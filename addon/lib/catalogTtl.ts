export interface CatalogTtlPolicy {
  effectiveCatalogTtl: number;
  canonicalPageTtl: number;
  providerBatchTtl: number;
  terminalTtl: number;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function resolveEffectiveCatalogTtl(input: {
  catalogConfig?: any;
  globalCatalogTtl?: number;
  providerBatchTtl?: number;
  terminalTtl?: number;
} = {}): CatalogTtlPolicy {
  const globalCatalogTtl = nonNegativeInteger(input.globalCatalogTtl ?? process.env.CATALOG_TTL, 24 * 60 * 60);
  const explicitCatalogTtl = input.catalogConfig?.cacheTTL;
  const effectiveCatalogTtl = explicitCatalogTtl !== undefined && explicitCatalogTtl !== null
    ? nonNegativeInteger(explicitCatalogTtl, globalCatalogTtl)
    : globalCatalogTtl;
  const configuredProviderBatchTtl = nonNegativeInteger(input.providerBatchTtl ?? process.env.CATALOG_PROVIDER_BATCH_TTL, 300);
  const configuredTerminalTtl = nonNegativeInteger(input.terminalTtl ?? process.env.CATALOG_TERMINAL_TTL, globalCatalogTtl);

  if (effectiveCatalogTtl === 0) {
    return { effectiveCatalogTtl: 0, canonicalPageTtl: 0, providerBatchTtl: 0, terminalTtl: 0 };
  }
  return {
    effectiveCatalogTtl,
    canonicalPageTtl: effectiveCatalogTtl,
    providerBatchTtl: Math.min(configuredProviderBatchTtl, effectiveCatalogTtl),
    terminalTtl: Math.min(configuredTerminalTtl, effectiveCatalogTtl),
  };
}
