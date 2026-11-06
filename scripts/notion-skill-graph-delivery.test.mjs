import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { isAbsolute, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { verifySessionReceipts, nextGraphTool } from './notion-skill-graph.mjs';
import { deliveryEvidence, nextSessionTool, unchangedSelection, fixedMainFailureTarget, failedSourceEvidence, sourceLedgerEvidence } from './notion-skill-graph-session.mjs';
import { systemTempRoot } from './verification-paths.mjs';
import { isolatedEnv } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const measure = value => ({ sha256: hash(value), bytes: Buffer.byteLength(value) });

function failurePlan(stage, name, code) {
  return { stage, steps: [{ name, arguments: {} }, { name: 'notion_ctl', arguments: {} }], expectedFailure: { index: 0, name, code } };
}

function failedTool(plan) {
  const expected = plan.expectedFailure;
  return { role: 'toolResult', toolCallId: plan.stage + ':' + expected.index, toolName: expected.name, isError: true,
    content: [{ type: 'text', text: expected.code === 'CATALOG_INCOMPLETE' ? 'context-broker source operation failed (CATALOG_INCOMPLETE)' : 'context-broker source notion unavailable (' + expected.code + '). The fixed snapshot is missing.' }] };
}

test('session planned refresh failure continues to the explicit graph audit', () => {
  const plan = failurePlan('failed-refresh-keeps-a', 'notion_use', 'CATALOG_INCOMPLETE');
  assert.deepEqual(nextSessionTool({ messages: [failedTool(plan)] }, plan), { type: 'toolCall', id: plan.stage + ':1', name: 'notion_ctl', arguments: {} });
  for (const diagnostic of ['Content reference is unavailable', 'context-broker source operation failed (AUTH_REQUIRED)']) {
    const wrong = failedTool(plan); wrong.content[0].text = diagnostic;
    assert.throws(() => nextSessionTool({ messages: [wrong] }, plan));
  }
});

test('session planned missing fixed read continues without accepting a successful fallback', () => {
  const plan = failurePlan('unavailable-fixed-rejects-current', 'read', 'SNAPSHOT_MISSING'), result = failedTool(plan);
  assert.equal(nextSessionTool({ messages: [result] }, plan).name, 'notion_ctl');
  result.isError = false;
  assert.throws(() => nextSessionTool({ messages: [result] }, plan), /expected.*fail/i);
});

test('session planned failure never permits another tool, error code or unplanned failure', () => {
  const plan = failurePlan('unavailable-fixed-rejects-current', 'read', 'SNAPSHOT_MISSING');
  for (const mutate of [
    result => { result.toolName = 'notion_use'; },
    result => { result.content[0].text = 'context-broker source notion unavailable (AUTH_REQUIRED).'; },
    result => { result.details = { contextBrokerRead: { snapshotId: 'unearned-success' } }; },
  ]) {
    const result = failedTool(plan); mutate(result);
    assert.throws(() => nextSessionTool({ messages: [result] }, plan));
  }
  const unexpected = failedTool(plan); unexpected.toolCallId = plan.stage + ':1'; unexpected.toolName = 'notion_ctl';
  assert.throws(() => nextSessionTool({ messages: [failedTool(plan), unexpected] }, plan));
  const ordinary = { ...plan }; delete ordinary.expectedFailure;
  assert.throws(() => nextSessionTool({ messages: [failedTool(plan)] }, ordinary));
});

test('failed refresh must keep the exact prior scope, graph lock, pin and delivered state', () => {
  const { nodes } = fixture();
  const before = { scopes: nodes.map(node => ({ scope: node.scope, graph_locks: [{ sha256: hash(node.binding.ref) }],
    nodes: [{ binding: node.binding, selected: true, loaded: true }] })) };
  assert.match(unchangedSelection(before, structuredClone(before)), /^[0-9a-f]{64}$/u);
  for (const mutate of [
    value => { value.scopes[0].scope = 'wrong-scope'; },
    value => { value.scopes[0].graph_locks[0].sha256 = hash('new B vector'); },
    value => { value.scopes[0].nodes[0].binding.snapshot_id = 's_' + hash('new B'); },
    value => { value.scopes[0].nodes[0].loaded = false; },
  ]) {
    const after = structuredClone(before); mutate(after);
    assert.throws(() => unchangedSelection(before, after), /Failed refresh changed/);
  }
});

function failedSource({ fixed = false } = {}) {
  const ref = fixed ? 'skill://selected/SKILL.md?snapshot=s_' + hash('old A') + '&file_id=main-a' : 'skill://selected/SKILL.md';
  const code = fixed ? 'SNAPSHOT_MISSING' : 'CATALOG_INCOMPLETE', dataSource = { id: 'controlled-skills', database: 'controlled-database' };
  return {
    expected: { commands: [fixed ? 'files' : 'prepare'], ref, code, ...(fixed ? {} : { dataSource }) },
    receipt: { id: 'real-cli-operation', command: fixed ? 'files' : 'prepare', args: fixed ? ['files', ref] : ['prepare', ref, '--refresh'],
      code: 1, signal: null, timedOut: false, response: { ok: false, error: { code, ...(fixed ? {} : { details: { method: 'explicit_database', exhaustive: false,
        failed_sources: [{ id: dataSource.id, data_source_id: dataSource.id, database_id: dataSource.database, code: 'NOT_FOUND' }] } }) } },
      metrics: { complete: true, total_requests: fixed ? 0 : 1, trace: fixed ? [] : [{ event: 'attempt', request_kind: 'notion_metadata',
        method: 'POST', target: { data_source_id: dataSource.id }, outcome: 'failure', http_status: 404 }] } },
  };
}

test('planned source errors require the exact real CLI input, code, exit and full metadata ledger', () => {
  for (const fixed of [false, true]) {
    const value = failedSource({ fixed });
    assert.equal(failedSourceEvidence([value.receipt], value.expected).code, value.expected.code);
    for (const mutate of [
      receipt => { receipt.code = 0; },
      receipt => { receipt.args[1] = 'skill://other/SKILL.md'; },
      receipt => { receipt.response.error.code = 'AUTH_REQUIRED'; },
      receipt => { receipt.signal = 'SIGKILL'; receipt.code = null; },
      receipt => { receipt.timedOut = true; },
      receipt => { receipt.metrics.complete = false; },
      receipt => { receipt.metrics.total_requests++; },
      receipt => { receipt.metrics.trace.push({ event: 'attempt', request_kind: 'notion_body' }); },
      receipt => { receipt.metrics.trace.push({ event: 'attempt', request_kind: 'notion_write' }); },
    ]) {
      const receipt = structuredClone(value.receipt); mutate(receipt);
      assert.throws(() => failedSourceEvidence([receipt], value.expected));
    }
  }
});

test('unavailable fixed evidence rejects a current prepare fallback and refresh evidence rejects another target', () => {
  const fixed = failedSource({ fixed: true });
  for (const command of ['prepare', 'use', 'export']) {
    const fallback = { command, args: [command, 'skill://selected/SKILL.md'], code: 0,
      metrics: { complete: true, total_requests: 0, trace: [] } };
    assert.throws(() => failedSourceEvidence([fixed.receipt, fallback], fixed.expected), /fall back/);
  }
  const refresh = failedSource();
  for (const mutate of [
    receipt => { receipt.response.error.details.failed_sources[0].data_source_id = 'another-source'; },
    receipt => { receipt.response.error.details.failed_sources[0].database_id = 'another-database'; },
    receipt => { receipt.response.error.details.failed_sources[0].code = 'AUTH_REQUIRED'; },
    receipt => { receipt.response.error.details.failed_sources.push({ ...receipt.response.error.details.failed_sources[0] }); },
    receipt => { receipt.metrics.trace[0].target.data_source_id = 'another-source'; },
    receipt => { receipt.metrics.trace[0].http_status = 403; },
    receipt => { receipt.metrics.trace[0].outcome = 'success'; },
    receipt => { receipt.args.pop(); },
  ]) {
    const receipt = structuredClone(refresh.receipt); mutate(receipt);
    assert.throws(() => failedSourceEvidence([receipt], refresh.expected));
  }
  const unexpected = structuredClone(fixed.receipt); unexpected.id = 'another-failure';
  assert.throws(() => failedSourceEvidence([fixed.receipt, unexpected], fixed.expected), /Only the planned/);
});

for (const command of ['read', 'files']) test('unavailable fixed evidence rejects an additional current ' + command + ' even with zero HTTP', () => {
  const fixed = failedSource({ fixed: true });
  const fallback = { command, args: [command, 'skill://selected/SKILL.md'], code: 0,
    metrics: { complete: true, total_requests: 0, trace: [] } };
  assert.throws(() => failedSourceEvidence([fixed.receipt, fallback], fixed.expected), /fixed reference/);
});

test('a failed fixed source must use the exact positional ref, not an unrelated flag value', () => {
  const fixed = failedSource({ fixed: true });
  fixed.receipt.args = ['files', 'skill://selected/SKILL.md', '--database', fixed.expected.ref];
  assert.throws(() => failedSourceEvidence([fixed.receipt], fixed.expected), /exact requested reference/);
});

test('fixed failure permits the original fixed target and only the existing metadata commands', () => {
  const fixed = failedSource({ fixed: true });
  const argv = [['read', fixed.expected.ref], ['list'], ['views'], ['schema', 'read'], ['ctl', 'views'], ['ctl', 'doctor'], ['ctl', 'cache', 'identity']];
  const metadata = argv.map(args => ({ command: args[0], args, code: 0, metrics: { complete: true, total_requests: 0, trace: [] } }));
  assert.equal(failedSourceEvidence([fixed.receipt, ...metadata], fixed.expected).code, 'SNAPSHOT_MISSING');
  for (const args of [['ctl', 'prepare', fixed.expected.ref], ['ctl', 'cache', 'clear']]) {
    assert.throws(() => failedSourceEvidence([fixed.receipt, { command: args[0], args, code: 0 }], fixed.expected), /fall back/);
  }
  const mismatchedCommand = { command: 'list', args: ['read', 'skill://selected/SKILL.md'], code: 0,
    metrics: { complete: true, total_requests: 0, trace: [] } };
  assert.throws(() => failedSourceEvidence([fixed.receipt, mismatchedCommand], fixed.expected), /recorded argv/);
});

function fixedMainFixture() {
  const value = fixture(), node = value.nodes[0], binding = node.binding;
  const target = binding.record.ref + '?snapshot=' + binding.snapshot_id;
  const selection = { status: 'passed', delivery: deliveryEvidence([value.message], value.nodes, 'stage'), selectedGraph: { kind: 'selected_graph', scopes: value.nodes.map((item, index) => ({
    scope: item.scope, nodes: [{ binding: item.binding, selected: true, loaded: true }], graph_locks: [value.message.details.contextBrokerPreparation.graphs[index].graph_lock],
  })) } };
  const fixedMain = fixedMainFailureTarget(selection, [value.message], binding.ref, binding.record.locator.database_id);
  const error = { code: 'SNAPSHOT_MISSING', details: { snapshot_id: binding.snapshot_id } };
  const preparation = { version: 1, purpose: 'inspect', scope: binding.scope, status: 'failed',
    roots: [{ target, readiness: 'not_ready' }], nodes: [{ id: node.id, ref: target, roles: ['root'], state: 'failed', error }],
    required: [], required_closure: [], observed_bindings: [], usage: { prepared_nodes: 0, instruction_bytes: 0 }, errors: [{ target, ...error }] };
  const receipt = { id: 'fixed-main-actual-shape', command: 'prepare', args: ['prepare', target, '--purpose', 'inspect', '--database', fixedMain.database, '--max-age', '0', '--metrics'],
    code: 1, signal: null, timedOut: false, response: { ok: false, error: { ...error, details: { ...error.details, preparation } } },
    metrics: { complete: true, total_requests: 1, trace: [{ event: 'attempt', request_kind: 'notion_metadata', method: 'GET', http_status: 200, outcome: 'success' }] } };
  return { ...value, selection, fixedMain, receipt, expected: { commands: ['read', 'files'], ref: binding.ref, code: 'SNAPSHOT_MISSING', fixedMain } };
}

test('fixed-main exception requires the first complete root delivery, matching graph and proven main File ID', () => {
  for (const mutate of [
    value => { value.selection.status = 'failed'; },
    value => { value.selection.delivery[0].scope = 'another-scope'; },
    value => { value.selection.delivery[0].body_sha256 = hash('different body'); },
    value => { value.selection.selectedGraph.scopes[0].nodes[0].loaded = false; },
    value => { value.selection.selectedGraph.scopes[0].graph_locks[0].roots = []; },
    value => { value.message.isError = true; },
    value => { value.message.details.contextBrokerPreparation.records[0].directory.files[0].ref += '-other-file'; },
    value => { value.message.details.contextBrokerPreparation.records[0].directory.files[0].path = 'guide.md'; },
  ]) {
    const value = fixedMainFixture(); mutate(value);
    assert.throws(() => fixedMainFailureTarget(value.selection, [value.message], value.expected.ref, value.fixedMain.database));
  }
  const value = fixedMainFixture();
  assert.throws(() => fixedMainFailureTarget(value.selection, [value.message], value.expected.ref, 'another-database'));
  assert.throws(() => fixedMainFailureTarget(value.selection, [value.message], value.expected.ref.replace('/SKILL.md', '/guide.md'), value.fixedMain.database));
});

test('fixed main permits the unique failed inspect preparation without changing owner, pin or main identity', () => {
  const value = fixedMainFixture();
  assert.equal(failedSourceEvidence([value.receipt], value.expected).code, 'SNAPSHOT_MISSING');
  for (const mutate of [
    receipt => { receipt.args[1] = value.nodes[0].record.ref; },
    receipt => { receipt.args[1] += '&file_id=other'; },
    receipt => { receipt.args[1] = receipt.args[1].replace(value.fixedMain.snapshot, 's_' + hash('different pin')); },
    receipt => { receipt.args.splice(2, 0, 'skill://another/SKILL.md'); },
    receipt => { receipt.args[3] = 'use'; },
    receipt => { receipt.args.push('--refresh'); },
    receipt => { receipt.args[5] = 'different-database'; },
    receipt => { receipt.response.error.details.snapshot_id = 's_' + hash('different pin'); },
    receipt => { receipt.response.error.details.preparation.scope = 'wrong-scope'; },
    receipt => { receipt.response.error.details.preparation.roots.push({ target: 'another', readiness: 'not_ready' }); },
    receipt => { receipt.response.error.details.preparation.roots[0].readiness = 'entry_ready'; },
    receipt => { receipt.response.error.details.preparation.nodes[0].id = 'another-owner'; },
    receipt => { receipt.response.error.details.preparation.nodes[0].state = 'prepared'; },
    receipt => { receipt.response.error.details.preparation.nodes[0].content = 'Unexpected body'; },
    receipt => { receipt.response.error.details.preparation.nodes[0].error.code = 'AUTH_REQUIRED'; },
    receipt => { receipt.response.error.details.preparation.usage.prepared_nodes = 1; },
    receipt => { receipt.response.error.details.preparation.observed_bindings.push(value.nodes[0].binding); },
    receipt => { receipt.response.error.details.preparation.required.push({ from: value.fixedMain.owner, to: 'another' }); },
    receipt => { receipt.code = 0; receipt.response.ok = true; },
    receipt => { receipt.metrics.trace[0].request_kind = 'notion_body'; },
    receipt => { receipt.metrics.trace[0].request_kind = 'notion_write'; },
  ]) {
    const receipt = structuredClone(value.receipt); mutate(receipt);
    assert.throws(() => failedSourceEvidence([receipt], value.expected));
  }
  assert.throws(() => failedSourceEvidence([value.receipt], { ...value.expected, fixedMain: undefined }));
  assert.throws(() => failedSourceEvidence([value.receipt], { ...value.expected, ref: value.expected.ref.replace('/SKILL.md', '/guide.md') }));
  const successful = { ...value.receipt, id: 'extra-prepare', code: 0, response: { ok: true } };
  assert.throws(() => failedSourceEvidence([value.receipt, successful], value.expected));
});

test('the full server ledger stays distinct from a cancelled local identity with unobserved metrics', () => {
  const receipts = [
    { id: 'measured', command: 'read', args: ['read', 'skill://selected/SKILL.md'], code: 1, signal: null, timedOut: false,
      metrics: { complete: true, total_requests: 1, trace: [{ event: 'attempt', method: 'GET', http_status: 404, request_bytes: 0, response_bytes: 17 }] } },
    { id: 'cancelled', command: 'ctl', args: ['ctl', 'cache', 'identity', '--database', 'owned'], code: null, signal: 'SIGTERM', timedOut: false, stdout: '', stderr: '' },
  ];
  const processes = receipts.flatMap((receipt, index) => [
    { category: 'installed-cli', event: 'spawn', id: receipt.id, childPid: index + 10, args: receipt.args, at: '2026-11-06T00:00:00Z' },
    ...(index ? [{ category: 'installed-cli', event: 'signal', id: receipt.id, childPid: index + 10, signal: 'SIGTERM', forwarded: true, at: '2026-11-06T00:00:01Z' }] : []),
    { category: 'installed-cli', event: 'close', id: receipt.id, childPid: index + 10, code: receipt.code, signal: receipt.signal, timedOut: false, observedExit: true, at: '2026-11-06T00:00:02Z' },
  ]);
  const requests = [{ sequence: 1, method: 'GET', status: 404, request_bytes: 0, response_bytes: 17 }];
  const before = JSON.stringify({ receipts, processes, requests }), result = sourceLedgerEvidence(receipts, requests, processes);
  assert.equal(result.serverHttpFullyCovered, true); assert.equal(result.allInvocationMetricsPresent, false);
  assert.deepEqual(result.unmeasured, [{ id: 'cancelled', args: receipts[1].args, code: null, signal: 'SIGTERM', metricsPresent: false, metrics: null }]);
  assert.equal(JSON.stringify({ receipts, processes, requests }), before);
  for (const mutate of [
    value => { value.requests.push({ ...value.requests[0], sequence: 2 }); },
    value => { value.requests = []; },
    value => { value.requests[0].sequence = 2; },
    value => { value.requests[0].response_bytes++; },
    value => { value.requests[0].status = 200; },
    value => { value.receipts[0].metrics.complete = false; },
    value => { value.receipts[0].metrics.total_requests++; },
    value => { value.receipts[1].command = 'read'; },
    value => { value.receipts[1].code = 0; },
    value => { value.receipts[1].metrics = { complete: true, total_requests: 0, trace: [] }; },
    value => { value.processes.find(event => event.event === 'signal').forwarded = false; },
    value => { value.processes.pop(); },
  ]) {
    const value = structuredClone({ receipts, processes, requests }); mutate(value);
    assert.throws(() => sourceLedgerEvidence(value.receipts, value.requests, value.processes));
  }
});

const installedFaultEnabled = ['BROKER_SESSION_CLI_ENTRY', 'BROKER_SESSION_CLI_SOURCE', 'BROKER_SESSION_BUN'].some(key => process.env[key]);
test('installed refresh fault intercepts required metadata, preserves unrelated routes and disarms in finally', { skip: !installedFaultEnabled, timeout: 150000 }, async t => {
  const cli = process.env.BROKER_SESSION_CLI_ENTRY, cliSource = process.env.BROKER_SESSION_CLI_SOURCE, bun = process.env.BROKER_SESSION_BUN;
  assert.ok([cli, cliSource, bun].every(value => isAbsolute(value ?? '')), 'The controlled regression requires explicit installed CLI, frozen fixture source and Bun paths');
  const directory = await mkdtemp(join(await systemTempRoot(), 'graph-session-fault-'));
  t.diagnostic('owned refresh fault fixture: ' + directory);
  const output = join(directory, 'service'), control = join(directory, 'control.json'), responses = join(directory, 'responses');
  await mkdir(output); await mkdir(responses);
  const setControl = async armed => { await writeFile(control + '.next', JSON.stringify({ revision: 'B', fail_refresh_root: armed })); await rename(control + '.next', control); };
  await setControl(true);
  const token = 'controlled-ah577-graph-token', servicePath = fileURLToPath(new URL('./notion-skill-graph-service.mjs', import.meta.url));
  const service = spawn(bun, [servicePath, '--output', output, '--control', control, '--cli-repo', cliSource], {
    cwd: directory, env: isolatedEnv({ base: join(directory, 'service-home'), agentDir: join(directory, 'unused-agent'), NOTION_API_TOKEN: token }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [], stderr = [];
  service.stdout.on('data', value => stdout.push(value)); service.stderr.on('data', value => stderr.push(value));
  const closed = new Promise((resolve, reject) => { service.once('error', reject); service.once('close', (code, signal) => resolve({ code, signal })); });
  let info, invoke;
  try {
    const deadline = Date.now() + 15000;
    while (!info && Date.now() < deadline) {
      if (service.exitCode !== null) throw new Error('Controlled service exited: ' + Buffer.concat(stderr));
      try { info = JSON.parse(await readFile(join(output, 'server-info.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await pause(20); }
    }
    assert.ok(info, 'Controlled service did not become ready');
    const ca = await readFile(info.cert);
    invoke = (method, path) => new Promise((resolve, reject) => {
      const body = method === 'POST' ? '{}' : undefined;
      const request = httpsRequest(new URL(path, info.origin), { method, ca, headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      request.setTimeout(30000, () => request.destroy(new Error('Controlled route probe timed out')));
      request.on('error', reject); request.end(body);
    });
    const state = join(directory, 'source-state.json'), ledger = join(directory, 'processes.jsonl'); await writeFile(ledger, '');
    await writeFile(state, JSON.stringify({ cli, cliSha256: hash(await readFile(cli)), cwd: directory, responses, ledger,
      env: isolatedEnv({ base: join(directory, 'consumer'), agentDir: join(directory, 'consumer-agent'), NOTION_API_TOKEN: token, NOTION_API_BASE_URL: info.origin, NODE_EXTRA_CA_CERTS: info.cert, NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000' }) }));
    const ref = 'skill://' + encodeURIComponent(info.logical_ids.root) + '/SKILL.md';
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./notion-skill-graph-session.mjs', import.meta.url)), '--source', state, 'prepare', ref, '--purpose', 'use', '--database', info.database, '--refresh'], { encoding: 'utf8', timeout: 125000 });
    await writeFile(join(directory, 'prepare.stdout.json'), result.stdout); await writeFile(join(directory, 'prepare.stderr.log'), result.stderr);
    const observed = (await readFile(info.ledger, 'utf8')).split('\n').filter(Boolean).map(JSON.parse), faults = observed.filter(row => row.fault);
    t.diagnostic(JSON.stringify({ cliExit: result.status, faultHits: faults.length, http: observed.length }));
    assert.ok(faults.length > 0, 'An armed refresh fault must intercept the actual installed CLI path');
    assert.equal(result.status, 1); assert.equal(result.signal, null);
    const files = await readdir(responses); assert.equal(files.length, 1);
    const receipt = JSON.parse(await readFile(join(responses, files[0]), 'utf8'));
    const proof = failedSourceEvidence([receipt], { commands: ['prepare'], ref, code: 'CATALOG_INCOMPLETE', dataSource: { id: info.data_source_id, database: info.database } });
    assert.equal(faults.length, proof.failedAttempts.length);
    assert.ok(faults.every((row, index) => row.method === 'POST' && row.path.split('?')[0] === 'v1/data_sources/' + info.data_source_id + '/query'
      && row.status === 404 && row.request_bytes === proof.failedAttempts[index].request_bytes && row.response_bytes === proof.failedAttempts[index].response_bytes));
    await writeFile(join(directory, 'failure-proof.json'), JSON.stringify(proof, null, 2) + '\n');
    assert.equal((await invoke('GET', '/v1/users/me')).status, 200);
    assert.equal((await invoke('GET', '/v1/pages/' + info.pages.root)).status, 200);
  } finally {
    try {
      await setControl(false);
      if (invoke) assert.equal((await invoke('POST', '/v1/data_sources/' + info.data_source_id + '/query')).status, 200, 'Disarmed inventory must be available again');
    } finally {
      if (service.exitCode === null && service.signalCode === null) service.kill('SIGTERM');
      const kill = setTimeout(() => service.kill('SIGKILL'), 10000);
      let stopped;
      try { stopped = await closed; } finally { clearTimeout(kill); }
      await writeFile(join(output, 'stdout.log'), Buffer.concat(stdout)); await writeFile(join(output, 'stderr.log'), Buffer.concat(stderr));
      assert.deepEqual(stopped, { code: 0, signal: null });
      assert.equal(JSON.parse(await readFile(join(output, 'stopped.json'), 'utf8')).fail_refresh_root, false);
    }
  }
});

// Exercise the original --source subprocess boundary. This fake CLI only
// observes forwarding; the installed CLI + HTTPS fixture supplies View evidence.
async function commandFixture(t) {
  const directory = await mkdtemp(join(await systemTempRoot(), 'graph-session-command-'));
  t.diagnostic('owned command fixture: ' + directory);
  const cli = join(directory, 'argv.mjs'), responses = join(directory, 'responses'), ledger = join(directory, 'processes.jsonl');
  const source = 'process.stdout.write(JSON.stringify({ok:true,argv:process.argv.slice(2)})+"\\n");\n';
  await mkdir(responses); await writeFile(cli, source); await writeFile(ledger, '');
  const state = join(directory, 'state.json');
  await writeFile(state, JSON.stringify({ cli, cliSha256: hash(source), cwd: directory, responses, ledger, env: {} }));
  const invoke = args => spawnSync(process.execPath, [fileURLToPath(new URL('./notion-skill-graph-session.mjs', import.meta.url)), '--source', state, ...args], { encoding: 'utf8', timeout: 10000 });
  return { invoke, ledger };
}

test('session custom command forwards the current ctl views metadata entry unchanged', async t => {
  const { invoke } = await commandFixture(t), args = ['ctl', 'views', '--database', 'controlled-library', '--max-age', '0'];
  const result = invoke(args);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).argv, args);
});

test('session custom command keeps legacy views and rejects unrelated ctl or author commands before a CLI spawn', async t => {
  const { invoke, ledger } = await commandFixture(t);
  for (const args of [['views', '--database', 'controlled-library'], ['ctl', 'doctor'], ['ctl', 'cache', 'identity']]) {
    const result = invoke(args); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).argv, args);
  }
  const before = await readFile(ledger, 'utf8');
  for (const args of [['ctl', 'sync'], ['ctl', 'operation', 'resume', 'unknown'], ['ctl', 'cache', 'clear'], ['create', 'unexpected']]) {
    const result = invoke(args); assert.notEqual(result.status, 0); assert.match(result.stderr, /AssertionError/);
  }
  assert.equal(await readFile(ledger, 'utf8'), before);
});

const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => JSON.stringify(key) + ':' + canonical(child)).join(',') + '}';

// Independent captured-shape fixtures, not production compiler output. Rebuild
// only the declared rendered hashes when testing loss of the original source.
function rendered(message) {
  const content = message.content[0].text, model = JSON.parse(content), proof = message.details.contextBrokerPreparation;
  if (proof.projection) proof.projection.rendered = measure(content);
  let cursor = content.indexOf('"records":[');
  for (const [index, record] of model.records.entries()) {
    const serialized = JSON.stringify(record), offset = content.indexOf(serialized, cursor);
    const start = offset + serialized.indexOf('"content":' + JSON.stringify(record.content)) + '"content":"'.length;
    const encoded = JSON.stringify(record.content).slice(1, -1), delivery = { start, end: start + encoded.length, encoding: 'json' };
    proof.records[index].delivery = delivery;
    if (proof.projection) Object.assign(proof.projection.records[index], { delivery: { ...delivery }, rendered: measure(encoded) });
    cursor = offset + serialized.length;
  }
}

function fixture({ version = 2, sameIdentityAcrossScopes = false } = {}) {
  const nodes = [0, 1].map(index => {
    const scope = (index ? 'b' : 'a').repeat(64), id = 'shared_skill:' + (sameIdentityAcrossScopes ? 'same' : index);
    const body = '\ufeff# Author 🧭\r\n<body>literal</body> "content" \\ ' + (sameIdentityAcrossScopes ? 'same' : index) + '\r\n';
    const snapshot = 's_' + hash(sameIdentityAcrossScopes ? 'same snapshot' : 'snapshot ' + index);
    const ref = 'skill://' + encodeURIComponent(id) + '/SKILL.md?snapshot=' + snapshot + '&file_id=main-' + index;
    const record = { id, kind: 'skill', name: '原始内容 ' + index, alias: 'source-' + index, description: 'Source oracle', entrypoint: 'SKILL.md',
      ref: 'skill://' + encodeURIComponent(id) + '/SKILL.md', default_context: false,
      locator: { type: 'shared_skill', database_id: 'database', data_source_id: 'source', library_id: 'library', skill_id: id, page_id: 'page-' + index } };
    const binding = { record, scope, snapshot_id: snapshot, version_id: hash('version ' + index), body_sha256: hash(body), ref };
    return { id, scope, record, body, content: body, snapshot_id: snapshot, bytes: Buffer.byteLength(body), body_sha256: hash(body), binding,
      modelRef: 'sr:S' + (index ? 'c' : 'd').repeat(22), directory: { files: [{ path: 'SKILL.md', ref, bytes: Buffer.byteLength(body), sha256: hash(body) }], required: [], candidates: [], references: [] } };
  });
  const graphs = nodes.map(node => {
    const vector = { version: 1, kind: 'observed_version_vector', purpose: 'use', scope: node.scope, roots: [node.id], required: [], bindings: [node.binding] };
    return { scope: node.scope, roots: [node.id], graph_lock: { ...vector, sha256: hash(canonical(vector)) },
      budget: { maxNodes: 64, maxDepth: 16, maxInstructionBytes: 1048576, maxContextBytes: 262144 },
      usage: { prepared_nodes: 1, instruction_bytes: node.bytes, context_bytes: node.bytes, max_depth: 0 } };
  });
  const records = nodes.map(node => ({ version: 2, identity: JSON.stringify(['notion', 'owned', node.scope, 'skill', node.id]), contentIdentity: JSON.stringify([node.scope, node.id]),
    loaded: true, snapshotId: node.snapshot_id, bodySha256: node.body_sha256, bytes: node.bytes, binding: node.binding, directory: node.directory }));
  const modelRecords = nodes.map(node => version === 2 ? { name: node.record.name, kind: node.record.kind, ref: node.modelRef, content: node.body,
    directory: { files: [{ path: 'SKILL.md', ref: node.modelRef, bytes: node.bytes }], required: [], candidates: [], references: [] } }
    : { id: node.id, scope: node.scope, ref: node.binding.ref, snapshot_id: node.snapshot_id, version_id: node.binding.version_id,
      body_sha256: node.body_sha256, bytes: node.bytes, content: node.body, directory: node.directory });
  const model = { ok: true, status: 'ready', purpose: 'use', ...(version === 2 ? { roots: nodes.map(node => node.modelRef) } : { graphs }), records: modelRecords };
  const content = JSON.stringify(model);
  const projection = { version: 1, compiler: 'context-broker/skill-prepare/v1', sourceProjection: 'source-identity/v1', rendered: measure(content), records: records.map((record, index) =>
    ({ index, ref: modelRecords[index].ref, source: { identity: record.identity, sha256: record.bodySha256, bytes: record.bytes }, state: 'source' })) };
  const message = { role: 'toolResult', toolName: version === 1 ? 'skill_prepare' : 'notion_use', toolCallId: 'stage:0', isError: false, content: [{ type: 'text', text: content }],
    details: { contextBrokerPreparation: { version, toolCallId: 'stage:0', purpose: 'use', records, graphs, ...(version === 2 ? { projection } : {}) } } };
  rendered(message);
  return { message, nodes };
}

function verifyBoth(value, options) {
  return [verifySessionReceipts([value.message], value.nodes, options), deliveryEvidence([value.message], value.nodes, 'stage', options)];
}

test('current graph selectors use list/use and native inspection while old tool receipts require explicit historical mode', () => {
  const empty = { messages: [] };
  assert.equal(nextGraphTool(empty, { mode: 'prepare-use' }).name, 'notion_list');
  const root = 'sr:C' + 'a'.repeat(22);
  const context = { messages: [{ role: 'toolResult', toolCallId: 'graph-search', content: JSON.stringify({ records: [{ ref: root, in_default_view: true }] }) }] };
  assert.deepEqual(nextGraphTool(context, { mode: 'prepare-use' }).arguments, { ref: root });
  assert.equal(nextGraphTool(context, { mode: 'prepare-use' }).name, 'notion_use');
  assert.deepEqual(nextGraphTool(context, { mode: 'prepare-inspect' }).arguments, { path: root });
  assert.equal(nextGraphTool(context, { mode: 'prepare-inspect' }).name, 'read');
  const old = fixture(); old.message.toolName = 'skill_prepare';
  assert.throws(() => verifyBoth(old), /notion_use/);
  for (const proof of verifyBoth(old, { historicalSkillPrepare: true })) assert.equal(proof.length, 2);
});

test('existing graph and session callers verify v2 projection against their independent source nodes', () => {
  const value = fixture(), before = JSON.stringify(value);
  for (const result of verifyBoth(value)) {
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(record => record.body_sha256), value.nodes.map(node => node.body_sha256));
  }
  assert.equal(JSON.stringify(value), before);
});

test('legacy v1 preparation remains valid but cannot carry a compiled projection', () => {
  const legacy = fixture({ version: 1 });
  for (const result of verifyBoth(legacy, { historicalSkillPrepare: true })) assert.equal(result.length, 2);
  const downgraded = fixture(); downgraded.message.details.contextBrokerPreparation.version = 1;
  assert.throws(() => verifyBoth(downgraded), /legacy version-one/);
  assert.throws(() => deliveryEvidence([downgraded.message], downgraded.nodes, 'stage'), /legacy version-one/);
});

test('unknown compiler and unsupported outer evidence versions are never treated as complete', () => {
  const compiler = fixture(); compiler.message.details.contextBrokerPreparation.projection.compiler = 'unreviewed/v99';
  assert.throws(() => verifyBoth(compiler), /Unknown preparation compiler/);
  assert.throws(() => deliveryEvidence([compiler.message], compiler.nodes, 'stage'), /Unknown preparation compiler/);
  const version = fixture(); version.message.details.contextBrokerPreparation.version = 99;
  assert.throws(() => verifyBoth(version), /Unknown preparation receipt version/);
  assert.throws(() => deliveryEvidence([version.message], version.nodes, 'stage'), /Unknown preparation receipt version/);
});

test('whole projection, encoded spans and exact source bytes have independent failure checks', () => {
  for (const mutate of [
    proof => { proof.projection.rendered.sha256 = '0'.repeat(64); },
    proof => { proof.projection.rendered.bytes++; },
    proof => { proof.projection.records[0].rendered.sha256 = '0'.repeat(64); },
    proof => { proof.projection.records[0].delivery.start++; },
    proof => { proof.projection.records[0].source.sha256 = '0'.repeat(64); },
  ]) {
    const value = fixture(); mutate(value.message.details.contextBrokerPreparation);
    assert.throws(() => verifySessionReceipts([value.message], value.nodes));
    assert.throws(() => deliveryEvidence([value.message], value.nodes, 'stage'));
  }
  const partial = fixture(), model = JSON.parse(partial.message.content[0].text);
  model.records[0].content = model.records[0].content.slice(0, -6);
  partial.message.content[0].text = JSON.stringify(model); rendered(partial.message);
  assert.throws(() => verifyBoth(partial), /Complete source body hash/);
  assert.throws(() => deliveryEvidence([partial.message], partial.nodes, 'stage'), /Complete source body hash/);
});

test('receipt ownership cannot be forged by a wrong tool, call ID, failed result or user message', () => {
  for (const mutate of [
    message => { message.toolName = 'read'; },
    message => { message.details.contextBrokerPreparation.toolCallId = 'different'; },
    message => { message.isError = true; },
  ]) {
    const value = fixture(); mutate(value.message);
    assert.throws(() => verifySessionReceipts([value.message], value.nodes));
    assert.throws(() => deliveryEvidence([value.message], value.nodes, 'stage'));
  }
  const user = fixture(); user.message.role = 'user';
  assert.throws(() => verifySessionReceipts([user.message], user.nodes), /actual tool result/);
  assert.deepEqual(deliveryEvidence([user.message], user.nodes, 'stage'), []);
});

test('equal record IDs and snapshot labels in different scopes stay independent', () => {
  const value = fixture({ sameIdentityAcrossScopes: true });
  for (const result of verifyBoth(value)) assert.deepEqual(result.map(record => record.scope), value.nodes.map(node => node.scope));
  const onlyFirst = structuredClone(value.message), model = JSON.parse(onlyFirst.content[0].text), group = onlyFirst.details.contextBrokerPreparation;
  model.records = model.records.slice(0, 1); model.roots = model.roots.slice(0, 1);
  group.records = group.records.slice(0, 1); group.graphs = group.graphs.slice(0, 1); group.projection.records = group.projection.records.slice(0, 1);
  onlyFirst.content[0].text = JSON.stringify(model); rendered(onlyFirst);
  assert.throws(() => verifySessionReceipts([onlyFirst], value.nodes), /Session needs a verified/);
  assert.equal(deliveryEvidence([onlyFirst], value.nodes, 'stage').length, 1);
});

test('a replaced record does not count as a new complete source delivery', () => {
  const value = fixture(), group = value.message.details.contextBrokerPreparation, model = JSON.parse(value.message.content[0].text);
  group.projection.derived = { reason: 'deduplicate', parentSha256: group.projection.rendered.sha256 };
  group.projection.records[0].state = 'replaced'; group.records[0].loaded = false;
  model.records[0].content = 'The verified body already exists in this provider context.';
  value.message.content[0].text = JSON.stringify(model); rendered(value.message);
  const remaining = [value.nodes[1]];
  assert.equal(verifySessionReceipts([value.message], remaining).length, 1);
  assert.equal(deliveryEvidence([value.message], remaining, 'stage').length, 1);
  assert.throws(() => verifySessionReceipts([value.message], value.nodes), /Session needs a verified/);
  group.records[0].loaded = true;
  assert.throws(() => deliveryEvidence([value.message], remaining, 'stage'), /replaced span/);
});

test('native version-three prefixes verify complete source bytes without including the directory footer', () => {
  const value = fixture(), node = value.nodes[0], source = value.message.details.contextBrokerPreparation.records[0];
  const proof = { ...source, version: 3, toolCallId: 'stage:1', delivery: { start: 0, end: node.body.length, encoding: 'raw' } };
  delete proof.loaded;
  const message = { role: 'toolResult', toolName: 'read', toolCallId: 'stage:1', isError: false,
    content: [{ type: 'text', text: node.body + '\n<skill-directory>fixed refs</skill-directory>' }], details: { contextBrokerRead: proof } };
  assert.equal(verifySessionReceipts([message], [node]).length, 1);
  assert.equal(deliveryEvidence([message], [node], 'stage').length, 1);
  proof.delivery.start = 1;
  assert.throws(() => verifySessionReceipts([message], [node]));
  assert.throws(() => deliveryEvidence([message], [node], 'stage'));
});
