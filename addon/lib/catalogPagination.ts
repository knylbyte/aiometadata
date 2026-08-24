import redis from './redisClient';
import type { CanonicalCatalogPage, CanonicalTerminalState, ProviderResumeState } from './catalogFetchPlanner';
import { capRedisTtl } from './catalogTtl';
import { buildCatalogCursorKey, buildCatalogTerminalKey } from './catalogCacheIdentity';

export interface CatalogCursor {
  served: number;
  upstreamPage: number;
  pageOffset?: number;
  responseLimit?: number;
  canonicalPage?: number;
  canonicalOffset?: number;
  filteredOffset?: number;
  canonicalSourceStart?: ProviderResumeState;
  itemResumeAfterServed?: ProviderResumeState;
  deliverySignature?: string;
  sourceResume?: ProviderResumeState;
}

export function cursorKey(
  userUUID: string,
  catalogId: string,
  type: string,
  querySignature?: string,
  served: number = 0,
  scopeFingerprint: string = 'scope-legacy'
): string {
  return buildCatalogCursorKey({
    scopeFingerprint,
    userUUID,
    catalogId,
    type,
    deliverySignature: querySignature,
    served,
  });
}

export function terminalKey(scopeFingerprint: string, querySignature: string): string {
  return buildCatalogTerminalKey({ scopeFingerprint, sourceQuerySignature: querySignature });
}

export async function readCursor(key: string): Promise<CatalogCursor | null> {
  if (!redis) return null;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CatalogCursor;
  } catch {
    await redis.del(key);
    return null;
  }
}

export async function writeCursor(key: string, cursor: CatalogCursor): Promise<void> {
  if (!redis) return;
  const ttl = Math.max(60, parseInt(process.env.CATALOG_CURSOR_TTL || '3600', 10) || 3600);
  await redis.set(key, JSON.stringify(cursor), 'EX', ttl);
}

export async function clearCursor(key: string): Promise<void> {
  if (redis) await redis.del(key);
}

export async function readCatalogTerminal(key: string, ttl?: number): Promise<CanonicalTerminalState | null> {
  if (!redis || ttl === 0) return null;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as CanonicalTerminalState;
    if (Number.isFinite(ttl) && ttl! > 0) await capRedisTtl(redis as any, key, Math.floor(ttl!));
    return value;
  } catch {
    await redis.del(key);
    return null;
  }
}

export async function writeCatalogTerminal(key: string, state: CanonicalTerminalState, ttlOverride?: number): Promise<void> {
  if (!redis) return;
  const ttl = ttlOverride ?? (parseInt(process.env.CATALOG_TTL || '86400', 10) || 86400);
  if (!Number.isFinite(ttl) || ttl <= 0) return;
  await redis.set(key, JSON.stringify(state), 'EX', Math.max(1, Math.floor(ttl)));
}

export async function resolveStartPage(
  key: string,
  skip: number,
  legacyPage: number,
  legacyOffset: number = 0
): Promise<{ startPage: number; startOffset: number; matched: boolean }> {
  if (skip <= 0) return { startPage: 1, startOffset: 0, matched: true };
  const cursor = await readCursor(key);
  if (cursor && cursor.served === skip) {
    return {
      startPage: Math.max(1, cursor.canonicalPage || cursor.upstreamPage || 1),
      startOffset: Math.max(0, cursor.filteredOffset ?? cursor.canonicalOffset ?? cursor.pageOffset ?? 0),
      matched: true,
    };
  }
  return {
    startPage: Math.max(1, legacyPage || 1),
    startOffset: Math.max(0, legacyOffset || 0),
    matched: false,
  };
}

export function fillMaxPages(): number {
  return Math.max(1, parseInt(process.env.CATALOG_FILTER_FILL_MAX_PAGES || '5', 10) || 5);
}

export async function fillFilteredPage(options: {
  startPage: number;
  startOffset?: number;
  pageSize: number;
  sourcePageSize?: number;
  maxPages?: number;
  fetchPage: (page: number) => Promise<any[] | CanonicalCatalogPage>;
  filter?: (items: any[]) => Promise<any[]> | any[];
  filterEntries?: (entries: CanonicalDeliveryEntry[]) => Promise<CanonicalDeliveryEntry[]> | CanonicalDeliveryEntry[];
}): Promise<{
  metas: any[];
  nextPage: number;
  nextOffset: number;
  nextCanonicalPage: number;
  nextFilteredOffset: number;
  pagesRead: number;
  exhausted: boolean;
  lastServedCanonicalIndex?: number;
  sourceResumeAfterLastServed?: ProviderResumeState;
  canonicalPageSourceStart?: ProviderResumeState;
  transient: boolean;
}> {
  const pageSize = Math.max(1, options.pageSize);
  const sourcePageSize = Math.max(1, options.sourcePageSize || pageSize);
  const maxPages = Math.max(1, options.maxPages || fillMaxPages());
  const metas: any[] = [];
  let page = Math.max(1, options.startPage);
  let offset = Math.max(0, options.startOffset || 0);
  let pagesRead = 0;
  let exhausted = false;
  let lastServedCanonicalIndex: number | undefined;
  let sourceResumeAfterLastServed: ProviderResumeState | undefined;
  let canonicalPageSourceStart: ProviderResumeState | undefined;
  let transient = false;

  while (metas.length < pageSize && pagesRead < maxPages) {
    const fetched = await options.fetchPage(page);
    pagesRead += 1;
    const canonical = !Array.isArray(fetched) && fetched && Array.isArray(fetched.metas)
      ? fetched as CanonicalCatalogPage
      : null;
    const raw = canonical ? canonical.metas : fetched as any[];
    if (!raw || raw.length === 0) {
      exhausted = true;
      offset = 0;
      page += 1;
      break;
    }
    const entries: CanonicalDeliveryEntry[] = raw.map((meta, canonicalIndex) => ({
      meta,
      canonicalIndex,
      sourcePosition: canonical
        ? (canonicalIndex === 0
            ? canonical._canonical.sourceStart
            : canonical._canonical.entryResumes[canonicalIndex - 1])
        : undefined,
      resumeAfter: canonical?._canonical.entryResumes[canonicalIndex],
    }));
    let filteredEntries: CanonicalDeliveryEntry[];
    if (options.filterEntries) {
      filteredEntries = await options.filterEntries(entries);
    } else {
      const filteredMetas = options.filter ? await options.filter(raw) : raw;
      const wanted = new Map<any, number>();
      for (const meta of filteredMetas) wanted.set(meta, (wanted.get(meta) || 0) + 1);
      filteredEntries = entries.filter(entry => {
        const count = wanted.get(entry.meta) || 0;
        if (count <= 0) return false;
        wanted.set(entry.meta, count - 1);
        return true;
      });
    }
    const available = filteredEntries.slice(offset);
    const taken = available.slice(0, pageSize - metas.length);
    metas.push(...taken.map(entry => entry.meta));
    const last = taken[taken.length - 1];
    if (last) {
      lastServedCanonicalIndex = last.canonicalIndex;
      sourceResumeAfterLastServed = last.resumeAfter;
      canonicalPageSourceStart = canonical?._canonical.sourceStart;
    }
    if (taken.length < available.length) {
      offset += taken.length;
      break;
    }
    if (canonical?._canonical.transient) {
      offset = filteredEntries.length;
      canonicalPageSourceStart = canonical._canonical.sourceStart;
      transient = true;
      break;
    }
    offset = 0;
    page += 1;
    if (canonical) canonicalPageSourceStart = canonical._canonical.sourceNext;
    if (canonical?._canonical.exhausted || (!canonical && raw.length < sourcePageSize)) {
      exhausted = true;
      break;
    }
  }
  return {
    metas,
    nextPage: page,
    nextOffset: offset,
    nextCanonicalPage: page,
    nextFilteredOffset: offset,
    pagesRead,
    exhausted,
    lastServedCanonicalIndex,
    sourceResumeAfterLastServed,
    canonicalPageSourceStart,
    transient,
  };
}

export interface CanonicalDeliveryEntry {
  meta: any;
  canonicalIndex: number;
  sourcePosition?: ProviderResumeState;
  resumeAfter?: ProviderResumeState;
}
