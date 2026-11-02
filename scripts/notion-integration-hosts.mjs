/** Host selection belongs to verification orchestration, not the source adapter.
 * A Pi-only run must neither probe nor launch an unrelated installed host.
 * Cross-host cache and native-editor scenarios remain explicitly multi-host.
 */
export function selectIntegrationHosts({ host, sharedCatalog = false, cacheLifecycle = false }) {
  if (host !== undefined && !['pi', 'omp'].includes(host)) {
    throw new Error('--host must be pi or omp; omit it to run both hosts');
  }
  if (host !== undefined && (sharedCatalog || cacheLifecycle)) {
    throw new Error('--host cannot narrow shared-catalog or cache-lifecycle: those scenarios require multiple hosts');
  }
  return host === undefined ? ['pi', 'omp'] : [host];
}

/** Preserve the default policy unless a run explicitly selects the daily mode. */
export function selectIntegrationPrefetch(value) {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('--prefetch must be true or false');
}
