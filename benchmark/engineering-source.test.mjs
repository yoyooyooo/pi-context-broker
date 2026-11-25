import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fingerprint } from './protocol.mjs';
import { executionImplementation } from './implementation.mjs';
import { verifyReviewedEngineeringOverlay } from './engineering-source.mjs';
import { prepareApprovedEngineeringWindowContinuation } from './approved-campaign.mjs';
import { ENGINEERING_SOURCE3_CONTROLLER_SHA256, ENGINEERING_WINDOW_DRAFT, readEngineeringControllerComposition,
  verifyEngineeringControllerFiles, assertEngineeringInstrumentation, verifyEngineeringInstrumentation,
  readEngineeringHistoricalAuthority, verifyEngineeringHistoricalPlan, readEngineeringHistoricalPredecessor } from './campaign-engineering-window-continuation.mjs';

const current = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function save(path, value) { const bytes = JSON.stringify(value, null, 2) + '\n'; await writeFile(path, bytes); return { path, sha256: sha(bytes) }; }
async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'engineering-source-test-')));
  if (process.platform === 'darwin') t.after(() => execFileSync('/usr/bin/trash', [root]));
  return root;
}
const sourceModule = (root, name) => import(pathToFileURL(join(root, 'benchmark', name)));

/** A portable synthetic producer graph. The dependency walker and observer
 * instrumentation validator are the actual product files. Entry stubs avoid
 * constructing a fake104 authority or running any history/model workflow. */
async function compositionFixture(root) {
  const base = join(root, 'base'), next = join(root, 'next');
  for (const item of (await executionImplementation()).files) {
    const path = resolve(base, 'benchmark', item.path); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await readFile(resolve(current, item.path)));
  }
  for (const path of ['revision.mjs', 'cli.mjs', 'configure.mjs', 'controller.mjs', 'batch.mjs', 'gate.mjs', 'subject.mjs', 'turn-bridge.mjs',
    'fixture-turn-adapter.mjs', 'execute.mjs', 'models.mjs', 'resumption.mjs', 'corpus/index.mjs', 'corpus/materials.mjs', 'corpus/grader.mjs',
    'evidence/normalize.mjs', 'evidence/store.mjs']) await writeFile(join(base, 'benchmark', path), 'export const offlineFixture = true;\n');
  await writeFile(join(base, 'scripts/paired-environment.mjs'), 'export function checkEnvironment() { throw new Error("No runtime in source fixture"); }\n');
  await writeFile(join(base, 'benchmark/collect.mjs'), "import { fingerprint } from './protocol.mjs';\nexport const fixtureCollector = fingerprint('retained-old-observer');\n");
  await writeFile(join(base, 'benchmark/cli.mjs'), "import './finite-campaign.mjs';\nimport './approved-campaign.mjs';\n");
  await writeFile(join(base, 'benchmark/finite-campaign.mjs'), `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { verifyResolveRepairInstrumentation } from './resolve-observer-repair.mjs';
export async function verifyAuthorizedHistoryPlan(plan, amendment, parent) {
  await verifyResolveRepairInstrumentation(plan.execution, parent.fixtureOriginal, { builds: [{ changes: [] }] });
  return { verified_by: 'retained-source', plan_id: plan.id };
}
export async function readFiniteCampaignAmendment(reference) {
  const bytes = await readFile(reference.path); assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sha256);
  return JSON.parse(bytes);
}
export function checkCampaignScope() { throw new Error('Historical delegation must not use the current-state guard'); }
`);
  await writeFile(join(base, 'benchmark/approved-campaign.mjs'), `import { readFile } from 'node:fs/promises';
export async function readApprovedCampaign(reference) { return { value: JSON.parse(await readFile(reference.path)), verified_by: 'retained-source' }; }
`);
  const producer = await sourceModule(base, 'implementation.mjs'), implementation = await producer.executionImplementation();
  const original = { source_root: base, implementation }, baseReference = await save(join(root, 'base-controller.json'), original);
  await cp(base, next, { recursive: true });
  await writeFile(join(next, 'benchmark/cli.mjs'), (await readFile(join(base, 'benchmark/cli.mjs'))) + "import './engineering-progress.mjs';\n");
  const updated = await (await sourceModule(next, 'implementation.mjs')).executionImplementation();
  const before = new Map(implementation.files.map(item => [item.path, item]));
  const overlay = updated.files.filter(item => fingerprint(item) !== fingerprint(before.get(item.path) ?? null));
  const composition = { version: 1, kind: 'benchmark-engineering-controller-composition', base_controller: baseReference,
    source_root: next, reviewed_repository: root, reviewed_commit: '1'.repeat(40), implementation: updated, overlay_files: overlay };
  return { original, composition, base, next, producer, baseReference };
}

test('composition file proof derives the complete graph and rejects omitted modules, collector changes and self-certified bases', async t => {
  const root = await temporary(t), fixture = await compositionFixture(root);
  await verifyEngineeringControllerFiles(fixture.composition, fixture.original);
  assert.ok(fixture.composition.implementation.files.some(item => item.path === 'engineering-progress.mjs'));
  const omitted = structuredClone(fixture.composition);
  omitted.implementation.files = omitted.implementation.files.filter(item => item.path !== 'engineering-progress.mjs');
  omitted.implementation.sha256 = fingerprint(omitted.implementation.files);
  omitted.overlay_files = omitted.overlay_files.filter(item => item.path !== 'engineering-progress.mjs');
  await assert.rejects(verifyEngineeringControllerFiles(omitted, fixture.original), /ENGINEERING_WINDOW_INCOMPLETE_IMPLEMENTATION/);
  const changed = structuredClone(fixture.composition), collector = changed.implementation.files.find(item => item.path === 'collect.mjs');
  await writeFile(join(fixture.next, 'benchmark/collect.mjs'), 'export const alteredCollector = true;\n');
  const bytes = await readFile(join(fixture.next, 'benchmark/collect.mjs')); Object.assign(collector, { sha256: sha(bytes), bytes: bytes.length });
  changed.implementation.sha256 = fingerprint(changed.implementation.files);
  await assert.rejects(verifyEngineeringControllerFiles(changed, fixture.original), /ENGINEERING_WINDOW_UNREVIEWED_SOURCE_CHANGE:collect.mjs/);
  const reference = await save(join(root, 'synthetic-composition.json'), fixture.composition);
  await assert.rejects(readEngineeringControllerComposition(reference, { execution: { implementation: fixture.original.implementation } }), /ENGINEERING_WINDOW_RETAINED_SOURCE3_REQUIRED/);
});

async function expectationFixture(root, producer) {
  const expectation = { projection: { visibility: { projection: { files: [{ path: 'observer.mjs', sha256: sha('observer'), bytes: 7 }] } },
    pi: { files: [{ path: 'sdk.mjs', sha256: sha('sdk'), bytes: 3 }] }, node: { sha256: sha('node') }, bun: { sha256: sha('bun') } } };
  const reference = await save(join(root, 'expectation.json'), expectation), execution = { conditions: { condition: { expectations: { case: reference } } } };
  execution.instrumentation = await producer.instrumentationIdentity(execution);
  return { expectation, reference, execution };
}

test('new instrumentation recomputes actual expectation bytes with the private producer and rejects retained-looking false runtime identities', async t => {
  const root = await temporary(t), fixture = await compositionFixture(root), observation = await expectationFixture(root, fixture.producer);
  const execution = { ...structuredClone(observation.execution), implementation: fixture.composition.implementation };
  execution.instrumentation = await (await sourceModule(fixture.next, 'implementation.mjs')).instrumentationIdentity(execution);
  // This lower-level guard receives a verified context in production. The
  // public composition reader above separately rejects this synthetic base.
  const contextComposition = { ...fixture.composition, base_controller: { ...fixture.baseReference, sha256: ENGINEERING_SOURCE3_CONTROLLER_SHA256 } };
  const continuation = { source: { execution: observation.execution }, controllerImplementation: fixture.composition.implementation,
    controllerSource: await save(join(root, 'internal-context-composition.json'), contextComposition) };
  await verifyEngineeringInstrumentation(execution, continuation);
  for (const mutate of [x => { x.instrumentation.runtime_sha256 = []; }, x => { x.instrumentation.runtime_sha256.push(sha('extra')); },
    x => { x.instrumentation.runtime_sha256[0] = sha('fake'); },
    x => { x.instrumentation.collector_files.find(item => item.path === 'benchmark/protocol.mjs').sha256 = sha('unreviewed-model-or-scoring-change'); },
    x => { x.instrumentation.collector_files.find(item => item.path === 'benchmark/collect.mjs').sha256 = sha('new-collector'); }]) {
    const changed = structuredClone(execution); mutate(changed); changed.instrumentation.collector_sha256 = fingerprint(changed.instrumentation.collector_files);
    assert.throws(() => assertEngineeringInstrumentation(changed, continuation));
  }
  const changed = structuredClone(execution), changedExpectation = structuredClone(observation.expectation);
  changedExpectation.projection.node.sha256 = sha('different-runtime');
  changed.conditions.condition.expectations.case = await save(join(root, 'changed-expectation.json'), changedExpectation);
  await assert.rejects(verifyEngineeringInstrumentation(changed, continuation), /ENGINEERING_WINDOW_CURRENT_INSTRUMENTATION_CHANGED/);
});

test('historical delegation uses the byte-bound old producer and remains historical after a later reservation and registration', async t => {
  const root = await temporary(t), fixture = await compositionFixture(root), observation = await expectationFixture(root, fixture.producer);
  const control = join(root, 'old-control'); await mkdir(control);
  const parentReference = await save(join(root, 'parent6.json'), { version: 6 });
  const amendment = { prospective_authorization: { reference: parentReference }, id: 'old-scope13' };
  const predecessor = await save(join(root, 'amendment13.json'), amendment);
  const plan = { id: 'old-code24', execution: { ...observation.execution, implementation: fixture.original.implementation, control_root: control } };
  const planReference = await save(join(control, 'plan.json'), plan);
  const context = { value: { version: 7, predecessor: { amendment: predecessor } }, engineeringContinuation: {
    historicalController: { reference: fixture.baseReference, source_root: fixture.base, implementation: fixture.original.implementation },
    historicalAuthorityReferences: [parentReference], parent: { value: { version: 6 }, fixtureOriginal: observation.execution.instrumentation }, parentReference,
    scopes: [{ plan, planReference, amendment }] } };
  assert.equal((await readEngineeringHistoricalAuthority(parentReference, context)).verified_by, 'retained-source');
  assert.deepEqual(await verifyEngineeringHistoricalPlan(plan, amendment, context), { verified_by: 'retained-source', plan_id: plan.id });
  await save(join(root, '105.json'), { run_id: 'new-window-001' }); await save(join(root, 'scope-registration-014.json'), { sequence: 14 });
  assert.deepEqual(await readEngineeringHistoricalPredecessor(predecessor, context), amendment);
  assert.deepEqual(await verifyEngineeringHistoricalPlan(plan, amendment, context), { verified_by: 'retained-source', plan_id: plan.id });
  await assert.rejects(readEngineeringHistoricalAuthority({ ...parentReference, sha256: sha('foreign') }, context), /FOREIGN_HISTORICAL_AUTHORITY/);
  await assert.rejects(verifyEngineeringHistoricalPlan({ ...plan, id: 'foreign' }, amendment, context), /FOREIGN_HISTORICAL_PLAN/);
  await assert.rejects(readEngineeringHistoricalPredecessor({ ...predecessor, sha256: sha('foreign') }, context), /FOREIGN_HISTORICAL_PREDECESSOR/);
  const changedExpectation = structuredClone(observation.expectation); changedExpectation.projection.node.sha256 = sha('changed-node');
  plan.execution.conditions.condition.expectations.case = await save(join(root, 'old-changed-expectation.json'), changedExpectation);
  context.engineeringContinuation.scopes[0].planReference = await save(join(control, 'plan.json'), plan);
  await assert.rejects(verifyEngineeringHistoricalPlan(plan, amendment, context), /RESOLVE_REPAIR_CURRENT_INSTRUMENTATION_CHANGED/);
  await writeFile(join(fixture.base, 'benchmark/finite-campaign.mjs'), (await readFile(join(fixture.base, 'benchmark/finite-campaign.mjs'))) + '\n// changed after binding\n');
  await assert.rejects(readEngineeringHistoricalPredecessor(predecessor, context), /ENGINEERING_WINDOW_HISTORICAL_SOURCE_CHANGED/);
});

test('prospective source provenance rejects wrong commit/blob before a self-reported protocol can execute', async t => {
  const root = await temporary(t), repository = join(root, 'reviewed'), source = join(root, 'candidate');
  await mkdir(join(repository, 'benchmark'), { recursive: true }); await mkdir(join(source, 'benchmark'), { recursive: true });
  const git = args => execFileSync('git', ['-C', repository, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).toString().trim();
  git(['init', '--quiet']); await writeFile(join(repository, 'benchmark/protocol.mjs'), 'export const approvedFixture = true;\n');
  git(['add', 'benchmark/protocol.mjs']); git(['-c', 'user.name=Offline Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Offline fixture source']);
  const reviewedCommit = git(['rev-parse', 'HEAD']), sentinel = join(root, 'UNREVIEWED_PROTOCOL_EXECUTED');
  const bad = "import { writeFileSync } from 'node:fs';\nwriteFileSync(" + JSON.stringify(sentinel) + ", 'executed');\n";
  await writeFile(join(source, 'benchmark/protocol.mjs'), bad);
  const composition = { version: 1, kind: 'benchmark-engineering-controller-composition', base_controller: { path: '/synthetic/base', sha256: ENGINEERING_SOURCE3_CONTROLLER_SHA256 },
    source_root: source, reviewed_repository: repository, reviewed_commit: reviewedCommit, implementation: {},
    overlay_files: [{ path: 'protocol.mjs', sha256: sha(bad), bytes: Buffer.byteLength(bad) }] };
  await assert.rejects(verifyReviewedEngineeringOverlay(composition), /ENGINEERING_WINDOW_REVIEWED_BLOB_CHANGED/);
  await assert.rejects(verifyReviewedEngineeringOverlay({ ...composition, reviewed_commit: 'f'.repeat(40) }));
  const compositionReference = await save(join(root, 'composition.json'), composition), reference = { path: '/synthetic/unused', sha256: sha('unused') };
  const draft = { version: 1, kind: ENGINEERING_WINDOW_DRAFT, id: 'synthetic-unreviewed-draft', approved: false, execution_authority: null,
    controller_source: compositionReference, parent_authorization: reference, checkpoint: reference, predecessor: { registration: reference, amendment: reference },
    transition: { source_plan: reference, source_ledger: reference }, model_window: { previous: { end: '2029-12-31T00:00:00Z' },
      proposed: { start: null, end: null }, duration_hours: 24, automatic_renewal: false }, proposal_sha256: null };
  draft.proposal_sha256 = fingerprint(draft); const draftReference = await save(join(root, 'draft.json'), draft);
  const decision = { version: 1, kind: 'user-approved-engineering-window-continuation', approved: true, source: 'current-user-message',
    user_message: 'SYNTHETIC OFFLINE FIXTURE ONLY', recorded_at_utc: '2030-01-01T00:00:00Z', approved_draft: draftReference,
    controller_source: compositionReference, parent_authorization: reference, checkpoint: reference, predecessor: draft.predecessor,
    source_plan: reference, source_ledger: reference, accepted_history_reservations: 104, registration_sequence: 13,
    approved_remaining_reservations: 35, total_reservation_ceiling: 139, max_scheduled_episodes: 144,
    model_window: { start: '2030-01-01T00:00:00Z', end: '2030-01-02T00:00:00Z', automatic_renewal: false },
    future_stop_policy: { core: 'stop', usage_unknown: 'stop', retry: false, renew_window: false } };
  await assert.rejects(prepareApprovedEngineeringWindowContinuation({ draftReference, userApproval: await save(join(root, 'decision.json'), decision) }), /ENGINEERING_WINDOW_REVIEWED_BLOB_CHANGED/);
  await assert.rejects(lstat(sentinel), { code: 'ENOENT' });
});

test('the execution closure includes the concrete runner, source proof and typed authority modules', async () => {
  const implementation = await executionImplementation();
  for (const name of ['engineering-runner.mjs', 'engineering-progress.mjs', 'engineering-source.mjs', 'campaign-engineering-window-continuation.mjs'])
    assert.ok(implementation.files.some(item => item.path === name), name);
});
