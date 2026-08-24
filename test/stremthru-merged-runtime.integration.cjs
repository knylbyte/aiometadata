process.env.HOST_NAME = process.env.HOST_NAME || 'http://localhost:7000';
process.env.CATALOG_LIST_ITEMS_SIZE = '20';

const assert = require('node:assert/strict');
const { after, beforeEach, test } = require('node:test');

const httpClient = require('../dist/server/utils/httpClient.js');
const originalHttpGet = httpClient.httpGet;
const redis = require('../dist/server/lib/redisClient.js');
if (typeof redis?.disconnect === 'function') redis.disconnect();
redis.type = async () => 'none';
let responseMode = 'empty';

httpClient.httpGet = async url => {
  if (responseMode === '503' || responseMode === '429') {
    const status = Number(responseMode);
    throw Object.assign(new Error(`HTTP ${status}`), { response: { status, data: `error-${status}` } });
  }
  if (responseMode === 'merged') {
    if (String(url).includes('skip=')) return { data: { metas: [] } };
    const prefix = String(url).includes('child-a') ? 'A' : 'B';
    return {
      data: {
        metas: [
          { id: `${prefix}1`, type: 'movie', name: `${prefix} one`, poster: '' },
          { id: `${prefix}2`, type: 'movie', name: `${prefix} two`, poster: '' },
        ],
      },
    };
  }
  return { data: { metas: [] } };
};

const { getCatalog } = require('../dist/server/lib/getCatalog.js');
const {
  createCatalogSourceAdapter,
  providerPageResultFromHandler,
} = require('../dist/server/lib/catalogSourceAdapter.js');
const {
  buildCatalogSourceQuerySignature,
  hydrateCanonicalPageWindow,
  resolveCanonicalPageWindow,
} = require('../dist/server/lib/catalogFetchPlanner.js');
const {
  buildCatalogScopeFingerprint,
  resolveCatalogCacheScope,
} = require('../dist/server/lib/catalogCacheIdentity.js');
const {
  clearProviderBatchCacheForTests,
  providerBatchCacheSizeForTests,
} = require('../dist/server/lib/providerBatchCache.js');

after(() => {
  httpClient.httpGet = originalHttpGet;
});

beforeEach(() => {
  clearProviderBatchCacheForTests();
});

function customConfig(id = 'custom.real', sourceUrl = 'https://external.test/catalog/movie/real.json') {
  return {
    language: 'en-US',
    catalogs: [{ id, type: 'movie', source: 'custom', sourceUrl, cacheTTL: 0, showInHome: true }],
  };
}

async function runRealExternalPlanner(mode) {
  responseMode = mode;
  const catalogId = 'custom.real';
  const config = customConfig(catalogId);
  const catalogConfig = config.catalogs[0];
  const scope = resolveCatalogCacheScope({ cleanId: catalogId, catalogConfig, config, userUUID: 'user-a', sourceUrl: catalogConfig.sourceUrl });
  const scopeFingerprint = buildCatalogScopeFingerprint(scope);
  const querySignature = buildCatalogSourceQuerySignature({
    catalogId,
    type: 'movie',
    language: 'en-US',
    canonicalPageSize: 20,
    catalogConfig,
    cacheScopeFingerprint: scopeFingerprint,
  });
  const adapter = createCatalogSourceAdapter({
    catalogId,
    catalogConfig,
    canonicalPageSize: 20,
    querySignature,
    type: 'movie',
    language: 'en-US',
    userUUID: 'user-a',
    cacheScopeFingerprint: scopeFingerprint,
    cacheScopeKind: scope.kind,
    providerBatchTtl: 0,
    useRedisBatchCache: false,
    fetchPage: async (page, nativePageSize) => {
      const result = await getCatalog('movie', 'en-US', page, catalogId, '', config, 'user-a', false, (page - 1) * nativePageSize);
      return providerPageResultFromHandler({
        catalogId,
        canonicalPageSize: 20,
        page,
        nativePageSize,
        metas: result.metas,
      });
    },
  });
  const pages = new Map();
  let terminal = null;
  const hydrate = () => hydrateCanonicalPageWindow({
    window: resolveCanonicalPageWindow(0, 20, 20),
    adapter,
    readPage: async page => pages.get(page) || null,
    writePage: async (page, value) => {
      pages.set(page, value);
      return value;
    },
    readTerminal: async () => terminal,
    writeTerminal: async value => {
      terminal = value;
    },
    maxBatches: 2,
  });
  return { hydrate, pages, terminal: () => terminal };
}

for (const status of ['503', '429']) {
  test(`real StremThru HTTP ${status} path throws without EOF or cache state`, async () => {
    const runtime = await runRealExternalPlanner(status);
    await assert.rejects(runtime.hydrate, new RegExp(status));
    assert.equal(runtime.pages.size, 0);
    assert.equal(runtime.terminal(), null);
    assert.equal(providerBatchCacheSizeForTests(), 0);
  });
}

test('real StremThru HTTP 200 empty catalog confirms EOF', async () => {
  const runtime = await runRealExternalPlanner('empty');
  const result = await runtime.hydrate();
  assert.equal(result.exhausted, true);
  assert.equal(runtime.pages.size, 0);
  assert.ok(runtime.terminal());
});

test('real merged source is user-isolated and does not apply delivery filters internally', async () => {
  responseMode = 'merged';
  const makeConfig = (user, hideWatchedTrakt) => {
    const child = {
      id: 'custom.child',
      type: 'movie',
      source: 'custom',
      sourceUrl: `https://external.test/${user === 'user-a' ? 'child-a' : 'child-b'}/catalog/movie/items.json`,
      cacheTTL: 0,
      showInHome: true,
    };
    const merged = {
      id: 'merged.personal',
      type: 'movie',
      cacheTTL: 0,
      metadata: {
        mergeMode: 'interleaved',
        mergedSources: [{ catalogId: child.id, catalogType: child.type }],
      },
    };
    return {
      language: 'en-US',
      hideWatchedTrakt,
      exclusionKeywords: 'one',
      catalogs: [merged, child],
    };
  };
  const configA = makeConfig('user-a', false);
  const configB = makeConfig('user-b', true);
  const resultA = await getCatalog('movie', 'en-US', 1, 'merged.personal', '', configA, 'user-a', false, 0);
  const resultB = await getCatalog('movie', 'en-US', 1, 'merged.personal', '', configB, 'user-b', false, 0);
  assert.deepEqual(resultA.metas.map(meta => meta.id), ['A1', 'A2']);
  assert.deepEqual(resultB.metas.map(meta => meta.id), ['B1', 'B2']);
  const scopeA = buildCatalogScopeFingerprint(resolveCatalogCacheScope({
    cleanId: 'merged.personal', catalogConfig: configA.catalogs[0], config: configA, userUUID: 'user-a',
  }));
  const scopeB = buildCatalogScopeFingerprint(resolveCatalogCacheScope({
    cleanId: 'merged.personal', catalogConfig: configB.catalogs[0], config: configB, userUUID: 'user-b',
  }));
  assert.notEqual(scopeA, scopeB);
});
