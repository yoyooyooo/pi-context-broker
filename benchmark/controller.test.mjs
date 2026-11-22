import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completedEpisodeRecord } from './controller.mjs';

const successfulRaw = () => ({ status: 'completed', root: '/owned/run',
  shared: { runtime_check: { status: 'unchanged' }, frozen_artifacts: 'passed' },
  turn_control_verification: { status: 'absent', required: false }, stop_batch: false });
const collected = () => ({ stored: { directory: '/owned/normalized' }, bundle: { episode: { episode_sha256: 'a'.repeat(64) } },
  budget_usage: { requests: 4, input_tokens: 23621, output_tokens: 769 }, stop_batch: false, stop_reason: null });

test('a lost launcher acknowledgement retains complete evidence and costs while stopping the batch', () => {
  const raw = { ...successfulRaw(), stop_batch: true, dispatch_error: { name: 'Error', message: 'owned launcher acknowledgement lost' } };
  const facts = collected(), result = completedEpisodeRecord(raw, facts);
  assert.equal(result.status, 'completed');
  assert.equal(result.stop_batch, true);
  assert.equal(result.stop_reason, 'subject_dispatch_error');
  assert.deepEqual(result.budget_usage, facts.budget_usage);
  assert.equal(result.episode_sha256, facts.bundle.episode.episode_sha256);
});

test('missing, unknown and stopped turn control cannot be hidden by a completed child', () => {
  const reference = { path: '/owned/control/result.json', sha256: 'b'.repeat(64) };
  for (const verification of [
    { required: true, status: 'unavailable', result: null, receipt: null, reason: 'missing' },
    { required: true, status: 'verified', result: { status: 'stopped', reason: 'UNKNOWN_WRITE' }, receipt: reference },
  ]) {
    const facts = collected(), result = completedEpisodeRecord({ ...successfulRaw(), turn_control_verification: verification }, facts);
    assert.equal(result.stop_batch, true);
    assert.equal(result.stop_reason, 'turn_control_unverified_or_stopped');
    assert.deepEqual(result.budget_usage, facts.budget_usage);
    assert.deepEqual(result.turn_control.receipt, verification.receipt);
  }
  const retainedStop = completedEpisodeRecord({ ...successfulRaw(), turn_control: { status: 'stopped', reason: 'RETENTION_FAILED' },
    turn_control_verification: { required: true, status: 'verified', result: { status: 'completed' }, receipt: reference } }, collected());
  assert.equal(retainedStop.stop_batch, true);
  assert.equal(retainedStop.stop_reason, 'RETENTION_FAILED');
});

test('verified completion and legacy single-turn results preserve collector stop decisions', () => {
  assert.equal(completedEpisodeRecord(successfulRaw(), collected()).stop_batch, false);
  const completed = { ...successfulRaw(), turn_control_verification: { required: true, status: 'verified', result: { status: 'completed' }, receipt: { path: '/owned/result', sha256: 'c'.repeat(64) } } };
  assert.equal(completedEpisodeRecord(completed, collected()).stop_batch, false);
  assert.equal(completedEpisodeRecord(completed, { ...collected(), stop_batch: true, stop_reason: 'usage_unknown' }).stop_reason, 'usage_unknown');
  assert.equal(completedEpisodeRecord({ ...completed, shared: { runtime_check: { status: 'drifted' }, frozen_artifacts: 'passed' } }, collected()).stop_batch, true);
});
