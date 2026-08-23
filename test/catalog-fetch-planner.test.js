const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CATALOG_CANONICAL_CACHE_VERSION,
  assembleCanonicalResponse,
  buildCanonicalCatalogCacheArgs,
  createSequentialPageBatchFetcher,
  hydrateCanonicalPageWindow,
  planMissingPageRanges,
  resolveCanonicalPageWindow,
  splitIntoCanonicalPages,
} = require('../dist/server/lib/catalogFetchPlanner.js');

const metas = (start, count) => Array.from({ length: count }, (_, index) => ({ id: `id-${start + index}` }));
const variableCapabilities = {
  supportsOffset: true,
  supportsVariableLimit: true,
  maxLimit: 100,
  cursorBased: false,
  stableOrdering: true,
  fixedPageSize: 20,
};

function memoryCache(initial = new Map()) {
  const pages = new Map(initial);
  return {
    pages,
    readPage: async page => pages.get(page) || null,
    writePage: async (page, value) => {
      pages.set(page, value);
      return value;
    },
  };
}

test('limit 100 spans five canonical pages and one variable upstream batch', async () => {
  const cache = memoryCache();
  const calls = [];
  const window = resolveCanonicalPageWindow(0, 100, 20);
  const result = await hydrateCanonicalPageWindow({
    window,
    capabilities: variableCapabilities,
    readPage: cache.readPage,
    writePage: cache.writePage,
    fetchBatch: async batch => {
      calls.push({ offset: batch.offset, limit: batch.limit });
      return { items: metas(batch.offset, batch.limit), rawCount: batch.limit, nextOffset: batch.offset + batch.limit, exhausted: false };
    },
  });

  assert.deepEqual(window.pages, [1, 2, 3, 4, 5]);
  assert.deepEqual(calls, [{ offset: 0, limit: 100 }]);
  assert.deepEqual([...result.pages.keys()], [1, 2, 3, 4, 5]);
  assert.equal(result.pages.get(5).metas.length, 20);
});

test('partially warm cache fetches only the contiguous missing range', async () => {
  const initial = splitIntoCanonicalPages(metas(40, 40), 3, 20, false, 40, 80, 40);
  const cache = memoryCache(initial);
  const calls = [];
  const window = resolveCanonicalPageWindow(40, 100, 20);
  await hydrateCanonicalPageWindow({
    window,
    capabilities: variableCapabilities,
    readPage: cache.readPage,
    writePage: cache.writePage,
    fetchBatch: async batch => {
      calls.push({ offset: batch.offset, limit: batch.limit });
      return { items: metas(batch.offset, batch.limit), rawCount: batch.limit, nextOffset: batch.offset + batch.limit, exhausted: false };
    },
  });
  assert.deepEqual(calls, [{ offset: 80, limit: 60 }]);
  assert.deepEqual([...cache.pages.keys()], [3, 4, 5, 6, 7]);
});

test('skip 40 and limit 50 align fetch to 60 but return at most 50', async () => {
  const cache = memoryCache();
  const calls = [];
  const window = resolveCanonicalPageWindow(40, 50, 20);
  const result = await hydrateCanonicalPageWindow({
    window,
    capabilities: variableCapabilities,
    readPage: cache.readPage,
    writePage: cache.writePage,
    fetchBatch: async batch => {
      calls.push({ offset: batch.offset, limit: batch.limit });
      return { items: metas(batch.offset, batch.limit), rawCount: batch.limit, nextOffset: batch.offset + batch.limit, exhausted: false };
    },
  });
  assert.deepEqual(calls, [{ offset: 40, limit: 60 }]);
  assert.equal(assembleCanonicalResponse(window, result.pages).length, 50);
});

test('provider without variable limits falls back to multiple fixed requests', async () => {
  const capabilities = { ...variableCapabilities, supportsOffset: false, supportsVariableLimit: false, maxLimit: 20 };
  const sourceCalls = [];
  const sequential = createSequentialPageBatchFetcher(capabilities, async page => {
    sourceCalls.push(page);
    return metas((page - 1) * 20, 20);
  });
  const cache = memoryCache();
  await hydrateCanonicalPageWindow({
    window: resolveCanonicalPageWindow(0, 100, 20),
    capabilities,
    readPage: cache.readPage,
    writePage: cache.writePage,
    fetchBatch: sequential,
  });
  assert.deepEqual(sourceCalls, [1, 2, 3, 4, 5]);
});

test('cursor providers remain sequential', async () => {
  const capabilities = { ...variableCapabilities, supportsOffset: false, supportsVariableLimit: false, cursorBased: true, maxLimit: 20 };
  const calls = [];
  const sequential = createSequentialPageBatchFetcher(capabilities, async page => {
    calls.push(page);
    return metas((page - 1) * 20, 20);
  });
  const cache = memoryCache();
  await hydrateCanonicalPageWindow({
    window: resolveCanonicalPageWindow(0, 40, 20),
    capabilities,
    readPage: cache.readPage,
    writePage: cache.writePage,
    fetchBatch: sequential,
  });
  assert.deepEqual(calls, [1, 2]);
});

test('local filtering triggers an additional upstream batch', async () => {
  const cache = memoryCache();
  const calls = [];
  await hydrateCanonicalPageWindow({
    window: resolveCanonicalPageWindow(0, 20, 20),
    capabilities: { ...variableCapabilities, maxLimit: 20 },
    readPage: cache.readPage,
    writePage: cache.writePage,
    fetchBatch: async batch => {
      calls.push(batch.offset);
      return { items: metas(batch.offset, 20), rawCount: 20, nextOffset: batch.offset + 20, exhausted: false };
    },
    processItems: items => items.filter((_, index) => index % 2 === 0),
  });
  assert.deepEqual(calls, [0, 20]);
  assert.equal(cache.pages.get(1).metas.length, 20);
});

test('different response windows build identical canonical content after reconstruction loss', async () => {
  const source = metas(0, 140);
  const fetchBatch = async batch => {
    const raw = source.slice(batch.offset, batch.offset + batch.limit);
    return {
      items: raw.filter(item => item.id !== 'id-10'),
      rawCount: raw.length,
      nextOffset: batch.offset + raw.length,
      exhausted: raw.length < batch.limit,
    };
  };

  const largeCache = memoryCache();
  await hydrateCanonicalPageWindow({
    window: resolveCanonicalPageWindow(0, 100, 20),
    capabilities: variableCapabilities,
    readPage: largeCache.readPage,
    writePage: largeCache.writePage,
    fetchBatch,
  });

  const smallCache = memoryCache();
  for (let skip = 0; skip < 100; skip += 20) {
    await hydrateCanonicalPageWindow({
      window: resolveCanonicalPageWindow(skip, 20, 20),
      capabilities: variableCapabilities,
      readPage: smallCache.readPage,
      writePage: smallCache.writePage,
      fetchBatch,
    });
  }

  for (let page = 1; page <= 5; page += 1) {
    assert.deepEqual(smallCache.pages.get(page).metas, largeCache.pages.get(page).metas);
  }
});

test('an incomplete page is cached only after confirmed exhaustion', () => {
  assert.equal(splitIntoCanonicalPages(metas(0, 7), 1, 20, false).size, 0);
  const exhausted = splitIntoCanonicalPages(metas(0, 7), 1, 20, true);
  assert.equal(exhausted.get(1).metas.length, 7);
});

test('runtime and warmup canonical keys share the versioned geometry', () => {
  const runtime = buildCanonicalCatalogCacheArgs({ genre: 'Drama', _pageSize: 100 }, 3, 20);
  const warmup = buildCanonicalCatalogCacheArgs({ genre: 'Drama' }, 3, 20);
  assert.deepEqual(runtime, warmup);
  assert.equal(runtime._catalogPaging, CATALOG_CANONICAL_CACHE_VERSION);
  assert.equal('_pageSize' in runtime, false);
  assert.deepEqual(planMissingPageRanges([3, 4, 5], [3], 20), [
    { startPage: 4, endPage: 5, offset: 60, limit: 40 },
  ]);
});
