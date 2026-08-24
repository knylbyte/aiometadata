const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CATALOG_CANONICAL_CACHE_VERSION,
  CatalogProviderNoProgressError,
  assembleCanonicalResponse,
  buildCanonicalCatalogCacheArgs,
  buildCatalogQuerySignature,
  buildCatalogSourceQuerySignature,
  buildDeliveryCursorSignature,
  hydrateCanonicalPageWindow,
  resolveCanonicalPageWindow,
} = require('../dist/server/lib/catalogFetchPlanner.js');
const {
  createCatalogSourceAdapter,
  attachProviderPageMetadata,
  CATALOG_PROVIDER_REGISTRY,
  createFixedPageAdapter,
  getCatalogProviderDefinition,
  providerPageResultFromHandler,
} = require('../dist/server/lib/catalogSourceAdapter.js');
const { fillFilteredPage } = require('../dist/server/lib/catalogPagination.js');
const {
  clearProviderBatchCacheForTests,
  fetchProviderBatchCached,
  providerBatchCacheKey,
} = require('../dist/server/lib/providerBatchCache.js');

const metas = (start, count) => Array.from({ length: count }, (_, index) => ({ id: `id-${start + index}` }));

function fixedPageEntries(page, pageMetas, nativePageSize) {
  return pageMetas.map((meta, index) => ({
    meta,
    sourcePosition: { kind: 'page-index', page, index },
    resumeAfter: index + 1 < nativePageSize
      ? { kind: 'page-index', page, index: index + 1 }
      : { kind: 'page-index', page: page + 1, index: 0 },
  }));
}

function memoryState(initial = new Map(), initialTerminal = null) {
  const pages = new Map(initial);
  let terminal = initialTerminal;
  return {
    pages,
    readPage: async page => pages.get(page) || null,
    writePage: async (page, value) => {
      pages.set(page, value);
      return value;
    },
    readTerminal: async () => terminal,
    writeTerminal: async value => {
      terminal = value;
    },
    getTerminal: () => terminal,
  };
}

function offsetAdapter(raw, calls, options = {}) {
  const maxLimit = options.maxLimit || 20;
  return {
    provider: options.provider || 'test-offset',
    sourceIdentity: options.sourceIdentity || 'source',
    querySignature: options.querySignature || 'query',
    capabilities: {
      supportsOffset: true,
      supportsVariableLimit: true,
      maxLimit,
      cursorBased: false,
      stableOrdering: true,
    },
    initialResumeState: { kind: 'offset', offset: 0 },
    fetchBatch: async request => {
      const offset = request.resumeState.offset;
      calls.push({ offset, limit: request.requestedRawCount });
      if (options.failAt === offset) throw options.error || new Error('provider failed');
      const slice = raw.slice(offset, offset + request.requestedRawCount);
      const entries = slice.flatMap((meta, index) => meta ? [{
        meta,
        sourcePosition: { kind: 'offset', offset: offset + index },
        resumeAfter: { kind: 'offset', offset: offset + index + 1 },
      }] : []);
      const resumeAfterBatch = { kind: 'offset', offset: offset + slice.length };
      const exhaustion = options.exhaustion
        ? options.exhaustion({ offset, slice, raw })
        : offset + slice.length >= raw.length ? 'confirmed' : 'not-exhausted';
      return { entries, rawCount: slice.length, resumeAfterBatch, exhaustion };
    },
  };
}

function hydrate(state, adapter, skip, limit, extra = {}) {
  return hydrateCanonicalPageWindow({
    window: resolveCanonicalPageWindow(skip, limit, 20),
    adapter,
    readPage: state.readPage,
    writePage: state.writePage,
    readTerminal: state.readTerminal,
    writeTerminal: state.writeTerminal,
    ...extra,
  });
}

test('reconstruction loss in the fill batch preserves every unconsumed valid source item', async () => {
  const raw = metas(0, 60);
  raw[19] = null;
  raw[39] = null;
  const calls = [];
  const state = memoryState();
  const result = await hydrate(state, offsetAdapter(raw, calls), 0, 40);

  assert.deepEqual(calls, [
    { offset: 0, limit: 20 },
    { offset: 20, limit: 20 },
    { offset: 40, limit: 20 },
  ]);
  assert.deepEqual(result.pages.get(1).metas.map(meta => meta.id), [
    ...metas(0, 19).map(meta => meta.id),
    'id-20',
  ]);
  assert.deepEqual(result.pages.get(1)._canonical.sourceNext, { kind: 'offset', offset: 21 });
  assert.deepEqual(result.pages.get(2)._canonical.sourceStart, { kind: 'offset', offset: 21 });
  assert.deepEqual(result.pages.get(2).metas.map(meta => meta.id), [
    ...metas(21, 18).map(meta => meta.id),
    'id-40',
    'id-41',
  ]);
  assert.equal(new Set([...result.pages.get(1).metas, ...result.pages.get(2).metas].map(meta => meta.id)).size, 40);
});

test('deduplication advances source provenance past inspected duplicates', async () => {
  const raw = metas(0, 50);
  raw[1] = { id: 'id-0' };
  const state = memoryState();
  await hydrate(state, offsetAdapter(raw, []), 0, 40);

  assert.equal(state.pages.get(1).metas.length, 20);
  assert.equal(state.pages.get(2).metas.length, 20);
  assert.equal(state.pages.get(1)._canonical.sourceNext.offset, 21);
  assert.equal(state.pages.get(2)._canonical.sourceStart.offset, 21);
  const ids = [...state.pages.get(1).metas, ...state.pages.get(2).metas].map(meta => meta.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('id-39'));
});

test('AniList native pages of 50 split into canonical pages of 20 without gaps', async () => {
  clearProviderBatchCacheForTests();
  const providerCalls = [];
  const adapter = createCatalogSourceAdapter({
    catalogId: 'anilist.trending',
    canonicalPageSize: 20,
    querySignature: 'anilist-query',
    type: 'series',
    language: 'en-US',
    useRedisBatchCache: false,
    fetchPage: async page => {
      providerCalls.push(page);
      const pageMetas = metas((page - 1) * 50, 50);
      return {
        metas: pageMetas,
        entries: fixedPageEntries(page, pageMetas, 50),
        rawCount: 50,
        exhaustion: page === 2 ? 'confirmed' : 'not-exhausted',
        resumeAfterBatch: { kind: 'page-index', page: page + 1, index: 0 },
      };
    },
  });
  const state = memoryState();
  await hydrate(state, adapter, 0, 60);

  assert.deepEqual(state.pages.get(1).metas.map(meta => meta.id), metas(0, 20).map(meta => meta.id));
  assert.deepEqual(state.pages.get(2).metas.map(meta => meta.id), metas(20, 20).map(meta => meta.id));
  assert.deepEqual(state.pages.get(3).metas.map(meta => meta.id), metas(40, 20).map(meta => meta.id));
  assert.deepEqual(providerCalls, [1, 2]);

  state.pages.delete(3);
  await hydrate(state, adapter, 40, 20);
  assert.deepEqual(state.pages.get(3).metas.map(meta => meta.id), metas(40, 20).map(meta => meta.id));
  assert.deepEqual(providerCalls, [1, 2], 'provider page 1/2 should come from provider-batch:v4');
  assert.equal(getCatalogProviderDefinition({ catalogId: 'anilist.discover.test', canonicalPageSize: 20 }).capabilities.nativePageSize, 50);
});

for (const error of [
  Object.assign(new Error('HTTP 503'), { status: 503 }),
  Object.assign(new Error('HTTP 429'), { status: 429 }),
  new Error('request timeout'),
]) {
  test(`${error.message} is not cached as EOF`, async () => {
    const raw = metas(0, 7);
    const state = memoryState();
    const adapter = offsetAdapter(raw, [], {
      failAt: 7,
      error,
      exhaustion: ({ offset }) => offset === 0 ? 'not-exhausted' : 'unknown',
    });
    await assert.rejects(() => hydrate(state, adapter, 0, 20), error);
    assert.equal(state.pages.size, 0);
    assert.equal(state.getTerminal(), null);
  });
}

test('unknown exhaustion returns progress transiently without persisting a partial page', async () => {
  const calls = [];
  const adapter = {
    ...offsetAdapter([], calls),
    fetchBatch: async request => {
      const offset = request.resumeState.offset;
      calls.push(offset);
      if (offset === 0) {
        return {
          entries: metas(0, 7).map((meta, index) => ({
            meta,
            sourcePosition: { kind: 'offset', offset: index },
            resumeAfter: { kind: 'offset', offset: index + 1 },
          })),
          rawCount: 7,
          resumeAfterBatch: { kind: 'offset', offset: 7 },
          exhaustion: 'unknown',
        };
      }
      return {
        entries: [],
        rawCount: 0,
        resumeAfterBatch: { kind: 'offset', offset: 7 },
        exhaustion: 'unknown',
      };
    },
  };
  const state = memoryState();
  const result = await hydrate(state, adapter, 0, 20);
  assert.deepEqual(result.pages.get(1).metas.map(meta => meta.id), metas(0, 7).map(meta => meta.id));
  assert.equal(result.pages.get(1)._canonical.transient, true);
  assert.deepEqual(result.pages.get(1)._canonical.sourceNext, { kind: 'offset', offset: 7 });
  assert.equal(state.pages.size, 0);
  assert.equal(state.getTerminal(), null);
});

test('an exact full batch with explicit exhaustion writes a terminal marker without an empty fetch', async () => {
  const calls = [];
  const state = memoryState();
  const result = await hydrate(state, offsetAdapter(metas(0, 20), calls), 0, 20);
  assert.equal(calls.length, 1);
  assert.equal(result.exhausted, true);
  assert.equal(state.pages.get(1)._canonical.exhausted, true);
  assert.deepEqual(state.getTerminal(), {
    schema: 'v7',
    sourceEnd: { kind: 'offset', offset: 20 },
    lastCanonicalPage: 1,
  });
});

test('a final partial canonical page is written only for confirmed exhaustion', async () => {
  const state = memoryState();
  await hydrate(state, offsetAdapter(metas(0, 7), []), 0, 20);
  assert.equal(state.pages.get(1).metas.length, 7);
  assert.equal(state.pages.get(1)._canonical.exhausted, true);
  assert.equal(state.getTerminal().lastCanonicalPage, 1);
});

test('local filtering advances provenance and fetches additional source batches', async () => {
  const calls = [];
  const state = memoryState();
  await hydrate(state, offsetAdapter(metas(0, 60), calls), 0, 20, {
    acceptEntry: entry => Number(entry.meta.id.split('-')[1]) % 2 === 0,
  });
  assert.deepEqual(calls, [
    { offset: 0, limit: 20 },
    { offset: 20, limit: 20 },
  ]);
  assert.equal(state.pages.get(1).metas.length, 20);
  assert.deepEqual(state.pages.get(1)._canonical.sourceNext, { kind: 'offset', offset: 39 });
});

test('a partially evicted canonical page is reconstructed identically from its anchor', async () => {
  const calls = [];
  const state = memoryState();
  const adapter = offsetAdapter(metas(0, 100), calls, { maxLimit: 100 });
  await hydrate(state, adapter, 0, 100);
  const original = state.pages.get(3).metas.map(meta => meta.id);
  state.pages.delete(3);

  await hydrate(state, adapter, 40, 20);
  assert.deepEqual(state.pages.get(3).metas.map(meta => meta.id), original);
  assert.equal(new Set([
    ...state.pages.get(2).metas,
    ...state.pages.get(3).metas,
    ...state.pages.get(4).metas,
  ].map(meta => meta.id)).size, 60);
});

test('runtime and warmer share canonical pages and identical concurrent provider batches', async () => {
  clearProviderBatchCacheForTests();
  const calls = [];
  const state = memoryState();
  const querySignature = buildCatalogQuerySignature({
    catalogId: 'mdblist.demo',
    type: 'movie',
    language: 'en-US',
    canonicalPageSize: 20,
    args: { genre: 'Drama' },
  });
  const createAdapter = () => ({
    provider: 'mdblist',
    sourceIdentity: 'same-source',
    querySignature,
    capabilities: {
      supportsOffset: true,
      supportsVariableLimit: true,
      maxLimit: 100,
      cursorBased: false,
      stableOrdering: true,
    },
    initialResumeState: { kind: 'offset', offset: 0 },
    fetchBatch: request => fetchProviderBatchCached({
      provider: 'mdblist',
      sourceIdentity: 'same-source',
      querySignature,
      resumeState: request.resumeState,
      requestedUpstreamLimit: request.requestedRawCount,
      useRedis: false,
      loader: async () => {
        calls.push(request.resumeState.offset);
        await new Promise(resolve => setTimeout(resolve, 10));
        const offset = request.resumeState.offset;
        return {
          entries: metas(offset, request.requestedRawCount).map((meta, index) => ({
            meta,
            sourcePosition: { kind: 'offset', offset: offset + index },
            resumeAfter: { kind: 'offset', offset: offset + index + 1 },
          })),
          rawCount: request.requestedRawCount,
          resumeAfterBatch: { kind: 'offset', offset: offset + request.requestedRawCount },
          exhaustion: 'not-exhausted',
        };
      },
    }),
  });

  await Promise.all([
    hydrate(state, createAdapter(), 0, 100),
    hydrate(state, createAdapter(), 0, 100),
  ]);
  assert.deepEqual(calls, [0]);

  const beforeWarmHit = calls.length;
  const hit = await hydrate(state, createAdapter(), 0, 100);
  assert.equal(calls.length, beforeWarmHit);
  assert.equal(assembleCanonicalResponse(resolveCanonicalPageWindow(0, 100, 20), hit.pages).length, 100);
});

test('failed provider batches are not retained by the single-flight cache', async () => {
  clearProviderBatchCacheForTests();
  let attempts = 0;
  const input = {
    provider: 'test',
    sourceIdentity: 'source',
    querySignature: 'query',
    resumeState: { kind: 'offset', offset: 0 },
    requestedUpstreamLimit: 20,
    useRedis: false,
  };
  await assert.rejects(() => fetchProviderBatchCached({
    ...input,
    loader: async () => {
      attempts += 1;
      throw new Error('temporary failure');
    },
  }), /temporary failure/);
  const result = await fetchProviderBatchCached({
    ...input,
    loader: async () => {
      attempts += 1;
      return {
        entries: [],
        rawCount: 0,
        resumeAfterBatch: { kind: 'offset', offset: 0 },
        exhaustion: 'confirmed',
      };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.exhaustion, 'confirmed');
});

test('a terminal marker suppresses requests beyond the confirmed final page', async () => {
  const state = memoryState(new Map(), {
    schema: 'v7',
    sourceEnd: { kind: 'offset', offset: 125 },
    lastCanonicalPage: 7,
  });
  const calls = [];
  const result = await hydrate(state, offsetAdapter(metas(0, 200), calls), 140, 20);
  assert.equal(result.exhausted, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(assembleCanonicalResponse(resolveCanonicalPageWindow(140, 20, 20), result.pages), []);
});

test('fixed and cursor providers are fetched sequentially using adapter-native geometry', async () => {
  for (const cursorBased of [false, true]) {
    const calls = [];
    const adapter = {
      provider: cursorBased ? 'cursor' : 'fixed',
      sourceIdentity: 'source',
      querySignature: 'query',
      capabilities: {
        supportsOffset: false,
        supportsVariableLimit: false,
        maxLimit: 20,
        nativePageSize: 20,
        cursorBased,
        stableOrdering: true,
      },
      initialResumeState: { kind: 'page-index', page: 1, index: 0 },
      fetchBatch: async request => {
        const page = request.resumeState.page;
        calls.push(page);
        return {
          entries: metas((page - 1) * 20, 20).map((meta, index) => ({
            meta,
            sourcePosition: { kind: 'page-index', page, index },
            resumeAfter: index === 19
              ? { kind: 'page-index', page: page + 1, index: 0 }
              : { kind: 'page-index', page, index: index + 1 },
          })),
          rawCount: 20,
          resumeAfterBatch: { kind: 'page-index', page: page + 1, index: 0 },
          exhaustion: 'not-exhausted',
        };
      },
    };
    await hydrate(memoryState(), adapter, 0, 100);
    assert.deepEqual(calls, [1, 2, 3, 4, 5]);
  }
});

test('v6 pages are not read as v7 and response limits do not fork canonical keys', async () => {
  const oldPage = {
    metas: metas(900, 20),
    _canonical: {
      schema: 'v6', page: 1,
      sourceStart: { kind: 'offset', offset: 0 },
      sourceNext: { kind: 'offset', offset: 20 },
      exhausted: false, entryResumes: [],
    },
  };
  const state = memoryState(new Map([[1, oldPage]]));
  const unrelatedMetaCache = new Map([['meta:tmdb:1', { id: 'tmdb:1' }]]);
  await hydrate(state, offsetAdapter(metas(0, 20), []), 0, 20);

  assert.deepEqual(state.pages.get(1).metas.map(meta => meta.id), metas(0, 20).map(meta => meta.id));
  assert.deepEqual(unrelatedMetaCache.get('meta:tmdb:1'), { id: 'tmdb:1' });

  const limit20 = buildCanonicalCatalogCacheArgs({ genre: 'Drama', _pageSize: 20 }, 1, 20, 'same-query');
  const limit100 = buildCanonicalCatalogCacheArgs({ genre: 'Drama', _pageSize: 100 }, 1, 20, 'same-query');
  assert.deepEqual(limit20, limit100);
  assert.equal(limit20._catalogPaging, CATALOG_CANONICAL_CACHE_VERSION);
  assert.equal('_pageSize' in limit20, false);
  assert.equal(providerBatchCacheKey({
    provider: 'mdblist',
    sourceIdentity: 'source',
    querySignature: 'query',
    resumeState: { kind: 'offset', offset: 0 },
    requestedUpstreamLimit: 20,
  }).startsWith('provider-batch:v4:'), true);
});

test('FlixPatrol Top 10 confirms EOF on its successful empty second page', async () => {
  clearProviderBatchCacheForTests();
  const calls = [];
  const adapter = createCatalogSourceAdapter({
    catalogId: 'flixpatrol.netflix.us.movie', canonicalPageSize: 20,
    querySignature: 'flix-top-10', type: 'movie', language: 'en-US', useRedisBatchCache: false,
    fetchPage: async page => {
      calls.push(page);
      const pageMetas = page === 1 ? metas(0, 10) : [];
      return {
        metas: pageMetas,
        entries: fixedPageEntries(page, pageMetas, 10),
        rawCount: pageMetas.length,
        resumeAfterBatch: { kind: 'page-index', page: page + 1, index: 0 },
        exhaustion: page === 2 ? 'confirmed' : 'unknown',
      };
    },
  });
  const state = memoryState();
  const result = await hydrate(state, adapter, 0, 20);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.pages.get(1).metas.length, 10);
  assert.equal(result.pages.get(1)._canonical.exhausted, true);
  assert.equal(state.getTerminal().lastCanonicalPage, 1);
});

test('a configured short fixed page confirms EOF without an extra empty request', async () => {
  const calls = [];
  const fetchPage = createFixedPageAdapter({
    providerId: 'short-page', nativePageSize: 20,
    emptyPageConfirmsEnd: true, shortPageConfirmsEnd: true,
    fetchPage: async page => {
      calls.push(page);
      const pageMetas = page === 1 ? metas(0, 20) : metas(20, 7);
      return {
        metas: pageMetas,
        entries: fixedPageEntries(page, pageMetas, 20),
        rawCount: pageMetas.length,
        resumeAfterBatch: { kind: 'page-index', page: page + 1, index: 0 },
        exhaustion: page === 2 ? 'confirmed' : 'not-exhausted',
      };
    },
  });
  const capabilities = {
    supportsOffset: false, supportsVariableLimit: false, maxLimit: 20, nativePageSize: 20,
    cursorBased: false, stableOrdering: true,
  };
  const adapter = {
    provider: 'short-page', sourceIdentity: 'short-page', querySignature: 'short-page',
    capabilities, initialResumeState: { kind: 'page-index', page: 1, index: 0 },
    fetchBatch: require('../dist/server/lib/catalogFetchPlanner.js').createSequentialPageBatchFetcher(capabilities, fetchPage),
  };
  const state = memoryState();
  await hydrate(state, adapter, 20, 20);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(state.pages.get(2).metas.length, 7);
  assert.equal(state.getTerminal().lastCanonicalPage, 2);
});

test('Trakt Recommendations uses native pages of 50 without losing IDs 20-49', async () => {
  clearProviderBatchCacheForTests();
  const calls = [];
  const adapter = createCatalogSourceAdapter({
    catalogId: 'trakt.recommendations.movies', canonicalPageSize: 20,
    querySignature: 'trakt-recommendations', type: 'movie', language: 'en-US', useRedisBatchCache: false,
    fetchPage: async (page, nativePageSize) => {
      calls.push({ page, nativePageSize });
      const pageMetas = metas((page - 1) * 50, 50);
      return {
        metas: pageMetas,
        entries: fixedPageEntries(page, pageMetas, 50),
        rawCount: 50,
        hasMore: page < 2,
        resumeAfterBatch: { kind: 'page-index', page: page + 1, index: 0 },
        exhaustion: page < 2 ? 'not-exhausted' : 'confirmed',
      };
    },
  });
  const state = memoryState();
  await hydrate(state, adapter, 0, 80);
  assert.deepEqual(calls, [{ page: 1, nativePageSize: 50 }, { page: 2, nativePageSize: 50 }]);
  assert.deepEqual(state.pages.get(1).metas.map(meta => meta.id), metas(0, 20).map(meta => meta.id));
  assert.deepEqual(state.pages.get(2).metas.map(meta => meta.id), metas(20, 20).map(meta => meta.id));
  assert.deepEqual(state.pages.get(3).metas.map(meta => meta.id), metas(40, 20).map(meta => meta.id));
  assert.deepEqual(state.pages.get(4).metas.map(meta => meta.id), metas(60, 20).map(meta => meta.id));
});

test('every registered fixed-page provider passes the real handler contract wrapper', async () => {
  for (const registryEntry of CATALOG_PROVIDER_REGISTRY) {
    clearProviderBatchCacheForTests();
    const definition = getCatalogProviderDefinition({ catalogId: registryEntry.testCatalogId, canonicalPageSize: 20 });
    let usedSize = null;
    const adapter = createCatalogSourceAdapter({
      catalogId: registryEntry.testCatalogId, canonicalPageSize: 20,
      querySignature: `audit-${registryEntry.id}`, type: 'movie', language: 'en-US', useRedisBatchCache: false,
      fetchPage: async (page, nativePageSize) => {
        usedSize = nativePageSize;
        const handlerMetas = attachProviderPageMetadata(metas(0, nativePageSize), {
          rawCount: nativePageSize,
          hasMore: false,
        });
        return providerPageResultFromHandler({
          catalogId: registryEntry.testCatalogId,
          canonicalPageSize: 20,
          page,
          nativePageSize,
          metas: handlerMetas,
        });
      },
      fetchOffsetBatch: async (resumeState, requestedRawCount) => {
        usedSize = requestedRawCount;
        return {
          entries: metas(0, requestedRawCount).map((meta, index) => ({
            meta,
            sourcePosition: { kind: 'offset', offset: resumeState.offset + index },
            resumeAfter: { kind: 'offset', offset: resumeState.offset + index + 1 },
          })),
          rawCount: requestedRawCount,
          resumeAfterBatch: { kind: 'offset', offset: resumeState.offset + requestedRawCount },
          exhaustion: 'not-exhausted',
        };
      },
    });
    const requestedRawCount = definition.capabilities.supportsVariableLimit ? 37 : definition.capabilities.nativePageSize;
    const result = await adapter.fetchBatch({
      resumeState: adapter.initialResumeState, requestedRawCount, limit: requestedRawCount,
      sequential: !definition.capabilities.supportsVariableLimit,
    });
    assert.equal(usedSize, requestedRawCount, registryEntry.id);
    assert.ok(Array.isArray(result.entries), registryEntry.id);
    assert.ok(Number.isInteger(result.rawCount), registryEntry.id);
  }
});

test('fixed-page adapters reject naked arrays and propagate provider errors', async () => {
  const naked = createFixedPageAdapter({
    providerId: 'naked', nativePageSize: 20, emptyPageConfirmsEnd: true, shortPageConfirmsEnd: true,
    fetchPage: async () => [],
  });
  await assert.rejects(() => naked(1), /naked or invalid/);
  for (const error of [
    Object.assign(new Error('HTTP 429'), { status: 429 }),
    Object.assign(new Error('HTTP 503'), { status: 503 }),
    Object.assign(new Error('auth'), { status: 401 }),
    new Error('timeout'), new SyntaxError('invalid json'),
  ]) {
    const adapter = createFixedPageAdapter({
      providerId: 'failure', nativePageSize: 20,
      emptyPageConfirmsEnd: true, shortPageConfirmsEnd: true,
      fetchPage: async () => { throw error; },
    });
    await assert.rejects(() => adapter(1), error);
  }
});

test('transient seven-item delivery recovers without shifting canonical pages', async () => {
  let recovered = false;
  const raw = metas(0, 60);
  const adapter = {
    ...offsetAdapter(raw, []),
    fetchBatch: async request => {
      const offset = request.resumeState.offset;
      if (!recovered) {
        if (offset === 0) {
          return {
            entries: raw.slice(0, 7).map((meta, index) => ({
              meta,
              sourcePosition: { kind: 'offset', offset: index },
              resumeAfter: { kind: 'offset', offset: index + 1 },
            })),
            rawCount: 7,
            resumeAfterBatch: { kind: 'offset', offset: 7 },
            exhaustion: 'unknown',
          };
        }
        return {
          entries: [],
          rawCount: 0,
          resumeAfterBatch: { kind: 'offset', offset: 7 },
          exhaustion: 'unknown',
        };
      }
      const slice = raw.slice(offset, offset + request.requestedRawCount);
      return {
        entries: slice.map((meta, index) => ({
          meta,
          sourcePosition: { kind: 'offset', offset: offset + index },
          resumeAfter: { kind: 'offset', offset: offset + index + 1 },
        })),
        rawCount: slice.length,
        resumeAfterBatch: { kind: 'offset', offset: offset + slice.length },
        exhaustion: offset + slice.length >= raw.length ? 'confirmed' : 'not-exhausted',
      };
    },
  };
  const state = memoryState();
  const transient = await hydrate(state, adapter, 0, 20);
  assert.deepEqual(transient.pages.get(1).metas.map(meta => meta.id), metas(0, 7).map(meta => meta.id));
  assert.equal(state.pages.size, 0);

  recovered = true;
  await hydrate(state, adapter, 7, 33);
  assert.deepEqual(state.pages.get(1).metas.map(meta => meta.id), metas(0, 20).map(meta => meta.id));
  assert.deepEqual(state.pages.get(2).metas.map(meta => meta.id), metas(20, 20).map(meta => meta.id));
});

test('limit seven plus canonical cache eviction reconstructs page one at its boundary', async () => {
  const state = memoryState();
  const adapter = offsetAdapter(metas(0, 60), []);
  await hydrate(state, adapter, 0, 20);
  const first = await fillFilteredPage({
    startPage: 1,
    pageSize: 7,
    sourcePageSize: 20,
    fetchPage: state.readPage,
  });
  assert.deepEqual(first.metas.map(meta => meta.id), metas(0, 7).map(meta => meta.id));
  assert.equal(first.nextCanonicalPage, 1);
  assert.equal(first.nextFilteredOffset, 7);

  state.pages.delete(1);
  await hydrate(state, adapter, 7, 20);
  const resumed = await fillFilteredPage({
    startPage: 1,
    startOffset: 7,
    pageSize: 13,
    sourcePageSize: 20,
    fetchPage: state.readPage,
  });
  assert.deepEqual(state.pages.get(1).metas.map(meta => meta.id), metas(0, 20).map(meta => meta.id));
  assert.deepEqual(resumed.metas.map(meta => meta.id), metas(7, 13).map(meta => meta.id));
});

test('filtered delivery cursor preserves the canonical source index after eviction', async () => {
  const state = memoryState();
  const adapter = offsetAdapter(metas(0, 60), []);
  await hydrate(state, adapter, 0, 20);
  const filterEntries = entries => entries.filter(entry => Number(entry.meta.id.slice(3)) >= 10);
  const first = await fillFilteredPage({
    startPage: 1,
    pageSize: 5,
    sourcePageSize: 20,
    fetchPage: state.readPage,
    filterEntries,
  });
  assert.deepEqual(first.metas.map(meta => meta.id), metas(10, 5).map(meta => meta.id));
  assert.equal(first.lastServedCanonicalIndex, 14);
  assert.deepEqual(first.sourceResumeAfterLastServed, { kind: 'offset', offset: 15 });
  assert.equal(first.nextFilteredOffset, 5);

  state.pages.delete(1);
  await hydrate(state, adapter, 0, 20);
  const resumed = await fillFilteredPage({
    startPage: 1,
    startOffset: first.nextFilteredOffset,
    pageSize: 5,
    sourcePageSize: 20,
    fetchPage: state.readPage,
    filterEntries,
  });
  assert.deepEqual(state.pages.get(1).metas.map(meta => meta.id), metas(0, 20).map(meta => meta.id));
  assert.deepEqual(resumed.metas.map(meta => meta.id), metas(15, 5).map(meta => meta.id));
});

test('local filter changes reuse source pages but invalidate delivery cursors', () => {
  const base = {
    catalogId: 'tmdb.trending',
    type: 'movie',
    language: 'en-US',
    canonicalPageSize: 20,
    args: { genre: 'Drama' },
  };
  const withoutHide = buildCatalogSourceQuerySignature({
    ...base,
    catalogConfig: { metadata: { hideWatchedTrakt: false } },
    configFingerprint: { sfw: false },
  });
  const withHide = buildCatalogSourceQuerySignature({
    ...base,
    catalogConfig: { metadata: { hideWatchedTrakt: true } },
    configFingerprint: { sfw: false },
  });
  assert.equal(withoutHide, withHide);
  assert.deepEqual(
    buildCanonicalCatalogCacheArgs({ genre: 'Drama' }, 1, 20, withoutHide),
    buildCanonicalCatalogCacheArgs({ genre: 'Drama' }, 1, 20, withHide)
  );
  assert.notEqual(
    buildDeliveryCursorSignature({
      sourceQuerySignature: withoutHide,
      config: { hideWatchedTrakt: false },
      catalogConfig: { metadata: { hideWatchedTrakt: false } },
    }),
    buildDeliveryCursorSignature({
      sourceQuerySignature: withHide,
      config: { hideWatchedTrakt: true },
      catalogConfig: { metadata: { hideWatchedTrakt: true } },
    })
  );
});
