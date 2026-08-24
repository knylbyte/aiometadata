process.env.HOST_NAME = process.env.HOST_NAME || 'http://localhost:7000';
process.env.CATALOG_LIST_ITEMS_SIZE = '20';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  CATALOG_CANONICAL_CACHE_VERSION,
  CATALOG_CURSOR_CACHE_VERSION,
  CATALOG_TERMINAL_CACHE_VERSION,
  PROVIDER_BATCH_CACHE_VERSION,
  buildCanonicalCatalogKey,
  buildCatalogScopeFingerprint,
  resolveCatalogCacheScope,
} = require('../dist/server/lib/catalogCacheIdentity.js');
const {
  buildCatalogSourceQuerySignature,
  buildDeliveryCursorSignature,
  hydrateCanonicalPageWindow,
  resolveCanonicalPageWindow,
} = require('../dist/server/lib/catalogFetchPlanner.js');
const { cursorKey, terminalKey } = require('../dist/server/lib/catalogPagination.js');
const {
  createCatalogSourceAdapter,
} = require('../dist/server/lib/catalogSourceAdapter.js');
const {
  createRawFixedPageEntries,
  reconstructEntriesWithProvenance,
} = require('../dist/server/lib/catalogProvenance.js');
const {
  clearProviderBatchCacheForTests,
  providerBatchCacheKey,
} = require('../dist/server/lib/providerBatchCache.js');
const { resolveEffectiveCatalogTtl } = require('../dist/server/lib/catalogTtl.js');

function identity({ cleanId, userUUID, catalogConfig, config = {}, type = 'movie' }) {
  const scope = resolveCatalogCacheScope({ cleanId, userUUID, catalogConfig, config, sourceUrl: catalogConfig?.sourceUrl });
  const scopeFingerprint = buildCatalogScopeFingerprint(scope);
  const sourceQuerySignature = buildCatalogSourceQuerySignature({
    catalogId: cleanId,
    type,
    language: 'en-US',
    canonicalPageSize: 20,
    catalogConfig,
    cacheScopeFingerprint: scopeFingerprint,
    configFingerprint: { providers: config.providers || null, sfw: config.sfw, includeAdult: config.includeAdult },
  });
  return {
    scope,
    scopeFingerprint,
    sourceQuerySignature,
    canonical: buildCanonicalCatalogKey({ scopeFingerprint, sourceQuerySignature, catalogKey: `${cleanId}:${type}:page=1` }),
    terminal: terminalKey(scopeFingerprint, sourceQuerySignature),
    batch: providerBatchCacheKey({
      provider: cleanId.split('.')[0],
      scopeFingerprint,
      sourceIdentity: cleanId,
      querySignature: sourceQuerySignature,
      resumeState: { kind: 'page-index', page: 1, index: 0 },
      requestedUpstreamLimit: 20,
    }),
    cursor: cursorKey(userUUID, cleanId, type, sourceQuerySignature, 0, scopeFingerprint),
  };
}

test('personal catalog scopes isolate canonical, terminal, batch, and cursor keys across users', () => {
  const personalCatalogs = [
    'tmdb.watchlist',
    'tmdb.favorites',
    'mdblist.watchlist.movies',
    'mdblist.watchlist.series',
    'mdblist.recommended.demo.movies',
    'mdblist.upnext',
    'mal.userlist.watching',
    'mal.suggestions',
  ];
  for (const cleanId of personalCatalogs) {
    const catalogConfig = { id: cleanId, type: 'movie' };
    const userA = identity({ cleanId, userUUID: 'user-a', catalogConfig, config: { apiKeys: { mdblist: 'a', malTokenId: 'a' } } });
    const userB = identity({ cleanId, userUUID: 'user-b', catalogConfig, config: { apiKeys: { mdblist: 'b', malTokenId: 'b' } } });
    assert.equal(userA.scope.kind, 'account', cleanId);
    assert.equal(userB.scope.kind, 'account', cleanId);
    for (const key of ['canonical', 'terminal', 'batch', 'cursor']) {
      assert.notEqual(userA[key], userB[key], `${cleanId} shared ${key}`);
    }
  }
});

test('a genuinely public MDBList by-name source shares canonical source identity', () => {
  const catalogConfig = {
    id: 'mdblist.nobnobz.netflix.movie',
    type: 'movie',
    sourceUrl: 'https://api.mdblist.com/lists/nobnobz/netflix/items/movie',
  };
  const userA = identity({ cleanId: catalogConfig.id, userUUID: 'user-a', catalogConfig });
  const userB = identity({ cleanId: catalogConfig.id, userUUID: 'user-b', catalogConfig });
  assert.equal(userA.scope.kind, 'public');
  assert.equal(userB.scope.kind, 'public');
  assert.equal(userA.canonical, userB.canonical);
  assert.equal(userA.terminal, userB.terminal);
  assert.equal(userA.batch, userB.batch);
  assert.notEqual(userA.cursor, userB.cursor);
});

test('merged source identity is user-config scoped while delivery filters only change its cursor signature', () => {
  const merged = {
    id: 'merged.personal',
    type: 'movie',
    cacheTTL: 0,
    metadata: {
      mergeMode: 'interleaved',
      mergedSources: [{ catalogId: 'tmdb.watchlist', catalogType: 'movie' }],
    },
  };
  const child = { id: 'tmdb.watchlist', type: 'movie' };
  const configA = { catalogs: [merged, child], hideWatchedTrakt: false, apiKeys: { tmdbSessionId: 'same' } };
  const configB = { ...configA, hideWatchedTrakt: true };
  const sourceA = identity({ cleanId: merged.id, userUUID: 'user-a', catalogConfig: merged, config: configA });
  const sourceB = identity({ cleanId: merged.id, userUUID: 'user-a', catalogConfig: merged, config: configB });
  const otherUser = identity({ cleanId: merged.id, userUUID: 'user-b', catalogConfig: merged, config: configA });
  assert.equal(sourceA.scope.kind, 'user-config');
  assert.equal(sourceA.sourceQuerySignature, sourceB.sourceQuerySignature);
  assert.equal(sourceA.canonical, sourceB.canonical);
  assert.notEqual(sourceA.canonical, otherUser.canonical);
  const deliveryA = buildDeliveryCursorSignature({ sourceQuerySignature: sourceA.sourceQuerySignature, config: configA, catalogConfig: merged });
  const deliveryB = buildDeliveryCursorSignature({ sourceQuerySignature: sourceB.sourceQuerySignature, config: configB, catalogConfig: merged });
  assert.notEqual(deliveryA, deliveryB);
  assert.notEqual(
    cursorKey('user-a', merged.id, 'movie', deliveryA, 20, sourceA.scopeFingerprint),
    cursorKey('user-a', merged.id, 'movie', deliveryB, 20, sourceB.scopeFingerprint)
  );
  assert.deepEqual(resolveEffectiveCatalogTtl({ catalogConfig: merged }), {
    effectiveCatalogTtl: 0,
    canonicalPageTtl: 0,
    providerBatchTtl: 0,
    terminalTtl: 0,
  });
});

test('raw fixed-page provenance keeps index six after reconstruction loss at index five', async () => {
  const rawItems = Array.from({ length: 20 }, (_, index) => ({ id: index }));
  const rawEntries = createRawFixedPageEntries(rawItems, 1, 20);
  const entries = await reconstructEntriesWithProvenance({
    rawEntries,
    reconstruct: async item => item.id === 5 ? null : ({ id: `id-${item.id}` }),
  });
  assert.equal(entries.length, 19);
  assert.equal(entries.find(entry => entry.meta.id === 'id-6').sourcePosition.index, 6);
  assert.equal(entries.find(entry => entry.meta.id === 'id-6').resumeAfter.index, 7);
});

test('native 50 provenance remains deterministic after canonical page eviction', async () => {
  clearProviderBatchCacheForTests();
  const canonicalPages = new Map();
  const fetchPage = async (page, nativePageSize) => {
    const rawItems = Array.from({ length: nativePageSize }, (_, index) => ({
      id: ((page - 1) * nativePageSize) + index,
    }));
    const rawEntries = createRawFixedPageEntries(rawItems, page, nativePageSize);
    const entries = await reconstructEntriesWithProvenance({
      rawEntries,
      reconstruct: async item => item.id === 5 ? null : ({ id: `id-${item.id}` }),
    });
    return {
      metas: entries.map(entry => entry.meta),
      entries,
      rawCount: rawItems.length,
      resumeAfterBatch: { kind: 'page-index', page: page + 1, index: 0 },
      exhaustion: 'not-exhausted',
      hasMore: true,
    };
  };
  const adapter = createCatalogSourceAdapter({
    catalogId: 'trakt.recommendations.movies',
    canonicalPageSize: 20,
    querySignature: 'native-50-loss',
    type: 'movie',
    language: 'en-US',
    cacheScopeFingerprint: 'account-test',
    cacheScopeKind: 'account',
    providerBatchTtl: 0,
    useRedisBatchCache: false,
    fetchPage,
  });
  const hydrate = window => hydrateCanonicalPageWindow({
    window,
    adapter,
    readPage: async page => canonicalPages.get(page) || null,
    writePage: async (page, value) => {
      canonicalPages.set(page, value);
      return value;
    },
    maxBatches: 10,
  });
  await hydrate(resolveCanonicalPageWindow(0, 60, 20));
  assert.deepEqual(canonicalPages.get(1).metas.map(meta => meta.id), [
    'id-0', 'id-1', 'id-2', 'id-3', 'id-4',
    'id-6', 'id-7', 'id-8', 'id-9', 'id-10',
    'id-11', 'id-12', 'id-13', 'id-14', 'id-15',
    'id-16', 'id-17', 'id-18', 'id-19', 'id-20',
  ]);
  const originalPageTwo = JSON.stringify(canonicalPages.get(2));
  const pageOneIds = new Set(canonicalPages.get(1).metas.map(meta => meta.id));
  const pageThreeIds = new Set(canonicalPages.get(3).metas.map(meta => meta.id));
  canonicalPages.delete(2);
  await hydrate(resolveCanonicalPageWindow(20, 20, 20));
  assert.equal(JSON.stringify(canonicalPages.get(2)), originalPageTwo);
  for (const meta of canonicalPages.get(2).metas) {
    assert.equal(pageOneIds.has(meta.id), false);
    assert.equal(pageThreeIds.has(meta.id), false);
  }
});

test('unsafe v6/v3 paging namespaces are not reused', () => {
  assert.equal(CATALOG_CANONICAL_CACHE_VERSION, 'canonical-v7');
  assert.equal(CATALOG_CURSOR_CACHE_VERSION, 'catalog-cursor:v7');
  assert.equal(CATALOG_TERMINAL_CACHE_VERSION, 'canonical-terminal:v7');
  assert.equal(PROVIDER_BATCH_CACHE_VERSION, 'provider-batch:v4');
  const next = identity({ cleanId: 'tmdb.watchlist', userUUID: 'user-a', catalogConfig: { id: 'tmdb.watchlist', type: 'movie' } });
  assert.equal(next.canonical.includes('canonical-v6'), false);
  assert.equal(next.canonical.includes(':account-'), true);
});
