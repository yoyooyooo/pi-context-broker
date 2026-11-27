import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createEpisodeRecorder, fileIdentity } from './episode-evidence.mjs';
import { assessProfileToolCall, codemodeExtensionOptions, createEpisodeBudget, createEpisodeToolGuard } from './episode-policy.mjs';
import { assertProfileResources, assertProfileToolRegistry, reserveEpisodeRequest, awaitProfileMcpAdmission, observerFirst, validateEpisodeConfig, writeEpisodeResult, sdkInstallation, sdkMcpImportEntry, createEpisodeUIContext, requestContractEvidence, requestContractDifferences, captureExtensionEntry } from './episode-runner.mjs';

const policy = { allowed_tools: ['codemode', 'read', 'bash', 'fetch_content', 'mcp__fixture__read'],
  blocked_tools: ['subagent', 'deck_generate', 'bg_start', 'mcp__fixture__save', 'mcp__fixture__forget', 'tool_search'],
  blocked_parameters: [{ tool: 'fetch_content', path: ['model'], when: 'present', reason: 'Unmetered derived model.' },
    { tool: 'fetch_content', path: ['answer'], when: 'truthy', reason: 'Unmetered generated answer.' }] };
const limits = { wallTimeMs: 60000, maxModelRequests: 3, maxToolCalls: 10, maxHttpAttempts: 3, maxInputTokens: 300000, maxOutputTokens: 16000, maxTotalTokens: 316000 };

test('known tool and parameter rules do not infer danger from arbitrary names or bash content', () => {
  assert.equal(assessProfileToolCall(policy, { toolName: 'bash', input: { command: 'literal model=word' } }), null);
  assert.equal(assessProfileToolCall(policy, { toolName: 'fetch_content', input: { answer: false } }), null);
  assert.equal(assessProfileToolCall(policy, { toolName: 'read', input: { path: '/file/with/model/in/name' } }), null);
  assert.equal(assessProfileToolCall(policy, { toolName: 'fetch_content', input: { model: null } }).rule, 'blocked_parameter');
  assert.equal(assessProfileToolCall(policy, { toolName: 'fetch_content', input: { answer: 'summarize' } }).rule, 'blocked_parameter');
  assert.equal(assessProfileToolCall(policy, { toolName: 'new_unreviewed_tool', input: {} }).rule, 'undeclared_tool');
  assert.equal(assessProfileToolCall(null, { toolName: 'any_bare_tool', input: {} }), null);
});

test('blocked child calls retain exact request identity, are marked unexecuted, and preserve already-accounted usage', () => {
  const budget = createEpisodeBudget(limits); budget.request(); budget.attempt();
  budget.usage({ complete_for_token_budget: true, input: 100, output: 20, total: 120 });
  const events = [], stopped = [];
  const guard = createEpisodeToolGuard({ budget, codeEnabled: true, toolPolicy: policy,
    record: (type, data) => events.push({ type, data }), stop: (code, details) => stopped.push({ code, details }) });
  const input = { toolName: 'mcp__fixture__save', toolCallId: 'child-1', parentToolCallId: 'code-1', input: { body: 'fixture' } };
  assert.deepEqual(guard(input), { block: true, terminate: true, reason: 'This declared tool is outside the episode authorization.' });
  assert.equal(stopped[0].code, 'BENCHMARK_OUT_OF_SCOPE_TOOL');
  assert.equal(events[0].data, input); assert.equal(events[1].data.executed, false); assert.equal(events[1].data.parent_tool_call_id, 'code-1');
  assert.equal(events[1].data.scope, 'apparatus-out-of-scope');
  assert.deepEqual([budget.state.requests, budget.state.attempts, budget.state.tools, budget.state.input_tokens, budget.state.output_tokens], [1, 1, 1, 100, 20]);
});

test('the guard precedes third-party hooks while their original order remains intact', () => {
  const common1 = { path: '/first.mjs' }, common2 = { path: '/second.mjs' }, observer = { path: '<inline:benchmark-observer>' };
  const loaded = { extensions: [common1, common2, observer], errors: [], runtime: { identity: 'same' } };
  const result = observerFirst(loaded);
  assert.deepEqual(result.extensions, [observer, common1, common2]); assert.equal(result.runtime, loaded.runtime);
  assert.deepEqual(loaded.extensions, [common1, common2, observer]);
  assert.throws(() => observerFirst({ extensions: [common1] }), /OBSERVER_REQUIRED/);
});

test('MCP admission waits for complete metadata then applies only the common tool-search policy', async () => {
  let complete = false, active = ['read', 'codemode', 'tool_search']; const events = [];
  const session = { prompt: async command => { assert.equal(command, '/mcp'); complete = true; },
    getAllTools: () => { assert.equal(complete, true); return ['read', 'codemode', 'tool_search', 'mcp__fixture__read', 'mcp__fixture__save'].map(name => ({ name })); },
    getActiveToolNames: () => [...active], setActiveToolsByName: value => { active = value; } };
  const resources = { manifest: { mcp_tools: ['mcp__fixture__read', 'mcp__fixture__save'], tool_policy: { allowed_tools: ['read', 'codemode', 'mcp__fixture__read'], blocked_tools: ['tool_search', 'mcp__fixture__save'], blocked_parameters: [] } } };
  await awaitProfileMcpAdmission({ session, resources, codeEnabled: true, record: (type, data) => events.push({ type, data }) });
  assert.deepEqual(active, ['read', 'codemode']); assert.equal(events.at(-1).data.scope, 'actual registry; no remote tool executed');
  resources.manifest.mcp_tools.pop(); await assert.rejects(awaitProfileMcpAdmission({ session, resources, codeEnabled: true }), /MCP_REGISTRY_DRIFT/);
});

test('native and context admission reject missing hidden entries, changed bytes, wrong visibility and extension reorder', () => {
  const resources = { manifest: { native_skills: [{ path: '/visible.md', sha256: 'a', visible: true }, { path: '/hidden.md', sha256: 'b', visible: false }] },
    contextFiles: [{ path: '/AGENTS.md', content: 'frozen context' }] };
  const baseline = { resources, profile: { extensions: [{ path: '/first.mjs' }, { path: '/broker.mjs' }] },
    extensions: [{ path: '<inline:benchmark-observer>' }, { path: '/first.mjs' }, { path: '/broker.mjs' }, { path: 'builtin:mcp' }],
    skills: [{ file: { realpath: '/visible.md', sha256: 'a' }, disableModelInvocation: false }, { file: { realpath: '/hidden.md', sha256: 'b' }, disableModelInvocation: true }],
    contextFiles: { agentsFiles: structuredClone(resources.contextFiles) } };
  assertProfileResources(baseline);
  for (const mutate of [value => value.skills.pop(), value => { value.skills[0].file.sha256 = 'different'; },
    value => { value.skills[1].disableModelInvocation = false; }, value => { value.contextFiles.agentsFiles[0].content = 'different'; },
    value => { [value.extensions[1], value.extensions[2]] = [value.extensions[2], value.extensions[1]]; }]) {
    const changed = structuredClone(baseline); mutate(changed); assert.throws(() => assertProfileResources(changed), /BENCHMARK_PROFILE_/);
  }
});

const sdkEntry = process.env.BENCHMARK_PI_SDK_ENTRY;
test('actual maintained SDK preserves headless startup UI and guards a deferred CodeMode child before implementation',
  { skip: !sdkEntry && 'Set BENCHMARK_PI_SDK_ENTRY to the maintained SDK for this zero-model proof.', timeout: 30000 }, async t => {
  const installation = await sdkInstallation(sdkEntry, true), bareInstallation = await sdkInstallation(sdkEntry);
  assert.deepEqual(installation.entry, await fileIdentity(installation.module));
  assert.deepEqual(bareInstallation.entry, installation.entry);
  for (const [name, suffix] of [['codemode', 'codemode'], ['tool_search', 'tool-search'], ['mcp', 'mcp']]) {
    assert.deepEqual(await captureExtensionEntry('builtin:' + name, installation),
      await fileIdentity(join(installation.root, 'dist/extensions', suffix, 'index.js')));
  }
  for (const file of bareInstallation.files) assert.deepEqual(installation.files.find(item => item.path === file.path), file);
  const sdk = await import(pathToFileURL(installation.module).href), root = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-profile-sdk-')));
  const cwd = join(root, 'workspace'), agentDir = join(root, 'agent'); await mkdir(cwd); await mkdir(agentDir);
  const mcpImports = [];
  for (const [specifier, exported] of [['@earendil-works/pi-mcp', 'McpClient'], ['@earendil-works/pi-mcp/oauth', 'createMcpAuthProvider']]) {
    const selected = await sdkMcpImportEntry(installation.module, specifier);
    const namespace = await import(pathToFileURL(selected.entry).href);
    assert.equal(typeof namespace[exported], 'function');
    for (const path of [selected.package_file, selected.entry]) {
      assert.deepEqual(installation.files.find(file => file.path === path), await fileIdentity(path));
      assert.ok(!bareInstallation.files.some(file => file.path === path));
    }
    mcpImports.push({ specifier, package: await fileIdentity(selected.package_file), entry: await fileIdentity(selected.entry), verified_export: exported });
  }
  const { loadMcpConfig } = await import(pathToFileURL(join(installation.root, 'dist/extensions/mcp/config.js')).href);
  await writeFile(join(agentDir, 'mcp.json'), '{"mcpServers":{}}\n', { mode: 0o600 });
  const mcpConfig = loadMcpConfig({ agentDir, cwd, projectTrusted: false });
  assert.deepEqual(mcpConfig.errors, []); assert.equal(mcpConfig.servers.length, 0);
  const mcpFactory = sdk.createMcpExtension({ loadConfig: () => mcpConfig });
  assert.equal(typeof mcpFactory, 'function');
  await assert.rejects(sdkMcpImportEntry(installation.module, '@earendil-works/pi-mcp/unreviewed'), /PI_MCP_IMPORT_UNREVIEWED/);

  const visible = join(root, 'visible.md'), hidden = join(root, 'hidden.md'), contextFile = join(root, 'AGENTS.md');
  await writeFile(visible, '---\nname: profile-visible\ndescription: Synthetic visible native source.\n---\nSource.\n');
  await writeFile(hidden, '---\nname: profile-hidden\ndescription: Synthetic explicit native source.\ndisable-model-invocation: true\n---\nSource.\n');
  await writeFile(contextFile, 'Explicit owned context.\n');
  const settingsManager = sdk.SettingsManager.inMemory({ packages: [], enableSkillCommands: true, compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, modelsStorePath: join(agentDir, 'model-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider('profile-proof', { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'unused-fixture', models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 256 }] });
  const stops = [], notifications = [], blockedInteractions = []; let events = [], executions = 0, requests = 0, laterHooks = 0, startupCalls = 0, widgetFactories = 0;
  const recorder = await createEpisodeRecorder(join(root, 'evidence'), { run_id: 'synthetic-profile-sdk-proof' });
  recorder.bind({ turn_id: 'synthetic-proof-turn' });
  const budget = createEpisodeBudget(limits);
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: ['builtin:codemode'], extensionsOverride: observerFirst, additionalSkillPaths: [visible, hidden],
    agentsFilesOverride: () => ({ agentsFiles: [{ path: contextFile, content: 'Explicit owned context.\n' }] }),
    extensionFactories: [
      { name: 'fixture-mcp', factory: api => {
        api.on('session_start', async (_event, ctx) => {
          assert.equal(ctx.mode, 'rpc'); assert.equal(ctx.hasUI, true);
          assert.equal(ctx.ui.theme, defaultUI.theme);
          ctx.ui.setHiddenThinkingLabel('');
          ctx.ui.setWidget('compact-anim-proof', () => { widgetFactories++; return { render: () => [], invalidate() {} }; });
          ctx.ui.notify('Synthetic startup notification.');
          ctx.ui.notify('Synthetic startup warning.', 'warning');
          for (const [method, args] of [['select', ['Synthetic choice.', ['one']]], ['confirm', ['Synthetic confirmation.', 'Owned fixture.']], ['input', ['Synthetic input.']]]) {
            await assert.rejects(async () => ctx.ui[method](...args), { code: 'BENCHMARK_INTERACTIVE_UI_REQUEST' });
            blockedInteractions.push(method);
          }
          startupCalls++;
        });
        api.on('tool_call', () => { laterHooks++; });
        api.registerTool({ name: 'mcp__fixture__save', description: 'Synthetic deferred write, never executes.', exposure: 'deferred', parameters: { type: 'object', properties: {}, additionalProperties: false },
          async execute() { executions++; return { content: [{ type: 'text', text: 'must not happen' }] }; } });
      } },
      { name: 'codemode', builtin: true, replaceable: true, factory: sdk.createCodemodeExtension(codemodeExtensionOptions('free')) },
      { name: 'benchmark-observer', factory: api => api.on('tool_call', createEpisodeToolGuard({ budget, codeEnabled: true, toolPolicy: policy,
        record: recorder.record, stop: (code, details) => stops.push({ code, details }) })) },
    ] });
  await loader.reload();
  assert.deepEqual(loader.getSkills().skills.map(skill => [skill.name, skill.disableModelInvocation]), [['profile-visible', false], ['profile-hidden', true]]);
  assert.deepEqual(loader.getAgentsFiles(), { agentsFiles: [{ path: contextFile, content: 'Explicit owned context.\n' }] });
  const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, model: modelRuntime.getModel('profile-proof', 'fixture'), thinkingLevel: 'off', sessionManager: sdk.SessionManager.inMemory(cwd), tools: ['+codemode'] });
  session.agent.streamFunction = () => { requests++; throw new Error('PROFILE_PROOF_MODEL_FORBIDDEN'); };
  const unsubscribe = session.subscribe(event => recorder.record('session_event', event));
  const defaultUI = session.extensionRunner.getUIContext(), defaultDescriptors = Object.getOwnPropertyDescriptors(defaultUI);
  const ui = createEpisodeUIContext({ session, resources: {}, notifications, recorder });
  const bareUI = createEpisodeUIContext({ notifications, recorder });
  assert.equal(bareUI.setHiddenThinkingLabel, undefined);
  try {
    await session.bindExtensions({ uiContext: ui, mode: 'rpc', onError: error => { throw error; } });
    assert.equal(startupCalls, 1); assert.equal(widgetFactories, 0);
    assert.deepEqual(blockedInteractions, ['select', 'confirm', 'input']);
    assert.deepEqual(Object.keys(session.extensionRunner.getUIContext()).sort(), Object.keys(defaultUI).sort());
    assert.deepEqual(Object.getOwnPropertyDescriptors(defaultUI), defaultDescriptors);
    assert.equal(await defaultUI.select('Unused choice.', ['one']), undefined);
    assert.equal(await defaultUI.confirm('Unused confirmation.', 'Owned fixture.'), false);
    assert.equal(await defaultUI.input('Unused input.'), undefined);
    defaultUI.notify('The shared default must remain a no-op.');
    assert.deepEqual(notifications, [{ message: 'Synthetic startup notification.', type: 'info' }, { message: 'Synthetic startup warning.', type: 'warning' }]);
    // A synthetic parent message establishes the SDK tool-call lineage. No stream or HTTP request is made.
    session.agent.state.messages = [{ role: 'assistant', content: [{ type: 'toolCall', id: 'outer-code', name: 'codemode', arguments: { code: 'await tools.mcp__fixture__save({})' } }],
      api: 'openai-completions', provider: 'profile-proof', model: 'fixture', stopReason: 'toolUse', timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }];
    const controller = new AbortController(), ctx = session.extensionRunner.createToolContext('outer-code', controller.signal);
    const result = await session.getToolDefinition('codemode').execute('outer-code', { code: 'await tools.mcp__fixture__save({})' }, controller.signal, undefined, ctx);
    await recorder.close();
    events = (await readFile(recorder.eventPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(executions, 0); assert.equal(requests, 0); assert.equal(laterHooks, 0);
    assert.ok(stops.length, JSON.stringify({ result, callable: session.getCallableToolNames(), events }));
    assert.equal(stops[0].code, 'BENCHMARK_OUT_OF_SCOPE_TOOL');
    const call = events.find(item => item.type === 'tool_call'); assert.equal(call.data.toolName, 'mcp__fixture__save'); assert.equal(call.data.parentToolCallId, 'outer-code');
    assert.ok(events.some(item => item.type === 'tool_call_blocked' && item.data.executed === false));
    assert.deepEqual(events.filter(item => item.type === 'extension_notification').map(item => item.data), notifications);
    const lifecycle = events.filter(item => ['tool_call', 'tool_call_blocked'].includes(item.type) || item.type === 'session_event' && ['tool_execution_start', 'tool_execution_end'].includes(item.data.type));
    assert.deepEqual(lifecycle.map(item => item.type === 'session_event' ? item.data.type : item.type), ['tool_execution_start', 'tool_call', 'tool_call_blocked', 'tool_execution_end']);
    assert.ok(lifecycle.every(item => item.turn_id === 'synthetic-proof-turn'));
    assert.doesNotMatch(JSON.stringify(result), /must not happen/);
    const files = await Promise.all([new URL('./episode-policy.mjs', import.meta.url), new URL('./episode-runner.mjs', import.meta.url), new URL('./episode-evidence.mjs', import.meta.url), pathToFileURL(sdkEntry)].map(url => fileIdentity(fileURLToPath(url))));
    await writeFile(join(root, 'proof.json'), JSON.stringify({ schema_version: 1, kind: 'maintained-sdk-child-guard-proof', scope: 'direct executor with synthetic assistant parent lineage through actual CodeMode and deferred child pipeline; no outer SDK execution callbacks, model stream, HTTP request or tool implementation execution', files, mcp_imports: mcpImports, mcp_validation: { config_loaded: true, factory_constructed: true, servers: 0, factory_executed: false, bare_excludes_mcp: true, sdk_version: installation.version }, ui_validation: { startup_calls: startupCalls, blocked_interactions: blockedInteractions, notifications, widget_factory_executions: widgetFactories, default_context_unchanged: true, inherited_members: Object.keys(defaultUI).sort() }, requests, executions, laterHooks, events, stops }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    t.diagnostic('Zero-model SDK proof: ' + join(root, 'proof.json'));
  } finally { unsubscribe(); await recorder.close(); await session.abort(); session.dispose(); }
});


test('late private resource credentials are scrubbed before extension and tool evidence is retained', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-profile-redaction-')));
  const recorder = await createEpisodeRecorder(directory, { run_id: 'synthetic-profile' });
  const secret = 'SYNTHETIC-WEB-KEY-987654321';
  recorder.addCredentials([secret]);
  recorder.record('fixture_tool_error', { message: 'provider echoed ' + secret, benign: 'ordinary model text' });
  const originalPath = join(directory, 'private-sdk-session.jsonl');
  const originalBytes = Buffer.from(JSON.stringify({ type: 'message', content: 'echoed ' + secret }) + '\n');
  await writeFile(originalPath, originalBytes, { mode: 0o600 });
  const original = await fileIdentity(originalPath);
  const session = await recorder.addRedactedJsonlArtifact('session', originalPath, 'pi-session-jsonl');
  await recorder.save('session-entries', { entries: [{ content: 'embedded ' + secret }] });
  await recorder.close();
  const rawResult = { error: { message: 'failed ' + secret }, turns: [{ final_text: 'final ' + secret }],
    requests: [{ assistant: { error: 'provider ' + secret } }], paths: { result: join(directory, 'episode-result.json') } };
  const retained = await writeEpisodeResult(rawResult, recorder, { redact: true });
  const events = await readFile(recorder.eventPath, 'utf8'), entries = await readFile(join(directory, 'session-entries.json'), 'utf8');
  const result = await readFile(rawResult.paths.result, 'utf8'), copy = await readFile(session.path, 'utf8');
  assert.doesNotMatch(events + entries + result + copy, new RegExp(secret)); assert.match(events + entries + result + copy, /REDACTED_CREDENTIAL/);
  assert.match(events, /ordinary model text/); assert.deepEqual(retained, JSON.parse(result));
  assert.equal(rawResult.turns[0].final_text, 'final ' + secret);
  assert.equal(session.kind, 'pi-session-jsonl-redacted-copy');
  assert.equal(session.source.sha256, original.sha256); assert.equal(session.source.retained_private, true);
  assert.deepEqual(session.source.permissions, { file_mode: 0o600, parent_mode: 0o700 });
  assert.deepEqual(await readFile(originalPath), originalBytes);
  assert.equal((await stat(originalPath)).mode & 0o077, 0); assert.equal((await stat(session.path)).mode & 0o077, 0);
  const bare = { final_text: 'unmodified bare fixture', paths: { result: join(directory, 'bare-result.json') } };
  assert.equal(await writeEpisodeResult(bare, recorder), bare);
});



test('canonical comparison precedes machine-safe redaction and retains a strict pre-redaction request digest', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-canonical-redaction-')));
  const recorder = await createEpisodeRecorder(directory, { run_id: 'synthetic-redaction' }, ['search', 'tiny', 'first-private', 'second-private']);
  const payload = (root, prompt, text = 'first-private') => ({ model: 'fixture', messages: [
    { role: 'system', content: 'Owned source ' + root + '/AGENTS.md and ' + text },
    { role: 'user', content: prompt }], tools: [{ type: 'function', function: { name: 'mcp__search__read', parameters: { type: 'object' } } }] });
  const before = payload('/owned/search/capture', 'capture question'), after = payload('/owned/search/paid', 'paid question');
  const rawBefore = JSON.stringify(before), rawAfter = JSON.stringify(after);
  try {
    const captured = requestContractEvidence(before, 'openai-completions', 'capture question', { RUN: '/owned/search/capture' }, [], recorder);
    await recorder.save('candidate-expectation', { version: 1, ...captured });
    const expected = JSON.parse(await readFile(join(directory, 'candidate-expectation.json'), 'utf8'));
    const actual = requestContractEvidence(after, 'openai-completions', 'paid question', { RUN: '/owned/search/paid' }, [], recorder);
    assert.deepEqual(requestContractDifferences(expected, actual), []);
    assert.match(actual.request_contract.messages[0].content, /\$RUN\/AGENTS\.md/);
    assert.match(actual.request_contract.tools[0].function.name, /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
    assert.doesNotMatch(JSON.stringify(expected), /first-private|second-private|search/);
    assert.deepEqual(recorder.scrub(expected), expected);
    assert.equal(recorder.scrub({ echo: 'tiny', apiKey: 'unlisted-field-value' }).echo, 'REDACTED_CREDENTIAL');
    assert.equal(recorder.scrub({ apiKey: 'unlisted-field-value' }).apiKey, 'REDACTED_CREDENTIAL');
    const projected = recorder.project({ path: '/owned/search/paid/file', all: [{ name: 'mcp__search__read' }], active: ['mcp__search__read'] }, { RUN: '/owned/search/paid' });
    assert.equal(projected.path, '$RUN/file');
    assert.equal(projected.all[0].name, projected.active[0]);
    recorder.record('tool_call', { toolName: 'mcp__search__read', toolCallId: 'call-search-1', parentToolCallId: 'outer-search' });
    recorder.record('tool_call_blocked', { tool: 'mcp__search__read', tool_call_id: 'call-search-1', parent_tool_call_id: 'outer-search', executed: false });
    await recorder.close();
    const events = (await readFile(recorder.eventPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events[0].data.toolName, projected.all[0].name);
    assert.equal(events[0].data.toolCallId, events[1].data.tool_call_id);
    assert.equal(events[0].data.parentToolCallId, events[1].data.parent_tool_call_id);
    const maskedChange = requestContractEvidence(payload('/owned/search/paid', 'paid question', 'second-private'),
      'openai-completions', 'paid question', { RUN: '/owned/search/paid' }, [], recorder);
    assert.deepEqual(maskedChange.request_contract, actual.request_contract);
    assert.deepEqual(requestContractDifferences(expected, maskedChange).map(item => item.path), ['/request_contract_sha256']);
    const substantiveChange = structuredClone(after); substantiveChange.messages[0].content += ' Different required fact.';
    assert.ok(requestContractDifferences(expected, requestContractEvidence(substantiveChange, 'openai-completions', 'paid question', { RUN: '/owned/search/paid' }, [], recorder)).some(item => item.path === '/messages'));
    assert.throws(() => requestContractDifferences({ request_contract: expected.request_contract }, actual), /DIGEST_REQUIRED/);
    assert.equal(JSON.stringify(before), rawBefore); assert.equal(JSON.stringify(after), rawAfter);
  } finally { await recorder.close(); }
});


test('a later registry or schema change stops before the next request without overwriting the previous response', () => {
  const expected = [{ name: 'read', description: 'Frozen', parameters: { type: 'object' } }];
  assertProfileToolRegistry(expected, structuredClone(expected), ['read']);
  assert.throws(() => assertProfileToolRegistry(expected, [{ ...expected[0], parameters: { type: 'string' } }], ['read']), { code: 'BENCHMARK_RESOURCE_TOOL_REGISTRY_DRIFT' });
  assert.throws(() => assertProfileToolRegistry(expected, expected, ['read', 'tool_search']), { code: 'BENCHMARK_RESOURCE_TOOL_SEARCH_DRIFT' });
  const budget = createEpisodeBudget(limits); budget.request(); budget.attempt(); let current = { id: 'sent-request' }, stopped;
  const original = current;
  assert.throws(() => reserveEpisodeRequest({ budget, captureOnly: false, clearRequest: () => { current = undefined; },
    checkContract: () => assertProfileToolRegistry(expected, [], []), onStop: error => { stopped = error; } }), { code: 'BENCHMARK_RESOURCE_TOOL_REGISTRY_DRIFT' });
  assert.equal(current, undefined); assert.deepEqual(original, { id: 'sent-request' }); assert.equal(stopped.code, 'BENCHMARK_RESOURCE_TOOL_REGISTRY_DRIFT');
  assert.equal(budget.state.requests, 1); assert.equal(budget.state.attempts, 1);
});


test('reviewed web paths require explicit literal modes and reject missing, automatic or derived-model options', () => {
  const webPolicy = { allowed_tools: ['get_search_content', 'source_check', 'web_search', 'fetch_content'], blocked_tools: [], blocked_parameters: [
    { tool: 'source_check', path: ['provider'], when: 'not_equal', value: 'brave', reason: 'Reviewed direct provider only.' },
    { tool: 'source_check', path: ['fetchContent'], when: 'truthy', reason: 'No extra content route.' },
    { tool: 'web_search', path: ['provider'], when: 'not_equal', value: 'brave', reason: 'Reviewed direct provider only.' },
    { tool: 'web_search', path: ['workflow'], when: 'not_equal', value: 'none', reason: 'No generated workflow.' },
    { tool: 'web_search', path: ['includeContent'], when: 'truthy', reason: 'No extra content route.' },
    { tool: 'web_search', path: ['model'], when: 'present', reason: 'No derived model.' },
    { tool: 'fetch_content', path: ['mode'], when: 'not_equal', value: 'raw', reason: 'Reviewed raw route only.' },
    ...['auth', 'prompt', 'model', 'answerModel', 'forceClone', 'frames', 'timestamp'].map(key => ({ tool: 'fetch_content', path: [key], when: 'present', reason: 'Outside the reviewed raw route.' })),
  ] };
  const assess = (toolName, input) => assessProfileToolCall(webPolicy, { toolName, input });
  for (const [tool, input] of [['get_search_content', {}], ['source_check', { provider: 'brave', fetchContent: false }],
    ['web_search', { provider: 'brave', workflow: 'none', includeContent: false }], ['fetch_content', { mode: 'raw' }]]) assert.equal(assess(tool, input), null);
  for (const [tool, input] of [['source_check', {}], ['source_check', { provider: 'auto' }], ['source_check', { provider: 'brave', fetchContent: true }],
    ['web_search', { provider: 'brave' }], ['web_search', { provider: 'auto', workflow: 'none' }], ['web_search', { provider: 'brave', workflow: 'auto-summary' }],
    ['web_search', { provider: 'brave', workflow: 'none', includeContent: true }], ['web_search', { provider: 'brave', workflow: 'none', model: null }],
    ['fetch_content', {}], ['fetch_content', { mode: 'readable' }], ['fetch_content', { mode: false }], ['fetch_content', { mode: ['raw'] }]]) assert.equal(assess(tool, input)?.rule, 'blocked_parameter');
  for (const key of ['auth', 'prompt', 'model', 'answerModel', 'forceClone', 'frames', 'timestamp']) assert.equal(assess('fetch_content', { mode: 'raw', [key]: false })?.rule, 'blocked_parameter');
});

test('runtime selection rejects explicit empty resource profiles while absence preserves bare mode', () => {
  const config = { version: 1, runRoot: '/owned/run', buildRoot: '/owned/build', workspace: '/owned/run/workspace', agentDir: '/owned/run/agent', controlDir: '/owned/run/control',
    mode: 'broker', model: { api: 'openai-completions', provider: 'fixture', id: 'fixture', baseUrl: 'http://127.0.0.1:9', parameters: { maxTokens: 128, thinkingLevel: 'off' } },
    turns: [{ id: 'one', prompt: 'Synthetic fixture.' }], correlation: { run_id: 'fixture', episode_id: 'fixture' }, codeMode: { policy: 'free', models: false, toolSearchEnabled: false },
    visibility: '/owned/run/visibility.json', admission: { captureOnly: true }, limits };
  assert.equal(validateEpisodeConfig(config), config);
  for (const resourceProfile of [null, false, '']) assert.throws(() => validateEpisodeConfig({ ...config, resourceProfile }), /RESOURCE_PROFILE_REFERENCE_REQUIRED/);
});


test('SDK-relative MCP identity rejects missing or unknown export conditions instead of bypassing exports', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-mcp-exports-')));
  const module = join(root, 'sdk/dist/index.js'), packageRoot = join(root, 'sdk/node_modules/@earendil-works/pi-mcp');
  await mkdir(dirname(module), { recursive: true }); await writeFile(module, 'export {};\n');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(packageRoot, 'dist/index.js'), 'export const identity = 1;\n');
  await writeFile(join(root, 'outside.js'), 'export {};\n');
  const base = { name: '@earendil-works/pi-mcp', type: 'module', version: 'fixture', exports: { '.': { source: './src/index.ts', types: './dist/index.d.ts', import: './dist/index.js' } } };
  const write = value => writeFile(join(packageRoot, 'package.json'), JSON.stringify(value));
  await write(base);
  assert.equal((await sdkMcpImportEntry(module, '@earendil-works/pi-mcp')).entry, join(packageRoot, 'dist/index.js'));
  await assert.rejects(sdkMcpImportEntry(module, '@earendil-works/pi-mcp/oauth'), /PI_MCP_IMPORT_EXPORT_REQUIRED/);
  for (const exported of [{ types: './dist/index.d.ts' }, { node: './dist/index.js', import: './dist/index.js' }, './dist/index.js', ['./dist/index.js']]) {
    await write({ ...base, exports: { '.': exported } });
    await assert.rejects(sdkMcpImportEntry(module, '@earendil-works/pi-mcp'), /PI_MCP_IMPORT_EXPORT_REQUIRED/);
  }
  for (const target of ['./../../../../outside.js', './dist/../dist/index.js', './node_modules/other/index.js', './dist/index.js?alternate']) {
    await write({ ...base, exports: { '.': { import: target } } });
    await assert.rejects(sdkMcpImportEntry(module, '@earendil-works/pi-mcp'), /PI_MCP_IMPORT_TARGET/);
  }
  await write({ ...base, exports: { '.': { import: './dist/missing.js' } } });
  await assert.rejects(sdkMcpImportEntry(module, '@earendil-works/pi-mcp'), { code: 'ENOENT' });
});


test('builtin capture binds reviewed raw names to observed identities before credential redaction', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-builtin-identity-')));
  const recorder = await createEpisodeRecorder(join(root, 'evidence'), { run_id: 'synthetic-builtin-identity' }, ['search']);
  const installation = { root: '/fixture/pi-coding-agent', files: ['codemode', 'tool-search', 'mcp'].map((name, index) => ({
    path: '/fixture/pi-coding-agent/dist/extensions/' + name + '/index.js',
    realpath: '/fixture/pi-coding-agent/dist/extensions/' + name + '/index.js', sha256: String(index + 1).repeat(64), bytes: index + 1,
  })) };
  try {
    for (const [index, name] of ['codemode', 'tool_search', 'mcp'].entries()) {
      const entry = await captureExtensionEntry('builtin:' + name, installation);
      assert.equal(entry, installation.files[index]);
      const evidence = recorder.project({ path: 'builtin:' + name, entry }, {});
      assert.equal(evidence.entry.sha256, installation.files[index].sha256);
      if (name === 'tool_search') {
        assert.equal(evidence.path, 'builtin:tool_REDACTED_CREDENTIAL');
        assert.equal(evidence.entry.path, '/fixture/pi-coding-agent/dist/extensions/tool-REDACTED_CREDENTIAL/index.js');
      }
    }
    assert.equal(await captureExtensionEntry('<inline:benchmark-observer>', installation), null);
    await assert.rejects(captureExtensionEntry('builtin:unknown', installation), /BUILTIN_IMPLEMENTATION_UNREVIEWED/);
    await assert.rejects(captureExtensionEntry('builtin:tool_REDACTED_CREDENTIAL', installation), /BUILTIN_IMPLEMENTATION_UNREVIEWED/);
    await assert.rejects(captureExtensionEntry('builtin:mcp', { ...installation, files: installation.files.slice(0, 2) }), /BUILTIN_IMPLEMENTATION_UNOBSERVED/);
    await assert.rejects(captureExtensionEntry('builtin:codemode', { ...installation, files: [...installation.files, installation.files[0]] }), /BUILTIN_IMPLEMENTATION_UNOBSERVED/);
    const extension = join(root, 'extension.mjs'); await writeFile(extension, 'export default () => {};\n');
    assert.deepEqual(await captureExtensionEntry(extension, installation), await fileIdentity(extension));
  } finally { await recorder.close(); }
});
