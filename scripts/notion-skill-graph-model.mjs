#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHost, runCommand } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { safeRequestMetrics } from './notion-default-context.mjs';
import { entryIdentity, verifyEntryIdentity } from './verification-entry.mjs';
import { systemTempRoot } from './verification-paths.mjs';
import { evaluateGraphTrace, frozenPrompt } from './verify-skill-graph-contract.mjs';
import { createOwnedGraphProject, inspectOwnedGraphProject, retainGeneratedPlan, exerciseGeneratedProcedure } from './notion-skill-graph-project.mjs';

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

// Called by the source adapter inside Pi. Only public read-only CLI operations
// and snapshot export are admitted; stdout is forwarded without changing pins.
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
  let sequence = 0;
  const record = value => appendFileSync(settings.output, JSON.stringify({ sequence: ++sequence, at: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 });
  const text = content => typeof content === 'string' ? content : (content ?? []).filter(item => item.type === 'text').map(item => String(item.text ?? '')).join('\n');
  const unescape = value => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  const inside = (parent, child) => { const value = relative(parent, child); return value === '' || (!value.startsWith('../') && value !== '..' && !isAbsolute(value)); };
  const makeRef = (id, path, snapshot, fileId) => `skill://${encodeURIComponent(id)}/${path.split('/').map(encodeURIComponent).join('/')}?snapshot=${snapshot}${fileId ? '&file_id=' + encodeURIComponent(fileId) : ''}`;
  const parseRef = value => {
    if (typeof value !== 'string') return undefined;
    const match = /^skill:\/\/([^/?#]+)\/([^?#]+)(?:\?([^#]*))?$/.exec(value);
    if (!match) return undefined;
    try {
      const query = new URLSearchParams(match[3]);
      if ([...query.keys()].some(key => !['snapshot', 'file_id'].includes(key)) || query.getAll('snapshot').length > 1 || query.getAll('file_id').length > 1) return undefined;
      return { selector: decodeURIComponent(match[1]), path: match[2].split('/').map(decodeURIComponent).join('/'), snapshot: query.get('snapshot') ?? undefined, fileId: query.get('file_id') ?? undefined };
    } catch { return undefined; }
  };
  const root = parseRef(settings.rootRef);
  const discovered = new Map([[settings.rootRef, { sequence: 0, source: 'explicit selected root' }]]);
  const advertisedPaths = new Set();
  const projectFiles = new Map((settings.project?.files ?? []).map(file => [resolve(settings.cwd, file.path), file]));
  const calls = new Map();
  const assistantCalls = new Map();
  const wireAllowed = model => model === settings.model || model === settings.model.slice(settings.model.indexOf('/') + 1);
  const assertModel = ctx => {
    if (ctx.model?.provider + '/' + ctx.model?.id !== settings.model) throw new Error('Graph gate rejected an unauthorized model');
  };
  const sourceStrings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(sourceStrings) : value && typeof value === 'object' ? ['assistant', 'model'].includes(value.role) ? [] : Object.values(value).flatMap(sourceStrings) : [];
  const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const copies = (payload, body) => {
    const encoded = body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const choices = [...new Set([body, encoded, JSON.stringify(body).slice(1, -1)])].sort((a, b) => b.length - a.length).map(escapePattern);
    if (!body || !choices.length) return 0;
    return sourceStrings(payload).reduce((sum, value) => sum + [...value.matchAll(new RegExp(choices.join('|'), 'g'))].length, 0);
  };
  const sourceResponses = () => [...readdirSync(settings.responses).filter(name => name.endsWith('.json')).map(name => ({ path: join(settings.responses, name) })), ...(settings.priorResponseFiles ?? [])].flatMap(file => {
    const bytes = readFileSync(file.path);
    if (file.sha256 !== undefined && digest(bytes) !== file.sha256) throw new Error('A prior owned consumer response differs from its cache reuse receipt');
    try { const item = JSON.parse(bytes.toString('utf8')); return item.code === 0 && item.response?.ok === true ? [item] : []; } catch { return []; }
  });
  const exportedFiles = ({ includePending = false } = {}) => {
    const outputs = sourceResponses();
    const files = [];
    const walk = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && ['.broker-snapshot.json', '.broker-entry.json'].includes(entry.name)) {
          const receipt = JSON.parse(readFileSync(path, 'utf8'));
          const partial = entry.name === '.broker-entry.json';
          const ownerId = partial ? receipt.id : receipt.record?.id, snapshot = partial ? receipt.snapshot_id : receipt.snapshot, mainPath = partial ? receipt.entrypoint : receipt.entry;
          if ((partial ? receipt.version !== 1 || receipt.projection !== 'entry' || receipt.manifest_complete !== true : receipt.version !== 3 || receipt.projection !== 'snapshot') || typeof ownerId !== 'string' || !Array.isArray(receipt.files) || realpathSync(directory) !== directory || !inside(settings.cache, directory)) throw new Error('Unverified Broker materialization receipt in graph observation');
          const publicRead = outputs.find(item => item.command === 'read' && item.response.record?.id === ownerId && item.response.scope === receipt.scope && item.response.snapshot_id === snapshot && item.response.path === mainPath)?.response;
          if (!publicRead) throw new Error('Materialized main has no actual fixed public read receipt');
          const expectedDirectory = join(settings.cache, 'scopes', receipt.scope, 'records', digest(ownerId), partial ? 'entries' : 'snapshots', snapshot);
          if (expectedDirectory !== directory) throw new Error('Snapshot owner differs from its cache directory');
          if (partial) {
            const prepared = outputs.flatMap(item => item.command === 'prepare' && item.response.scope === receipt.scope ? item.response.nodes ?? [] : []).find(node => node.state === 'prepared' && node.id === ownerId && node.binding.snapshot_id === snapshot);
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
            const declared = { ref, logicalId: main ? ownerId : binding?.file_id ?? ownerId + '/' + item.path, ownerId, scope: receipt.scope, snapshot, sha256: hash, bytes: item.bytes, path: item.path, actual, actuals: [actual], fileId: binding?.file_id, role: main ? 'entrypoint' : 'resource', kind: publicRead.record.kind, projection: receipt.projection };
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
    const unique = new Map();
    for (const file of files) {
      const key = JSON.stringify([file.scope, file.ownerId, file.snapshot, file.path]);
      const previous = unique.get(key);
      if (previous && (previous.sha256 !== file.sha256 || previous.bytes !== file.bytes || previous.ref !== file.ref)) throw new Error('One immutable file has conflicting materialization receipts');
      unique.set(key, previous ? { ...(file.materialized ? file : previous), actuals: [...new Set([...previous.actuals, ...file.actuals])] } : file);
    }
    return [...unique.values()];
  };
  const discover = (value, source, file) => {
    for (const match of value.matchAll(/skill:\/\/[^\s)<>"\]]+/g)) {
      const ref = unescape(match[0]);
      if (parseRef(ref) && !discovered.has(ref)) discovered.set(ref, { sequence, source });
    }
    if (file) for (const match of value.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const raw = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/') || raw.includes('#') || raw.includes('?')) continue;
      const parent = file.path.split('/').slice(0, -1);
      const parts = [...parent];
      let escaped = false;
      for (const part of raw.split('/')) { if (part === '..') { if (!parts.length) { escaped = true; break; } parts.pop(); } else if (part !== '.' && part) parts.push(part); }
      if (escaped) continue;
      const targetPath = parts.join('/');
      const target = exportedFiles({ includePending: true }).find(item => item.ownerId === file.ownerId && item.scope === file.scope && item.snapshot === file.snapshot && item.path === targetPath);
      if (target) { discovered.set(target.ref, { sequence, source }); for (const actual of target.actuals) discovered.set(actual, { sequence, source }); }
    }
  };
  const wasDiscovered = input => {
    if (discovered.has(input) || advertisedPaths.has(input)) return true;
    const parsed = parseRef(input);
    return parsed && [...discovered.keys()].some(ref => { const old = parseRef(ref); return old && old.selector === parsed.selector && old.path === parsed.path && old.fileId === parsed.fileId && (!parsed.snapshot || old.snapshot === parsed.snapshot); });
  };
  const targetFor = (input, body) => {
    const parsed = parseRef(input);
    let available = exportedFiles();
    if (parsed) available = available.filter(file => file.ownerId === parsed.selector && (!parsed.snapshot || parsed.snapshot === file.snapshot) && (parsed.fileId ? file.fileId === parsed.fileId : file.path === parsed.path));
    else if (advertisedPaths.has(input)) available = available.filter(file => file.ownerId === root.selector && file.role === 'entrypoint');
    else available = available.filter(file => file.actuals.includes(resolve(settings.cwd, input)));
    if (body !== undefined) available = available.filter(file => file.content === body);
    return available.length === 1 ? available[0] : undefined;
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    let body;
    try { const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined); if (typeof raw === 'string') body = JSON.parse(raw); } catch { /* Non-model authentication transport. */ }
    if (body && typeof body.model === 'string') {
      if (!wireAllowed(body.model)) throw new Error('Graph gate rejected an unauthorized transport model');
      record({ phase: 'provider-transport-start', model: settings.model, wireModel: body.model });
      try { const response = await originalFetch.call(this, input, init); record({ phase: 'provider-transport-response', status: response.status }); return response; }
      catch (error) { record({ phase: 'provider-transport-error', name: error.name, code: typeof error.code === 'string' ? error.code : null }); throw error; }
    }
    return originalFetch.call(this, input, init);
  };
  api.on('session_start', async (_event, ctx) => { assertModel(ctx); await api.setActiveTools(['read']); record({ phase: 'selected', model: settings.model, tools: ['read'], fallbackTools: false }); });
  api.on('before_agent_start', (event, ctx) => {
    assertModel(ctx);
    const prompt = typeof event.systemPrompt === 'string' ? event.systemPrompt : (event.systemPrompt ?? []).join('\n');
    for (const match of prompt.matchAll(/<skill>[\s\S]*?<\/skill>/g)) { const location = /<location>\s*([^<]+)\s*<\/location>/.exec(match[0])?.[1]?.trim(); if (location) advertisedPaths.add(unescape(location)); }
    discover(prompt, 'actual native catalog');
    const skills = [...prompt.matchAll(/<skill>[\s\S]*?<name>\s*([^<]+)\s*<\/name>[\s\S]*?<location>\s*([^<]+)\s*<\/location>[\s\S]*?<\/skill>/g)].map(match => {
      const file = unescape(match[2].trim());
      let provenance = null, sha256 = null;
      try {
        const actual = realpathSync(file), bytes = readFileSync(actual); sha256 = digest(bytes);
        let directory = settings.path.dirname(actual);
        for (let level = 0; level < 6; level++) {
          try {
            const raw = readFileSync(join(directory, '.broker-host-index.json'));
            const receipt = JSON.parse(raw.toString('utf8'));
            const read = sourceResponses().find(item => item.command === 'read' && item.response.record?.id === receipt.id && item.response.scope === receipt.scope && item.response.snapshot_id === receipt.snapshot_id && item.response.path === receipt.entrypoint)?.response;
            const source = exportedFiles().find(item => item.ownerId === receipt.id && item.scope === receipt.scope && item.snapshot === receipt.snapshot_id && item.role === 'entrypoint' && item.projection === 'entry');
            const published = receipt.published?.path;
            const manifest = readFileSync(join(settings.cache, 'scopes', receipt.scope, 'records', digest(receipt.id), 'entries', receipt.snapshot_id, '.broker-entry.json'));
            if (receipt.version === 1 && receipt.projection === 'host_index' && receipt.loaded === false && receipt.id === root.selector && read && source && receipt.ref === read.ref && receipt.version_id === read.version_id && receipt.source?.bytes === source.bytes && receipt.source?.sha256 === source.sha256 && typeof published === 'string' && published && !published.split('/').some(part => !part || part === '.' || part === '..') && actual === join(directory, published) && receipt.published.bytes === bytes.length && receipt.published.sha256 === digest(bytes) && receipt.manifest_id === digest(JSON.stringify(JSON.parse(manifest.toString('utf8')))))
              provenance = { source: 'verified-notion-host-index', ownerId: receipt.id, scope: receipt.scope, snapshot: receipt.snapshot_id, receiptSha256: digest(raw), manifestSha256: receipt.manifest_id, sourceMainSha256: source.sha256, publishedSha256: digest(bytes), loaded: false };
            break;
          } catch (error) { if (error.code !== 'ENOENT') break; }
          try {
            const raw = readFileSync(join(directory, '.broker-snapshot.json'));
            const receipt = JSON.parse(raw.toString('utf8'));
            const read = sourceResponses().find(item => item.command === 'read' && item.response.record?.id === receipt.record?.id && item.response.scope === receipt.scope && item.response.snapshot_id === receipt.snapshot)?.response;
            if (receipt.version === 3 && receipt.projection === 'snapshot' && receipt.record.id === root.selector && read)
              provenance = { source: 'verified-notion-host-snapshot', ownerId: receipt.record.id, scope: receipt.scope, snapshot: receipt.snapshot, receiptSha256: digest(raw) };
            break;
          } catch { directory = settings.path.dirname(directory); }
        }
      } catch { /* An unreadable or unbound catalog path is not a verified Notion advertisement. */ }
      return { name: match[1].trim(), path: file, sha256, provenance };
    });
    const routers = [...prompt.matchAll(/<router\b[^>]*\bref="([^"]+)"/g)].map(match => ({ ref: unescape(match[1]) }));
    record({ phase: 'catalog', submittedPromptSha256: digest(event.prompt), frozenPromptMatched: event.prompt === settings.prompt, skills, routers, systemPromptSha256: digest(prompt), systemPromptBytes: Buffer.byteLength(prompt), localDiscoveryDisabled: true });
    if (projectFiles.size) return { systemPrompt: prompt + '\n\nCurrent owned project files (paths only; read the actual source when needed):\n' + [...projectFiles.values()].map(file => '- ' + file.path).join('\n') + '\n' };
  });
  api.on('context', (event, ctx) => { assertModel(ctx); record({ phase: 'agent-context', messages: event.messages.map(message => ({ role: message.role, customType: message.customType, toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError, contentSha256: digest(text(message.content)), contentBytes: Buffer.byteLength(text(message.content)), ...(message.details?.records ? { records: message.details.records } : {}), ...(message.details?.contextBrokerRead ? { read: message.details.contextBrokerRead } : {}), ...(message.details?.contextBrokerPreparation ? { preparation: message.details.contextBrokerPreparation } : {}) })) }); });
  api.on('before_provider_request', (event, ctx) => {
    assertModel(ctx);
    if (event.payload?.model !== undefined && !wireAllowed(event.payload.model)) throw new Error('Graph gate rejected an unauthorized provider model');
    const toolChoice = event.payload?.tool_choice ?? event.payload?.toolChoice;
    if (toolChoice !== undefined && toolChoice !== 'auto' && toolChoice?.type !== 'auto') throw new Error('Graph gate requires autonomous tool selection');
    const files = exportedFiles();
    const contents = files.flatMap(file => Array.from({ length: copies(event.payload, file.content) }, () => ({ ref: file.ref, logicalId: file.logicalId, ownerId: file.ownerId, scope: file.scope, snapshot: file.snapshot, sha256: file.sha256, bytes: file.bytes, role: file.role, content: file.content })));
    for (const file of files) if (contents.some(item => item.ref === file.ref)) discover(file.content, 'actual provider source body', file);
    for (const value of sourceStrings(event.payload)) discover(value, 'actual provider context');
    record({ phase: 'provider-request', model: settings.model, toolChoice: 'auto', forcedToolArguments: false, payloadSha256: digest(JSON.stringify(event.payload)), contents, sourceTextHashes: sourceStrings(event.payload).map(value => ({ sha256: digest(value), bytes: Buffer.byteLength(value) })) });
  });
  api.on('after_provider_response', event => record({ phase: 'provider-response', status: typeof event.status === 'number' ? event.status : null }));
  api.on('message_end', event => {
    const message = event.message;
    if (message?.role !== 'assistant') return;
    for (const part of message.content ?? []) if (part.type === 'toolCall') assistantCalls.set(part.id, { tool: part.name, input: part.arguments });
    const value = text(message.content);
    if (value.trim()) record({ phase: 'assistant-final', success: ['stop', 'length'].includes(message.stopReason), stopReason: message.stopReason ?? null, text: value, sha256: digest(value), bytes: Buffer.byteLength(value) });
  });
  api.on('tool_call', event => {
    const authored = assistantCalls.get(event.toolCallId);
    const input = authored?.input?.path ?? event.input?.path;
    const discoveredBefore = typeof input === 'string' && Boolean(wasDiscovered(input));
    const projectPath = typeof input === 'string' && !parseRef(input) ? resolve(settings.cwd, input) : undefined;
    const project = projectFiles.get(projectPath);
    const category = project ? 'project' : discoveredBefore ? 'skill' : 'blocked';
    const allowed = event.toolName === 'read' && (discoveredBefore || Boolean(project)) && authored?.tool === 'read';
    calls.set(event.toolCallId, { input, projectPath, category, discovered: discoveredBefore, origin: authored ? 'model' : 'unknown', sequence: sequence + 1, allowed });
    record({ phase: 'tool-call', toolCallId: event.toolCallId, tool: event.toolName, input, category, allowed, discovered: discoveredBefore, origin: authored ? 'model' : 'unknown' });
    if (!allowed) return { block: true, reason: 'This read-only gate permits the advertised owned project files and references discovered from the selected root or a successful read.' };
  });
  api.on('tool_result', event => {
    if (event.toolName !== 'read') return;
    const call = calls.get(event.toolCallId), content = text(event.content);
    if (call?.category === 'project') {
      const file = projectFiles.get(call.projectPath);
      const actual = readFileSync(call.projectPath);
      const complete = !event.isError && call.allowed && realpathSync(call.projectPath) === call.projectPath && digest(actual) === file.sha256 && digest(content) === file.sha256 && Buffer.byteLength(content) === file.bytes;
      record({ phase: 'project-read-result', toolCallId: event.toolCallId, path: file.path, complete, sourceSha256: file.sha256, returnedSha256: digest(content), bytes: Buffer.byteLength(content), origin: call.origin, callSequence: call.sequence });
      return;
    }
    if (call?.category === 'blocked') { record({ phase: 'blocked-read-result', toolCallId: event.toolCallId, requested: call.input, returnedSha256: digest(content), error: event.isError }); return; }
    const target = typeof call?.input === 'string' ? targetFor(call.input, content) : undefined;
    const complete = Boolean(target && !event.isError && call?.allowed);
    record({ phase: 'tool-result', toolCallId: event.toolCallId, tool: 'read', origin: call?.origin ?? 'unknown', discovered: call?.discovered ?? false, callSequence: call?.sequence, requested: call?.input, complete, error: event.isError || !target ? 'native read did not match one complete immutable file' : null, ...(target ? { ref: target.ref, logicalId: target.logicalId, ownerId: target.ownerId, scope: target.scope, snapshot: target.snapshot, sha256: digest(content), bytes: Buffer.byteLength(content), role: target.role, path: target.path, content } : { sha256: digest(content), bytes: Buffer.byteLength(content) }) });
    if (complete) discover(content, 'successful native read', target);
  });
  api.on('session_shutdown', () => record({ phase: 'session-shutdown' }));
}

export async function readGateConfig(path) {
  assert.ok(isAbsolute(path), '--config must be absolute');
  const input = await json(path);
  const allowed = ['version', 'gate', 'selection', 'rootRef', 'database', 'viewId', 'profileId', 'extension', 'packagePath', 'cliCommand', 'oraclePath', 'evidenceRoot', 'model', 'previousFailures', 'preparation', 'mode', 'reuseReceipt', 'selectionReceipt'];
  assert.ok(input && Object.keys(input).every(key => allowed.includes(key)), 'Unknown graph-model configuration field');
  assert.equal(input.version, 1);
  const prompt = frozenPrompt(input.gate, input.selection);
  assert.match(input.rootRef ?? '', /^skill:\/\/[^/?#]+\/(?:SKILL|ROUTER)\.md$/);
  assert.equal(input.rootRef.endsWith('/ROUTER.md'), input.gate === 'A', 'Gate A selects a Router; Gate B selects a Skill');
  assert.match(input.database ?? '', /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  assert.ok(Boolean(input.viewId) !== Boolean(input.profileId), 'Select exactly one existing root-only View or Profile');
  if (input.viewId) assert.match(input.viewId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  if (input.profileId) assert.match(input.profileId, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
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
  assert.ok(model === modelSelectors[0] || previousFailures.length, 'Worker requires a retained actual flash-free availability failure');
  const mode = input.mode ?? 'cold';
  assert.ok(['cold', 'warm-new-process', 'matrix'].includes(mode), 'Use cold, warm-new-process, or the fixed matrix (which includes two live continued-session samples)');
  assert.ok(mode === 'warm-new-process' ? isAbsolute(input.reuseReceipt ?? '') : input.reuseReceipt === undefined, 'Only warm-new-process may name a previous complete cache receipt');
  if (input.selectionReceipt !== undefined) assert.ok(isAbsolute(input.selectionReceipt));
  return { ...input, model, mode, previousFailures, prompt };
}

const brokerConfiguration = (config, command, cacheDir) => ({ skillRoots: [], extraSkillRoots: [], sources: [{ type: 'notion', id: 'notion', namespace: 'notion', command, database: config.database, ...(config.viewId ? { default_view_id: config.viewId } : { profile_id: config.profileId }), prefetch: false, cacheDir, requestTimeoutMs: 60000, ...(config.preparation ? { preparation: config.preparation } : {}) }] });
const sourceEnvironment = root => ({ NTN_SKILLS_CONFIG_HOME: join(root, 'config'), NTN_SKILLS_HOME: join(root, 'state'), NTN_SKILLS_CACHE_HOME: join(root, 'cache'), NTN_SKILLS_DATA_HOME: join(root, 'data') });
function gateEnvironment(cliPaths, brokerConfig, evidence, owned) {
  const env = { ...process.env, ...cliPaths, CONTEXT_BROKER_CONFIG: brokerConfig, CONTEXT_BROKER_HOST: 'pi', CONTEXT_BROKER_LOG_FILE: join(evidence, 'broker-decisions.jsonl'), BROKER_E2E_PROCESS_LEDGER: owned };
  for (const key of ['NODE_OPTIONS', 'CONTEXT_BROKER_ROOTS', 'CONTEXT_BROKER_EXTRA_ROOTS', 'CONTEXT_BROKER_DISCOVERY_CATALOGS', 'CONTEXT_BROKER_EXTRA_DISCOVERY_CATALOGS']) delete env[key];
  return env;
}

const runFingerprint = (config, doctor, oracleSha256, projectSha256) => hash(JSON.stringify({ version: 1, gate: config.gate, rootRef: config.rootRef, selection: config.selection, database: config.database, viewId: config.viewId, profileId: config.profileId, prompt: config.prompt.sha256, model: config.model, cli: doctor.cli.sha256, extension: doctor.extension.sha256, package: doctor.package.sha256, oracleSha256, projectSha256, preparation: config.preparation ?? null }));

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
  const prepared = responses.filter(item => item.command === 'prepare' && item.response?.status === 'ready' && item.response.purpose === 'use');
  const closes = new Map(sourceLedger.filter(event => event.phase === 'close').map(event => [event.requestId, event]));
  const ready = prepared.map(item => closes.get(item.requestId)).filter(event => event && Date.parse(event.at) >= Date.parse(sample.startedAt) && Date.parse(event.at) <= Date.parse(sample.finishedAt)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  const preparation = prepared.find(item => item.response.roots?.length)?.response;
  const rootIds = preparation?.roots.map(root => root.id) ?? [];
  const preparedIds = preparation?.nodes.filter(node => node.state === 'prepared').map(node => node.id) ?? [];
  const providers = inTurn.filter(event => event.phase === 'provider-request');
  const carries = (provider, ids) => ids.length > 0 && ids.every(id => provider.contents?.some(file => file.ownerId === id && file.role === 'entrypoint'));
  const rootReady = providers.find(provider => carries(provider, rootIds));
  const requiredReady = providers.find(provider => carries(provider, preparedIds));
  const final = inTurn.filter(event => event.phase === 'assistant-final' && event.success).at(-1);
  const elapsed = value => value ? Math.max(0, Date.parse(value) - Date.parse(sample.startedAt)) : null;
  return { pi_startup_ms: sample.mode === 'continued-session' ? null : startupMs, root_ready_ms: elapsed(rootReady?.at), required_ready_ms: elapsed(requiredReady?.at), task_final_ms: elapsed(final?.at), cli_prepare_ready_ms: elapsed(ready?.at), readinessEvidence: 'First actual provider boundary containing the verified root or full Required closure; this is an observed upper bound, not an invented earlier per-node event', provider_requests: providers.length };
}

export async function graphSelectionPreflight(config) {
  const artifacts = await packageIdentity(config);
  await mkdir(config.evidenceRoot, { recursive: true });
  const evidence = await mkdtemp(join(await realpath(config.evidenceRoot), 'graph-selection-'));
  const scratch = await mkdtemp(join(await systemTempRoot(), 'broker-graph-selection-'));
  const cli = join(scratch, 'cli'), broker = join(scratch, 'broker'), sessions = join(scratch, 'sessions'), control = join(scratch, 'control'), cwd = join(scratch, 'workspace'), responses = join(evidence, 'source-responses');
  await Promise.all([cli, broker, sessions, control, cwd, responses].map(path => mkdir(path)));
  const ledger = join(evidence, 'source-processes.jsonl'), owned = join(evidence, 'owned-processes.jsonl'), provider = join(evidence, 'provider-guard.jsonl');
  await Promise.all([ledger, owned, provider].map(path => writeFile(path, '', { mode: 0o600 })));
  const cliPaths = sourceEnvironment(cli), state = join(control, 'source.json'), brokerConfig = join(control, 'broker.json');
  await save(state, { command: config.cliCommand, cliPaths, ledger, responses, metadataOnly: true });
  await save(brokerConfig, brokerConfiguration(config, [process.execPath, helper, '--source', state], broker));
  const guard = join(control, 'no-provider.mjs');
  await writeFile(guard, "import { appendFileSync } from 'node:fs'; export default function(api) { api.on('before_provider_request', () => { appendFileSync(" + JSON.stringify(provider) + ", JSON.stringify({ at:new Date().toISOString(), unexpectedProvider:true }) + '\\n'); throw new Error('Metadata-only selection preflight cannot invoke a provider'); }); }\n", { mode: 0o600 });
  const result = { version: 1, status: 'running', kind: 'installed-pi-selection-preflight', evidence, scratch, rootRef: config.rootRef, database: config.database, viewId: config.viewId, profileId: config.profileId, artifacts, cliSha256: hash(await readFile(config.cliCommand[1])), files: ['result.json', 'source-processes.jsonl', 'owned-processes.jsonl', 'provider-guard.jsonl', 'ownership.json'], scope: 'Actual installed Pi commands and Notion metadata only; independent of the private oracle and the later cold consumer' };
  await save(join(scratch, 'ownership.json'), { evidence, purpose: 'native-graph-selection', runId: randomUUID() });
  await save(join(evidence, 'ownership.json'), await json(join(scratch, 'ownership.json')));
  await save(join(evidence, 'result.json'), result);
  console.log(JSON.stringify({ status: 'running', action: 'selection', evidence, scratch }));
  let rpc;
  try {
    rpc = await startRpc({ host: 'pi', cwd, env: gateEnvironment(cliPaths, brokerConfig, evidence, owned), timeoutMs: 90000, args: ['--no-extensions', '--no-skills', '--no-mcp', '--no-context-files', '--no-prompt-templates', '--session-dir', sessions, '--tools', 'read', '-e', guard, '-e', artifacts.extension.path, '--model', config.model] });
    const commands = await rpc.command('get_commands'); await save(join(evidence, 'registered-commands.json'), commands); result.files.push('registered-commands.json');
    const id = decodeURIComponent(config.rootRef.split('/')[2]);
    let record;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && !record) {
      record = (await collectResponses(responses)).flatMap(item => item.command === 'list' ? item.response?.records ?? [] : []).find(item => item.id === id);
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
    assert.equal((await rows(provider)).length, 0);
    const receipts = await collectResponses(responses);
    assert.ok(receipts.length && receipts.every(item => item.metrics?.complete), 'Retain a complete actual HTTP trace for every preflight command');
    result.httpAttempts = receipts.flatMap(item => item.metrics.trace.filter(event => event.event === 'attempt'));
    assert.ok(result.httpAttempts.every(event => event.request_kind === 'notion_metadata'), 'Selection preflight cannot load body bytes or write remote data');
    assert.ok(receipts.every(item => ['list', 'views', 'ctl'].includes(item.command)));
    result.providerRequests = 0; result.bodyRequests = 0; result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.error = { code: error.code ?? 'SELECTION_PREFLIGHT_FAILED', message: error.message }; }
  finally { if (rpc) { await save(join(evidence, 'pi-rpc.json'), rpc.frames); result.files.push('pi-rpc.json'); try { await rpc.stop(); } catch (error) { result.status = 'failed'; result.error ??= { code: 'HOST_CLOSE_FAILED', message: error.message }; } } }
  const processes = await rows(owned), sourceProcesses = await rows(ledger);
  result.processesClosed = processes.filter(event => event.event === 'spawn').every(event => processes.some(end => end.event === 'close' && end.pid === event.pid && end.observedExit)) && sourceProcesses.filter(event => event.phase === 'spawn').every(event => sourceProcesses.some(end => end.phase === 'close' && end.requestId === event.requestId));
  if (!result.processesClosed) { result.status = 'failed'; result.error = { code: 'PROCESS_EVIDENCE', message: 'An owned metadata preflight process has no observed close' }; }
  result.files.push(...(await readdir(responses)).map(name => 'source-responses/' + name));
  await save(join(evidence, 'result.json'), result); return result;
}

async function packageIdentity(config) {
  const extension = await entryIdentity(config.extension), pkg = await entryIdentity(config.packagePath);
  assert.ok(extension.path.includes('/node_modules/pi-context-broker/'), 'Consume an actual installed package entry');
  const packageRoot = extension.path.slice(0, extension.path.indexOf('/node_modules/pi-context-broker/') + '/node_modules/pi-context-broker'.length);
  const metadata = await json(join(packageRoot, 'package.json'));
  const declared = metadata.pi?.extensions?.[0];
  assert.ok(declared && await realpath(resolve(packageRoot, declared)) === extension.path, 'The entry must be declared by the installed Pi package');
  const packed = await runCommand('/usr/bin/tar', ['-xOf', pkg.path, 'package/' + declared.replace(/^\.\//, '')], { cwd: packageRoot, env: process.env, timeoutMs: 10000 });
  assert.equal(hash(packed.stdout), extension.sha256, 'Installed extension bytes differ from the frozen package');
  return { extension, package: pkg, packageRoot, bundledSkills: metadata.pi?.skills ?? [] };
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
  return { status: 'ready', gate: config.gate, model: config.model, prompt: config.prompt, ...artifacts, cli: { command: config.cliCommand, sha256: hash(await readFile(config.cliCommand[1])) }, node: process.version, pi: pi.stdout.trim(), authentication: 'existing credentials reused in place; not probed or copied', scratch: probe, proof: 'Doctor inspects artifacts and contract only; no real model or Notion request' };
}

async function collectResponses(directory) {
  return Promise.all((await readdir(directory)).filter(name => name.endsWith('.json')).map(name => json(join(directory, name))));
}

export function graphTrace({ config, oracle, observation, responses, sourceLedger, hostLedger, isolation, ownershipResponses = responses }) {
  const providerRequests = observation.filter(event => event.phase === 'provider-request');
  const firstProvider = providerRequests[0];
  assert.ok(firstProvider, 'No actual provider request was observed');
  const directorySequence = firstProvider.sequence;
  const reads = observation.filter(event => event.phase === 'tool-result').map(event => ({ ...event, sequence: event.callSequence ?? event.sequence }));
  if (config.gate === 'A' && oracle.roots?.B?.ref) assert.ok(!reads.some(read => read.ownerId === decodeURIComponent(oracle.roots.B.ref.split('/')[2])), 'Gate A cannot read the ordinary root as a bridge, including a pinned ref');
  const actualPrepare = responses.filter(item => item.command === 'prepare' && item.response?.status === 'ready').map(item => item.response);
  const rootPreparation = actualPrepare.find(value => value.purpose === 'use' && value.roots?.some(root => root.id === decodeURIComponent(config.rootRef.split('/')[2])));
  assert.ok(rootPreparation, 'The selected root must use the actual public prepare protocol');
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
  }
  const rootNode = selected.find(node => node.record.ref === config.rootRef);
  assert.ok(rootNode);
  const candidates = (rootNode.candidates ?? []).map(candidate => {
    const read = reads.find(read => read.logicalId === candidate.id && read.scope === rootPreparation.scope && read.complete);
    return { ref: read?.ref ?? candidate.ref, observedRef: candidate.ref, logicalId: candidate.id, scope: rootPreparation.scope, available: candidate.availability === 'available', sequence: directorySequence };
  });
  const pageOwners = new Map(), entityOwners = new Map();
  const remember = (index, key, owner) => { const values = index.get(key) ?? new Map(); values.set(owner.scope + '/' + owner.id, owner); index.set(key, values); };
  for (const item of ownershipResponses) {
    const value = item.response;
    if (item.command !== 'read' || value?.ok !== true || !value.record?.id || !value.scope) continue;
    const owner = { id: value.record.id, scope: value.scope, snapshot: value.snapshot_id };
    if (value.record.locator?.page_id) remember(pageOwners, value.record.locator.page_id.replaceAll('-', '').toLowerCase(), owner);
    for (const file of value.file_bindings ?? []) {
      remember(pageOwners, file.page_id.replaceAll('-', '').toLowerCase(), owner);
      remember(entityOwners, file.file_id, owner);
    }
    if (value.record.locator?.skill_id) remember(entityOwners, value.record.locator.skill_id, owner);
    remember(entityOwners, value.record.id, owner);
  }
  const closes = new Map(sourceLedger.filter(event => event.phase === 'close').map(event => [event.requestId, event]));
  const attempts = [];
  let missingMetrics = false, unattributedBeforeSelection = 0, memberBodyReadsBeforeSelection = 0;
  const selectedIds = new Set(selected.map(node => node.id));
  const calls = new Map(observation.filter(event => event.phase === 'tool-call').map(event => [event.toolCallId, event]));
  const starts = new Map(sourceLedger.filter(event => event.phase === 'spawn').map(event => [event.requestId, Date.parse(event.at)]));
  for (const receipt of responses) {
    if (!receipt.metrics?.complete) { missingMetrics = true; continue; }
    for (const event of receipt.metrics.trace.filter(event => event.event === 'attempt')) {
      const target = event.target;
      const page = target?.page_id ?? target?.block_id;
      const identities = page ? [pageOwners.get(page.replaceAll('-', '').toLowerCase())] : target?.entity_ids?.map(id => entityOwners.get(id)) ?? [];
      const attributed = identities.length > 0 && identities.every(values => values?.size === 1);
      const owners = [...new Map(identities.filter(Boolean).flatMap(values => [...values]).map(([key, owner]) => [key, owner])).values()];
      const selectedBefore = owner => owner.scope === rootPreparation.scope && (selectedIds.has(owner.id) || reads.some(read => read.ownerId === owner.id && read.scope === owner.scope && read.complete && calls.get(read.toolCallId)?.origin === 'model' && calls.get(read.toolCallId)?.allowed && Date.parse(calls.get(read.toolCallId).at) <= starts.get(receipt.requestId)));
      const beforeSelection = !attributed || owners.some(owner => !selectedBefore(owner));
      if (event.request_kind === 'notion_body') {
        if (!attributed) unattributedBeforeSelection++;
        if (owners.some(owner => !selectedBefore(owner))) memberBodyReadsBeforeSelection++;
      }
      attempts.push({ transport: 'direct_http', kind: event.request_kind === 'notion_body' ? 'body' : event.request_kind === 'notion_write' ? 'write' : event.request_kind === 'provider' ? 'provider' : 'metadata', status: event.http_status, requestIdAvailable: event.request_id !== null, requestId: event.request_id, ...(event.http_status === null ? { networkError: event.outcome } : {}), target: target ?? null, owners, attributed, beforeSelection, requestBytes: event.request_bytes, responseBytes: event.response_bytes, bodyKind: event.body_kind, command: receipt.command, requestReceipt: receipt.requestId });
    }
  }
  const processes = hostLedger.filter(event => event.event === 'spawn').map(event => ({ owned: true, pid: event.pid, spawnObserved: true, closeObserved: hostLedger.some(end => end.event === 'close' && end.pid === event.pid && end.observedExit), closed: hostLedger.some(end => end.event === 'close' && end.pid === event.pid && end.observedExit) }));
  for (const event of sourceLedger.filter(event => event.phase === 'spawn')) processes.push({ owned: true, pid: event.childPid, spawnObserved: true, closeObserved: closes.has(event.requestId), closed: closes.has(event.requestId) });
  const final = observation.filter(event => event.phase === 'assistant-final').at(-1);
  const statuses = observation.filter(event => ['provider-response', 'provider-transport-response'].includes(event.phase)).map(event => event.status).filter(status => typeof status === 'number');
  const trace = { version: 1, evidenceKind: 'real_model', host: 'pi', nativeEntry: true, gate: config.gate, prompt: config.prompt, selectedRoots: [config.rootRef], requiredRefs: rootPreparation.required.map(edge => edge.ref), toolChoice: 'auto', forcedToolArguments: false, cacheMode: config.mode === 'cold' || !config.mode ? 'cold' : 'warm', isolation, candidates, memberBodyReadsBeforeSelection: unattributedBeforeSelection || missingMetrics ? null : memberBodyReadsBeforeSelection, directorySequence, reads, providerRequests, httpLedgerObserved: !missingMetrics, httpAttempts: attempts, model: { selector: config.model, previousFailures: config.previousFailures, responseStatus: statuses.find(status => status >= 200 && status < 300) ?? statuses.at(-1) ?? null, final }, processes, unknownWrites: [], replayedUnknownWrites: false, preparation: { roots: rootPreparation.roots, required: rootPreparation.required, graph_lock: rootPreparation.graph_lock, usage: rootPreparation.usage }, attribution: { unattributedBeforeSelection, missingMetrics, rule: 'Every actual body target must map without ambiguity to a prepared root/Required or an earlier model-selected owner; missing targets never imply zero' } };
  const targetRead = reads.find(read => read.logicalId === oracle.target.logicalId && read.scope === oracle.target.scope);
  if (targetRead) assert.equal(targetRead.ref, oracle.target.ref, 'The oracle must use the observed canonical snapshot/file_id ref');
  return trace;
}

async function runGate(config) {
  const doctor = await graphModelDoctor(config);
  assert.ok(config.selectionReceipt, 'Run the public metadata-only selection preflight first');
  const selection = await json(config.selectionReceipt);
  assert.equal(selection.status, 'passed'); assert.equal(selection.kind, 'installed-pi-selection-preflight');
  assert.equal(selection.selection, config.selection); assert.equal(selection.rootRef, config.rootRef); assert.equal(selection.database, config.database); assert.equal(selection.viewId, config.viewId); assert.equal(selection.profileId, config.profileId);
  assert.equal(selection.artifacts.extension.sha256, doctor.extension.sha256); assert.equal(selection.cliSha256, doctor.cli.sha256, 'Selection preflight must use the same installed artifacts');
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
  await mkdir(responses);
  const ledger = join(evidence, 'source-processes.jsonl'), owned = join(evidence, 'owned-processes.jsonl'), output = join(evidence, 'observer.jsonl');
  await Promise.all([ledger, owned, output].map(path => writeFile(path, '', { mode: 0o600 })));
  const cliPaths = sourceEnvironment(resolved[0]);
  const statePath = join(control, 'source.json');
  await save(statePath, { command: config.cliCommand, cliPaths, ledger, responses });
  const brokerConfig = join(control, 'broker.json');
  await save(brokerConfig, brokerConfiguration(config, [process.execPath, helper, '--source', statePath], resolved[1]));
  const observer = join(control, 'observer.mjs');
  const settings = { rootRef: config.rootRef, model: config.model, prompt: config.prompt.text, cache: resolved[1], cwd, responses, output, project, priorResponseFiles };
  await writeFile(observer, "import * as fs from 'node:fs';\nimport * as crypto from 'node:crypto';\nimport * as path from 'node:path';\nexport default function(api) { (" + observeGraphGate.toString() + ')(api, { ...' + JSON.stringify(settings) + ', fs, crypto, path }); }\n', { mode: 0o600 });
  const inputObserver = join(control, 'input-observer.mjs');
  await writeFile(inputObserver, "import { appendFileSync } from 'node:fs'; import { createHash } from 'node:crypto';\nexport default function(api) { api.on('input', event => { const text = event.text ?? ''; appendFileSync(" + JSON.stringify(output) + ", JSON.stringify({ phase: 'native-input', at: new Date().toISOString(), source: event.source, textSha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text), frozenPromptMatched: text === " + JSON.stringify(config.prompt.text) + " }) + '\\n', { mode: 0o600 }); }); }\n", { mode: 0o600 });
  const isolation = { oracleRoots, consumerRoots: resolved, resolved: true, oracleObserverOnly: true, inventoryComplete: false, localSkillInventory: [], shellEnabled: false, contextFiles: false, promptTemplates: false, autoExtensions: false, prelaunch, discoveryPolicy: 'Pi --no-skills plus explicit installed Broker/observer only; native catalog inventory is captured; unobserved local reads are blocked', credentialPolicy: 'Inherited host authentication read in place; no credential file is read or copied by the driver' };
  const result = { version: 1, gate: config.gate, mode: config.mode, model: config.model, status: 'running', evidence, scratch, doctor, isolation, project, prompt: config.prompt, availabilityFailure: false, samples: [], files: ['doctor.json', 'isolation.json', 'project.json', 'ownership.json', 'observer.jsonl', 'source-processes.jsonl', 'owned-processes.jsonl', 'result.json'], notRun: ['Native composer Stop/TUI', 'Generated procedure execution until the explicit exercise action'] };
  await save(join(scratch, 'ownership.json'), { evidence, purpose: 'native-graph-model', runId: randomUUID() });
  await save(join(evidence, 'ownership.json'), await json(join(scratch, 'ownership.json')));
  await save(join(evidence, 'doctor.json'), doctor);
  await save(join(evidence, 'isolation.json'), isolation);
  await save(join(evidence, 'project.json'), project);
  await save(join(evidence, 'result.json'), result);
  console.log(JSON.stringify({ status: 'running', gate: config.gate, evidence, scratch }));
  const env = gateEnvironment(cliPaths, brokerConfig, evidence, owned);
  const args = ['--no-extensions', '--no-skills', '--no-mcp', '--no-context-files', '--no-prompt-templates', '--session-dir', resolved[2], '--tools', 'read', '-e', inputObserver, '-e', doctor.extension.path, '-e', observer, '--model', config.model];
  let rpc, launchError;
  let startupMs = null;
  try {
    const start = performance.now(); rpc = await startRpc({ host: 'pi', cwd, env, args, timeoutMs: 300000 }); startupMs = performance.now() - start;
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
  result.availabilityFailure = (!final?.success && (observation.some(event => event.phase === 'provider-transport-error') || responseStatuses.some(status => [401, 403, 404, 408, 429].includes(status) || status >= 500))) || Boolean(final && permissionFailure(final.text));
  try {
    const catalog = observation.find(event => event.phase === 'catalog');
    assert.ok(observation.some(event => event.phase === 'native-input' && event.frozenPromptMatched && event.textSha256 === config.prompt.sha256), 'The actual native input did not contain the frozen root-only task');
    assert.equal(catalog.skills.length + catalog.routers.length, 1, 'The actual default View must advertise only the selected root');
    if (config.gate === 'A') assert.equal(catalog.routers[0]?.ref, config.rootRef);
    else assert.equal(catalog.skills.length, 1);
    isolation.inventoryComplete = true;
    isolation.localSkillInventory = catalog.skills.filter(item => !['verified-notion-host-snapshot', 'verified-notion-host-index'].includes(item.provenance?.source));
    assert.ok(catalog.skills.every(item => item.provenance?.ownerId === decodeURIComponent(config.rootRef.split('/')[2])), 'Every advertised native Skill must be bound to the actual selected Notion snapshot');
    isolation.nativeCatalog = catalog;
    const trace = graphTrace({ config, oracle, observation, responses: responsesObserved, sourceLedger, hostLedger, isolation, ownershipResponses: [...responsesObserved, ...priorResponses] });
    await save(join(evidence, 'trace.json'), trace); result.files.push('trace.json');
    result.contract = evaluateGraphTrace(trace, oracle);
    result.preparation = trace.preparation;
    assert.ok(observation.some(event => event.phase === 'project-read-result' && event.complete && event.path.startsWith('src/')), 'The generated workflow must be grounded in an actual owned project source read');
    assert.ok(!observation.some(event => event.phase === 'tool-call' && !event.allowed), 'An unobserved local or shell fallback was attempted');
    await inspectOwnedGraphProject(cwd);
    if (launchError) throw launchError;
    assert.equal(result.availabilityFailure, false, 'HTTP success with a permission/quota answer is unavailable');
    await verifyEntryIdentity(doctor.extension.path, doctor.extension);
    result.status = 'passed';
    result.proof = 'Actual native Pi/provider/source artifacts checked against the independent oracle; contract alone is not counted as product proof';
  } catch (error) { result.status = 'failed'; result.error = { code: error.code ?? 'GRAPH_GATE_FAILED', message: error.code === 'ERR_ASSERTION' || error.code ? error.message : 'Native graph gate did not complete; retained observer and source artifacts identify the boundary' }; }
  for (const sample of result.samples) {
    sample.timings = observedTimings(sample, observation, responsesObserved, sourceLedger, startupMs);
    try {
      if (sample.error) throw Object.assign(new Error(sample.error.message), { code: sample.error.code });
      const through = observation.filter(event => Date.parse(event.at) <= Date.parse(sample.finishedAt));
      assert.ok(through.some(event => event.phase === 'native-input' && event.frozenPromptMatched && Date.parse(event.at) >= Date.parse(sample.startedAt)), 'This sample lacks its own native frozen input');
      assert.ok(through.some(event => event.phase === 'assistant-final' && event.success && Date.parse(event.at) >= Date.parse(sample.startedAt)), 'This sample lacks its own successful final');
      const available = responsesObserved.filter(receipt => sourceLedger.some(event => event.phase === 'close' && event.requestId === receipt.requestId && Date.parse(event.at) <= Date.parse(sample.finishedAt)));
      const trace = graphTrace({ config, oracle, observation: through, responses: available, sourceLedger, hostLedger, isolation, ownershipResponses: [...available, ...priorResponses] });
      sample.contract = evaluateGraphTrace(trace, oracle);
      sample.status = 'passed';
    } catch (error) { sample.status = 'failed'; sample.error = { code: error.code ?? 'SAMPLE_FAILED', message: error.message }; }
  }
  result.summary = summarizeSamples(result.samples);
  try { result.generatedPlan = await retainGeneratedPlan({ evidence, final, prompt: config.prompt, project }); }
  catch (error) { result.generatedPlan = { status: 'failed', artifactStatus: 'invalid-generated-files', error: { code: error.code ?? 'ARTIFACT_EXTRACTION_FAILED', message: error.message } }; }
  if (result.generatedPlan.status === 'plan-retained') result.files.push('generated-acceptance-plan.md', 'generated-plan.json', ...result.generatedPlan.files.map(file => file.evidencePath));
  result.productAcceptance = { graphStatus: result.status, generatedArtifactStatus: result.generatedPlan.artifactStatus ?? 'missing', generatedProcedureExecuted: false, scope: 'Graph/model evidence and generated-file execution are separate; a graph pass alone is not AH573 product completion' };
  if (result.status === 'passed' && result.samples.every(sample => sample.status === 'passed')) {
    const receiptPath = join(evidence, 'cache-reuse.json');
    const responseFiles = [...new Map([...priorResponseFiles, ...await Promise.all(responsesObserved.map(async receipt => { const path = join(responses, receipt.requestId + '.json'); return { path, sha256: hash(await readFile(path)) }; }))].map(file => [file.path, file])).values()];
    await save(receiptPath, { version: 1, status: 'complete', fingerprint, evidence, cliRoot: resolved[0], brokerRoot: resolved[1], projectSha256: project.sha256, taskSha256: config.prompt.sha256, responseFiles, graphLockSha256: result.preparation.graph_lock.sha256, prior: config.reuseReceipt ?? null });
    result.cacheReceipt = { path: receiptPath, sha256: hash(await readFile(receiptPath)) }; result.files.push('cache-reuse.json');
  } else if (result.samples.some(sample => sample.status === 'failed')) result.status = 'failed';
  await save(join(evidence, 'isolation.json'), isolation);
  result.files.push(...(await readdir(responses)).map(name => 'source-responses/' + name));
  result.finishedAt = new Date().toISOString();
  await save(join(evidence, 'result.json'), result);
  return result;
}

async function runMatrix(config) {
  await mkdir(config.evidenceRoot, { recursive: true });
  const evidence = await mkdtemp(join(await realpath(config.evidenceRoot), `graph-matrix-${config.gate}-`));
  const result = { version: 1, gate: config.gate, mode: 'matrix', evidence, status: 'running', prompt: config.prompt, design: { cold: 1, warm_new_process: 2, continued_session: 2, order: ['cold', 'warm-new-process', 'warm-new-process', 'continued-session', 'continued-session'] }, runs: [], samples: [], notRun: [], files: ['result.json'] };
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
  result.summary = summarizeSamples(result.samples);
  result.status = result.samples.length === 5 && result.samples.every(sample => sample.status === 'passed') ? 'passed' : 'failed';
  result.proof = 'Fixed five-sample design; each failure remains an observed sample, with raw timings and medians only. Continued samples retain the live session and cumulative original discovery/read receipts.';
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
    config: { version: 1, gate: 'A or B', selection: 'Use exact token returned by the independent selection preflight', selectionReceipt: 'absolute successful selection result.json; required for run', rootRef: 'exact unpinned shared record.ref', database: 'UUID', viewId: 'existing root-only View UUID; alternatively profileId', extension: 'absolute installed Pi entry', packagePath: 'absolute frozen tgz', cliCommand: ['absolute Node', 'absolute installed ntn-skills entry'], oraclePath: 'absolute private oracle JSON, kept outside consumer roots; not opened by selection preflight', evidenceRoot: 'absolute retained directory', model: modelSelectors[0], previousFailures: [], mode: 'cold (default), warm-new-process or matrix', reuseReceipt: 'absolute complete cache-reuse.json for warm-new-process only' },
    sampling: 'matrix runs 1 cold process, 2 warm new processes on the same complete CLI/Broker caches, then 2 more frozen submissions in the second warm live session; failures remain samples; raw values and medians, no p95',
    artifacts: 'Retain the actual final verbatim. Extract only complete fenced files with explicit relative filenames; a valid SKILL.md and all local links must be present. Prose alone remains plan-only. exercise accepts an exact test command from a retained generated file and drives the unchanged owned application with PID, exit, stdout and hash evidence. Graph pass alone is not generated-Skill acceptance.',
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
  await runCommand('/usr/bin/trash', [result.scratch], { cwd: dirname(helper), env: process.env, timeoutMs: 10000 });
  await save(join(options.evidence, 'cleanup.json'), { status: 'trashed', scratch: result.scratch, evidencePreserved: true });
  return { ...retained, cleanup: 'trashed' };
}

if (process.argv[1] && resolve(process.argv[1]) === helper) {
  try { const result = await main(process.argv.slice(2)); if (result !== undefined) console.log(JSON.stringify(result, null, 2)); if (result?.status === 'failed') process.exitCode = 1; }
  catch (error) { console.error(JSON.stringify({ status: 'failed', code: error.code ?? 'GRAPH_DRIVER_FAILED', message: error.message })); process.exitCode = 1; }
}
