import type { ProviderResumeState, ReconstructedCatalogEntry } from './catalogFetchPlanner';

export interface RawProviderEntry<T = any> {
  rawItem: T;
  sourcePosition: ProviderResumeState;
  resumeAfter: ProviderResumeState;
}

export function createRawFixedPageEntries<T>(
  rawItems: readonly T[],
  providerPage: number,
  nativePageSize: number
): RawProviderEntry<T>[] {
  const page = Math.max(1, providerPage | 0);
  const size = Math.max(1, nativePageSize | 0);
  return rawItems.map((rawItem, rawIndex) => ({
    rawItem,
    sourcePosition: { kind: 'page-index', page, index: rawIndex },
    resumeAfter: rawIndex + 1 >= size
      ? { kind: 'page-index', page: page + 1, index: 0 }
      : { kind: 'page-index', page, index: rawIndex + 1 },
  }));
}

export async function reconstructEntriesWithProvenance<T>(input: {
  rawEntries: readonly RawProviderEntry<T>[];
  reconstruct: (rawItem: T, rawIndex: number) => Promise<any | null | undefined>;
  concurrency?: number;
  onError?: (error: unknown, rawItem: T, rawIndex: number) => void;
}): Promise<ReconstructedCatalogEntry[]> {
  const results = new Array<ReconstructedCatalogEntry | null>(input.rawEntries.length).fill(null);
  let nextIndex = 0;
  const width = Math.max(1, Math.min(input.concurrency || 20, input.rawEntries.length || 1));
  await Promise.all(Array.from({ length: width }, async () => {
    while (true) {
      const rawIndex = nextIndex++;
      if (rawIndex >= input.rawEntries.length) return;
      const rawEntry = input.rawEntries[rawIndex];
      try {
        const meta = await input.reconstruct(rawEntry.rawItem, rawIndex);
        if (meta) {
          results[rawIndex] = {
            meta,
            sourcePosition: rawEntry.sourcePosition,
            resumeAfter: rawEntry.resumeAfter,
          };
        }
      } catch (error) {
        input.onError?.(error, rawEntry.rawItem, rawIndex);
      }
    }
  }));
  return results.filter((entry): entry is ReconstructedCatalogEntry => entry !== null);
}

function aliases(value: any): Set<string> {
  const result = new Set<string>();
  const add = (kind: string, candidate: any) => {
    if (candidate !== undefined && candidate !== null && String(candidate)) result.add(`${kind}:${String(candidate)}`);
  };
  const visit = (item: any) => {
    if (!item || typeof item !== 'object') return;
    add('imdb', item.imdb_id ?? item.imdbId ?? item._imdbId);
    add('tmdb', item.tmdb_id ?? item.tmdbId ?? item._tmdbId ?? item.tmdbMovieId ?? item.tmdbShowId);
    add('tvdb', item.tvdb_id ?? item.tvdbId ?? item._tvdbId);
    add('mal', item.mal_id ?? item.malId ?? item._malId);
    add('anilist', item.anilist_id ?? item.anilistId ?? item._anilistId);
    if (typeof item.id === 'string') {
      if (item.id.startsWith('tt')) add('imdb', item.id);
      else if (item.id.includes(':')) {
        const [kind, id] = item.id.split(':', 2);
        add(kind, id);
      } else add('id', item.id);
    } else add('id', item.id);
    const ids = item.ids || item.id_map;
    if (ids) {
      add('imdb', ids.imdb ?? ids.imdbid);
      add('tmdb', ids.tmdb ?? ids.tmdbid);
      add('tvdb', ids.tvdb ?? ids.tvdbid);
      add('mal', ids.mal ?? ids.anime?.mal);
      add('anilist', ids.anilist ?? ids.anime?.anilist);
    }
    for (const nested of ['movie', 'show', 'anime', 'node', 'tmdb']) {
      if (item[nested] && item[nested] !== item) visit(item[nested]);
    }
  };
  visit(value);
  return result;
}

export function reconstructedEntriesFromRawItems(input: {
  rawItems: readonly any[];
  metas: readonly any[];
  providerPage: number;
  nativePageSize: number;
}): ReconstructedCatalogEntry[] {
  if (input.metas.length > input.rawItems.length) {
    throw new Error('Provider reconstructed more metas than it consumed raw items');
  }
  const rawEntries = createRawFixedPageEntries(input.rawItems, input.providerPage, input.nativePageSize);
  if (input.metas.length === input.rawItems.length) {
    return input.metas.map((meta, index) => ({
      meta,
      sourcePosition: rawEntries[index].sourcePosition,
      resumeAfter: rawEntries[index].resumeAfter,
    }));
  }

  const unmatched = new Set(rawEntries.map((_, index) => index));
  return input.metas.map((meta) => {
    const metaAliases = aliases(meta);
    const rawIndex = [...unmatched].find(index => {
      const rawAliases = aliases(rawEntries[index].rawItem);
      return [...metaAliases].some(alias => rawAliases.has(alias));
    });
    if (rawIndex === undefined) {
      throw new Error('Provider reconstruction loss cannot be mapped to an original raw source position');
    }
    unmatched.delete(rawIndex);
    return {
      meta,
      sourcePosition: rawEntries[rawIndex].sourcePosition,
      resumeAfter: rawEntries[rawIndex].resumeAfter,
    };
  });
}
