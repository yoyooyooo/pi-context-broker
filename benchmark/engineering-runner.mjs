import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { validateBatchPlan } from './batch.mjs';
import { readApprovedCampaign, approvedCampaignBinding } from './approved-campaign.mjs';
import { ENGINEERING_WINDOW_REVISION } from './campaign-engineering-window-continuation.mjs';
import { ENGINEERING_PREFLIGHT_REPAIR_REVISION } from './campaign-engineering-preflight-repair.mjs';
import { verifyAuthorizedHistoryPlan } from './finite-campaign.mjs';
import { executeBatchPlan, analyzeBatch } from './controller.mjs';
import { runEngineeringSlices } from './engineering-progress.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

export function assertEngineeringRunnerAuthority(authorized, version) {
  assert.ok(version === 7 || version === 8);
  assert.equal(authorized.value.version, version, 'ENGINEERING_RUNNER_ENTRYPOINT_AUTHORITY_MISMATCH');
  assert.equal(authorized.value.revision.kind, version === 7 ? ENGINEERING_WINDOW_REVISION : ENGINEERING_PREFLIGHT_REPAIR_REVISION);
  if (version === 8) assert.ok(authorized.engineeringPreflightRepair, 'ENGINEERING_PREFLIGHT_REPAIR_CONTEXT_REQUIRED');
}

export const runEngineeringWindowBatch = input => runTypedEngineeringBatch(input, 7);
export const runEngineeringPreflightRepairBatch = input => runTypedEngineeringBatch(input, 8);

/** Each public entry has one exact authority type. A new claim owns its bounded
 * invocation series; executeBatchPlan retains every live dispatch guard. */
async function runTypedEngineeringBatch({ planFile, outputRoot, maximumSlice = 8 }, version) {
  assert.ok(isAbsolute(planFile) && isAbsolute(outputRoot));
  assert.equal(resolve(planFile), planFile); assert.equal(await realpath(planFile), planFile); assert.ok((await lstat(planFile)).isFile());
  assert.equal(resolve(outputRoot), outputRoot); assert.equal(await realpath(dirname(outputRoot)), dirname(outputRoot));
  assert.ok(Number.isSafeInteger(maximumSlice) && maximumSlice > 0);
  const bytes = await readFile(planFile), plan = JSON.parse(bytes); validateBatchPlan(plan);
  assert.equal(planFile, join(plan.execution.control_root, 'plan.json'), 'ENGINEERING_WINDOW_PLAN_OWNER_REQUIRED');
  const reference = plan.execution.campaign_scope?.amendment; assert.ok(reference, 'ENGINEERING_WINDOW_TYPED_PLAN_REQUIRED');
  const amendmentBytes = await readFile(reference.path); assert.equal(sha(amendmentBytes), reference.sha256);
  const amendment = JSON.parse(amendmentBytes), authorityReference = amendment.prospective_authorization?.reference;
  assert.ok(authorityReference, 'ENGINEERING_WINDOW_APPROVAL_REQUIRED');
  const authorized = await readApprovedCampaign(authorityReference);
  assertEngineeringRunnerAuthority(authorized, version);
  assert.deepEqual(amendment.prospective_authorization, approvedCampaignBinding(authorityReference, authorized.value, amendment.id));
  assert.equal(plan.execution.campaign_scope.id, amendment.id);
  // Reuse this same freshly verified authority for the shallow frozen-plan
  // proof. Even an already-complete ledger must belong to this exact design.
  await verifyAuthorizedHistoryPlan(plan, amendment, authorized, authorityReference);
  assert.equal(await realpath(authorized.value.environment_root), authorized.value.environment_root);
  assert.ok(outputRoot.startsWith(authorized.value.environment_root + '/control/'), 'ENGINEERING_WINDOW_RUNNER_OWNER_REQUIRED');
  if (version === 8) {
    const window = authorized.engineeringContinuation.modelWindow;
    assert.ok(Date.now() >= Date.parse(window.start) && Date.now() < Date.parse(window.end), 'ENGINEERING_PREFLIGHT_REPAIR_ORIGINAL_WINDOW_CLOSED');
  }
  const kind = version === 7 ? 'engineering-window' : 'engineering-preflight-repair';
  // mkdir is exclusive: an interrupted or completed runner claim is retained.
  await mkdir(outputRoot, { mode: 0o700 });
  await save(join(outputRoot, 'claim.json'), { version: 1, kind: kind + '-runner-claim',
    plan: { path: planFile, sha256: sha(bytes) }, authority: authorityReference, pid: process.pid,
    started_at: new Date().toISOString(), maximum_slice: maximumSlice, automatic_retry: false, automatic_resume: false });
  let checkpoints = 0, ledgerSnapshot = null;
  const ledgerPath = join(plan.execution.control_root, 'ledger.jsonl');
  const ledgerReference = async () => {
    try { return { path: ledgerPath, sha256: sha(await readFile(ledgerPath)) }; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const readRows = async () => {
    let bytes;
    try { bytes = await readFile(ledgerPath); } catch (error) { if (error.code === 'ENOENT') { ledgerSnapshot = null; return []; } throw error; }
    assert.ok(!bytes.length || bytes.at(-1) === 10, 'ENGINEERING_WINDOW_INCOMPLETE_LEDGER');
    ledgerSnapshot = { path: ledgerPath, sha256: sha(bytes) };
    return bytes.toString().split('\n').filter(Boolean).map(JSON.parse);
  };
  try {
    const result = await runEngineeringSlices({ plan, maximumSlice, readRows,
      runSlice: limit => executeBatchPlan({ plan, maximumNewEpisodes: limit }),
      writeCheckpoint: async checkpoint => {
        checkpoints++;
        await save(join(outputRoot, 'checkpoint-' + String(checkpoints).padStart(3, '0') + '.json'), {
          version: 1, kind: kind + '-prefix-checkpoint', recorded_at: new Date().toISOString(), ...checkpoint,
          plan: { path: planFile, sha256: sha(bytes) }, ledger: ledgerSnapshot });
      },
      verifySnapshot: async () => assert.deepEqual(await ledgerReference(), ledgerSnapshot, 'ENGINEERING_WINDOW_LEDGER_CHANGED_DURING_REVIEW'),
      analyzePrefix: async checkpoint => {
        const analysis = join(outputRoot, 'analysis-prefix-' + String(checkpoint.completed_prefix).padStart(3, '0'));
        await analyzeBatch({ root: plan.execution.control_root, outputDirectory: analysis });
        assert.deepEqual(await ledgerReference(), ledgerSnapshot, 'ENGINEERING_WINDOW_LEDGER_CHANGED_DURING_ANALYSIS');
        await save(join(outputRoot, 'analysis-' + String(checkpoints).padStart(3, '0') + '.json'), {
          completed_prefix: checkpoint.completed_prefix, output: analysis, new_completed: checkpoint.new_completed });
      },
    });
    const receipt = { version: 1, kind: kind + '-runner-receipt', status: result.action === 'finish' ? 'completed' : 'stopped',
      completed_at: new Date().toISOString(), checkpoints, result, automatic_resume: false };
    await save(join(outputRoot, 'receipt.json'), receipt); return receipt;
  } catch (error) {
    // A retained checkpoint precedes analysis. If parsing itself failed, link
    // the actual ledger rather than claiming a completed count or zero sends.
    let ledger = null;
    try { ledger = await ledgerReference(); } catch {}
    const receipt = { version: 1, kind: kind + '-runner-receipt', status: 'stopped', completed_at: new Date().toISOString(),
      checkpoints, ledger, error: { name: error.name, message: error.message }, execution_performed: null, automatic_resume: false };
    await save(join(outputRoot, 'receipt.json'), receipt); return receipt;
  }
}
