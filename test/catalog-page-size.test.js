const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveCatalogResponseLimit,
} = require('../dist/server/lib/catalogPageSize.js');
const { buildCanonicalCatalogCacheArgs } = require('../dist/server/lib/catalogFetchPlanner.js');

function withCatalogEnv(values, callback) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = String(value);
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function resolve({ mode, fixed = 20, fallback = 20, query = {}, path = {}, cursor = null }) {
  return withCatalogEnv({
    CATALOG_PAGE_SIZE_MODE: mode,
    CATALOG_LIST_ITEMS_SIZE: fixed,
    CATALOG_REQUEST_LIMIT_FALLBACK: fallback,
  }, () => resolveCatalogResponseLimit({ query }, path, cursor));
}

test('fixed mode ignores a request limit', () => {
  assert.equal(resolve({ mode: 'fixed', query: { limit: '100' } }), 20);
});

test('request mode accepts a direct query limit', () => {
  assert.equal(resolve({ mode: 'request', query: { limit: '100' } }), 100);
});

test('request mode accepts a URL-encoded limit inside query extra', () => {
  assert.equal(resolve({ mode: 'request', query: { extra: 'limit%3D100' } }), 100);
});

test('direct query limit wins over the nested extra limit', () => {
  assert.equal(resolve({ mode: 'request', query: { limit: '50', extra: 'limit=100' } }), 50);
});

test('invalid request limits use the fallback', () => {
  for (const limit of ['0', '-1', 'abc', '']) {
    assert.equal(resolve({ mode: 'request', fallback: 30, query: { limit } }), 30);
  }
});

test('request limits above the hard maximum are clamped to 100', () => {
  assert.equal(resolve({ mode: 'request', query: { limit: '500' } }), 100);
});

test('a matching follow-up cursor supplies the remembered response limit', () => {
  const cursor = { served: 100, upstreamPage: 6, pageOffset: 0, responseLimit: 100 };
  assert.equal(resolve({ mode: 'request', path: { skip: '100' }, cursor }), 100);
});

test('request mode falls back when neither request nor matching cursor has a limit', () => {
  assert.equal(resolve({ mode: 'request', fallback: 35 }), 35);
});

test('client limits 20 and 100 use the same canonical page key', () => {
  const forLimit20 = buildCanonicalCatalogCacheArgs({ page: 1 }, 1, 20);
  const forLimit100 = buildCanonicalCatalogCacheArgs({ page: 1 }, 1, 20);
  assert.deepEqual(forLimit20, forLimit100);
  assert.equal('_pageSize' in forLimit20, false);
  assert.equal(forLimit20._canonicalPageSize, 20);
});
