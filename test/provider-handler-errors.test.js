const test = require('node:test');
const assert = require('node:assert/strict');

process.env.HOST_NAME = process.env.HOST_NAME || 'http://localhost:7000';
process.env.CATALOG_LIST_ITEMS_SIZE = '20';

const {
  hydrateCanonicalPageWindow,
  resolveCanonicalPageWindow,
} = require('../dist/server/lib/catalogFetchPlanner.js');
const {
  createCatalogSourceAdapter,
  providerPageResultFromHandler,
} = require('../dist/server/lib/catalogSourceAdapter.js');
const { clearProviderBatchCacheForTests } = require('../dist/server/lib/providerBatchCache.js');
const { getCatalog } = require('../dist/server/lib/getCatalog.js');

const tvdb = require('../dist/server/lib/tvdb.js');
const tmdb = require('../dist/server/lib/getTmdb.js');
const stremthru = require('../dist/server/utils/stremthru.js');
const mdblist = require('../dist/server/utils/mdbList.js');
const simkl = require('../dist/server/utils/simklUtils.js');
const trakt = require('../dist/server/utils/traktUtils.js');

function configFor(catalogId, type) {
  return {
    userUUID: 'provider-error-user',
    language: 'en-US',
    sfw: false,
    includeAdult: true,
    apiKeys: {
      tvdb: 'tvdb-key',
      tmdb: 'tmdb-key',
      mdblist: 'mdblist-key',
      simklTokenId: 'simkl-token',
    },
    catalogs: [{
      id: catalogId,
      type,
      sourceUrl: catalogId.startsWith('custom.') ? 'https://addon.invalid/catalog' : undefined,
      metadata: {
        discover: { params: {} },
        mergedSources: [],
      },
    }],
  };
}

async function assertRealHandlerFailure({ dependency, method, catalogId, type = 'movie', error }) {
  clearProviderBatchCacheForTests();
  const original = dependency[method];
  let providerCalls = 0;
  dependency[method] = async () => {
    providerCalls += 1;
    throw error;
  };
  const pages = new Map();
  let terminal = null;
  const config = configFor(catalogId, type);
  try {
    const adapter = createCatalogSourceAdapter({
      catalogId,
      catalogConfig: config.catalogs[0],
      canonicalPageSize: 20,
      querySignature: `error-${catalogId}`,
      type,
      language: 'en-US',
      userUUID: config.userUUID,
      useRedisBatchCache: false,
      fetchPage: async (page, nativePageSize) => {
        const providerPage = catalogId === 'tvdb.collections' ? page - 1 : page;
        const result = await getCatalog(
          type, 'en-US', providerPage, catalogId, null, config, config.userUUID, false,
          catalogId.startsWith('custom.') ? (page - 1) * nativePageSize : undefined
        );
        return providerPageResultFromHandler({
          catalogId,
          canonicalPageSize: 20,
          page,
          nativePageSize,
          metas: result.metas,
        });
      },
    });
    await assert.rejects(() => hydrateCanonicalPageWindow({
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
    }), error);
    assert.ok(providerCalls >= 1);
    assert.equal(pages.size, 0);
    assert.equal(terminal, null);
  } finally {
    dependency[method] = original;
  }
}

const failures = [
  { name: 'TVDB Discover HTTP 503', dependency: tvdb, method: 'filter', catalogId: 'tvdb.discover.error', error: Object.assign(new Error('TVDB 503'), { status: 503 }) },
  { name: 'TMDB Discover HTTP 503', dependency: tmdb, method: 'discoverMovie', catalogId: 'tmdb.discover.error', error: Object.assign(new Error('TMDB discover 503'), { status: 503 }) },
  { name: 'TMDB Collection HTTP 503', dependency: tmdb, method: 'collectionInfo', catalogId: 'tmdb.collection.42', error: Object.assign(new Error('TMDB collection 503'), { status: 503 }) },
  { name: 'TMDB List HTTP 503', dependency: tmdb, method: 'getTmdbListItems', catalogId: 'tmdb.list.42', error: Object.assign(new Error('TMDB list 503'), { status: 503 }) },
  { name: 'External Addon timeout', dependency: stremthru, method: 'fetchStremThruCatalog', catalogId: 'custom.timeout', error: new Error('request timeout') },
  { name: 'MDBList Up Next HTTP 429', dependency: mdblist, method: 'fetchMDBListUpNext', catalogId: 'mdblist.upnext', type: 'series', error: Object.assign(new Error('MDBList 429'), { status: 429 }) },
  { name: 'Simkl Discover parse error', dependency: simkl, method: 'fetchSimklGenreItems', catalogId: 'simkl.discover.error', error: new SyntaxError('invalid Simkl JSON') },
  { name: 'Trakt Most Favorited HTTP 503', dependency: trakt, method: 'fetchTraktMostFavoritedItems', catalogId: 'trakt.most_favorited.movies.weekly', error: Object.assign(new Error('Trakt 503'), { status: 503 }) },
  { name: 'TVDB Collections HTTP 503', dependency: tvdb, method: 'getCollectionsList', catalogId: 'tvdb.collections', error: Object.assign(new Error('TVDB collections 503'), { status: 503 }) },
];

for (const failure of failures) {
  test(`${failure.name} is propagated by the real planner handler wrapper`, async () => {
    await assertRealHandlerFailure(failure);
  });
}
