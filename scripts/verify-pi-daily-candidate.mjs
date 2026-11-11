import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { consumptionCostExtensionSource, readConsumptionCostEvents } from './skill-consumption-cost.mjs';
import { providerTransportExtensionSource, readProviderTransport, providerApplicationCompletion } from './skill-consumption-provider.mjs';
import { sourceObserverPreloadSource, readSourceObservation } from './skill-consumption-source-observer.mjs';
import { observeGraphSdk } from './notion-skill-graph-model-evidence.mjs';
import { observeOwnedObjectReads } from './notion-sdk-pi.mjs';
import { safeRequestMetrics } from './notion-default-context.mjs';
import { createOwnedGraphProject, retainGeneratedPlan } from './notion-skill-graph-project.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const hash = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = path => access(path).then(() => true, () => false);
const inside = (base, path) => { const rel = relative(base, path); return rel === '' || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,120}$/u.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const { parse: parseYaml } = createRequire(new URL('../packages/context-broker/package.json', import.meta.url))('yaml');

/** Inspect a fresh linear native session independently of the model's answer.
 * Forked histories need the host's branch projector, not this print-session check. */
export function inspectCandidatePrintSession(text, { provider, model, expectedUserMessages = 1 }) {
  assert.ok(Number.isSafeInteger(expectedUserMessages) && expectedUserMessages > 0);
  assert.ok(typeof text === 'string' && text.endsWith('\n'), 'Retain a complete native JSONL session');
  const rows = text.trimEnd().split('\n').map((line, index) => ({ value: JSON.parse(line), line: index + 1 }));
  assert.equal(rows[0]?.value.type, 'session');
  assert.ok(typeof rows[0].value.id === 'string' && !rows[0].value.parentSession, 'Use a fresh session, not a copied or forked history');
  const seen = new Set(), calls = new Map(), models = [], finals = [], userLines = [], projections = [];
  let previous = null;
  for (const { value: row, line } of rows.slice(1)) {
    assert.ok(typeof row.id === 'string' && !seen.has(row.id), 'Native entry identity is missing or duplicated');
    assert.equal(row.parentId, previous, 'This verifier only accepts a fresh linear session');
    seen.add(row.id); previous = row.id;
    if (row.type === 'model_change') {
      assert.equal(row.provider, provider); assert.equal(row.modelId, model);
      models.push({ line, provider: row.provider, model: row.modelId });
    }
    if (row.type === 'context_edit') {
      assert.ok(seen.has(row.targetId) && row.targetId !== row.id, 'Context replacement must point to an earlier native entry');
      projections.push({ line, targetId: row.targetId, sha256: hash(JSON.stringify(row.replacement)) });
      if (row.replacement === null) for (const call of calls.values()) {
        if (call.assistantEntryId === row.targetId) {
          assert.ok(['error', 'aborted'].includes(call.assistantStopReason) && call.resultLine === undefined,
            'Only a failed partial assistant call without a result can be classified as retracted');
          call.retractedLine = line;
        }
      }
    }
    if (row.type !== 'message') continue;
    const message = row.message;
    if (message.role === 'user') userLines.push(line);
    if (message.role === 'assistant') {
      assert.equal(message.provider, provider); assert.equal(message.model, model);
      for (const part of message.content ?? []) {
        if (part.type !== 'toolCall') continue;
        assert.ok(typeof part.id === 'string' && !calls.has(part.id), 'Tool calls must have unique native identities');
        assert.ok(typeof part.name === 'string' && part.arguments && typeof part.arguments === 'object');
        calls.set(part.id, { id: part.id, name: part.name, arguments: part.arguments, callLine: line,
          assistantEntryId: row.id, assistantStopReason: message.stopReason });
      }
      if (['stop', 'length', 'error', 'aborted'].includes(message.stopReason)) {
        const output = (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
        finals.push({ line, stopReason: message.stopReason, bytes: Buffer.byteLength(output), sha256: hash(output) });
      }
    }
    if (message.role === 'toolResult') {
      const call = calls.get(message.toolCallId);
      assert.ok(call && call.resultLine === undefined && call.retractedLine === undefined, 'A result must pair with exactly one earlier unretracted tool call');
      assert.equal(message.toolName, call.name);
      Object.assign(call, { resultLine: line, isError: message.isError === true,
        proofKinds: ['contextBrokerPreparation', 'contextBrokerRead', 'contextBrokerResource'].filter(key => message.details?.[key] !== undefined),
        resultSha256: hash(JSON.stringify(message.content)) });
    }
  }
  assert.ok(models.length > 0 && userLines.length === expectedUserMessages, 'Verify the exact print submissions with their recorded model');
  assert.ok(finals.length > 0 && finals.at(-1).stopReason === 'stop' && finals.at(-1).bytes > 0, 'A process exit is not a successful final model response');
  assert.ok([...calls.values()].every(call => call.resultLine !== undefined || call.retractedLine !== undefined), 'A native tool call has no terminal result or explicit failed-response retraction');
  return { version: 1, sessionId: rows[0].value.id, sha256: hash(text), bytes: Buffer.byteLength(text),
    lines: rows.length, models, userLines, calls: [...calls.values()].filter(call => call.retractedLine === undefined),
    retractedCalls: [...calls.values()].filter(call => call.retractedLine !== undefined), projections, finals,
    errors: [...calls.values()].filter(call => call.isError).map(call => ({ id: call.id, name: call.name, line: call.resultLine })),
    scope: 'fresh-native-session-identity-and-tool-flow; provider delivery and task semantics require separate observations' };
}

export function candidatePlan(config) {
  assert.equal(config.version, 1);
  assert.equal(config.scope, 'project-scoped-candidate-precheck');
  assert.ok(Array.isArray(config.turns) && config.turns.length > 0);
  assert.equal(new Set(config.turns.map(turn => turn.id)).size, config.turns.length);
  assert.equal(new Set((config.expectedBodies ?? []).map(body => body.sha256)).size, (config.expectedBodies ?? []).length, 'Freeze each distinct body hash once');
  for (const turn of config.turns) {
    assert.ok(identifier(turn.id) && typeof turn.prompt === 'string' && turn.prompt.trim());
    assert.ok(turn.cancel === undefined || ['consume', 'read', 'read-resources'].includes(turn.cancel.operation));
    for (const body of turn.bodies ?? []) {
      assert.ok(digest(body.sha256) && Number.isSafeInteger(body.occurrences) && body.occurrences >= 0);
      assert.ok((config.expectedBodies ?? []).some(expected => expected.sha256 === body.sha256), 'Every body assertion needs frozen source bytes');
    }
    assert.ok(turn.proofs === undefined || Array.isArray(turn.proofs) && turn.proofs.every(proof => proof && typeof proof === 'object' && !Array.isArray(proof) && Object.keys(proof).length));
  }
  return {
    version: 1, scope: config.scope, status: 'prepared_not_executed',
    sourceId: config.sourceId, database: config.database, turns: config.turns.map(({ id, prompt, cancel }) => ({ id, promptSha256: hash(prompt), cancel: cancel ?? null })),
    projectPackages: 'The old exact local Broker source is filtered; the immutable installed candidate autoloads from the owned project.',
    preserved: ['normal HOME and agentDir', 'all other packages', 'local Skill roots, rules and catalogs', 'normal MCP, context files, provider configuration and tools'],
    changes: ['owned project settings', 'owned source config with reviewed Notion entry and empty cache', 'owned sessions and source state'],
    observers: ['existing cost and Undici transport', 'existing SDK diagnostics and owned object reads', 'passive tool receipt and final-answer events'],
    notClaimed: ['global daily package activation', 'AH718 inventory acceptance', 'Mini', 'Notion UI', 'semantic task success without separate review'],
  };
}

export function candidateProjectSettings(oldSource, candidateRoot) {
  assert.ok(isAbsolute(oldSource) && isAbsolute(candidateRoot) && oldSource !== candidateRoot);
  return { packages: [{ source: oldSource, extensions: [] }, candidateRoot] };
}

export function candidateSourceConfig(original, { sourceId, database, cacheDir, viewId, noNotion = false }) {
  assert.ok(identifier(sourceId) && /^[a-f0-9-]{32,36}$/iu.test(database) && isAbsolute(cacheDir));
  assert.ok(viewId === undefined || typeof viewId === 'string' && /^[a-f0-9-]{32,36}$/iu.test(viewId), 'Use an explicit reviewed View ID');
  const config = structuredClone(original);
  const matches = (config.sources ?? []).filter(source => source.id === sourceId && source.type === 'notion');
  assert.equal(matches.length, 1, 'The reviewed existing Notion source must be unique');
  assert.ok((config.sources ?? []).filter(source => source.type === 'notion' && source.enabled !== false).every(source => source === matches[0]),
    'Another enabled Notion source needs an explicit reviewed scope');
  assert.equal(matches[0].command, undefined, 'The candidate must use its bundled SDK');
  assert.ok(matches[0].prefetch === undefined || matches[0].prefetch === false, 'Do not silently alter daily prefetch');
  if (matches[0].database !== database && viewId === undefined)
    assert.equal(matches[0].default_view_id, undefined, 'A daily View cannot be carried into a different test library');
  for (const key of ['skillRoots', 'extraSkillRoots', 'ruleRoots', 'discoveryCatalogs', 'extraDiscoveryCatalogs'])
    for (const path of config[key] ?? []) assert.ok(isAbsolute(path) || path.startsWith('~/'), 'Relative config paths need explicit scope review');
  Object.assign(matches[0], { database, cacheDir, ...(viewId === undefined ? {} : { default_view_id: viewId }), ...(noNotion ? { enabled: false } : {}) });
  return config;
}

/** A small shell subset for one frozen public author task.
 * The public CLI owns author decisions, operation identities and Store writes. */
export function reviewCandidateCliCommand(command, policy) {
  const check = (value, message) => { if (!value) throw new Error(message); };
  check(['original-create-recovery', 'owned-description-update'].includes(policy?.mode), 'Unknown public CLI task scope');
  check(typeof command === 'string' && !/[\r\n\0\\]/u.test(command), 'Use one plain public CLI command');
  const text = command.trim(), words = [], token = /\s*(?:'([^']*)'|"([^"$`\\]*)"|([^\s'"\\;&|`<>$()*?\[\]{}!~]+))/uy;
  let at = 0;
  while (at < text.length) {
    token.lastIndex = at; const match = token.exec(text);
    check(match && match.index === at && (token.lastIndex === text.length || /\s/u.test(text[token.lastIndex])), 'Shell composition is outside this task');
    words.push(match[1] ?? match[2] ?? match[3]); at = token.lastIndex;
  }
  check(words[0] === 'node' && words[1] === policy.entry.path, 'Use the exact frozen public Node CLI entry');
  const args = words.slice(2);
  if (args.at(-1) === '--help') {
    check(args.slice(0, -1).every(arg => /^[a-z][a-z-]*$/u.test(arg)), 'Help must contain only a public command path');
    return { kind: 'help', argv: words };
  }
  if (args[0] === 'schema') {
    check(args.slice(1).every(arg => /^[a-z][a-z-]*$/u.test(arg)), 'Schema inspection must name only a public command path');
    return { kind: 'schema', argv: words };
  }
  if (args.slice(0, 3).join(' ') === 'ctl operation show') {
    check(policy.mode === 'original-create-recovery' && args.length === 4 && args[3] === policy.operationId, 'Inspect only the original operation');
    return { kind: 'operation-show', argv: words };
  }
  const withinOutput = value => typeof value === 'string' && value.startsWith(policy.outputRoot + '/')
    && !value.split('/').some(part => part === '.' || part === '..') && !value.endsWith('/');
  const read = args[0] === 'read', files = args[0] === 'files', consumer = read || files;
  const update = policy.mode === 'owned-description-update' && args[0] === 'update';
  if (!consumer && !update) {
    check(policy.mode === 'original-create-recovery', 'Only the exact description update is authorized');
    check(args.slice(0, 4).join(' ') === 'ctl library create recovery' && ['review', 'apply', 'reconcile'].includes(args[4]), 'Only the original create recovery is authorized');
  }
  const kind = consumer || update ? args[0] : args[4], flags = new Map(), positional = [];
  const boolean = new Set(read ? ['--json', '--metrics', '--read-only', '--refresh', '--offline'] : files ? ['--metrics', '--offline'] : update || kind === 'apply' ? ['--dry-run'] : []);
  const valued = new Set(read ? ['--database', '--output', '--path', '--from'] : files ? ['--database', '--path'] : update ? ['--database', '--description'] : ['--entry', '--max-requests', '--max-bytes', '--duration-ms',
    ...(kind === 'apply' ? ['--review', '--review-id'] : ['--target']), ...(kind === 'review' ? ['--output'] : [])]);
  for (let index = consumer || update ? 1 : 5; index < args.length; index++) {
    const flag = args[index];
    if (!flag.startsWith('-')) { positional.push(flag); continue; }
    check(!flags.has(flag), 'Duplicate CLI option');
    if (boolean.has(flag)) flags.set(flag, true);
    else { check(valued.has(flag) && typeof args[index + 1] === 'string' && !args[index + 1].startsWith('--'), 'Unknown public CLI option'); flags.set(flag, args[++index]); }
  }
  check(positional.length === 1, 'Use the single public target argument');
  check(flags.get(consumer || update ? '--database' : '--entry') === policy.database, 'Keep the exact reviewed library');
  if (update) {
    check(positional[0] === policy.target && typeof policy.description === 'string' && flags.get('--description') === policy.description,
      'Update only the original page to the exact authorized Description');
  } else if (consumer) {
    const owner = value => value === policy.target || value?.startsWith(policy.refPrefix);
    const relativeFile = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes(':')
      && !value.split('/').some(part => part === '' || part === '.' || part === '..');
    check(owner(positional[0]) || relativeFile(positional[0]) && flags.get('--from')?.startsWith(policy.refPrefix), 'Read only the original owner');
    if (flags.has('--from')) check(flags.get('--from').startsWith(policy.refPrefix) && relativeFile(positional[0]) && !flags.has('--path'), 'Resolve only an original owner relative file');
    if (flags.has('--path')) check(relativeFile(flags.get('--path')), 'Use an original owner relative file path');
    if (read) {
      check(flags.get('--json') && flags.get('--metrics'), 'Read output needs its public JSON and metrics flags');
      check(flags.get('--read-only'), 'Post-recovery inspection must prohibit remote writes');
    } else check(positional[0].startsWith(policy.refPrefix) && /[?&]snapshot=s_[a-f0-9]{64}(?:&|$)/u.test(positional[0])
      && flags.get('--metrics'), 'List only the original immutable owner pin with public metrics');
    check(!(flags.has('--refresh') && flags.has('--offline')), 'Use one public freshness policy');
  } else {
    check(positional[0] === policy.originalPlan.path, 'Use the original immutable plan');
    // These recovery commands always emit JSON with request_metrics; unlike
    // read, their public schema has no --json, --metrics or arbitrary --output.
    if (kind === 'apply') check(flags.has('--review') && flags.has('--review-id'), 'Use the saved public review and its exact identity');
    else check(flags.has('--target'), 'Keep the original main page');
    if (kind === 'review') check(flags.has('--output'), 'Save the complete public restoration review');
    for (const [flag, maximum] of [['--max-requests', 2000], ['--max-bytes', 134217728], ['--duration-ms', 300000]])
      if (flags.has(flag)) check(/^[1-9][0-9]*$/u.test(flags.get(flag)) && Number(flags.get(flag)) <= maximum, 'Keep the public recovery budget bounded');
  }
  if (flags.has('--target')) check(flags.get('--target') === policy.target, 'Keep the original main page');
  for (const flag of ['--output', '--review']) if (flags.has(flag)) check(withinOutput(flags.get(flag)), 'CLI files must stay in the owned output directory');
  if (flags.has('--review-id')) check(/^create-restore-[0-9a-f]{64}$/u.test(flags.get('--review-id')), 'Use the public review identity');
  return { kind, dryRun: flags.has('--dry-run'), argv: words };
}

export function candidateCliGuard(api, { fs, output, policy, review }) {
  const fd = fs.openSync(output, 'wx', 0o600);
  const approvedBashCalls = new Set(), publicOutputs = new Set(policy.inputFiles);
  api.on('tool_call', event => {
    try {
      if (event.toolName === 'bash') { review(event.input?.command, policy); approvedBashCalls.add(event.toolCallId); }
      else if (event.toolName === 'read') {
        const value = event.input?.path;
        if (!(publicOutputs.has(value) || typeof value === 'string' && value.startsWith(policy.outputRoot + '/') && !value.split('/').includes('..')))
          throw new Error('Read only the disclosed original artifacts or owned public CLI outputs');
      } else throw new Error('This bounded management task uses only public CLI and artifact reads');
      fs.writeSync(fd, JSON.stringify({ toolCallId: event.toolCallId, toolName: event.toolName, allowed: true }) + '\n');
    } catch (error) {
      fs.writeSync(fd, JSON.stringify({ toolCallId: event.toolCallId, toolName: event.toolName, allowed: false, reason: error.message }) + '\n');
      return { block: true, reason: error.message };
    }
  });
  api.on('tool_result', event => {
    const path = event.details?.fullOutputPath;
    if (event.toolName !== 'bash' || !approvedBashCalls.has(event.toolCallId) || event.details?.truncation?.truncated !== true
      || typeof path !== 'string' || !/^\/tmp\/pi-bash-[a-f0-9]{16}\.log$/u.test(path)) return;
    publicOutputs.add(path);
    fs.writeSync(fd, JSON.stringify({ phase: 'public-cli-output', sourceToolCallId: event.toolCallId, artifactPath: path, allowed: true }) + '\n');
  });
  api.on('session_shutdown', () => { fs.writeSync(fd, JSON.stringify({ complete: true }) + '\n'); fs.closeSync(fd); });
}

// This is a finite inventory vocabulary for the fixed owned application, not a
// shell parser. No content search, executable, substitution or outside path is admitted.
export function candidateProjectInspection(input, cwd, projectRoot) {
  if (typeof projectRoot !== 'string' || !/^\/private\/tmp\/notion-candidate-print-[A-Za-z0-9]+$/u.test(projectRoot)
    || cwd !== projectRoot || !input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['command', 'timeout'].includes(key))
    || typeof input.command !== 'string' || input.command.length > 512 || /[\r\n\0]/u.test(input.command)
    || input.timeout !== undefined && (!Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > 60)) return false;
  const commands = input.command.trim().split(/\s*&&\s*/u);
  if (!commands.length || commands.length > 3) return false;
  return commands.every(command => {
    const value = command.trim().replaceAll("'" + projectRoot + "'", '.').replaceAll('"' + projectRoot + '"', '.').replaceAll(projectRoot, '.');
    return value === 'pwd' || /^ls(?: -(?:l|a|la|al))?(?: \.)?$/u.test(value)
      || /^find \. -maxdepth [1-4] (?:-type f|-type d -o -type f)(?: \| head -(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200))?$/u.test(value);
  });
}

export function guardCandidateProject(api, { projectRoot, inspectProject }) {
  api.on('tool_call', (event, ctx) => {
    if (event.toolName === 'bash' && !inspectProject(event.input, ctx.cwd, projectRoot))
      return { block: true, reason: 'This owned project task permits only pwd, ls and bounded find inventory within its fixed cwd. Project execution, content search, outside paths and other shell commands remain blocked.' };
  });
}

// Receipt events retain Broker-owned metadata and rendered hashes. The optional
// payload directory retains complete provider input for an owned E2E audit;
// headers and authentication configuration are never collected. Exact body
// counts remain passive and are paired with actual Undici requests below.
export function candidatePayloadBodies(value, expectedBodies) {
  const strings = [];
  const content = item => {
    if (typeof item === 'string') strings.push(item);
    else if (Array.isArray(item)) item.forEach(content);
    else if (item && typeof item === 'object') {
      if ((item.type === undefined || ['text', 'input_text', 'output_text'].includes(item.type)) && typeof item.text === 'string') strings.push(item.text);
      else if (item.type === 'tool_result') content(item.content);
      else if (Array.isArray(item.parts)) content(item.parts);
    }
  };
  const message = item => { content(item?.content); content(item?.parts); if (item?.type === 'function_call_output') content(item.output); };
  for (const key of ['messages', 'contents']) if (Array.isArray(value?.[key])) value[key].forEach(message);
  if (typeof value?.input === 'string') content(value.input); else if (Array.isArray(value?.input)) value.input.forEach(message);
  for (const key of ['system', 'system_instruction', 'systemInstruction', 'instructions', 'systemPrompt']) content(value?.[key]);
  return expectedBodies.map(body => {
    const xml = body.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const encodings = [...new Set([body.text, xml, JSON.stringify(body.text).slice(1, -1), JSON.stringify(xml).slice(1, -1)])];
    const spans = [];
    strings.forEach((string, contentIndex) => {
      const candidates = [];
      for (const encoded of encodings) {
        let start = string.indexOf(encoded);
        while (start >= 0) { candidates.push({ contentIndex, start, end: start + encoded.length }); start = string.indexOf(encoded, start + encoded.length); }
      }
      candidates.sort((left, right) => left.start - right.start || right.end - left.end);
      let end = -1;
      for (const span of candidates) if (span.start >= end) { spans.push(span); end = span.end; }
    });
    return { sha256: body.sha256, bytes: body.bytes, occurrences: spans.length, spans };
  });
}

export function observeCandidateTask(api, { fs, crypto, output, bodyFiles, inspectPayload, payloadDirectory, hostOutput, projectRoot, inspectProject }) {
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const oracleStarted = process.hrtime.bigint();
  const expectedBodies = bodyFiles.map(file => {
    const bytes = fs.readFileSync(file.path);
    if (sha(bytes) !== file.sha256 || bytes.length !== file.bytes || bytes.length === 0) throw new Error('Frozen body bytes changed');
    return { sha256: file.sha256, bytes: file.bytes, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
  });
  const fd = fs.openSync(output, 'wx', 0o600);
  const oracleReadMs = Number(process.hrtime.bigint() - oracleStarted) / 1e6;
  let turn = 0, sequence = 0, previous = null, errors = 0, closed = false, observerWorkNs = 0n, payloadNumber = 0;
  const record = (phase, fields = {}) => {
    const row = { sequence: ++sequence, previousSha256: previous, pid: process.pid, monotonicNs: process.hrtime.bigint().toString(), turn, phase, ...fields };
    row.eventSha256 = sha(JSON.stringify(row)); previous = row.eventSha256;
    fs.writeSync(fd, JSON.stringify(row) + '\n');
  };
  const text = content => typeof content === 'string' ? content : (Array.isArray(content) ? content : []).filter(part => part?.type === 'text').map(part => part.text).join('\n');
  const receipt = message => {
    if (!message || message.isError === true) return;
    const details = message.details;
    if (!details || typeof details !== 'object') return;
    const keys = ['contextBrokerPreparation', 'contextBrokerRead', 'contextBrokerResource'];
    const proofs = Object.fromEntries(keys.filter(key => details[key]).map(key => [key, details[key]]));
    if (message.role === 'custom' && ['context-broker', 'skill-prompt-message'].includes(message.customType)) proofs.custom = details;
    if (!Object.keys(proofs).length) return;
    const body = text(message.content);
    record('receipt', { toolName: message.toolName, toolCallId: message.toolCallId, customType: message.customType,
      content: { bytes: Buffer.byteLength(body), sha256: sha(body) }, proofs });
  };
  const on = (name, fn) => api.on(name, (event, ctx) => {
    if (closed) return;
    const started = process.hrtime.bigint();
    try { fn(event, ctx); } catch { errors++; record('observer_error', { event: name }); }
    finally { observerWorkNs += process.hrtime.bigint() - started; }
    // Always undefined: observation cannot block, transform or choose tools.
  });
  record('task_observer_start', { oracleReadMs, oracleSeededIntoSourceOrModel: false });
  if (hostOutput) api.on('session_start', (_event, ctx) => {
    fs.writeFileSync(hostOutput, JSON.stringify({ sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
      model: { provider: ctx.model?.provider, id: ctx.model?.id }, pid: process.pid,
      commands: api.getCommands().map(command => ({ name: command.name, source: command.source, sourceInfo: command.sourceInfo })) }) + '\n', { flag: 'wx', mode: 0o600 });
  });
  on('input', () => { turn++; record('input'); });
  on('context_with_system', event => { for (const message of event.messages ?? []) receipt(message); });
  on('before_provider_request', event => {
    const payload = JSON.stringify(event.payload), toolNames = (event.payload?.tools ?? []).map(tool => tool.function?.name ?? tool.name).filter(name => typeof name === 'string');
    const payloadFile = payloadDirectory ? payloadDirectory + '/payload-' + (++payloadNumber) + '.json' : undefined;
    if (payloadFile) fs.writeFileSync(payloadFile, payload, { flag: 'wx', mode: 0o600 });
    record('provider_payload', { sha256: sha(payload), bytes: Buffer.byteLength(payload), bodies: inspectPayload(event.payload, expectedBodies), toolNames,
      ...(payloadFile ? { payloadFile } : {}),
      notionCatalogPresent: payload.includes('<ntn-skills-view-catalog>'), notionGuidancePresent: payload.includes('<ntn-skills-guidance>') });
  });
  on('tool_call', (event, ctx) => {
    const input = event.input ?? {};
    const inspection = event.toolName === 'bash' && projectRoot && inspectProject?.(input, ctx?.cwd, projectRoot)
      ? { root: projectRoot, cwd: ctx.cwd, input } : undefined;
    const selectors = Object.fromEntries(['path', 'paths', 'ref', 'refs', 'query', 'id', 'ids'].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
    record('tool_call', { toolName: event.toolName, toolCallId: event.toolCallId, inputSha256: sha(JSON.stringify(input)), selectors,
      executionTool: ['bash', 'powershell', 'codemode', 'execute', 'eval'].includes(event.toolName),
      reviewedReadTool: Boolean(inspection) || ['read', 'grep', 'find', 'ls', 'notion_list', 'notion_use'].includes(event.toolName),
      ...(inspection ? { ownedProjectInspection: inspection } : {}) });
  });
  on('tool_result', event => { record('tool_result', { toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError === true }); receipt({ ...event, role: 'toolResult' }); });
  on('message_end', event => {
    const message = event.message;
    if (message?.role !== 'assistant' || !['stop', 'length', 'error', 'aborted'].includes(message.stopReason)) return;
    const value = text(message.content);
    record('assistant_final', { text: value, sha256: sha(value), bytes: Buffer.byteLength(value), stopReason: message.stopReason,
      success: ['stop', 'length'].includes(message.stopReason) && value.trim().length > 0 });
  });
  on('session_shutdown', () => { record('task_observer_end', { errors, complete: errors === 0, observerWorkMs: Number(observerWorkNs) / 1e6 }); closed = true; fs.closeSync(fd); });
}

export function containsProof(value, expected) {
  if (!value || typeof value !== 'object') return false;
  const matches = !Array.isArray(value) && Object.entries(expected).every(([key, item]) => item && typeof item === 'object'
    ? Object.hasOwn(value, key) && containsProof(value[key], item) : Object.hasOwn(value, key) && value[key] === item);
  return matches || Object.values(value).some(child => child && typeof child === 'object' && containsProof(child, expected));
}

export function validateCandidateTurn(turn, { costs, transport, tasks }, { approvedCliCalls = [] } = {}) {
  if (turn.toolCallCount !== undefined) {
    assert.ok(Number.isSafeInteger(turn.toolCallCount) && turn.toolCallCount >= 0);
    assert.equal(tasks.filter(event => event.phase === 'tool_call').length, turn.toolCallCount, 'Tool calls differ from this frozen turn intent');
  }
  const requests = costs.filter(event => event.phase === 'provider_request');
  const sent = transport.filter(event => event.phase === 'request_sent');
  assert.ok(requests.length, 'No actual provider request was observed');
  for (const request of requests) {
    const matched = sent.filter(event => event.requestBodySha256 === request.payload.sha256 && event.requestBodyBytes === request.payload.bytes);
    assert.equal(matched.length, 1, 'Provider hook payload must match one actually sent HTTP body');
    assert.ok(transport.some(event => event.phase === 'request_start' && event.id === matched[0].id && event.category === 'model'), 'Sent body did not belong to the selected model');
    const ended = transport.find(event => event.phase === 'request_end' && event.id === matched[0].id);
    const message = costs.find(event => event.phase === 'message_end' && event.request === request.request)?.message;
    assert.ok(providerApplicationCompletion(ended, message), 'Actual provider transport has no completed application response');
    assert.ok(tasks.some(event => event.phase === 'provider_payload' && event.sha256 === request.payload.sha256 && event.bytes === request.payload.bytes), 'Task body observer did not see the exact sent payload');
  }
  const last = requests.at(-1);
  const actual = tasks.filter(event => event.phase === 'provider_payload' && event.sha256 === last.payload.sha256).at(-1);
  for (const expected of turn.bodies ?? []) {
    const counted = actual.bodies.filter(body => body.sha256 === expected.sha256);
    assert.equal(counted.length, 1, 'Frozen body was not independently observed'); assert.equal(counted[0].occurrences, expected.occurrences);
    if (expected.occurrences > 0 && expected.receiptRequired !== false) {
      const observed = last.payload.verifiedBodyOccurrences.filter(body => body.sha256 === expected.sha256);
      assert.equal(observed.length, 1, 'Missing exact receipt-verified full body'); assert.equal(observed[0].occurrences, expected.occurrences);
    }
    if (expected.occurrences === 0) for (const event of tasks.filter(event => event.phase === 'provider_payload'))
      assert.equal(event.bodies.find(body => body.sha256 === expected.sha256)?.occurrences, 0, 'Forbidden full body reached an earlier provider request');
  }
  for (const proof of turn.proofs ?? []) assert.ok(tasks.some(event => event.phase === 'receipt' && containsProof(event.proofs, proof)), 'Required source/snapshot/file proof missing');
  if (turn.requireUse) assert.ok(tasks.some(call => call.phase === 'tool_call' && call.toolName === 'notion_use' && typeof call.toolCallId === 'string'
    && tasks.some(event => event.phase === 'tool_result' && event.toolCallId === call.toolCallId && event.isError === false)
    && tasks.some(event => event.phase === 'receipt' && event.toolCallId === call.toolCallId && event.proofs.contextBrokerPreparation?.toolCallId === call.toolCallId
      && event.proofs.contextBrokerPreparation.purpose === 'use')), 'Natural application did not complete this turn\'s notion_use');
  const projectInspections = tasks.filter(event => event.phase === 'tool_call' && event.toolName === 'bash'
    && turn.project === 'owned-ticket-service' && event.ownedProjectInspection
    && candidateProjectInspection(event.ownedProjectInspection.input, event.ownedProjectInspection.cwd, event.ownedProjectInspection.root)
    && hash(JSON.stringify(event.ownedProjectInspection.input)) === event.inputSha256);
  const executionCalls = tasks.filter(event => event.phase === 'tool_call' && event.executionTool && !projectInspections.includes(event));
  assert.equal(new Set(approvedCliCalls).size, approvedCliCalls.length);
  assert.equal(executionCalls.length, approvedCliCalls.length, 'The inspected Skill must not execute unreviewed scripts or binaries');
  assert.ok(executionCalls.every(event => event.toolName === 'bash' && approvedCliCalls.includes(event.toolCallId)));
  assert.equal(tasks.filter(event => event.phase === 'tool_call' && event.reviewedReadTool !== true && !approvedCliCalls.includes(event.toolCallId)).length, 0, 'An unreviewed tool cannot establish a read-only task');
  const final = tasks.filter(event => event.phase === 'assistant_final').at(-1);
  assert.ok(final?.success, 'This exact turn has no successful task answer');
  return { providerRequests: requests.length, lastPayloadSha256: last.payload.sha256, bodyOccurrences: actual.bodies, receiptVerifiedBodies: last.payload.verifiedBodyOccurrences,
    finalSha256: final.sha256, finalBytes: final.bytes, semanticReview: 'required', scriptExecutionToolCalls: executionCalls.length, ownedProjectInspectionToolCalls: projectInspections.length,
    ...(approvedCliCalls.length ? { authorizedPublicCliToolCalls: approvedCliCalls.length } : {}) };
}

/** Input has already passed readProviderTransport's complete ledger validation. */
export function candidateTransportCoverage(transport) {
  const end = transport.at(-1);
  assert.equal(end?.phase, 'transport_end');
  assert.equal(end.errors, 0, 'A transport observer error leaves task coverage unknown');
  const starts = transport.filter(event => event.phase === 'request_start');
  const incomplete = end.incompleteRequestIds.map(id => starts.find(event => event.id === id));
  assert.ok(incomplete.every(event => event && event.category === 'other'), 'A selected-model request has no terminal observation');
  return { scope: 'selected-model-and-separately-validated-source', allRequestsComplete: end.complete,
    model: { attempts: starts.filter(event => event.category === 'model').length, complete: true },
    other: { attempts: starts.filter(event => event.category === 'other').length, complete: incomplete.length === 0,
      unknownRequestIds: incomplete.map(event => event.id) } };
}

async function readRows(path) {
  if (!await exists(path)) return [];
  const text = await readFile(path, 'utf8');
  const end = text.lastIndexOf('\n');
  return end < 0 ? [] : text.slice(0, end).split('\n').filter(Boolean).map(JSON.parse);
}

async function waitUntil(check, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Requested observable boundary did not occur before deadline');
}

async function normalSnapshot(config, fileIdentity) {
  assert.ok(!process.env.PI_CODING_AGENT_DIR || await realpath(process.env.PI_CODING_AGENT_DIR) === await realpath(join(homedir(), '.pi/agent')));
  assert.ok(!process.env.CONTEXT_BROKER_CONFIG, 'Start from the normal source configuration');
  assert.ok(!process.env.NOTION_API_BASE_URL || process.env.NOTION_API_BASE_URL.replace(/\/$/u, '') === 'https://api.notion.com');
  const settingsPath = join(homedir(), '.pi/agent/settings.json'), settings = await json(settingsPath);
  const selected = settings.packages?.[config.packageIndex ?? 1];
  const oldSource = typeof selected === 'string' ? selected : selected?.source;
  assert.ok(isAbsolute(oldSource));
  assert.equal(await realpath(oldSource), await realpath(config.oldBrokerRoot), 'Daily Broker identity changed since review');
  const candidates = ['.yml', '.yaml', '.json'].map(ext => join(homedir(), '.pi/agent/context-broker/config' + ext));
  const sourcePath = (await Promise.all(candidates.map(async path => await exists(path) ? path : undefined))).find(Boolean);
  assert.ok(sourcePath);
  const source = parseYaml(await readFile(sourcePath, 'utf8'));
  const local = await fileIdentity(config.localSkill.path);
  assert.equal(local.sha256, config.localSkill.sha256, 'The real existing same-name local Skill changed');
  const context = [];
  for (const path of config.contextFiles ?? []) context.push(await fileIdentity(path));
  return { safe: { settings: await fileIdentity(settingsPath), source: await fileIdentity(sourcePath), oldSource,
    oldEntry: await fileIdentity(join(oldSource, 'src/index.ts')), oldRuntime: await fileIdentity(join(oldSource, 'dist/ntn-skills-runtime.json')),
    packages: settings.packages.length, otherPackagesSha256: hash(JSON.stringify(settings.packages.filter((_, index) => index !== (config.packageIndex ?? 1)))),
    local, context }, source, oldSource };
}

export async function runCandidate(config, { packageClosure, fileIdentity }) {
  const plan = candidatePlan(config);
  for (const key of ['brokerRoot', 'brokerArchive', 'brokerArchiveSha256', 'embeddedCliSha256', 'embeddedSdkSha256', 'cliRoot', 'cliArchive', 'cliArchiveSha256', 'cliEntrySha256', 'oldBrokerRoot', 'evidenceRoot'])
    assert.equal(typeof config[key], 'string', 'Missing final candidate artifact: ' + key);
  assert.equal(config.model, 'magpie/group/flash'); assert.equal(config.thinkingLevel, 'high');
  assert.ok(process.env.NOTION_API_TOKEN?.trim(), 'Owned source state requires the already inherited Notion credential');
  assert.ok(config.localSkill && isAbsolute(config.localSkill.path) && digest(config.localSkill.sha256) && identifier(config.localSkill.name));
  for (const body of config.expectedBodies ?? []) {
    assert.ok(isAbsolute(body.path) && digest(body.sha256) && Number.isSafeInteger(body.bytes) && body.bytes > 0);
    const actual = await fileIdentity(body.path); assert.equal(actual.sha256, body.sha256); assert.equal(actual.bytes, body.bytes);
  }
  assert.ok(isAbsolute(config.evidenceRoot) && !inside(root, config.evidenceRoot));
  const ownership = await fileIdentity(config.ownershipReceipt.path); assert.equal(ownership.sha256, config.ownershipReceipt.sha256);
  assert.ok(JSON.stringify(await json(ownership.path)).includes(config.database), 'Bind the owned fixture receipt to this exact database');
  const before = await normalSnapshot(config, fileIdentity);
  const broker = await packageClosure(config.brokerRoot, config.brokerArchive, config.brokerArchiveSha256);
  const cli = await packageClosure(config.cliRoot, config.cliArchive, config.cliArchiveSha256);
  const embedded = await fileIdentity(join(config.brokerRoot, 'dist/ntn-skills.mjs'));
  const sdk = await fileIdentity(join(config.brokerRoot, 'dist/ntn-skills-sdk.mjs'));
  const standalone = await fileIdentity(join(config.cliRoot, 'dist/ntn-skills.js'));
  const runtime = await json(join(config.brokerRoot, 'dist/ntn-skills-runtime.json'));
  assert.equal(embedded.sha256, config.embeddedCliSha256); assert.equal(sdk.sha256, config.embeddedSdkSha256);
  assert.equal(standalone.sha256, config.cliEntrySha256); assert.equal(runtime.cli_sha256, embedded.sha256); assert.equal(runtime.sdk_sha256, sdk.sha256);
  const artifactReceipt = await fileIdentity(config.artifactReceipt.path); assert.equal(artifactReceipt.sha256, config.artifactReceipt.sha256);
  const artifact = await json(artifactReceipt.path);
  assert.equal(artifact.status, 'passed'); assert.equal(artifact.host, 'pi'); assert.equal(artifact.buildInput.mode, 'explicit');
  assert.equal(artifact.buildInput.package, 'ntn-skills'); assert.equal(artifact.buildInput.cli.sha256, standalone.sha256);
  const cliManifestPath = join(config.cliRoot, 'package.json'), cliManifest = await json(cliManifestPath);
  const exportedSdk = cliManifest.exports?.['./sdk'], sdkImport = typeof exportedSdk === 'string' ? exportedSdk : exportedSdk?.import;
  assert.ok(typeof sdkImport === 'string' && sdkImport.startsWith('./'));
  const inputSdk = await fileIdentity(resolve(config.cliRoot, sdkImport)); assert.ok(inside(await realpath(config.cliRoot), inputSdk.realpath));
  assert.equal(artifact.buildInput.manifest.sha256, (await fileIdentity(cliManifestPath)).sha256);
  assert.equal(artifact.buildInput.sdk.sha256, inputSdk.sha256); assert.equal(artifact.runtime.cli.sha256, embedded.sha256); assert.equal(artifact.runtime.sdk.sha256, sdk.sha256);
  assert.equal(artifact.package.archive.sha256, broker.archive.sha256);
  const harness = await Promise.all([
    'scripts/verify-pi-daily-installation.mjs', 'scripts/verify-pi-daily-candidate.mjs', 'scripts/skill-consumption-cost.mjs',
    'scripts/skill-consumption-provider.mjs', 'scripts/skill-consumption-source-observer.mjs', 'scripts/notion-skill-graph-model-evidence.mjs',
    'scripts/notion-sdk-pi.mjs', 'scripts/notion-default-context.mjs',
    'packages/context-broker/scripts/context-broker-rpc-harness.mjs', 'packages/context-broker/scripts/context-broker-e2e-fixture.mjs',
  ].map(path => fileIdentity(join(root, path))));
  await mkdir(config.evidenceRoot, { recursive: true, mode: 0o700 });
  const evidence = await mkdtemp(join(config.evidenceRoot, 'daily-candidate-'));
  let previous;
  if (config.resumeFrom) {
    const receipt = await fileIdentity(config.resumeFrom.path); assert.equal(receipt.sha256, config.resumeFrom.sha256);
    assert.ok(inside(await realpath(config.evidenceRoot), receipt.realpath), 'Only an owned prior candidate run may be resumed');
    previous = await json(receipt.path);
    assert.equal(previous.scope, config.scope); assert.equal(previous.status, 'passed'); assert.equal(previous.plan.database, config.database);
    assert.equal(previous.artifacts.embedded.sha256, embedded.sha256); assert.equal(previous.artifacts.sdk.sha256, sdk.sha256);
    assert.ok(inside(previous.evidence, previous.session.artifact.path));
    const session = await fileIdentity(previous.session.artifact.path); assert.equal(session.sha256, previous.session.artifact.sha256);
  }
  const cwd = previous?.launch.cwd ?? join(evidence, 'workspace'), control = join(evidence, 'observation'), sessions = join(evidence, 'sessions'), responses = join(evidence, 'sdk-responses');
  for (const path of [cwd, join(cwd, '.pi'), control, sessions, responses]) await mkdir(path, { recursive: true, mode: 0o700 });
  const sourcePath = join(control, 'source.json'), sourceCache = join(cwd, 'broker-cache');
  const source = candidateSourceConfig(before.source, { sourceId: config.sourceId, database: config.database, cacheDir: sourceCache, noNotion: config.noNotion === true });
  const projectSettings = candidateProjectSettings(before.oldSource, config.brokerRoot);
  if (previous) assert.deepEqual(await json(join(cwd, '.pi/settings.json')), projectSettings, 'The original owned project package mapping changed');
  else await save(join(cwd, '.pi/settings.json'), projectSettings);
  await save(sourcePath, source); await save(join(evidence, 'config.json'), config); await save(join(evidence, 'broker-files.json'), broker); await save(join(evidence, 'cli-files.json'), cli);
  const clockId = randomUUID(), host = await resolveHost('pi');
  assert.ok(host.identity.includes('/@earendil-works/pi-coding-agent/'));
  const costs = join(control, 'cost.jsonl'), transport = join(control, 'transport.jsonl'), tasks = join(control, 'tasks.jsonl'), sourceLedger = join(control, 'source.jsonl'), sdkLedger = join(control, 'sdk.jsonl'), objects = join(control, 'objects.jsonl');
  const costExtension = join(control, 'cost.mjs'), transportExtension = join(control, 'transport.mjs'), taskExtension = join(control, 'tasks.mjs'), sourcePreload = join(control, 'source.mjs'), sdkPreload = join(control, 'sdk.mjs');
  await writeFile(costExtension, consumptionCostExtensionSource({ output: costs, checkoutRoot: root, runId: clockId, sampleId: 'daily-candidate', clockId }), { mode: 0o600, flag: 'wx' });
  await writeFile(transportExtension, providerTransportExtensionSource({ output: transport, checkoutRoot: root, clockId }), { mode: 0o600, flag: 'wx' });
  await writeFile(taskExtension, "import fs from 'node:fs'; import crypto from 'node:crypto';\nconst inspectPayload=" + candidatePayloadBodies.toString() + ';\nexport default api => (' + observeCandidateTask.toString() + ')(api,{fs,crypto,inspectPayload,output:' + JSON.stringify(tasks) + ',bodyFiles:' + JSON.stringify(config.expectedBodies ?? []) + '});\n', { mode: 0o600, flag: 'wx' });
  await writeFile(sourcePreload, sourceObserverPreloadSource({ output: sourceLedger, checkoutRoot: root, clockId, cliPath: embedded.realpath, ownerParentPid: process.pid, ownerEntry: host.path }), { mode: 0o600, flag: 'wx' });
  const state = join(cwd, 'ntn/state');
  await writeFile(sdkPreload, "import fs from 'node:fs'; import fsPromises from 'node:fs/promises'; import {channel} from 'node:diagnostics_channel'; import {createHash} from 'node:crypto'; import {syncBuiltinESMExports} from 'node:module'; import {isMainThread} from 'node:worker_threads';\n"
    + 'const hash=value=>createHash("sha256").update(value).digest("hex");\n' + safeRequestMetrics.toString() + '\n'
    + 'if(isMainThread&&process.ppid===' + process.pid + '){const sdk=(' + observeGraphSdk.toString() + ')({channel,fs,safeMetrics:safeRequestMetrics,paths:' + JSON.stringify({ ledger: sdkLedger, responses, outputRoot: sourceCache }) + '});\n'
    + 'const objects=(' + observeOwnedObjectReads.toString() + ')({fs,fsPromises,hash,objects:' + JSON.stringify(join(state, 'objects'))
    + ',record:row=>fs.appendFileSync(' + JSON.stringify(objects) + ',JSON.stringify({monotonicNs:process.hrtime.bigint().toString(),...row})+"\\n",{mode:0o600})});syncBuiltinESMExports();let done=false;const finish=()=>{if(!done){done=true;objects.finish();sdk.close();}};process.once("beforeExit",finish);process.once("exit",finish);}\n', { mode: 0o600, flag: 'wx' });
  const env = { ...process.env, CONTEXT_BROKER_CONFIG: sourcePath, NTN_SKILLS_HOME: state, NTN_SKILLS_CONFIG_HOME: join(cwd, 'ntn/config'), NTN_SKILLS_CACHE_HOME: join(cwd, 'ntn/cache'), NTN_SKILLS_DATA_HOME: join(cwd, 'ntn/data'), NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000',
    BROKER_E2E_PROCESS_LEDGER: join(evidence, 'owned-processes.jsonl'), NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + JSON.stringify(sourcePreload), '--import=' + JSON.stringify(sdkPreload)].filter(Boolean).join(' ') };
  const args = ['--approve', '--session-dir', sessions, '--model', config.model, '--thinking', config.thinkingLevel, '-e', costExtension, '-e', transportExtension, '-e', taskExtension];
  let resumedSession;
  if (previous) {
    resumedSession = join(sessions, basename(previous.session.artifact.path));
    await writeFile(resumedSession, await readFile(previous.session.artifact.path), { flag: 'wx', mode: 0o600 });
    args.push('--session', resumedSession);
  }
  const result = { version: 1, scope: config.scope, status: 'running', evidence, plan, ownership, host, hostArtifact: await fileIdentity(host.identity), harness, before: before.safe,
    artifacts: { brokerArchive: broker.archive, brokerFilesSha256: broker.sha256, cliArchive: cli.archive, embedded, sdk, standalone, inputSdk, runtime, artifactReceipt, buildInput: artifact.buildInput },
    launch: { cwd, args, normalHome: true, normalAgentDir: true, targetExtensionArgument: false, sourceCommandConfigured: false, normalTools: true, normalMcpAndContext: true, sourceStateStartsEmpty: !previous,
      resume: previous ? { source: previous.session.artifact, copiedOwnedSessionOnly: true, originalSessionPreserved: true, sourceCache: 'original-owned-warm-state' } : null },
    turns: config.turns.map(turn => ({ id: turn.id, status: 'not_run' })), semanticReview: 'required', globalDailyActivation: 'not_tested', modifications: { globalSettings: 0, dailySourceConfig: 0, credentialCopies: 0 } };
  await save(join(evidence, 'started.json'), result);
  let rpc;
  try {
    rpc = await startRpc({ host: 'pi', cwd, env, args, timeoutMs: config.rpcTimeoutMs ?? 300000 });
    const initial = await rpc.command('get_state');
    result.launch.readyNs = process.hrtime.bigint().toString(); result.launch.spawnReturnNs = rpc.lifecycle[0].monotonicNs;
    result.launch.readyAfterSpawnMs = Number(BigInt(result.launch.readyNs) - BigInt(result.launch.spawnReturnNs)) / 1e6;
    assert.equal(initial.model?.provider, 'magpie'); assert.equal(initial.model?.id, 'group/flash'); assert.equal(initial.thinkingLevel, 'high');
    result.session = { sessionId: initial.sessionId, sessionFile: initial.sessionFile };
    assert.ok(inside(sessions, resolve(initial.sessionFile)));
    const commands = (await rpc.command('get_commands')).commands;
    await save(join(evidence, 'commands.json'), commands.map(command => ({ name: command.name, source: command.source, sourceInfo: command.sourceInfo })));
    const registrations = commands.filter(command => command.name === 'context-broker');
    assert.equal(registrations.length, 1); const actualEntry = await fileIdentity(registrations[0].sourceInfo.path);
    assert.ok(inside(await realpath(config.brokerRoot), actualEntry.realpath));
    result.autoload = { source: registrations[0].source, sourceInfo: registrations[0].sourceInfo, actualEntry };
    result.localCommand = [];
    for (const command of commands.filter(command => command.source === 'skill' && command.name === 'skill:' + config.localSkill.name)) {
      if (!command.sourceInfo?.path) continue;
      if (await realpath(command.sourceInfo.path) === before.safe.local.realpath)
        result.localCommand.push({ name: command.name, source: command.source, sourceInfo: command.sourceInfo });
    }
    assert.ok(result.localCommand.length > 0, 'The real existing local Skill was not discovered by normal Pi');
    for (const [file, phase] of [[costs, 'observer_start'], [transport, 'transport_start'], [tasks, 'task_observer_start'], [sourceLedger, 'source_observer_start'], [sdkLedger, 'sdk-observer-start']])
      assert.equal((await readRows(file))[0]?.phase, phase, 'A required observer did not start; do not spend a model request without it');
    assert.equal((await readRows(objects))[0]?.kind, 'object_observer_start');
    for (let index = 0; index < config.turns.length; index++) {
      const turn = config.turns[index], startedNs = process.hrtime.bigint().toString();
      const receipt = result.turns[index]; receipt.status = 'running'; receipt.startedNs = startedNs;
      receipt.forbiddenObjectsBefore = await Promise.all((turn.forbiddenObjectSha256s ?? []).map(async sha256 => {
        assert.ok(digest(sha256)); return { sha256, present: await exists(join(state, 'objects', sha256)) };
      }));
      let failure;
      try {
        if (turn.cancel) {
          const pending = rpc.prompt(turn.prompt).then(() => ({ status: 'completed' }), error => ({ status: 'rejected', message: error.message }));
          const boundary = await waitUntil(async () => {
            const rows = await readRows(sourceLedger);
            return rows.find(event => event.phase === 'started' && event.kind === 'sdk' && event.operation === turn.cancel.operation && BigInt(event.monotonicNs) >= BigInt(startedNs)
              && !rows.some(end => end.phase === 'completed' && end.requestId === event.requestId));
          }, turn.cancel.timeoutMs ?? 30000);
          receipt.cancelBoundary = boundary; receipt.abortNs = process.hrtime.bigint().toString(); receipt.abort = await rpc.command('abort'); receipt.promptOutcome = await pending;
          await waitUntil(async () => !(await rpc.command('get_state')).isStreaming, 30000);
          receipt.cancelCompletion = await waitUntil(async () => (await readRows(sourceLedger)).find(event => event.phase === 'completed' && event.requestId === boundary.requestId), 30000);
          receipt.cancellation = 'requested-at-observed-sdk-start';
        } else await rpc.prompt(turn.prompt);
      } catch (error) { failure = error; }
      const endedNs = process.hrtime.bigint().toString(); receipt.endedNs = endedNs;
      receipt.forbiddenObjectsAfter = await Promise.all(receipt.forbiddenObjectsBefore.map(async item => ({ sha256: item.sha256, present: await exists(join(state, 'objects', item.sha256)) })));
      const slice = rows => rows.filter(row => BigInt(row.monotonicNs ?? row.monotonic_ns ?? '0') >= BigInt(startedNs) && BigInt(row.monotonicNs ?? row.monotonic_ns ?? '0') <= BigInt(endedNs));
      const observed = { costs: slice(await readRows(costs)), transport: slice(await readRows(transport)), tasks: slice(await readRows(tasks)), source: slice(await readRows(sourceLedger)), objects: slice(await readRows(objects)) };
      await save(join(evidence, 'turn-' + turn.id + '.json'), { turn, ...receipt, observed, failure: failure ? { message: failure.message } : null });
      if (failure) throw failure;
      if (!turn.cancel) receipt.assertions = validateCandidateTurn(turn, observed);
      else {
        const requests = observed.costs.filter(event => event.phase === 'provider_request');
        assert.equal(requests.filter(event => BigInt(event.monotonicNs) <= BigInt(receipt.abortNs)).length, turn.cancel.providerRequestsBeforeAbort ?? 0, 'Cancellation occurred after an unexpected provider dispatch');
        assert.equal(requests.filter(event => BigInt(event.monotonicNs) > BigInt(receipt.abortNs)).length, 0, 'Cancelled input dispatched a new provider request');
        assert.equal(receipt.cancelCompletion.status, 'cancelled', 'The exact observed SDK operation did not finish cancelled');
      }
      assert.equal(observed.tasks.filter(event => event.phase === 'tool_call' && event.executionTool).length, 0);
      assert.equal(observed.tasks.filter(event => event.phase === 'tool_call' && event.reviewedReadTool !== true).length, 0);
      if (turn.forbiddenObjectSha256s?.length) {
        assert.ok(observed.objects.some(event => event.kind === 'object_read' && event.event === 'end' && event.api === 'node:fs.readFile' && event.code === null && event.bytes > 0), 'Missing positive control for selected source object reads');
        for (const sha256 of turn.forbiddenObjectSha256s) assert.equal(observed.objects.filter(event => event.kind === 'object_read' && event.object_sha256 === sha256).length, 0, 'Unselected source object was read');
        for (const item of receipt.forbiddenObjectsBefore) if (!item.present)
          assert.equal(receipt.forbiddenObjectsAfter.find(after => after.sha256 === item.sha256).present, false, 'An unselected source object was materialized');
      }
      receipt.status = 'passed';
      await save(join(evidence, 'turn-' + turn.id + '-verdict.json'), receipt);
    }
    await rpc.closeInput();
    result.cost = await readConsumptionCostEvents(costs); result.transport = await readProviderTransport(transport); result.source = await readSourceObservation(sourceLedger);
    result.transportCoverage = candidateTransportCoverage(result.transport);
    assert.equal(result.source.complete, true); assert.deepEqual(result.source.errors, []);
    assert.ok(result.cost.events.at(-1)?.phase === 'observer_end' && result.cost.events.at(-1).complete);
    assert.ok((await readRows(tasks)).at(-1)?.complete);
    const objectRows = await readRows(objects), objectEnd = objectRows.at(-1);
    assert.equal(objectEnd?.kind, 'object_observer_end'); assert.equal(objectEnd.pending_reads, 0); assert.equal(objectEnd.errors, 0);
    if (config.noNotion) {
      assert.equal(result.source.events.filter(event => event.phase === 'started').length, 0, 'Disabled Notion source invoked the source transport');
      assert.equal(objectEnd.reads, 0);
      for (const payload of (await readRows(tasks)).filter(event => event.phase === 'provider_payload')) {
        assert.ok(!payload.notionCatalogPresent && !payload.notionGuidancePresent, 'Disabled source still exposed Notion context');
        assert.ok(payload.toolNames.every(name => !name.startsWith('notion_')), 'Disabled source still exposed Notion tools');
      }
    }
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.error = { code: error.code ?? 'CANDIDATE_PRECHECK_FAILED', message: error.message };
    const active = result.turns.find(turn => turn.status === 'running');
    if (active) { active.status = 'failed'; active.error = result.error; await save(join(evidence, 'turn-' + active.id + '-verdict.json'), active); }
  } finally {
    if (rpc && !rpc.lifecycle.some(event => event.event === 'close')) await rpc.stop().catch(error => { result.shutdownError = error.message; });
    if (rpc) { result.lifecycle = rpc.lifecycle; await save(join(evidence, 'rpc-lifecycle.json'), rpc.lifecycle); }
    if (result.session?.sessionFile && await exists(result.session.sessionFile)) result.session.artifact = await fileIdentity(result.session.sessionFile);
    if (previous) result.resumedOriginalUnchanged = (await fileIdentity(previous.session.artifact.path)).sha256 === previous.session.artifact.sha256;
    const after = await normalSnapshot(config, fileIdentity).catch(error => ({ safe: { failure: error.message } }));
    result.after = after.safe; result.normalConfigurationUnchanged = JSON.stringify(before.safe) === JSON.stringify(after.safe);
    result.candidateFilesUnchanged = (await Promise.all(broker.files.map(async file => hash(await readFile(join(config.brokerRoot, file.path))) === file.sha256))).every(Boolean);
    result.cliFilesUnchanged = (await Promise.all(cli.files.map(async file => hash(await readFile(join(config.cliRoot, file.path))) === file.sha256))).every(Boolean);
    result.harnessUnchanged = (await Promise.all(harness.map(async file => hash(await readFile(file.path)) === file.sha256))).every(Boolean);
    if (!result.normalConfigurationUnchanged || !result.candidateFilesUnchanged || !result.cliFilesUnchanged || !result.harnessUnchanged || result.resumedOriginalUnchanged === false) result.status = 'failed';
    await save(join(evidence, 'result.json'), result);
  }
  return { status: result.status, scope: result.scope, evidence, error: result.error, turns: result.turns, semanticReview: result.semanticReview };
}

/** Run one real native print submission with the normal HOME and extensions.
 * The optional -ns arm changes only Pi's native Skill discovery. Each continuation
 * copies an owned session, preserving its prior evidence, and reuses its own Store.
 * This is a source candidate boundary, not an installed-package release gate. */
export async function runCandidatePrint(config) {
  assert.equal(config.version, 1); assert.equal(config.scope, 'project-scoped-candidate-print');
  assert.equal(config.model, 'magpie/group/worker'); assert.equal(config.thinkingLevel, 'high');
  assert.ok(['normal', 'notion-only'].includes(config.arm) && identifier(config.id));
  assert.ok(typeof config.prompt === 'string' && config.prompt.trim());
  assert.ok(config.project === undefined || config.project === 'owned-ticket-service');
  assert.ok(isAbsolute(config.evidenceRoot) && !inside(root, config.evidenceRoot));
  assert.ok(isAbsolute(config.brokerRoot) && config.sourceId && config.database);
  assert.ok(process.env.NOTION_API_TOKEN?.trim(), 'Use the already authorized Notion identity');
  assert.ok(!process.env.NOTION_API_BASE_URL || process.env.NOTION_API_BASE_URL.replace(/\/$/u, '') === 'https://api.notion.com');
  assert.ok(!process.env.PI_CODING_AGENT_DIR && !process.env.CONTEXT_BROKER_CONFIG, 'Keep normal HOME and agent configuration');
  const identity = async path => { const bytes = await readFile(path); return { path, realpath: await realpath(path), bytes: bytes.length, sha256: hash(bytes) }; };
  const settingsPath = join(homedir(), '.pi/agent/settings.json');
  const sourcePath = join(homedir(), '.pi/agent/context-broker/config.yml');
  const settings = await json(settingsPath), sourceBytes = await readFile(sourcePath);
  const originalSource = parseYaml(sourceBytes.toString('utf8'));
  const secretKeys = value => value && typeof value === 'object' && Object.entries(value).some(([key, child]) =>
    /token|secret|password|authorization|api.?key/iu.test(key) || secretKeys(child));
  assert.ok(!secretKeys(originalSource), 'Do not persist source configuration containing credentials');
  const oldPackage = settings.packages?.[config.packageIndex ?? 1];
  const oldSource = typeof oldPackage === 'string' ? oldPackage : oldPackage?.source;
  assert.ok(isAbsolute(oldSource) && oldSource !== config.brokerRoot);
  const ownership = await identity(config.ownershipReceipt.path);
  assert.equal(ownership.sha256, config.ownershipReceipt.sha256);
  assert.ok((await readFile(ownership.path, 'utf8')).includes(config.database), 'Bind the owned database receipt');
  const cliPolicy = config.publicCli;
  const cliProtected = [];
  if (cliPolicy) {
    assert.ok(['original-create-recovery', 'owned-description-update'].includes(cliPolicy.mode)); assert.ok(!config.resumeFrom);
    if (cliPolicy.mode === 'original-create-recovery') assert.ok(/^skill-create-[0-9a-f]{64}$/u.test(cliPolicy.operationId));
    else {
      assert.ok(typeof cliPolicy.description === 'string' && cliPolicy.description.trim() && [...cliPolicy.description].length <= 2000);
      assert.ok(Object.values(cliPolicy.stateRoots).every(isAbsolute));
      for (const path of Object.values(cliPolicy.stateRoots)) assert.equal(await exists(path), false, 'The cold author task needs its own initially empty state roots');
    }
    assert.equal(cliPolicy.database, config.database); assert.ok(isAbsolute(cliPolicy.outputRoot) && inside(config.evidenceRoot, cliPolicy.outputRoot));
    assert.ok(cliPolicy.refPrefix.startsWith('skill://') && cliPolicy.refPrefix.endsWith('/'));
    assert.deepEqual(Object.keys(cliPolicy.stateRoots).sort(), ['NTN_SKILLS_HOME', 'NTN_SKILLS_CONFIG_HOME', 'NTN_SKILLS_CACHE_HOME', 'NTN_SKILLS_DATA_HOME'].sort());
    assert.ok(Object.values(cliPolicy.stateRoots).every(isAbsolute));
    const intent = cliPolicy.mode === 'original-create-recovery' ? cliPolicy.originalPlan : cliPolicy.managementIntent;
    for (const expected of [cliPolicy.entry, intent, ...(cliPolicy.protectedFiles ?? [])]) {
      const actual = await identity(expected.path); assert.equal(actual.sha256, expected.sha256); cliProtected.push(actual);
    }
    assert.ok(cliPolicy.inputFiles.includes(intent.path));
    assert.ok(cliPolicy.inputFiles.every(file => cliProtected.some(protectedFile => protectedFile.path === file)));
    await mkdir(cliPolicy.outputRoot, { recursive: true, mode: 0o700 });
  }
  for (const body of config.expectedBodies ?? []) {
    const actual = await identity(body.path);
    assert.equal(actual.sha256, body.sha256); assert.equal(actual.bytes, body.bytes); assert.ok(body.bytes > 0);
  }
  const baselineFiles = await Promise.all(['package.json', 'src/index.ts', 'dist/ntn-skills.mjs', 'dist/ntn-skills-sdk.mjs', 'dist/ntn-skills-runtime.json'].map(path => identity(join(config.brokerRoot, path))));
  const runtime = await json(join(config.brokerRoot, 'dist/ntn-skills-runtime.json'));
  assert.equal(runtime.cli_sha256, baselineFiles[2].sha256); assert.equal(runtime.sdk_sha256, baselineFiles[3].sha256);
  await mkdir(config.evidenceRoot, { recursive: true, mode: 0o700 });
  const evidence = await mkdtemp(join(config.evidenceRoot, config.arm + '-' + config.id + '-'));
  let previous;
  if (config.resumeFrom) {
    const artifact = await identity(config.resumeFrom.path); assert.equal(artifact.sha256, config.resumeFrom.sha256);
    assert.ok(inside(await realpath(config.evidenceRoot), artifact.realpath));
    previous = await json(artifact.path);
    assert.equal(previous.scope, config.scope); assert.equal(previous.status, 'passed'); assert.equal(previous.arm, config.arm);
    assert.equal(previous.database, config.database); assert.equal(previous.runtime.sdk_sha256, runtime.sdk_sha256);
    assert.equal((await identity(previous.session.path)).sha256, previous.session.sha256);
  }
  const cwd = previous?.launch.cwd ?? await mkdtemp('/private/tmp/notion-candidate-print-');
  if (previous) assert.equal(previous.project?.kind, config.project, 'A continuation must retain its original application');
  const project = previous?.project ?? (config.project ? { ...await createOwnedGraphProject(cwd), kind: config.project } : undefined);
  const stateRoot = previous?.stateRoot ?? join(evidence, 'owned-state');
  const control = join(evidence, 'observation'), sessions = join(evidence, 'sessions'), responses = join(control, 'sdk-responses'), payloads = join(control, 'provider-payloads');
  for (const path of [join(cwd, '.pi'), stateRoot, control, sessions, responses, payloads]) await mkdir(path, { recursive: true, mode: 0o700 });
  const projectSettings = candidateProjectSettings(oldSource, config.brokerRoot);
  if (previous) assert.deepEqual(await json(join(cwd, '.pi/settings.json')), projectSettings);
  else await save(join(cwd, '.pi/settings.json'), projectSettings);
  const sourceCache = join(stateRoot, 'broker-cache'), state = join(stateRoot, 'ntn/state');
  const source = candidateSourceConfig(originalSource, { sourceId: config.sourceId, database: config.database, cacheDir: sourceCache, viewId: config.viewId });
  const observedSource = source.sources.find(source => source.id === config.sourceId);
  assert.equal(observedSource.discovery?.maxAge, '5m'); assert.equal(observedSource.activation?.maxAge, '5m');
  assert.equal(observedSource.prefetch, false);
  await save(join(control, 'source-config.json'), source); await save(join(evidence, 'config.json'), config);
  const clockId = randomUUID(), host = await resolveHost('pi');
  const costs = join(control, 'cost.jsonl'), transport = join(control, 'transport.jsonl'), tasks = join(control, 'tasks.jsonl');
  const sourceLedger = join(control, 'source.jsonl'), sdkLedger = join(control, 'sdk.jsonl'), hostOutput = join(control, 'host.json');
  const costExtension = join(control, 'cost.mjs'), transportExtension = join(control, 'transport.mjs'), taskExtension = join(control, 'tasks.mjs');
  const sourcePreload = join(control, 'source.mjs'), sdkPreload = join(control, 'sdk.mjs');
  const cliGuard = join(control, 'public-cli-guard.mjs'), cliGuardLedger = join(control, 'public-cli-guard.jsonl');
  if (cliPolicy) await writeFile(cliGuard, "import fs from 'node:fs';const review=" + reviewCandidateCliCommand.toString()
    + ';export default api=>(' + candidateCliGuard.toString() + ')(api,{fs,review,output:' + JSON.stringify(cliGuardLedger)
    + ',policy:' + JSON.stringify(cliPolicy) + '});\n', { flag: 'wx', mode: 0o600 });
  await writeFile(costExtension, consumptionCostExtensionSource({ output: costs, checkoutRoot: root, runId: clockId, sampleId: config.id, clockId }), { flag: 'wx', mode: 0o600 });
  await writeFile(transportExtension, providerTransportExtensionSource({ output: transport, checkoutRoot: root, clockId }), { flag: 'wx', mode: 0o600 });
  await writeFile(taskExtension, "import fs from 'node:fs';import crypto from 'node:crypto';const inspectPayload=" + candidatePayloadBodies.toString()
    + ';const inspectProject=' + candidateProjectInspection.toString()
    + ';export default api => (' + observeCandidateTask.toString() + ')(api,{fs,crypto,inspectPayload,output:' + JSON.stringify(tasks)
    + ',bodyFiles:' + JSON.stringify(config.expectedBodies ?? []) + ',payloadDirectory:' + JSON.stringify(payloads) + ',hostOutput:' + JSON.stringify(hostOutput)
    + ',inspectProject,projectRoot:' + JSON.stringify(project?.root ?? null) + '});\n', { flag: 'wx', mode: 0o600 });
  await writeFile(sourcePreload, sourceObserverPreloadSource({ output: sourceLedger, checkoutRoot: root, clockId, cliPath: baselineFiles[2].realpath, ownerParentPid: process.pid, ownerEntry: host.path }), { flag: 'wx', mode: 0o600 });
  await writeFile(sdkPreload, "import fs from 'node:fs';import {channel} from 'node:diagnostics_channel';import {createHash} from 'node:crypto';import {isMainThread} from 'node:worker_threads';const hash=value=>createHash('sha256').update(value).digest('hex');\n"
    + safeRequestMetrics.toString() + '\nif(isMainThread&&process.ppid===' + process.pid + '){const sdk=(' + observeGraphSdk.toString()
    + ')({channel,fs,safeMetrics:safeRequestMetrics,paths:' + JSON.stringify({ ledger: sdkLedger, responses, outputRoot: sourceCache })
    + '});let done=false;const finish=()=>{if(!done){done=true;sdk.close();}};process.once("beforeExit",finish);process.once("exit",finish);}\n', { flag: 'wx', mode: 0o600 });
  const env = { ...process.env, CONTEXT_BROKER_CONFIG: join(control, 'source-config.json'), NTN_SKILLS_HOME: state,
    NTN_SKILLS_CONFIG_HOME: join(stateRoot, 'ntn/config'), NTN_SKILLS_CACHE_HOME: join(stateRoot, 'ntn/cache'), NTN_SKILLS_DATA_HOME: join(stateRoot, 'ntn/data'),
    NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000', NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + JSON.stringify(sourcePreload), '--import=' + JSON.stringify(sdkPreload)].filter(Boolean).join(' ') };
  if (cliPolicy) Object.assign(env, cliPolicy.stateRoots);
  delete env.NTN_SKILLS_DEV_ROOT;
  const args = ['-p', ...(config.arm === 'notion-only' ? ['-ns'] : []), '--approve', '--session-dir', sessions, '--model', config.model, '--thinking', config.thinkingLevel,
    '-e', costExtension, '-e', transportExtension, '-e', taskExtension];
  if (cliPolicy) args.push('-e', cliGuard);
  if (project) {
    const guard = join(control, 'project-guard.mjs');
    await writeFile(guard, 'const inspectProject=' + candidateProjectInspection.toString() + ';export default api=>('
      + guardCandidateProject.toString() + ')(api,{inspectProject,projectRoot:' + JSON.stringify(project.root) + '});\n', { flag: 'wx', mode: 0o600 });
    args.push('-e', guard);
  }
  let prefix;
  if (previous) {
    prefix = await readFile(previous.session.path);
    const session = join(sessions, basename(previous.session.path));
    await writeFile(session, prefix, { flag: 'wx', mode: 0o600 }); args.push('--session', session);
  }
  args.push('--', config.prompt);
  const before = { settings: await identity(settingsPath), source: await identity(sourcePath), packages: settings.packages,
    otherPackagesSha256: hash(JSON.stringify(settings.packages.filter((_, index) => index !== (config.packageIndex ?? 1)))) };
  const result = { version: 1, scope: config.scope, status: 'running', arm: config.arm, id: config.id, database: config.database,
    evidence, stateRoot, project, baselineFiles, runtime, ownership, before, host, hostArtifact: await identity(host.identity), expectedUserMessages: (previous?.expectedUserMessages ?? 0) + 1,
    launch: { cwd, executable: host.file, args: [...host.prefix, ...args], normalHome: true, normalAgentDir: true, normalMcpAndExtensions: true,
      projectPackageOverrideOnly: true, nativeSkillDiscovery: config.arm !== 'notion-only', sourceStateStartsEmpty: !previous && (!cliPolicy || cliPolicy.mode === 'owned-description-update'),
      cliDevRootOverride: null, inheritedCliDevRootOverrideRemoved: Boolean(process.env.NTN_SKILLS_DEV_ROOT),
      previous: config.resumeFrom ?? null, sessionContinuation: previous ? 'copied-owned-linear-history-and-owned-warm-store; new-process' : 'new-session-and-process' },
    semanticReview: 'required', artifactBoundary: 'actual source package and bundled CLI/SDK; not an installed release gate' };
  if (cliPolicy) result.publicCli = { entry: cliProtected[0], stateRoots: cliPolicy.stateRoots, protectedFiles: cliProtected,
    policy: cliPolicy.mode === 'original-create-recovery'
      ? 'Only the original create recovery and strict reads through the frozen public CLI; no shell composition or private Store API'
      : 'Only one exact Description update on the original page and strict reads through the frozen public CLI; no other field, shell composition or private Store API',
    sourceCoverage: 'The parent source observer does not observe shell grandchildren. Public CLI JSON/metrics and native tool results need a separate audit; missing child source traces remain unknown.' };
  await save(join(evidence, 'started.json'), result);
  const startedNs = process.hrtime.bigint().toString();
  let stdout = '', stderr = '';
  try {
    result.process = await new Promise((resolveProcess, reject) => {
      const child = spawn(host.file, [...host.prefix, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, config.timeoutMs ?? 600000);
      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolveProcess({ pid: child.pid, code, signal, timedOut, startedNs, endedNs: process.hrtime.bigint().toString() }); });
    });
    assert.equal(result.process.code, 0, 'Native print process failed');
    const actualHost = await json(hostOutput);
    assert.equal(actualHost.model.provider, 'magpie'); assert.equal(actualHost.model.id, 'group/worker');
    const brokers = actualHost.commands.filter(command => command.name === 'context-broker');
    assert.equal(brokers.length, 1);
    assert.ok(inside(await realpath(config.brokerRoot), await realpath(brokers[0].sourceInfo.path)));
    result.autoload = brokers[0]; result.nativeSkillCommands = actualHost.commands.filter(command => command.source === 'skill');
    if (config.arm === 'notion-only') assert.equal(result.nativeSkillCommands.length, 0, '-ns still discovered a native Skill');
    else assert.ok(result.nativeSkillCommands.length > 0, 'Normal positive control lost its native Skills');
    assert.ok(inside(sessions, resolve(actualHost.sessionFile)));
    const sessionBytes = await readFile(actualHost.sessionFile);
    if (prefix) assert.equal(hash(sessionBytes.subarray(0, prefix.length)), hash(prefix), 'The retained native history changed');
    result.session = await identity(actualHost.sessionFile);
    result.nativeAudit = inspectCandidatePrintSession(sessionBytes.toString('utf8'), { provider: 'magpie', model: 'group/worker', expectedUserMessages: result.expectedUserMessages });
    const cost = await readConsumptionCostEvents(costs), wire = await readProviderTransport(transport), task = await readRows(tasks);
    result.source = await readSourceObservation(sourceLedger); result.transportCoverage = candidateTransportCoverage(wire);
    assert.equal(result.source.complete, true); assert.deepEqual(result.source.errors, []);
    assert.ok(cost.events.at(-1)?.phase === 'observer_end' && cost.events.at(-1).complete);
    assert.ok(task.at(-1)?.phase === 'task_observer_end' && task.at(-1).complete && task.at(-1).errors === 0);
    const approvedCliCalls = [];
    if (cliPolicy) {
      const guard = await readRows(cliGuardLedger); assert.equal(guard.at(-1)?.complete, true);
      assert.ok(guard.slice(0, -1).every(entry => entry.allowed === true), 'A command escaped the frozen public CLI task');
      result.publicCli.commands = result.nativeAudit.calls.filter(call => call.name === 'bash').map(call => {
        const command = reviewCandidateCliCommand(call.arguments.command, cliPolicy);
        approvedCliCalls.push(call.id); return { toolCallId: call.id, ...command, isError: call.isError };
      });
      for (const call of result.nativeAudit.calls) assert.equal(guard.filter(entry => entry.toolCallId === call.id && entry.allowed).length, 1);
    }
    result.assertions = validateCandidateTurn(config, { costs: cost.events, transport: wire, tasks: task }, { approvedCliCalls });
    for (const event of task.filter(event => event.phase === 'provider_payload')) {
      const actual = await identity(event.payloadFile); assert.equal(actual.sha256, event.sha256); assert.equal(actual.bytes, event.bytes);
    }
    if (project) result.generatedPlan = await retainGeneratedPlan({ evidence, project,
      final: task.filter(event => event.phase === 'assistant_final').at(-1), prompt: { sha256: hash(config.prompt) } });
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.error = { code: error.code ?? error.name, message: error.message };
  } finally {
    await writeFile(join(evidence, 'stdout.txt'), stdout, { flag: 'wx', mode: 0o600 });
    await writeFile(join(evidence, 'stderr.txt'), stderr, { flag: 'wx', mode: 0o600 });
    const hostState = await json(hostOutput).catch(() => null);
    if (!result.session && hostState?.sessionFile && await exists(hostState.sessionFile)) result.session = await identity(hostState.sessionFile);
    result.normalConfigurationUnchanged = (await identity(settingsPath)).sha256 === before.settings.sha256 && (await identity(sourcePath)).sha256 === before.source.sha256;
    result.baselineFilesUnchanged = (await Promise.all(baselineFiles.map(async file => (await identity(file.path)).sha256 === file.sha256))).every(Boolean);
    if (project) result.projectFilesUnchanged = (await Promise.all(project.files.map(async file => (await identity(join(project.root, file.path))).sha256 === file.sha256))).every(Boolean);
    if (cliPolicy) result.publicCliProtectedFilesUnchanged = (await Promise.all(cliProtected.map(async file => (await identity(file.path)).sha256 === file.sha256))).every(Boolean);
    if (previous) result.originalSessionUnchanged = (await identity(previous.session.path)).sha256 === previous.session.sha256;
    if (!result.normalConfigurationUnchanged || !result.baselineFilesUnchanged || result.originalSessionUnchanged === false || result.projectFilesUnchanged === false || result.publicCliProtectedFilesUnchanged === false) result.status = 'failed';
    await save(join(evidence, 'result.json'), result);
  }
  return { status: result.status, evidence, error: result.error, session: result.session, assertions: result.assertions };
}
