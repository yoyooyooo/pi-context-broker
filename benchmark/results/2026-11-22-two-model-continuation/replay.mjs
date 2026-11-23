import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { deriveReleaseEvidence } from './accounting.mjs';
import { verifyPublicRecoveryAudit, verifyRecoveryAccounting } from './recovery-audit.mjs';
const root = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async name => JSON.parse(await readFile(join(root, name), 'utf8'));
const manifest = await read('release-manifest.json');
assert.equal(manifest.kind, 'benchmark-prospective-cohort-release');
assert.equal(manifest.publication_version, '1.0.5');
assert.equal(manifest.manifest_sha256, sha(JSON.stringify({ ...manifest, manifest_sha256: null })));
const names = [];
async function walk(path, prefix = '') {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'Symlinks are not release members');
    const name = prefix + entry.name;
    if (entry.isDirectory()) await walk(join(path, entry.name), name + '/');
    else { assert.ok(entry.isFile()); names.push(name); }
  }
}
await walk(root);
assert.deepEqual(names.sort(), [...manifest.files.map(file => file.path), 'release-manifest.json'].sort());
assert.equal(new Set(manifest.files.map(file => file.path)).size, manifest.files.length);
for (const file of manifest.files) {
  assert.ok(file.path && !isAbsolute(file.path) && !file.path.split('/').includes('..'));
  const bytes = await readFile(join(root, file.path)); assert.equal(bytes.length, file.bytes); assert.equal(sha(bytes), file.sha256);
}
assert.equal(manifest.history.status, 'linked_not_replayed');
assert.equal(manifest.history.commit, 'c2526547e41937fd9dd21c10db06e02c08f497cf');
const history = { manifest: await read('history/release-manifest.json'), accounting: await read('history/accounting.json') };
assert.equal(history.manifest.manifest_sha256, sha(JSON.stringify({ ...history.manifest, manifest_sha256: null })));
assert.equal(sha(await readFile(join(root, 'history/release-manifest.json'))), manifest.history.release_manifest_source_sha256);
const accountingBytes = await readFile(join(root, 'history/accounting.json'));
assert.equal(sha(accountingBytes), manifest.history.accounting_source_sha256);
const originalAccounting = history.manifest.files.find(file => file.path === 'accounting.json');
assert.equal(sha(accountingBytes), originalAccounting.sha256); assert.equal(accountingBytes.length, originalAccounting.bytes);
const groups = [], recoveryAudits = [];
for (const descriptor of manifest.packages) {
  assert.ok(/^[a-z][a-z0-9-]{0,79}$/.test(descriptor.path));
  const receipt = JSON.parse(execFileSync(process.execPath, [join(root, descriptor.path, 'replay.mjs')], {
    env: { PATH: dirname(process.execPath) + ':/usr/bin:/bin', LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 60000, maxBuffer: 16777216 }).trim());
  assert.equal(receipt.status, 'verified'); assert.equal(receipt.model_requests, 0);
  const input = await read(descriptor.path + '/analysis-input.json'), analysis = await read(descriptor.path + '/analysis.json');
  const published = await read(descriptor.path + '/public-manifest.json');
  assert.equal(published.manifest_sha256, descriptor.manifest_sha256); assert.equal(receipt.analysis_sha256, analysis.analysis_sha256);
  if (descriptor.collection_recovery_source_sha256) {
    const ref = descriptor.collection_recovery_audit; assert.ok(ref && !isAbsolute(ref.path) && !ref.path.split('/').includes('..'));
    const bytes = await readFile(join(root, ref.path)); assert.equal(sha(bytes), ref.sha256); assert.equal(bytes.length, ref.bytes);
    const index = JSON.parse(bytes), auditFiles = new Map([[ref.path, bytes]]);
    for (const doc of index.documents) { assert.ok(!isAbsolute(doc.public_path) && !doc.public_path.split('/').includes('..'));
      auditFiles.set(doc.public_path, await readFile(join(root, doc.public_path))); }
    verifyPublicRecoveryAudit({ index, descriptor, publicManifest: published, files: auditFiles }); recoveryAudits.push(index);
  } else assert.equal(descriptor.collection_recovery_audit, undefined);
  groups.push({ descriptor, input, analysis, manifest: published });
}
const derived = deriveReleaseEvidence({ history, groups, reservations: await read('reservations.json'), intent: await read('coverage-intent.json'), scopes: await read('scopes.json') });
verifyRecoveryAccounting({ audits: recoveryAudits, accounting: derived.accounting });
assert.deepEqual(await read('accounting.json'), derived.accounting); assert.deepEqual(await read('coverage.json'), derived.coverage);
console.log(JSON.stringify({ status: 'verified', release_manifest_sha256: manifest.manifest_sha256,
  packages_replayed: groups.length, recovery_audits_verified: recoveryAudits.length, history: 'linked_not_replayed', historical_reservations: history.accounting.episodes.length,
  physical_reservations: derived.accounting.episodes.length, model_requests: 0,
  plan_phases: derived.coverage.per_plan.map(row => ({ experiment_id: row.experiment_id, scope_kind: row.scope_kind, role: row.role, phase: row.phase, purpose: row.purpose })),
  route_intent_source_sha256: derived.coverage.intent_source_sha256, budget_design_source_sha256: derived.coverage.prospective_budget?.source_sha256 ?? null,
  scope: 'Exact public inventory and independent subpackage replay; per-plan coverage and shared physical accounting. Private scope verification is not rerun.' }));
