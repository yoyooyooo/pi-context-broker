import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runSubject } from './execute.mjs';
import { inventoryPublicInputs } from './subject.mjs';

const environment = process.env.BENCHMARK_TURN_SDK_ENV, buildId = process.env.BENCHMARK_TURN_SDK_BUILD;
const proofDirectory = process.env.BENCHMARK_TURN_SDK_PROOF_ROOT;
const resourceMode = process.env.BENCHMARK_TURN_SDK_RESOURCE_MODE ?? 'bounded';
assert.ok(['bounded', 'unbounded'].includes(resourceMode), 'Select a declared apparatus resource mode');
const sha = value => createHash('sha256').update(value).digest('hex');
const readJson = path => readFile(path, 'utf8').then(JSON.parse);
async function save(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  await writeFile(path, content, { flag: 'wx', mode }); await chmod(path, mode);
  return { path, sha256: sha(content), bytes: Buffer.byteLength(content) };
}
const sse = value => 'data: ' + JSON.stringify(value) + '\n\n';

test('shared launcher, maintained Pi session and production turn hook use only an owned loopback provider (' + resourceMode + ')', {
  skip: !(environment && buildId && proofDirectory) && 'Set explicit owned ENV, fresh BUILD and PROOF_ROOT; this test never uses a real provider.',
  timeout: 120000,
}, async () => {
  const root = await realpath(environment), controlRoot = await realpath(proofDirectory);
  assert.ok(controlRoot.startsWith(root + '/control/'));
  const build = await readJson(join(root, 'builds', buildId, 'build.json'));
  const runId = 'turn-sdk-' + controlRoot.split('/').at(-1), captureId = runId + '-capture', runRoot = join(root, 'runs', runId);
  const received = [], usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } };
  const nativePath = join(runRoot, 'skills/native/owned-skill/routing.json');
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); received.push({ method: request.method, path: request.url, body, sha256: sha(raw) });
    const messages = body.messages, userIndex = messages.findLastIndex(message => message.role === 'user');
    const userText = typeof messages[userIndex].content === 'string' ? messages[userIndex].content
      : messages[userIndex].content.map(part => part.text ?? '').join('');
    const toolRead = messages.slice(userIndex + 1).some(message => message.role === 'tool');
    const shouldRead = /TURN_(?:ONE|TWO)/.test(userText) && !toolRead;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'loopback-turn-' + received.length });
    const base = { id: 'chatcmpl-turn-' + received.length, object: 'chat.completion.chunk', created: 0, model: 'fixture' };
    if (shouldRead) {
      const code = 'const result = await tools.read({path:' + JSON.stringify(nativePath) + '}); console.log(result);';
      response.write(sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{
        index: 0, id: 'read-turn-' + received.length, type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code }) },
      }] }, finish_reason: null }] }));
      response.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
    } else {
      const text = userText.includes('TURN_ONE') ? '请问配送方式？' : '已完成本次受控文件读取。';
      response.write(sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }));
      response.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    }
    response.write(sse({ ...base, choices: [], usage })); response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proof = { version: 1, kind: 'shared-maintained-pi-turn-bridge-apparatus',
    scope: 'owned-loopback-only; synthetic fixture effect; not a real model route, live Notion update or business score',
    real_model_calls: 0, external_provider_requests: 0, build_id: buildId, resource_mode: resourceMode, status: 'running' };
  const keyName = 'BENCHMARK_TURN_LOOPBACK_KEY', previousKey = process.env[keyName]; process.env[keyName] = 'controlled-non-provider-credential';
  try {
    const skillRoot = join(controlRoot, 'initial-skills'), inventory = [];
    for (const [path, content] of [['SKILL.md', '---\nname: owned-skill\ndescription: Read the controlled routing resource.\n---\nRead routing.json for the current controlled version.\n'],
      ['routing.json', '{"version":1}\n']]) inventory.push({ ...await save(join(skillRoot, 'owned-skill', path), content, 0o400),
      skill_id: 'routing', resource_path: path, mode: '100644' });
    const inputRoot = join(controlRoot, 'inputs'); await save(join(inputRoot, 'input/task.json'), { scope: 'controlled apparatus' });
    const event = { id: 'policy-v2', before_turn: 'turn-2', kind: 'publish-version', skill_id: 'routing', version: 'v2' };
    const fixtureRoot = join(controlRoot, 'fixture'), fixturePlan = { schema_version: 1, kind: 'benchmark-controller-fixture', access: 'episode-owned',
      control_root: fixtureRoot, episode_id: runId, owned_runtime_root: runRoot,
      events: [{ ...event, logical_operation: { skill_id: 'routing', path: 'routing.json', intent: 'publish-version' } }] };
    fixturePlan.plan_sha256 = sha(JSON.stringify(fixturePlan));
    const fixtureRef = await save(join(fixtureRoot, 'plan.json'), fixturePlan), versionRoot = join(fixtureRoot, 'native-v2'), versionFiles = [];
    for (const original of inventory) {
      const content = original.resource_path === 'routing.json' ? '{"version":2}\n' : await readFile(original.path, 'utf8');
      versionFiles.push({ ...await save(join(versionRoot, 'owned-skill', original.resource_path), content, 0o400),
        skill_id: 'routing', resource_path: original.resource_path, mode: '100644', version: 'v2' });
    }
    const rawReadback = await save(join(fixtureRoot, 'synthetic-readback-raw.json'), { scope: 'controlled-source-apparatus', version: 2 });
    const readback = await save(join(fixtureRoot, 'synthetic-readback.json'), { status: 'passed', observed: { files: versionFiles.map(file => ({
      path: file.resource_path, sha256: file.sha256, bytes: file.bytes, mode: file.mode,
    })) }, rawEvidence: rawReadback });
    let effects = 0;
    const fixtureOperations = {
      async apply({ eventId, episodeId }) {
        effects++; assert.equal(eventId, event.id); assert.equal(episodeId, runId);
        const result = { schema_version: 1, event_id: eventId, episode_id: episodeId, status: 'applied', effect_unknown: false, effect_verified: true,
          effect_evidence: [readback, rawReadback], native_version: { target_name: 'owned-skill', skill_root: versionRoot, files: versionFiles, readback, raw_readback: rawReadback } };
        return { ...result, receipt: await save(join(fixtureRoot, 'effect.json'), result) };
      },
      async reconcile() { throw new Error('No synthetic recovery allowed'); },
      async attach() { throw new Error('This native apparatus has no Notion Store fault'); },
    };
    const binding = { id: 'controlled-turns', input_root: inputRoot, input_inventory_sha256: sha(JSON.stringify(await inventoryPublicInputs(inputRoot))),
      skills_root: skillRoot, skill_inventory: inventory, events: [event], fixture_control: { path: fixtureRef.path, sha256: fixtureRef.sha256 },
      public_case: { turns: [{ id: 'turn-1', prompt: 'TURN_ONE: read the current controlled routing resource, then ask which delivery mode to use.' },
        { id: 'turn-2', prompt: 'TURN_TWO: read the current controlled routing resource again.' }] },
      clarification: [{ topic_id: 'delivery-mode', max_questions: 1, response: '请使用普通配送。', expected_value: 'PRIVATE_CLARIFICATION_EXPECTATION_83627' }] };
    const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
    const models = await save(join(controlRoot, 'models.json'), { providers: { 'benchmark-loopback': { api: 'openai-completions', baseUrl, apiKey: keyName,
      models: [{ id: 'fixture', name: 'fixture', api: 'openai-completions', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 256 }] } } });
    const parameters = { maxTokens: 256, thinkingLevel: 'off' }, options = {
      environmentRoot: root, buildId, mode: 'native', binding,
      model: { provider: 'benchmark-loopback', id: 'fixture', api: 'openai-completions', baseUrl, parameters }, modelsFile: models.path,
      runtime: { node: build.tools.node, pi: build.tools.pi, bun: build.tools.bun },
      controlRoot, conditionId: 'controlled-native', budget: { max_duration_ms: 60000, max_model_requests: 10, max_http_attempts: 10,
        max_input_tokens: 1000000, max_output_tokens: 4096 }, codeMode: 'free',
      credential: { source_file: models.path, provider: 'benchmark-loopback', api_key_env: keyName },
    };
    if (resourceMode === 'unbounded') {
      options.budgetMode = 'unbounded';
      options.budget = { max_duration_ms: null, max_model_requests: null, max_http_attempts: null,
        max_input_tokens: null, max_output_tokens: null, max_retries: null };
    }
    const capture = await runSubject({ ...options, runId: captureId, captureOnly: true }, { fixtureOperations });
    proof.capture = capture;
    assert.equal(capture.status, 'captured', JSON.stringify(capture.episode?.error)); assert.equal(received.length, 0);
    const expectationSource = capture.episode.artifacts.find(artifact => artifact.id === 'candidate-expectation');
    assert.ok(expectationSource); const expected = await save(join(controlRoot, 'frozen-expectation.json'), await readFile(expectationSource.path, 'utf8'));
    const observed = await runSubject({ ...options, runId, expected }, { fixtureOperations });
    proof.observed = observed; proof.fixture_effects = effects; proof.loopback_http_requests = received.length;
    assert.equal(observed.status, 'completed', JSON.stringify(observed.episode?.error));
    assert.equal(observed.stop_batch, false); assert.equal(observed.turn_control.status, 'completed');
    if (resourceMode === 'unbounded') {
      assert.equal(observed.shared.timeout_ms, null); assert.equal(capture.shared.timeout_ms, null);
      const launch = await readJson(join(controlRoot, runId + '.launch.json'));
      assert.equal(launch.runtime_config.limits.mode, 'unbounded');
      assert.ok(Object.entries(launch.runtime_config.limits).every(([key, value]) => key === 'mode' || value === null));
      assert.equal(launch.runtime_config.model.parameters.maxTokens, 256);
    }
    assert.deepEqual(observed.episode.turns.map(turn => turn.id), ['turn-1', 'clarification-1', 'turn-2']);
    const events = (await readFile(join(runRoot, 'benchmark/runtime/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const ends = events.filter(event => event.type === 'user_turn_end');
    assert.equal(new Set(ends.map(event => event.data.session_id)).size, 1);
    assert.equal(ends.every(event => event.data.is_idle && event.data.settled), true);
    const reads = events.filter(event => event.type === 'session_event' && event.data.type === 'tool_execution_end'
      && event.data.toolName === 'read' && !event.data.isError);
    assert.equal(reads.length, 2); assert.match(JSON.stringify(reads[0]), /version.{0,8}1/); assert.match(JSON.stringify(reads[1]), /version.{0,8}2/);
    assert.equal(received.length, 5); assert.equal(observed.episode.requests.length, 5); assert.equal(effects, 1);
    assert.ok(!JSON.stringify(received).includes('PRIVATE_CLARIFICATION_EXPECTATION_83627'));
    proof.status = 'passed';
  } catch (error) { proof.status = 'failed'; proof.error = { name: error.name, message: error.message }; throw error; }
  finally {
    await new Promise(resolve => server.close(resolve));
    if (previousKey === undefined) delete process.env[keyName]; else process.env[keyName] = previousKey;
    proof.received = await save(join(controlRoot, 'loopback-requests.json'), received);
    await save(join(controlRoot, 'apparatus-proof.json'), proof);
  }
});

