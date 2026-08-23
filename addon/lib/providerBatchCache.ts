import { createHash } from 'node:crypto';
import { cacheWrapGlobal } from './getCache';
import type { ProviderBatchResult, ProviderResumeState } from './catalogFetchPlanner';
import { stableCatalogStringify } from './catalogFetchPlanner';

export const PROVIDER_BATCH_CACHE_VERSION = 'provider-batch:v1';

interface MemoryEntry {
  expiresAt: number;
  value: ProviderBatchResult;
}

const inFlight = new Map<string, Promise<ProviderBatchResult>>();
const memory = new Map<string, MemoryEntry>();
const MEMORY_LIMIT = 500;

function hash(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : stableCatalogStringify(value))
    .digest('hex')
    .slice(0, 24);
}

export function credentialFingerprint(secret?: string): string {
  return secret ? hash(secret) : 'public';
}

export function providerBatchCacheKey(input: {
  provider: string;
  sourceIdentity: string;
  querySignature: string;
  resumeState: ProviderResumeState;
  requestedUpstreamLimit: number;
}): string {
  return `${PROVIDER_BATCH_CACHE_VERSION}:${input.provider}:${hash(input.sourceIdentity)}:${input.querySignature}:${hash(input.resumeState)}:${input.requestedUpstreamLimit}`;
}

function remember(key: string, value: ProviderBatchResult, ttl: number): void {
  if (memory.size >= MEMORY_LIMIT) {
    const oldest = memory.keys().next().value;
    if (oldest) memory.delete(oldest);
  }
  memory.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
}

export async function fetchProviderBatchCached(input: {
  provider: string;
  sourceIdentity: string;
  querySignature: string;
  resumeState: ProviderResumeState;
  requestedUpstreamLimit: number;
  loader: () => Promise<ProviderBatchResult>;
  ttl?: number;
  bypass?: boolean;
  useRedis?: boolean;
}): Promise<ProviderBatchResult> {
  const key = providerBatchCacheKey(input);
  const ttl = Math.max(1, input.ttl || parseInt(process.env.CATALOG_PROVIDER_BATCH_TTL || '300', 10) || 300);
  if (!input.bypass) {
    const local = memory.get(key);
    if (local && local.expiresAt > Date.now()) return local.value;
    if (local) memory.delete(key);
    const pending = inFlight.get(key);
    if (pending) return pending;
  }

  const load = async () => {
    const result = input.useRedis === false
      ? await input.loader()
      : await cacheWrapGlobal(key, input.loader, ttl, {
          upstream: true,
          enableErrorCaching: false,
          maxRetries: 0,
        });
    if (!result || !Array.isArray(result.entries)) throw new Error('Invalid provider batch result');
    if (!input.bypass) remember(key, result, ttl);
    return result;
  };
  if (input.bypass) return load();
  const promise = load().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

export function clearProviderBatchCacheForTests(): void {
  memory.clear();
  inFlight.clear();
}
