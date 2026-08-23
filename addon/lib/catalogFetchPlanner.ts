import { createHash } from 'node:crypto';

export const CATALOG_CANONICAL_CACHE_VERSION = 'canonical-v5';
export const CATALOG_CANONICAL_PAGE_SCHEMA = 'v5';

export type CatalogExhaustion = 'confirmed' | 'not-exhausted' | 'unknown';

export type ProviderResumeState =
  | { kind: 'offset'; offset: number }
  | { kind: 'page-index'; page: number; index: number }
  | { kind: 'cursor'; token: string; index?: number };

export interface ReconstructedCatalogEntry {
  meta: any;
  sourcePosition: ProviderResumeState;
  resumeAfter: ProviderResumeState;
}

export interface ProviderBatchResult {
  entries: ReconstructedCatalogEntry[];
  rawCount: number;
  resumeAfterBatch: ProviderResumeState;
  exhaustion: CatalogExhaustion;
  supported?: boolean;
}

export interface CatalogProviderCapabilities {
  supportsOffset: boolean;
  supportsVariableLimit: boolean;
  maxLimit: number;
  nativePageSize?: number;
  cursorBased: boolean;
  stableOrdering: boolean;
  paginationModel?: 'offset' | 'page' | 'cursor';
  emptyPageConfirmsEnd?: boolean;
  shortPageConfirmsEnd?: boolean;
}

export interface CatalogFetchBatch {
  resumeState: ProviderResumeState;
  requestedRawCount: number;
  limit: number;
  offset?: number;
  providerPage?: number;
  pageOffset?: number;
  sequential: boolean;
}

export interface CatalogSourceAdapter {
  provider: string;
  sourceIdentity: string;
  querySignature: string;
  capabilities: CatalogProviderCapabilities;
  initialResumeState: ProviderResumeState;
  fetchBatch: (request: CatalogFetchBatch) => Promise<ProviderBatchResult>;
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

export interface CanonicalCatalogPage {
  metas: any[];
  _canonical: {
    schema: 'v5';
    page: number;
    sourceStart: ProviderResumeState;
    sourceNext: ProviderResumeState;
    exhausted: boolean;
    entryResumes: ProviderResumeState[];
    transient?: boolean;
  };
}

export interface CanonicalTerminalState {
  schema: 'v5';
  sourceEnd: ProviderResumeState;
  lastCanonicalPage: number;
}

export class CatalogProviderNoProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogProviderNoProgressError';
  }
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function stableValue(value: any, omitCachePolicy: boolean = false): any {
  if (Array.isArray(value)) return value.map(child => stableValue(child, omitCachePolicy));
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result: Record<string, any>, key) => {
      if (omitCachePolicy && key === 'cacheTTL') return result;
      const child = value[key];
      if (child !== undefined && typeof child !== 'function') result[key] = stableValue(child, omitCachePolicy);
      return result;
    }, {});
  }
  return value;
}

export function stableCatalogStringify(value: any): string {
  return JSON.stringify(stableValue(value));
}

export function buildCatalogQuerySignature(input: {
  catalogId: string;
  type: string;
  language?: string;
  canonicalPageSize: number;
  args?: Record<string, unknown>;
  catalogConfig?: any;
  configFingerprint?: unknown;
}): string {
  const args = { ...(input.args || {}) };
  for (const key of [
    'skip',
    'limit',
    'page',
    '_pageSize',
    '_pageOffset',
    '_catalogPaging',
    '_canonicalPageSize',
    '_querySignature',
    '_mdblistPaging',
  ]) delete (args as any)[key];
  const payload = {
    catalogId: input.catalogId,
    type: input.type,
    language: input.language || '',
    canonicalPageSize: positiveInteger(input.canonicalPageSize, 20),
    args,
    catalogConfig: input.catalogConfig ? stableValue(input.catalogConfig, true) : null,
    configFingerprint: input.configFingerprint || null,
  };
  return createHash('sha256').update(stableCatalogStringify(payload)).digest('hex').slice(0, 32);
}

export function resumeStateKey(state: ProviderResumeState): string {
  return stableCatalogStringify(state);
}

export function resumeStatesEqual(a?: ProviderResumeState | null, b?: ProviderResumeState | null): boolean {
  return !!a && !!b && resumeStateKey(a) === resumeStateKey(b);
}

export function isProviderResumeState(value: any): value is ProviderResumeState {
  if (!value || typeof value !== 'object') return false;
  if (value.kind === 'offset') return Number.isInteger(value.offset) && value.offset >= 0;
  if (value.kind === 'page-index') {
    return Number.isInteger(value.page) && value.page > 0 && Number.isInteger(value.index) && value.index >= 0;
  }
  if (value.kind === 'cursor') {
    return typeof value.token === 'string' && (value.index === undefined || (Number.isInteger(value.index) && value.index >= 0));
  }
  return false;
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
  const endPage = Math.max(startPage, Math.ceil((normalizedSkip + limit) / size));
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
    } else {
      ranges.push({ startPage: page, endPage: page, offset: (page - 1) * size, limit: size });
    }
  }
  return ranges;
}

export function buildCanonicalCatalogCacheArgs(
  args: Record<string, unknown>,
  page: number,
  canonicalPageSize: number,
  querySignature?: string
): Record<string, unknown> {
  const normalized = { ...args };
  for (const key of ['skip', 'limit', 'page', '_pageSize', '_pageOffset']) delete (normalized as any)[key];
  normalized._catalogPaging = CATALOG_CANONICAL_CACHE_VERSION;
  normalized._canonicalPageSize = positiveInteger(canonicalPageSize, 20);
  if (querySignature) normalized._querySignature = querySignature;
  if (page > 1) normalized.page = page;
  return normalized;
}

export function isCanonicalV4Page(value: any, page?: number): value is CanonicalCatalogPage {
  return !!value
    && Array.isArray(value.metas)
    && value._canonical?.schema === CATALOG_CANONICAL_PAGE_SCHEMA
    && (page === undefined || value._canonical.page === page)
    && isProviderResumeState(value._canonical.sourceStart)
    && isProviderResumeState(value._canonical.sourceNext)
    && Array.isArray(value._canonical.entryResumes);
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
    if (cached._canonical.exhausted || cached.metas.length < window.canonicalPageSize) break;
  }
  return metas.slice(window.startOffset, window.startOffset + window.responseLimit);
}

function offsetEntries(items: any[], sourceOffset: number): ReconstructedCatalogEntry[] {
  return items.map((meta, index) => ({
    meta,
    sourcePosition: { kind: 'offset', offset: sourceOffset + index },
    resumeAfter: { kind: 'offset', offset: sourceOffset + index + 1 },
  }));
}

export function splitIntoCanonicalPages(
  values: ReconstructedCatalogEntry[] | any[],
  startPage: number,
  canonicalPageSize: number,
  exhaustion: CatalogExhaustion | boolean = 'unknown',
  sourceStart: ProviderResumeState | number = { kind: 'offset', offset: (startPage - 1) * canonicalPageSize }
): Map<number, CanonicalCatalogPage> {
  const size = positiveInteger(canonicalPageSize, 20);
  const start = typeof sourceStart === 'number' ? { kind: 'offset' as const, offset: sourceStart } : sourceStart;
  const entries: ReconstructedCatalogEntry[] = values.length && values[0]?.meta !== undefined
    ? values as ReconstructedCatalogEntry[]
    : offsetEntries(values as any[], start.kind === 'offset' ? start.offset : 0);
  const confirmed = exhaustion === true || exhaustion === 'confirmed';
  const result = new Map<number, CanonicalCatalogPage>();
  let pageStart = start;
  for (let index = 0; index < entries.length; index += size) {
    const chunk = entries.slice(index, index + size);
    const full = chunk.length === size;
    if (!full && !confirmed) break;
    const page = startPage + Math.floor(index / size);
    const last = index + chunk.length >= entries.length;
    const sourceNext = chunk.length ? chunk[chunk.length - 1].resumeAfter : pageStart;
    result.set(page, {
      metas: chunk.map(entry => entry.meta),
      _canonical: {
        schema: CATALOG_CANONICAL_PAGE_SCHEMA,
        page,
        sourceStart: pageStart,
        sourceNext,
        exhausted: confirmed && last,
        entryResumes: chunk.map(entry => entry.resumeAfter),
      },
    });
    pageStart = sourceNext;
  }
  return result;
}

export async function writeCanonicalPages(
  pages: Map<number, CanonicalCatalogPage>,
  writePage: (page: number, value: CanonicalCatalogPage) => Promise<CanonicalCatalogPage | void>
): Promise<Map<number, CanonicalCatalogPage>> {
  const written = new Map<number, CanonicalCatalogPage>();
  await Promise.all([...pages.entries()].filter(([, value]) => !value._canonical.transient).sort(([a], [b]) => a - b).map(async ([page, value]) => {
    const stored = await writePage(page, value);
    written.set(page, stored || value);
  }));
  return written;
}

function requestForResume(
  resumeState: ProviderResumeState,
  requestedRawCount: number,
  capabilities: CatalogProviderCapabilities
): CatalogFetchBatch {
  const request: CatalogFetchBatch = {
    resumeState,
    requestedRawCount,
    limit: requestedRawCount,
    sequential: !capabilities.supportsVariableLimit || capabilities.cursorBased,
  };
  if (resumeState.kind === 'offset') request.offset = resumeState.offset;
  if (resumeState.kind === 'page-index') {
    request.providerPage = resumeState.page;
    request.pageOffset = resumeState.index;
  }
  return request;
}

export function createSequentialPageBatchFetcher(
  capabilities: CatalogProviderCapabilities,
  fetchPage: (page: number) => Promise<ProviderBatchResult>
): (request: CatalogFetchBatch) => Promise<ProviderBatchResult> {
  return async (request: CatalogFetchBatch): Promise<ProviderBatchResult> => {
    const resume = request.resumeState.kind === 'page-index'
      ? request.resumeState
      : { kind: 'page-index' as const, page: request.providerPage || 1, index: request.pageOffset || 0 };
    const rawResult: any = await fetchPage(resume.page);
    if (!rawResult || Array.isArray(rawResult) || !Array.isArray(rawResult.entries)
      || !Number.isInteger(rawResult.rawCount) || rawResult.rawCount < 0) {
      throw new Error('Fixed-page provider must return a structured ProviderBatchResult');
    }
    const info = rawResult;
    const allEntries: ReconstructedCatalogEntry[] = Array.isArray(info.entries)
      ? info.entries
      : [];
    const entries = allEntries.filter(entry => {
      return entry.sourcePosition.kind !== 'page-index'
        || entry.sourcePosition.page > resume.page
        || (entry.sourcePosition.page === resume.page && entry.sourcePosition.index >= resume.index);
    });
    const rawCount = Math.max(0, Number(info.rawCount) - resume.index);
    const resumeAfterBatch = isProviderResumeState(info.resumeAfterBatch)
      ? info.resumeAfterBatch
      : { kind: 'page-index' as const, page: resume.page + 1, index: 0 };
    const exhaustion: CatalogExhaustion = info.exhaustion || 'unknown';
    return { entries, rawCount, resumeAfterBatch, exhaustion };
  };
}

function batchSizeFor(
  remainingMetas: number,
  canonicalPageSize: number,
  capabilities: CatalogProviderCapabilities
): number {
  if (!capabilities.supportsVariableLimit || capabilities.cursorBased) {
    return positiveInteger(capabilities.nativePageSize || capabilities.maxLimit, canonicalPageSize);
  }
  const maximum = positiveInteger(capabilities.maxLimit, canonicalPageSize);
  const aligned = Math.ceil(Math.max(1, remainingMetas) / canonicalPageSize) * canonicalPageSize;
  return Math.max(1, Math.min(maximum, aligned));
}

async function trustedAnchor(options: {
  startPage: number;
  initialResumeState: ProviderResumeState;
  loadPage: (page: number) => Promise<CanonicalCatalogPage | null>;
  dedupeKey: (meta: any) => string | null | undefined;
}): Promise<{ page: number; resume: ProviderResumeState; seen: Set<string> }> {
  if (options.startPage <= 1) return { page: 0, resume: options.initialResumeState, seen: new Set() };
  let anchorPage = 0;
  let anchor: CanonicalCatalogPage | null = null;
  for (let page = options.startPage - 1; page >= 1; page -= 1) {
    const candidate = await options.loadPage(page);
    if (candidate) {
      anchorPage = page;
      anchor = candidate;
      break;
    }
  }
  if (!anchor) return { page: 0, resume: options.initialResumeState, seen: new Set() };

  const seen = new Set<string>();
  for (let page = 1; page <= anchorPage; page += 1) {
    const prior = await options.loadPage(page);
    if (!prior) return { page: 0, resume: options.initialResumeState, seen: new Set() };
    for (const meta of prior.metas) {
      const key = options.dedupeKey(meta);
      if (key) seen.add(key);
    }
  }
  return { page: anchorPage, resume: anchor._canonical.sourceNext, seen };
}

export async function hydrateCanonicalPageWindow(options: {
  window: CanonicalPageWindow;
  adapter?: CatalogSourceAdapter;
  capabilities?: CatalogProviderCapabilities;
  initialResumeState?: ProviderResumeState;
  readPage: (page: number) => Promise<CanonicalCatalogPage | null>;
  writePage: (page: number, value: CanonicalCatalogPage) => Promise<CanonicalCatalogPage | void>;
  writePages?: (pages: Map<number, CanonicalCatalogPage>) => Promise<Map<number, CanonicalCatalogPage> | void>;
  fetchBatch?: (request: CatalogFetchBatch) => Promise<ProviderBatchResult>;
  readTerminal?: () => Promise<CanonicalTerminalState | null>;
  writeTerminal?: (terminal: CanonicalTerminalState) => Promise<void>;
  sourceAnchor?: { canonicalPage: number; resumeState: ProviderResumeState };
  dedupeKey?: (meta: any) => string | null | undefined;
  acceptEntry?: (entry: ReconstructedCatalogEntry) => Promise<boolean> | boolean;
  maxBatches?: number;
}): Promise<{
  pages: Map<number, CanonicalCatalogPage>;
  fetchedBatches: CatalogFetchBatch[];
  writtenPages: number[];
  transientPages: number[];
  exhausted: boolean;
  terminal: CanonicalTerminalState | null;
}> {
  const { window } = options;
  const capabilities = options.adapter?.capabilities || options.capabilities;
  const fetchBatch = options.adapter?.fetchBatch || options.fetchBatch;
  const initialResumeState = options.adapter?.initialResumeState || options.initialResumeState || { kind: 'offset' as const, offset: 0 };
  if (!capabilities || !fetchBatch) throw new Error('Catalog hydration requires a source adapter');

  const dedupeKey = options.dedupeKey || ((meta: any) => meta?.id || null);
  const pages = new Map<number, CanonicalCatalogPage>();
  const loaded = new Map<number, CanonicalCatalogPage | null>();
  const fetchedBatches: CatalogFetchBatch[] = [];
  const writtenPages: number[] = [];
  const transientPages: number[] = [];
  let terminal = options.readTerminal ? await options.readTerminal() : null;
  if (terminal?.schema !== CATALOG_CANONICAL_PAGE_SCHEMA || !isProviderResumeState(terminal.sourceEnd)) terminal = null;

  const loadPage = async (page: number): Promise<CanonicalCatalogPage | null> => {
    if (loaded.has(page)) return loaded.get(page) || null;
    const value = await options.readPage(page);
    const valid = isCanonicalV4Page(value, page) ? value : null;
    loaded.set(page, valid);
    if (valid) pages.set(page, valid);
    return valid;
  };

  await Promise.all(window.pages.map(loadPage));
  if (terminal && terminal.lastCanonicalPage < window.startPage) {
    return { pages, fetchedBatches, writtenPages, transientPages, exhausted: true, terminal };
  }

  const ranges = planMissingPageRanges(window.pages, pages.keys(), window.canonicalPageSize);
  for (const range of ranges) {
    if (terminal && range.startPage > terminal.lastCanonicalPage) break;
    let anchor = await trustedAnchor({ startPage: range.startPage, initialResumeState, loadPage, dedupeKey });
    if (anchor.page === 0 && options.sourceAnchor?.canonicalPage === range.startPage - 1
      && isProviderResumeState(options.sourceAnchor.resumeState)) {
      anchor = { page: options.sourceAnchor.canonicalPage, resume: options.sourceAnchor.resumeState, seen: new Set() };
    }
    let currentPage = anchor.page + 1;
    const targetEndPage = terminal
      ? Math.min(range.endPage, terminal.lastCanonicalPage)
      : range.endPage;
    let currentResume = anchor.resume;
    const seen = anchor.seen;
    const staged = new Map<number, CanonicalCatalogPage>();
    let carry: {
      entries: ReconstructedCatalogEntry[];
      index: number;
      resumeAfterBatch: ProviderResumeState;
      exhaustion: CatalogExhaustion;
    } | null = null;
    let terminalReached = false;
    let transientRange = false;
    let batchesRead = 0;
    const maxBatches = options.maxBatches ?? 100;

    while (currentPage <= targetEndPage && !terminalReached) {
      if (terminal && resumeStatesEqual(currentResume, terminal.sourceEnd)) {
        terminalReached = true;
        break;
      }
      const sourceStart = currentResume;
      const accepted: ReconstructedCatalogEntry[] = [];
      let transientStop = false;

      while (accepted.length < window.canonicalPageSize && !terminalReached) {
        if (carry && carry.index < carry.entries.length) {
          const entry = carry.entries[carry.index++];
          if (!isProviderResumeState(entry.sourcePosition) || !isProviderResumeState(entry.resumeAfter)) {
            throw new Error('Provider returned an entry without a valid source resume state');
          }
          currentResume = entry.resumeAfter;
          const acceptedByFilter = options.acceptEntry ? await options.acceptEntry(entry) : true;
          const key = dedupeKey(entry.meta);
          if (!acceptedByFilter || (key && seen.has(key))) continue;
          if (key) seen.add(key);
          accepted.push(entry);
          continue;
        }

        if (carry) {
          const before = currentResume;
          const hadEntries = carry.entries.length > 0;
          currentResume = carry.resumeAfterBatch;
          const state = carry.exhaustion;
          carry = null;
          if (state === 'confirmed' || (terminal && resumeStatesEqual(currentResume, terminal.sourceEnd))) {
            terminalReached = true;
            break;
          }
          if (!hadEntries && resumeStatesEqual(before, currentResume)) {
            throw new CatalogProviderNoProgressError(`Provider returned no progress at ${resumeStateKey(currentResume)}`);
          }
          continue;
        }

        if (batchesRead >= maxBatches) {
          if (accepted.length > 0) {
            transientStop = true;
            break;
          }
          throw new CatalogProviderNoProgressError(`Provider did not fill canonical page ${currentPage} within ${maxBatches} batches`);
        }
        const remaining = ((targetEndPage - currentPage) * window.canonicalPageSize)
          + (window.canonicalPageSize - accepted.length);
        const requestedRawCount = batchSizeFor(remaining, window.canonicalPageSize, capabilities);
        const request = requestForResume(currentResume, requestedRawCount, capabilities);
        const result = await fetchBatch(request);
        fetchedBatches.push(request);
        batchesRead += 1;
        if (!result || !Array.isArray(result.entries) || !isProviderResumeState(result.resumeAfterBatch)) {
          throw new Error('Provider returned an invalid batch result');
        }
        if (!['confirmed', 'not-exhausted', 'unknown'].includes(result.exhaustion)) {
          throw new Error('Provider returned an invalid exhaustion state');
        }
        if (!result.entries.length && result.exhaustion !== 'confirmed'
          && resumeStatesEqual(currentResume, result.resumeAfterBatch)) {
          if (accepted.length > 0) {
            transientStop = true;
            break;
          }
          throw new CatalogProviderNoProgressError(`Provider returned an empty ${result.exhaustion} batch without progress`);
        }
        carry = {
          entries: result.entries,
          index: 0,
          resumeAfterBatch: result.resumeAfterBatch,
          exhaustion: result.exhaustion,
        };
      }

      if (transientStop && accepted.length > 0) {
        const transientPage: CanonicalCatalogPage = {
          metas: accepted.map(entry => entry.meta),
          _canonical: {
            schema: CATALOG_CANONICAL_PAGE_SCHEMA,
            page: currentPage,
            sourceStart,
            sourceNext: currentResume,
            exhausted: false,
            entryResumes: accepted.map(entry => entry.resumeAfter),
            transient: true,
          },
        };
        pages.set(currentPage, transientPage);
        loaded.set(currentPage, transientPage);
        transientPages.push(currentPage);
        transientRange = true;
        break;
      }

      if (accepted.length === window.canonicalPageSize && carry
        && carry.index >= carry.entries.length && carry.exhaustion === 'confirmed') {
        currentResume = carry.resumeAfterBatch;
        carry = null;
        terminalReached = true;
      }

      if (accepted.length === window.canonicalPageSize || (terminalReached && accepted.length > 0)) {
        staged.set(currentPage, {
          metas: accepted.map(entry => entry.meta),
          _canonical: {
            schema: CATALOG_CANONICAL_PAGE_SCHEMA,
            page: currentPage,
            sourceStart,
            sourceNext: currentResume,
            exhausted: terminalReached,
            entryResumes: accepted.map(entry => entry.resumeAfter),
          },
        });
        currentPage += 1;
      } else if (terminalReached) {
        break;
      } else {
        throw new CatalogProviderNoProgressError(`Provider could not complete canonical page ${currentPage}`);
      }
    }

    const writeResult = options.writePages
      ? await options.writePages(staged)
      : await writeCanonicalPages(staged, options.writePage);
    const storedPages = writeResult || staged;
    for (const [page, value] of storedPages) {
      pages.set(page, value);
      loaded.set(page, value);
      writtenPages.push(page);
    }

    if (transientRange) break;

    if (terminalReached) {
      const lastCanonicalPage = staged.size
        ? Math.max(...staged.keys())
        : Math.max(0, currentPage - 1);
      terminal = {
        schema: CATALOG_CANONICAL_PAGE_SCHEMA,
        sourceEnd: currentResume,
        lastCanonicalPage,
      };
      if (options.writeTerminal) await options.writeTerminal(terminal);
      break;
    }
  }

  return { pages, fetchedBatches, writtenPages, transientPages, exhausted: !!terminal, terminal };
}

export async function resumeStateForCanonicalPosition(
  page: number,
  offset: number,
  readPage: (page: number) => Promise<CanonicalCatalogPage | null>
): Promise<ProviderResumeState | undefined> {
  const current = await readPage(page);
  if (current && isCanonicalV4Page(current, page)) {
    if (offset <= 0) return current._canonical.sourceStart;
    return current._canonical.entryResumes[offset - 1] || current._canonical.sourceNext;
  }
  if (offset === 0 && page > 1) {
    const previous = await readPage(page - 1);
    if (previous && isCanonicalV4Page(previous, page - 1)) return previous._canonical.sourceNext;
  }
  return undefined;
}
