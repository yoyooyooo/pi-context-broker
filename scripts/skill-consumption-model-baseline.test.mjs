import assert from 'node:assert/strict';
import test from 'node:test';
import { modelBaselineSource, validateModelBaselineConfig, summarizeSource, verifyModelAnswer } from './skill-consumption-model-baseline.mjs';

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

test('SDK mode requires an absent command and emits the unchanged default source; legacy CLI remains explicit', () => {
  const config = { version: 1, extension: '/fixture/index.mjs', database: '12345678-1234-1234-1234-123456789012',
    prompt: '12 加 7 是多少？', expectedAnswers: ['19'], counts: { cold: 5, warm: 20 } };
  const sdk = { ...config, transport: 'sdk' }, before = JSON.stringify(sdk);
  assert.equal(validateModelBaselineConfig(sdk), sdk);
  const source = modelBaselineSource(sdk, { cacheDir: '/fixture/cache' });
  assert.equal(Object.hasOwn(source, 'command'), false); assert.equal(source.prefetch, false);
  assert.equal(JSON.stringify(sdk), before);
  for (const command of [undefined, null, [], ['/node', '/cli']]) assert.throws(() => validateModelBaselineConfig({ ...sdk, command }), /omit command/);
  assert.throws(() => modelBaselineSource(sdk, { command: ['/wrapper'] }), /must not install a source wrapper/);
  const legacy = { ...config, command: ['/node', '/cli'] };
  assert.equal(validateModelBaselineConfig(legacy), legacy);
  assert.deepEqual(modelBaselineSource(legacy, { command: ['/ledger', '/config'] }).command, ['/ledger', '/config']);
  assert.throws(() => validateModelBaselineConfig(config));
  assert.throws(() => validateModelBaselineConfig({ ...legacy, transport: 'alternate' }));
  assert.throws(() => validateModelBaselineConfig({ ...sdk, model: 'another-provider/model' }));
});

test('SDK, CLI and HTTP counts stay distinct; missing, late and unmatched observations cannot prove zero cost', () => {
  const operation = (id, kind, attempts) => [
    { phase: 'started', requestId: id, kind },
    ...Array.from({ length: attempts }, (_, index) => ({ phase: 'attempt', kind: 'http', requestId: id, attempt: index + 1,
      request_kind: kind === 'sdk' ? 'notion_body' : 'notion_metadata', request_bytes: 3, response_bytes: 7 })),
    { phase: 'metrics', requestId: id, observed: true, complete: true },
    { phase: 'completed', requestId: id, kind, sdkStarted: kind === 'sdk' },
  ];
  const sdk = operation('sdk', 'sdk', 2), cli = operation('cli', 'cli', 1), ledger = [...cli, ...sdk];
  const options = { transport: 'sdk', sourceObservation: { complete: true, errors: [] }, ownedLifecycle: hostClosed, beforeCloseRequestIds: ['cli', 'sdk'] };
  const value = summarizeSource(ledger, options);
  assert.equal(value.complete, true); assert.equal(value.sdkStarts, 1); assert.equal(value.cliStarts, 1); assert.equal(value.httpAttempts, 3);
  assert.equal(value.sdkEntered, 1); assert.equal(value.decodedResponseBytes, 21); assert.equal(value.wireBytes, null);
  assert.equal(summarizeSource(sdk, { ...options, beforeCloseRequestIds: ['sdk'] }).httpAttempts, 2);
  const zero = summarizeSource(operation('sdk', 'sdk', 0), { ...options, beforeCloseRequestIds: ['sdk'] });
  assert.equal(zero.cliStarts, 0); assert.equal(zero.httpAttempts, 0);
  for (const [rows, changed] of [
    [[], { beforeCloseRequestIds: [] }],
    [sdk.filter(row => row.phase !== 'metrics'), { beforeCloseRequestIds: ['sdk'] }],
    [ledger, { sourceObservation: { complete: false, errors: ['missing-end-boundary'] } }],
    [ledger, { beforeCloseRequestIds: [] }],
    [[...ledger, { phase: 'unmatched_child_start' }], {}],
  ]) {
    const result = summarizeSource(rows, { ...options, ...changed });
    assert.equal(result.complete, false); assert.equal(result.httpAttempts, null); assert.equal(result.decodedResponseBytes, null);
  }
});
