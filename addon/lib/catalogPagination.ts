import redis from './redisClient';
import type { CanonicalTerminalState, ProviderResumeState } from './catalogFetchPlanner';

export interface CatalogCursor {
  served: number;
  upstreamPage: number;
  pageOffset?: number;
  responseLimit?: number;
  canonicalPage?: number;
  canonicalOffset?: number;
  sourceResume?: ProviderResumeState;
}

const CURSOR_PREFIX = 'catalog-cursor:v4';
const TERMINAL_PREFIX = 'canonical-terminal:v4';

function segment(value: unknown): string {
  return encodeURIComponent(String(value ?? ''));
}

export function cursorKey(
  userUUID: string,
  catalogId: string,
  type: string,
  querySignature?: string,
  served: number = 0
): string {
  return `${CURSOR_PREFIX}:${segment(userUUID)}:${segment(catalogId)}:${segment(type)}:${segment(querySignature || 'default')}:served:${Math.max(0, served | 0)}`;
}

export function terminalKey(userUUID: string, querySignature: string): string {
  return `${TERMINAL_PREFIX}:${segment(userUUID)}:${segment(querySignature)}`;
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

export async function readCatalogTerminal(key: string): Promise<CanonicalTerminalState | null> {
  if (!redis) return null;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CanonicalTerminalState;
  } catch {
    await redis.del(key);
    return null;
  }
}

export async function writeCatalogTerminal(key: string, state: CanonicalTerminalState): Promise<void> {
  if (!redis) return;
  const ttl = Math.max(60, parseInt(process.env.CATALOG_TTL || '86400', 10) || 86400);
  await redis.set(key, JSON.stringify(state), 'EX', ttl);
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
      startOffset: Math.max(0, cursor.canonicalOffset ?? cursor.pageOffset ?? 0),
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
  fetchPage: (page: number) => Promise<any[]>;
  filter: (items: any[]) => Promise<any[]> | any[];
}): Promise<{ metas: any[]; nextPage: number; nextOffset: number; pagesRead: number; exhausted: boolean }> {
  const pageSize = Math.max(1, options.pageSize);
  const sourcePageSize = Math.max(1, options.sourcePageSize || pageSize);
  const maxPages = Math.max(1, options.maxPages || fillMaxPages());
  const metas: any[] = [];
  let page = Math.max(1, options.startPage);
  let offset = Math.max(0, options.startOffset || 0);
  let pagesRead = 0;
  let exhausted = false;

  while (metas.length < pageSize && pagesRead < maxPages) {
    const raw = await options.fetchPage(page);
    pagesRead += 1;
    if (!raw || raw.length === 0) {
      exhausted = true;
      offset = 0;
      page += 1;
      break;
    }
    const available = (await options.filter(raw)).slice(offset);
    const taken = available.slice(0, pageSize - metas.length);
    metas.push(...taken);
    if (taken.length < available.length) {
      offset += taken.length;
      break;
    }
    offset = 0;
    page += 1;
    if (raw.length < sourcePageSize) {
      exhausted = true;
      break;
    }
  }
  return { metas, nextPage: page, nextOffset: offset, pagesRead, exhausted };
}
