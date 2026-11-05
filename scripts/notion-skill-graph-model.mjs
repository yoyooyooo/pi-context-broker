#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveHost, runCommand, assertSupportedPiVersion } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { safeRequestMetrics } from './notion-default-context.mjs';
import { entryIdentity, verifyEntryIdentity } from './verification-entry.mjs';
import { systemTempRoot } from './verification-paths.mjs';
import { evaluateGraphTrace, frozenPrompt, verifyWorkerAuthorization } from './verify-skill-graph-contract.mjs';
import { createOwnedGraphProject, inspectOwnedGraphProject, retainGeneratedPlan, exerciseGeneratedProcedure } from './notion-skill-graph-project.mjs';
import { verifyRetainedSourceProof } from './notion-skill-retained-proof.mjs';
import { createPiHelpBoundary } from './notion-pi-help.mjs';
import { graphSourceViews, graphSourceAccounting } from './notion-skill-graph-model-evidence.mjs';
import { verifyPreparationEvidence } from './skill-preparation-evidence.mjs';

const helper = fileURLToPath(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const rows = async path => { try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
const log = (path, value) => appendFile(path, JSON.stringify({ ...value, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
const within = (base, target) => { const value = relative(base, target); return value === '' || (!value.startsWith('../') && value !== '..' && !isAbsolute(value)); };
const disjoint = (a, b) => !within(a, b) && !within(b, a);
const modelSelectors = ['magpie/group/flash-free', 'magpie/group/worker'];
const permissionFailure = text => /insufficient (?:permission|quota)|not authorized|api key.*(?:invalid|denied)|please upgrade|无权限使用|额度不足|账户.*(?:无权|欠费)/i.test(text);
export const GRAPH_GATE_HARNESS_VERSION = 15;
export const GRAPH_GATE_TOOLS = Object.freeze(['read', 'notion_list', 'notion_use']);
export async function graphHarnessIdentity() {
  const files = await Promise.all(['notion-skill-graph-model.mjs', 'notion-skill-graph-model-evidence.mjs', 'skill-preparation-evidence.mjs', 'verify-skill-graph-contract.mjs', 'notion-skill-graph-project.mjs', 'notion-skill-graph-observer-smoke.mjs', 'notion-skill-retained-proof.mjs', 'notion-skill-source-proof.ts', 'notion-pi-help.mjs', 'notion-skill-graph.mjs', 'notion-integration-model.mjs', 'verify-pi-notion-model-cache.mjs'].map(async name => {
    const path = fileURLToPath(new URL('./' + name, import.meta.url)), bytes = await readFile(path);
    return { path, bytes: bytes.length, sha256: hash(bytes) };
  }));
  return { version: GRAPH_GATE_HARNESS_VERSION, tools: GRAPH_GATE_TOOLS, files, sha256: hash(JSON.stringify(files)) };
}

export function graphObserverModule(settings, referenceParser) {
  return "import * as fs from 'node:fs';\nimport * as crypto from 'node:crypto';\nimport * as path from 'node:path';\nimport { graphSourceViews } from " + JSON.stringify(new URL('./notion-skill-graph-model-evidence.mjs', import.meta.url).href)
    + ';\nimport { verifyPreparationEvidence } from ' + JSON.stringify(new URL('./skill-preparation-evidence.mjs', import.meta.url).href)
    + ';\nimport { parseNativeReference } from ' + JSON.stringify(referenceParser)
    + ';\nimport { validateResourceReadProjection } from ' + JSON.stringify(new URL('./resource-read-projection.ts', referenceParser).href)
    + ";\nexport default function(api) { const settings = " + JSON.stringify(settings) + '; const piHelpBoundary = (' + createPiHelpBoundary.toString() + ')({fs,crypto,path,executable:settings.piExecutable}); (' + observeGraphGate.toString() + ')(api, { ...settings, fs, crypto, path, piHelpBoundary, parseNativeReference, validateResourceReadProjection }); }\n';
}

export function graphCatalogEvidence(observation, config) {
  const catalogs = observation.filter(event => event.phase === 'catalog');
  assert.ok(catalogs.length, 'An actual native catalog observation is required');
  const ownerId = decodeURIComponent(config.rootRef.split('/')[2]);
  for (const catalog of catalogs) {
    assert.equal(catalog.stage, 'before_provider_request', 'Only the actual provider system payload proves catalog visibility');
    assert.ok(['pending', 'ready'].includes(catalog.state), 'An unavailable or unobserved catalog cannot prove discovery');
    assert.equal(catalog.localDiscoveryDisabled, true);
    const visible = [...catalog.skills, ...catalog.routers];
    for (const item of visible) assert.ok(item.provenance?.ownerId === ownerId && ['verified-notion-metadata', 'verified-notion-host-snapshot', 'verified-notion-host-index'].includes(item.provenance.source), 'Every visible entry needs its selected Notion metadata binding');
    if (catalog.state === 'pending') {
      assert.ok(visible.length <= 1, 'A pending catalog must not introduce an unrelated default entry');
      continue;
    }
    assert.equal(visible.length, 1, 'The ready default View must advertise only the selected root');
    if (config.gate === 'A') assert.equal(catalog.routers[0]?.canonicalRef ?? catalog.routers[0]?.ref, config.rootRef, 'The ready router must be the selected root');
    else assert.equal(catalog.skills.length, 1, 'The ready skill must be the selected root');
  }
  return { status: catalogs.at(-1).state, firstState: catalogs[0].state, snapshots: catalogs.length,
    readyProviderRequests: catalogs.filter(event => event.state === 'ready').map(event => event.sequence),
    meaning: 'Pending is a startup observation, not empty discovery or loaded instructions. Only a verified ready catalog proves default visibility.' };
}

export function graphTaskEvidence(observation) {
  const project = observation.filter(event => event.phase === 'project-read-result' && event.complete && event.path?.startsWith('src/'));
  const resources = observation.filter(event => event.phase === 'tool-result' && event.complete && event.role === 'resource');
  const uses = observation.filter(event => event.phase === 'preparation-result' && event.complete && event.tool === 'notion_use');
  const final = observation.filter(event => event.phase === 'assistant-final').at(-1);
  return { projectSourceReadStatus: project.length ? 'observed' : 'missing', projectSourceReadCount: project.length,
    projectSourceReads: project.map(({ path, toolCallId, sha256, bytes }) => ({ path, toolCallId, sha256, bytes })),
    resourceReadCount: resources.length, resourceToolCallCount: new Set(resources.map(event => event.toolCallId)).size,
    resourceReads: resources.map(({ ref, toolCallId, sha256, bytes }) => ({ ref, toolCallId, sha256, bytes })),
    explicitUseCount: uses.length, ...(final ? { finalTextSha256: hash(final.text ?? '') } : {}),
    boundary: 'Final prose is retained separately and never establishes a source read, selected Skill use, or provider delivery.' };
}

export async function createGraphFallbackTraps(control, evidence) {
  const directory = join(control, 'poison-bin'), ledger = join(evidence, 'legacy-fallback-calls.jsonl');
  await mkdir(directory, { recursive: true }); await writeFile(ledger, '', { flag: 'wx', mode: 0o600 });
  const code = '#!' + process.execPath + '\nimport { appendFileSync } from "node:fs";\nimport { basename } from "node:path";\n'
    + 'appendFileSync(' + JSON.stringify(ledger) + ', JSON.stringify({at:new Date().toISOString(),executable:basename(process.argv[1]),operation:["login","auth","doctor","whoami"].includes(process.argv[2])?process.argv[2]:"other",argumentCount:process.argv.length-2})+"\\n",{mode:0o600});\nprocess.exit(97);\n';
  for (const name of ['ntn', 'legacy-ntn']) await writeFile(join(directory, name), code, { flag: 'wx', mode: 0o755 });
  return { directory, ledger, environment: { PATH: directory + ':' + (process.env.PATH ?? ''), NTN_SKILLS_NTN_BIN: join(directory, 'legacy-ntn') }, checks: ['PATH ntn including login/auth', 'legacy NTN_SKILLS_NTN_BIN override'] };
}

// Explicit command compatibility only. Consumption can retain/adopt source
// edits; its actual Records writes remain in the HTTP ledger.
async function sourceCommand(statePath, incoming) {
  const state = await json(statePath);
  const name = incoming[0];
  assert.ok(['list', 'views', 'prepare', 'read', 'files', 'export'].includes(name) || name === 'ctl' && (incoming[1] === 'doctor' || incoming[1] === 'cache' && incoming[2] === 'identity'), 'Graph model gate permits no remote write command');
  if (state.metadataOnly) assert.ok(['list', 'views', 'ctl'].includes(name), 'Selection preflight permits metadata operations only');
  const args = ['list', 'prepare', 'read', 'files'].includes(name) && !incoming.includes('--metrics') ? [...incoming, '--metrics'] : incoming;
  const requestId = randomUUID();
  const child = spawn(state.command[0], [...state.command.slice(1), ...args], { env: { ...process.env, ...state.cliPaths, NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000' }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  let bytes = 0;
  child.stdout.on('data', chunk => { process.stdout.write(chunk); bytes += chunk.length; if (bytes <= 16 * 1024 * 1024) stdout.push(chunk); });
  child.stderr.on('data', chunk => { process.stderr.write(chunk); stderr.push(chunk); });
  const pending = [];
  const handlers = ['SIGTERM', 'SIGINT'].map(signal => [signal, () => { const forwarded = child.kill(signal); pending.push(log(state.ledger, { phase: 'signal-forwarded', requestId, pid: process.pid, childPid: child.pid, signal, forwarded })); }]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const closed = new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })); });
  await log(state.ledger, { phase: 'spawn', requestId, pid: process.pid, childPid: child.pid, command: name, args, owned: true });
  const closedResult = await closed;
  await Promise.all(pending);
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  const output = Buffer.concat(stdout).toString('utf8');
  let response;
  try { if (bytes <= 16 * 1024 * 1024) response = JSON.parse(output); } catch { /* Invalid output remains a failed observation. */ }
  const metrics = safeRequestMetrics(response?.request_metrics);
  const receipt = { version: 1, requestId, command: name, args, ...closedResult, stdout_bytes: bytes, stdout_sha256: hash(Buffer.concat(stdout)), stderr_bytes: Buffer.concat(stderr).length, stderr_sha256: hash(Buffer.concat(stderr)), response: response ?? null, metrics: metrics ?? null };
  await save(join(state.responses, requestId + '.json'), receipt);
  await log(state.ledger, { phase: 'close', requestId, pid: process.pid, childPid: child.pid, command: name, ...closedResult, responseFile: requestId + '.json', metricsObserved: metrics !== undefined, metricsComplete: metrics?.complete ?? false, owned: true, closed: true });
  process.exitCode = closedResult.code ?? 1;
}

/** Installed Pi observer. It receives no private oracle, target name or answer. */
export function observeGraphGate(api, settings) {
  const { appendFileSync, readFileSync, readdirSync, realpathSync, statSync } = settings.fs;
  const { createHash } = settings.crypto;
  const { join, relative, resolve, isAbsolute } = settings.path;
  const digest = value => createHash('sha256').update(value).digest('hex');
  let sequence = settings.sequenceOffset ?? 0;
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid observer sequence offset');
  const record = value => { const event = { sequence: ++sequence, at: new Date().toISOString(), ...value }; appendFileSync(settings.output, JSON.stringify(event) + '\n', { mode: 0o600 }); return event; };
  const text = content => typeof content === 'string' ? content : (content ?? []).filter(item => item.type === 'text').map(item => String(item.text ?? '')).join('\n');
  const unescape = value => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  const inside = (parent, child) => { const value = relative(parent, child); return value === '' || (!value.startsWith('../') && value !== '..' && !isAbsolute(value)); };
  const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  const same = (a, b) => canonical(a) === canonical(b);
  const tools = ['read', 'notion_list', 'notion_use'];
  let currentContext;
  const refreshContext = ctx => { if (ctx) currentContext = ctx; };
  const hostIndexBindings = new Map();
  let contextDeliveries = [];
  const toolSurface = () => {
    const surface = settings.toolSurfaceFile ? JSON.parse(readFileSync(settings.toolSurfaceFile, 'utf8')).surface : 'public-tools';
    if (!['native-read-only', 'public-tools'].includes(surface)) throw new Error('Unknown frozen graph tool surface');
    return { surface, tools: surface === 'native-read-only' ? ['read'] : tools };
  };
  const canonicalReadPath = input => {
    if (typeof input !== 'string' || input.split(/[\\/]/).includes('..')) return undefined;
    const nativeHome = settings.nativeHome ?? process.env.HOME;
    const expanded = input.startsWith('~/') && typeof nativeHome === 'string' && isAbsolute(nativeHome) ? join(nativeHome, input.slice(2)) : input;
    const absolute = resolve(settings.cwd, expanded);
    let current = absolute, normalized;
    const tail = [];
    for (;;) {
      try { normalized = resolve(realpathSync(current), ...tail); break; }
      catch (error) {
        if (error.code !== 'ENOENT') return undefined;
        const parent = settings.path.dirname(current);
        if (parent === current) return undefined;
        tail.unshift(relative(parent, current)); current = parent;
      }
    }
    // OS aliases may precede the owned root. Symlinks within that root may not
    // substitute an undeclared path for a verified manifest entry.
    for (let ancestor = absolute;;) {
      try {
        const actual = realpathSync(ancestor);
        if ([settings.cache, settings.cwd, ...[...hostIndexBindings.values()].map(binding => binding.root)].includes(actual) && resolve(actual, relative(ancestor, absolute)) !== normalized) return undefined;
      } catch (error) { if (error.code !== 'ENOENT') return undefined; }
      const parent = settings.path.dirname(ancestor);
      if (parent === ancestor) return normalized;
      ancestor = parent;
    }
  };
  const makeRef = (id, path, snapshot, fileId) => `skill://${encodeURIComponent(id)}/${path.split('/').map(encodeURIComponent).join('/')}?snapshot=${snapshot}${fileId ? '&file_id=' + encodeURIComponent(fileId) : ''}`;
  if (typeof settings.parseNativeReference !== 'function') throw new Error('Graph observation requires the installed product reference parser');
  const parseRef = value => {
    if (typeof value !== 'string') return undefined;
    try { return value.startsWith('sr:') ? shortReference(value) : settings.parseNativeReference(value); } catch { return undefined; }
  };
  const entryMode = settings.entryMode ?? 'explicit-root';
  if (!['explicit-root', 'discovery-only'].includes(entryMode)) throw new Error('Unknown graph entry mode');
  if (entryMode === 'discovery-only' && settings.rootRef !== undefined) throw new Error('Discovery-only observation cannot seed a private root');
  const root = entryMode === 'explicit-root' ? parseRef(settings.rootRef) : undefined;
  if (entryMode === 'explicit-root' && !root) throw new Error('An explicitly selected root requires its actual reference');
  const discovered = new Map(root ? [[settings.rootRef, { sequence: 0, source: 'explicit selected root' }]] : []);
  const advertisedPaths = new Set();
  const projectFiles = new Map((settings.project?.files ?? []).map(file => [resolve(settings.cwd, file.path), file]));
  const calls = new Map();
  const assistantCalls = new Map();
  const deliveredTools = new Map();
  const wireAllowed = model => model === settings.model || model === settings.model.slice(settings.model.indexOf('/') + 1);
  const assertModel = ctx => {
    if (ctx.model?.provider + '/' + ctx.model?.id !== settings.model) throw new Error('Graph gate rejected an unauthorized model');
  };
  const sourceStrings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(sourceStrings) : value && typeof value === 'object' ? ['assistant', 'model'].includes(value.role) ? [] : Object.values(value).flatMap(sourceStrings) : [];
  const copies = (payload, body) => {
    if (!body) return 0;
    const encoded = body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const choices = [...new Set([body, encoded, JSON.stringify(body).slice(1, -1)])].sort((a, b) => b.length - a.length);
    return sourceStrings(payload).reduce((sum, value) => {
      let cursor = 0, count = 0;
      for (;;) {
        let start = -1, length = 0;
        for (const choice of choices) {
          const found = value.indexOf(choice, cursor);
          if (found !== -1 && (start === -1 || found < start)) { start = found; length = choice.length; }
        }
        if (start === -1) return sum + count;
        count++; cursor = start + length;
      }
    }, 0);
  };
  let verifiedPayloadHash;
  const observerFault = (stage, error, payload) => {
    verifiedPayloadHash = undefined;
    const message = String(error?.message ?? error).slice(0, 512);
    let payloadSha256;
    try { payloadSha256 = digest(JSON.stringify(payload)); } catch { /* An unserializable payload cannot authorize transport. */ }
    record({ phase: 'observer-error', stage, code: 'GRAPH_OBSERVER_INVALID', name: error?.name ?? 'Error', message, ...(payloadSha256 ? { payloadSha256 } : {}) });
    return Object.assign(new Error('Graph observation failed: ' + message), { code: 'GRAPH_OBSERVER_INVALID' });
  };
  const providerToolOutputs = (payload, toolCallId) => {
    const found = [];
    const visit = value => {
      if (Array.isArray(value)) { for (const item of value) visit(item); return; }
      if (!value || typeof value !== 'object') return;
      if (value.role === 'tool' && value.tool_call_id === toolCallId
        || value.role === 'toolResult' && value.toolCallId === toolCallId
        || value.type === 'tool_result' && value.tool_use_id === toolCallId
        || value.type === 'function_call_output' && value.call_id === toolCallId) {
        found.push(text(value.content ?? value.output)); return;
      }
      for (const item of Object.values(value)) visit(item);
    };
    visit(payload); return found;
  };
  const sourceResponses = () => [...readdirSync(settings.responses).filter(name => name.endsWith('.json')).map(name => ({ path: join(settings.responses, name) })), ...(settings.priorResponseFiles ?? [])].flatMap(file => {
    const bytes = readFileSync(file.path);
    if (file.sha256 !== undefined && digest(bytes) !== file.sha256) throw new Error('A prior owned consumer response differs from its cache reuse receipt');
    try { const item = JSON.parse(bytes.toString('utf8')); return item.transport === 'sdk'
      ? item.status === 'completed' && item.resultObserved === true ? [item] : []
      : item.code === 0 && item.response?.ok === true ? [item] : []; } catch { return []; }
  });
  const sourceViews = () => graphSourceViews(sourceResponses());
  function shortReference(value) {
    if (!/^sr:[CSR][A-Za-z0-9_-]{22}$/.test(value)) throw new Error('Invalid session reference');
    const bindings = new Map();
    for (const entry of currentContext?.sessionManager?.getBranch?.() ?? []) {
      if (entry.type !== 'custom' || entry.customType !== 'context-broker-short-ref') continue;
      const event = entry.data;
      if (event?.version !== 1 || !/^sr:[CSR][A-Za-z0-9_-]{22}$/.test(event.ref)
        || bindings.has(event.ref) && !same(bindings.get(event.ref), event.target)) throw new Error('Conflicting session reference evidence');
      bindings.set(event.ref, event.target);
    }
    const target = bindings.get(value);
    const owner = target?.kind === 'resource' ? bindings.get(target.owner) : target;
    const identity = owner?.identity;
    if (!target || !owner || identity?.source !== 'notion' || !/^[a-f0-9]{64}$/.test(identity.scope)
      || value[3] !== ({ candidate: 'C', selected: 'S', resource: 'R' })[target.kind]) throw new Error('Unknown session reference');
    const raw = settings.parseNativeReference(target.kind === 'candidate' ? identity.ref : target.ref);
    const facts = sourceViews();
    const records = [...facts.directories.flatMap(item => (item.value.records ?? []).map(record => ({ record, scope: item.value.scope }))),
      ...facts.entries.map(item => ({ record: item.value.record, scope: item.value.scope }))];
    if (!records.some(({ record, scope }) => scope === identity.scope && record.id === identity.id && record.kind === identity.kind
      && same(record.locator, identity.locator) && settings.parseNativeReference(record.ref).selector === raw.selector)) throw new Error('Session reference lacks an authorized observed owner');
    if (target.kind === 'candidate') {
      if (raw.path || raw.snapshot !== undefined || raw.fileId !== undefined) throw new Error('Candidate reference cannot contain a pin');
    } else {
      if (owner.kind !== 'selected') throw new Error('Resource owner must be a selected reference');
      const entry = facts.entries.find(item => item.value.record.id === identity.id && item.value.scope === identity.scope
        && item.value.snapshot_id === owner.snapshot_id && item.value.version_id === owner.version_id && item.value.path === owner.entrypoint
        && digest(item.value.content) === owner.body_sha256 && item.value.ref === owner.ref);
      if (!entry || raw.snapshot !== owner.snapshot_id) throw new Error('Session reference changed the selected source version');
      if (target.kind === 'resource') {
        const prepared = facts.preparations.flatMap(item => item.value.scope === identity.scope ? item.value.nodes ?? [] : [])
          .find(node => node.state === 'prepared' && node.id === identity.id && node.binding.snapshot_id === owner.snapshot_id);
        const file = prepared?.files.find(file => file.path === target.path);
        if (!file || file.ref !== target.ref || file.sha256 !== target.sha256 || file.bytes !== target.bytes
          || raw.fileId !== target.file_id || target.path === owner.entrypoint) throw new Error('Resource session reference lacks its immutable manifest');
      } else if (raw.path !== owner.entrypoint || raw.fileId !== owner.file_id) throw new Error('Selected reference changed its main file');
    }
    return { ...raw, scope: identity.scope };
  }
  const resolveMainReference = parsed => {
    if (!parsed || parsed.path) return parsed;
    const views = sourceViews();
    const candidates = [...views.directories.map(item => ({ value: item.value, records: item.value.records })),
      ...views.entries.map(item => ({ value: item.value, records: [item.value.record], pin: item.value.snapshot_id })),
      ...views.preparations.flatMap(item => item.value.nodes.map(node => ({ value: item.value, records: [node.record], pin: node.binding?.snapshot_id })))].flatMap(item => {
      const { value, records } = item;
      return records.flatMap(record => {
        const ref = parseRef(record?.ref), entrypoint = record?.entrypoint ?? ref?.path;
        if (!ref?.path || !['skill', 'router'].includes(record.kind) || record.id !== parsed.selector || ref.selector !== record.id
          || entrypoint !== ref.path || typeof value.scope !== 'string') return [];
        return [{ ownerId: record.id, scope: value.scope, path: entrypoint, pin: item.pin }];
      });
    });
    const matched = candidates.filter(candidate => (parsed.scope === undefined || parsed.scope === candidate.scope)
      && (parsed.snapshot === undefined || candidate.pin === parsed.snapshot || [...discovered].some(([ref, proof]) => {
        const prior = parseRef(ref);
        return prior?.selector === candidate.ownerId && prior.path === candidate.path && prior.snapshot === parsed.snapshot
          && (proof.scope === undefined || proof.scope === candidate.scope);
      })));
    const unique = [...new Map(matched.map(candidate => [JSON.stringify([candidate.scope, candidate.ownerId, candidate.path]), candidate])).values()];
    return unique.length === 1 ? { ...parsed, path: unique[0].path, scope: unique[0].scope } : undefined;
  };
  const exportedFiles = ({ includePending = false } = {}) => {
    const outputs = sourceViews();
    const files = [];
    const walk = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && ['.broker-snapshot.json', '.broker-entry.json'].includes(entry.name)) {
          const receiptBytes = readFileSync(path);
          const receipt = JSON.parse(receiptBytes.toString('utf8'));
          const partial = entry.name === '.broker-entry.json';
          const ownerId = partial ? receipt.id : receipt.record?.id, snapshot = partial ? receipt.snapshot_id : receipt.snapshot, mainPath = partial ? receipt.entrypoint : receipt.entry;
          if ((partial ? receipt.version !== 1 || receipt.projection !== 'entry' || receipt.manifest_complete !== true : receipt.version !== 3 || receipt.projection !== 'snapshot') || typeof ownerId !== 'string' || !Array.isArray(receipt.files) || realpathSync(directory) !== directory || !inside(settings.cache, directory)) throw new Error('Unverified Broker materialization receipt in graph observation');
          const publicRead = outputs.entries.find(item => item.value.record?.id === ownerId && item.value.scope === receipt.scope && item.value.snapshot_id === snapshot && item.value.path === mainPath)?.value;
          if (!publicRead) throw new Error('Materialized main has no actual consume-entry or fixed read source proof');
          const expectedDirectory = join(settings.cache, 'scopes', receipt.scope, 'records', digest(ownerId), partial ? 'entries' : 'snapshots', snapshot);
          if (expectedDirectory !== directory) throw new Error('Snapshot owner differs from its cache directory');
          if (partial) {
            const prepared = outputs.preparations.flatMap(item => item.value.scope === receipt.scope ? item.value.nodes ?? [] : []).find(node => node.state === 'prepared' && node.id === ownerId && node.binding.snapshot_id === snapshot);
            const inventory = items => JSON.stringify(items.map(({ path, bytes, sha256, ref }) => ({ path, bytes, sha256, ref })).sort((a, b) => a.path.localeCompare(b.path)));
            if (!prepared || prepared.path !== mainPath || receipt.ref !== prepared.binding.ref || receipt.version_id !== publicRead.version_id || inventory(receipt.files) !== inventory(prepared.files) || digest(publicRead.content) !== prepared.body_sha256 || JSON.stringify(receipt.file_bindings ?? []) !== JSON.stringify(publicRead.file_bindings ?? [])) throw new Error('Entry manifest differs from the actual public preparation/read contract');
          }
          const contentRoot = partial ? join(directory, 'tree') : directory;
          const seen = new Set();
          for (const item of receipt.files) {
            if (typeof item.path !== 'string' || !item.path || item.path.split('/').some(part => !part || part === '.' || part === '..') || item.path.includes('\\') || seen.has(item.path)) throw new Error('Materialization manifest has an ambiguous path');
            seen.add(item.path);
            const actual = join(contentRoot, item.path), hash = partial ? item.sha256 : item.hash;
            if (!inside(contentRoot, actual) || !/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(item.bytes) || item.bytes < 0) throw new Error('Snapshot resource escaped its verified owner');
            const binding = publicRead.file_bindings?.find(binding => binding.path === item.path);
            const main = item.path === mainPath, ref = makeRef(ownerId, item.path, snapshot, binding?.file_id);
            if (partial && item.ref !== ref) throw new Error('Entry file ref differs from its scope/owner/snapshot binding');
            const declared = { ref, logicalId: main ? ownerId : binding?.file_id ?? ownerId + '/' + item.path, ownerId, scope: receipt.scope, snapshot, version: publicRead.version_id, sha256: hash, bytes: item.bytes, path: item.path, actual, actuals: [actual], fileId: binding?.file_id, role: main ? 'entrypoint' : 'resource', kind: publicRead.record.kind, projection: receipt.projection, manifestSha256: digest(receiptBytes) };
            let bytes;
            try {
              if (realpathSync(actual) !== actual || !statSync(actual).isFile()) throw new Error('Snapshot resource is not a verified regular file');
              bytes = readFileSync(actual);
            } catch (error) {
              if (!partial || main || error.code !== 'ENOENT') throw error;
              if (includePending) files.push({ ...declared, materialized: false });
              continue;
            }
            if (bytes.length !== item.bytes || digest(bytes) !== hash) throw new Error('Snapshot resource bytes differ from its frozen receipt');
            if (item.path === '.ntn-skills.json' || item.path === 'ntn-skills-source.zip' || bytes.includes(0)) continue;
            let content;
            try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { continue; }
            files.push({ ...declared, content, materialized: true });
          }
          if (!seen.has(mainPath)) throw new Error('Complete manifest omits its main instruction');
        }
      }
    };
    walk(settings.cache);
    for (const observed of outputs.entries) {
      const value = observed.value, output = observed.outputEvidence;
      if (!output || typeof output.content !== 'string' || value.path === value.record.entrypoint) continue;
      const parsed = parseRef(value.ref), owner = outputs.preparations.flatMap(item => item.value.scope === value.scope ? item.value.nodes ?? [] : [])
        .find(node => node.state === 'prepared' && node.id === value.record.id && node.binding.snapshot_id === value.snapshot_id);
      const declared = owner?.files.find(file => file.path === value.path);
      if (!parsed || !declared || declared.ref !== value.ref || declared.bytes !== output.bytes || declared.sha256 !== output.sha256
        || value.bytes !== output.bytes || value.sha256 !== output.sha256 || digest(output.content) !== output.sha256
        || Buffer.byteLength(output.content) !== output.bytes || value.entrypoint_sha256 !== owner.body_sha256
        || value.version_id !== owner.binding.version_id) throw new Error('Observed scalar resource differs from its selected owner manifest');
      files.push({ ref: value.ref, logicalId: parsed.fileId ?? value.record.id + '/' + value.path, ownerId: value.record.id,
        scope: value.scope, snapshot: value.snapshot_id, version: value.version_id, sha256: output.sha256, bytes: output.bytes,
        path: value.path, actual: output.path, actuals: [output.path], fileId: parsed.fileId, role: 'resource', kind: value.record.kind,
        projection: 'selected-resource', content: output.content, materialized: true, sourceOutputObserved: true });
    }
    for (const observed of outputs.resources) {
      const { selection, manifest, files: selected } = observed.value;
      const owner = outputs.preparations.flatMap(item => item.value.scope === selection.scope ? item.value.nodes ?? [] : [])
        .find(node => node.state === 'prepared' && node.id === selection.owner && node.binding.snapshot_id === selection.snapshot_id);
      if (!owner || !same(owner.record, manifest.record) || owner.binding.version_id !== selection.version_id
        || manifest.files.find(file => file.path === manifest.entrypoint)?.sha256 !== owner.body_sha256) throw new Error('Observed resource batch changed its selected owner');
      for (const file of selected) {
        const parsed = parseRef(file.ref), declared = owner.files.find(item => item.path === file.path);
        if (!parsed || !declared || declared.ref !== file.ref || declared.sha256 !== file.sha256 || declared.bytes !== file.bytes
          || parsed.selector !== selection.owner || parsed.snapshot !== selection.snapshot_id || parsed.fileId !== file.file_id) throw new Error('Observed resource batch differs from its selected immutable manifest');
        if (file.encoding !== 'utf8') continue;
        files.push({ ref: file.ref, logicalId: file.file_id ?? selection.owner + '/' + file.path, ownerId: selection.owner,
          scope: selection.scope, snapshot: selection.snapshot_id, version: selection.version_id, sha256: file.sha256, bytes: file.bytes,
          path: file.path, actuals: [], fileId: file.file_id, role: 'resource', kind: owner.record.kind,
          projection: 'selected-resource-batch', content: file.content, materialized: true, sourceOutputObserved: true });
      }
    }
    const unique = new Map();
    for (const file of files) {
      const key = JSON.stringify([file.scope, file.ownerId, file.snapshot, file.path]);
      const previous = unique.get(key);
      if (previous && (previous.sha256 !== file.sha256 || previous.bytes !== file.bytes || previous.ref !== file.ref)) throw new Error('One immutable file has conflicting materialization receipts');
      unique.set(key, previous ? { ...(file.materialized ? file : previous), actuals: [...new Set([...previous.actuals, ...file.actuals])] } : file);
    }
    return [...unique.values()];
  };
  const hostIndexProof = (input, source) => {
    if (source.role !== 'entrypoint' || source.projection !== 'entry' || !source.fileId) return undefined;
    const main = canonicalReadPath(input);
    if (!main || ![...advertisedPaths].some(path => canonicalReadPath(path) === main)) return undefined;
    let directory = settings.path.dirname(main);
    for (let level = 0; level < 6; level++, directory = settings.path.dirname(directory)) {
      try {
        const receiptPath = join(directory, '.broker-host-index.json');
        if (!settings.fs.lstatSync(receiptPath).isFile()) return undefined;
        const raw = readFileSync(receiptPath), receipt = JSON.parse(raw.toString('utf8'));
        const published = receipt.published?.path;
        if (receipt.version !== 1 || receipt.projection !== 'host_index' || receipt.loaded !== false
          || receipt.scope !== source.scope || receipt.id !== source.ownerId || receipt.snapshot_id !== source.snapshot
          || receipt.version_id !== source.version || receipt.ref !== source.ref || receipt.entrypoint !== source.path
          || receipt.source?.sha256 !== source.sha256 || receipt.source?.bytes !== source.bytes
          || typeof published !== 'string' || published.includes('\\') || published.split('/').some(part => !part || part === '.' || part === '..')
          || main !== join(directory, published) || realpathSync(directory) !== directory) return undefined;
        let part = directory;
        for (const name of published.split('/')) { part = join(part, name); if (settings.fs.lstatSync(part).isSymbolicLink()) return undefined; }
        if (!statSync(main).isFile()) return undefined;
        const bytes = readFileSync(main);
        if (receipt.published.bytes !== bytes.length || receipt.published.sha256 !== digest(bytes)) return undefined;
        const manifestPath = join(settings.cache, 'scopes', source.scope, 'records', digest(source.ownerId), 'entries', source.snapshot, '.broker-entry.json');
        if (!settings.fs.lstatSync(manifestPath).isFile() || realpathSync(manifestPath) !== manifestPath) return undefined;
        const manifest = readFileSync(manifestPath);
        if (digest(manifest) !== source.manifestSha256 || receipt.manifest_id !== digest(JSON.stringify(JSON.parse(manifest.toString('utf8'))))) return undefined;
        return { root: directory, main, receiptPath, receiptSha256: digest(raw), manifestPath, manifestSha256: digest(manifest), manifestId: receipt.manifest_id, publishedSha256: digest(bytes) };
      } catch (error) { if (error.code !== 'ENOENT') return undefined; }
    }
    return undefined;
  };
  const bindHostIndex = (input, source) => {
    const proof = hostIndexProof(input, source);
    if (!proof) return undefined;
    const binding = { ...proof, input, source, aliases: new Map() };
    hostIndexBindings.set(proof.main, binding);
    record({ phase: 'host-index-binding', ...proof, ref: source.ref, scope: source.scope, ownerId: source.ownerId,
      snapshot: source.snapshot, fileId: source.fileId, sha256: source.sha256, bytes: source.bytes });
    return binding;
  };
  const hostIndexAlias = input => {
    const actual = canonicalReadPath(input);
    if (!actual) return undefined;
    const matches = [];
    for (const binding of hostIndexBindings.values()) {
      const alias = binding.aliases.get(actual);
      if (!alias) continue;
      const proof = hostIndexProof(binding.input, binding.source);
      if (proof && proof.receiptSha256 === binding.receiptSha256 && proof.manifestSha256 === binding.manifestSha256
        && proof.publishedSha256 === binding.publishedSha256) matches.push(alias);
    }
    return matches.length === 1 ? matches[0] : undefined;
  };
  const discover = (value, source, file, hostIndex) => {
    for (const match of value.matchAll(/skill:\/\/[^\s)<>"\]]+|sr:[CSR][A-Za-z0-9_-]{22}/g)) {
      const ref = unescape(match[0]);
      if (parseRef(ref) && !discovered.has(ref)) discovered.set(ref, { sequence, source });
    }
    if (file) for (const raw of [
      ...[...value.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)].map(match => match[1]),
      ...[...value.matchAll(/<code>([^<>\r\n]+)<\/code>|&lt;code&gt;([^<>\r\n]+?)&lt;\/code&gt;/g)].map(match => unescape(match[1] ?? match[2]).trim()),
    ]) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/') || raw.includes('#') || raw.includes('?')) continue;
      const parent = file.path.split('/').slice(0, -1);
      const parts = [...parent];
      let escaped = false;
      for (const part of raw.split('/')) { if (part === '..') { if (!parts.length) { escaped = true; break; } parts.pop(); } else if (part !== '.' && part) parts.push(part); }
      if (escaped) continue;
      const targetPath = parts.join('/');
      const targets = exportedFiles({ includePending: true }).filter(item => item.ownerId === file.ownerId && item.scope === file.scope && item.snapshot === file.snapshot && item.path === targetPath);
      const target = targets.length === 1 ? targets[0] : undefined;
      if (target) {
        discovered.set(target.ref, { sequence, source, scope: target.scope }); for (const actual of target.actuals) discovered.set(actual, { sequence, source, scope: target.scope });
        if (hostIndex && !raw.includes('\\')) {
          const alias = resolve(settings.path.dirname(hostIndex.main), raw);
          if (inside(hostIndex.root, alias)) hostIndex.aliases.set(alias, { ref: target.ref, scope: target.scope, ownerId: target.ownerId,
            snapshot: target.snapshot, path: target.path, fileId: target.fileId, sha256: target.sha256, bytes: target.bytes });
        }
      }
    }
  };
  const wasDiscovered = input => {
    const raw = parseRef(input), parsed = resolveMainReference(raw);
    if (raw && !parsed) return false;
    if (discovered.has(input) || advertisedPaths.has(input)) return true;
    if (parsed) return [...discovered].some(([ref, proof]) => { const old = parseRef(ref); return old && old.selector === parsed.selector && old.path === parsed.path
      && (parsed.fileId === undefined || old.fileId === parsed.fileId) && (parsed.scope === undefined || proof.scope === undefined || proof.scope === parsed.scope)
      && (parsed.snapshot === undefined || old.snapshot === parsed.snapshot || !raw.path && parsed.scope !== undefined); });
    const actual = canonicalReadPath(input);
    return actual && (Boolean(hostIndexAlias(input)) || [...discovered.keys(), ...advertisedPaths].some(path => !parseRef(path) && canonicalReadPath(path) === actual)
      || exportedFiles({ includePending: true }).some(file => file.actuals.includes(actual) && wasDiscovered(file.ref)));
  };
  const discoverProvidedPaths = (payload, files, contents, providerPayloadSha256) => {
    const hasOwnerDelivery = (value, file) => contextDeliveries.some(delivery => delivery.messageSha256 === digest(value)
      && delivery.receipt.binding?.record?.id === file.ownerId && delivery.receipt.binding.scope === file.scope
      && delivery.receipt.binding.snapshot_id === file.snapshot && delivery.receipt.binding.version_id === file.version
      && delivery.receipt.binding.ref === file.ref && delivery.receipt.snapshotId === file.snapshot
      && delivery.receipt.bodySha256 === file.sha256 && delivery.receipt.bytes === file.bytes);
    for (const value of sourceStrings(payload)) for (const match of value.matchAll(/<context-broker-record\b([^>]*)>([\s\S]*?)<\/context-broker-record>/g)) {
      const reference = unescape(/\bref="([^"]+)"/.exec(match[1])?.[1] ?? ''), selected = resolveMainReference(parseRef(reference));
      const delivered = files.filter(file => file.role === 'entrypoint' && selected?.selector === file.ownerId && selected.path === file.path
        && selected.snapshot === file.snapshot && (selected.scope === undefined || selected.scope === file.scope)
        && (selected.fileId === undefined || selected.fileId === file.fileId) && copies(match[2], file.content) === 1
        && contents.filter(content => content.ref === file.ref && content.scope === file.scope && content.sha256 === file.sha256).length === 1
        && hasOwnerDelivery(value, file));
      if (delivered.length === 1) {
        const file = delivered[0], proof = { source: 'actual Broker source wrapper', ref: file.ref,
          ownerId: file.ownerId, scope: file.scope, snapshot: file.snapshot, sha256: file.sha256, bytes: file.bytes };
        record({ phase: 'provided-native-reference', reference, ...proof, providerPayloadSha256 });
        discovered.set(reference, { sequence, ...proof });
      }
      const location = unescape(/\bpath="([^"]+)"/.exec(match[1])?.[1] ?? '');
      const suppliedRef = parseRef(unescape(/<skill-ref>\s*([^<]+)\s*<\/skill-ref>/.exec(match[2])?.[1]?.trim() ?? ''));
      const actual = canonicalReadPath(location);
      if (!actual || !suppliedRef) continue;
      const matches = files.filter(file => file.actuals.includes(actual) && file.ownerId === suppliedRef.selector
        && file.path === suppliedRef.path && file.snapshot === suppliedRef.snapshot
        && (suppliedRef.fileId === undefined || suppliedRef.fileId === file.fileId)
        && contents.some(content => content.ref === file.ref && content.scope === file.scope && content.sha256 === file.sha256));
      if (matches.length !== 1) continue;
      const file = matches[0];
      const proof = { sequence, source: 'actual provider advertised verified file', ref: file.ref, scope: file.scope, snapshot: file.snapshot, sha256: file.sha256 };
      if (!discovered.has(location)) record({ phase: 'provided-native-path', path: location, ref: file.ref, scope: file.scope, snapshot: file.snapshot, sha256: file.sha256, bytes: file.bytes });
      discovered.set(location, proof); discovered.set(actual, proof); discovered.set(file.ref, proof);
    }
    for (const value of sourceStrings(payload)) for (const match of value.matchAll(/<skill\b([^>]*)>([\s\S]*?)<\/skill>/g)) {
      const location = unescape(/\blocation="([^"]+)"/.exec(match[1])?.[1] ?? ''), actual = canonicalReadPath(location);
      if (!actual) continue;
      const matches = files.filter(file => file.role === 'entrypoint' && file.actuals.includes(actual) && copies(match[2], file.content) === 1
        && contents.some(content => content.ref === file.ref && content.scope === file.scope && content.sha256 === file.sha256)
        && hasOwnerDelivery(value, file));
      if (matches.length !== 1) continue;
      const file = matches[0], proof = { sequence, source: 'actual Pi native wrapper', ref: file.ref, scope: file.scope, snapshot: file.snapshot, sha256: file.sha256 };
      if (!discovered.has(location)) record({ phase: 'provided-native-path', source: proof.source, path: location, ref: file.ref, scope: file.scope, snapshot: file.snapshot, sha256: file.sha256, bytes: file.bytes });
      discovered.set(location, proof); discovered.set(actual, proof); discovered.set(file.ref, proof);
    }
  };
  const fileIdentity = file => ({ scope: file.scope, ownerId: file.ownerId, path: file.path, snapshot: file.snapshot,
    fileId: file.fileId, sha256: file.sha256, bytes: file.bytes });
  const refMatchesFile = (parsed, file, allowFileAlias = false) => parsed && parsed.selector === file.ownerId
    && (parsed.path === file.path || allowFileAlias && parsed.fileId !== undefined)
    && (parsed.scope === undefined || parsed.scope === file.scope)
    && (parsed.snapshot === undefined || parsed.snapshot === file.snapshot)
    && (parsed.fileId === undefined || parsed.fileId === file.fileId);
  const targetFor = (input, body, { expected, includePending = false } = {}) => {
    const parsed = resolveMainReference(parseRef(input));
    const alias = parsed ? undefined : hostIndexAlias(input);
    let available = exportedFiles({ includePending });
    if (parsed) available = available.filter(file => refMatchesFile(parsed, file, true));
    else if (alias) available = available.filter(file => file.ref === alias.ref && file.scope === alias.scope && file.ownerId === alias.ownerId
      && file.snapshot === alias.snapshot && file.fileId === alias.fileId && file.path === alias.path && file.sha256 === alias.sha256 && file.bytes === alias.bytes);
    else if (root && [...advertisedPaths].some(path => canonicalReadPath(path) === canonicalReadPath(input))) available = available.filter(file => file.ownerId === root.selector && file.role === 'entrypoint');
    else available = available.filter(file => file.actuals.includes(canonicalReadPath(input)));
    if (expected) available = available.filter(file => same(fileIdentity(file), expected));
    if (body !== undefined) available = available.filter(file => file.content === body);
    return available.length === 1 ? available[0] : undefined;
  };
  const verifiedPartialRead = (call, content) => {
    const authored = assistantCalls.get(call?.toolCallId), input = authored?.input;
    if (!call?.allowed || !call.discovered || call.origin !== 'model' || authored?.tool !== 'read'
      || authored.sequence !== call.authoredSequence || authored.argumentsSha256 !== call.argumentsSha256
      || !input || input.path !== call.input || digest(JSON.stringify(input)) !== call.argumentsSha256
      || Object.keys(input).some(key => !['path', 'offset', 'limit'].includes(key))) return undefined;
    const offset = input.offset ?? 1, limit = input.limit;
    if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1) return undefined;
    const source = targetFor(call.input, undefined, { expected: call.expected });
    if (!call.expected && !matchesClaim(call.claim, source)) return undefined;
    if (!source) return undefined;
    const lines = source.content.split('\n'), start = offset - 1, end = Math.min(start + limit, lines.length);
    if (start >= lines.length) return undefined;
    const slice = lines.slice(start, end).join('\n');
    // Match the installed Pi reader's explicit user-limit branch, without automatic line/byte truncation.
    const countedLines = slice === '' ? 0 : slice.split('\n').length - Number(slice.endsWith('\n'));
    if (slice === source.content || countedLines > 2000 || Buffer.byteLength(slice) > 50 * 1024) return undefined;
    const footer = end < lines.length ? '\n\n[' + (lines.length - end) + ' more lines in file. Use offset=' + (end + 1) + ' to continue.]' : '';
    if (content !== slice + footer) return undefined;
    return { source: { ref: source.ref, ...fileIdentity(source) }, offset, limit, startLine: offset, endLine: end,
      totalLines: lines.length, sliceSha256: digest(slice), sliceBytes: Buffer.byteLength(slice), footer };
  };
  const discoveredReadIdentity = input => {
    const raw = parseRef(input), parsed = resolveMainReference(raw);
    if (raw && !parsed) return undefined;
    if (!parsed) {
      const target = wasDiscovered(input) ? targetFor(input, undefined, { includePending: true }) : undefined;
      return target ? fileIdentity(target) : undefined;
    }
    const available = exportedFiles({ includePending: true }).filter(file => refMatchesFile(parsed, file, true)
      && [...discovered].some(([ref, proof]) => {
        const prior = parseRef(ref);
        return prior && prior.selector === parsed.selector && prior.path === parsed.path
          && (parsed.fileId === undefined || prior.fileId === parsed.fileId)
          && refMatchesFile(prior, file, parsed.fileId !== undefined) && (proof.scope === undefined || proof.scope === file.scope);
      }));
    return available.length === 1 ? fileIdentity(available[0]) : undefined;
  };
  const discoveredReadClaim = input => {
    const parsed = resolveMainReference(parseRef(input));
    if (!parsed || !wasDiscovered(input)) return undefined;
    const owners = sourceViews().directories.flatMap(item => (item.value.records ?? []).filter(record => record.id === parsed.selector)
      .map(record => ({ scope: item.value.scope, ownerId: record.id, path: parsed.path, snapshot: parsed.snapshot, fileId: parsed.fileId })))
      .filter(owner => parsed.scope === undefined || parsed.scope === owner.scope);
    const unique = [...new Map(owners.map(owner => [owner.scope + '/' + owner.ownerId, owner])).values()];
    return unique.length === 1 ? unique[0] : undefined;
  };
  const matchesClaim = (claim, file) => claim && file && claim.scope === file.scope && claim.ownerId === file.ownerId
    && (claim.path === file.path || claim.fileId !== undefined && claim.fileId === file.fileId)
    && (claim.snapshot === undefined || claim.snapshot === file.snapshot) && (claim.fileId === undefined || claim.fileId === file.fileId);
  const metadataCursors = new Map();
  const checkedMetadata = (content, call, details) => {
    const value = JSON.parse(content), outputs = sourceViews();
    const keys = ['id', 'ref', 'kind', 'name', 'description', 'source', 'scope', 'in_default_view', 'availability'];
    if (value.ok !== true || value.state !== 'known' || !Array.isArray(value.records)
      || value.count !== value.records.length || !Number.isSafeInteger(value.total_count) || value.total_count < value.count
      || !Array.isArray(value.failures)
      || typeof value.coverage?.exhaustive !== 'boolean' || !Array.isArray(value.coverage.sources)
      || Object.keys(value).some(key => !['ok', 'state', 'count', 'total_count', 'has_more', 'next_cursor', 'coverage', 'records', 'failures'].includes(key))) throw new Error('Notion list did not return its public directory contract');
    const offset = call.input.cursor === undefined ? 0 : Number(call.input.cursor.split('.')[0]);
    if (value.has_more !== (value.total_count > offset + value.count)
      || (value.has_more ? typeof value.next_cursor !== 'string' || !value.next_cursor.startsWith((offset + value.count) + '.') : value.next_cursor !== null)) throw new Error('Notion list pagination lost coverage');
    if (!details || !same(value, { ...details, records: details.records?.map(({ id, scope, ...item }) => item) })) throw new Error('Notion list model projection differs from the complete host details');
    for (const item of value.records) {
      const full = details.records.find(record => record.ref === item.ref), ref = resolveMainReference(parseRef(item.ref));
      const matches = outputs.directories.filter(output => output.value.scope === full?.scope)
        .flatMap(output => output.value.records ?? []).filter(record => record.id === full?.id);
      if (!ref || !matches.length || Object.keys(item).some(key => !keys.includes(key))
        || !matches.some(record => ['kind', 'name', 'description'].every(key => record[key] === item[key])
          && record.id === ref.selector && settings.parseNativeReference(record.ref).path === ref.path
          && (ref.scope === undefined || ref.scope === full.scope)
          && item.availability === (record.enabled === false ? 'disabled' : 'available'))) throw new Error('Notion list identity differs from the actual authorized source directory');
    }
    return value;
  };
  const checkedPreparation = (content, call, details) => {
    const verified = verifyPreparationEvidence(content, details, call.toolCallId);
    const value = verified.model, outputs = sourceViews(), files = exportedFiles(), requested = typeof call.input.ref === 'string' ? [call.input.ref] : call.input.ref;
    if (value.purpose !== 'use' || verified.projection.derived || verified.records.some(record => record.mapping.state !== 'source')) throw new Error('Notion use must deliver the entire original root and Requires closure');
    const graphs = details.graphs.map(graph => {
      const publicReceipt = outputs.preparations.find(output => output.value.status === 'ready'
        && output.value.purpose === 'use' && output.value.scope === graph.scope
        && same(output.value.graph_lock, graph.graph_lock) && same(output.value.budget, graph.budget)
        && same(output.value.usage, graph.usage) && same(output.value.roots.map(root => root.id), graph.roots));
      const { sha256, ...vector } = graph.graph_lock ?? {};
      if (!publicReceipt || digest(canonical(vector)) !== sha256) throw new Error('Prepare graph differs from its actual public version vector');
      return { ...graph, publicReceipt };
    });
    const explicitIds = [...new Set(requested.map(ref => parseRef(ref).selector))].sort();
    if (!same([...new Set(graphs.flatMap(graph => graph.roots))].sort(), explicitIds)) throw new Error('Prepare silently changed the model-selected roots');
    const expected = graphs.flatMap(graph => graph.publicReceipt.value.nodes.filter(node => node.state === 'prepared').map(node => graph.scope + '/' + node.id)).sort();
    if (!same(details.records.map(record => record.binding.scope + '/' + record.binding.record.id).sort(), expected)) throw new Error('Prepare output omitted or added a prepared instruction');
    const records = value.records.map((item, index) => {
      const proof = details.records[index], owner = proof.binding.record.id, scope = proof.binding.scope;
      const graph = graphs.find(graph => graph.scope === scope && graph.publicReceipt.value.nodes.some(node => node.state === 'prepared' && node.id === owner));
      const node = graph?.publicReceipt.value.nodes.find(node => node.id === owner && node.state === 'prepared');
      const file = files.find(file => file.role === 'entrypoint' && file.scope === scope && file.ownerId === owner && file.snapshot === proof.snapshotId && file.ref === proof.binding.ref);
      if (!node || !file || item.content !== file.content || !refMatchesFile(resolveMainReference(parseRef(item.ref)), file)
        || proof.bodySha256 !== file.sha256
        || proof.bytes !== file.bytes || proof.snapshotId !== file.snapshot || !same(proof.binding, node.binding)
        || !same(proof.directory?.files, node.files)
        || !['required', 'candidates', 'references'].every(key => same(proof.directory?.[key], node[key].map(({ id, ref, kind, name, description, availability }) => ({ id, ref, kind, name, description, availability }))))) throw new Error('Prepared main differs from its actual source, manifest or delivery span');
      verifyDirectoryRefs(item.directory, proof.directory);
      const explicitRoot = graph.roots.includes(owner);
      for (const ref of requested.filter(ref => parseRef(ref).selector === owner)) {
        const parsed = resolveMainReference(parseRef(ref));
        if (!parsed || parsed.path !== file.path || parsed.scope && parsed.scope !== file.scope || parsed.snapshot && parsed.snapshot !== file.snapshot || parsed.fileId && parsed.fileId !== file.fileId) throw new Error('Prepared main changed an explicit pin or File ID');
      }
      return { ...file, preparationProof: { purpose: 'use', explicitRoot,
        roots: requested.map(ref => { const selected = parseRef(ref); return graphs.filter(graph => selected.scope === undefined || selected.scope === graph.scope).flatMap(graph => graph.publicReceipt.value.nodes).find(node => node.state === 'prepared' && node.id === selected.selector).binding.ref; }),
        requestedRefs: requested,
        publicRequestId: graph.publicReceipt.requestId, graphLockSha256: graph.graph_lock.sha256,
        manifestSha256: file.manifestSha256, publicRef: node.binding.ref, scope: file.scope, ownerId: file.ownerId,
        snapshot: file.snapshot, sha256: file.sha256, bytes: file.bytes,
        toolResultSha256: digest(content), toolResultBytes: Buffer.byteLength(content), deliveryVerified: true } };
    });
    return { value, records };
  };
  const checkedResourceBatch = (content, call, details) => {
    const proof = settings.validateResourceReadProjection?.(content, details?.contextBrokerResource);
    if (!proof || proof.toolCallId !== call.toolCallId || proof.projection.derived
      || proof.files.length !== call.input.length || proof.files.some(file => file.state !== 'source' || !file.delivered_complete_text)) throw new Error('Resource batch lacks complete original text spans');
    const model = JSON.parse(content), outputs = sourceViews();
    const source = outputs.resources.find(item => same(item.value, details?.contextBrokerResourceSource?.result)
      && same(item.value.selection, proof.selection));
    if (!source) throw new Error('Resource batch lacks its actual observed SDK result');
    return model.files.map((item, index) => {
      const sourceFile = source.value.files[index], receipt = proof.files[index], parsed = parseRef(call.input[index]);
      const target = targetFor(call.input[index], item.content, { expected: call.expected[index] });
      if (!target || target.role !== 'resource' || !sourceFile || item.kind !== 'text'
        || sourceFile.content !== item.content || receipt.requested_ref !== sourceFile.requested_ref || receipt.ref !== sourceFile.ref
        || receipt.ref !== target.ref || receipt.file_id !== target.fileId || receipt.path !== target.path
        || receipt.sha256 !== target.sha256 || receipt.bytes !== target.bytes
        || !refMatchesFile(parsed, target, true) || !refMatchesFile(parseRef(item.ref), target)
        || !same(proof.selection, { scope: target.scope, owner: target.ownerId, snapshot_id: target.snapshot, version_id: target.version })) throw new Error('Resource batch changed a discovered owner, pin, file or complete body');
      return { ...target, resourceBatchProof: { selection: proof.selection, index, publicRequestId: source.requestId,
        delivery: receipt.delivery, deliveryVerified: true, toolResultSha256: digest(content), toolResultBytes: Buffer.byteLength(content) } };
    });
  };
  const verifyDirectoryRefs = (model, proof) => {
    for (const group of ['files', 'required', 'candidates', 'references']) {
      if (!Array.isArray(model?.[group]) || model[group].length !== proof?.[group]?.length) throw new Error('The model directory lost a complete source group');
      for (let index = 0; index < model[group].length; index++) {
        const actual = resolveMainReference(parseRef(model[group][index].ref)), expected = resolveMainReference(parseRef(proof[group][index].ref));
        if (!actual || !expected || actual.selector !== expected.selector || actual.path !== expected.path
          || actual.snapshot !== expected.snapshot || actual.fileId !== expected.fileId
          || actual.scope !== undefined && expected.scope !== undefined && actual.scope !== expected.scope) throw new Error('The model directory reference changed source identity or version');
      }
    }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    let body, serialized;
    try { const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined); if (typeof raw === 'string') { serialized = raw; body = JSON.parse(raw); } } catch { /* Non-model authentication transport. */ }
    if (body && typeof body.model === 'string') {
      if (!wireAllowed(body.model)) throw new Error('Graph gate rejected an unauthorized transport model');
      const observedPayloadSha256 = digest(canonical(body));
      if (verifiedPayloadHash !== observedPayloadSha256) {
        const error = observerFault('provider-transport', new Error('Provider transport has no matching verified observation payload.'), body);
        record({ phase: 'provider-transport-blocked', reason: 'unverified_observer_payload', model: settings.model, wireModel: body.model, observedPayloadSha256 });
        throw error;
      }
      const wireBodyFile = settings.payloads ? 'http-' + sequence + '.json' : undefined;
      if (wireBodyFile) settings.fs.writeFileSync(join(settings.payloads, wireBodyFile), serialized, { mode: 0o600, flag: 'wx' });
      record({ phase: 'provider-transport-start', model: settings.model, wireModel: body.model, observedPayloadSha256,
        wireBodySha256: digest(serialized), wireBodyBytes: Buffer.byteLength(serialized), ...(wireBodyFile ? { wireBodyFile } : {}) });
      try { const response = await originalFetch.call(this, input, init); record({ phase: 'provider-transport-response', status: response.status }); return response; }
      catch (error) { record({ phase: 'provider-transport-error', name: error.name, code: typeof error.code === 'string' ? error.code : null }); throw error; }
    }
    return originalFetch.call(this, input, init);
  };
  api.on('session_start', async (_event, ctx) => { refreshContext(ctx); assertModel(ctx); const selected = toolSurface(); await api.setActiveTools(selected.tools); record({ phase: 'selected', model: settings.model, tools: selected.tools, toolSurface: selected.surface, fallbackTools: false }); });
  const observeCatalog = (prompt, observation, admit = false) => {
    const skills = [...prompt.matchAll(/<skill>[\s\S]*?<name>\s*([^<]+)\s*<\/name>[\s\S]*?<location>\s*([^<]+)\s*<\/location>[\s\S]*?<\/skill>/g)].map(match => {
      const file = unescape(match[2].trim());
      let provenance = null, sha256 = null;
      const selected = resolveMainReference(parseRef(file));
      if (selected) {
        const matches = sourceViews().directories.flatMap(item => (item.value.records ?? []).map(record => ({ record, scope: item.value.scope })))
          .filter(item => item.record.id === selected.selector && item.record.kind === 'skill'
            && settings.parseNativeReference(item.record.ref).path === selected.path && (selected.scope === undefined || selected.scope === item.scope));
        const unique = [...new Map(matches.map(item => [item.scope + '/' + item.record.id, item])).values()];
        const description = unescape(/<description>\s*([\s\S]*?)\s*<\/description>/.exec(match[0])?.[1] ?? '');
        if (unique.length === 1 && unescape(match[1].trim()) === unique[0].record.name && description === unique[0].record.description) provenance = { source: 'verified-notion-metadata',
          ownerId: unique[0].record.id, scope: unique[0].scope, ref: unique[0].record.ref, loaded: false };
      }
      try {
        if (selected) return { name: match[1].trim(), path: file, sha256, provenance };
        const actual = realpathSync(file), bytes = readFileSync(actual); sha256 = digest(bytes);
        let directory = settings.path.dirname(actual);
        for (let level = 0; level < 6; level++) {
          try {
            const raw = readFileSync(join(directory, '.broker-host-index.json'));
            const receipt = JSON.parse(raw.toString('utf8'));
            const read = sourceViews().entries.find(item => item.value.record?.id === receipt.id && item.value.scope === receipt.scope && item.value.snapshot_id === receipt.snapshot_id && item.value.path === receipt.entrypoint)?.value;
            const source = exportedFiles().find(item => item.ownerId === receipt.id && item.scope === receipt.scope && item.snapshot === receipt.snapshot_id && item.role === 'entrypoint' && item.projection === 'entry');
            const published = receipt.published?.path;
            const manifest = readFileSync(join(settings.cache, 'scopes', receipt.scope, 'records', digest(receipt.id), 'entries', receipt.snapshot_id, '.broker-entry.json'));
            if (root && receipt.version === 1 && receipt.projection === 'host_index' && receipt.loaded === false && receipt.id === root.selector && read && source && receipt.ref === read.ref && receipt.version_id === read.version_id && receipt.source?.bytes === source.bytes && receipt.source?.sha256 === source.sha256 && typeof published === 'string' && published && !published.split('/').some(part => !part || part === '.' || part === '..') && actual === join(directory, published) && receipt.published.bytes === bytes.length && receipt.published.sha256 === digest(bytes) && receipt.manifest_id === digest(JSON.stringify(JSON.parse(manifest.toString('utf8')))))
              provenance = { source: 'verified-notion-host-index', ownerId: receipt.id, scope: receipt.scope, snapshot: receipt.snapshot_id, receiptSha256: digest(raw), manifestSha256: receipt.manifest_id, sourceMainSha256: source.sha256, publishedSha256: digest(bytes), loaded: false };
            break;
          } catch (error) { if (error.code !== 'ENOENT') break; }
          try {
            const raw = readFileSync(join(directory, '.broker-snapshot.json'));
            const receipt = JSON.parse(raw.toString('utf8'));
            const read = sourceViews().entries.find(item => item.value.record?.id === receipt.record?.id && item.value.scope === receipt.scope && item.value.snapshot_id === receipt.snapshot)?.value;
            if (root && receipt.version === 3 && receipt.projection === 'snapshot' && receipt.record.id === root.selector && read)
              provenance = { source: 'verified-notion-host-snapshot', ownerId: receipt.record.id, scope: receipt.scope, snapshot: receipt.snapshot, receiptSha256: digest(raw) };
            break;
          } catch { directory = settings.path.dirname(directory); }
        }
      } catch { /* An unreadable or unbound catalog path is not a verified Notion advertisement. */ }
      return { name: match[1].trim(), path: file, sha256, provenance };
    });
    const routers = [...prompt.matchAll(/<router\b[^>]*\bref="([^"]+)"[^>]*>([\s\S]*?)<\/router>/g)].map(match => {
      const ref = unescape(match[1]), parsed = resolveMainReference(parseRef(ref));
      const candidates = sourceViews().directories.flatMap(item => (item.value.records ?? []).map(record => ({ record, scope: item.value.scope })))
        .filter(item => item.record.kind === 'router' && item.record.id === parsed?.selector && settings.parseNativeReference(item.record.ref).path === parsed.path
          && (parsed.scope === undefined || parsed.scope === item.scope));
      const unique = [...new Map(candidates.map(item => [item.scope + '/' + item.record.id, item])).values()];
      const source = unique.length === 1 ? unique[0] : undefined;
      const name = unescape(/<name>\s*([^<]*)\s*<\/name>/.exec(match[2])?.[1] ?? '');
      const description = unescape(/<description>\s*([\s\S]*?)\s*<\/description>/.exec(match[2])?.[1] ?? '');
      return { ref, ...(source && source.record.name === name && source.record.description === description
        ? { canonicalRef: source.record.ref, provenance: { source: 'verified-notion-metadata', ownerId: source.record.id, scope: source.scope, loaded: false } } : {}) };
    });
    const state = /<ntn-skills-discovery\b[^>]*\bstatus="([^"]+)"/.exec(prompt)?.[1] ?? 'ready';
    if (admit) {
      for (const skill of skills) if (skill.provenance) { advertisedPaths.add(skill.path); discover(skill.path, 'actual provider catalog'); }
      for (const router of routers) if (router.provenance) discover(router.ref, 'actual provider catalog');
    }
    return record({ ...observation, state, skills, routers, systemPromptSha256: digest(prompt), systemPromptBytes: Buffer.byteLength(prompt), localDiscoveryDisabled: true });
  };
  let userTurn = 0;
  api.on('before_agent_start', (event, ctx) => {
    refreshContext(ctx); assertModel(ctx);
    const prompt = typeof event.systemPrompt === 'string' ? event.systemPrompt : (event.systemPrompt ?? []).join('\n');
    observeCatalog(prompt, { phase: 'catalog-before-agent-start', stage: 'before_agent_start', userTurn: ++userTurn,
      submittedPromptSha256: digest(event.prompt ?? ''), frozenPromptMatched: event.prompt === settings.prompt });
    if (projectFiles.size) {
      if (!event.systemPromptOptions?.sections) throw new Error('Graph project paths require public mutable system prompt sections');
      event.systemPromptOptions.sections['graph-owned-project-files'] = '\n\nCurrent owned project files (paths only; read the actual source when needed):\n' + [...projectFiles.values()].map(file => '- ' + file.path).join('\n') + '\n';
    }
  });
  api.on('context_with_system', (event, ctx) => {
    refreshContext(ctx); assertModel(ctx);
    record({ phase: 'system-context', stage: 'context_with_system', userTurn,
      messages: event.messages.filter(message => message.role === 'system').map(message => ({
        contentSha256: digest(text(message.content)), contentBytes: Buffer.byteLength(text(message.content)),
        sections: Object.fromEntries(Object.entries(message.sections ?? {}).map(([name, value]) => [name,
          value === null ? null : { sha256: digest(value), bytes: Buffer.byteLength(value) }])) })) });
  });
  api.on('context', (event, ctx) => {
    refreshContext(ctx);
    assertModel(ctx);
    const visible = event.messages.filter(message => !['assistant', 'model'].includes(message.role)), texts = visible.map(message => text(message.content));
    contextDeliveries = visible.flatMap(message => message.details?.records ?? []).flatMap(receipt => {
      const span = receipt.delivery;
      if (receipt.version !== 2 || receipt.loaded !== true || !receipt.binding || !span || !Number.isSafeInteger(span.start)
        || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start || !['raw', 'xml', 'json'].includes(span.encoding)) return [];
      return texts.flatMap(value => {
        if (span.end > value.length) return [];
        try {
          const raw = value.slice(span.start, span.end), body = span.encoding === 'xml' ? unescape(raw) : span.encoding === 'json' ? JSON.parse('"' + raw + '"') : raw;
          return digest(body) === receipt.bodySha256 && Buffer.byteLength(body) === receipt.bytes ? [{ receipt, messageSha256: digest(value) }] : [];
        } catch { return []; }
      });
    });
    record({ phase: 'agent-context', messages: event.messages.map(message => ({ role: message.role, customType: message.customType, toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError, contentSha256: digest(text(message.content)), contentBytes: Buffer.byteLength(text(message.content)), ...(message.details?.records ? { records: message.details.records } : {}), ...(message.details?.contextBrokerRead ? { read: message.details.contextBrokerRead } : {}), ...(message.details?.contextBrokerPreparation ? { preparation: message.details.contextBrokerPreparation } : {}) })) });
  });
  api.on('before_provider_request', (event, ctx) => {
    refreshContext(ctx);
    verifiedPayloadHash = undefined;
    try {
    assertModel(ctx);
    if (event.payload?.model !== undefined && !wireAllowed(event.payload.model)) throw new Error('Graph gate rejected an unauthorized provider model');
    const toolChoice = event.payload?.tool_choice ?? event.payload?.toolChoice;
    if (toolChoice !== undefined && toolChoice !== 'auto' && toolChoice?.type !== 'auto') throw new Error('Graph gate requires autonomous tool selection');
    const advertisedTools = (event.payload?.tools ?? []).map(tool => tool.function?.name ?? tool.name).sort();
    const selected = toolSurface();
    if (!same(advertisedTools, [...selected.tools].sort())) throw new Error('Graph gate must advertise exactly the frozen native tool surface without shell');
    const files = exportedFiles();
    const contents = files.flatMap(file => Array.from({ length: copies(event.payload, file.content) }, () => ({ ref: file.ref, logicalId: file.logicalId, ownerId: file.ownerId, scope: file.scope, snapshot: file.snapshot, sha256: file.sha256, bytes: file.bytes, role: file.role, content: file.content })));
    for (const { content, ...file } of settings.piHelpBoundary?.observeProvider(event.payload) ?? []) record({ phase: 'host-help-advertised', ...file });
    const hostHelp = (settings.piHelpBoundary?.consumed() ?? []).map(({ content, ...file }) => ({ ...file, copies: copies(event.payload, content) })).filter(file => file.copies > 0);
    const serialized = JSON.stringify(event.payload);
    const observedPayloadSha256 = digest(canonical(JSON.parse(serialized)));
    discoverProvidedPaths(event.payload, files, contents, observedPayloadSha256);
    for (const file of files) if (contents.some(item => item.ref === file.ref)) discover(file.content, 'actual provider source body', file);
    for (const value of sourceStrings(event.payload)) if (contextDeliveries.some(delivery => delivery.messageSha256 === digest(value)))
      discover(value, 'actual provider verified delivery');
    for (const message of event.payload?.messages ?? []) if (message.role === 'user')
      for (const value of sourceStrings(message.content)) if (value === settings.prompt) discover(value, 'actual frozen user reference');
    const toolResults = [...deliveredTools.values()].map(result => ({ toolCallId: result.toolCallId, tool: result.tool, sha256: digest(result.content), bytes: Buffer.byteLength(result.content), copies: copies(event.payload, result.content),
      exactToolOutputCopies: providerToolOutputs(event.payload, result.toolCallId).filter(content => content === result.content).length,
      records: (result.records ?? []).map(file => ({ ref: file.ref, scope: file.scope, snapshot: file.snapshot, sha256: file.sha256, bytes: file.bytes, providerCopies: contents.filter(item => item.ref === file.ref && item.scope === file.scope && item.sha256 === file.sha256).length })) }));
    const payloadFile = settings.payloads ? 'payload-' + sequence + '.json' : undefined;
    if (payloadFile) settings.fs.writeFileSync(join(settings.payloads, payloadFile), serialized, { mode: 0o600, flag: 'wx' });
    const system = [text(event.payload?.system), ...(event.payload?.messages ?? []).filter(message => message.role === 'system').map(message => text(message.content))].filter(Boolean).join('\n\n');
    observeCatalog(system, { phase: 'catalog', stage: 'before_provider_request', userTurn, providerPayloadSha256: observedPayloadSha256 }, true);
    record({ phase: 'provider-request', model: settings.model, tools: advertisedTools, toolSurface: selected.surface, toolDefinitionsSha256: digest(JSON.stringify(event.payload?.tools)), toolChoice: 'auto', forcedToolArguments: false, payloadSha256: digest(serialized), payloadBytes: Buffer.byteLength(serialized), ...(payloadFile ? { payloadFile } : {}), observedPayloadSha256, contents, hostHelp, toolResults, sourceTextHashes: sourceStrings(event.payload).map(value => ({ sha256: digest(value), bytes: Buffer.byteLength(value) })) });
    verifiedPayloadHash = observedPayloadSha256;
    } catch (error) { throw observerFault('before_provider_request', error, event.payload); }
  });
  api.on('after_provider_response', event => record({ phase: 'provider-response', status: typeof event.status === 'number' ? event.status : null }));
  api.on('message_end', (event, ctx) => {
    refreshContext(ctx);
    const message = event.message;
    if (message?.role !== 'assistant') return;
    for (const part of message.content ?? []) if (part.type === 'toolCall') {
      const input = JSON.parse(JSON.stringify(part.arguments)), selected = part.name === 'read' ? input?.paths ?? input?.path : input;
      const requested = typeof selected?.ref === 'string' ? [selected.ref] : selected?.ref;
      const discovered = part.name === 'notion_use' ? Array.isArray(requested) && requested.length > 0 && requested.every(ref => wasDiscovered(ref))
        : part.name === 'read' && (typeof selected === 'string' ? wasDiscovered(selected)
          : Array.isArray(selected) && selected.length > 0 && selected.every(ref => typeof ref === 'string' && wasDiscovered(ref)));
      const observed = record({ phase: 'authored-tool-call', source: 'assistant-message-end', toolCallId: part.id, tool: part.name, input,
        argumentsSha256: digest(JSON.stringify(input)), discovered });
      assistantCalls.set(part.id, { tool: part.name, input, sequence: observed.sequence, at: observed.at, argumentsSha256: observed.argumentsSha256 });
    }
    const value = text(message.content);
    if (value.trim()) record({ phase: 'assistant-final', success: ['stop', 'length'].includes(message.stopReason), stopReason: message.stopReason ?? null, text: value, sha256: digest(value), bytes: Buffer.byteLength(value) });
  });
  api.on('tool_call', (event, ctx) => {
    refreshContext(ctx);
    const authored = assistantCalls.get(event.toolCallId);
    const payload = authored?.input ?? event.input;
    const batch = event.toolName === 'read' && Object.hasOwn(payload ?? {}, 'paths');
    const input = event.toolName === 'read' ? batch ? payload.paths : payload?.path : payload;
    const batchTargets = batch && Array.isArray(input) && input.length > 0 && input.length <= 16 && Object.keys(payload).length === 1
      ? input.map(ref => typeof ref === 'string' && parseRef(ref)?.snapshot && discoveredReadIdentity(ref)) : undefined;
    const batchAllowed = batchTargets?.every(Boolean) && new Set(batchTargets.map(target => JSON.stringify([target.scope, target.ownerId, target.snapshot]))).size === 1
      && new Set(batchTargets.map(target => target.fileId ?? target.path)).size === batchTargets.length
      && input.every((ref, index) => targetFor(ref, undefined, { expected: batchTargets[index], includePending: true })?.role === 'resource');
    const expected = batch ? batchTargets : event.toolName === 'read' && typeof input === 'string' ? discoveredReadIdentity(input) : undefined;
    const claim = event.toolName === 'read' && typeof input === 'string' ? discoveredReadClaim(input) : undefined;
    const requested = typeof input?.ref === 'string' ? [input.ref] : input?.ref;
    const discoveredBefore = event.toolName === 'notion_use'
      ? Array.isArray(requested) && requested.length > 0 && requested.every(ref => typeof ref === 'string' && parseRef(ref) && wasDiscovered(ref))
      : batch ? Boolean(batchAllowed) : Boolean(expected || claim);
    const projectPath = typeof input === 'string' && !parseRef(input) ? canonicalReadPath(input) : undefined;
    const project = projectFiles.get(projectPath);
    let help;
    try { if (event.toolName === 'read' && typeof input === 'string') help = settings.piHelpBoundary?.target(input); }
    catch (error) { observerFault('host-help-read', error); return { block: true, reason: 'The advertised host documentation changed or could not be verified.' }; }
    const metadata = event.toolName === 'notion_list' && input && (input.query === undefined || typeof input.query === 'string' && input.query.length <= 512)
      && (input.source === undefined || typeof input.source === 'string')
      && (input.limit === undefined || Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 100)
      && (input.cursor === undefined || typeof input.cursor === 'string' && metadataCursors.get(input.cursor) === JSON.stringify([input.query ?? '', input.source ?? null]))
      && Object.keys(input).every(key => ['query', 'source', 'limit', 'cursor'].includes(key));
    const preparation = event.toolName === 'notion_use' && discoveredBefore && requested.length <= 64
      && (input.refresh === undefined || typeof input.refresh === 'boolean')
      && Object.keys(input).every(key => ['ref', 'refresh'].includes(key)) && requested.every(ref => {
        const parsed = resolveMainReference(parseRef(ref));
        if (!parsed || ref.startsWith('sr:R')) return false;
        const views = sourceViews(), records = [...views.directories.flatMap(item => item.value.records ?? []), ...views.entries.map(item => item.value.record)];
        return records.some(record => record.id === parsed.selector && settings.parseNativeReference(record.ref).path === parsed.path && ['skill', 'router'].includes(record.kind));
      });
    const allowed = toolSurface().tools.includes(event.toolName) && authored?.tool === event.toolName && (event.toolName === 'read' && (discoveredBefore || Boolean(project) || Boolean(help)) || metadata || preparation);
    const category = !allowed ? 'blocked' : help ? 'host-help' : project ? 'project' : metadata ? 'metadata' : preparation ? 'preparation' : batch ? 'resource-batch' : 'skill';
    const authoredProof = authored ? { authoredSequence: authored.sequence, authoredAt: authored.at, argumentsSha256: authored.argumentsSha256 } : {};
    calls.set(event.toolCallId, { toolCallId: event.toolCallId, input, projectPath, category, discovered: discoveredBefore, expected, claim, ...authoredProof, origin: authored ? 'model' : 'unknown', sequence: sequence + 1, allowed });
    record({ phase: 'tool-call', toolCallId: event.toolCallId, tool: event.toolName, input, category, allowed, discovered: discoveredBefore, expected, claim, ...authoredProof, origin: authored ? 'model' : 'unknown' });
    if (!allowed) return { block: true, reason: 'This gate permits owned project reads, actual advertised installed Pi help, notion_list and exact read/notion_use references discovered from the selected root or successful tool results.' };
  });
  api.on('tool_result', (event, ctx) => {
    refreshContext(ctx);
    const call = calls.get(event.toolCallId), content = text(event.content);
    if (event.toolName === 'notion_list' && call?.allowed) {
      try {
        if (event.isError) throw new Error('Metadata search failed');
        const result = checkedMetadata(content, call, event.details);
        record({ phase: 'metadata-result', toolCallId: event.toolCallId, tool: event.toolName, origin: call.origin, complete: true, sha256: digest(content), bytes: Buffer.byteLength(content), records: result.records, content, callSequence: call.sequence });
        for (const item of event.details.records) if (item.availability === 'available') discovered.set(item.ref, { sequence, source: 'actual authorized metadata list', id: item.id, scope: item.scope });
        if (result.next_cursor) metadataCursors.set(result.next_cursor, JSON.stringify([call.input.query ?? '', call.input.source ?? null]));
        deliveredTools.set(event.toolCallId, { toolCallId: event.toolCallId, tool: event.toolName, content });
      } catch (error) { record({ phase: 'metadata-result', toolCallId: event.toolCallId, complete: false, error: error.message, sha256: digest(content), bytes: Buffer.byteLength(content) }); }
      return;
    }
    if (event.toolName === 'notion_use' && call?.allowed) {
      try {
        if (event.isError) throw new Error('Explicit preparation failed');
        if (event.parentToolCallId) throw new Error('Only a model-visible top-level use result can prove delivery');
        const result = checkedPreparation(content, call, event.details?.contextBrokerPreparation);
        const requested = typeof call.input.ref === 'string' ? [call.input.ref] : call.input.ref;
        record({ phase: 'preparation-result', toolCallId: event.toolCallId, tool: event.toolName, purpose: 'use', roots: requested, complete: true, sha256: digest(content), bytes: Buffer.byteLength(content), content, callSequence: call.sequence });
        for (const target of result.records) {
          record({ phase: 'tool-result', toolCallId: event.toolCallId, tool: 'notion_use', origin: call.origin, discovered: call.discovered && target.preparationProof.explicitRoot, callSequence: call.sequence, requested, complete: true, error: null,
            ref: target.ref, logicalId: target.logicalId, ownerId: target.ownerId, scope: target.scope, snapshot: target.snapshot, sha256: target.sha256, bytes: target.bytes, role: target.role, path: target.path, content: target.content, preparationProof: target.preparationProof });
          discover(target.content, 'successful explicit preparation', target);
        }
        discover(content, 'successful explicit preparation directory');
        deliveredTools.set(event.toolCallId, { toolCallId: event.toolCallId, tool: event.toolName, content, records: result.records });
      } catch (error) { record({ phase: 'tool-result', toolCallId: event.toolCallId, tool: 'notion_use', origin: call.origin, complete: false, error: error.message, sha256: digest(content), bytes: Buffer.byteLength(content), callSequence: call.sequence }); }
      return;
    }
    if (event.toolName !== 'read') { record({ phase: 'blocked-tool-result', toolCallId: event.toolCallId, tool: event.toolName, error: event.isError, sha256: digest(content), bytes: Buffer.byteLength(content) }); return; }
    if (call?.category === 'host-help') {
      try {
        const proof = settings.piHelpBoundary.verifyRead(call.input, content, event.isError);
        record({ phase: 'host-help-read-result', toolCallId: event.toolCallId, origin: call.origin, callSequence: call.sequence, ...proof });
        if (proof?.complete) deliveredTools.set(event.toolCallId, { toolCallId: event.toolCallId, tool: event.toolName, content });
      } catch (error) { observerFault('host-help-result', error); }
      return;
    }
    if (call?.category === 'project') {
      const file = projectFiles.get(call.projectPath);
      const actual = readFileSync(call.projectPath);
      const complete = !event.isError && call.allowed && realpathSync(call.projectPath) === call.projectPath && digest(actual) === file.sha256 && digest(content) === file.sha256 && Buffer.byteLength(content) === file.bytes;
      record({ phase: 'project-read-result', toolCallId: event.toolCallId, path: file.path, complete, sourceSha256: file.sha256, returnedSha256: digest(content), bytes: Buffer.byteLength(content), origin: call.origin, callSequence: call.sequence });
      return;
    }
    if (call?.category === 'blocked') { record({ phase: 'blocked-read-result', toolCallId: event.toolCallId, requested: call.input, returnedSha256: digest(content), error: event.isError }); return; }
    if (call?.category === 'resource-batch') {
      try {
        if (event.isError || event.parentToolCallId) throw new Error('Only a complete model-visible resource batch proves delivery');
        const targets = checkedResourceBatch(content, call, event.details);
        for (const target of targets) {
          record({ phase: 'tool-result', toolCallId: event.toolCallId, tool: 'read', origin: call.origin, discovered: call.discovered,
            callSequence: call.sequence, requested: call.input, complete: true, error: null, ref: target.ref, logicalId: target.logicalId,
            ownerId: target.ownerId, scope: target.scope, snapshot: target.snapshot, sha256: target.sha256, bytes: target.bytes,
            role: target.role, path: target.path, fileId: target.fileId, content: target.content, resourceBatchProof: target.resourceBatchProof });
          discover(target.content, 'successful native resource batch', target);
        }
        deliveredTools.set(event.toolCallId, { toolCallId: event.toolCallId, tool: event.toolName, content, records: targets });
      } catch (error) { record({ phase: 'tool-result', toolCallId: event.toolCallId, tool: 'read', origin: call.origin, complete: false,
        error: error.message, sha256: digest(content), bytes: Buffer.byteLength(content), callSequence: call.sequence }); }
      return;
    }
    let body = content, nativeProofError;
    const nativeProof = event.details?.contextBrokerRead;
    if (nativeProof?.version === 3) {
      const span = nativeProof.delivery;
      if (span?.start !== 0 || span.encoding !== 'raw' || !Number.isSafeInteger(span.end) || span.end <= 0 || span.end > content.length) nativeProofError = 'Native main lacks its complete source span';
      else body = content.slice(0, span.end);
    }
    let target = call?.allowed ? targetFor(call.input, body, { expected: call.expected }) : undefined;
    if (target && !call.expected && !matchesClaim(call.claim, target)) target = undefined;
    if (target?.role === 'entrypoint' && (settings.sourceMode === 'sdk' || nativeProof)) {
      try {
        const node = sourceViews().preparations.flatMap(item => item.value.scope === target.scope ? item.value.nodes ?? [] : [])
          .find(node => node.state === 'prepared' && node.id === target.ownerId && node.binding.snapshot_id === target.snapshot);
        if (nativeProofError || !node || ![2, 3].includes(nativeProof?.version) || nativeProof.toolCallId !== event.toolCallId
          || nativeProof.snapshotId !== target.snapshot || nativeProof.bodySha256 !== target.sha256 || nativeProof.bytes !== target.bytes
          || !same(nativeProof.binding, node.binding) || nativeProof.loaded === true) throw new Error(nativeProofError ?? 'Native inspection receipt differs from the actual source entry');
        if (nativeProof.version === 3) {
          const footer = /^\n{2,3}<skill-directory>\n([\s\S]*)\n<\/skill-directory>$/.exec(content.slice(body.length));
          if (!footer) throw new Error('Native inspection has an unverified footer');
          const model = JSON.parse(footer[1]);
          if (!same(Object.keys(model).sort(), ['directory', 'ref']) || !refMatchesFile(resolveMainReference(parseRef(model.ref)), target)) throw new Error('Native inspection main reference changed');
          const directory = { files: node.files, ...Object.fromEntries(['required', 'candidates', 'references'].map(key => [key,
            node[key].map(({ id, ref, kind, name, description, availability }) => ({ id, ref, kind, name, description, availability }))])) };
          if (!same(nativeProof.directory, directory)) throw new Error('Native inspection lost the canonical directory');
          verifyDirectoryRefs(model.directory, directory);
          for (const group of ['files', 'required', 'candidates', 'references']) for (let i = 0; i < directory[group].length; i++) {
            const fields = group === 'files' ? ['path', 'ref', 'bytes'] : ['ref', 'kind', 'name', 'description', 'availability'];
            if (!same(Object.keys(model.directory[group][i]).sort(), [...fields].sort())
              || !fields.filter(key => key !== 'ref').every(key => same(model.directory[group][i][key], directory[group][i][key]))) throw new Error('Native inspection directory changed source metadata');
          }
        }
      } catch (error) { nativeProofError = error.message; target = undefined; }
    }
    const complete = Boolean(target && !event.isError && !event.parentToolCallId && call?.allowed);
    const partialRead = !complete && !event.isError ? verifiedPartialRead(call, content) : undefined;
    record({ phase: 'tool-result', toolCallId: event.toolCallId, tool: 'read', origin: call?.origin ?? 'unknown', discovered: call?.discovered ?? false, callSequence: call?.sequence, requested: call?.input, complete, error: nativeProofError ?? (event.isError || !target && !partialRead ? 'native read did not match one complete immutable file' : null), ...(partialRead ? { partialRead } : {}), ...(target ? { ref: target.ref, logicalId: target.logicalId, ownerId: target.ownerId, scope: target.scope, snapshot: target.snapshot, sha256: digest(body), bytes: Buffer.byteLength(body), role: target.role, path: target.path, fileId: target.fileId, content: body } : { sha256: digest(content), bytes: Buffer.byteLength(content) }) });
    if (partialRead) deliveredTools.set(event.toolCallId, { toolCallId: event.toolCallId, tool: event.toolName, content });
    if (complete) {
      discover(body, 'successful native read', target, bindHostIndex(call.input, target));
      discover(content, 'successful native read directory');
      deliveredTools.set(event.toolCallId, { toolCallId: event.toolCallId, tool: event.toolName, content, records: [target] });
    }
  });
  api.on('session_shutdown', () => record({ phase: 'session-shutdown' }));
}

export async function readGateConfig(path) {
  assert.ok(isAbsolute(path), '--config must be absolute');
  const input = await json(path);
  const allowed = ['version', 'gate', 'selection', 'rootRef', 'database', 'viewId', 'profileId', 'sourceMode', 'extension', 'packagePath', 'cliCommand', 'oraclePath', 'evidenceRoot', 'model', 'promptTimeoutMs', 'previousFailures', 'workerAuthorization', 'preparation', 'mode', 'reuseReceipt', 'selectionReceipt', 'retainedSourceProofRepo'];
  assert.ok(input && Object.keys(input).every(key => allowed.includes(key)), 'Unknown graph-model configuration field');
  assert.equal(input.version, 1);
  const promptTimeoutMs = input.promptTimeoutMs === undefined ? 300000 : input.promptTimeoutMs;
  assert.ok(Number.isSafeInteger(promptTimeoutMs) && promptTimeoutMs > 0 && promptTimeoutMs <= 2147483647, 'promptTimeoutMs must be a positive safe timer integer no greater than 2147483647');
  const prompt = frozenPrompt(input.gate, input.selection);
  assert.match(input.rootRef ?? '', /^skill:\/\/[^/?#]+\/(?:SKILL|ROUTER)\.md$/);
  assert.equal(input.rootRef.endsWith('/ROUTER.md'), input.gate === 'A', 'Gate A selects a Router; Gate B selects a Skill');
  assert.match(input.database ?? '', /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  assert.ok(Boolean(input.viewId) !== Boolean(input.profileId), 'Select exactly one existing root-only View or Profile');
  if (input.viewId) assert.match(input.viewId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  if (input.profileId) assert.match(input.profileId, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
  const sourceMode = input.sourceMode ?? 'sdk';
  assert.ok(['sdk', 'command'].includes(sourceMode), 'sourceMode must be sdk or command');
  assert.ok(!input.profileId || sourceMode === 'command', 'Profile compatibility requires explicit sourceMode command');
  for (const key of ['extension', 'packagePath', 'oraclePath', 'evidenceRoot']) assert.ok(isAbsolute(input[key] ?? ''), key + ' must be absolute');
  assert.ok(Array.isArray(input.cliCommand) && input.cliCommand.length === 2 && input.cliCommand.every(isAbsolute), 'cliCommand must contain absolute Node and installed CLI paths');
  const model = input.model ?? modelSelectors[0];
  assert.ok(modelSelectors.includes(model), 'No third model is authorized');
  const previousFailures = [];
  for (const file of input.previousFailures ?? []) {
    assert.ok(isAbsolute(file));
    const previous = await json(file);
    assert.equal(previous.model, modelSelectors[0]);
    assert.equal(previous.status, 'failed');
    assert.equal(previous.availabilityFailure, true, 'A task/assertion failure does not authorize model fallback');
    previousFailures.push({ selector: previous.model, status: 'failed', evidence: await realpath(file), evidenceSha256: hash(await readFile(file)) });
  }
  let workerAuthorization;
  if (input.workerAuthorization !== undefined) {
    assert.equal(model, modelSelectors[1], 'Explicit worker authorization cannot authorize another model');
    assert.deepEqual(Object.keys(input.workerAuthorization).sort(), ['path', 'sha256']);
    assert.ok(isAbsolute(input.workerAuthorization.path ?? ''), 'Worker authorization path must be absolute');
    const raw = await readFile(input.workerAuthorization.path, 'utf8');
    workerAuthorization = { path: await realpath(input.workerAuthorization.path), sha256: input.workerAuthorization.sha256, raw };
    verifyWorkerAuthorization(workerAuthorization, { gate: input.gate, rootRef: input.rootRef, promptSha256: prompt.sha256 });
  }
  assert.ok(model === modelSelectors[0] || previousFailures.length || workerAuthorization, 'Worker requires a retained actual flash-free availability failure or explicit user authorization');
  const mode = input.mode ?? 'cold';
  assert.ok(['cold', 'warm-new-process', 'matrix'].includes(mode), 'Use cold, warm-new-process, or the fixed matrix (which includes two live continued-session samples)');
  assert.ok(mode === 'warm-new-process' ? isAbsolute(input.reuseReceipt ?? '') : input.reuseReceipt === undefined, 'Only warm-new-process may name a previous complete cache receipt');
  if (input.selectionReceipt !== undefined) assert.ok(isAbsolute(input.selectionReceipt));
  if (input.retainedSourceProofRepo !== undefined) assert.ok(isAbsolute(input.retainedSourceProofRepo));
  return { ...input, sourceMode, model, mode, promptTimeoutMs, previousFailures, ...(workerAuthorization ? { workerAuthorization } : {}), prompt };
}

export const brokerConfiguration = (config, command, cacheDir) => ({ skillRoots: [], extraSkillRoots: [], sources: [{ type: 'notion', id: 'notion', namespace: 'notion', ...(config.sourceMode === 'command' ? { command } : {}), database: config.database, ...(config.viewId ? { default_view_id: config.viewId } : { profile_id: config.profileId }), prefetch: false, cacheDir, requestTimeoutMs: 60000, ...(config.preparation ? { preparation: config.preparation } : {}) }] });
export async function sourceObserver(control, { ledger, responses, outputRoot, cliEntries }) {
  const file = join(control, 'source-observer.mjs');
  const module = pathToFileURL(fileURLToPath(new URL('./notion-skill-graph-model-evidence.mjs', import.meta.url))).href;
  await writeFile(file, "import * as fs from 'node:fs';\nimport { channel } from 'node:diagnostics_channel';\nimport childProcess from 'node:child_process';\nimport { syncBuiltinESMExports } from 'node:module';\nimport { observeGraphSdk, observeGraphChildren } from " + JSON.stringify(module) + ';\n'
    + safeRequestMetrics.toString() + '\nconst paths = ' + JSON.stringify({ ledger, responses, outputRoot }) + ';\n'
    + 'const sdk = observeGraphSdk({channel,fs,paths,safeMetrics:safeRequestMetrics});\n'
    + 'const children = observeGraphChildren({childProcess,syncBuiltinESMExports,fs,ledger:paths.ledger,cliEntries:' + JSON.stringify(cliEntries) + '});\n'
    + "process.once('exit',()=>{sdk.close();children.close();});\n", { mode: 0o600 });
  return file;
}
const sourceEnvironment = root => ({ NTN_SKILLS_CONFIG_HOME: join(root, 'config'), NTN_SKILLS_HOME: join(root, 'state'), NTN_SKILLS_CACHE_HOME: join(root, 'cache'), NTN_SKILLS_DATA_HOME: join(root, 'data') });
function gateEnvironment(cliPaths, brokerConfig, evidence, owned) {
  const env = { ...process.env, ...cliPaths, CONTEXT_BROKER_CONFIG: brokerConfig, CONTEXT_BROKER_HOST: 'pi', CONTEXT_BROKER_LOG_FILE: join(evidence, 'broker-decisions.jsonl'), BROKER_E2E_PROCESS_LEDGER: owned };
  for (const key of ['NODE_OPTIONS', 'CONTEXT_BROKER_ROOTS', 'CONTEXT_BROKER_EXTRA_ROOTS', 'CONTEXT_BROKER_DISCOVERY_CATALOGS', 'CONTEXT_BROKER_EXTRA_DISCOVERY_CATALOGS']) delete env[key];
  return env;
}

export const runFingerprint = (config, doctor, oracleSha256, projectSha256) => hash(JSON.stringify({ version: 3, sourceMode: config.sourceMode ?? 'sdk', harness: doctor.harness.sha256, gate: config.gate, rootRef: config.rootRef, selection: config.selection, database: config.database, viewId: config.viewId, profileId: config.profileId, prompt: config.prompt.sha256, model: config.model, promptTimeoutMs: config.promptTimeoutMs, ...(config.workerAuthorization ? { workerAuthorizationSha256: config.workerAuthorization.sha256 } : {}), cli: doctor.cli.sha256, extension: doctor.extension.sha256, package: doctor.package.sha256, oracleSha256, projectSha256, preparation: config.preparation ?? null }));

export function summarizeSamples(samples) {
  const summary = {};
  for (const mode of ['cold', 'warm-new-process', 'continued-session']) {
    const values = samples.filter(sample => sample.mode === mode);
    const timing = {};
    for (const name of ['pi_startup_ms', 'root_ready_ms', 'required_ready_ms', 'task_final_ms']) {
      const observed = values.map(sample => sample.timings?.[name]).filter(value => typeof value === 'number' && Number.isFinite(value));
      const sorted = [...observed].sort((a, b) => a - b);
      timing[name] = { values: observed, n: observed.length, median_ms: sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2 : null, p95_ms: null, p95_reason: 'The fixed design has at most two samples per mode; no tail percentile is estimated' };
    }
    summary[mode] = { samples: values.length, passed: values.filter(value => value.status === 'passed').length, failed: values.filter(value => value.status === 'failed').length, timing };
  }
  return summary;
}

function observedTimings(sample, observation, responses, sourceLedger, startupMs) {
  const inTurn = observation.filter(event => Date.parse(event.at) >= Date.parse(sample.startedAt) && Date.parse(event.at) <= Date.parse(sample.finishedAt));
  const prepared = graphSourceViews(responses).preparations.filter(item => item.value.status === 'ready' && item.value.purpose === 'use');
  const closes = new Map(sourceLedger.filter(event => ['close', 'sdk-end'].includes(event.phase)).map(event => [event.requestId, event]));
  const ready = prepared.map(item => closes.get(item.requestId)).filter(event => event && Date.parse(event.at) >= Date.parse(sample.startedAt) && Date.parse(event.at) <= Date.parse(sample.finishedAt)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  const preparation = prepared.find(item => item.value.roots?.length)?.value;
  const rootIds = preparation?.roots.map(root => root.id) ?? [];
  const preparedIds = preparation?.nodes.filter(node => node.state === 'prepared').map(node => node.id) ?? [];
  const providers = inTurn.filter(event => event.phase === 'provider-request');
  const carries = (provider, ids) => ids.length > 0 && ids.every(id => provider.contents?.some(file => file.ownerId === id && file.role === 'entrypoint'));
  const rootReady = providers.find(provider => carries(provider, rootIds));
  const requiredReady = providers.find(provider => carries(provider, preparedIds));
  const final = inTurn.filter(event => event.phase === 'assistant-final' && event.success).at(-1);
  const elapsed = value => value ? Math.max(0, Date.parse(value) - Date.parse(sample.startedAt)) : null;
  return { pi_startup_ms: sample.mode === 'continued-session' ? null : startupMs, root_ready_ms: elapsed(rootReady?.at), required_ready_ms: elapsed(requiredReady?.at), task_final_ms: elapsed(final?.at), source_consume_ready_ms: elapsed(ready?.at), readinessEvidence: 'First actual provider boundary containing the verified root or full Required closure; this is an observed upper bound, not an invented earlier per-node event', provider_requests: providers.length };
}

async function createCatalogProvider(control, wirePath) {
  const model = 'graph-selection-catalog/metadata';
  let requests = 0, failure;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw), number = ++requests;
      await log(wirePath, { number, wireBodySha256: hash(raw), wireBodyBytes: Buffer.byteLength(raw), body });
      assert.deepEqual(body.tools.map(tool => tool.function?.name ?? tool.name).sort(), [...GRAPH_GATE_TOOLS].sort());
      assert.ok(number <= 3, 'The metadata probe has exactly one list and one ordinary continuation');
      const tool = number === 1;
      const delta = tool ? { tool_calls: [{ index: 0, id: 'catalog-list', type: 'function', function: { name: 'notion_list', arguments: '{}' } }] } : { content: 'Metadata observation complete.' };
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ id: 'catalog-' + number, object: 'chat.completion.chunk', created: 1, model: 'metadata', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
      response.end(chunk({ role: 'assistant' }) + chunk(delta) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    } catch (error) { failure = error; response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  server.unref();
  const extension = join(control, 'catalog-provider.mjs');
  await writeFile(extension, "export default function(api) { api.registerProvider('graph-selection-catalog', { name:'Metadata-only catalog observation',baseUrl:" + JSON.stringify('http://127.0.0.1:' + server.address().port + '/v1') + ",api:'openai-completions',apiKey:'controlled-no-secret',models:[{id:'metadata',name:'Controlled metadata observer',input:['text'],contextWindow:1000000,maxTokens:256,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}); }\n", { mode: 0o600 });
  return { model, extension, assertComplete() { if (failure) throw failure; assert.equal(requests, 3); },
    async close() { server.closeAllConnections(); await new Promise(accept => server.close(accept)); } };
}

function verifyCatalogProvider(observation, wires, config) {
  const catalog = graphCatalogEvidence(observation, config);
  assert.equal(catalog.status, 'ready', 'A separate ordinary continuation must observe the ready default directory');
  assert.equal(observation.filter(event => event.phase === 'catalog-before-agent-start').length, 2, 'Keep both actual ordinary user turns separately from final provider input');
  const catalogs = observation.filter(event => event.phase === 'catalog');
  const providers = observation.filter(event => event.phase === 'provider-request');
  const transports = observation.filter(event => event.phase === 'provider-transport-start');
  assert.equal(providers.length, 3); assert.equal(transports.length, providers.length); assert.equal(wires.length, providers.length);
  assert.equal(catalog.snapshots, providers.length, 'Observe the actual system catalog at every provider request');
  assert.deepEqual(catalogs.map(snapshot => snapshot.userTurn), [1, 1, 2]);
  const text = value => typeof value === 'string' ? value : (value ?? []).filter(part => part.type === 'text').map(part => String(part.text ?? '')).join('\n');
  for (let index = 0; index < providers.length; index++) {
    assert.equal(providers[index].observedPayloadSha256, transports[index].observedPayloadSha256);
    assert.equal(transports[index].wireBodySha256, wires[index].wireBodySha256, 'The public provider hook must match the actual local HTTP payload');
    assert.equal(providers[index].contents.length, 0, 'Catalog validation cannot load main instructions');
    const snapshot = catalogs[index], payload = wires[index].body;
    const system = [text(payload.system), ...(payload.messages ?? []).filter(message => message.role === 'system').map(message => text(message.content))].filter(Boolean).join('\n\n');
    assert.equal(snapshot.providerPayloadSha256, providers[index].observedPayloadSha256);
    assert.ok(snapshot.sequence < providers[index].sequence);
    assert.equal(snapshot.systemPromptSha256, hash(system), 'Only the final actual HTTP system text proves catalog visibility');
    assert.equal(snapshot.systemPromptBytes, Buffer.byteLength(system));
  }
  const calls = observation.filter(event => event.phase === 'tool-call');
  assert.equal(calls.length, 1); assert.equal(calls[0].tool, 'notion_list'); assert.equal(calls[0].allowed, true);
  assert.ok(observation.some(event => event.phase === 'metadata-result' && event.complete && event.toolCallId === calls[0].toolCallId));
  assert.ok(!observation.some(event => event.phase === 'observer-error'));
  return { status: 'passed', catalog, ordinaryTurns: 2, controlledProviderRequests: providers.length, realModelRequests: 0,
    scope: 'Separate metadata-only installed Pi session: actual notion_list followed by an ordinary continuation whose ready catalog reaches a controlled HTTP provider. It does not warm the task consumer or prove real-model task success.' };
}

export async function graphSelectionPreflight(config) {
  const artifacts = await packageIdentity(config);
  await mkdir(config.evidenceRoot, { recursive: true });
  const evidence = await mkdtemp(join(await realpath(config.evidenceRoot), 'graph-selection-'));
  const scratch = await mkdtemp(join(await systemTempRoot(), 'broker-graph-selection-'));
  const cli = join(scratch, 'cli'), broker = join(scratch, 'broker'), sessions = join(scratch, 'sessions'), control = join(scratch, 'control'), cwd = join(scratch, 'workspace'), responses = join(evidence, 'source-responses');
  await Promise.all([cli, broker, sessions, control, cwd, responses].map(path => mkdir(path)));
  const ledger = join(evidence, 'source-processes.jsonl'), owned = join(evidence, 'owned-processes.jsonl'), provider = join(evidence, 'catalog-provider-http.jsonl'), output = join(evidence, 'catalog-observer.jsonl'), payloads = join(evidence, 'catalog-provider-requests');
  await mkdir(payloads);
  await Promise.all([ledger, owned, provider, output].map(path => writeFile(path, '', { mode: 0o600 })));
  const cliPaths = sourceEnvironment(cli), state = join(control, 'source.json'), brokerConfig = join(control, 'broker.json');
  await save(state, { command: config.cliCommand, cliPaths, ledger, responses, metadataOnly: true });
  await save(brokerConfig, brokerConfiguration(config, [process.execPath, helper, '--source', state], broker));
  await save(join(evidence, 'source-config.json'), await json(brokerConfig));
  const sourceHook = await sourceObserver(control, { ledger, responses, outputRoot: broker, cliEntries: [config.cliCommand[1], join(artifacts.packageRoot, 'dist/ntn-skills.mjs')] });
  const controlled = await createCatalogProvider(control, provider);
  const prompts = ['Inspect the available Notion metadata directory only. Do not load instructions or resources.', 'Continue by reporting the current default directory state only.'];
  const observer = join(control, 'catalog-observer.mjs');
  await writeFile(observer, graphObserverModule({ sourceMode: config.sourceMode ?? 'sdk', rootRef: config.rootRef, model: controlled.model,
    prompt: prompts[0], cache: broker, cwd, responses, output, payloads, piExecutable: (await resolveHost('pi')).identity }, pathToFileURL(join(dirname(artifacts.extension.path), 'native-reference.ts')).href), { mode: 0o600 });
  const result = { version: 1, sourceMode: config.sourceMode ?? 'sdk', status: 'running', kind: 'installed-pi-selection-preflight', evidence, scratch, rootRef: config.rootRef, database: config.database, viewId: config.viewId, profileId: config.profileId, artifacts, cliSha256: hash(await readFile(config.cliCommand[1])), files: ['result.json', 'source-config.json', 'source-processes.jsonl', 'owned-processes.jsonl', 'catalog-provider-http.jsonl', 'catalog-observer.jsonl', 'ownership.json'], scope: 'Actual installed Pi commands, ordinary metadata-only turns and real Notion metadata; controlled local provider only, independent of the private oracle and the later cold consumer' };
  await save(join(scratch, 'ownership.json'), { evidence, purpose: 'native-graph-selection', runId: randomUUID() });
  await save(join(evidence, 'ownership.json'), await json(join(scratch, 'ownership.json')));
  await save(join(evidence, 'result.json'), result);
  console.log(JSON.stringify({ status: 'running', action: 'selection', evidence, scratch }));
  let rpc;
  try {
    rpc = await startRpc({ host: 'pi', cwd, env: { ...gateEnvironment(cliPaths, brokerConfig, evidence, owned), NODE_OPTIONS: '--import=' + sourceHook }, timeoutMs: 90000, args: ['--no-extensions', '--no-skills', '--no-mcp', '--no-context-files', '--no-prompt-templates', '--session-dir', sessions, '--tools', GRAPH_GATE_TOOLS.join(','), '-e', controlled.extension, '-e', artifacts.extension.path, '-e', observer, '--model', controlled.model] });
    const commands = await rpc.command('get_commands'); await save(join(evidence, 'registered-commands.json'), commands); result.files.push('registered-commands.json');
    for (const prompt of prompts) await rpc.prompt(prompt);
    controlled.assertComplete();
    result.defaultDiscovery = verifyCatalogProvider(await rows(output), await rows(provider), config);
    const id = decodeURIComponent(config.rootRef.split('/')[2]);
    let record;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && !record) {
      record = graphSourceViews(await collectResponses(responses)).directories.flatMap(item => item.value.records ?? []).find(item => item.id === id);
      if (!record) await new Promise(accept => setTimeout(accept, 50));
    }
    assert.ok(record, 'The actual public metadata directory did not return the selected root');
    assert.equal(record.ref, config.rootRef); assert.equal(record.enabled, true);
    await rpc.prompt('/context-broker find ' + record.name);
    const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
    const notifications = rpc.frames.filter(frame => frame.type === 'extension_ui_request').flatMap(strings);
    const candidates = [];
    for (const value of notifications.filter(text => text.includes('context-broker find:'))) {
      const lines = value.split('\n');
      for (let index = 0; index < lines.length; index++) if (lines[index].startsWith('$')) {
        const body = []; for (let next = index + 1; next < lines.length && !lines[next].startsWith('$'); next++) body.push(lines[next].trim());
        if (body.includes('page: ' + record.locator.page_id) && body.includes('source: notion') && body.includes('kind: ' + record.kind)) candidates.push(lines[index].trim());
      }
    }
    const selections = [...new Set(candidates)]; assert.equal(selections.length, 1, 'The actual registered directory must yield one selection token for the exact root page');
    await rpc.prompt('/context-broker explain ' + selections[0].slice(1));
    assert.ok(rpc.frames.filter(frame => frame.type === 'extension_ui_request').flatMap(strings).some(text => text.includes('select: ' + selections[0]) && text.includes('kind: ' + record.kind)), 'The actual registered explain command must confirm the selection token');
    result.selection = selections[0]; result.record = record;
    const receipts = await collectResponses(responses);
    assert.ok(receipts.length && receipts.every(item => item.metrics?.complete), 'Retain a complete actual HTTP trace for every preflight command');
    result.httpAttempts = receipts.flatMap(item => item.metrics.trace.filter(event => event.event === 'attempt'));
    assert.ok(result.httpAttempts.every(event => event.request_kind === 'notion_metadata'), 'Selection preflight cannot load body bytes or write remote data');
    assert.ok(receipts.every(item => item.transport === 'sdk' ? item.operation === 'list' : ['list', 'views', 'ctl'].includes(item.command)));
    result.providerRequests = result.defaultDiscovery.controlledProviderRequests; result.realModelRequests = 0; result.bodyRequests = 0; result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.error = { code: error.code ?? 'SELECTION_PREFLIGHT_FAILED', message: error.message }; }
  finally { if (rpc) { await save(join(evidence, 'pi-rpc.json'), rpc.frames); result.files.push('pi-rpc.json'); try { await rpc.stop(); } catch (error) { result.status = 'failed'; result.error ??= { code: 'HOST_CLOSE_FAILED', message: error.message }; } } await controlled.close(); }
  const processes = await rows(owned), sourceProcesses = await rows(ledger);
  try {
    const receipts = await collectResponses(responses);
    result.sourceAccounting = graphSourceAccounting(sourceProcesses, receipts, { sourceMode: config.sourceMode ?? 'sdk' });
    result.httpAttempts = receipts.flatMap(item => item.metrics.trace.filter(event => event.event === 'attempt'));
    assert.ok(result.httpAttempts.every(event => event.request_kind === 'notion_metadata'), 'All setup attempts, including canceled operations, must remain metadata-only');
    assert.ok(receipts.every(item => item.transport === 'sdk' ? item.operation === 'list' : ['list', 'views', 'ctl'].includes(item.command)));
    result.setupCost = { httpAttempts: result.httpAttempts.length,
      responseBytes: result.httpAttempts.reduce((sum, event) => sum + (event.response_bytes ?? 0), 0),
      requestBytes: result.httpAttempts.reduce((sum, event) => sum + (event.request_bytes ?? 0), 0),
      scope: 'Separate selection/setup ledger; never subtracted from or hidden inside the task consumer ledger.' };
    if (result.defaultDiscovery) {
      result.defaultDiscovery.observerSha256 = hash(await readFile(output));
      result.defaultDiscovery.wireSha256 = hash(await readFile(provider));
    }
  }
  catch (error) { result.status = 'failed'; result.error = { code: 'OBSERVATION_INCOMPLETE', message: error.message }; }
  result.processesClosed = processes.filter(event => event.event === 'spawn').every(event => processes.some(end => end.event === 'close' && end.pid === event.pid && end.observedExit)) && sourceProcesses.filter(event => event.phase === 'spawn').every(event => sourceProcesses.some(end => end.phase === 'close' && end.requestId === event.requestId));
  if (!result.processesClosed) { result.status = 'failed'; result.error = { code: 'PROCESS_EVIDENCE', message: 'An owned metadata preflight process has no observed close' }; }
  result.files.push(...(await readdir(responses)).map(name => 'source-responses/' + name));
  result.files.push(...(await readdir(payloads)).map(name => 'catalog-provider-requests/' + name));
  await save(join(evidence, 'result.json'), result); return result;
}

export async function packageIdentity(config) {
  const extension = await entryIdentity(config.extension), pkg = await entryIdentity(config.packagePath);
  assert.ok(extension.path.includes('/node_modules/pi-context-broker/'), 'Consume an actual installed package entry');
  const packageRoot = extension.path.slice(0, extension.path.indexOf('/node_modules/pi-context-broker/') + '/node_modules/pi-context-broker'.length);
  const metadata = await json(join(packageRoot, 'package.json'));
  const declared = metadata.pi?.extensions?.[0];
  assert.ok(declared && await realpath(resolve(packageRoot, declared)) === extension.path, 'The entry must be declared by the installed Pi package');
  const packed = await runCommand('/usr/bin/tar', ['-xOf', pkg.path, 'package/' + declared.replace(/^\.\//, '')], { cwd: packageRoot, env: process.env, timeoutMs: 10000 });
  assert.equal(hash(packed.stdout), extension.sha256, 'Installed extension bytes differ from the frozen package');
  const listing = await runCommand('/usr/bin/tar', ['-tzf', pkg.path], { cwd: packageRoot, env: process.env, timeoutMs: 10000 });
  const archived = listing.stdout.trim().split('\n').filter(file => /^package\/(?:src|dist)\//.test(file) && !file.endsWith('/') || file === 'package/package.json').map(file => file.slice('package/'.length)).sort();
  assert.ok(archived.length > 1 && new Set(archived).size === archived.length);
  assert.ok(archived.every(file => file.split('/').every(part => part && part !== '.' && part !== '..')));
  const installed = ['package.json'];
  const walk = async directory => {
    for (const entry of await readdir(join(packageRoot, directory), { withFileTypes: true })) {
      const file = directory + '/' + entry.name;
      assert.equal(entry.isSymbolicLink(), false, 'Frozen runtime files cannot be replaced with local symlinks');
      if (entry.isDirectory()) await walk(file); else if (entry.isFile()) installed.push(file);
    }
  };
  await Promise.all(['src', 'dist'].map(walk));
  assert.deepEqual(installed.sort(), archived, 'Installed runtime inventory differs from the selected archive');
  const runtimeFiles = [];
  for (let offset = 0; offset < archived.length; offset += 8) runtimeFiles.push(...await Promise.all(archived.slice(offset, offset + 8).map(async file => {
    const [actual, packed] = await Promise.all([readFile(join(packageRoot, file)), runCommand('/usr/bin/tar', ['-xOf', pkg.path, 'package/' + file], { cwd: packageRoot, env: process.env, timeoutMs: 10000 })]);
    assert.equal(hash(packed.stdout), hash(actual), 'Installed runtime file differs from the selected archive: ' + file);
    return { path: file, bytes: actual.length, sha256: hash(actual) };
  })));
  return { extension, package: pkg, packageRoot, bundledSkills: metadata.pi?.skills ?? [], runtimeFiles, runtimeSha256: hash(JSON.stringify(runtimeFiles)) };
}

export async function graphModelDoctor(config) {
  const artifacts = await packageIdentity(config);
  const oracle = await json(config.oraclePath);
  assert.equal(oracle.version, 1);
  assert.equal(oracle.roots?.[config.gate]?.ref, config.rootRef);
  assert.equal(oracle.roots?.[config.gate]?.selection, config.selection);
  assert.ok(Array.isArray(oracle.preparations?.[config.gate]) && oracle.preparations[config.gate].length > 0, 'The independent oracle must include the selected root and exact Required closure');
  for (const node of oracle.preparations[config.gate]) {
    assert.ok(typeof node.logicalId === 'string' && typeof node.ref === 'string' && typeof node.scope === 'string' && typeof node.snapshot === 'string');
    assert.match(node.sha256 ?? '', /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(node.bytes) && node.bytes > 0); assert.ok(['root', 'required'].includes(node.role));
  }
  const probe = await mkdtemp(join(await systemTempRoot(), 'broker-graph-model-doctor-'));
  const pi = await runCommand('pi', ['--version'], { cwd: probe, env: process.env, timeoutMs: 10000 });
  assertSupportedPiVersion(pi.stdout.trim());
  return { status: 'ready', gate: config.gate, model: config.model, promptTimeoutMs: config.promptTimeoutMs, prompt: config.prompt, ...artifacts, harness: await graphHarnessIdentity(), cli: { command: config.cliCommand, sha256: hash(await readFile(config.cliCommand[1])) }, node: process.version, pi: pi.stdout.trim(), authentication: 'existing credentials reused in place; not probed or copied', scratch: probe, proof: 'Doctor inspects artifacts and contract only; no real model or Notion request' };
}

async function collectResponses(directory) {
  return Promise.all((await readdir(directory)).filter(name => name.endsWith('.json')).map(name => json(join(directory, name))));
}

export function graphSourceAttribution({ observation, responses, sourceLedger, ownershipResponses = responses, retainedSourceProofs = [], selected = [], scope, libraryId }) {
  const reads = observation.filter(event => event.phase === 'tool-result').map(event => ({ ...event, sequence: event.callSequence ?? event.sequence }));
  const pageOwners = new Map(), entityOwners = new Map();
  const remember = (index, key, owner) => { const values = index.get(key) ?? new Map(); values.set(owner.scope + '/' + owner.id, owner); index.set(key, values); };
  const ownershipEntries = graphSourceViews(ownershipResponses).entries;
  for (const item of ownershipEntries) {
    const value = item.value;
    if (!value.record?.id || !value.scope) continue;
    const owner = { id: value.record.id, scope: value.scope, snapshot: value.snapshot_id };
    if (value.record.locator?.page_id) remember(pageOwners, value.record.locator.page_id.replaceAll('-', '').toLowerCase(), owner);
    for (const file of value.file_bindings ?? []) {
      remember(pageOwners, file.page_id.replaceAll('-', '').toLowerCase(), owner);
      remember(entityOwners, file.file_id, owner);
    }
    if (value.record.locator?.skill_id) remember(entityOwners, value.record.locator.skill_id, owner);
    remember(entityOwners, value.record.id, owner);
  }
  const retainedRecords = retainedSourceProofs.flatMap(proof => verifyRetainedSourceProof(proof, {
    scope: scope,
    libraryId: libraryId,
    recordsDataSourceId: proof.records_data_source_id,
  }).map(record => ({ record, scope: proof.scope, dataSourceId: proof.records_data_source_id, libraryId: proof.library_id })));
  const closes = new Map(sourceLedger.filter(event => ['close', 'sdk-end'].includes(event.phase)).map(event => [event.requestId, event]));
  const attempts = [];
  let missingMetrics = false, unattributedBeforeSelection = 0, memberBodyReadsBeforeSelection = 0;
  const selectedIds = new Set(selected.map(node => node.id));
  const calls = new Map(observation.filter(event => event.phase === 'tool-call').map(event => [event.toolCallId, event]));
  const authoredCalls = new Map(observation.filter(event => event.phase === 'authored-tool-call').map(event => [event.sequence, event]));
  const selectionTime = (read, owner) => {
    const call = calls.get(read.toolCallId);
    if (!call?.allowed || call.origin !== 'model' || read.callSequence !== call.sequence) return Infinity;
    const admittedAt = Date.parse(call.at), authored = authoredCalls.get(call.authoredSequence);
    // Historical observations retain their original admission time. An earlier
    // time needs a received assistant event, exact original arguments, and the
    // immutable identity later verified by the actual read/prepare result.
    if (!authored || authored.source !== 'assistant-message-end' || authored.discovered !== true
      || authored.toolCallId !== call.toolCallId || authored.tool !== call.tool
      || authored.sequence >= call.sequence || Date.parse(authored.at) > admittedAt
      || hash(JSON.stringify(authored.input)) !== authored.argumentsSha256
      || authored.argumentsSha256 !== call.argumentsSha256
      || (call.tool === 'read' ? Array.isArray(call.input) ? JSON.stringify(authored.input?.paths) !== JSON.stringify(call.input)
        : authored.input?.path !== call.input : JSON.stringify(authored.input) !== JSON.stringify(call.input))
      || owner.snapshot !== undefined && read.snapshot !== owner.snapshot) return admittedAt;
    if (call.tool === 'read') {
      let fileId = read.fileId;
      try { fileId ??= new URL(read.ref).searchParams.get('file_id') ?? undefined; } catch { return admittedAt; }
      const expected = Array.isArray(call.expected) ? call.expected[read.resourceBatchProof?.index] : call.expected, claim = call.claim;
      if (expected ? expected.scope !== read.scope || expected.ownerId !== read.ownerId || expected.path !== read.path
        || expected.snapshot !== read.snapshot || expected.fileId !== fileId || expected.sha256 !== read.sha256 || expected.bytes !== read.bytes
        : !claim || claim.scope !== read.scope || claim.ownerId !== read.ownerId || claim.path !== read.path
          || claim.snapshot !== undefined && claim.snapshot !== read.snapshot || claim.fileId !== undefined && claim.fileId !== fileId) return admittedAt;
    } else if (call.tool === 'notion_use') {
      const proof = read.preparationProof;
      if (!proof?.deliveryVerified || proof.scope !== read.scope || proof.ownerId !== read.ownerId || proof.snapshot !== read.snapshot
        || proof.sha256 !== read.sha256 || proof.bytes !== read.bytes) return admittedAt;
    } else return admittedAt;
    return Date.parse(authored.at);
  };
  const starts = new Map(sourceLedger.filter(event => ['spawn', 'sdk-start'].includes(event.phase)).map(event => [event.requestId, Date.parse(event.at)]));
  for (const receipt of responses) {
    if (!receipt.metrics?.complete) { missingMetrics = true; continue; }
    // A chunk belongs to a source only when this very CLI request observed the
    // immutable bundle ID. A shared prepare batch or a later cache entry is not
    // ownership evidence. Independent metadata proves membership, not a read.
    const observedBundles = new Set(receipt.metrics.trace.filter(event => event.event === 'attempt' && event.request_kind === 'notion_metadata')
      .flatMap(event => (event.target?.entity_ids ?? []).filter(id => /^bundle-[a-f0-9]{64}$/.test(id)).map(id => event.target.data_source_id + '/' + id)));
    const retainedOwners = new Map(), retainedMembership = new Map();
    for (const { record, scope, dataSourceId, libraryId } of retainedRecords) {
      if (!observedBundles.has(dataSourceId + '/' + record.entity_id)) continue;
      const ownerReads = ownershipEntries.filter(item => item.value.scope === scope && item.value.record?.locator?.library_id === libraryId
        && item.value.record.locator.page_id === record.skill_page_id);
      for (const item of ownerReads) for (const chunk of record.payload.archive.chunks) {
        const key = dataSourceId + '/' + chunk.object_id;
        remember(retainedOwners, key, { id: item.value.record.id, scope, snapshot: item.value.snapshot_id });
        retainedMembership.set(key, [...new Set([...(retainedMembership.get(key) ?? []), record.record_id])]);
      }
    }
    for (const event of receipt.metrics.trace.filter(event => event.event === 'attempt')) {
      const target = event.target;
      const page = target?.page_id ?? target?.block_id;
      const identities = page ? [pageOwners.get(page.replaceAll('-', '').toLowerCase())] : target?.entity_ids?.map(id => {
        const values = new Map([...(entityOwners.get(id) ?? []), ...(retainedOwners.get(target.data_source_id + '/' + id) ?? [])]);
        return values.size ? values : undefined;
      }) ?? [];
      const attributed = identities.length > 0 && identities.every(values => values?.size === 1);
      const owners = [...new Map(identities.filter(Boolean).flatMap(values => [...values]).map(([key, owner]) => [key, owner])).values()];
      const selectedBefore = owner => owner.scope === scope && (selectedIds.has(owner.id) || reads.some(read => read.ownerId === owner.id && read.scope === owner.scope && read.complete && selectionTime(read, owner) <= starts.get(receipt.requestId)));
      const beforeSelection = !attributed || owners.some(owner => !selectedBefore(owner));
      if (event.request_kind === 'notion_body') {
        if (!attributed) unattributedBeforeSelection++;
        if (owners.some(owner => !selectedBefore(owner))) memberBodyReadsBeforeSelection++;
      }
      const sourceProofs = [...new Set((target?.entity_ids ?? []).flatMap(id => retainedMembership.get(target.data_source_id + '/' + id) ?? []))];
      attempts.push({ transport: 'direct_http', sourceTransport: receipt.transport ?? 'command', kind: event.request_kind === 'notion_body' ? 'body' : event.request_kind === 'notion_write' ? 'write' : event.request_kind === 'provider' ? 'provider' : 'metadata', status: event.http_status, requestIdAvailable: event.request_id !== null, requestId: event.request_id, ...(event.http_status === null ? { networkError: event.outcome } : {}), target: target ?? null, owners, attributed, beforeSelection, ...(sourceProofs.length ? { retainedSourceProofs: sourceProofs } : {}), requestBytes: event.request_bytes, responseBytes: event.response_bytes, bodyKind: event.body_kind, operation: receipt.operation ?? receipt.command, ...(receipt.command ? { command: receipt.command } : {}), requestReceipt: receipt.requestId });
    }
  }
  return { attempts, missingMetrics, unattributedBeforeSelection, memberBodyReadsBeforeSelection, closes };
}

export function graphTrace({ config, oracle, observation, responses, sourceLedger, hostLedger, isolation, ownershipResponses = responses, retainedSourceProofs = [] }) {
  const providerRequests = observation.filter(event => event.phase === 'provider-request');
  const firstProvider = providerRequests[0];
  const transportAttempts = observation.filter(event => event.phase === 'provider-transport-start').length;
  if (observation.some(event => event.phase === 'observer-error') || !firstProvider && transportAttempts > 0)
    throw Object.assign(new Error('Provider observation is invalid; actual transport attempts: ' + transportAttempts + '. Missing verified payload evidence cannot be reconstructed from context or response events.'), { code: 'GRAPH_OBSERVER_INVALID' });
  assert.ok(firstProvider, 'No verified provider payload or actual provider transport was observed');
  const directorySequence = firstProvider.sequence;
  const reads = observation.filter(event => event.phase === 'tool-result').map(event => ({ ...event, sequence: event.callSequence ?? event.sequence }));
  for (const delivery of observation.filter(event => ['metadata-result', 'preparation-result'].includes(event.phase) && event.complete)) {
    const observed = providerRequests.some(request => request.sequence > delivery.sequence && request.toolResults?.some(result => result.toolCallId === delivery.toolCallId
      && result.sha256 === delivery.sha256 && result.bytes === delivery.bytes
      && (delivery.phase === 'metadata-result' ? result.exactToolOutputCopies >= 1 : result.exactToolOutputCopies >= 1 || result.records?.length > 0 && result.records.every(record => record.providerCopies === 1))));
    assert.ok(observed, 'A successful discovery/preparation tool output must reach an actual provider with matching output or verified body hashes');
  }
  if (config.gate === 'A' && oracle.roots?.B?.ref) assert.ok(!reads.some(read => read.ownerId === decodeURIComponent(oracle.roots.B.ref.split('/')[2])), 'Gate A cannot read the ordinary root as a bridge, including a pinned ref');
  const actualPrepare = graphSourceViews(responses).preparations.filter(item => item.value.status === 'ready').map(item => item.value);
  const rootPreparation = actualPrepare.find(value => value.purpose === 'use' && value.roots?.some(root => root.id === decodeURIComponent(config.rootRef.split('/')[2])));
  assert.ok(rootPreparation, 'The selected root must use the actual SDK consume or explicit command preparation');
  const selected = rootPreparation.nodes.filter(node => node.state === 'prepared');
  assert.ok(!selected.some(node => node.id === oracle.target.logicalId), 'The optional target cannot be silently promoted into the required closure');
  const expectedPreparation = oracle.preparations?.[config.gate];
  assert.ok(Array.isArray(expectedPreparation) && expectedPreparation.length > 0, 'Independent root/Required observations are required');
  assert.deepEqual(selected.map(node => node.id).sort(), expectedPreparation.map(node => node.logicalId).sort(), 'Observed ready nodes must exactly match the independent root/Required closure');
  for (const node of selected) {
    const expected = expectedPreparation.find(item => item.logicalId === node.id);
    assert.equal(node.body_sha256, expected.sha256); assert.equal(node.bytes, expected.bytes); assert.equal(node.binding.snapshot_id, expected.snapshot); assert.equal(node.binding.ref, expected.ref); assert.equal(rootPreparation.scope, expected.scope);
    assert.equal(rootPreparation.roots.some(root => root.id === node.id) ? 'root' : 'required', expected.role);
    const copies = firstProvider.contents.filter(file => file.ownerId === node.id && file.role === 'entrypoint');
    assert.equal(copies.length, 1, 'Every root/Required body must occur once in the first real provider request');
    assert.equal(copies[0].sha256, node.body_sha256);
    assert.equal(copies[0].bytes, node.bytes);
    assert.equal(copies[0].snapshot, node.binding.snapshot_id);
    assert.equal(copies[0].scope, rootPreparation.scope);
    for (const request of providerRequests) {
      const retained = request.contents.filter(file => file.ownerId === node.id && file.role === 'entrypoint');
      assert.ok(retained.length <= 1 && retained.every(file => file.sha256 === node.body_sha256 && file.bytes === node.bytes
        && file.snapshot === node.binding.snapshot_id && file.scope === rootPreparation.scope), 'Root/Required bodies must remain unique and on the selected version in every provider request');
    }
  }
  const rootNode = selected.find(node => node.record.ref === config.rootRef);
  assert.ok(rootNode);
  const candidates = (rootNode.candidates ?? []).map(candidate => {
    const read = reads.find(read => read.logicalId === candidate.id && read.scope === rootPreparation.scope && read.complete);
    return { ref: read?.ref ?? candidate.ref, observedRef: candidate.ref, logicalId: candidate.id, scope: rootPreparation.scope, available: candidate.availability === 'available', sequence: directorySequence };
  });
  const { attempts, missingMetrics, unattributedBeforeSelection, memberBodyReadsBeforeSelection, closes } = graphSourceAttribution({
    observation, responses, sourceLedger, ownershipResponses, retainedSourceProofs, selected, scope: rootPreparation.scope, libraryId: rootNode.record.locator?.library_id });
  const processes = hostLedger.filter(event => event.event === 'spawn').map(event => ({ owned: true, pid: event.pid, spawnObserved: true, closeObserved: hostLedger.some(end => end.event === 'close' && end.pid === event.pid && end.observedExit), closed: hostLedger.some(end => end.event === 'close' && end.pid === event.pid && end.observedExit) }));
  for (const event of sourceLedger.filter(event => event.phase === 'spawn')) processes.push({ owned: true, pid: event.childPid, spawnObserved: true, closeObserved: closes.has(event.requestId), closed: closes.has(event.requestId) });
  const final = observation.filter(event => event.phase === 'assistant-final').at(-1);
  const statuses = observation.filter(event => ['provider-response', 'provider-transport-response'].includes(event.phase)).map(event => event.status).filter(status => typeof status === 'number');
  const trace = { version: 1, toolContract: 'agent-cli-ref-20261105', sourceMode: config.sourceMode ?? 'sdk', evidenceKind: 'real_model', host: 'pi', nativeEntry: true, gate: config.gate, prompt: config.prompt, selectedRoots: [config.rootRef], requiredRefs: rootPreparation.required.map(edge => edge.ref), toolChoice: 'auto', forcedToolArguments: false, cacheMode: config.mode === 'cold' || !config.mode ? 'cold' : 'warm', isolation, candidates, memberBodyReadsBeforeSelection: unattributedBeforeSelection || missingMetrics ? null : memberBodyReadsBeforeSelection, directorySequence, reads, providerRequests, httpLedgerObserved: !missingMetrics, httpAttempts: attempts, model: { selector: config.model, previousFailures: config.previousFailures, ...(config.workerAuthorization ? { workerAuthorization: config.workerAuthorization } : {}), responseStatus: statuses.find(status => status >= 200 && status < 300) ?? statuses.at(-1) ?? null, final }, processes, unknownWrites: [], replayedUnknownWrites: false, preparation: { roots: rootPreparation.roots, required: rootPreparation.required, graph_lock: rootPreparation.graph_lock, usage: rootPreparation.usage }, attribution: { unattributedBeforeSelection, missingMetrics, rule: 'Every actual body target must map without ambiguity to a prepared root/Required or an earlier model-selected owner; missing targets never imply zero' } };
  const targetRead = reads.find(read => read.logicalId === oracle.target.logicalId && read.scope === oracle.target.scope);
  if (targetRead) assert.equal(targetRead.ref, oracle.target.ref, 'The oracle must use the observed canonical snapshot/file_id ref');
  return trace;
}

export function retainedSourceProofInput({ gate, evidence, trace, responses, ownershipResponses = responses }) {
  const attempts = trace.httpAttempts.filter(attempt => attempt.kind === 'body' && attempt.bodyKind === 'retained_body'
    && !attempt.attributed && attempt.status === 200 && attempt.target?.entity_ids?.length
    && attempt.target.entity_ids.every(id => /^chunk-[a-f0-9]{64}$/.test(id)));
  if (!attempts.length) return undefined;
  const requests = new Set(attempts.map(attempt => attempt.requestReceipt));
  const sources = [...new Set(attempts.map(attempt => attempt.target.data_source_id))];
  if (sources.length !== 1) return undefined;
  const bundles = [...new Set(responses.filter(receipt => requests.has(receipt.requestId)).flatMap(receipt => receipt.metrics?.trace ?? [])
    .filter(event => event.event === 'attempt' && event.request_kind === 'notion_metadata' && event.target?.data_source_id === sources[0])
    .flatMap(event => (event.target.entity_ids ?? []).filter(id => /^bundle-[a-f0-9]{64}$/.test(id))))].sort();
  if (!bundles.length) return undefined;
  const owners = [...new Map(graphSourceViews(ownershipResponses).entries.filter(receipt => receipt.value.record?.locator?.type === 'shared_skill').map(receipt => {
      const { record, scope, snapshot_id } = receipt.value, locator = record.locator;
      return [scope + '/' + record.id, { id: record.id, name: record.name, page_id: locator.page_id, database_id: locator.database_id,
        library_id: locator.library_id, scope, snapshot_id }];
    })).values()];
  if (!owners.length) return undefined;
  return { version: 1, runs: [{ gate, directory: evidence, records_data_source_ids: sources, bundle_ids: bundles,
    owners, unattributed_retained_attempts: attempts }] };
}

export async function collectSupplementaryRetainedProof({ config, evidence, trace, responses, ownershipResponses }) {
  const input = retainedSourceProofInput({ gate: config.gate, evidence, trace, responses, ownershipResponses });
  if (!input) return { receipt: { status: 'not-needed-or-unresolved', accounting: 'No additional HTTP; unknown ownership remains unknown' } };
  if (!config.retainedSourceProofRepo) return { receipt: { status: 'not-configured', accounting: 'No additional HTTP; retained chunk ownership remains unknown' } };
  const inputPath = join(evidence, 'retained-source-input.json'), output = join(evidence, 'retained-source-oracle');
  const proofPath = join(output, 'proof.json'), collector = fileURLToPath(new URL('./notion-skill-source-proof.ts', import.meta.url));
  await save(inputPath, input);
  const receipt = { version: 1, status: 'running', phase: 'after-consumer-closed', input: { path: inputPath, sha256: hash(await readFile(inputPath)) },
    collector: { path: collector, sha256: hash(await readFile(collector)) }, cliSource: config.retainedSourceProofRepo,
    command: [process.execPath, collector, 'collect', '--input', inputPath, '--output', output, '--cli-repo', config.retainedSourceProofRepo],
    accounting: 'Supplementary exact immutable source metadata only. Its HTTP/process costs are separate from consumer metrics; bundle membership does not establish native read, provider delivery, or loaded state.', startedAt: new Date().toISOString() };
  let proof;
  try {
    const execution = await runCommand(receipt.command[0], receipt.command.slice(1), { cwd: dirname(helper),
      env: { ...process.env, BROKER_E2E_PROCESS_LEDGER: join(evidence, 'retained-source-processes.jsonl') }, timeoutMs: 120000 });
    await writeFile(join(evidence, 'retained-source-collector.stdout'), execution.stdout, { mode: 0o600 });
    await writeFile(join(evidence, 'retained-source-collector.stderr'), execution.stderr, { mode: 0o600 });
    const bytes = await readFile(proofPath); proof = JSON.parse(bytes.toString('utf8'));
    verifyRetainedSourceProof(proof, { scope: input.runs[0].owners[0].scope, libraryId: input.runs[0].owners[0].library_id, recordsDataSourceId: input.runs[0].records_data_source_ids[0] });
    receipt.status = 'verified'; receipt.exit_code = 0; receipt.proof = { path: proofPath, bytes: bytes.length, sha256: hash(bytes) };
    receipt.request_metrics = proof.request_metrics;
  } catch (error) {
    proof = undefined; receipt.status = 'unknown'; receipt.error = { code: error.code ?? 'RETAINED_SOURCE_PROOF_UNRESOLVED', message: error.message };
    try { const bytes = await readFile(proofPath); receipt.proof = { path: proofPath, bytes: bytes.length, sha256: hash(bytes) }; receipt.request_metrics = JSON.parse(bytes.toString('utf8')).request_metrics; } catch { /* The missing proof remains explicit. */ }
  }
  receipt.finishedAt = new Date().toISOString();
  await save(join(evidence, 'retained-source-observation.json'), receipt);
  return { proof, receipt };
}

async function runGate(config) {
  const doctor = await graphModelDoctor(config);
  assert.ok(config.selectionReceipt, 'Run the public metadata-only selection preflight first');
  const selection = await json(config.selectionReceipt);
  assert.equal(selection.status, 'passed'); assert.equal(selection.kind, 'installed-pi-selection-preflight');
  assert.equal(selection.selection, config.selection); assert.equal(selection.rootRef, config.rootRef); assert.equal(selection.database, config.database); assert.equal(selection.viewId, config.viewId); assert.equal(selection.profileId, config.profileId);
  assert.equal(selection.artifacts.extension.sha256, doctor.extension.sha256); assert.equal(selection.cliSha256, doctor.cli.sha256, 'Selection preflight must use the same installed artifacts');
  assert.equal(selection.artifacts.package.sha256, doctor.package.sha256, 'Selection preflight must use the selected package archive');
  assert.equal(selection.artifacts.runtimeSha256, doctor.runtimeSha256, 'Selection preflight must use the same complete installed runtime');
  assert.equal(selection.sourceMode, config.sourceMode ?? 'sdk', 'Selection preflight must use the same explicit source transport');
  assert.equal(selection.defaultDiscovery?.status, 'passed', 'Selection must independently verify default discovery on an ordinary continuation');
  const selectionObserver = join(selection.evidence, 'catalog-observer.jsonl'), selectionWires = join(selection.evidence, 'catalog-provider-http.jsonl');
  assert.equal(hash(await readFile(selectionObserver)), selection.defaultDiscovery.observerSha256);
  assert.equal(hash(await readFile(selectionWires)), selection.defaultDiscovery.wireSha256);
  verifyCatalogProvider(await rows(selectionObserver), await rows(selectionWires), config);
  const oraclePath = await realpath(config.oraclePath), oracle = await json(oraclePath);
  await mkdir(config.evidenceRoot, { recursive: true });
  const evidence = await mkdtemp(join(await realpath(config.evidenceRoot), `graph-model-${config.gate}-`));
  const scratch = await mkdtemp(join(await systemTempRoot(), 'broker-graph-model-'));
  const control = join(scratch, 'control'), cwd = join(scratch, 'workspace');
  const project = await createOwnedGraphProject(cwd);
  const fingerprint = runFingerprint(config, doctor, hash(await readFile(oraclePath)), project.sha256);
  let reuse;
  let priorResponseFiles = [], priorResponses = [];
  if (config.mode === 'warm-new-process') {
    reuse = await json(config.reuseReceipt);
    assert.equal(reuse.version, 1); assert.equal(reuse.status, 'complete'); assert.equal(reuse.fingerprint, fingerprint, 'A warm cache receipt must bind the same frozen task, oracle, project, installed artifacts and scope configuration');
    const prior = await json(join(reuse.evidence, 'result.json'));
    assert.equal(prior.status, 'passed'); assert.equal(prior.cacheReceipt?.sha256, hash(await readFile(config.reuseReceipt)), 'Cache reuse must match its originating successful result');
    assert.ok(Array.isArray(reuse.responseFiles) && reuse.responseFiles.length > 0);
    priorResponseFiles = reuse.responseFiles;
    priorResponses = await Promise.all(priorResponseFiles.map(async file => {
      assert.ok(isAbsolute(file.path) && /\/source-responses\/[a-f0-9-]+\.json$/.test(file.path));
      const bytes = await readFile(file.path); assert.equal(hash(bytes), file.sha256, 'Prior owned consumer evidence must be unchanged');
      return JSON.parse(bytes.toString('utf8'));
    }));
  }
  const consumerRoots = [reuse?.cliRoot ?? join(scratch, 'cli'), reuse?.brokerRoot ?? join(scratch, 'broker'), join(scratch, 'sessions')];
  await Promise.all([control, ...consumerRoots].map(path => mkdir(path, { recursive: true })));
  const resolved = await Promise.all(consumerRoots.map(path => realpath(path)));
  const oracleRoots = [await realpath(dirname(oraclePath))];
  assert.ok(disjoint(await realpath(selection.scratch), scratch), 'Selection preflight cannot warm a consumer cache');
  for (const [index, root] of [...resolved, ...oracleRoots].entries()) for (const other of [...resolved, ...oracleRoots].slice(index + 1)) assert.ok(disjoint(root, other), 'Oracle and three consumer layers must be disjoint');
  const prelaunch = await Promise.all(resolved.map(async root => ({ root, entries: (await readdir(root)).length })));
  if (!reuse) assert.ok(prelaunch.every(item => item.entries === 0));
  else assert.ok(prelaunch[0].entries > 0 && prelaunch[1].entries > 0 && prelaunch[2].entries === 0, 'A new warm process reuses complete CLI/Broker caches and starts a fresh session root');
  const responses = join(evidence, 'source-responses');
  const payloads = join(evidence, 'provider-requests');
  await Promise.all([responses, payloads].map(directory => mkdir(directory)));
  const ledger = join(evidence, 'source-processes.jsonl'), owned = join(evidence, 'owned-processes.jsonl'), output = join(evidence, 'observer.jsonl');
  await Promise.all([ledger, owned, output].map(path => writeFile(path, '', { mode: 0o600 })));
  const cliPaths = sourceEnvironment(resolved[0]);
  const statePath = join(control, 'source.json');
  await save(statePath, { command: config.cliCommand, cliPaths, ledger, responses });
  const brokerConfig = join(control, 'broker.json');
  await save(brokerConfig, brokerConfiguration(config, [process.execPath, helper, '--source', statePath], resolved[1]));
  await save(join(evidence, 'source-config.json'), await json(brokerConfig));
  const sourceHook = await sourceObserver(control, { ledger, responses, outputRoot: resolved[1], cliEntries: [config.cliCommand[1], join(doctor.packageRoot, 'dist/ntn-skills.mjs')] });
  const observer = join(control, 'observer.mjs');
  const settings = { sourceMode: config.sourceMode ?? 'sdk', rootRef: config.rootRef, model: config.model, prompt: config.prompt.text, cache: resolved[1], cwd, responses, payloads, output, project, priorResponseFiles, piExecutable: (await resolveHost('pi')).identity };
  const referenceParser = pathToFileURL(join(dirname(config.extension), 'native-reference.ts')).href;
  await writeFile(observer, graphObserverModule(settings, referenceParser), { mode: 0o600 });
  const inputObserver = join(control, 'input-observer.mjs');
  await writeFile(inputObserver, "import { appendFileSync } from 'node:fs'; import { createHash } from 'node:crypto';\nexport default function(api) { api.on('input', event => { const text = event.text ?? ''; appendFileSync(" + JSON.stringify(output) + ", JSON.stringify({ phase: 'native-input', at: new Date().toISOString(), source: event.source, textSha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text), frozenPromptMatched: text === " + JSON.stringify(config.prompt.text) + " }) + '\\n', { mode: 0o600 }); }); }\n", { mode: 0o600 });
  const traps = await createGraphFallbackTraps(control, evidence);
  const isolation = { oracleRoots, consumerRoots: resolved, resolved: true, oracleObserverOnly: true, inventoryComplete: false, localSkillInventory: [], shellEnabled: false, contextFiles: false, promptTemplates: false, autoExtensions: false, tools: GRAPH_GATE_TOOLS, prelaunch, discoveryPolicy: 'Pi --no-skills plus explicit installed Broker/observer only; read, notion_list and notion_use are advertised. notion_ctl stays deferred. Undiscovered reads, shell and outside project files are blocked.', credentialPolicy: 'Inherited host authentication read in place; no credential file is read or copied by the driver', legacyFallback: { directory: traps.directory, ledger: traps.ledger, checks: traps.checks } };
  const result = { version: 1, sourceMode: config.sourceMode ?? 'sdk', harness: doctor.harness, gate: config.gate, mode: config.mode, model: config.model, promptTimeoutMs: config.promptTimeoutMs, status: 'running', evidence, scratch, doctor, isolation, project, prompt: config.prompt, availabilityFailure: false, samples: [], files: ['doctor.json', 'isolation.json', 'project.json', 'ownership.json', 'source-config.json', 'observer.jsonl', 'source-processes.jsonl', 'owned-processes.jsonl', 'legacy-fallback-calls.jsonl', 'result.json'], notRun: ['Native composer Stop/TUI', 'Generated procedure execution until the explicit exercise action'] };
  await save(join(scratch, 'ownership.json'), { evidence, purpose: 'native-graph-model', runId: randomUUID() });
  await save(join(evidence, 'ownership.json'), await json(join(scratch, 'ownership.json')));
  await save(join(evidence, 'doctor.json'), doctor);
  await save(join(evidence, 'isolation.json'), isolation);
  await save(join(evidence, 'project.json'), project);
  await save(join(evidence, 'result.json'), result);
  console.log(JSON.stringify({ status: 'running', gate: config.gate, evidence, scratch }));
  const env = { ...gateEnvironment(cliPaths, brokerConfig, evidence, owned), ...traps.environment, NODE_OPTIONS: '--import=' + sourceHook };
  const args = ['--no-extensions', '--no-skills', '--no-mcp', '--no-context-files', '--no-prompt-templates', '--session-dir', resolved[2], '--tools', GRAPH_GATE_TOOLS.join(','), '-e', inputObserver, '-e', doctor.extension.path, '-e', observer, '--model', config.model];
  let rpc, launchError;
  let startupMs = null;
  try {
    const start = performance.now(); rpc = await startRpc({ host: 'pi', cwd, env, args, timeoutMs: config.promptTimeoutMs }); startupMs = performance.now() - start;
    for (let index = 0; index <= (config.continuedSamples ?? 0); index++) {
      const sample = { index, mode: index === 0 ? config.mode : 'continued-session', startedAt: new Date().toISOString(), promptSha256: config.prompt.sha256, status: 'running' };
      result.samples.push(sample);
      await log(output, { phase: 'submission-start', sample: index, mode: sample.mode, promptSha256: config.prompt.sha256 });
      try { await rpc.prompt(config.prompt.text); } catch (error) { sample.error = { code: error.code ?? 'NATIVE_SUBMISSION_FAILED', message: error.message }; launchError = error; }
      sample.finishedAt = new Date().toISOString();
      await log(output, { phase: 'submission-end', sample: index, mode: sample.mode });
      if (launchError) break;
    }
  }
  catch (error) { launchError = error; }
  finally {
    if (rpc) {
      try { await save(join(evidence, 'session-messages.json'), (await rpc.command('get_messages')).messages); result.files.push('session-messages.json'); } catch { /* Retain RPC frames even after a failed host. */ }
      await save(join(evidence, 'pi-rpc.json'), rpc.frames); result.files.push('pi-rpc.json');
      try { await rpc.stop(); } catch (error) { launchError ??= error; }
    }
  }
  const observation = await rows(output);
  const responsesObserved = await collectResponses(responses), sourceLedger = await rows(ledger), hostLedger = await rows(owned);
  const final = observation.filter(event => event.phase === 'assistant-final').at(-1);
  const responseStatuses = observation.filter(event => ['provider-response', 'provider-transport-response'].includes(event.phase)).map(event => event.status);
  const observerErrors = observation.filter(event => event.phase === 'observer-error');
  result.taskEvidence = graphTaskEvidence(observation);
  await save(join(evidence, 'task-evidence.json'), result.taskEvidence); result.files.push('task-evidence.json');
  result.providerObservation = { verifiedPayloads: observation.filter(event => event.phase === 'provider-request').length, transportAttempts: observation.filter(event => event.phase === 'provider-transport-start').length, transportResponses: observation.filter(event => event.phase === 'provider-transport-response').length, blockedUnverifiedPayloads: observation.filter(event => event.phase === 'provider-transport-blocked').length, observerErrors: observerErrors.length };
  result.legacyFallback = { checks: traps.checks, calls: (await rows(traps.ledger)).length };
  result.availabilityFailure = observerErrors.length === 0 && ((!final?.success && (observation.some(event => event.phase === 'provider-transport-error') || responseStatuses.some(status => [401, 403, 404, 408, 429].includes(status) || status >= 500))) || Boolean(final && permissionFailure(final.text)));
  let retainedSourceProofs = [];
  try {
    const catalog = observation.find(event => event.phase === 'catalog');
    assert.ok(observation.some(event => event.phase === 'native-input' && event.frozenPromptMatched && event.textSha256 === config.prompt.sha256), 'The actual native input did not contain the frozen root-only task');
    result.defaultDiscovery = { consumer: graphCatalogEvidence(observation, config),
      independentMetadataSelection: { receipt: config.selectionReceipt, sha256: hash(await readFile(config.selectionReceipt)), ...selection.defaultDiscovery },
      setupCost: selection.setupCost };
    isolation.inventoryComplete = true;
    isolation.localSkillInventory = observation.filter(event => event.phase === 'catalog').flatMap(event => event.skills).filter(item => !['verified-notion-metadata', 'verified-notion-host-snapshot', 'verified-notion-host-index'].includes(item.provenance?.source));
    isolation.nativeCatalog = catalog;
    result.sourceAccounting = graphSourceAccounting(sourceLedger, responsesObserved, { sourceMode: config.sourceMode ?? 'sdk', requireConsumption: true });
    const traceInput = { config, oracle, observation, responses: responsesObserved, sourceLedger, hostLedger, isolation, ownershipResponses: [...responsesObserved, ...priorResponses] };
    let trace = graphTrace(traceInput);
    const supplementary = await collectSupplementaryRetainedProof({ config, evidence, trace, responses: responsesObserved, ownershipResponses: traceInput.ownershipResponses });
    result.retainedSourceObservation = supplementary.receipt;
    if (supplementary.proof) {
      await save(join(evidence, 'trace-before-retained-proof.json'), trace); result.files.push('trace-before-retained-proof.json');
      retainedSourceProofs = [supplementary.proof]; trace = graphTrace({ ...traceInput, retainedSourceProofs });
    }
    if (supplementary.receipt.input) result.files.push('retained-source-input.json', 'retained-source-observation.json');
    await save(join(evidence, 'trace.json'), trace); result.files.push('trace.json');
    result.contract = evaluateGraphTrace(trace, oracle);
    result.preparation = trace.preparation;
    assert.ok(observation.some(event => event.phase === 'project-read-result' && event.complete && event.path.startsWith('src/')), 'The generated workflow must be grounded in an actual owned project source read');
    assert.ok(!observation.some(event => event.phase === 'tool-call' && !event.allowed), 'An unobserved local or shell fallback was attempted');
    assert.ok(!observation.some(event => event.phase === 'metadata-result' && !event.complete), 'Metadata discovery failure cannot disappear from the trace');
    assert.equal(result.legacyFallback.calls, 0, 'An old ntn/login fallback was invoked');
    await inspectOwnedGraphProject(cwd);
    if (launchError) throw launchError;
    assert.equal(result.availabilityFailure, false, 'HTTP success with a permission/quota answer is unavailable');
    await verifyEntryIdentity(doctor.extension.path, doctor.extension);
    result.status = 'passed';
    result.proof = 'Actual native Pi/provider/source artifacts checked against the independent oracle; contract alone is not counted as product proof';
  } catch (error) {
    result.status = 'failed'; result.error = { code: error.code ?? 'GRAPH_GATE_FAILED', message: error.code === 'ERR_ASSERTION' || error.code ? error.message : 'Native graph gate did not complete; retained observer and source artifacts identify the boundary' };
    if (error.code === 'GRAPH_OBSERVER_INVALID' || observerErrors.length) { result.failureClass = 'harness-invalid'; result.availabilityFailure = false; }
    else if (error.code === 'OBSERVATION_INCOMPLETE') { result.failureClass = 'observation-incomplete'; result.availabilityFailure = false; }
  }
  for (const sample of result.samples) {
    sample.timings = observedTimings(sample, observation, responsesObserved, sourceLedger, startupMs);
    try {
      if (sample.error) throw Object.assign(new Error(sample.error.message), { code: sample.error.code });
      const through = observation.filter(event => Date.parse(event.at) <= Date.parse(sample.finishedAt));
      assert.ok(through.some(event => event.phase === 'native-input' && event.frozenPromptMatched && Date.parse(event.at) >= Date.parse(sample.startedAt)), 'This sample lacks its own native frozen input');
      assert.ok(through.some(event => event.phase === 'assistant-final' && event.success && Date.parse(event.at) >= Date.parse(sample.startedAt)), 'This sample lacks its own successful final');
      const available = responsesObserved.filter(receipt => sourceLedger.some(event => ['close', 'sdk-end'].includes(event.phase) && event.requestId === receipt.requestId && Date.parse(event.at) <= Date.parse(sample.finishedAt)));
      const trace = graphTrace({ config, oracle, observation: through, responses: available, sourceLedger, hostLedger, isolation, ownershipResponses: [...available, ...priorResponses], retainedSourceProofs });
      sample.contract = evaluateGraphTrace(trace, oracle);
      sample.status = 'passed';
    } catch (error) { sample.status = 'failed'; sample.error = { code: error.code ?? 'SAMPLE_FAILED', message: error.message }; }
  }
  result.summary = summarizeSamples(result.samples);
  const afterHarness = await graphHarnessIdentity();
  result.harnessIntegrity = { unchanged: afterHarness.sha256 === doctor.harness.sha256, beforeSha256: doctor.harness.sha256, afterSha256: afterHarness.sha256,
    changedFiles: afterHarness.files.filter(file => doctor.harness.files.find(before => before.path === file.path)?.sha256 !== file.sha256).map(file => file.path) };
  if (!result.harnessIntegrity.unchanged) { result.status = 'failed'; result.failureClass = 'harness-invalid'; result.availabilityFailure = false;
    result.error ??= { code: 'HARNESS_CHANGED', message: 'The verification harness changed during the run; raw observations remain retained but cannot certify a pass' }; }
  try { result.generatedPlan = await retainGeneratedPlan({ evidence, final, prompt: config.prompt, project }); }
  catch (error) { result.generatedPlan = { status: 'failed', artifactStatus: 'invalid-generated-files', error: { code: error.code ?? 'ARTIFACT_EXTRACTION_FAILED', message: error.message } }; }
  if (result.generatedPlan.status === 'plan-retained') result.files.push('generated-acceptance-plan.md', 'generated-plan.json', ...result.generatedPlan.files.map(file => file.evidencePath));
  result.productAcceptance = { graphStatus: result.status, generatedArtifactStatus: result.generatedPlan.artifactStatus ?? 'missing', generatedProcedureExecuted: false, scope: 'Graph/model evidence and generated-file execution are separate; a graph pass alone is not AH573 product completion' };
  if (result.status === 'passed' && result.samples.every(sample => sample.status === 'passed')) {
    const receiptPath = join(evidence, 'cache-reuse.json');
    const responseFiles = [...new Map([...priorResponseFiles, ...await Promise.all(responsesObserved.map(async receipt => { const path = join(responses, receipt.requestId + '.json'); return { path, sha256: hash(await readFile(path)) }; }))].map(file => [file.path, file])).values()];
    await save(receiptPath, { version: 1, status: 'complete', fingerprint, evidence, cliRoot: resolved[0], brokerRoot: resolved[1], projectSha256: project.sha256, taskSha256: config.prompt.sha256, promptTimeoutMs: config.promptTimeoutMs, responseFiles, graphLockSha256: result.preparation.graph_lock.sha256, prior: config.reuseReceipt ?? null });
    result.cacheReceipt = { path: receiptPath, sha256: hash(await readFile(receiptPath)) }; result.files.push('cache-reuse.json');
  } else if (result.samples.some(sample => sample.status === 'failed')) result.status = 'failed';
  await save(join(evidence, 'isolation.json'), isolation);
  result.files.push(...(await readdir(responses)).map(name => 'source-responses/' + name));
  result.finishedAt = new Date().toISOString();
  result.files.push(...(await readdir(payloads)).map(name => 'provider-requests/' + name));
  await save(join(evidence, 'result.json'), result);
  return result;
}

export function unstartedMatrixSamples(result) {
  return result.notRun.length ? result.notRun : result.design.order.slice(result.samples.length).map(mode => ({ mode, reason: 'The live run ended before this scheduled sample started; observed samples are retained' }));
}

export function matrixStatus(result) {
  return result.runs.length === 3 && result.runs.every(run => run.status === 'passed')
    && result.samples.length === 5 && result.samples.every(sample => sample.status === 'passed') ? 'passed' : 'failed';
}

async function runMatrix(config) {
  await mkdir(config.evidenceRoot, { recursive: true });
  const evidence = await mkdtemp(join(await realpath(config.evidenceRoot), `graph-matrix-${config.gate}-`));
  const result = { version: 1, gate: config.gate, mode: 'matrix', evidence, status: 'running', prompt: config.prompt, promptTimeoutMs: config.promptTimeoutMs, design: { cold: 1, warm_new_process: 2, continued_session: 2, order: ['cold', 'warm-new-process', 'warm-new-process', 'continued-session', 'continued-session'] }, runs: [], samples: [], notRun: [], files: ['result.json'] };
  await save(join(evidence, 'result.json'), result); console.log(JSON.stringify({ status: 'running', action: 'matrix', evidence }));
  for (let index = 0; index < 3; index++) {
    const previous = result.runs.at(-1);
    if (index > 0 && !previous?.cacheReceipt) { result.notRun.push(...result.design.order.slice(result.samples.length).map(mode => ({ mode, reason: 'No complete successful prior consumer cache receipt exists; the failed sample is retained' }))); break; }
    let run;
    try { run = await runGate({ ...config, mode: index === 0 ? 'cold' : 'warm-new-process', ...(index ? { reuseReceipt: previous.cacheReceipt.path } : {}), continuedSamples: index === 2 ? 2 : 0 }); }
    catch (error) { run = { status: 'failed', error: { code: error.code ?? 'RUN_SETUP_FAILED', message: error.message }, samples: [{ mode: index === 0 ? 'cold' : 'warm-new-process', status: 'failed', error: { code: error.code ?? 'RUN_SETUP_FAILED', message: error.message } }] }; }
    result.runs.push({ evidence: run.evidence, status: run.status, cacheReceipt: run.cacheReceipt, generatedArtifactStatus: run.generatedPlan?.artifactStatus ?? 'missing', generatedProcedure: run.generatedProcedure ?? null, availabilityFailure: run.availabilityFailure, error: run.error });
    result.samples.push(...run.samples.map(sample => ({ ...sample, evidence: run.evidence })));
    await save(join(evidence, 'result.json'), result);
  }
  result.notRun = unstartedMatrixSamples(result);
  result.summary = summarizeSamples(result.samples);
  result.status = matrixStatus(result);
  result.proof = 'Fixed five-sample design; graph samples and run-level failures are retained, with raw timings and medians only. Every run and sample must pass. Continued samples retain the live session and cumulative original discovery/read receipts.';
  await save(join(evidence, 'result.json'), result); return result;
}

async function evidenceStatus(directory) {
  assert.ok(isAbsolute(directory));
  const result = await json(join(directory, 'result.json'));
  assert.equal(await realpath(directory), result.evidence);
  for (const file of result.files) assert.ok(!isAbsolute(file) && !file.split('/').includes('..'));
  const present = await Promise.all(result.files.map(file => readFile(join(directory, file))));
  if (result.mode === 'matrix') for (const run of result.runs) if (run.evidence) await evidenceStatus(run.evidence);
  return { status: 'preserved', functionalStatus: result.status, evidence: directory, files: present.length, gate: result.gate, model: result.model, error: result.error };
}

async function main(args) {
  const action = args.shift();
  if (!action || action === '--help' || action === 'help') return {
    usage: ['node scripts/notion-skill-graph-model.mjs doctor|selection --config ABSOLUTE_JSON', 'node scripts/notion-skill-graph-model.mjs run --config ABSOLUTE_JSON', 'node scripts/notion-skill-graph-model.mjs exercise --evidence ABSOLUTE_RUN --command-json \'["npm","test"]\'', 'node scripts/notion-skill-graph-model.mjs evidence|cleanup --evidence ABSOLUTE_RUN'],
    config: { version: 1, gate: 'A or B', selection: 'Use exact token returned by the independent selection preflight', selectionReceipt: 'absolute successful selection result.json; required for run', rootRef: 'exact unpinned shared record.ref', database: 'UUID', viewId: 'existing root-only View UUID', sourceMode: 'sdk (default, source.command absent); command explicitly selects the legacy/custom/profile comparison', profileId: 'legacy compatibility only, requires sourceMode command instead of viewId', extension: 'absolute installed Pi entry', packagePath: 'absolute frozen tgz', cliCommand: ['absolute Node', 'absolute installed ntn-skills entry; identity and explicit command mode only'], oraclePath: 'absolute private oracle JSON, kept outside consumer roots; not opened by selection preflight', evidenceRoot: 'absolute retained directory', model: modelSelectors[0], promptTimeoutMs: 300000, previousFailures: [], mode: 'cold (default), warm-new-process or matrix', reuseReceipt: 'absolute complete cache-reuse.json for warm-new-process only' },
    consumption: 'Pi 1.4 advertises read, notion_list and notion_use. notion_use is model-only; inspection and resources use read. notion_ctl stays deferred and is not activated for the A/B plan task. Actual SDK results and their matching HTTP metrics are observer-only evidence; roots and Requires still require complete source bytes in actual provider requests. The driver does not claim live or independent acceptance merely because its tests pass.',
    discovery: 'selection uses its own cold scratch, real Notion metadata, actual Pi and three controlled local HTTP provider requests: one public notion_list followed by a second ordinary user turn with ready default metadata. No instruction bodies or real model are requested. Setup attempts/bytes remain a separate ledger. The later task can observe first-turn pending; explicit root consumption never substitutes for the independent ready-directory proof.',
    promptTimeout: 'Optional config.promptTimeoutMs freezes the model-run RPC deadline before launch; default 300000 ms, positive safe timer integer up to 2147483647. The value is retained in doctor/run/matrix/cache evidence and the cache fingerprint. It never changes task or graph assertions.',
    workerAuthorization: 'Optional config.workerAuthorization is {path, sha256} for a retained explicit user approval of worker for the exact gate/root/frozen prompt. It remains observer-only evidence; absent authorization preserves the flash-free availability-failure requirement. No receipt can substitute for actual user approval.',
    sampling: 'matrix runs 1 cold process, 2 warm new processes on the same complete CLI/Broker caches, then 2 more frozen submissions in the second warm live session; failures remain samples; raw values and medians, no p95',
    artifacts: 'Retain the actual final verbatim. Extract only complete fenced files with explicit relative filenames; a valid SKILL.md and all local links must be present. Prose alone remains plan-only. exercise accepts an exact test command from a retained generated file and drives the unchanged owned application with PID, exit, stdout and hash evidence. Graph pass alone is not generated-Skill acceptance.',
    retainedSourceProof: 'Optional config.retainedSourceProofRepo names the absolute frozen CLI source tree. After Pi closes, only unresolved retained chunks with actual observed bundle IDs trigger the independent Effect collector. Its immutable metadata proof, process ledger and HTTP costs are retained separately; it cannot add model reads, resources or loaded state. Missing proof remains observation-incomplete.',
    oracleIdentity: 'Target logicalId is the full public record.id (shared_skill:library:skill_id); resource logicalId is its observed stable file_id (fallback owner/path only for historical snapshots without file IDs). All refs are canonical actual read refs including snapshot and available file_id.',
  };
  if (action === '--source') { await sourceCommand(args.shift(), args); return; }
  const options = {};
  while (args.length) { const key = args.shift(); assert.ok(/^--[a-z-]+$/.test(key) && args.length && options[key.slice(2)] === undefined); options[key.slice(2)] = args.shift(); }
  if (['doctor', 'selection', 'run'].includes(action)) { assert.deepEqual(Object.keys(options), ['config']); const config = await readGateConfig(options.config); return action === 'doctor' ? graphModelDoctor(config) : action === 'selection' ? graphSelectionPreflight(config) : config.mode === 'matrix' ? runMatrix(config) : runGate(config); }
  if (action === 'exercise') { assert.deepEqual(Object.keys(options).sort(), ['command-json', 'evidence']); return exerciseGeneratedProcedure(options.evidence, JSON.parse(options['command-json'])); }
  assert.ok(['evidence', 'cleanup'].includes(action));
  assert.deepEqual(Object.keys(options), ['evidence']);
  const retained = await evidenceStatus(options.evidence);
  if (action === 'evidence') return retained;
  const result = await json(join(options.evidence, 'result.json'));
  assert.notEqual(result.mode, 'matrix', 'Review the matrix, then clean its individual run evidence roots after all reuse has ended');
  const owner = await json(join(result.scratch, 'ownership.json'));
  assert.equal(owner.evidence, options.evidence);
  assert.ok(['native-graph-model', 'native-graph-selection'].includes(owner.purpose));
  assert.equal(dirname(await realpath(result.scratch)), await systemTempRoot());
  const processes = await rows(join(options.evidence, 'owned-processes.jsonl'));
  assert.ok(processes.filter(event => event.event === 'spawn').every(event => processes.some(end => end.event === 'close' && end.pid === event.pid && end.observedExit)), 'Do not trash an active owned Pi process');
  const sources = await rows(join(options.evidence, 'source-processes.jsonl'));
  assert.ok(sources.filter(event => event.phase === 'spawn').every(event => sources.some(end => end.phase === 'close' && end.requestId === event.requestId)), 'Do not trash an active owned CLI process');
  graphSourceAccounting(sources, await collectResponses(join(options.evidence, 'source-responses')), { sourceMode: result.sourceMode ?? 'command', requireConsumption: false });
  await runCommand('/usr/bin/trash', [result.scratch], { cwd: dirname(helper), env: process.env, timeoutMs: 10000 });
  await save(join(options.evidence, 'cleanup.json'), { status: 'trashed', scratch: result.scratch, evidencePreserved: true });
  return { ...retained, cleanup: 'trashed' };
}

if (process.argv[1] && resolve(process.argv[1]) === helper) {
  try { const result = await main(process.argv.slice(2)); if (result !== undefined) console.log(JSON.stringify(result, null, 2)); if (result?.status === 'failed') process.exitCode = 1; }
  catch (error) { console.error(JSON.stringify({ status: 'failed', code: error.code ?? 'GRAPH_DRIVER_FAILED', message: error.message })); process.exitCode = 1; }
}
