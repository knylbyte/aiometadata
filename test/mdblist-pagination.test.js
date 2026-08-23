const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CATALOG_LIST_ITEMS_SIZE = '20';
process.env.CATALOG_FILTER_FILL_MAX_PAGES = '5';
process.env.HOST_NAME = process.env.HOST_NAME || 'http://localhost:7000';

const requestTrackerPath = require.resolve('../dist/server/lib/requestTracker.js');
require.cache[requestTrackerPath] = {
  id: requestTrackerPath,
  filename: requestTrackerPath,
  loaded: true,
  exports: new Proxy({}, { get: () => () => undefined }),
};

const redisModule = require('../dist/server/lib/redisClient.js');
const redis = redisModule.default || redisModule;
const redisValues = new Map();
const redisSetKeys = [];

redis.get = async (key) => redisValues.get(key) ?? null;
redis.getBuffer = async () => null;
redis.set = async (key, value) => {
  redisSetKeys.push(key);
  redisValues.set(key, String(value));
  return 'OK';
};
redis.del = async (key) => redisValues.delete(key) ? 1 : 0;

const httpClient = require('../dist/server/utils/httpClient.js');
const requestedUrls = [];
const httpResponses = [];

httpClient.httpGet = async (url) => {
  requestedUrls.push(new URL(url));
  const response = httpResponses.shift();
  assert.ok(response, `Unexpected HTTP request: ${url}`);
  if (response instanceof Error) throw response;
  return response;
};

const {
  fetchMDBListExternalItems,
  normalizeMDBListByNameItemsUrl,
  usesMdblistExternalItemsEndpoint,
} = require('../dist/server/utils/mdbList.js');
const {
  cursorKey,
  fillFilteredPage,
  readCursor,
  resolveStartPage,
  writeCursor,
} = require('../dist/server/lib/catalogPagination.js');

const sourceUrl = 'https://api.mdblist.com/lists/nobnobz/netflix/items';

test('normalizes only public MDBList by-name item URLs for the requested catalog type', () => {
  assert.equal(
    normalizeMDBListByNameItemsUrl(sourceUrl, 'movie'),
    `${sourceUrl}/movie`
  );
  assert.equal(
    normalizeMDBListByNameItemsUrl(sourceUrl, 'series'),
    `${sourceUrl}/show`
  );
  assert.equal(normalizeMDBListByNameItemsUrl(sourceUrl, 'all'), sourceUrl);
  assert.equal(
    normalizeMDBListByNameItemsUrl(`${sourceUrl}/`, 'movie'),
    `${sourceUrl}/movie`
  );
  assert.equal(
    normalizeMDBListByNameItemsUrl(`${sourceUrl}?sort=rank&order=asc`, 'series'),
    `${sourceUrl}/show?sort=rank&order=asc`
  );
  assert.equal(
    normalizeMDBListByNameItemsUrl(`${sourceUrl}/movie`, 'movie'),
    `${sourceUrl}/movie`
  );
  assert.equal(
    normalizeMDBListByNameItemsUrl(`${sourceUrl}/movie`, 'series'),
    `${sourceUrl}/show`
  );

  const externalUrl = 'https://api.mdblist.com/external/lists/123/items';
  const foreignUrl = 'https://example.com/lists/nobnobz/netflix/items';
  assert.equal(normalizeMDBListByNameItemsUrl(externalUrl, 'movie'), externalUrl);
  assert.equal(normalizeMDBListByNameItemsUrl(foreignUrl, 'movie'), foreignUrl);
  assert.equal(usesMdblistExternalItemsEndpoint({ sourceUrl }), true);
  assert.equal(usesMdblistExternalItemsEndpoint({ sourceUrl: `${sourceUrl}/show` }), true);
  assert.equal(usesMdblistExternalItemsEndpoint({ sourceUrl: externalUrl }), true);
  assert.equal(usesMdblistExternalItemsEndpoint({ sourceUrl: foreignUrl }), false);
});

test('uses typed URLs, limit, and offset in external MDBList HTTP requests and cache keys', async () => {
  requestedUrls.length = 0;
  redisSetKeys.length = 0;
  httpResponses.push(
    { data: [{ id: 1, mediatype: 'movie' }], headers: {} },
    { data: { movies: [], shows: [{ id: 2, mediatype: 'show' }] }, headers: {} }
  );

  const movieResult = await fetchMDBListExternalItems(
    sourceUrl,
    'test-api-key',
    'en-US',
    1,
    undefined,
    undefined,
    undefined,
    'movie',
    true
  );
  const seriesResult = await fetchMDBListExternalItems(
    sourceUrl,
    'test-api-key',
    'en-US',
    2,
    undefined,
    undefined,
    undefined,
    'series',
    true
  );

  assert.equal(requestedUrls.length, 2);
  assert.equal(requestedUrls[0].pathname, '/lists/nobnobz/netflix/items/movie');
  assert.equal(requestedUrls[0].searchParams.get('limit'), '20');
  assert.equal(requestedUrls[0].searchParams.get('offset'), '0');
  assert.equal(requestedUrls[1].pathname, '/lists/nobnobz/netflix/items/show');
  assert.equal(requestedUrls[1].searchParams.get('limit'), '20');
  assert.equal(requestedUrls[1].searchParams.get('offset'), '20');
  assert.deepEqual(movieResult.items, [{ id: 1, mediatype: 'movie' }]);
  assert.deepEqual(seriesResult.items, [{ id: 2, mediatype: 'show' }]);
  assert.equal(movieResult.exhaustion, 'unknown');
  assert.equal(seriesResult.exhaustion, 'unknown');
  assert.ok(redisSetKeys.some((key) => key.includes('/items/movie')));
  assert.ok(redisSetKeys.some((key) => key.includes('/items/show')));
});

function metas(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index + 1}` }));
}

async function requestCatalogPage({ key, skip, legacyPage, pages, fetchSequence, filter = async (items) => items }) {
  const { startPage, startOffset, matched } = await resolveStartPage(key, skip, legacyPage);
  const filled = await fillFilteredPage({
    startPage,
    startOffset,
    pageSize: 20,
    fetchPage: async (page) => {
      fetchSequence.push(page);
      return pages.get(page) || [];
    },
    filter,
  });

  await writeCursor(key, {
    served: skip + filled.metas.length,
    upstreamPage: filled.nextPage,
    pageOffset: filled.nextOffset,
  });

  return { ...filled, matched };
}

test('advances movie cursor across shortened 7/13 pages without repeating page 2', async () => {
  const key = cursorKey('movie-user', 'mdblist.nobnobz.netflix.movie', 'movie', undefined);
  const pages = new Map([
    [1, metas('movie-page-1', 7)],
    [2, metas('movie-page-2', 13)],
    [3, metas('movie-page-3', 20)],
  ]);
  const fetchSequence = [];

  const first = await requestCatalogPage({ key, skip: 0, legacyPage: 1, pages, fetchSequence });
  const second = await requestCatalogPage({ key, skip: 7, legacyPage: 2, pages, fetchSequence });
  const third = await requestCatalogPage({ key, skip: 20, legacyPage: 2, pages, fetchSequence });

  assert.deepEqual(fetchSequence, [1, 2, 3]);
  assert.equal(second.matched, true);
  assert.equal(third.matched, true);
  const deliveredIds = [...first.metas, ...second.metas, ...third.metas].map((meta) => meta.id);
  assert.equal(new Set(deliveredIds).size, deliveredIds.length);
});

test('advances series cursor across shortened 13/7 pages without repeating page 2', async () => {
  const key = cursorKey('series-user', 'mdblist.nobnobz.netflix.show', 'series', undefined);
  const pages = new Map([
    [1, metas('series-page-1', 13)],
    [2, metas('series-page-2', 7)],
    [3, metas('series-page-3', 20)],
  ]);
  const fetchSequence = [];

  await requestCatalogPage({ key, skip: 0, legacyPage: 1, pages, fetchSequence });
  await requestCatalogPage({ key, skip: 13, legacyPage: 2, pages, fetchSequence });
  await requestCatalogPage({ key, skip: 20, legacyPage: 2, pages, fetchSequence });

  assert.deepEqual(fetchSequence, [1, 2, 3]);
});

test('keeps full 20-item pages on the 1/2/3 sequence', async () => {
  const key = cursorKey('full-user', 'mdblist.nobnobz.netflix.movie', 'movie', undefined);
  const pages = new Map([
    [1, metas('full-page-1', 20)],
    [2, metas('full-page-2', 20)],
    [3, metas('full-page-3', 20)],
  ]);
  const fetchSequence = [];

  await requestCatalogPage({ key, skip: 0, legacyPage: 1, pages, fetchSequence });
  await requestCatalogPage({ key, skip: 20, legacyPage: 2, pages, fetchSequence });
  await requestCatalogPage({ key, skip: 40, legacyPage: 3, pages, fetchSequence });

  assert.deepEqual(fetchSequence, [1, 2, 3]);
});

test('separates movie and series cursors for the same MDBList source', async () => {
  const movieKey = cursorKey('shared-user', 'mdblist.nobnobz.netflix', 'movie', 'Drama');
  const seriesKey = cursorKey('shared-user', 'mdblist.nobnobz.netflix', 'series', 'Drama');
  assert.notEqual(movieKey, seriesKey);

  await writeCursor(movieKey, { served: 7, upstreamPage: 2, pageOffset: 0 });
  await writeCursor(seriesKey, { served: 13, upstreamPage: 4, pageOffset: 3 });

  assert.deepEqual(await resolveStartPage(movieKey, 7, 99), {
    startPage: 2,
    startOffset: 0,
    matched: true,
  });
  assert.deepEqual(await resolveStartPage(seriesKey, 13, 99), {
    startPage: 4,
    startOffset: 3,
    matched: true,
  });
});

test('uses the legacy page once on cursor mismatch and does not clear cursor history at skip zero', async () => {
  const key = cursorKey('mismatch-user', 'mdblist.nobnobz.netflix.movie', 'movie', undefined);
  await writeCursor(key, { served: 7, upstreamPage: 2, pageOffset: 0 });

  assert.deepEqual(await resolveStartPage(key, 20, 2), {
    startPage: 2,
    startOffset: 0,
    matched: false,
  });

  const fetchSequence = [];
  const mismatchResult = await fillFilteredPage({
    startPage: 2,
    pageSize: 20,
    fetchPage: async (page) => {
      fetchSequence.push(page);
      return [];
    },
    filter: async (items) => items,
  });
  assert.deepEqual(fetchSequence, [2]);
  assert.equal(mismatchResult.exhausted, true);

  assert.deepEqual(await resolveStartPage(key, 0, 42), {
    startPage: 1,
    startOffset: 0,
    matched: true,
  });
  assert.deepEqual(await readCursor(key), { served: 7, upstreamPage: 2, pageOffset: 0 });
});

test('cursor v4 separates parallel clients by their actually served skip', async () => {
  const query = 'same-query-signature';
  const clientA = cursorKey('parallel-user', 'mdblist.demo', 'movie', query, 100);
  const clientB = cursorKey('parallel-user', 'mdblist.demo', 'movie', query, 20);
  assert.notEqual(clientA, clientB);

  await writeCursor(clientA, {
    served: 100,
    upstreamPage: 6,
    pageOffset: 0,
    responseLimit: 100,
    sourceResume: { kind: 'offset', offset: 100 },
  });
  await writeCursor(clientB, {
    served: 20,
    upstreamPage: 2,
    pageOffset: 0,
    responseLimit: 20,
    sourceResume: { kind: 'offset', offset: 20 },
  });

  assert.equal((await readCursor(clientA)).sourceResume.offset, 100);
  assert.equal((await readCursor(clientB)).sourceResume.offset, 20);
});

test('retains multi-page fill behavior for filter-active catalogs', async () => {
  const fetchSequence = [];
  const result = await fillFilteredPage({
    startPage: 1,
    pageSize: 20,
    fetchPage: async (page) => {
      fetchSequence.push(page);
      return metas(`filtered-page-${page}`, 20);
    },
    filter: async (items) => items.filter((_, index) => index < (fetchSequence.length === 1 ? 5 : 15)),
  });

  assert.deepEqual(fetchSequence, [1, 2]);
  assert.equal(result.metas.length, 20);
  assert.equal(result.nextPage, 3);
});
