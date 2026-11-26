import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { fileIdentity, sha256 } from './episode-evidence.mjs';
import { codemodeExtensionOptions, createEpisodeBudget, guardedFetch, providerUsage } from './episode-policy.mjs';
import { awaitBrokerAdmission, finishEpisodeRequest, reserveEpisodeRequest } from './episode-runner.mjs';
import { providerReportedModel } from '../reported-model.mjs';

const pairedRoot = process.env.PAIRED_RUN_ROOT;
const fixtureUsage = { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 5 } };
const responsesUsage = { input_tokens: 100, output_tokens: 30, total_tokens: 130, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 }, output_tokens_details: { reasoning_tokens: 5 } };
const sse = object => 'data: ' + JSON.stringify(object) + '\n\n';

test('maintained Pi admission joins catalog then public metadata publication without forcing refresh', { skip: !pairedRoot && 'Run through the existing paired SDK proof; no provider or Notion request is made.', timeout: 30000 }, async () => {
  const run = JSON.parse(await readFile(join(pairedRoot, 'run.json'), 'utf8'));
  const piRoot = dirname(dirname(dirname(run.pi_launch.entry))), sdk = await import(pathToFileURL(join(piRoot, 'dist/index.js')).href);
  const directory = join(pairedRoot, 'admission-readiness-proof'), cwd = join(directory, 'workspace'), agentDir = join(directory, 'agent');
  await mkdir(cwd, { recursive: true }); await mkdir(agentDir);
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, modelsStorePath: join(agentDir, 'model-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider('readiness-proof', { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'controlled-unused-key', models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 256 }] });
  const catalog = Promise.withResolvers(), publication = Promise.withResolvers(), enteredProbe = Promise.withResolvers(), errors = [], commands = [], probes = [], evidence = [];
  let startup, ready = false, modelRequests = 0;
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [{ name: 'delayed-catalog-proof', factory: api => {
      api.on('session_start', () => { startup = catalog.promise.then(() => publication.promise).then(() => { ready = true; }); void startup; });
      api.registerCommand('context-broker', { description: 'Owned admission-readiness fixture.', handler: async args => {
        commands.push(args); assert.notEqual(args, 'refresh'); if (args === 'status') await catalog.promise;
      } });
      api.registerTool({ name: 'notion_list', description: 'Owned metadata publication fixture.', parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_id, input, signal, _update, ctx) {
          assert.deepEqual(input, {}); assert.equal(ctx.mode, 'rpc'); signal?.throwIfAborted();
          probes.push(input); enteredProbe.resolve(); await startup;
          return { content: [{ type: 'text', text: 'PREPARE_RESULT_MUST_NOT_REACH_MODEL' }], details: { ok: true, state: 'known', records: [] } };
        } });
      api.on('context_with_system', event => ({ messages: event.messages.map(message => message.role === 'system'
        ? { ...message, content: String(message.content) + '\n' + (ready ? 'OWNED_CATALOG_READY' : 'OWNED_CATALOG_PENDING') } : message) }));
    } }] });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, model: modelRuntime.getModel('readiness-proof', 'fixture'), thinkingLevel: 'off', sessionManager: sdk.SessionManager.inMemory(cwd) });
  session.agent.streamFunction = () => { modelRequests++; throw new Error('READINESS_PROOF_MODEL_FORBIDDEN'); };
  try {
    await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error) });
    const initial = [{ role: 'system', content: session.systemPrompt, timestamp: 0 }];
    // The old ordering takes a real SDK projection while startup publication is pending.
    const pending = await session.agent.transformContext(initial);
    assert.match(JSON.stringify(pending), /OWNED_CATALOG_PENDING/);
    const controller = new AbortController();
    const startupReady = awaitBrokerAdmission({ session, sources: [{ type: 'notion', id: 'notion' }], signal: controller.signal,
      record: (type, data) => evidence.push({ type, data }), save: async (name, result) => ({ artifact_id: name, result }) });
    catalog.resolve(); await enteredProbe.promise;
    assert.deepEqual(commands, ['status'], 'Status can return before host publication');
    let previewStarted = false;
    const projected = startupReady.then(() => { previewStarted = true; return session.agent.transformContext(initial); });
    await Promise.resolve(); assert.equal(previewStarted, false, 'The public metadata tool must await publication');
    publication.resolve();
    const complete = await projected;
    assert.match(JSON.stringify(complete), /OWNED_CATALOG_READY/);
    assert.doesNotMatch(JSON.stringify(complete), /OWNED_CATALOG_PENDING/);
    assert.doesNotMatch(JSON.stringify(complete), /PREPARE_RESULT_MUST_NOT_REACH_MODEL/);
    assert.equal(modelRequests, 0); assert.deepEqual(errors, []); assert.deepEqual(commands, ['status', 'roots', 'catalogs']);
    assert.deepEqual(probes, [{}]); assert.equal(evidence.at(-1).data.ok, true);
    await writeFile(join(directory, 'observed.json'), JSON.stringify({ version: 1,
      scope: 'Actual Pi SDK public metadata-tool/context-transform contract with controlled delayed publication; no live catalog or business result.',
      previous_order: pending, publication_before_preview: complete, commands, probes, evidence, provider_requests: modelRequests, notion_requests: 0,
      source: await fileIdentity(fileURLToPath(new URL('./episode-runner.mjs', import.meta.url))) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } finally { catalog.resolve(); publication.resolve(); await session.dispose(); }
});

test('admission metadata probe rejects unavailable tools, failed results, tool errors and cancellation', async t => {
  const sources = [{ type: 'notion', id: 'notion' }];
  for (const [name, definition, expected] of [
    ['missing tool', undefined, /ADMISSION_TOOL_UNAVAILABLE/],
    ['failed result', { execute: async () => ({ details: { ok: false } }) }, /STARTUP_UNAVAILABLE/],
    ['error result', { execute: async () => ({ isError: true, details: { ok: true } }) }, /STARTUP_UNAVAILABLE/],
    ['tool error', { execute: async () => { throw new Error('CONTROLLED_SOURCE_FAILURE'); } }, /CONTROLLED_SOURCE_FAILURE/],
  ]) await t.test(name, async () => {
    const commands = [], events = [];
    const session = { prompt: async command => commands.push(command), getToolDefinition: () => definition,
      extensionRunner: { createToolContext: () => ({}) } };
    await assert.rejects(awaitBrokerAdmission({ session, sources, record: (type, data) => events.push({ type, data }) }), expected);
    assert.deepEqual(commands, ['/context-broker status']);
    assert.ok(!events.some(event => event.type === 'admission_metadata_probe_end' && event.data.ok));
  });
  await t.test('current cancellation', async () => {
    const entered = Promise.withResolvers(), controller = new AbortController(), reason = new Error('CONTROLLED_CURRENT_CANCELLATION'), commands = [];
    const session = { prompt: async command => commands.push(command), getToolDefinition: () => ({ execute: async (_id, _input, signal) => {
      entered.resolve(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } }), extensionRunner: { createToolContext: () => ({}) } };
    const pending = awaitBrokerAdmission({ session, sources, signal: controller.signal });
    await entered.promise; controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    assert.deepEqual(commands, ['/context-broker status']);
  });
  await t.test('no enabled Notion source needs no metadata probe', async () => {
    const commands = [], session = { prompt: async command => commands.push(command), getToolDefinition: () => { throw new Error('UNEXPECTED_PROBE'); } };
    await awaitBrokerAdmission({ session, sources: [{ type: 'notion', id: 'disabled', enabled: false }, { type: 'local', id: 'local' }] });
    assert.deepEqual(commands, ['/context-broker status', '/context-broker roots', '/context-broker catalogs']);
  });
});

test('maintained Pi adapter and CodeMode apparatus proof over owned loopback HTTP', { skip: !pairedRoot && 'Run through shared paired-environment --target command; no public provider is contacted.', timeout: 30000 }, async () => {
  const run = JSON.parse(await readFile(join(pairedRoot, 'run.json'), 'utf8'));
  const piRoot = dirname(dirname(dirname(run.pi_launch.entry))), sdkEntry = join(piRoot, 'dist/index.js');
  const sdk = await import(pathToFileURL(sdkEntry).href);
  const proofRoot = join(pairedRoot, 'sdk-apparatus-proof'); await mkdir(proofRoot, { mode: 0o700 });
  const proof = { version: 1, kind: 'controlled-http-maintained-pi-adapter-proof', scope: 'apparatus-only-not-natural-route-or-business-benchmark', node_version: process.versions.node,
    pi_manifest: await fileIdentity(join(piRoot, 'package.json')), sdk_entry: await fileIdentity(sdkEntry),
    source_modules: await Promise.all(['openai-completions.js', 'openai-responses.js', 'openai-responses-shared.js'].map(name => fileIdentity(join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/api', name)))), cases: [] };
  let route, received = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    received.push({ path: request.url, body: JSON.parse(body), sha256: sha256(body) });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'controlled-' + received.length });
    if (route.api === 'openai-completions') {
      const base = { id: 'chatcmpl-controlled-' + received.length, object: 'chat.completion.chunk', created: 0,
        ...(route.omitReported ? {} : { model: route.reportedModel ?? 'fixture' }) };
      if (route.nested && received.length === 1) {
        const code = 'const result = await tools.read({path:"probe.txt"}); console.log(result); throw new Error("intentional parent failure after child success");';
        response.write(sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'outer-call', type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code }) } }] }, finish_reason: null }] }));
        response.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
      } else {
        response.write(sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Controlled fixture complete.' }, finish_reason: null }] }));
        response.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
      }
      response.write(sse({ ...base, choices: [], usage: fixtureUsage })); response.end('data: [DONE]\n\n');
    } else {
      const base = { id: 'resp-controlled', object: 'response', created_at: 0, model: route.reportedModel ?? 'fixture', output: [] };
      const item = { id: 'msg-controlled', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Controlled fixture complete.', annotations: [] }] };
      for (const event of [
        { type: 'response.created', response: { ...base, status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: 'Controlled fixture complete.' },
        { type: 'response.output_text.done', output_index: 0, item_id: item.id, content_index: 0, text: 'Controlled fixture complete.' },
        { type: 'response.content_part.done', output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { ...base, status: 'completed', output: [item], usage: responsesUsage } },
      ]) response.write('event: ' + event.type + '\n' + sse(event));
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const scenario of [{ id: 'guard-and-census', api: 'openai-completions', guard: true }, { id: 'completions-and-nested', api: 'openai-completions', nested: true }, { id: 'responses', api: 'openai-responses' },
      { id: 'required-completions-and-nested', api: 'openai-completions', policy: 'required', nested: true },
      { id: 'required-responses', api: 'openai-responses', policy: 'required' },
      { id: 'off-completions', api: 'openai-completions', policy: 'off' },
      { id: 'off-responses', api: 'openai-responses', policy: 'off' },
      { id: 'completions-reported-mismatch', api: 'openai-completions', nested: true, enforceReported: true, reportedModel: 'wrong-variant' },
      { id: 'completions-reported-missing', api: 'openai-completions', nested: true, enforceReported: true, omitReported: true },
      { id: 'responses-reported-mismatch', api: 'openai-responses', enforceReported: true, reportedModel: 'wrong-variant' }]) {
      route = scenario; received = [];
      const directory = join(proofRoot, scenario.id), cwd = join(directory, 'workspace'), agentDir = join(directory, 'agent');
      await mkdir(cwd, { recursive: true }); await mkdir(agentDir); await writeFile(join(cwd, 'probe.txt'), 'SDK owned nested read fixture.\n');
      const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: 'off', transport: 'sse' });
      const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, modelsStorePath: join(agentDir, 'model-store.json'), allowModelNetwork: false, refreshOnCreate: false });
      modelRuntime.registerProvider('benchmark-loopback', { baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', api: scenario.api, apiKey: 'controlled-local-only-key', models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 256 }] });
      const extensionErrors = [], events = [], providerEvents = [], payloads = [];
      const requests = [], runtimeRecords = [], routing = { mode: 'fixed-route', model_variant: 'fixture', reported_model_ids: ['fixture'] };
      const budget = createEpisodeBudget({ wallTimeMs: 30000, maxModelRequests: 10, maxToolCalls: 40, maxHttpAttempts: 10,
        maxInputTokens: 300000, maxOutputTokens: 16000, maxTotalTokens: 316000 });
      let currentRequest, identityStop;
      const record = (type, data) => { runtimeRecords.push({ type, data: structuredClone(data) }); return { artifact_id: 'observed', pointer: '/runtime_records/' + (runtimeRecords.length - 1) }; };
      const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: ['builtin:codemode', 'builtin:tool_search'], extensionFactories: [
          { name: 'codemode', builtin: true, factory: sdk.createCodemodeExtension(codemodeExtensionOptions(scenario.policy ?? 'free')) },
          { name: 'tool_search', builtin: true, factory: sdk.createToolSearchExtension() },
          { name: 'silent-proof', factory: api => { api.on('context_with_system', event => ({ messages: event.messages.map(message => message.role === 'system' ? { ...message, content: String(message.content) + '\nCONTROLLED_SILENT_EXTENSION' } : message) })); if (scenario.guard) api.on('before_provider_request', () => { throw new Error('CONTROLLED_EXTENSION_THROW'); }); } },
        ] });
      await loader.reload();
      const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, model: modelRuntime.getModel('benchmark-loopback', 'fixture'), thinkingLevel: 'off', tools: [scenario.policy === 'off' ? '-codemode' : '+codemode', '+tool_search'], sessionManager: sdk.SessionManager.inMemory(cwd) });
      session.subscribe(event => {
        events.push(event);
        if (scenario.enforceReported && currentRequest && event.type === 'message_end' && event.message.role === 'assistant') {
          currentRequest.assistant = { stop_reason: event.message.stopReason, error: event.message.errorMessage ?? null };
          finishEpisodeRequest({ request: currentRequest, budget, routing, record, onStop: error => { identityStop ??= error; } });
        }
      });
      try {
        await session.bindExtensions({ onError: error => extensionErrors.push(error) });
        const initial = [{ role: 'system', content: session.systemPrompt, toolsAdded: session.agent.state.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })), timestamp: 0 }];
        const preview = await session.agent.transformContext(initial);
        const original = session.agent.streamFunction;
        session.agent.streamFunction = async (model, context, options = {}) => {
          let request;
          if (scenario.enforceReported) {
            const sequence = reserveEpisodeRequest({ budget, captureOnly: false, priorStop: identityStop,
              clearRequest: () => { currentRequest = undefined; }, onStop: error => { identityStop ??= error; } });
            request = { id: 'request-' + sequence, attempts: [], accounted: false, usage: null };
            requests.push(request); currentRequest = request;
          }
          return original(model, context, { ...options, maxTokens: 256, maxRetries: 0,
          ...(request ? { fetch: guardedFetch({ request, model, budget, admitted: () => true, record }) } : {}),
          onPayload: async payload => { const replacement = await options.onPayload?.(payload, model), final = replacement === undefined ? payload : replacement; payloads.push(final); if (scenario.guard) throw new Error('CONTROLLED_OUTER_TRANSPORT_GUARD'); return final; },
          onProviderStreamEvent: async (event, observedModel) => {
            providerEvents.push(event);
            if (request) {
              const observed = providerReportedModel(observedModel.api, event), attempt = request.attempts.find(item => item.id === request.current_attempt_id);
              if (observed && attempt) (attempt.reported_model_observations ??= []).push({ ...observed, ref: { artifact_id: 'observed', pointer: '/provider_events/' + (providerEvents.length - 1) } });
              const usage = providerUsage(observedModel.api, event); if (usage) request.usage = usage;
            }
            await options.onProviderStreamEvent?.(event, observedModel);
          },
        }); };
        await session.prompt('Run the owned controlled apparatus fixture.'); await session.waitForIdle();
        if (scenario.enforceReported && !scenario.nested) { await session.prompt('Attempt the controlled follow-up.'); await session.waitForIdle(); }
        const assistants = events.filter(event => event.type === 'message_end' && event.message.role === 'assistant').map(event => event.message);
        const result = { ...scenario, extensions: loader.getExtensions().extensions.map(extension => ({ path: extension.path, handlers: [...extension.handlers.keys()], tools: [...extension.tools.keys()] })), preview_contains_marker: JSON.stringify(preview).includes('CONTROLLED_SILENT_EXTENSION'), payloads, provider_events: providerEvents, events, received: [...received], extension_errors: extensionErrors, assistants,
          ...(scenario.enforceReported ? { tracked_requests: requests, runtime_records: runtimeRecords, budget: budget.state, identity_stop: identityStop?.code ?? null } : {}) };
        await writeFile(join(directory, 'observed.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        const artifact = await fileIdentity(join(directory, 'observed.json'), scenario.id);
        assert.equal(result.preview_contains_marker, true); assert.ok(result.extensions.some(extension => extension.path.includes('silent-proof')));
        for (const payload of payloads) {
          const names = payload.tools.map(tool => tool.function?.name ?? tool.name);
          assert.equal(names.includes('codemode'), scenario.policy !== 'off');
          assert.equal(names.includes('read'), scenario.policy !== 'required');
          assert.equal(names.includes('bash'), scenario.policy !== 'required');
          assert.equal(names.includes('write'), scenario.policy !== 'required');
          assert.equal(names.includes('tool_search'), true, 'Model-only discovery remains declared in Pi only mode');
          if (scenario.policy === 'required') {
            const description = payload.tools.find(tool => (tool.function?.name ?? tool.name) === 'codemode');
            assert.match(description.function?.description ?? description.description, /read\(/);
          }
        }
        if (scenario.guard) {
          assert.equal(received.length, 0); assert.equal(payloads.length, 1); assert.equal(extensionErrors.length, 1);
          assert.match(assistants.at(-1).errorMessage, /CONTROLLED_OUTER_TRANSPORT_GUARD/);
        } else if (scenario.enforceReported) {
          assert.equal(received.length, 1); assert.equal(requests.length, 1); assert.equal(payloads.length, 1);
          assert.equal(identityStop?.code, scenario.omitReported ? 'BENCHMARK_REPORTED_MODEL_MISSING' : 'BENCHMARK_REPORTED_MODEL_MISMATCH');
          assert.deepEqual([budget.state.input_tokens, budget.state.output_tokens, budget.state.tokens], [100, 30, 130]);
          assert.equal(requests[0].usage.complete_for_token_budget, true);
          assert.equal(requests[0].assistant.stop_reason, scenario.nested ? 'toolUse' : 'stop');
          assert.equal(currentRequest, undefined); assert.equal(budget.state.requests, 1); assert.equal(budget.state.attempts, 1);
          assert.equal(runtimeRecords.find(item => item.type === 'request_usage_accounted').data.budget.tokens, 130);
          assert.ok(assistants.some(message => message.stopReason === 'error'));
        } else {
          assert.equal(received.length, scenario.nested ? 2 : 1);
          const normalized = assistants.at(-1).usage;
          assert.deepEqual([normalized.input, normalized.output, normalized.cacheRead, normalized.cacheWrite, normalized.reasoning, normalized.totalTokens], [70, 30, 20, 10, 5, 130]);
          assert.ok(providerEvents.some(event => event.usage || event.response?.usage));
          if (scenario.nested) {
            const child = events.find(event => event.type === 'tool_execution_end' && event.parentToolCallId === 'outer-call');
            const parent = events.find(event => event.type === 'tool_execution_end' && event.toolCallId === 'outer-call');
            assert.equal(child?.toolName, 'read'); assert.equal(child.isError, false); assert.equal(parent?.isError, true);
          }
        }
        proof.cases.push({ id: scenario.id, status: 'passed', artifact, actual_http_requests: received.length, normalized_input_semantics: 'excludes_cache_read_write', normalized_output_semantics: 'includes_reasoning', provider_input_semantics: 'includes_cache', provider_output_semantics: 'includes_reasoning' });
      } finally { await session.abort(); session.dispose(); }
    }
    proof.status = 'passed';
  } catch (error) { proof.status = 'failed'; proof.error = String(error); throw error; }
  finally {
    await new Promise(resolve => server.close(resolve));
    await writeFile(join(proofRoot, 'adapter-evidence.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
});
