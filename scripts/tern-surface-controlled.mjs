#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const controlledModel = 'tern-surface-controlled/delivery';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });

// Serialized into a host-loaded TypeScript extension. The host resolves pi-ai
// through its official extension loader; no product bundle or imitation stream.
function install(api, settings, fs, crypto, createStream) {
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const record = value => fs.appendFileSync(settings.output, JSON.stringify({ at: new Date().toISOString(), model: settings.model, ...value }) + '\n', { mode: 0o600 });
  const normalized = text => text.replace(/^\s*\d+[:|]\s?/gm, '').replace(/\s+/g, ' ').trim();
  const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  const includes = (value, text) => strings(value).some(item => normalized(item).includes(normalized(text)));
  const images = value => !value || typeof value !== 'object' ? [] : [...(value.type === 'image' ? [hash(JSON.stringify(value))] : []), ...Object.values(value).flatMap(images)];
  const secretValues = Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL/i.test(key) && typeof value === 'string' && value.length >= 4).map(([, value]) => value);
  const redact = value => {
    if (typeof value === 'string') return secretValues.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
    if (Array.isArray(value)) return value.map(redact);
    return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /authorization|api.?key|token|secret|password|cookie/i.test(key) ? '[REDACTED]' : redact(item)])) : value;
  };
  const check = model => { if (`${model?.provider}/${model?.id}` !== settings.model) throw new Error('Controlled provider requires its isolated delivery model'); };
  const readPinned = (path, expected) => {
    const bytes = fs.readFileSync(path);
    if (hash(bytes) !== expected) throw new Error('Controlled fixture bytes changed after generation');
    return bytes.toString('utf8');
  };
  let turn = 0;
  api.on('session_start', (_event, ctx) => { check(ctx.model); api.setActiveTools(['read']); record({ phase: 'controlled-selected' }); });
  api.on('tool_call', event => {
    if (event.toolName !== 'read' || event.input?.path !== settings.memberPath) return { block: true, reason: 'Controlled provider permits only its pinned local fixture member read' };
    record({ phase: 'controlled-tool-call', toolCallId: event.toolCallId, path: settings.memberPath });
  });
  const streamSimple = (model, context, options) => {
    check(model);
    const stream = createStream();
    const output = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    queueMicrotask(() => {
      try {
        const contextHash = hash(JSON.stringify(context));
        record({ phase: 'controlled-input', request: ++turn, contextHash, snapshot: redact(context), inputHash: settings.inputHash, projectedInputHash: settings.projectedInputHash, inputProjection: settings.inputProjection, memberHash: settings.memberHash });
        if (options?.signal?.aborted) throw new Error('Controlled request aborted');
        const messages = context.messages;
        if (!Array.isArray(messages)) throw new Error('Official provider context.messages contract unavailable');
        const sourceInput = readPinned(settings.inputPath, settings.inputHash);
        // Exact public Broker renderSkillRecord/escapeText projection. Select it
        // explicitly; never weaken a failed raw comparison into an inferred pass.
        const input = settings.inputProjection === 'broker-xml-text' ? sourceInput.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : sourceInput;
        if (hash(input) !== settings.projectedInputHash) throw new Error('Pinned input projection changed');
        const member = readPinned(settings.memberPath, settings.memberHash);
        const lastUser = messages.findLastIndex(message => message.role === 'user');
        const taskUser = settings.task ? messages.findLastIndex(message => message.role === 'user' && includes(message.content, settings.task)) : lastUser;
        const dispatchEnd = messages.findIndex((message, index) => index > taskUser && message.role === 'assistant');
        const delivered = messages.slice(0, dispatchEnd < 0 ? messages.length : dispatchEnd);
        if (lastUser < 0 || !includes(delivered, input)) throw new Error('Actual provider delivery omitted the pinned entry body');
        if (taskUser < 0) throw new Error('Actual provider delivery omitted the current user task');
        const occurrences = (value, needle) => strings(value).reduce((count, text) => count + normalized(text).split(normalized(needle)).length - 1, 0);
        const bodyCount = occurrences(delivered, input);
        if (bodyCount !== 1) throw new Error(`Actual provider delivery contains ${bodyCount} pinned entry bodies; expected exactly one`);
        const taskCount = settings.task ? occurrences(messages.slice(0, lastUser + 1).filter(message => message.role === 'user'), settings.task) : null;
        if (settings.task && taskCount !== 1) throw new Error(`Actual provider delivery contains ${taskCount} current user tasks; expected exactly one`);
        for (const text of settings.requiredText) if (!includes(messages, text)) throw new Error('Actual provider delivery omitted required fixture text');
        for (const text of settings.forbiddenText) if (includes(messages.slice(lastUser), text)) throw new Error('Current turn contains forbidden fixture text');
        const imageHashes = images(messages[taskUser]);
        if (imageHashes.length < settings.requiredImages) throw new Error('Actual current user input omitted required images');
        const callId = `controlled-member-${hash(JSON.stringify(messages[taskUser])).slice(0, 20)}`;
        const result = messages.slice(lastUser + 1).find(message => message.role === 'toolResult' && message.toolCallId === callId);
        record({ phase: 'controlled-delivery', request: turn, dispatch: result ? 'tool-followup' : 'initial-user-dispatch', contextHash, bodyCount, taskCount, inputHash: settings.inputHash, projectedInputHash: settings.projectedInputHash, memberHash: settings.memberHash, imageHashes, readResultPresent: Boolean(result) });
        if (!result) {
          if (messages.slice(lastUser + 1).some(message => message.role === 'assistant' && message.content?.some(block => block.type === 'toolCall' && block.id === callId))) throw new Error('Requested fixture read has no actual tool result');
          const call = { type: 'toolCall', id: callId, name: 'read', arguments: { path: settings.memberPath } };
          output.content = [call]; output.stopReason = 'toolUse';
          stream.push({ type: 'start', partial: output });
          stream.push({ type: 'toolcall_start', contentIndex: 0, partial: output });
          stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: output });
        } else {
          if (result.isError || !includes(result.content, member)) throw new Error('Actual fixture read result omitted pinned member bytes');
          record({ phase: 'verified', proof: 'controlled-provider-delivery-and-real-local-read', contextHash, inputHash: settings.inputHash, projectedInputHash: settings.projectedInputHash, inputProjection: settings.inputProjection, memberHash: settings.memberHash, toolCallId: callId, toolResultHash: hash(JSON.stringify(result)), imageHashes, realModel: false, liveNotion: false });
          const text = 'Controlled delivery verified.';
          output.content = [{ type: 'text', text }];
          stream.push({ type: 'start', partial: output });
          stream.push({ type: 'text_start', contentIndex: 0, partial: output });
          stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: output });
          stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: output });
        }
        stream.push({ type: 'done', reason: output.stopReason, message: output }); stream.end();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Controlled provider contract failed';
        record({ phase: 'controlled-rejected', reason: message });
        output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'; output.errorMessage = message;
        stream.push({ type: 'error', reason: output.stopReason, error: output }); stream.end();
      }
    });
    return stream;
  };
  api.registerProvider('tern-surface-controlled', { api: 'tern-surface-controlled-api', apiKey: 'isolated-fixture-no-secret', baseUrl: 'http://127.0.0.1:1', streamSimple, models: [{ id: 'delivery', name: 'Controlled delivery fixture', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 4096 }] });
}

/** Generate assets only. This function never launches a host or calls a service. */
export async function createControlledProvider(options) {
  const { directory, output, fixture, host = 'omp', hostContracts = {} } = options;
  assert.ok(['omp', 'pi'].includes(host), 'host must be omp or pi');
  for (const path of [directory, output, fixture?.inputPath ?? fixture?.memberPath, fixture?.memberPath]) assert.ok(typeof path === 'string' && isAbsolute(path), 'Owned output and fixture paths must be absolute');
  const inputPath = await realpath(fixture.inputPath ?? fixture.memberPath);
  const memberPath = await realpath(fixture.memberPath);
  const inputBytes = await readFile(inputPath), memberBytes = await readFile(memberPath);
  assert.ok(inputBytes.length && memberBytes.length, 'Pinned fixture entry and member must be nonempty');
  const inputProjection = fixture.inputProjection ?? 'raw';
  assert.ok(['raw', 'broker-xml-text'].includes(inputProjection), 'Unknown fixture delivery projection');
  const inputText = inputBytes.toString('utf8');
  const projectedInput = inputProjection === 'broker-xml-text' ? inputText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : inputText;
  const settings = { model: controlledModel, output, inputPath, inputHash: sha(inputBytes), inputProjection, projectedInputHash: sha(projectedInput), memberPath, memberHash: sha(memberBytes), task: fixture.task ?? '', requiredText: fixture.requiredText ?? [], forbiddenText: fixture.forbiddenText ?? [], requiredImages: fixture.requiredImages ?? 0 };
  assert.ok(Number.isInteger(settings.requiredImages) && settings.requiredImages >= 0);
  for (const texts of [settings.requiredText, settings.forbiddenText]) assert.ok(Array.isArray(texts) && texts.every(text => typeof text === 'string' && text.trim()));
  const contract = hostContracts[host] ?? {};
  const contractEvidence = [];
  for (const key of ['typesPath', 'loaderPath', 'streamModule']) if (contract[key]) {
    assert.ok(isAbsolute(contract[key]), `${key} must identify an official installed file`);
    const path = await realpath(contract[key]); contractEvidence.push({ role: key, path, sha256: sha(await readFile(path)) });
  }
  const importName = host === 'omp' ? '@oh-my-pi/pi-ai' : '@earendil-works/pi-ai';
  const controlledExtension = join(directory, `controlled-${host}.ts`);
  const controlledReceipt = join(directory, `controlled-${host}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const source = `// Generated controlled-provider fixture; official host loader owns dependency resolution.\nimport * as fs from 'node:fs';\nimport * as crypto from 'node:crypto';\nimport { createAssistantMessageEventStream } from '${importName}';\nexport default api => (${install.toString()})(api, ${JSON.stringify(settings)}, fs, crypto, createAssistantMessageEventStream);\n`;
  await writeFile(controlledExtension, source, { mode: 0o600, flag: 'wx' });
  const result = { version: 1, status: 'generated-not-run', host, model: controlledModel, controlledExtension, controlledReceipt, controlledOutput: output, controlledSha256: sha(source), fixture: settings, contractEvidence, evidenceGate: contract.note ?? null, hostReadinessGate: 'Before sending any input, the runner must observe the actual composer as the focused input and absence of startup/setup/provider dialogs. session_start or visible model name alone does not establish input readiness.', boundary: 'Official installed TypeScript product entry is supplied separately to the runner; deterministic custom provider validates delivered fixture content using explicit projection and whitespace normalization, then validates an actual read result. Source-byte, projected-input and actual-context hashes remain distinct. No host, real model, or Notion operation is executed by this generator.' };
  await save(controlledReceipt, result);
  return result;
}

const usage = 'Usage: node scripts/tern-surface-controlled.mjs --spec ABSOLUTE_JSON\nJSON: {directory,output,host:"omp"|"pi",fixture:{inputPath,inputProjection?:"raw"|"broker-xml-text",memberPath,task?,requiredText?,forbiddenText?,requiredImages?},hostContracts?:{omp|pi:{typesPath?,loaderPath?,streamModule?,note?}}}\nGenerates a host-loaded TS provider and receipt only; no host/model/service invocation.';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length || args.some(arg => ['--help', '-h', 'help'].includes(arg))) console.log(usage);
  else {
    assert.ok(args.length === 2 && args[0] === '--spec' && isAbsolute(args[1]), usage);
    console.log(JSON.stringify(await createControlledProvider(JSON.parse(await readFile(args[1], 'utf8'))), null, 2));
  }
}
