const AUTO_META_CONCURRENCY = 20;

export function resolveMetaConcurrency(): number {
  const configured = Number.parseInt(process.env.META_CONCURRENCY || '0', 10);
  return Number.isInteger(configured) && configured > 0 ? configured : AUTO_META_CONCURRENCY;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function mapWithLimit<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  return mapWithConcurrency(items, resolveMetaConcurrency(), fn);
}
