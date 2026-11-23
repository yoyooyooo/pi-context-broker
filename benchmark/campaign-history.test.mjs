import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fingerprint } from './protocol.mjs';
import { readCampaignHistory } from './campaign-history.mjs';
import { exampleEnvelope } from './analysis/fixtures.mjs';
import { normalizeEpisode } from './evidence/normalize.mjs';
import { writeEvidenceBundle } from './evidence/store.mjs';

const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-campaign-history-'))), pilot = join(root, 'pilot'); await mkdir(pilot);
  const paths = [], ledgers = [], rawFiles = [];
  for (let index = 0; index < 2; index++) {
    const owner = join(root, 'owner-' + index), control = join(owner, 'control'); await mkdir(control, { recursive: true });
    const conditionId = 'condition-' + index, caseId = 'case-' + index, runId = 'history-' + index;
    const slot = { slot_id: 'slot-' + index, condition_id: conditionId, case_id: caseId, repeat: 0, seed: 0, order: 0 };
    const environment = { id: 'environment-' + index, manifest_sha256: fingerprint({ index }), build: { id: 'build-' + index } };
    const plan = { version: 1, kind: 'benchmark-batch-plan', id: 'plan-' + index, protocol: { phase: 'pilot', conditions: [{ id: conditionId, model_id: 'model', environment_id: environment.id }],
      environments: [environment], models: [{ id: 'model' }] }, execution: { control_root: control, environment_root: owner, pilot_ledger_root: pilot }, slots: [slot], plan_sha256: null };
    plan.plan_sha256 = fingerprint(plan); const path = join(control, 'plan.json'); await save(path, plan); paths.push(path);
    const rawPath = join(owner, 'raw.json'); const envelope = exampleEnvelope({ condition: conditionId, caseId, episodeId: runId,
      attemptInputs: index ? [null] : [25], valid: !index, rawPath });
    Object.assign(envelope.input.identity, { run_id: runId, experiment_id: plan.id, model_id: 'model', environment_sha256: environment.manifest_sha256, build_id: environment.build.id, analysis_implementation: { files: [] } });
    await writeFile(rawPath, envelope.rawText); rawFiles.push(rawPath);
    const bundle = normalizeEpisode(envelope.input), e = bundle.episode, directory = join(owner, 'evidence'); await writeEvidenceBundle({ directory, bundle, rawRoot: owner });
    const result = { normalized_directory: directory, episode_sha256: e.episode_sha256, stop_batch: Boolean(index), budget_usage: {
      model_requests: e.measurements.actual_attempts.status === 'known' ? e.measurements.actual_attempts.value : null,
      input_tokens: e.measurements.input_total.value.status === 'known' ? e.measurements.input_total.value.value : null,
      output_tokens: e.measurements.output_total.value.status === 'known' ? e.measurements.output_total.value.value : null,
      duration_ms: e.timing.duration_ms.value } };
    const rows = [{ seq: 1, type: 'episode_started', run_id: runId, slot_id: slot.slot_id }, { seq: 2, type: 'episode_completed', run_id: runId, slot_id: slot.slot_id, result }, { seq: 3, type: 'batch_closed' }];
    const ledger = join(control, 'ledger.jsonl'); await writeFile(ledger, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); ledgers.push(ledger);
    await save(join(pilot, String(index + 1).padStart(3, '0') + '.json'), { run_id: runId, experiment_id: plan.id, slot_id: slot.slot_id, plan: { path, sha256: sha(await readFile(path)) }, plan_sha256: plan.plan_sha256 });
  }
  const options = { planFiles: paths, pilotLedgerRoot: pilot,
    assertPlan: plan => { assert.equal(plan.protocol.phase, 'pilot'); assert.equal(plan.plan_sha256, fingerprint({ ...plan, plan_sha256: null })); },
    assertModelEvidence: (episode, model) => assert.equal(episode.identity.model_id, model.id) };
  return { root, pilot, paths, ledgers, rawFiles, options };
}

test('generic history retains owning environments, unknown totals and all observations without inventing credit', async t => {
  const f = await fixture(), result = await readCampaignHistory(f.options);
  assert.equal(result.scheduled_episodes, 2); assert.deepEqual(result.unknown_usage_run_ids, ['history-1']);
  assert.equal(result.total_usage_status, 'incomplete'); assert.equal(result.total_usage.input_tokens, null);
  assert.equal(result.known_subtotal.input_tokens, 25); assert.equal(result.episodes[1].stop_batch, true);
  assert.ok(result.episodes.every(item => item.quality_credit === 'excluded_from_new_scope'));
  assert.equal(result.episodes[0].core_evidence, 'complete'); assert.equal(result.episodes[1].core_evidence, 'incomplete');
  assert.deepEqual(await readCampaignHistory({ ...f.options, expected: result }), result);
  await t.test('trusted contracts are mandatory and cannot be disabled by options', async () => {
    await assert.rejects(readCampaignHistory({ ...f.options, assertPlan: undefined }), /trusted plan contract/);
    await assert.rejects(readCampaignHistory({ ...f.options, assertModelEvidence: undefined }), /trusted model contract/);
    await assert.rejects(readCampaignHistory({ ...f.options, assertPlan: () => assert.fail('wrong phase') }), /wrong phase/);
  });
  await t.test('every reserved owner and unique plan must be supplied', async () => {
    await assert.rejects(readCampaignHistory({ ...f.options, planFiles: [f.paths[0]] }), /PLAN_MISSING/);
    await assert.rejects(readCampaignHistory({ ...f.options, planFiles: [f.paths[0], f.paths[0]] }), /DUPLICATE_PLAN/);
  });
  await t.test('an active historical owner or open ledger is rejected', async () => {
    const lease = join(f.root, 'owner-1/control/lease.json'); await save(lease, { pid: process.pid });
    await assert.rejects(readCampaignHistory(f.options), /LEASE_REQUIRES_RECONCILIATION/); await rename(lease, lease + '.retained');
    const bytes = await readFile(f.ledgers[1]); await writeFile(f.ledgers[1], bytes.toString().split('\n').slice(0, 2).join('\n') + '\n');
    await assert.rejects(readCampaignHistory(f.options), /OPEN_BATCH/); await writeFile(f.ledgers[1], bytes);
  });
  await t.test('ledger usage cannot disagree with the verified normalized evidence', async () => {
    const bytes = await readFile(f.ledgers[0]), rows = bytes.toString().trimEnd().split('\n').map(JSON.parse); rows[1].result.budget_usage.input_tokens++;
    await writeFile(f.ledgers[0], rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    await assert.rejects(readCampaignHistory(f.options), /USAGE_MISMATCH/); await writeFile(f.ledgers[0], bytes);
  });
  await t.test('reservation gaps and duplicate runs remain rejected', async () => {
    const path = join(f.pilot, '002.json'), bytes = await readFile(path); await rename(path, join(f.pilot, '003.json'));
    await assert.rejects(readCampaignHistory(f.options), /RESERVATION_GAP/); await rename(join(f.pilot, '003.json'), path);
    const changed = JSON.parse(bytes); changed.run_id = 'history-0'; await save(path, changed);
    await assert.rejects(readCampaignHistory(f.options), /DUPLICATE_RUN/); await writeFile(path, bytes);
  });
  await t.test('raw bytes and a frozen history snapshot are independently checked', async () => {
    const bytes = await readFile(f.rawFiles[0]); await writeFile(f.rawFiles[0], Buffer.concat([bytes, Buffer.from(' ')]));
    await assert.rejects(readCampaignHistory(f.options)); await writeFile(f.rawFiles[0], bytes);
    const changed = structuredClone(result); changed.known_subtotal.input_tokens++;
    await assert.rejects(readCampaignHistory({ ...f.options, expected: changed }), /HISTORY_CHANGED/);
  });
});
