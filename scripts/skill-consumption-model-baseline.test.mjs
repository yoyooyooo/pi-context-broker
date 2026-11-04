import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeSource, verifyModelAnswer } from './skill-consumption-model-baseline.mjs';

test('ordinary task acceptance rejects permission-only replies containing the expected answer', () => {
  assert.equal(verifyModelAnswer({ stopReason: 'stop', text: '请先确认授权，我才能回答 12 加 7 是否等于 19。' }, ['19', '十九']), false);
  assert.equal(verifyModelAnswer({ stopReason: 'stop', text: 'I need your approval to answer whether the result is 19.' }, ['19']), false);
  assert.equal(verifyModelAnswer({ stopReason: 'stop', text: '12 加 7 等于 19。' }, ['19', '十九']), true);
});

test('a truncated, aborted, empty or wrong final answer cannot pass a cost sample', () => {
  for (const stopReason of ['length', 'aborted', 'error', 'toolUse', undefined]) {
    assert.equal(verifyModelAnswer({ stopReason, text: '19' }, ['19']), false);
  }
  assert.equal(verifyModelAnswer({ stopReason: 'stop', text: '   ' }, ['19']), false);
  assert.equal(verifyModelAnswer({ stopReason: 'stop', text: '20' }, ['19']), false);
});

const hostClosed = [{ event: 'spawn', pid: 123 }, { event: 'close', pid: 123, observedExit: true }];
const completedSource = id => [
  { phase: 'started', requestId: id },
  { phase: 'metrics', requestId: id, observed: true, complete: true },
  { phase: 'completed', requestId: id },
];

test('an empty source ledger or missing host lifecycle is unknown, not complete zero cost', () => {
  const empty = summarizeSource([], { beforeCloseRequestIds: [], ownedLifecycle: hostClosed });
  assert.equal(empty.complete, false);
  assert.equal(empty.observedHttpAttempts, 0);
  assert.equal(empty.httpAttempts, null);
  assert.equal(empty.decodedResponseBytes, null);
  assert.equal(summarizeSource(completedSource('a'), { beforeCloseRequestIds: ['a'] }).complete, false);
  const observed = summarizeSource(completedSource('a'), { beforeCloseRequestIds: ['a'], ownedLifecycle: hostClosed });
  assert.equal(observed.complete, true);
  assert.equal(observed.httpAttempts, 0);
  assert.match(observed.completenessScope, /not a metadata-producer terminal/);
});

test('late source starts and missing or duplicated closes invalidate final reconciliation', () => {
  const boundary = { beforeCloseRequestIds: ['a'], ownedLifecycle: hostClosed };
  const late = summarizeSource([...completedSource('a'), ...completedSource('b')], boundary);
  assert.equal(late.complete, false);
  assert.deepEqual(late.lateStarts, ['b']);
  assert.equal(late.httpAttempts, null);
  assert.equal(summarizeSource(completedSource('a').slice(0, -1), boundary).complete, false);
  assert.equal(summarizeSource([...completedSource('a'), { phase: 'completed', requestId: 'a' }], boundary).complete, false);
});
