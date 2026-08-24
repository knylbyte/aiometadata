import { envInt } from '../utils/envNumber';
import {
  createSequentialPageBatchFetcher,
  isProviderResumeState,
  type CatalogExhaustion,
  type CatalogProviderCapabilities,
  type CatalogSourceAdapter,
  type ProviderBatchResult,
  type ProviderResumeState,
  type ReconstructedCatalogEntry,
} from './catalogFetchPlanner';
import { credentialFingerprint, fetchProviderBatchCached } from './providerBatchCache';
import { reconstructedEntriesFromRawItems } from './catalogProvenance';

export interface ProviderPageResult {
  metas: any[];
  rawCount: number;
  entries: ReconstructedCatalogEntry[];
  resumeAfterBatch: ProviderResumeState;
  exhaustion: CatalogExhaustion;
  total?: number;
  hasMore?: boolean;
}

export function attachProviderPageMetadata(metas: any[], info: Record<string, any>): any[] {
  if (!Array.isArray(metas) || !Number.isInteger(info.rawCount) || info.rawCount < 0) {
    throw new Error('Provider page metadata requires metas and a non-negative rawCount');
  }
  Object.defineProperty(metas, '_providerPageInfo', {
    value: { ...info },
    enumerable: false,
    configurable: true,
  });
  return metas;
}

export interface AdapterContext {
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
  providerBatchTtl?: number;
  cacheScopeFingerprint?: string;
  cacheScopeKind?: 'public' | 'account' | 'user-config';
  fetchOffsetBatch?: (resume: ProviderResumeState, requestedRawCount: number) => Promise<ProviderBatchResult>;
  fetchPage: (page: number, nativePageSize: number) => Promise<ProviderPageResult>;
}

export interface ProviderDefinition {
  provider: string;
  capabilities: CatalogProviderCapabilities;
  initialResumeState: ProviderResumeState;
}

export interface ProviderRegistryEntry {
  id: string;
  testCatalogId: string;
  matches: (catalogId: string) => boolean;
  resolve: (context: Pick<AdapterContext, 'catalogId' | 'canonicalPageSize'>) => ProviderDefinition;
}

function fixed(provider: string, nativePageSize: number, eof: { empty?: boolean; short?: boolean } = {}): ProviderDefinition {
  return {
    provider,
    capabilities: {
      supportsOffset: false,
      supportsVariableLimit: false,
      maxLimit: nativePageSize,
      nativePageSize,
      cursorBased: false,
      stableOrdering: true,
      paginationModel: 'page',
      emptyPageConfirmsEnd: eof.empty === true,
      shortPageConfirmsEnd: eof.short === true,
    },
    initialResumeState: { kind: 'page-index', page: 1, index: 0 },
  };
}

function canonical(provider: string, context: Pick<AdapterContext, 'canonicalPageSize'>, short = true): ProviderDefinition {
  return fixed(provider, Math.max(1, context.canonicalPageSize), { empty: true, short });
}

const mdblistOffset = (): ProviderDefinition => ({
  provider: 'mdblist',
  capabilities: {
    supportsOffset: true,
    supportsVariableLimit: true,
    maxLimit: 100,
    cursorBased: false,
    stableOrdering: true,
    paginationModel: 'offset',
    emptyPageConfirmsEnd: false,
    shortPageConfirmsEnd: false,
  },
  initialResumeState: { kind: 'offset', offset: 0 },
});

export const CATALOG_PROVIDER_REGISTRY: ProviderRegistryEntry[] = [
  { id: 'mdblist-offset', testCatalogId: 'mdblist.demo.movie', matches: id => id.startsWith('mdblist.') && !id.startsWith('mdblist.discover.') && id !== 'mdblist.upnext', resolve: mdblistOffset },
  { id: 'anilist', testCatalogId: 'anilist.trending', matches: id => id.startsWith('anilist.'), resolve: () => fixed('anilist', 50, { empty: true }) },
  { id: 'trakt-recommendations', testCatalogId: 'trakt.recommendations.movies', matches: id => id === 'trakt.recommendations.movies' || id === 'trakt.recommendations.shows', resolve: () => fixed('trakt', 50, { empty: true, short: true }) },
  { id: 'trakt', testCatalogId: 'trakt.trending.movies', matches: id => id.startsWith('trakt.'), resolve: context => canonical('trakt', context, false) },
  { id: 'mal-discover', testCatalogId: 'mal.discover.sample', matches: id => id.startsWith('mal.discover.'), resolve: () => fixed('mal', 25, { empty: true, short: true }) },
  { id: 'mal-user', testCatalogId: 'mal.userlist.watching', matches: id => id.startsWith('mal.userlist.') || id === 'mal.suggestions', resolve: context => canonical('mal', context) },
  { id: 'mal', testCatalogId: 'mal.airing', matches: id => id.startsWith('mal.'), resolve: () => fixed('mal', envInt('MAL_PAGE_SIZE', 25, 1), { empty: true, short: true }) },
  { id: 'flixpatrol', testCatalogId: 'flixpatrol.netflix.us.movie', matches: id => id.startsWith('flixpatrol.'), resolve: () => fixed('flixpatrol', 10, { empty: true }) },
  { id: 'tmdb-collection', testCatalogId: 'tmdb.collection.1', matches: id => id.startsWith('tmdb.collection.'), resolve: context => canonical('tmdb', context) },
  { id: 'tmdb', testCatalogId: 'tmdb.trending', matches: id => id.startsWith('tmdb.') || id.startsWith('streaming.'), resolve: () => fixed('tmdb', 20, { empty: true, short: true }) },
  { id: 'tvdb', testCatalogId: 'tvdb.discover.sample', matches: id => id.startsWith('tvdb.'), resolve: context => canonical('tvdb', context) },
  { id: 'tvmaze', testCatalogId: 'tvmaze.schedule', matches: id => id === 'tvmaze.schedule', resolve: context => canonical('tvmaze', context) },
  { id: 'letterboxd', testCatalogId: 'letterboxd.demo', matches: id => id.startsWith('letterboxd.'), resolve: context => canonical('letterboxd', context) },
  { id: 'simkl', testCatalogId: 'simkl.trending.movies', matches: id => id.startsWith('simkl.'), resolve: context => canonical('simkl', context) },
  { id: 'movielens', testCatalogId: 'movielens.explore', matches: id => id.startsWith('movielens.'), resolve: context => canonical('movielens', context) },
  { id: 'publicmetadb', testCatalogId: 'publicmetadb.list.demo', matches: id => id.startsWith('publicmetadb.'), resolve: context => canonical('publicmetadb', context) },
  { id: 'custom', testCatalogId: 'custom.demo', matches: id => id.startsWith('custom.'), resolve: context => canonical('custom', context, false) },
  { id: 'stremthru', testCatalogId: 'stremthru.demo', matches: id => id.startsWith('stremthru.'), resolve: context => canonical('stremthru', context, false) },
  { id: 'merged', testCatalogId: 'merged.demo', matches: id => id.startsWith('merged.'), resolve: context => canonical('merged', context, false) },
  { id: 'mdblist-page', testCatalogId: 'mdblist.discover.demo', matches: id => id.startsWith('mdblist.'), resolve: context => canonical('mdblist', context, false) },
  { id: 'internal', testCatalogId: 'internal.catalog', matches: () => true, resolve: context => canonical('catalog', context, false) },
];

export function getCatalogProviderDefinition(context: Pick<AdapterContext, 'catalogId' | 'canonicalPageSize'>): ProviderDefinition {
  const id = String(context.catalogId || '');
  const entry = CATALOG_PROVIDER_REGISTRY.find(candidate => candidate.matches(id));
  if (!entry) throw new Error(`No catalog provider adapter registered for ${id}`);
  return entry.resolve(context);
}

export function resolveFixedPageExhaustion(input: {
  rawCount: number;
  nativePageSize: number;
  page: number;
  exhaustion?: CatalogExhaustion;
  hasMore?: boolean;
  total?: number;
  emptyPageConfirmsEnd: boolean;
  shortPageConfirmsEnd: boolean;
}): CatalogExhaustion {
  if (input.hasMore === true) return 'not-exhausted';
  if (input.hasMore === false) return 'confirmed';
  if (Number.isFinite(input.total) && ((input.page - 1) * input.nativePageSize) + input.rawCount >= Number(input.total)) return 'confirmed';
  if (input.exhaustion) return input.exhaustion;
  if (input.rawCount === 0 && input.emptyPageConfirmsEnd) return 'confirmed';
  if (input.rawCount < input.nativePageSize && input.shortPageConfirmsEnd) return 'confirmed';
  return 'unknown';
}

export function createFixedPageAdapter(input: {
  providerId: string;
  nativePageSize: number;
  emptyPageConfirmsEnd: boolean;
  shortPageConfirmsEnd: boolean;
  fetchPage: (page: number, nativePageSize: number) => Promise<ProviderPageResult>;
}): (page: number) => Promise<ProviderBatchResult> {
  return async (page: number): Promise<ProviderBatchResult> => {
    const output = await input.fetchPage(page, input.nativePageSize);
    if (!output || Array.isArray(output) || !Array.isArray(output.metas)) {
      throw new Error(`${input.providerId} returned a naked or invalid fixed-page result`);
    }
    if (!Number.isInteger(output.rawCount) || output.rawCount < 0 || output.metas.length > output.rawCount) {
      throw new Error(`${input.providerId} returned an invalid rawCount`);
    }
    if (!isProviderResumeState(output.resumeAfterBatch)
      || !['confirmed', 'not-exhausted', 'unknown'].includes(output.exhaustion)) {
      throw new Error(`${input.providerId} returned an incomplete provider page contract`);
    }
    const exhaustion = output.exhaustion;
    if (!Array.isArray(output.entries) || output.entries.length !== output.metas.length) {
      throw new Error(`${input.providerId} returned fixed-page metas without raw provenance`);
    }
    return { entries: output.entries, rawCount: output.rawCount, resumeAfterBatch: output.resumeAfterBatch, exhaustion };
  };
}

export function providerPageResultFromHandler(input: {
  catalogId: string;
  canonicalPageSize: number;
  page: number;
  nativePageSize: number;
  metas: any[];
}): ProviderPageResult {
  const definition = getCatalogProviderDefinition(input);
  const declaredSize = definition.capabilities.nativePageSize || definition.capabilities.maxLimit;
  if (declaredSize !== input.nativePageSize) {
    throw new Error(`${input.catalogId} fetched with ${input.nativePageSize}, but its adapter declares ${declaredSize}`);
  }
  const info = (input.metas as any)?._providerPageInfo;
  if (!info || !Number.isInteger(info.rawCount) || info.rawCount < 0) {
    throw new Error(`${input.catalogId} did not report rawCount from its provider response`);
  }
  if (Array.isArray(info.rawItems) && info.rawItems.length !== info.rawCount) {
    throw new Error(`${input.catalogId} rawItems length does not match rawCount`);
  }
  const exhaustion = resolveFixedPageExhaustion({
    rawCount: info.rawCount,
    nativePageSize: input.nativePageSize,
    page: input.page,
    exhaustion: info.exhaustion,
    hasMore: info.hasMore,
    total: info.total,
    emptyPageConfirmsEnd: definition.capabilities.emptyPageConfirmsEnd === true,
    shortPageConfirmsEnd: definition.capabilities.shortPageConfirmsEnd === true,
  });
  const resumeAfterBatch = info.resumeAfterBatch || {
    kind: 'page-index' as const,
    page: input.page + 1,
    index: 0,
  };
  if (!isProviderResumeState(resumeAfterBatch)) {
    throw new Error(`${input.catalogId} did not report a valid provider resume state`);
  }
  const entries = Array.isArray(info.entries)
    ? info.entries
    : reconstructedEntriesFromRawItems({
      rawItems: Array.isArray(info.rawItems)
        ? info.rawItems
        : (info.rawCount === input.metas.length ? input.metas : []),
      metas: input.metas,
      providerPage: input.page,
      nativePageSize: input.nativePageSize,
    });
  if (entries.length !== input.metas.length) {
    throw new Error(`${input.catalogId} did not preserve raw provenance for every reconstructed meta`);
  }
  return {
    metas: input.metas,
    rawCount: info.rawCount,
    entries,
    resumeAfterBatch,
    exhaustion,
    hasMore: info.hasMore,
    total: info.total,
  };
}

function sourceIdentity(context: AdapterContext, provider: string): string {
  return JSON.stringify({
    provider,
    catalogId: context.catalogId,
    sourceUrl: context.catalogConfig?.sourceUrl || '',
    type: context.type,
    language: context.language,
    genre: context.genre || '',
    scope: context.cacheScopeFingerprint || 'scope-legacy',
    credential: context.cacheScopeKind === 'public' ? 'public' : credentialFingerprint(context.credential),
  });
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
    ttl: context.providerBatchTtl,
    scopeFingerprint: context.cacheScopeFingerprint || 'scope-legacy',
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
  const fixedPageAdapter = createFixedPageAdapter({
    providerId: definition.provider,
    nativePageSize,
    emptyPageConfirmsEnd: definition.capabilities.emptyPageConfirmsEnd === true,
    shortPageConfirmsEnd: definition.capabilities.shortPageConfirmsEnd === true,
    fetchPage: context.fetchPage,
  });
  const fetchSequential = createSequentialPageBatchFetcher(definition.capabilities, async page => {
    const normalizedResume: ProviderResumeState = { kind: 'page-index', page, index: 0 };
    return fetchProviderBatchCached({
      ...commonCache,
      resumeState: normalizedResume,
      requestedUpstreamLimit: nativePageSize,
      loader: () => fixedPageAdapter(page),
    });
  });

  return {
    ...definition,
    sourceIdentity: identity,
    querySignature: context.querySignature,
    fetchBatch: fetchSequential,
  };
}
