import { envInt } from '../utils/envNumber';

export const CATALOG_CANONICAL_CACHE_VERSION = 'canonical-v3';

export interface CatalogProviderCapabilities {
  supportsOffset: boolean;
  supportsVariableLimit: boolean;
  maxLimit: number;
  cursorBased: boolean;
  stableOrdering: boolean;
  fixedPageSize: number;
}

export interface CanonicalPageWindow {
  skip: number;
  responseLimit: number;
  canonicalPageSize: number;
  startPage: number;
  endPage: number;
  startOffset: number;
  alignedOffset: number;
  alignedLimit: number;
  pages: number[];
}

export interface MissingPageRange {
  startPage: number;
  endPage: number;
  offset: number;
  limit: number;
}

export interface CatalogFetchBatch {
  offset: number;
  limit: number;
  providerPage: number;
  pageOffset: number;
  sequential: boolean;
}

export interface CatalogBatchResult {
  items: any[];
  rawCount?: number;
  nextOffset?: number;
  exhausted: boolean;
  supported?: boolean;
}

export interface CanonicalCatalogPage {
  metas: any[];
  _canonical?: {
    version: string;
    sourceStartOffset: number;
    sourceNextOffset?: number;
    exhausted: boolean;
  };
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function resolveCanonicalPageWindow(
  skip: number,
  responseLimit: number,
  canonicalPageSize: number
): CanonicalPageWindow {
  const size = positiveInteger(canonicalPageSize, 20);
  const normalizedSkip = Number.isInteger(skip) && skip >= 0 ? skip : 0;
  const limit = positiveInteger(responseLimit, size);
  const startPage = Math.floor(normalizedSkip / size) + 1;
  const endExclusive = normalizedSkip + limit;
  const endPage = Math.max(startPage, Math.ceil(endExclusive / size));
  const pages = Array.from({ length: endPage - startPage + 1 }, (_, index) => startPage + index);

  return {
    skip: normalizedSkip,
    responseLimit: limit,
    canonicalPageSize: size,
    startPage,
    endPage,
    startOffset: normalizedSkip % size,
    alignedOffset: (startPage - 1) * size,
    alignedLimit: pages.length * size,
    pages,
  };
}

export function planMissingPageRanges(
  pages: number[],
  cachedPages: Iterable<number>,
  canonicalPageSize: number
): MissingPageRange[] {
  const size = positiveInteger(canonicalPageSize, 20);
  const cached = new Set(cachedPages);
  const missing = [...new Set(pages)].filter(page => page > 0 && !cached.has(page)).sort((a, b) => a - b);
  const ranges: MissingPageRange[] = [];

  for (const page of missing) {
    const previous = ranges[ranges.length - 1];
    if (previous && previous.endPage + 1 === page) {
      previous.endPage = page;
      previous.limit += size;
      continue;
    }
    ranges.push({
      startPage: page,
      endPage: page,
      offset: (page - 1) * size,
      limit: size,
    });
  }

  return ranges;
}

export function resolveCatalogProviderCapabilities(
  catalogId: string,
  _catalogConfig: any,
  canonicalPageSize: number
): CatalogProviderCapabilities {
  const size = positiveInteger(canonicalPageSize, 20);
  const id = String(catalogId || '');

  if (id.startsWith('mdblist.discover.') || id === 'mdblist.upnext') {
    return {
      supportsOffset: false,
      supportsVariableLimit: false,
      maxLimit: size,
      cursorBased: true,
      stableOrdering: true,
      fixedPageSize: size,
    };
  }

  if (id.startsWith('mdblist.')) {
    return {
      supportsOffset: true,
      supportsVariableLimit: true,
      maxLimit: 100,
      cursorBased: false,
      stableOrdering: true,
      fixedPageSize: size,
    };
  }

  let fixedPageSize = size;
  if (id.startsWith('tmdb.') || id.startsWith('streaming.')) fixedPageSize = 20;
  else if (id.startsWith('flixpatrol.')) fixedPageSize = 10;
  else if (id.startsWith('mal.') && !id.startsWith('mal.userlist.') && id !== 'mal.suggestions') {
    fixedPageSize = envInt('MAL_PAGE_SIZE', 25, 1);
  } else if (id.startsWith('anilist.')) {
    fixedPageSize = Math.min(50, size);
  }

  return {
    supportsOffset: id.startsWith('custom.') || id.startsWith('stremthru.') || id.startsWith('merged.'),
    supportsVariableLimit: false,
    maxLimit: fixedPageSize,
    cursorBased: false,
    stableOrdering: true,
    fixedPageSize,
  };
}

export function planProviderFetchBatches(
  ranges: MissingPageRange[],
  capabilities: CatalogProviderCapabilities,
  canonicalPageSize: number
): CatalogFetchBatch[] {
  const size = positiveInteger(canonicalPageSize, 20);
  const batches: CatalogFetchBatch[] = [];

  for (const range of ranges) {
    if (capabilities.supportsOffset && capabilities.supportsVariableLimit && !capabilities.cursorBased) {
      const configuredMax = positiveInteger(capabilities.maxLimit, size);
      const alignedMax = configuredMax >= size
        ? Math.max(size, Math.floor(configuredMax / size) * size)
        : configuredMax;
      let offset = range.offset;
      let remaining = range.limit;
      while (remaining > 0) {
        const limit = Math.min(remaining, alignedMax);
        batches.push({
          offset,
          limit,
          providerPage: Math.floor(offset / size) + 1,
          pageOffset: 0,
          sequential: false,
        });
        offset += limit;
        remaining -= limit;
      }
      continue;
    }

    const sourceSize = positiveInteger(capabilities.fixedPageSize, size);
    let offset = range.offset;
    const endOffset = range.offset + range.limit;
    while (offset < endOffset) {
      const providerPage = Math.floor(offset / sourceSize) + 1;
      const pageOffset = offset % sourceSize;
      const limit = Math.min(sourceSize - pageOffset, endOffset - offset);
      batches.push({
        offset,
        limit,
        providerPage,
        pageOffset,
        sequential: true,
      });
      offset += limit;
    }
  }

  return batches;
}

export function buildCanonicalCatalogCacheArgs(
  args: Record<string, unknown>,
  page: number,
  canonicalPageSize: number
): Record<string, unknown> {
  const normalized = { ...args };
  delete normalized.skip;
  delete normalized.limit;
  delete normalized.page;
  delete normalized._pageSize;
  delete normalized._pageOffset;
  normalized._catalogPaging = CATALOG_CANONICAL_CACHE_VERSION;
  normalized._canonicalPageSize = positiveInteger(canonicalPageSize, 20);
  if (page > 1) normalized.page = page;
  return normalized;
}

export function splitIntoCanonicalPages(
  items: any[],
  startPage: number,
  canonicalPageSize: number,
  exhausted: boolean,
  sourceStartOffset: number = (startPage - 1) * canonicalPageSize,
  sourceNextOffset?: number,
  rawCount?: number
): Map<number, CanonicalCatalogPage> {
  const size = positiveInteger(canonicalPageSize, 20);
  const pages = new Map<number, CanonicalCatalogPage>();
  const totalRaw = rawCount ?? items.length;

  for (let index = 0; index < items.length; index += size) {
    const metas = items.slice(index, index + size);
    const isFull = metas.length === size;
    if (!isFull && !exhausted) break;

    const page = startPage + Math.floor(index / size);
    const isLastWrittenPage = index + metas.length >= items.length;
    const offsetsAreOneToOne = totalRaw === items.length;
    const pageNextOffset = offsetsAreOneToOne
      ? sourceStartOffset + index + metas.length
      : (isLastWrittenPage ? sourceNextOffset : undefined);

    pages.set(page, {
      metas,
      _canonical: {
        version: CATALOG_CANONICAL_CACHE_VERSION,
        sourceStartOffset,
        ...(pageNextOffset !== undefined ? { sourceNextOffset: pageNextOffset } : {}),
        exhausted: exhausted && isLastWrittenPage,
      },
    });
  }

  return pages;
}

export function assembleCanonicalResponse(
  window: CanonicalPageWindow,
  pages: Map<number, CanonicalCatalogPage>
): any[] {
  const metas: any[] = [];
  for (const page of window.pages) {
    const cached = pages.get(page);
    if (!cached) break;
    metas.push(...cached.metas);
    if (cached.metas.length < window.canonicalPageSize) break;
  }
  return metas.slice(window.startOffset, window.startOffset + window.responseLimit);
}

export function createSequentialPageBatchFetcher(
  capabilities: CatalogProviderCapabilities,
  fetchPage: (page: number) => Promise<any[]>
): (batch: CatalogFetchBatch) => Promise<CatalogBatchResult> {
  const sourceSize = positiveInteger(capabilities.fixedPageSize, 20);

  return async (batch: CatalogFetchBatch): Promise<CatalogBatchResult> => {
    const items: any[] = [];
    let absoluteOffset = batch.offset;
    let exhausted = false;

    while (items.length < batch.limit) {
      const providerPage = Math.floor(absoluteOffset / sourceSize) + 1;
      const pageOffset = absoluteOffset % sourceSize;
      const raw = await fetchPage(providerPage);
      if (!raw.length) {
        exhausted = true;
        break;
      }

      const available = raw.slice(pageOffset);
      const taken = available.slice(0, batch.limit - items.length);
      items.push(...taken);
      absoluteOffset += taken.length;

      if (raw.length < sourceSize && pageOffset + taken.length >= raw.length) {
        // A short reconstructed page can be caused by invalid IDs or missing
        // metadata. Advance to the next provider page and require an empty page
        // before treating the upstream as exhausted.
        absoluteOffset = providerPage * sourceSize;
        continue;
      }
      if (!taken.length) {
        exhausted = raw.length < sourceSize;
        break;
      }
    }

    return {
      items,
      rawCount: items.length,
      nextOffset: absoluteOffset,
      exhausted,
    };
  };
}

export async function hydrateCanonicalPageWindow(options: {
  window: CanonicalPageWindow;
  capabilities: CatalogProviderCapabilities;
  readPage: (page: number) => Promise<CanonicalCatalogPage | null>;
  writePage: (page: number, value: CanonicalCatalogPage) => Promise<CanonicalCatalogPage | void>;
  fetchBatch: (batch: CatalogFetchBatch) => Promise<CatalogBatchResult>;
  processItems?: (items: any[]) => Promise<any[]> | any[];
  dedupeKey?: (item: any) => string | null | undefined;
  maxBatches?: number;
}): Promise<{
  pages: Map<number, CanonicalCatalogPage>;
  fetchedBatches: CatalogFetchBatch[];
  exhausted: boolean;
}> {
  const { window, capabilities, readPage, writePage, fetchBatch } = options;
  const pages = new Map<number, CanonicalCatalogPage>();
  const fetchedBatches: CatalogFetchBatch[] = [];
  let exhausted = false;

  await Promise.all(window.pages.map(async page => {
    const cached = await readPage(page);
    if (cached) pages.set(page, cached);
  }));

  const ranges = planMissingPageRanges(window.pages, pages.keys(), window.canonicalPageSize);
  for (const originalRange of ranges) {
    let range = { ...originalRange };
    if (range.startPage > 1) {
      const previous = pages.get(range.startPage - 1) || await readPage(range.startPage - 1);
      const cursorOffset = previous?._canonical?.sourceNextOffset;
      if (Number.isInteger(cursorOffset) && cursorOffset! >= 0) {
        range.offset = cursorOffset!;
      }
    }

    const targetCount = originalRange.limit;
    const collected: any[] = [];
    const seen = new Set<string>();
    let nextSourceOffset = range.offset;
    let rawCount = 0;
    let queue = planProviderFetchBatches([range], capabilities, window.canonicalPageSize);
    let batchesRead = 0;
    const maxBatches = options.maxBatches ?? 100;

    while (collected.length < targetCount && !exhausted && batchesRead < maxBatches) {
      if (!queue.length) {
        const missing = targetCount - collected.length;
        const alignedMissing = Math.ceil(missing / window.canonicalPageSize) * window.canonicalPageSize;
        queue = planProviderFetchBatches([{
          startPage: originalRange.startPage,
          endPage: originalRange.endPage,
          offset: nextSourceOffset,
          limit: alignedMissing,
        }], capabilities, window.canonicalPageSize);
      }

      const batch = queue.shift();
      if (!batch) break;
      const result = await fetchBatch(batch);
      fetchedBatches.push(batch);
      batchesRead += 1;

      const rawItems = Array.isArray(result.items) ? result.items : [];
      const processed = options.processItems ? await options.processItems(rawItems) : rawItems;
      const processedItems = processed || [];
      let acceptedFromBatch = 0;
      for (const item of processedItems) {
        const key = options.dedupeKey?.(item);
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        collected.push(item);
        acceptedFromBatch += 1;
        if (collected.length >= targetCount) break;
      }

      const fetchedRawCount = Math.max(0, result.rawCount ?? rawItems.length);
      rawCount += fetchedRawCount;
      const canResumeInsideBatch = collected.length >= targetCount
        && acceptedFromBatch < processedItems.length
        && processedItems.length === fetchedRawCount;
      const proposedNextOffset = canResumeInsideBatch
        ? batch.offset + acceptedFromBatch
        : (result.nextOffset ?? (batch.offset + fetchedRawCount));
      nextSourceOffset = proposedNextOffset > nextSourceOffset
        ? proposedNextOffset
        : batch.offset + batch.limit;
      if (nextSourceOffset !== batch.offset + batch.limit) {
        queue = [];
      }
      exhausted = result.exhausted;

      if (!fetchedRawCount && !rawItems.length && !exhausted) break;
    }

    const split = splitIntoCanonicalPages(
      collected.slice(0, targetCount),
      originalRange.startPage,
      window.canonicalPageSize,
      exhausted,
      range.offset,
      nextSourceOffset,
      rawCount
    );

    for (const [page, value] of split) {
      const written = await writePage(page, value);
      pages.set(page, written || value);
    }
  }

  return { pages, fetchedBatches, exhausted };
}
