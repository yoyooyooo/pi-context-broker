import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, writeFakeProvider } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { safeRequestMetrics } from './notion-default-context.mjs';
import { packageIdentity } from './notion-skill-graph-model.mjs';
import { verifyPreparationEvidence } from './skill-preparation-evidence.mjs';

const helper = fileURLToPath(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const rows = async path => { try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
const log = (path, value) => appendFile(path, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 });
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const text = content => typeof content === 'string' ? content : (content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
const unescapeXml = value => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
const testToken = 'controlled-ah577-graph-token';
const tools = ['read', 'notion_list', 'notion_use'];
const managementTools = [...tools, 'notion_ctl'];

export async function installedBrokerIdentity(entry, packagePath) {
  assert.ok(isAbsolute(packagePath ?? ''), 'The exact independently installed archive is required');
  return packageIdentity({ extension: entry, packagePath });
}

async function until(label, probe, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { const result = await probe(); if (result) return result; await pause(50); }
  throw new Error('Timed out waiting for ' + label);
}

async function childProcess(command, args, { cwd, env, ledger, category, passthrough = false, timeout = 120000 }) {
  const id = randomUUID(), child = spawn(command[0], [...command.slice(1), ...args], { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = [], signals = [];
  child.stdout.on('data', chunk => { stdout.push(chunk); if (passthrough) process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { stderr.push(chunk); if (passthrough) process.stderr.write(chunk); });
  let timedOut = false, escalation;
  const forward = signal => { const forwarded = child.kill(signal); signals.push(log(ledger, { event: 'signal', category, id, childPid: child.pid, signal, forwarded })); };
  const timer = setTimeout(() => { timedOut = true; forward('SIGTERM'); escalation = setTimeout(() => forward('SIGKILL'), 2000); }, timeout);
  const handlers = ['SIGTERM', 'SIGINT'].map(signal => [signal, () => forward(signal)]);
  for (const [signal, listener] of handlers) process.on(signal, listener);
  await log(ledger, { event: 'spawn', category, id, pid: process.pid, childPid: child.pid, command, args, cwd });
  try {
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    await Promise.all(signals);
    await log(ledger, { event: 'close', category, id, childPid: child.pid, ...result, timedOut, observedExit: true });
    return { id, ...result, timedOut, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
  } finally {
    clearTimeout(timer); clearTimeout(escalation);
    for (const [signal, listener] of handlers) process.removeListener(signal, listener);
  }
}

// A tracing process around the installed public CLI. It forwards every command
// unchanged apart from requesting metrics, and never supplies catalog/graph data.
async function publicCommand(state, args, passthrough = false) {
  assert.ok(['list', 'views', 'prepare', 'read', 'files', 'schema', 'ctl'].includes(args[0]));
  if (args[0] === 'ctl') assert.ok(args[1] === 'views' || args[1] === 'doctor' || args[1] === 'cache' && args[2] === 'identity');
  const measured = ['list', 'prepare', 'read', 'files'].includes(args[0]) && !args.includes('--metrics') ? [...args, '--metrics'] : args;
  assert.equal(hash(await readFile(state.cli)), state.cliSha256, 'The installed CLI changed after the run was frozen');
  const result = await childProcess([process.execPath, state.cli], measured, { cwd: state.cwd, env: state.env, ledger: state.ledger, category: 'installed-cli', passthrough });
  let response;
  try { response = JSON.parse(result.stdout); } catch { /* The raw failed output remains evidence. */ }
  const metrics = response?.request_metrics === undefined ? undefined : safeRequestMetrics(response.request_metrics);
  const receipt = { ...result, command: args[0], args: measured, response, metrics };
  await save(join(state.responses, result.id + '.json'), receipt);
  return receipt;
}

export function nextSessionTool(context, plan) {
  for (let index = 0; index < plan.steps.length; index++) {
    const id = plan.stage + ':' + index;
    const result = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === id);
    if (!result) return { type: 'toolCall', id, name: plan.steps[index].name, arguments: plan.steps[index].arguments };
    const expected = plan.expectedFailure?.index === index ? plan.expectedFailure : undefined;
    if (expected) {
      if (result.isError !== true || result.toolName !== expected.name || plan.steps[index].name !== expected.name)
        throw new Error('Expected tool failure did not occur: ' + id);
      const diagnostic = (typeof result.content === 'string' ? result.content
        : (result.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n')).trim().replace(/^Error: /u, '');
      const matches = expected.name === 'notion_use' && expected.code === 'CATALOG_INCOMPLETE'
        ? diagnostic === 'context-broker source operation failed (CATALOG_INCOMPLETE)'
        : expected.name === 'read' && expected.code === 'SNAPSHOT_MISSING' && /\(SNAPSHOT_MISSING\)/u.test(diagnostic);
      if (!matches || result.details?.contextBrokerPreparation !== undefined || result.details?.contextBrokerRead !== undefined)
        throw new Error('Unexpected failure or success receipt: ' + id);
    } else if (result.isError) throw new Error('Actual native tool failed: ' + id);
  }
  return null;
}

async function sessionProvider(directory) {
  const path = await writeFakeProvider(directory);
  let source = await readFile(path, 'utf8');
  source = source.replace('import { appendFileSync }', 'import { appendFileSync, readFileSync }');
  source = source.replace('function stream(model, context) {', nextSessionTool.toString() + '\nfunction stream(model, context) {');
  source = source.replace('  const output = {', "  const call = nextSessionTool(context, JSON.parse(readFileSync(process.env.BROKER_SESSION_PLAN, 'utf8')));\n  const output = {");
  source = source.replace('content: [{ type: "text", text: "OK" }]', 'content: call ? [call] : [{ type: "text", text: "OK" }]');
  source = source.replace('stopReason: "stop"', 'stopReason: call ? "toolUse" : "stop"');
  source = source.replace('for (const event of events) yield event;', "if (call) { yield {type:'start',partial:output}; yield {type:'toolcall_start',contentIndex:0,partial:output}; yield {type:'toolcall_end',contentIndex:0,toolCall:call,partial:output}; yield {type:'done',reason:'toolUse',message:output}; } else for (const event of events) yield event;");
  await writeFile(path, source, { mode: 0o600 });
  return path;
}

function visibleBodies(context) {
  return context.messages.filter(message => !['assistant', 'model'].includes(message.role)).flatMap(message => {
    const content = text(message.content);
    try { const value = JSON.parse(content); if (Array.isArray(value.records) && value.records.some(record => typeof record.content === 'string')) return value.records.flatMap(record => typeof record.content === 'string' ? [record.content] : []); } catch { /* Native delivery is text/XML. */ }
    return [unescapeXml(content)];
  });
}

export function bodyEvidence(context, all, expected, { management = false } = {}) {
  const visible = visibleBodies(context), selected = new Set(expected.map(node => node.binding.scope + '/' + node.id + '/' + node.binding.snapshot_id));
  const evidence = all.map(node => {
    const key = node.binding.scope + '/' + node.id + '/' + node.binding.snapshot_id;
    const copies = visible.reduce((sum, value) => sum + value.split(node.content).length - 1, 0);
    assert.equal(copies, selected.has(key) ? 1 : 0, `Provider complete body count differs for ${node.record.alias} ${node.binding.snapshot_id}`);
    return { id: node.id, scope: node.binding.scope, snapshot_id: node.binding.snapshot_id, version_id: node.binding.version_id, ref: node.binding.ref, bytes: node.bytes, body_sha256: node.body_sha256, copies };
  });
  const advertised = [...new Set([...(context.tools ?? []), ...context.messages.flatMap(message => message.toolsAdded ?? [])].map(tool => tool.name ?? tool.tool?.name).filter(Boolean))].sort();
  assert.deepEqual(advertised, [...(management ? managementTools : tools)].sort(), 'The actual controlled provider must expose only consumption tools until an explicit graph-management step');
  return { completeBodies: evidence, advertisedTools: advertised };
}

export function deliveryEvidence(messages, expected, stage, { historicalSkillPrepare = false } = {}) {
  const selected = new Map(expected.map(node => [node.binding.scope + '/' + node.id + '/' + node.binding.snapshot_id, node]));
  const found = [];
  for (const message of messages.filter(message => message.role === 'toolResult' && message.toolCallId?.startsWith(stage + ':'))) {
    assert.equal(message.isError === true, false, 'A claimed session pass cannot hide a failed native tool');
    const group = message.details?.contextBrokerPreparation;
    const proofs = group?.records ?? (message.details?.contextBrokerRead ? [message.details.contextBrokerRead] : []);
    const content = text(message.content);
    if (group !== undefined) {
      assert.equal(message.toolName, historicalSkillPrepare ? 'skill_prepare' : 'notion_use'); assert.equal(group.toolCallId, message.toolCallId);
      if (group.version === 2) verifyPreparationEvidence(content, group, message.toolCallId);
      else {
        assert.equal(group.version, 1, 'Unknown preparation receipt version');
        assert.equal(Object.hasOwn(group, 'projection'), false, 'A compiled receipt cannot enter the legacy version-one path');
      }
    }
    for (const proof of proofs) {
      if (proof.loaded === false) continue;
      assert.ok(proof.version === 2 || !group && proof.version === 3, 'Unknown complete-body receipt version');
      if (group) assert.equal(proof.loaded, true);
      else {
        assert.equal(message.toolName, 'read'); assert.equal(proof.toolCallId, message.toolCallId);
        if (proof.version === 3) { assert.equal(proof.delivery?.start, 0); assert.equal(proof.delivery?.encoding, 'raw'); }
        else assert.equal(proof.delivery, undefined, 'A version-two native read proves its entire result');
      }
      const identity = JSON.parse(proof.contentIdentity), node = selected.get(identity[0] + '/' + identity[1] + '/' + proof.snapshotId);
      assert.ok(node, 'A delivered source has an unexpected node/version identity');
      assert.equal(identity[0], node.binding.scope);
      assert.deepEqual(proof.binding, node.binding, 'Delivery must bind the exact public CLI observation');
      if (group) assert.ok(proof.delivery);
      if (proof.delivery) assert.ok(Number.isSafeInteger(proof.delivery.start) && Number.isSafeInteger(proof.delivery.end)
        && proof.delivery.start >= 0 && proof.delivery.end > proof.delivery.start && proof.delivery.end <= content.length
        && ['raw', 'xml', 'json'].includes(proof.delivery.encoding), 'Only an exact bounded source span proves delivery');
      // Native read proves its entire unmodified tool result. Explicit prepare
      // proves one escaped content span inside its public JSON result.
      const span = proof.delivery ? content.slice(proof.delivery.start, proof.delivery.end) : content;
      const body = proof.delivery?.encoding === 'json' ? JSON.parse('"' + span + '"') : proof.delivery?.encoding === 'xml' ? unescapeXml(span) : span;
      assert.equal(body, node.content); assert.equal(hash(body), proof.bodySha256); assert.equal(Buffer.byteLength(body), proof.bytes);
      found.push({ toolCallId: message.toolCallId, id: node.id, ref: proof.binding.ref, scope: identity[0], snapshot_id: proof.snapshotId, bytes: proof.bytes, body_sha256: proof.bodySha256, delivery: proof.delivery, bodyOrigin: group ? 'prepare-json-content-span' : 'native-read-full-tool-result' });
    }
  }
  return found;
}

export function graphEvidence(messages, expected, stage) {
  const result = messages.find(message => message.role === 'toolResult' && message.toolCallId === stage + ':graph');
  assert.ok(result && !result.isError && result.toolName === 'notion_ctl', 'The explicitly enabled notion_ctl graph export must complete');
  const graph = JSON.parse(text(result.content));
  assert.equal(graph.kind, 'selected_graph'); assert.equal(graph.version, 1);
  const actual = graph.scopes.flatMap(scope => scope.nodes.map(node => ({ ...node, scope: scope.scope })));
  assert.equal(actual.length, expected.length);
  for (const node of expected) {
    const selected = actual.find(item => item.binding.record.id === node.id);
    assert.ok(selected && selected.selected === true && selected.loaded === true, 'Selection and body delivery must both be proved by the public graph tool');
    assert.equal(selected.scope, node.binding.scope); assert.deepEqual(selected.binding, node.binding);
  }
  for (const scope of graph.scopes) for (const lock of scope.graph_locks) {
    const { sha256, ...value } = lock;
    assert.equal(hash(canonical(value)), sha256);
  }
  return graph;
}

export function unchangedSelection(before, after) {
  const selected = graph => graph.scopes.map(scope => ({ scope: scope.scope, graph_locks: scope.graph_locks,
    nodes: scope.nodes.map(node => ({ binding: node.binding, selected: node.selected, loaded: node.loaded })) }));
  assert.deepEqual(selected(after), selected(before), 'Failed refresh changed the original selected graph or delivery state');
  return hash(canonical(selected(after)));
}

export function fixedMainFailureTarget(selection, messages, ref, database) {
  assert.equal(selection.status, 'passed', 'A fixed-main exception needs the actual successful first selection');
  const delivered = selection.delivery.filter(item => item.ref === ref);
  assert.equal(delivered.length, 1);
  const scopes = selection.selectedGraph.scopes.filter(scope => scope.scope === delivered[0].scope);
  assert.equal(scopes.length, 1);
  const nodes = scopes[0].nodes.filter(node => node.selected && node.loaded && node.binding.ref === ref);
  assert.equal(nodes.length, 1);
  const binding = nodes[0].binding, record = binding.record;
  assert.equal(binding.scope, delivered[0].scope); assert.equal(record.id, delivered[0].id);
  assert.equal(binding.snapshot_id, delivered[0].snapshot_id); assert.equal(binding.body_sha256, delivered[0].body_sha256);
  assert.equal(record.locator.database_id, database);
  const locks = scopes[0].graph_locks.filter(lock => lock.roots.includes(record.id));
  assert.equal(locks.length, 1); const { sha256, ...vector } = locks[0];
  assert.equal(hash(canonical(vector)), sha256); assert.equal(vector.scope, binding.scope);
  assert.deepEqual(vector.bindings.filter(item => item.record.id === record.id), [binding]);
  const results = messages.filter(message => message.role === 'toolResult' && message.toolCallId === delivered[0].toolCallId);
  assert.equal(results.length, 1); const result = results[0], group = result.details?.contextBrokerPreparation;
  assert.equal(result.toolName, 'notion_use'); assert.equal(result.isError, false); assert.equal(group?.version, 2);
  verifyPreparationEvidence(text(result.content), group, result.toolCallId);
  const proofs = group.records.filter(proof => proof.binding?.ref === ref);
  assert.equal(proofs.length, 1); assert.equal(proofs[0].loaded, true); assert.deepEqual(proofs[0].binding, binding);
  const files = proofs[0].directory.files.filter(file => file.path === record.entrypoint);
  assert.equal(files.length, 1); assert.equal(files[0].ref, ref);
  assert.equal(files[0].sha256, delivered[0].body_sha256); assert.equal(files[0].bytes, delivered[0].bytes);
  const fixed = new URL(ref), current = new URL(record.ref);
  assert.equal(fixed.protocol, 'skill:'); assert.equal(current.protocol, 'skill:');
  assert.equal(decodeURIComponent(fixed.hostname), record.id); assert.equal(fixed.host, current.host);
  assert.equal(decodeURIComponent(fixed.pathname.slice(1)), record.entrypoint); assert.equal(fixed.pathname, current.pathname);
  assert.equal(current.search, ''); assert.equal(fixed.hash, ''); assert.equal(current.hash, '');
  assert.deepEqual([...fixed.searchParams.keys()].sort(), ['file_id', 'snapshot']);
  assert.equal(fixed.searchParams.get('snapshot'), binding.snapshot_id);
  const fileId = fixed.searchParams.get('file_id'); assert.ok(fileId);
  const target = record.ref + '?snapshot=' + binding.snapshot_id;
  fixed.searchParams.delete('file_id'); assert.equal(fixed.href, target, 'Only the proven main File ID may be omitted from a graph target');
  return { ref, target, owner: record.id, scope: binding.scope, snapshot: binding.snapshot_id, database, entrypoint: record.entrypoint, fileId };
}

export function failedSourceEvidence(receipts, expected) {
  assert.ok(receipts.length, 'A planned failure needs an actual installed CLI response');
  const failures = receipts.filter(receipt => receipt.code !== 0);
  assert.equal(failures.length, 1, 'Only the planned installed CLI failure is permitted');
  const failed = failures[0];
  assert.ok(Number.isInteger(failed.code) && failed.code !== 0 && !failed.signal && !failed.timedOut, 'A missing PID or timeout cannot prove the planned error');
  const sourceArgs = receipt => {
    assert.ok(Array.isArray(receipt.args) && receipt.args.every(value => typeof value === 'string')
      && receipt.args[0] === receipt.command, 'The source command must match its recorded argv');
    return receipt.args;
  };
  // The original source adapter passes read/files/prepare targets immediately
  // after the command; a matching database or other flag value is not a target.
  const fixedMain = expected.code === 'SNAPSHOT_MISSING' && failed.command === 'prepare' ? expected.fixedMain : undefined;
  if (fixedMain) {
    assert.equal(fixedMain.ref, expected.ref);
    assert.deepEqual(sourceArgs(failed), ['prepare', fixedMain.target, '--purpose', 'inspect', '--database', fixedMain.database, '--max-age', '0', '--metrics'], 'Only the one pinned-main inspect preparation is permitted');
  } else assert.ok(expected.commands.includes(failed.command) && sourceArgs(failed)[1] === expected.ref, 'The failed source must receive the exact requested reference');
  assert.equal(failed.response?.ok, false);
  assert.equal(failed.response.error?.code, expected.code);
  if (fixedMain) {
    const details = failed.response.error.details, preparation = details?.preparation;
    assert.equal(details?.snapshot_id, fixedMain.snapshot); assert.equal(preparation?.version, 1);
    assert.equal(preparation?.scope, fixedMain.scope); assert.equal(preparation?.purpose, 'inspect'); assert.equal(preparation?.status, 'failed');
    assert.deepEqual(preparation.roots, [{ target: fixedMain.target, readiness: 'not_ready' }]);
    assert.equal(preparation.nodes.length, 1); const node = preparation.nodes[0];
    assert.equal(node.id, fixedMain.owner); assert.equal(node.ref, fixedMain.target);
    assert.deepEqual(node.roles, ['root']); assert.equal(node.state, 'failed');
    assert.equal(node.error?.code, 'SNAPSHOT_MISSING'); assert.equal(node.error?.details?.snapshot_id, fixedMain.snapshot);
    assert.equal(node.content, undefined); assert.equal(node.binding, undefined); assert.equal(preparation.graph_lock, undefined);
    assert.equal(preparation.usage?.prepared_nodes, 0); assert.equal(preparation.usage?.instruction_bytes, 0);
    for (const field of ['observed_bindings', 'required', 'required_closure']) assert.deepEqual(preparation[field], []);
    assert.equal(preparation.errors.length, 1); const error = preparation.errors[0];
    assert.equal(error.target, fixedMain.target); assert.equal(error.code, 'SNAPSHOT_MISSING'); assert.equal(error.details?.snapshot_id, fixedMain.snapshot);
  }
  if (expected.dataSource) {
    assert.ok(failed.args.includes('--refresh'), 'Failed refresh must actually request a fresh observation');
    const coverage = failed.response.error.details;
    assert.equal(coverage?.method, 'explicit_database'); assert.equal(coverage?.exhaustive, false);
    assert.ok(Array.isArray(coverage?.failed_sources) && coverage.failed_sources.length === 1, 'Only the controlled Skills inventory may fail');
    const source = coverage.failed_sources[0];
    assert.equal(source.id, expected.dataSource.id); assert.equal(source.data_source_id, expected.dataSource.id);
    assert.equal(source.database_id, expected.dataSource.database); assert.equal(source.code, 'NOT_FOUND');
  }
  const measured = receipts.filter(receipt => ['list', 'prepare', 'read', 'files'].includes(receipt.command));
  assert.ok(measured.every(receipt => receipt.metrics?.complete), 'A planned error cannot hide source costs');
  for (const receipt of measured) assert.equal(receipt.metrics.total_requests, receipt.metrics.trace.filter(event => event.event === 'attempt').length, 'The complete failure ledger must retain every HTTP attempt');
  const attempts = measured.flatMap(receipt => receipt.metrics.trace.filter(event => event.event === 'attempt'));
  assert.ok(attempts.every(event => event.request_kind === 'notion_metadata'), 'A planned error cannot read a body or write the source');
  const failedAttempts = failed.metrics.trace.filter(event => event.event === 'attempt' && event.outcome === 'failure');
  if (expected.dataSource) {
    assert.equal(failedAttempts.length, 1, 'The refresh must contain exactly one failed inventory attempt');
    const attempt = failedAttempts[0];
    assert.equal(attempt.method, 'POST'); assert.equal(attempt.http_status, 404);
    assert.equal(attempt.target?.data_source_id, expected.dataSource.id);
  }
  if (expected.code === 'SNAPSHOT_MISSING') for (const receipt of receipts) {
    const args = sourceArgs(receipt);
    if (['read', 'files'].includes(receipt.command)) {
      assert.equal(args[1], expected.ref, 'Every source read/files must retain the original fixed reference');
    } else if (receipt === failed && fixedMain) {
      // The sole failed main inspection above keeps the exact original pin.
      // Scalar resources and every other preparation retain the no-fallback gate.
    } else {
      const metadata = ['list', 'views', 'schema'].includes(receipt.command)
        || receipt.command === 'ctl' && (args[1] === 'views' || args[1] === 'doctor' || args[1] === 'cache' && args[2] === 'identity');
      assert.ok(metadata, 'An unavailable fixed resource must not fall back to prepare/use/export or another content command');
    }
  }
  return { id: failed.id, command: failed.command, args: failed.args, code: failed.response.error.code,
    ...(expected.dataSource ? { failedSource: failed.response.error.details.failed_sources[0], failedAttempts } : {}),
    ...(fixedMain ? { fixedMain } : {}), exitCode: failed.code, httpAttempts: attempts.length, attempts };
}

export function sourceLedgerEvidence(receipts, requests, processes) {
  assert.equal(new Set(receipts.map(receipt => receipt.id)).size, receipts.length);
  const events = processes.filter(event => event.category === 'installed-cli'), unmeasured = [], attempts = [];
  assert.equal(events.filter(event => event.event === 'spawn').length, receipts.length);
  assert.equal(events.filter(event => event.event === 'close').length, receipts.length);
  for (const receipt of receipts) {
    const own = events.filter(event => event.id === receipt.id), starts = own.filter(event => event.event === 'spawn'), ends = own.filter(event => event.event === 'close');
    assert.equal(starts.length, 1); assert.equal(ends.length, 1);
    assert.deepEqual(starts[0].args, receipt.args); assert.equal(starts[0].childPid, ends[0].childPid);
    assert.equal(ends[0].observedExit, true); assert.equal(ends[0].code, receipt.code); assert.equal(ends[0].signal, receipt.signal);
    assert.equal(ends[0].timedOut, false); assert.equal(receipt.timedOut, false);
    if (receipt.metrics == null) {
      // This local identity operation was cancelled before reporting metrics.
      // Keep that gap visible; full server accounting below does not make this
      // subprocess successful or manufacture a per-invocation zero ledger.
      assert.equal(receipt.command, 'ctl'); assert.equal(receipt.args.length, 5);
      assert.deepEqual(receipt.args.slice(0, 4), ['ctl', 'cache', 'identity', '--database']);
      assert.ok(typeof receipt.args[4] === 'string' && receipt.args[4].length > 0);
      assert.equal(receipt.code, null); assert.equal(receipt.signal, 'SIGTERM');
      assert.equal(receipt.stdout, ''); assert.equal(receipt.stderr, ''); assert.equal(receipt.response, undefined);
      const signals = own.filter(event => event.event === 'signal'); assert.equal(signals.length, 1);
      assert.equal(signals[0].signal, 'SIGTERM'); assert.equal(signals[0].forwarded, true); assert.equal(signals[0].childPid, starts[0].childPid);
      assert.ok(Date.parse(starts[0].at) <= Date.parse(signals[0].at) && Date.parse(signals[0].at) <= Date.parse(ends[0].at));
      unmeasured.push({ id: receipt.id, args: receipt.args, code: receipt.code, signal: receipt.signal, metricsPresent: Object.hasOwn(receipt, 'metrics'), metrics: receipt.metrics ?? null });
    } else {
      assert.equal(receipt.metrics.complete, true); assert.ok(Number.isInteger(receipt.code)); assert.equal(receipt.signal, null);
      const trace = receipt.metrics.trace.filter(event => event.event === 'attempt');
      assert.equal(receipt.metrics.total_requests, trace.length); attempts.push(...trace);
    }
  }
  const signature = (method, status, requestBytes, responseBytes) => {
    assert.ok(typeof method === 'string' && Number.isInteger(status));
    assert.ok([requestBytes, responseBytes].every(value => Number.isSafeInteger(value) && value >= 0));
    return JSON.stringify([method, status, requestBytes, responseBytes]);
  };
  requests.forEach((request, index) => assert.equal(request.sequence, index + 1, 'The complete service journal must retain every request'));
  assert.deepEqual(attempts.map(event => signature(event.method, event.http_status, event.request_bytes, event.response_bytes)).sort(),
    requests.map(request => signature(request.method, request.status, request.request_bytes, request.response_bytes)).sort(), 'Completed CLI traces must account for the full service HTTP multiset');
  return { serverHttpFullyCovered: true, allInvocationMetricsPresent: unmeasured.length === 0, unmeasured,
    invocations: receipts.length, completedMetrics: receipts.length - unmeasured.length, httpAttempts: requests.length,
    requestBytes: requests.reduce((sum, request) => sum + request.request_bytes, 0), responseBytes: requests.reduce((sum, request) => sum + request.response_bytes, 0),
    comparison: 'One-to-one multiset of method, HTTP status, request bytes and response bytes; cancelled local identity metrics remain unobserved.' };
}

async function oracle(state, info, revision) {
  const listed = await publicCommand(state, ['list', '--database', info.database, '--view', info.view]);
  assert.equal(listed.code, 0, listed.stdout + listed.stderr); assert.equal(listed.response.count, 1);
  assert.equal(listed.response.records[0].id, info.logical_ids.root);
  const all = await publicCommand(state, ['list', '--database', info.database]);
  assert.equal(all.code, 0, all.stdout + all.stderr); assert.equal(all.response.records.length, 3);
  const roots = ['root', 'optional'].map(role => all.response.records.find(record => record.id === info.logical_ids[role])?.ref);
  assert.ok(roots.every(Boolean));
  const prepared = await publicCommand(state, ['prepare', ...roots, '--purpose', 'use', '--refresh']);
  assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr); assert.equal(prepared.response.status, 'ready');
  const nodes = prepared.response.nodes.filter(node => node.state === 'prepared');
  assert.equal(nodes.length, 3);
  for (const node of nodes) {
    const read = await publicCommand(state, ['read', node.binding.ref]);
    assert.equal(read.code, 0, read.stdout + read.stderr);
    assert.equal(read.response.record.id, node.id); assert.equal(read.response.scope, node.binding.scope);
    assert.equal(read.response.snapshot_id, node.binding.snapshot_id); assert.equal(read.response.content, node.content);
    assert.equal(hash(node.content), node.body_sha256); assert.equal(Buffer.byteLength(node.content), node.bytes);
    assert.ok(node.content.includes('AH577_' + Object.entries(info.logical_ids).find(([, id]) => id === node.id)[0].toUpperCase() + '_' + revision));
  }
  return { revision, roots, nodes, rootOnlyCatalogRequestId: listed.id, preparationRequestId: prepared.id, prepared: prepared.response };
}

export async function runGraphSession(options) {
  for (const key of ['extension', 'package-path', 'cli-entry', 'cli-source', 'evidence-root']) assert.ok(isAbsolute(options[key] ?? ''), '--' + key + ' must be absolute');
  await mkdir(options['evidence-root'], { recursive: true });
  const evidence = await mkdtemp(join(options['evidence-root'], 'graph-session-'));
  const scratch = await mkdtemp(join(await realpath(tmpdir()), 'graph-session-'));
  await save(join(scratch, 'ownership.json'), { evidence });
  const serviceScript = join(dirname(helper), 'notion-skill-graph-service.mjs');
  const processLedger = join(evidence, 'processes.jsonl'), probe = join(evidence, 'official-ntn-probe.jsonl');
  await Promise.all([writeFile(processLedger, ''), writeFile(probe, '')]);
  const manifest = { version: 1, sourceMode: 'command', toolContract: 'agent-cli-ref-20261105', status: 'running', evidence, scratch, extension: options.extension, extensionSha256: hash(await readFile(options.extension)), cli: options['cli-entry'], cliSha256: hash(await readFile(options['cli-entry'])), harnessSha256: hash(await readFile(helper)), cases: [], boundary: 'Actual installed Pi RPC and explicit custom-command CLI comparison with Node/SQLite; controlled HTTPS Notion service and controlled provider. No cache/session/Store setters. No default SDK, real-model or production-Notion claim.', notRun: ['fork/rewind/compaction matrix (covered by the separate actual SessionManager suite)', 'TUI Stop (covered by the separate native terminal runner)'] };
  manifest.controlledServiceScript = { path: serviceScript, sha256: hash(await readFile(serviceScript)), cliFixtureSource: options['cli-source'] };
  manifest.installedBroker = await installedBrokerIdentity(options.extension, options['package-path']);
  await save(join(evidence, 'manifest.json'), manifest);
  console.log(JSON.stringify({ evidence, scratch, status: 'running' }));
  const poison = join(scratch, 'no-official-ntn'); await mkdir(poison);
  await writeFile(join(poison, 'ntn'), '#!' + process.execPath + '\nrequire("node:fs").appendFileSync(' + JSON.stringify(probe) + ',JSON.stringify({at:new Date().toISOString(),pid:process.pid,argc:process.argv.length-2})+"\\n");process.exit(97);\n', { mode: 0o700 });
  await chmod(join(poison, 'ntn'), 0o700);
  const control = join(scratch, 'service-control.json');
  let sourceRevision = 'A';
  const setControl = async (revision, failRefreshRoot = false) => {
    const value = { revision, fail_refresh_root: failRefreshRoot }, temporary = control + '.next';
    await save(temporary, value); await rename(temporary, control);
    sourceRevision = revision;
    await log(join(evidence, 'service-control.jsonl'), value);
  };
  await setControl('A');
  const serviceOutput = join(evidence, 'service'); await mkdir(serviceOutput);
  const serviceEnv = isolatedEnv({ base: join(scratch, 'service-home'), agentDir: join(scratch, 'unused-service-agent'), NOTION_API_TOKEN: testToken, PATH: poison + ':' + process.env.PATH });
  const service = spawn(options.bun ?? 'bun', [serviceScript, '--output', serviceOutput, '--control', control, '--cli-repo', options['cli-source']], { cwd: dirname(dirname(helper)), env: serviceEnv, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const serviceStdout = [], serviceStderr = [];
  service.stdout.on('data', chunk => serviceStdout.push(chunk)); service.stderr.on('data', chunk => serviceStderr.push(chunk));
  const serviceExit = new Promise((resolve, reject) => { service.once('error', reject); service.once('close', (code, signal) => resolve({ code, signal })); });
  await log(processLedger, { event: 'spawn', category: 'controlled-service', childPid: service.pid });
  let active;
  const stopHost = async () => {
    if (!active) return;
    const old = active; active = undefined;
    await old.rpc.closeInput();
    await save(join(evidence, old.name + '-rpc.json'), old.rpc.frames);
    if (old.state.sessionFile) {
      const bytes = await readFile(old.state.sessionFile), retained = join(evidence, old.name + '-session.jsonl');
      await writeFile(retained, bytes, { flag: 'wx', mode: 0o600 });
      (manifest.sessions ??= []).push({ source: old.state.sessionFile, retained, sha256: hash(bytes), bytes: bytes.length });
    }
  };
  try {
    const info = await until('controlled HTTPS service', async () => { if (service.exitCode !== null) throw new Error('Service exited: ' + Buffer.concat(serviceStderr)); try { return await json(join(serviceOutput, 'server-info.json')); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } });
    assert.match(info.origin, /^https:\/\/127\.0\.0\.1:\d+$/); assert.equal(info.token, testToken); assert.equal(info.no_consumer_cache_seed, true);
    const stateFor = async name => {
      const cwd = join(scratch, name), responses = join(evidence, name + '-responses'); await mkdir(cwd); await mkdir(responses);
      const env = isolatedEnv({ base: cwd, agentDir: join(cwd, 'agent'), NOTION_API_TOKEN: testToken, NOTION_API_BASE_URL: info.origin, NODE_EXTRA_CA_CERTS: info.cert, NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000', PATH: poison + ':' + process.env.PATH });
      const state = { cwd, responses, env, ledger: processLedger, cli: options['cli-entry'], cliSha256: manifest.cliSha256 };
      await save(join(cwd, 'source-state.json'), state);
      return state;
    };
    const oracleAState = await stateFor('oracle-a');
    let consumer = await stateFor('consumer');
    const consumerStates = [consumer];
    const a = await oracle(oracleAState, info, 'A'); await save(join(evidence, 'oracle-a.json'), a);
    const byRole = (observation, role) => observation.nodes.find(node => node.id === info.logical_ids[role]);
    const currentRef = role => byRole(a, role).record.ref;
    const base = join(scratch, 'host'); await mkdir(base);
    const cache = join(base, 'broker-cache'); await mkdir(cache);
    const sessions = join(base, 'sessions'); await mkdir(sessions);
    const provider = await sessionProvider(base), plan = join(base, 'plan.json'), config = join(base, 'broker.json');
    await save(plan, { stage: 'initial', steps: [] });
    const sourceConfig = (state, cacheDir) => ({ sources: [{ type: 'notion', id: 'notion', namespace: 'notion', command: [process.execPath, helper, '--source', join(state.cwd, 'source-state.json')], database: info.database, default_view_id: info.view, cacheDir, prefetch: false, activation: { maxAge: '0' }, discovery: { maxAge: '0' }, requestTimeoutMs: 30000 }] });
    await save(config, sourceConfig(consumer, cache));
    const guard = join(base, 'tools.mjs');
    await writeFile(guard, 'import { readFileSync } from "node:fs"; export default api=>{const tools=' + JSON.stringify(tools) + ',management=' + JSON.stringify(managementTools) + ',plan=' + JSON.stringify(plan) + ';let active=tools;const set=value=>{active=value;api.setActiveTools?.(value);};api.on("session_start",()=>set(tools));api.on("before_agent_start",()=>{const value=JSON.parse(readFileSync(plan,"utf8"));set(value.steps[0]?.name==="notion_ctl"?management:tools);});api.on("tool_result",event=>{const value=JSON.parse(readFileSync(plan,"utf8")),expected=value.expectedFailure;if((!event.isError||expected?.index===value.steps.length-2&&expected.name===event.toolName)&&event.toolCallId===value.stage+":"+(value.steps.length-2))set(management);});api.on("tool_call",e=>active.includes(e.toolName)?undefined:{block:true,reason:"Controlled session enables graph management only for its explicit audit step"});};\n');
    const boot = async (name, session, isolated = {}) => {
      await stopHost();
      assert.deepEqual(await installedBrokerIdentity(options.extension, options['package-path']), manifest.installedBroker, 'Installed runtime changed during the session acceptance');
      const capture = join(evidence, name + '-provider.jsonl'); await writeFile(capture, '');
      const hostBase = isolated.base ?? base, hostConfig = isolated.config ?? config, hostSessions = isolated.sessions ?? sessions;
      const agentDir = join(hostBase, name + '-agent'); await mkdir(agentDir);
      const env = isolatedEnv({ base: hostBase, agentDir, CONTEXT_BROKER_CONFIG: hostConfig, CONTEXT_BROKER_HOST: 'pi', CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: capture, CONTEXT_BROKER_LOG_FILE: join(evidence, name + '-decisions.jsonl'), BROKER_SESSION_PLAN: plan, BROKER_E2E_PROCESS_LEDGER: processLedger, PATH: poison + ':' + process.env.PATH });
      // Pi filters registration through --tools. Keep management registered,
      // while the guard exposes it only at the explicit graph-audit step.
      const args = ['--no-extensions', '--no-skills', '--no-mcp', '--no-context-files', '--no-prompt-templates', '--session-dir', hostSessions, '--tools', managementTools.join(','), '-e', provider, '-e', options.extension, '-e', guard, '--model', 'context-broker-e2e/fake', ...(session ? ['--session', session] : [])];
      const rpc = await startRpc({ host: 'pi', cwd: hostBase, env, args, timeoutMs: 120000 });
      active = { name, rpc, capture, state: await rpc.command('get_state') };
      return active;
    };
    let allNodes = a.nodes;
    const stage = async (name, steps, expected, delivered, failureCase) => {
      // The final graph call uses a stable suffix so its complete native output
      // can be located independently of any preceding tool count.
      const actualSteps = [...steps, { name: 'notion_ctl', arguments: {} }];
      const stagePlan = { stage: name, steps: actualSteps, ...(failureCase ? { expectedFailure: failureCase.expectedFailure } : {}) };
      await save(plan, stagePlan);
      await save(join(evidence, name + '-plan.json'), stagePlan);
      const before = (await rows(active.capture)).length, frameStart = active.rpc.frames.length;
      const priorResponses = new Set(await readdir(consumer.responses));
      const serviceBefore = (await rows(info.ledger)).length;
      const observation = { name, status: 'running', session: active.state.sessionFile, steps };
      manifest.cases.push(observation); await save(join(evidence, 'manifest.json'), manifest);
      try {
        await active.rpc.prompt('Run the controlled public selection stage ' + name + '.');
        const captures = (await rows(active.capture)).slice(before); assert.ok(captures.length >= actualSteps.length + 1);
        if (name === 'cold-root-required-a') bodyEvidence(captures[0].context, allNodes, []);
        const messages = (await active.rpc.command('get_messages')).messages;
        assert.equal(nextSessionTool({ messages }, stagePlan), null, 'The planned public tool sequence must be complete');
        const graphCall = messages.find(message => message.role === 'toolResult' && message.toolCallId === name + ':' + steps.length);
        assert.ok(graphCall); const graphMessages = messages.map(message => message === graphCall ? { ...message, toolCallId: name + ':graph' } : message);
        const body = bodyEvidence(captures.at(-1).context, allNodes, expected, { management: true });
        const failureId = failureCase ? name + ':' + failureCase.expectedFailure.index : undefined;
        const receipts = deliveryEvidence(failureCase ? messages.filter(message => message.toolCallId !== failureId) : messages, expected, name);
        for (const node of delivered) assert.ok(receipts.some(receipt => receipt.id === node.id && receipt.snapshot_id === node.binding.snapshot_id), 'The requested node needs an actual complete native delivery receipt');
        const selectedGraph = graphEvidence(graphMessages, expected, name);
        if (failureCase?.selectionBefore) observation.unchangedSelectionSha256 = unchangedSelection(failureCase.selectionBefore, selectedGraph);
        const sourceResponses = await Promise.all((await readdir(consumer.responses)).filter(file => !priorResponses.has(file)).map(file => json(join(consumer.responses, file))));
        const measured = sourceResponses.filter(item => ['list', 'prepare', 'read', 'files'].includes(item.command));
        assert.ok(measured.every(item => item.metrics?.complete), 'Stage HTTP attribution must be complete');
        const attempts = measured.flatMap(item => item.metrics.trace.filter(event => event.event === 'attempt'));
        if (failureCase) {
          assert.equal(receipts.length, 0, 'A failed operation cannot earn a complete native delivery receipt');
          observation.expectedFailure = { ...failureCase.expectedFailure,
            native: messages.find(message => message.role === 'toolResult' && message.toolCallId === failureId),
            source: failedSourceEvidence(sourceResponses, failureCase.source) };
          const serviceRequests = (await rows(info.ledger)).slice(serviceBefore);
          observation.expectedFailure.serviceRequests = serviceRequests;
          if (failureCase.source.dataSource) {
            const faults = serviceRequests.filter(request => request.fault === 'refresh-skill-inventory-unavailable');
            assert.ok(faults.length, 'The real refresh must reach the controlled inventory fault');
            const failedAttempts = observation.expectedFailure.source.failedAttempts;
            assert.equal(faults.length, failedAttempts.length);
            assert.ok(faults.every(request => request.status === 404 && request.method === 'POST'
              && request.path.split('?')[0] === 'v1/data_sources/' + failureCase.source.dataSource.id + '/query'));
            assert.ok(faults.every((request, index) => request.request_bytes === failedAttempts[index].request_bytes
              && request.response_bytes === failedAttempts[index].response_bytes), 'The actual CLI attempt must match the injected response');
          }
        }
        if (!expected.some(node => node.id === info.logical_ids.optional)) assert.equal(attempts.filter(event => event.request_kind === 'notion_body' && event.target?.page_id === info.pages.optional).length, 0, 'An unselected Member cannot cause a native body request');
        Object.assign(observation, { status: 'passed', providerRequests: captures.length, ...body, delivery: receipts, selectedGraph, source: { processes: sourceResponses.length, responseIds: sourceResponses.map(item => item.id), attempts } });
        active.state = await active.rpc.command('get_state'); observation.session = active.state.sessionFile;
        assert.ok(observation.session, 'The actual host must report a persisted session');
        await save(join(evidence, name + '-messages.json'), messages);
      } catch (error) { Object.assign(observation, { status: 'failed', error: error.message }); throw error; }
      finally { await save(join(evidence, name + '-rpc.json'), active.rpc.frames.slice(frameStart)); await save(join(evidence, name + '-result.json'), observation); await save(join(evidence, 'manifest.json'), manifest); }
      console.log(JSON.stringify({ stage: name, status: observation.status, providerRequests: observation.providerRequests }));
      return observation;
    };
    const prepare = (roots, refresh = false) => ({ name: 'notion_use', arguments: { ref: roots, ...(refresh ? { refresh: true } : {}) } });
    const aRequired = ['root', 'required'].map(role => byRole(a, role));
    assert.equal((await readdir(consumer.cwd)).length, 1, 'Consumer starts with only its command descriptor; no CLI cache/config was seeded');
    assert.equal((await readdir(cache)).length, 0); assert.equal((await readdir(sessions)).length, 0);
    manifest.coldRoots = { consumer: consumer.cwd, broker: cache, sessions, oracle: oracleAState.cwd, cacheSeeded: false }; await save(join(evidence, 'manifest.json'), manifest);
    await boot('original');
    const firstSelection = await stage('cold-root-required-a', [prepare([currentRef('root')])], aRequired, aRequired);
    const originalSession = active.state.sessionFile;
    await setControl('B');
    const oracleBState = await stateFor('oracle-b'), b = await oracle(oracleBState, info, 'B'); await save(join(evidence, 'oracle-b.json'), b);
    allNodes = [...a.nodes, ...b.nodes];
    for (const node of a.nodes) assert.notEqual(node.binding.snapshot_id, b.nodes.find(other => other.id === node.id).binding.snapshot_id, 'Each node must have an observed A/B revision');
    await stage('old-session-keeps-a', [prepare([currentRef('root')])], aRequired, aRequired);
    await boot('new-session');
    const bRequired = ['root', 'required'].map(role => byRole(b, role));
    await stage('new-session-observes-b', [prepare([currentRef('root')])], bRequired, bRequired);
    await boot('resumed-original', originalSession);
    const resumedA = await stage('resumed-original-keeps-a', [prepare([currentRef('root')])], aRequired, aRequired);
    const beforeFailedRefresh = await readFile(originalSession);
    await writeFile(join(evidence, 'failed-refresh-history-before.jsonl'), beforeFailedRefresh);
    await setControl('B', true);
    try {
      await stage('failed-refresh-keeps-a', [prepare([currentRef('root')], true)], aRequired, [], {
        expectedFailure: { index: 0, name: 'notion_use', code: 'CATALOG_INCOMPLETE' },
        selectionBefore: resumedA.selectedGraph,
        source: { commands: ['prepare'], ref: currentRef('root'), code: 'CATALOG_INCOMPLETE', dataSource: { id: info.data_source_id, database: info.database } },
      });
      const afterFailedRefresh = await readFile(originalSession);
      assert.deepEqual(afterFailedRefresh.subarray(0, beforeFailedRefresh.length), beforeFailedRefresh, 'Failed refresh rewrote original native history');
      const appended = afterFailedRefresh.subarray(beforeFailedRefresh.length).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
      for (const entry of appended.filter(entry => entry.type === 'custom' && entry.customType === 'context-broker-active-sources')) {
        for (const source of entry.data.sources) assert.ok(aRequired.some(node => node.binding.scope === source.record.sourceScope
          && node.id === source.record.id && node.binding.snapshot_id === source.snapshotId && node.body_sha256 === source.bodySha256), 'Failed refresh activated another source version');
      }
      await writeFile(join(evidence, 'failed-refresh-history-after.jsonl'), afterFailedRefresh);
      await save(join(evidence, 'failed-refresh-history-proof.json'), { beforeSha256: hash(beforeFailedRefresh), afterSha256: hash(afterFailedRefresh),
        originalPrefixBytes: beforeFailedRefresh.length, originalPrefixUnchanged: true, appendedEntries: appended.length, activeVersions: aRequired.map(node => node.binding) });
    } finally { await setControl('B'); }
    const mixed = [...aRequired, byRole(b, 'optional')];
    await stage('first-optional-selects-b', [{ name: 'read', arguments: { path: currentRef('optional') } }], mixed, [byRole(b, 'optional')]);
    await stage('explicit-refresh-selects-all-b', [prepare([currentRef('root'), currentRef('optional')], true)], b.nodes, b.nodes);
    const refreshedSession = active.state.sessionFile;
    const history = (await rows(refreshedSession)).flatMap(entry => entry.type === 'message' && entry.message ? [entry.message] : []);
    const historicBodies = visibleBodies({ messages: history });
    for (const node of aRequired) assert.ok(historicBodies.some(content => content.includes(node.content)), 'Refresh must retain original A source history');
    await boot('resumed-refreshed', refreshedSession);
    await stage('resumed-refresh-keeps-b', [], b.nodes, []);
    await stopHost();
    const fixedA = firstSelection.delivery.find(receipt => receipt.id === info.logical_ids.root);
    assert.ok(fixedA && new URL(fixedA.ref).searchParams.get('snapshot') === fixedA.snapshot_id);
    const fixedMain = fixedMainFailureTarget(firstSelection, await json(join(evidence, 'cold-root-required-a-messages.json')), fixedA.ref, info.database);
    const fixedCheckState = await stateFor('unavailable-fixed-cli');
    const fixedCheck = await publicCommand(fixedCheckState, ['read', fixedA.ref]);
    manifest.fixedCliCheck = failedSourceEvidence([fixedCheck], { commands: ['read'], ref: fixedA.ref, code: 'SNAPSHOT_MISSING' });
    consumer = await stateFor('unavailable-fixed-consumer'); consumerStates.push(consumer);
    const missingBase = join(scratch, 'unavailable-fixed-host'), missingCache = join(missingBase, 'broker-cache'), missingSessions = join(missingBase, 'sessions');
    await mkdir(missingBase); await mkdir(missingCache); await mkdir(missingSessions);
    const missingConfig = join(missingBase, 'broker.json');
    await save(missingConfig, sourceConfig(consumer, missingCache));
    assert.equal((await readdir(consumer.cwd)).length, 1, 'The fixed reader starts with only its command descriptor');
    assert.equal((await readdir(missingCache)).length, 0); assert.equal((await readdir(missingSessions)).length, 0);
    manifest.fixedUnavailable = { ref: fixedA.ref, from: { stage: firstSelection.name, toolCallId: fixedA.toolCallId, scope: fixedA.scope, snapshot_id: fixedA.snapshot_id },
      consumer: consumer.cwd, broker: missingCache, sessions: missingSessions, cacheSeeded: false, sourceRevision: 'B' };
    await save(join(evidence, 'unavailable-fixed-input.json'), manifest.fixedUnavailable);
    await boot('unavailable-fixed', undefined, { base: missingBase, config: missingConfig, sessions: missingSessions });
    await stage('unavailable-fixed-rejects-current', [{ name: 'read', arguments: { path: fixedA.ref } }], [], [], {
      expectedFailure: { index: 0, name: 'read', code: 'SNAPSHOT_MISSING' },
      source: { commands: ['files', 'read'], ref: fixedA.ref, code: 'SNAPSHOT_MISSING', fixedMain },
    });
    const missingHistory = await rows(active.state.sessionFile);
    assert.equal(missingHistory.filter(entry => entry.type === 'custom' && ['context-broker-active-sources', 'context-broker-selected-graph'].includes(entry.customType)).length, 0, 'An unavailable fixed read cannot persist an active or selected graph');
    await stopHost();
    const receipts = (await Promise.all(consumerStates.map(async state => Promise.all((await readdir(state.responses)).filter(name => name.endsWith('.json')).map(name => json(join(state.responses, name))))))).flat();
    const measured = receipts.filter(receipt => ['list', 'prepare', 'read', 'files'].includes(receipt.command));
    assert.ok(measured.length && measured.every(receipt => receipt.metrics?.complete), 'Every source operation must retain a complete actual HTTP attempt ledger');
    assert.equal((await rows(probe)).length, 0, 'The official ntn trap must never run');
    manifest.source = { processes: receipts.length, measuredOperations: measured.length, httpAttempts: measured.reduce((sum, receipt) => sum + receipt.metrics.total_requests, 0), responses: consumerStates.map(state => state.responses), noOfficialNtnCalls: true,
      excludes: 'Independent A/B source oracles and the separately reported fixed CLI comparison; controlledService records every server request.' };
    manifest.status = 'passed';
  } catch (error) { manifest.status = 'failed'; manifest.error = error.message; process.exitCode = 1; }
  finally {
    if (active) await stopHost().catch(error => { manifest.shutdownError = error.message; manifest.status = 'failed'; process.exitCode = 1; });
    await setControl(sourceRevision).catch(error => { manifest.controlResetError = error.message; manifest.status = 'failed'; process.exitCode = 1; });
    if (service.exitCode === null && service.signalCode === null) service.kill('SIGTERM');
    const stopped = await Promise.race([serviceExit, pause(10000).then(() => { if (service.exitCode === null && service.signalCode === null) service.kill('SIGKILL'); return serviceExit; })]);
    await log(processLedger, { event: 'close', category: 'controlled-service', childPid: service.pid, ...stopped, observedExit: true });
    await writeFile(join(serviceOutput, 'stdout.log'), Buffer.concat(serviceStdout)); await writeFile(join(serviceOutput, 'stderr.log'), Buffer.concat(serviceStderr));
    const requests = await rows(join(serviceOutput, 'http.jsonl'));
    manifest.controlledService = { requests: requests.length, requestBytes: requests.reduce((sum, request) => sum + request.request_bytes, 0),
      responseBytes: requests.reduce((sum, request) => sum + request.response_bytes, 0), injectedFaults: requests.filter(request => request.fault).length,
      includes: 'Both private A/B oracles, every actual Pi consumer, and the independent public CLI fixed-reference check.' };
    try {
      const directories = (await readdir(evidence, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('-responses'));
      const receipts = (await Promise.all(directories.map(async directory => Promise.all((await readdir(join(evidence, directory.name)))
        .filter(name => name.endsWith('.json')).map(name => json(join(evidence, directory.name, name))))))).flat();
      manifest.sourceAccounting = sourceLedgerEvidence(receipts, requests, await rows(processLedger));
    } catch (error) { manifest.status = 'failed'; manifest.sourceAccountingError = error.message; process.exitCode = 1; }
    if (stopped.code !== 0 || stopped.signal !== null) {
      manifest.status = 'failed'; manifest.serviceShutdownError = 'The controlled service did not close with exit code zero'; process.exitCode = 1;
    } else {
      try {
        const finalControl = await json(join(serviceOutput, 'stopped.json'));
        assert.equal(finalControl.fail_refresh_root, false, 'The controlled fault must be disabled before cleanup');
        manifest.controlledService.finalControl = finalControl;
      } catch (error) { manifest.status = 'failed'; manifest.serviceShutdownError = error.message; process.exitCode = 1; }
    }
    manifest.serviceExit = stopped; manifest.finishedAt = new Date().toISOString(); await save(join(evidence, 'manifest.json'), manifest);
  }
  console.log(JSON.stringify({ evidence, status: manifest.status, cases: manifest.cases.map(({ name, status }) => ({ name, status })), error: manifest.error?.slice(0, 600) }));
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === '--source') {
    const state = await json(process.argv[3]);
    const result = await publicCommand(state, process.argv.slice(4), true);
    process.exitCode = result.code ?? 1;
  } else {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const flag = process.argv[index], value = process.argv[index + 1];
      assert.ok(['--extension', '--package-path', '--cli-entry', '--cli-source', '--evidence-root', '--bun'].includes(flag) && value && !value.startsWith('--'));
      assert.equal(options[flag.slice(2)], undefined); options[flag.slice(2)] = value;
    }
    await runGraphSession(options);
  }
}
