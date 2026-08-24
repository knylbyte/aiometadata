const test = require('node:test');
const assert = require('node:assert/strict');

const { capRedisTtl, resolveEffectiveCatalogTtl } = require('../dist/server/lib/catalogTtl.js');
const {
  clearProviderBatchCacheForTests,
  fetchProviderBatchCached,
  providerBatchCacheKey,
  providerBatchMemoryExpiryForTests,
} = require('../dist/server/lib/providerBatchCache.js');
const { buildCatalogQuerySignature } = require('../dist/server/lib/catalogFetchPlanner.js');

test('effective catalog TTL caps canonical, terminal, and provider batch caches', () => {
  assert.deepEqual(resolveEffectiveCatalogTtl({
    catalogConfig: { cacheTTL: 300 }, globalCatalogTtl: 86400, providerBatchTtl: 600, terminalTtl: 86400,
  }), {
    effectiveCatalogTtl: 300, canonicalPageTtl: 300, providerBatchTtl: 300, terminalTtl: 300,
  });
});

test('TTL zero disables persistence but retains concurrent single-flight', async () => {
  assert.deepEqual(resolveEffectiveCatalogTtl({ catalogConfig: { cacheTTL: 0 } }), {
    effectiveCatalogTtl: 0, canonicalPageTtl: 0, providerBatchTtl: 0, terminalTtl: 0,
  });
  clearProviderBatchCacheForTests();
  let calls = 0;
  const input = {
    provider: 'ttl-zero', sourceIdentity: 'source', querySignature: 'query',
    resumeState: { kind: 'offset', offset: 0 }, requestedUpstreamLimit: 20, ttl: 0, useRedis: false,
  };
  const loader = async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { entries: [], rawCount: 0, resumeAfterBatch: { kind: 'offset', offset: 0 }, exhaustion: 'confirmed' };
  };
  await Promise.all([fetchProviderBatchCached({ ...input, loader }), fetchProviderBatchCached({ ...input, loader })]);
  assert.equal(calls, 1);
  await fetchProviderBatchCached({ ...input, loader });
  assert.equal(calls, 2);
});

test('TTL does not change content signatures or provider batch namespaces', () => {
  const base = { catalogId: 'mdblist.demo', type: 'movie', language: 'en-US', canonicalPageSize: 20 };
  assert.equal(
    buildCatalogQuerySignature({ ...base, catalogConfig: { sourceUrl: 'https://example.test', cacheTTL: 20 } }),
    buildCatalogQuerySignature({ ...base, catalogConfig: { sourceUrl: 'https://example.test', cacheTTL: 600 } })
  );
  assert.equal(providerBatchCacheKey({
    provider: 'mdblist', sourceIdentity: 'source', querySignature: 'query',
    resumeState: { kind: 'offset', offset: 0 }, requestedUpstreamLimit: 20,
  }).startsWith('provider-batch:v4:'), true);
});

test('Redis TTL caps never extend catalog or terminal lifetimes on reads', async () => {
  const expirations = [];
  const redis = {
    remaining: 200,
    ttl: async () => redis.remaining,
    expire: async (_key, seconds) => {
      expirations.push(seconds);
      redis.remaining = seconds;
    },
  };
  await capRedisTtl(redis, 'canonical', 300);
  assert.deepEqual(expirations, [], 'a 200 second remainder must not slide back to 300');

  redis.remaining = 600;
  await capRedisTtl(redis, 'terminal', 120);
  assert.deepEqual(expirations, [120]);

  redis.remaining = -1;
  await capRedisTtl(redis, 'persistent', 90);
  assert.deepEqual(expirations, [120, 90]);
});

test('a shorter effective TTL caps an existing in-memory provider batch', async () => {
  clearProviderBatchCacheForTests();
  const input = {
    provider: 'ttl-cap',
    sourceIdentity: 'same-source',
    querySignature: 'same-query',
    resumeState: { kind: 'offset', offset: 0 },
    requestedUpstreamLimit: 20,
    useRedis: false,
  };
  const loader = async () => ({
    entries: [],
    rawCount: 0,
    resumeAfterBatch: { kind: 'offset', offset: 0 },
    exhaustion: 'confirmed',
  });
  await fetchProviderBatchCached({ ...input, ttl: 600, loader });
  const key = providerBatchCacheKey(input);
  const longExpiry = providerBatchMemoryExpiryForTests(key);
  await fetchProviderBatchCached({ ...input, ttl: 120, loader });
  const cappedExpiry = providerBatchMemoryExpiryForTests(key);
  assert.ok(cappedExpiry < longExpiry);
  assert.ok(cappedExpiry <= Date.now() + 120_100);
});
