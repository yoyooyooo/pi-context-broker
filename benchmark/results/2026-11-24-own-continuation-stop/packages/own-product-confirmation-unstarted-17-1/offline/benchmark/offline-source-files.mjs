// Reviewed portable sources, shared by both evidence exporters and the isolated
// revision verifier. Do not copy the controller or private corpus wholesale.
const evidenceSources = [
  'protocol.mjs', 'campaign-selection.mjs', 'reported-model.mjs', 'provider-binding.mjs',
  'metrics.json', 'schemas/protocol.schema.json', 'schemas/environment-manifest.schema.json',
  'evidence/store.mjs', 'evidence/normalize.mjs',
];

export const OFFLINE_REPORT_SOURCE_FILES = Object.freeze([
  ...evidenceSources.map(path => 'benchmark/' + path),
  'benchmark/offline-source-files.mjs',
  'benchmark/analysis/compare.mjs', 'benchmark/analysis/statistics.mjs',
  'benchmark/analysis/report.mjs', 'benchmark/analysis/metrics.mjs',
]);

// Relative to benchmark/. Creation-only implementation APIs are intentionally
// replaced by refusal stubs in an isolated read-only revision verifier.
export const OFFLINE_REVISION_VERIFIER_SOURCE_FILES = Object.freeze([
  ...evidenceSources, 'revision.mjs', '../scripts/skill-consumption-provider.mjs',
]);
