import consola from 'consola';
import { LRUCache } from 'lru-cache';
import redis from './redisClient.js';
import { envInt } from '../utils/envNumber';

const logger = consola.withTag('CatalogPagination');

export interface CatalogCursor {
  served: number;
  upstreamPage: number;
  pageOffset: number;
  pageSize?: number;
}

export function fillMaxPages(): number {
  return envInt('CATALOG_FILTER_FILL_MAX_PAGES', 5, 1);
}

function cursorTtlSeconds(): number {
  return envInt('CATALOG_CURSOR_TTL', 6 * 60 * 60, 60);
}

const memoryCursors = new LRUCache<string, CatalogCursor>({
  max: envInt('CATALOG_CURSOR_MEMORY_MAX', 5000, 1),
  ttl: cursorTtlSeconds() * 1000,
});

export function cursorKey(
  userUUID: string,
  cleanId: string,
  type: string,
  genre: string | undefined | null
): string {
  return `catalog-cursor:v2:${userUUID}:${cleanId}:${type}:${genre || 'all'}`;
}

export async function readCursor(key: string): Promise<CatalogCursor | null> {
  if (redis) {
    try {
      const raw = await redis.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error: any) {
      logger.debug(`Cursor read failed for ${key}: ${error.message}`);
      return null;
    }
  }
  return memoryCursors.get(key) || null;
}

export async function writeCursor(key: string, cursor: CatalogCursor): Promise<void> {
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(cursor), 'EX', cursorTtlSeconds());
    } catch (error: any) {
      logger.debug(`Cursor write failed for ${key}: ${error.message}`);
    }
    return;
  }
  memoryCursors.set(key, cursor);
}

export async function clearCursor(key: string): Promise<void> {
  if (redis) {
    try {
      await redis.del(key);
    } catch (error: any) {
      logger.debug(`Cursor clear failed for ${key}: ${error.message}`);
    }
    return;
  }
  memoryCursors.delete(key);
}

export async function resolveStartPage(
  key: string,
  skip: number,
  legacyPage: number,
  legacyOffset: number = 0
): Promise<{ startPage: number; startOffset: number; matched: boolean }> {
  if (skip === 0) {
    await clearCursor(key);
    return { startPage: 1, startOffset: 0, matched: true };
  }

  const cursor = await readCursor(key);
  if (cursor && cursor.served === skip) {
    return { startPage: cursor.upstreamPage, startOffset: cursor.pageOffset || 0, matched: true };
  }
  return { startPage: legacyPage, startOffset: legacyOffset, matched: false };
}

export interface FillResult {
  metas: any[];
  nextPage: number;
  nextOffset: number;
  pagesRead: number;
  exhausted: boolean;
}

export async function fillFilteredPage(options: {
  startPage: number;
  startOffset?: number;
  pageSize: number;
  sourcePageSize?: number;
  maxPages?: number;
  fetchPage: (page: number) => Promise<any[]>;
  filter: (metas: any[]) => Promise<any[]>;
}): Promise<FillResult> {
  const { startPage, pageSize, fetchPage, filter } = options;
  const sourcePageSize = options.sourcePageSize ?? pageSize;
  const maxPages = options.maxPages ?? fillMaxPages();

  const metas: any[] = [];
  let page = startPage;
  let offset = options.startOffset || 0;
  let pagesRead = 0;
  let exhausted = false;

  while (metas.length < pageSize && pagesRead < maxPages) {
    const raw = await fetchPage(page);
    pagesRead += 1;

    if (!raw || raw.length === 0) {
      exhausted = true;
      offset = 0;
      page += 1;
      break;
    }

    const available = (await filter(raw)).slice(offset);
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
