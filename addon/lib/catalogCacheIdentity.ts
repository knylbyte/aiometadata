import { createHash } from 'node:crypto';

export const CATALOG_CANONICAL_CACHE_VERSION = 'canonical-v7';
export const CATALOG_CANONICAL_PAGE_SCHEMA = 'v7';
export const CATALOG_CURSOR_CACHE_VERSION = 'catalog-cursor:v7';
export const CATALOG_TERMINAL_CACHE_VERSION = 'canonical-terminal:v7';
export const PROVIDER_BATCH_CACHE_VERSION = 'provider-batch:v4';
export const EXTERNAL_ADDON_BATCH_CACHE_VERSION = 'external-addon-batch:v3';

export type CatalogCacheScope =
  | { kind: 'public' }
  | { kind: 'account'; accountFingerprint: string }
  | { kind: 'user-config'; userFingerprint: string };

export const CATALOG_DELIVERY_ONLY_KEYS = new Set([
  'skip',
  'limit',
  'page',
  '_pageSize',
  '_pageOffset',
  '_catalogPaging',
  '_canonicalPageSize',
  '_querySignature',
  '_mdblistPaging',
  'ageRating',
  'allowUnratedContent',
  'allowUnrated',
  'hideUnreleasedDigital',
  'hideUnreleasedShows',
  'hideWatched',
  'hideWatchedTrakt',
  'hideWatchedAnilist',
  'hideWatchedMdblist',
  'hideWatchedSimkl',
  'exclusionKeywords',
  'regexExclusionFilter',
  'exclusionGenres',
  'randomizePerPage',
  'cacheTTL',
]);

function stableValue(value: any, omittedKeys: Set<string> = new Set()): any {
  if (Array.isArray(value)) return value.map(child => stableValue(child, omittedKeys));
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result: Record<string, any>, key) => {
      if (omittedKeys.has(key)) return result;
      const child = value[key];
      if (child !== undefined && typeof child !== 'function') result[key] = stableValue(child, omittedKeys);
      return result;
    }, {});
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32);
}

function segment(value: unknown): string {
  return encodeURIComponent(String(value ?? ''));
}

function providerForCatalog(cleanId: string, provider?: string): string {
  if (provider) return provider;
  const prefix = String(cleanId || '').split('.')[0];
  return prefix || 'catalog';
}

function isPublicMdblistByNameUrl(sourceUrl?: string): boolean {
  if (!sourceUrl) return false;
  try {
    const url = new URL(sourceUrl);
    return url.hostname.toLowerCase() === 'api.mdblist.com'
      && /^\/lists\/[^/]+\/[^/]+\/items(?:\/(?:movie|show))?\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function accountCatalog(cleanId: string): boolean {
  return cleanId === 'tmdb.watchlist'
    || cleanId === 'tmdb.favorites'
    || /^mdblist\.(?:watchlist(?:\.|$)|recommended(?:\.|$)|upnext$)/.test(cleanId)
    || /^mal\.userlist\./.test(cleanId)
    || cleanId === 'mal.suggestions'
    || /^trakt\.(?:watchlist|favorites|recommendations|upnext)(?:\.|$)/.test(cleanId)
    || /^anilist\.(?:user|userlist|watchlist|watching|completed|planning|paused|dropped|favorites|recommendations)(?:\.|$)/.test(cleanId)
    || /^simkl\.(?:watchlist|upnext|calendar)(?:\.|$)/.test(cleanId)
    || cleanId.startsWith('movielens.')
    || cleanId.startsWith('publicmetadb.');
}

function userConfigCatalog(cleanId: string): boolean {
  return cleanId.startsWith('merged.')
    || cleanId.startsWith('custom.')
    || cleanId.startsWith('stremthru.')
    || cleanId.startsWith('letterboxd.');
}

function providerCredentialFingerprint(provider: string, config: any): string {
  const apiKeys = config?.apiKeys || {};
  const aliases = provider === 'tmdb'
    ? ['tmdb', 'session']
    : provider === 'mal'
      ? ['mal']
      : [provider];
  const relevantKeys = Object.keys(apiKeys)
    .filter(key => aliases.some(alias => key.toLowerCase().includes(alias)))
    .sort()
    .map(key => [key, apiKeys[key]]);
  const account = config?.[provider] || null;
  const sessionReference = provider === 'tmdb'
    ? (config?.sessionId || config?.tmdbSessionId || null)
    : null;
  return fingerprint({ relevantKeys, account, sessionReference });
}

function sourceCatalogConfig(catalogConfig: any): any {
  if (!catalogConfig) return null;
  return stableValue({
    id: catalogConfig.id,
    type: catalogConfig.type,
    source: catalogConfig.source,
    sourceUrl: catalogConfig.sourceUrl,
    sort: catalogConfig.sort,
    sortDirection: catalogConfig.sortDirection,
    order: catalogConfig.order,
    filter_score_min: catalogConfig.filter_score_min,
    filter_score_max: catalogConfig.filter_score_max,
    metadata: catalogConfig.metadata,
  }, CATALOG_DELIVERY_ONLY_KEYS);
}

export function buildMergedSourceSignature(input: {
  catalogConfig?: any;
  config?: any;
}): string {
  const sources = input.catalogConfig?.metadata?.mergedSources || [];
  const children = sources.map((source: any) => {
    const child = input.config?.catalogs?.find((candidate: any) =>
      candidate.id === source.catalogId && candidate.type === source.catalogType
    );
    return {
      catalogId: source.catalogId,
      catalogType: source.catalogType,
      config: sourceCatalogConfig(child),
    };
  });
  return fingerprint({
    catalog: sourceCatalogConfig(input.catalogConfig),
    children,
    providers: input.config?.providers || null,
    sfw: input.config?.sfw,
    includeAdult: input.config?.includeAdult,
    timezone: input.config?.timezone,
  });
}

export function resolveCatalogCacheScope(input: {
  cleanId: string;
  catalogConfig?: any;
  config?: any;
  userUUID?: string;
  provider?: string;
  sourceUrl?: string;
}): CatalogCacheScope {
  const cleanId = String(input.cleanId || '');
  const provider = providerForCatalog(cleanId, input.provider);
  const userUUID = String(input.userUUID || 'anonymous');

  if (cleanId.startsWith('merged.')) {
    return {
      kind: 'user-config',
      userFingerprint: fingerprint({
        provider,
        userUUID,
        mergedSource: buildMergedSourceSignature(input),
      }),
    };
  }

  if (accountCatalog(cleanId)) {
    return {
      kind: 'account',
      accountFingerprint: fingerprint({
        provider,
        userUUID,
        credentialId: providerCredentialFingerprint(provider, input.config),
      }),
    };
  }

  if (cleanId.startsWith('mdblist.')) {
    if (isPublicMdblistByNameUrl(input.sourceUrl || input.catalogConfig?.sourceUrl)
      || cleanId.startsWith('mdblist.discover.')) return { kind: 'public' };
    return {
      kind: 'user-config',
      userFingerprint: fingerprint({ provider, userUUID, catalog: sourceCatalogConfig(input.catalogConfig) }),
    };
  }

  if (userConfigCatalog(cleanId)) {
    return {
      kind: 'user-config',
      userFingerprint: fingerprint({
        provider,
        userUUID,
        catalog: sourceCatalogConfig(input.catalogConfig),
        providers: input.config?.providers || null,
        sfw: input.config?.sfw,
        includeAdult: input.config?.includeAdult,
      }),
    };
  }

  const knownPublic = /^(?:tmdb|tvdb|tvmaze|streaming|flixpatrol)\./.test(cleanId)
    || /^mal\.(?!userlist\.)/.test(cleanId)
    || /^anilist\.(?:trending|popular|discover|airing)(?:\.|$)/.test(cleanId)
    || /^simkl\.(?:trending|popular|anticipated|discover|recipe|genre|dvd)(?:\.|$)/.test(cleanId)
    || /^trakt\.(?:trending|popular|anticipated|most_favorited|calendar|list)(?:\.|$)/.test(cleanId);
  if (knownPublic) return { kind: 'public' };

  return {
    kind: 'user-config',
    userFingerprint: fingerprint({ provider, userUUID, catalog: sourceCatalogConfig(input.catalogConfig) }),
  };
}

export function buildCatalogScopeFingerprint(scope: CatalogCacheScope): string {
  if (scope.kind === 'public') return 'public';
  if (scope.kind === 'account') return `account-${scope.accountFingerprint}`;
  return `user-config-${scope.userFingerprint}`;
}

export function buildCanonicalCatalogKey(input: {
  scopeFingerprint: string;
  sourceQuerySignature: string;
  catalogKey: string;
}): string {
  return `catalog:${CATALOG_CANONICAL_CACHE_VERSION}:${segment(input.scopeFingerprint)}:${segment(input.sourceQuerySignature)}:${input.catalogKey}`;
}

export function buildCatalogCursorKey(input: {
  scopeFingerprint: string;
  userUUID: string;
  catalogId: string;
  type: string;
  deliverySignature?: string;
  served?: number;
}): string {
  return `${CATALOG_CURSOR_CACHE_VERSION}:${segment(input.scopeFingerprint)}:${segment(input.userUUID)}:${segment(input.catalogId)}:${segment(input.type)}:${segment(input.deliverySignature || 'default')}:served:${Math.max(0, input.served || 0)}`;
}

export function buildCatalogTerminalKey(input: {
  scopeFingerprint: string;
  sourceQuerySignature: string;
}): string {
  return `${CATALOG_TERMINAL_CACHE_VERSION}:${segment(input.scopeFingerprint)}:${segment(input.sourceQuerySignature)}`;
}

export function buildProviderBatchKey(input: {
  provider: string;
  scopeFingerprint: string;
  sourceIdentityHash: string;
  sourceQuerySignature: string;
  resumeHash: string;
  requestedUpstreamLimit: number;
}): string {
  return `${PROVIDER_BATCH_CACHE_VERSION}:${segment(input.scopeFingerprint)}:${segment(input.provider)}:${input.sourceIdentityHash}:${input.sourceQuerySignature}:${input.resumeHash}:${input.requestedUpstreamLimit}`;
}
