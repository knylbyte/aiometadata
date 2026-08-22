const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveCatalogPageSize,
  withCatalogPageSizeCacheArg,
} = require('../dist/server/lib/catalogPageSize.js');

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
  }, () => resolveCatalogPageSize({ query }, path, cursor));
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

test('a matching follow-up cursor supplies the remembered page size', () => {
  const cursor = { served: 100, upstreamPage: 2, pageOffset: 0, pageSize: 100 };
  assert.equal(resolve({ mode: 'request', path: { skip: '100' }, cursor }), 100);
});

test('request mode falls back when neither request nor matching cursor has a limit', () => {
  assert.equal(resolve({ mode: 'request', fallback: 35 }), 35);
});

test('catalog cache arguments differ for page sizes 20 and 100', () => {
  const page20 = withCatalogPageSizeCacheArg({ page: 1 }, 20);
  const page100 = withCatalogPageSizeCacheArg({ page: 1 }, 100);
  assert.notEqual(JSON.stringify(page20), JSON.stringify(page100));
  assert.equal(page20._pageSize, 20);
  assert.equal(page100._pageSize, 100);
});
