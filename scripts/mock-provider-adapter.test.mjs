import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { writeFakeProvider } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { isolatedEnv, resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import {
  assertLoopbackBaseUrl, contextFromCompletionRequest, createInProcessStream, createMockControl, renderHttpWrapper,
  renderInProcessWrapper, startLoopbackMock,
} from './mock-provider-adapter.mjs';
import { selectProviderCall, resolveInstalledPiSerializer } from './notion-sdk-pi.mjs';
import { systemTempRoot } from './verification-paths.mjs';

const mainRef = 'sr:S' + 'a'.repeat(22);
const resourceRef = 'sr:R' + 'b'.repeat(22);
const plan = { mode: 'native-repeat', owner: 'resources', resource_path: 'references/guide.md' };
const selectCall = context => selectProviderCall(context, plan);

function listText() {
  return JSON.stringify({ records: [{ name: 'resources', source: 'sdk-fixture', availability: 'available', ref: mainRef }] });
}
function mainText() {
  return 'MAIN\n<skill-directory>\n' + JSON.stringify({ ref: mainRef, directory: { files: [{ path: 'references/guide.md', ref: resourceRef }] } }) + '\n</skill-directory>';
}

test('loopback base URL rejects anything except 127.0.0.1 with a /v1 path', () => {
  assert.equal(assertLoopbackBaseUrl('http://127.0.0.1:9/v1').hostname, '127.0.0.1');
  for (const value of ['http://localhost:9/v1', 'http://127.0.0.1/v1', 'https://127.0.0.1:9/v1', 'http://8.8.8.8:9/v1', 'http://127.0.0.1:9/v1/extra'])
    assert.throws(() => assertLoopbackBaseUrl(value), /MOCK_PROVIDER_LOOPBACK_REQUIRED/);
});

test('completion reconstruction keeps tool ids and does not invent isError or missing tool names', () => {
  const context = contextFromCompletionRequest({
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    messages: [
      { role: 'user', content: 'inspect' },
      { role: 'assistant', tool_calls: [{ id: 'sc10-search', type: 'function', function: { name: 'notion_list', arguments: '{"query":""}' } }] },
      { role: 'tool', tool_call_id: 'sc10-search', content: listText() },
    ],
  });
  assert.equal(context.messages.at(-2).role, 'toolResult');
  assert.equal(context.messages.at(-2).toolName, 'notion_list');
  assert.equal(Object.hasOwn(context.messages.at(-2), 'isError'), false);
  assert.equal(context.messages.at(-1).toolsAdded[0].name, 'read');
  assert.deepEqual(selectCall(context).arguments, { path: mainRef });
});

test('in-process stream reports hooks, captures the replaced context, and emits one tool call', async () => {
  const root = await mkdtemp(join(await systemTempRoot(), 'mock-provider-stream-'));
  const capture = join(root, 'provider.jsonl');
  const previous = process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE;
  process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE = capture;
  const phases = [];
  const replacement = { messages: [{ role: 'user', content: 'replaced' }] };
  try {
    const stream = createInProcessStream({
      model: { id: 'fake', api: 'context-broker-e2e-api', provider: 'context-broker-e2e' },
      context: { messages: [] },
      requestId: '42:1',
      selectCall: () => ({ type: 'toolCall', id: 'sc10-search', name: 'notion_list', arguments: { query: '' } }),
      observe: event => phases.push(event.phase),
      options: {
        async onPayload(payload) { assert.equal(payload.model, 'fake'); return { context: replacement }; },
        async onResponse(response) { assert.equal(response.status, 200); },
      },
    });
    const events = [];
    for await (const event of stream) events.push(event.type);
    assert.deepEqual(events, ['start', 'toolcall_start', 'toolcall_end', 'done']);
    assert.deepEqual(phases, ['payload_start', 'payload_end', 'response_end']);
    const saved = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(saved.requestId, '42:1');
    assert.deepEqual(saved.context, replacement);
    assert.equal(await stream.result().then(message => message.stopReason), 'toolUse');
  } finally {
    if (previous === undefined) delete process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE;
    else process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE = previous;
  }
});

test('in-process stream requires the public provider hooks', async () => {
  const previous = process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE;
  process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE = '/tmp/unused-mock-provider.jsonl';
  try {
    const stream = createInProcessStream({
      model: { id: 'fake', api: 'context-broker-e2e-api', provider: 'context-broker-e2e' },
      context: { messages: [] }, requestId: '1:1', selectCall: () => null, options: {},
    });
    await assert.rejects(stream.result(), /PUBLIC_PROVIDER_HOOKS_REQUIRED/);
  } finally {
    if (previous === undefined) delete process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE;
    else process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE = previous;
  }
});

test('generated wrapper imports stable helpers instead of pasting selection', async () => {
  const root = await mkdtemp(join(await systemTempRoot(), 'mock-provider-wrapper-'));
  const helperUrl = new URL('./mock-provider-adapter.mjs', import.meta.url).href;
  const driverUrl = new URL('./notion-sdk-pi.mjs', import.meta.url).href;
  const source = renderInProcessWrapper({ helperUrl, driverUrl });
  assert.equal(source.includes('function selectProviderCall'), false);
  assert.match(source, /export function selectCall/);
  assert.match(source, /export function observe/);
  assert.match(source, /export function control/);
  assert.equal(renderHttpWrapper({ helperUrl, serializerUrl: helperUrl }).includes('streamSimple'), true);
  const path = join(root, 'fake-provider.mjs');
  await writeFile(path, source);
  const loaded = await import(pathToFileURL(path).href);
  const capture = join(root, 'provider.jsonl');
  const hooks = join(root, 'hooks.jsonl');
  const planPath = join(root, 'plan.json');
  await writeFile(planPath, JSON.stringify({ mode: 'complete' }));
  const previous = {
    plan: process.env.SC10_PI_TOOL_PLAN,
    hooks: process.env.SC10_PI_PROVIDER_HOOKS,
    capture: process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE,
    release: process.env.SC06_PI_CATALOG_RELEASE,
  };
  process.env.SC10_PI_TOOL_PLAN = planPath;
  process.env.SC10_PI_PROVIDER_HOOKS = hooks;
  process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE = capture;
  process.env.SC06_PI_CATALOG_RELEASE = 'provider';
  const { channel } = await import('node:diagnostics_channel');
  const seen = [];
  const onRelease = event => seen.push(event.boundary);
  channel('context-broker.verify-sdk-initialization-release').subscribe(onRelease);
  try {
    assert.equal(typeof loaded.default, 'function');
    const events = [];
    const providerStream = (await import(pathToFileURL(path).href)).selectCall;
    assert.equal(providerStream({ messages: [] }, { mode: 'search' }).name, 'notion_list');
    const created = createInProcessStream({
      model: { id: 'fake', api: 'context-broker-e2e-api', provider: 'context-broker-e2e' },
      context: { messages: [] }, requestId: '9:1', selectCall: context => loaded.selectCall(context),
      observe: event => events.push(event.phase),
      hold: async (_options, hook) => { hook('response_held'); return true; },
      options: { async onPayload() {}, async onResponse() {} },
    });
    assert.equal((await created.result()).stopReason, 'stop');
    assert.deepEqual(events, ['payload_start', 'payload_end', 'response_held', 'response_callback', 'response_end']);
    const direct = createInProcessStream({
      model: { id: 'fake', api: 'context-broker-e2e-api', provider: 'context-broker-e2e' },
      context: { messages: [] }, requestId: '9:2', selectCall: context => loaded.selectCall(context),
      observe: loaded.observe,
      options: { async onPayload() {}, async onResponse() {} },
    });
    await direct.result();
    assert.deepEqual(seen, ['provider']);
  } finally {
    channel('context-broker.verify-sdk-initialization-release').unsubscribe(onRelease);
    for (const [key, envName] of [['plan', 'SC10_PI_TOOL_PLAN'], ['hooks', 'SC10_PI_PROVIDER_HOOKS'], ['capture', 'CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE'], ['release', 'SC06_PI_CATALOG_RELEASE']]) {
      if (previous[key] === undefined) delete process.env[envName];
      else process.env[envName] = previous[key];
    }
  }
});

test('the original fake provider text keeps the Tern and startup replace anchors', async () => {
  const root = await mkdtemp(join(await systemTempRoot(), 'mock-provider-legacy-'));
  const path = await writeFakeProvider(root);
  const source = await readFile(path, 'utf8');
  for (const anchor of [
    'import { appendFileSync }',
    'const output = {',
    'content: [{ type: "text", text: "OK" }]',
    'stopReason: "stop"',
    'for (const event of events) yield event;',
    'appendFileSync(captureFile, JSON.stringify({ model: model.id, context }) + "\\n");',
  ]) assert.equal(source.split(anchor).length, 2, anchor);
  assert.equal(source.includes('mock-provider-adapter'), false);
});

test('installed serializer and loopback mock share native-repeat selection across turns', async () => {
  const host = await resolveHost('pi');
  let packageRoot = dirname(host.identity), packageInfo;
  for (;;) {
    try { packageInfo = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (packageInfo?.name === '@earendil-works/pi-coding-agent') break;
    assert.notEqual(packageRoot, dirname(packageRoot), 'The installed Pi package must be discoverable');
    packageRoot = dirname(packageRoot);
  }
  const identity = await resolveInstalledPiSerializer(packageRoot, packageInfo.version);
  const { stream } = await import(pathToFileURL(identity.serializer.path).href);
  const server = await startLoopbackMock({ selectCall });
  const model = { id: 'fake', name: 'Fixture', api: 'openai-completions', provider: 'openai', reasoning: false,
    baseUrl: server.baseUrl, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000, maxTokens: 128 };
  const context = { messages: [{ role: 'user', content: 'Read the resources skill.' }] };
  try {
    const expectedIds = ['sc10-search', 'sc15-main', 'sc15-resource', 'sc15-main-repeat', 'sc15-resource-repeat'];
    const outputs = [listText(), mainText(), 'resource-bytes', 'main-repeat', 'resource-repeat'];
    for (const [index, id] of expectedIds.entries()) {
      const expected = selectCall(context);
      assert.equal(expected.id, id);
      const result = await stream(model, context, { apiKey: 'fixture-no-secret', maxTokens: 64, signal: AbortSignal.timeout(10000) }).result();
      const call = result.content.find(block => block.type === 'toolCall');
      assert.equal(result.stopReason, 'toolUse');
      assert.equal(call.id, expected.id);
      assert.equal(call.name, expected.name);
      assert.deepEqual(call.arguments, expected.arguments);
      if (call.name === 'read') assert.ok([mainRef, resourceRef].includes(call.arguments.path));
      context.messages.push({ role: 'assistant', content: [call] });
      context.messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name, isError: false, content: [{ type: 'text', text: outputs[index] }] });
    }
    assert.equal(selectCall(context), null);
    const done = await stream(model, context, { apiKey: 'fixture-no-secret', maxTokens: 64, signal: AbortSignal.timeout(10000) }).result();
    assert.equal(done.stopReason, 'stop');
    assert.equal(done.content.find(block => block.type === 'text')?.text, 'OK');
    const reads = server.requests.filter(item => item.call?.name === 'read');
    assert.ok(reads.every(item => item.visibleToolText.includes(item.call.arguments.path)));
  } finally { await server.close(); }
});

test('loopback mock holds, releases, cancels, errors, and enforces bounds', async () => {
  const control = createMockControl();
  const server = await startLoopbackMock({
    selectCall: () => ({ type: 'toolCall', id: 'only', name: 'read', arguments: { path: 'guide.md' } }),
    control,
    limits: { maxRequests: 4, maxBodyBytes: 64, requestTimeoutMs: 2000, holdTimeoutMs: 2000, maxInFlight: 1 },
  });
  const body = JSON.stringify({ model: 'fake', messages: [{ role: 'user', content: 'hi' }] });
  const post = (headers, payload = body) => new Promise(resolve => {
    const req = httpRequest(server.baseUrl + '/chat/completions', { method: 'POST', headers: { host: new URL(server.baseUrl).host, ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', error => resolve({ status: 0, error: error.code ?? error.message }));
    req.end(payload);
  });
  try {
    control.hold();
    const held = post({ authorization: 'Bearer fixture-no-secret', 'content-type': 'application/json' });
    const deadline = Date.now() + 2000;
    while (!server.requests.some(item => item.phase === 'held')) {
      assert.ok(Date.now() < deadline, 'request was not held');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    control.release();
    const released = await held;
    assert.equal(released.status, 200);
    assert.match(released.body, /tool_calls/);
    control.fail('MOCK_PROVIDER_ERROR');
    const failed = await post({ authorization: 'Bearer fixture-no-secret', 'content-type': 'application/json' });
    assert.equal(failed.status, 500);
    assert.equal(JSON.parse(failed.body).error.message, 'MOCK_PROVIDER_ERROR');
    control.release();
    const rejected = await post({ authorization: 'Bearer production-token', 'content-type': 'application/json' });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.includes('production-token'), false);
    const wrongHost = await new Promise(resolve => {
      const req = httpRequest({ hostname: '127.0.0.1', port: server.port, path: '/v1/chat/completions', method: 'POST', headers: { host: 'evil.example', authorization: 'Bearer fixture-no-secret' } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(response.statusCode));
      });
      req.end(body);
    });
    assert.equal(wrongHost, 421);
    const oversized = await post({ authorization: 'Bearer fixture-no-secret', 'content-type': 'application/json' }, 'x'.repeat(80));
    assert.ok(oversized.status === 0 || oversized.status === 400 || oversized.status === 413);
    const beforeCancel = server.requests.length;
    control.hold();
    const aborting = post({ authorization: 'Bearer fixture-no-secret', 'content-type': 'application/json' });
    const abortDeadline = Date.now() + 2000;
    while (!server.requests.slice(beforeCancel).some(item => item.phase === 'held')) {
      assert.ok(Date.now() < abortDeadline);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    control.cancel();
    const cancelled = await aborting;
    assert.ok(cancelled.status === 0 || cancelled.status >= 500 || cancelled.body === '');
    assert.ok(server.requests.some(item => item.phase === 'cancelled'));
  } finally { await server.close(); }
});

test('closing the client cancels a held loopback response before selection', async () => {
  const control = createMockControl();
  let selected = 0;
  const server = await startLoopbackMock({
    selectCall: () => { selected += 1; return null; },
    control,
    limits: { maxRequests: 2, maxBodyBytes: 1024, requestTimeoutMs: 2000, holdTimeoutMs: 5000, maxInFlight: 1 },
  });
  try {
    control.hold();
    await new Promise((resolve, reject) => {
      const req = httpRequest(server.baseUrl + '/chat/completions', {
        method: 'POST', headers: { host: `127.0.0.1:${server.port}`, authorization: 'Bearer fixture-no-secret', 'content-type': 'application/json' },
      }, () => reject(new Error('held response started')));
      req.on('error', () => resolve());
      req.end(JSON.stringify({ model: 'fake', messages: [{ role: 'user', content: 'hi' }] }));
      const deadline = Date.now() + 2000;
      const timer = setInterval(() => {
        if (server.requests.some(item => item.phase === 'held')) { clearInterval(timer); req.destroy(); }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('request was not held')); }
      }, 10);
    });
    const deadline = Date.now() + 2000;
    while (!server.requests.some(item => item.phase === 'cancelled')) {
      assert.ok(Date.now() < deadline, 'client close did not cancel the hold');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(selected, 0);
  } finally { await server.close(); }
});

test('a received partial SSE can be interrupted before any completion or tool call', async () => {
  const server = await startLoopbackMock({ selectCall: () => { throw new Error('must not choose a call'); } });
  try {
    server.control.interrupt();
    const response = await fetch(server.baseUrl + '/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [] }) });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), first = await reader.read();
    assert.match(Buffer.from(first.value).toString(), /"content":"partial"/u);
    assert.equal(server.requests[0].phase, 'stream-held');
    server.control.cancel();
    await assert.rejects(reader.read());
    assert.equal(server.requests[0].phase, 'stream-interrupted');
    assert.equal(server.requests[0].call, undefined);
  } finally { await server.close(); }
});

test('real Pi loads the in-process wrapper and completes one turn', async () => {
  const root = await mkdtemp(join(await systemTempRoot(), 'mock-provider-pi-'));
  const helperUrl = new URL('./mock-provider-adapter.mjs', import.meta.url).href;
  const driverUrl = new URL('./notion-sdk-pi.mjs', import.meta.url).href;
  const provider = join(root, 'fake-provider.mjs');
  await writeFile(provider, renderInProcessWrapper({ helperUrl, driverUrl }));
  const planPath = join(root, 'plan.json');
  await writeFile(planPath, JSON.stringify({ mode: 'complete' }));
  const agentDir = join(root, 'agent'), sessions = join(root, 'sessions');
  await mkdir(agentDir, { recursive: true }); await mkdir(sessions);
  const env = isolatedEnv({ base: root, agentDir, TMPDIR: await systemTempRoot(),
    SC10_PI_TOOL_PLAN: planPath, SC10_PI_PROVIDER_HOOKS: join(root, 'hooks.jsonl'),
    CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: join(root, 'provider.jsonl') });
  const rpc = await startRpc({ host: 'pi', args: ['--no-extensions', '--no-skills', '--no-mcp', '--session-dir', sessions, '--tools', 'read', '-e', provider, '--model', 'context-broker-e2e/fake'], cwd: root, env, timeoutMs: 60000 });
  try {
    const frame = await rpc.prompt('Reply with the fixture stop text.');
    const assistant = (frame.messages ?? []).filter(message => message.role === 'assistant').at(-1);
    assert.equal(assistant?.stopReason, 'stop');
    const capture = JSON.parse(await readFile(join(root, 'provider.jsonl'), 'utf8'));
    assert.match(capture.requestId, /^\d+:[1-9]\d*$/u);
    assert.equal(createHash('sha256').update(JSON.stringify(capture.context)).digest('hex').length, 64);
  } finally { await rpc.stop(); }
});
