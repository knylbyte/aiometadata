import { AsyncLocalStorage } from 'node:async_hooks';
import type { CatalogCursor } from './catalogPagination.js';
import { envInt } from '../utils/envNumber';

export const MAX_CATALOG_PAGE_SIZE = 100;

export type CatalogPageSizeMode = 'fixed' | 'request';

interface CatalogRequestLike {
  query?: Record<string, unknown>;
}

interface CatalogPageSizeContext {
  pageSize: number;
}

const pageSizeContext = new AsyncLocalStorage<CatalogPageSizeContext>();

function clampPageSize(value: number, fallback: number): number {
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, MAX_CATALOG_PAGE_SIZE);
}

function configuredPageSize(name: string, fallback: number): number {
  return clampPageSize(envInt(name, fallback, 1), fallback);
}

function scalarQueryValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

export function parseCatalogRequestLimit(value: unknown): number | null {
  const scalar = scalarQueryValue(value);
  if (typeof scalar === 'number') {
    return Number.isInteger(scalar) && scalar > 0
      ? Math.min(scalar, MAX_CATALOG_PAGE_SIZE)
      : null;
  }
  if (typeof scalar !== 'string' || !/^\d+$/.test(scalar)) return null;
  const parsed = Number(scalar);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_CATALOG_PAGE_SIZE)
    : null;
}

function extraRequestLimit(value: unknown): number | null {
  const scalar = scalarQueryValue(value);
  if (typeof scalar !== 'string' || !scalar) return null;

  const candidates = [scalar];
  try {
    const decoded = decodeURIComponent(scalar);
    if (decoded !== scalar) candidates.push(decoded);
  } catch {
    // URLSearchParams below will safely handle the original value.
  }

  for (const candidate of candidates) {
    const parsed = parseCatalogRequestLimit(new URLSearchParams(candidate).get('limit'));
    if (parsed !== null) return parsed;
  }
  return null;
}

function requestedSkip(pathExtraArgs: Record<string, unknown> | undefined): number {
  const value = scalarQueryValue(pathExtraArgs?.skip);
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function catalogPageSizeMode(): CatalogPageSizeMode {
  return String(process.env.CATALOG_PAGE_SIZE_MODE || 'fixed').trim().toLowerCase() === 'request'
    ? 'request'
    : 'fixed';
}

export function fixedCatalogPageSize(): number {
  return configuredPageSize('CATALOG_LIST_ITEMS_SIZE', 20);
}

export function catalogRequestLimitFallback(): number {
  return configuredPageSize('CATALOG_REQUEST_LIMIT_FALLBACK', 20);
}

export function resolveCatalogPageSize(
  req: CatalogRequestLike | undefined,
  pathExtraArgs: Record<string, unknown> = {},
  cursorState: CatalogCursor | null = null
): number {
  if (catalogPageSizeMode() === 'fixed') return fixedCatalogPageSize();

  const directLimit = parseCatalogRequestLimit(req?.query?.limit);
  if (directLimit !== null) return directLimit;

  const nestedLimit = extraRequestLimit(req?.query?.extra);
  if (nestedLimit !== null) return nestedLimit;

  if (cursorState?.served === requestedSkip(pathExtraArgs)) {
    const cursorPageSize = parseCatalogRequestLimit(cursorState.pageSize);
    if (cursorPageSize !== null) return cursorPageSize;
  }

  return catalogRequestLimitFallback();
}

export function enterCatalogPageSizeContext(pageSize: number): void {
  pageSizeContext.enterWith({
    pageSize: clampPageSize(pageSize, catalogRequestLimitFallback()),
  });
}

export function catalogRequestPageSize(): number {
  const scoped = pageSizeContext.getStore()?.pageSize;
  if (scoped) return scoped;
  return catalogPageSizeMode() === 'fixed'
    ? fixedCatalogPageSize()
    : catalogRequestLimitFallback();
}

export function withCatalogPageSizeCacheArg(
  args: Record<string, unknown>,
  pageSize: number
): Record<string, unknown> {
  return { ...args, _pageSize: clampPageSize(pageSize, fixedCatalogPageSize()) };
}

export function resolveCatalogUpstreamPageSize(
  cleanId: string,
  effectivePageSize: number,
  mode: CatalogPageSizeMode = catalogPageSizeMode()
): number {
  const effective = clampPageSize(effectivePageSize, fixedCatalogPageSize());
  const fixed = fixedCatalogPageSize();
  const malPageSize = configuredPageSize('MAL_PAGE_SIZE', 25);

  if (mode === 'request') {
    if (cleanId.startsWith('flixpatrol.')) return Math.min(10, effective);
    if (cleanId.startsWith('mal.userlist.') || cleanId === 'mal.suggestions') return effective;
    if (cleanId.includes('mal.')) return Math.min(malPageSize, effective);
    if (cleanId.startsWith('anilist.')) return Math.min(50, effective);
    if (cleanId.startsWith('tmdb.') || cleanId.startsWith('streaming.')) return Math.min(20, effective);
    return effective;
  }

  if (cleanId.startsWith('flixpatrol.')) return 10;
  if (cleanId.startsWith('mal.userlist.') || cleanId === 'mal.suggestions') return fixed;
  if (cleanId.includes('mal.')) return malPageSize;
  if (cleanId === 'anilist.trending' || cleanId.startsWith('anilist.discover')) return 50;
  if (
    cleanId.startsWith('simkl.watchlist.') ||
    cleanId.startsWith('simkl.upnext') ||
    cleanId.startsWith('simkl.dvd.') ||
    cleanId.startsWith('simkl.trending.') ||
    cleanId.startsWith('simkl.recipe.') ||
    cleanId.startsWith('stremthru.') ||
    cleanId.startsWith('mdblist.') ||
    cleanId.startsWith('custom.') ||
    cleanId.startsWith('trakt.') ||
    cleanId.startsWith('anilist.') ||
    cleanId.startsWith('letterboxd.') ||
    cleanId.startsWith('movielens.') ||
    (cleanId.startsWith('tvdb.') && !cleanId.startsWith('tvdb.collection.'))
  ) {
    return fixed;
  }
  return 20;
}
