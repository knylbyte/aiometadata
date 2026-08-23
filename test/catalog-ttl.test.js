const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveEffectiveCatalogTtl } = require('../dist/server/lib/catalogTtl.js');
const { clearProviderBatchCacheForTests, fetchProviderBatchCached, providerBatchCacheKey } = require('../dist/server/lib/providerBatchCache.js');
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
  }).startsWith('provider-batch:v2:'), true);
});
