import { envInt } from '../utils/envNumber';
import {
  createSequentialPageBatchFetcher,
  type CatalogExhaustion,
  type CatalogProviderCapabilities,
  type CatalogSourceAdapter,
  type ProviderBatchResult,
  type ProviderResumeState,
  type ReconstructedCatalogEntry,
} from './catalogFetchPlanner';
import { credentialFingerprint, fetchProviderBatchCached } from './providerBatchCache';

interface AdapterContext {
  catalogId: string;
  catalogConfig?: any;
  canonicalPageSize: number;
  querySignature: string;
  type: string;
  language: string;
  genre?: string | null;
  userUUID?: string;
  credential?: string;
  forceRefresh?: boolean;
  useRedisBatchCache?: boolean;
  fetchOffsetBatch?: (resume: ProviderResumeState, requestedRawCount: number) => Promise<ProviderBatchResult>;
  fetchPage: (page: number, nativePageSize: number) => Promise<any>;
}

interface ProviderDefinition {
  provider: string;
  capabilities: CatalogProviderCapabilities;
  initialResumeState: ProviderResumeState;
}

function fixed(provider: string, nativePageSize: number): ProviderDefinition {
  return {
    provider,
    capabilities: {
      supportsOffset: false,
      supportsVariableLimit: false,
      maxLimit: nativePageSize,
      nativePageSize,
      cursorBased: false,
      stableOrdering: true,
    },
    initialResumeState: { kind: 'page-index', page: 1, index: 0 },
  };
}

export function getCatalogProviderDefinition(
  context: Pick<AdapterContext, 'catalogId' | 'canonicalPageSize'>
): ProviderDefinition {
  const id = String(context.catalogId || '');
  if (id.startsWith('mdblist.') && !id.startsWith('mdblist.discover.') && id !== 'mdblist.upnext') {
    return {
      provider: 'mdblist',
      capabilities: {
        supportsOffset: true,
        supportsVariableLimit: true,
        maxLimit: 100,
        cursorBased: false,
        stableOrdering: true,
      },
      initialResumeState: { kind: 'offset', offset: 0 },
    };
  }
  if (id.startsWith('anilist.')) return fixed('anilist', 50);
  if (id.startsWith('mal.') && !id.startsWith('mal.userlist.') && id !== 'mal.suggestions') {
    return fixed('mal', envInt('MAL_PAGE_SIZE', 25, 1));
  }
  if (id.startsWith('flixpatrol.')) return fixed('flixpatrol', 10);
  if (id.startsWith('tmdb.') || id.startsWith('streaming.')) return fixed('tmdb', 20);
  if (id.startsWith('custom.') || id.startsWith('stremthru.') || id.startsWith('merged.')) {
    return fixed(id.split('.')[0], Math.max(1, context.canonicalPageSize));
  }
  return fixed(id.split('.')[0] || 'catalog', 20);
}

function sourceIdentity(context: AdapterContext, provider: string): string {
  return JSON.stringify({
    provider,
    catalogId: context.catalogId,
    sourceUrl: context.catalogConfig?.sourceUrl || '',
    type: context.type,
    language: context.language,
    genre: context.genre || '',
    userUUID: context.userUUID || '',
    credential: credentialFingerprint(context.credential),
  });
}

function normalizePageResult(
  output: any,
  page: number,
  nativePageSize: number
): ProviderBatchResult {
  const items = Array.isArray(output) ? output : (output?.metas || output?.items || []);
  const info = (items as any)._providerPageInfo || output?._providerPageInfo || output || {};
  const entries: ReconstructedCatalogEntry[] = Array.isArray(info.entries)
    ? info.entries
    : items.map((meta: any, index: number) => ({
        meta,
        sourcePosition: { kind: 'page-index', page, index },
        resumeAfter: index + 1 >= nativePageSize
          ? { kind: 'page-index', page: page + 1, index: 0 }
          : { kind: 'page-index', page, index: index + 1 },
      }));
  const exhaustion: CatalogExhaustion = info.exhaustion || 'unknown';
  return {
    entries,
    rawCount: Math.max(0, Number(info.rawCount ?? items.length) || 0),
    resumeAfterBatch: info.resumeAfterBatch || { kind: 'page-index', page: page + 1, index: 0 },
    exhaustion,
  };
}

export function createCatalogSourceAdapter(context: AdapterContext): CatalogSourceAdapter {
  const definition = getCatalogProviderDefinition(context);
  const identity = sourceIdentity(context, definition.provider);
  const commonCache = {
    provider: definition.provider,
    sourceIdentity: identity,
    querySignature: context.querySignature,
    bypass: context.forceRefresh === true,
    useRedis: context.useRedisBatchCache,
  };

  if (definition.capabilities.supportsVariableLimit && context.fetchOffsetBatch) {
    return {
      ...definition,
      sourceIdentity: identity,
      querySignature: context.querySignature,
      fetchBatch: request => fetchProviderBatchCached({
        ...commonCache,
        resumeState: request.resumeState,
        requestedUpstreamLimit: request.requestedRawCount,
        loader: () => context.fetchOffsetBatch!(request.resumeState, request.requestedRawCount),
      }),
    };
  }

  const nativePageSize = definition.capabilities.nativePageSize || definition.capabilities.maxLimit;
  const fetchSequential = createSequentialPageBatchFetcher(definition.capabilities, async page => {
    const normalizedResume: ProviderResumeState = { kind: 'page-index', page, index: 0 };
    return fetchProviderBatchCached({
      ...commonCache,
      resumeState: normalizedResume,
      requestedUpstreamLimit: nativePageSize,
      loader: async () => normalizePageResult(
        await context.fetchPage(page, nativePageSize),
        page,
        nativePageSize
      ),
    });
  });

  return {
    ...definition,
    sourceIdentity: identity,
    querySignature: context.querySignature,
    fetchBatch: fetchSequential,
  };
}
