#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { systemTempRoot } from './verification-paths.mjs';

const options = {};
const argv = process.argv.slice(2);
if (argv.some(arg => ['help', '--help', '-h'].includes(arg))) {
  console.log('Usage: node scripts/verify-daily-notion-ui.mjs --database UUID --skill-ref skill://PAGE/SKILL.md [--mode captured|model] [--invocation native|dollar] [--model provider/model --model-prompt TEXT] [--lifecycle --lifecycle-selection alias@namespace]\nDrives an owned Tern window using daily installed configuration; requires separate task authorization. --lifecycle requires captured dollar mode and gates real metadata in an owned cold Broker cache; normal daily paths remain separate. Captured defaults to all three entries; --invocation dollar selects first-turn dollar UI without native selected-View prerequisites.');
  process.exit(0);
}
while (argv.length) {
  const key = argv.shift();
  if (key === '--lifecycle') { assert.ok(!options.lifecycle, 'Duplicate option'); options.lifecycle = true; continue; }
  assert.ok(['--database', '--skill-ref', '--mode', '--model', '--model-prompt', '--invocation', '--lifecycle-selection'].includes(key) && argv.length, 'Require database/ref and valid runner options; --lifecycle requires captured dollar mode and --lifecycle-selection alias@namespace');
  assert.ok(!(key.slice(2) in options), 'Duplicate option');
  options[key.slice(2)] = argv.shift();
}
const uuid = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const normalizedId = id => String(id).replaceAll('-', '').toLowerCase();
const refMatch = /^skill:\/\/([^/]+)\/SKILL\.md$/.exec(options['skill-ref'] ?? '');
const mode = options.mode ?? 'captured';
const invocation = options.invocation ?? 'native';
assert.ok(uuid.test(options.database ?? '') && refMatch && uuid.test(refMatch[1]), 'Require database UUID and skill://PAGE/SKILL.md');
assert.ok(['captured', 'model'].includes(mode), 'Mode must be captured or model');
assert.ok(['native', 'dollar'].includes(invocation), 'Invocation must be native or dollar');
const coldDollar = invocation === 'dollar';
const lifecycle = options.lifecycle === true;
assert.ok(!lifecycle || (mode === 'captured' && coldDollar && /^[^\s$]+@[^\s@]+$/.test(options['lifecycle-selection'] ?? '')), '--lifecycle requires --mode captured --invocation dollar --lifecycle-selection alias@namespace');
assert.ok(lifecycle || !options['lifecycle-selection'], '--lifecycle-selection requires --lifecycle');
const [nodeMajor, nodeMinor, nodePatch] = process.versions.node.split('.').map(Number);
const supportedNode = (nodeMajor === 22 && (nodeMinor > 22 || (nodeMinor === 22 && nodePatch >= 3))) || nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 20);
assert.ok(process.platform === 'darwin' && supportedNode && !process.versions.bun, 'Require macOS and Node.js 22.22.3+ within 22.x or 24.20.0+; Bun is build-only');
if (mode === 'model') {
  assert.ok(/^[^/\s]+\/[^\s]+$/.test(options.model ?? ''), 'Model mode requires an authorized provider/model');
  assert.ok(options['model-prompt']?.trim() && !/\$|\/skill:|skill:\/\/|\b(?:ntn-skills|notion-skills|api[_ -]?key|access[_ -]?token|bearer)\b/i.test(options['model-prompt']), 'Model mode requires a natural task prompt without invocation tokens or credential hints');
} else assert.ok(!options.model && !options['model-prompt'], 'Model options require --mode model');

const base = await mkdtemp(join(await systemTempRoot(), 'broker-daily-notion-ui-'));
const socket = join(base, 'control.sock');
const daemonSocket = join(base, 'daemon.sock');
const ternDir = join(base, 'tern');
const sessions = join(base, 'sessions');
const observations = join(base, 'consumption.jsonl');
const actions = join(base, 'actions.jsonl');
const model = mode === 'model' ? options.model : 'context-broker-e2e/fake';
const page = normalizedId(refMatch[1]);
const expectationFile = join(base, 'lifecycle-expectation.json');
const metadataGate = join(base, 'metadata-release');
const activePidFile = join(base, 'active-omp.pid');
const metadataEvents = join(base, 'metadata-events.jsonl');
const secrets = Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL/i.test(key) && value?.length >= 4).map(([, value]) => value);
function sanitize(value) {
  let text = String(value);
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"')\]]+/gi, '[url withheld]')
    .replace(/\b(?:Bearer|Basic)\s+[a-z0-9+/._=-]+/gi, '[authorization withheld]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|authorization|cookie)\s*[:=]\s*)[^\n,;]+/gi, '$1[redacted]');
}
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const hash = body => createHash('sha256').update(body).digest('hex');
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const expand = path => resolve(path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
const pause = ms => new Promise(accept => setTimeout(accept, ms));
const manifest = { status: 'running', mode, invocation, startedAt: new Date().toISOString(), evidence: base, database: options.database, skillRef: options['skill-ref'], model, stages: [], results: {}, files: ['actions.jsonl', 'consumption.jsonl', 'owned-processes.json', 'cleanup.json'], boundary: { broker: 'Daily automatically loaded installed broker; no -e broker, --no-extensions or --no-skills', notion: 'Existing authenticated source; read-only list/read and normal broker export/cache, no remote fixture', model: mode === 'model' ? 'Cold session, selected invocation menu and real authorized model response; extra main-entry/metadata/resource reads and snapshot glob calls are observations, not a zero-tool assertion' : 'Fake provider captures body digest/count; no real model inference', isolation: 'Owned Tern daemon/window/control endpoint, copied daily installed companion, isolated TERN_CONFIG_DIR and sessions; actual daily config/agentDir and inherited authentication' } };
if (mode === 'model') manifest.modelTask = { bytes: Buffer.byteLength(options['model-prompt']), sha256: hash(options['model-prompt']), promptWithheld: true };
let env = { ...process.env, TERN_CONFIG_DIR: ternDir, TERN_DAEMON_SOCKET: daemonSocket, STENCIL_LOG_DIR: join(base, 'logs') };
const owned = [];
let daemon;
let window;
let failure;
async function rows(path) {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function until(label, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if ([daemon, window].some(child => child && (child.exitCode !== null || child.signalCode !== null))) throw new Error(`Owned process exited during ${label}`);
    await pause(150);
  }
  throw new Error(`Timeout: ${label}`);
}
async function stage(name, fn) {
  const receipt = { name, status: 'running', startedAt: new Date().toISOString() };
  manifest.stages.push(receipt);
  await save(join(base, 'manifest.json'), manifest);
  try { await fn(); receipt.status = 'passed'; }
  catch (error) { receipt.status = 'failed'; receipt.error = sanitize(error.message); throw error; }
  finally { receipt.finishedAt = new Date().toISOString(); await save(join(base, 'manifest.json'), manifest); }
}
async function executable(name) {
  if (isAbsolute(name)) { await stat(name); return realpath(name); }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const path = join(directory, name);
    try { if ((await stat(path)).isFile()) return await realpath(path); } catch {}
  }
  throw new Error('Required daily executable unavailable');
}
function run(file, args, extra = {}) {
  const result = spawnSync(file, args, { cwd: base, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...extra });
  assert.ok(result.status === 0 && !result.error, `Command ${sanitize(file.split('/').at(-1))} ${sanitize(args[0] ?? '')} failed (exit ${result.status ?? 'none'}, signal ${result.signal ?? 'none'}, error ${result.error?.code ?? 'none'}); raw diagnostics withheld`);
  return result.stdout;
}
function ctl(...args) {
  const result = JSON.parse(run('tern', ['ctl', '--control', socket, ...args], { timeout: args[0] === 'ready' ? 30_000 : 10_000 }));
  assert.notEqual(result.ok, false, 'Owned Tern control action failed');
  return result;
}
const nodes = value => !value || typeof value !== 'object' ? [] : [...(Array.isArray(value) ? [] : [value]), ...Object.values(value).flatMap(nodes)];
const texts = value => nodes(value).flatMap(node => typeof node.text === 'string' ? [node.text] : []);
const editor = () => ctl('tree', '.sf-editor').nodes[0];
async function action(name, ...args) {
  await appendFile(actions, JSON.stringify({ at: new Date().toISOString(), action: name, args: args.map(sanitize) }) + '\n', { mode: 0o600 });
  return ctl(name, ...args);
}
const key = chord => action('key', chord);
const type = text => action('type', JSON.stringify(text));
async function draft(text) { await key('escape'); await key('cmd+a'); await key('backspace'); await type(text); }
async function evidence(label) {
  await save(join(base, `${label}-state.json`), JSON.parse(sanitize(JSON.stringify({ editor: editor(), tree: ctl('tree') }))));
  await action('shot', label);
  manifest.files.push(`${label}-state.json`);
}
async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await inventory(path, name + '/'));
    else if (entry.isFile()) { const bytes = await readFile(path); files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) }); }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function own(child, role) {
  owned.push({ child, role, pid: child.pid, command: child.spawnargs.map(sanitize) });
  await save(join(base, 'owned-processes.json'), owned.map(({ child: _child, ...receipt }) => receipt));
  child.on('error', () => {});
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => {
    // Keep lifecycle/byte evidence only: chunk boundaries can split secrets.
    void appendFile(join(base, `${role}.log`), JSON.stringify({ at: new Date().toISOString(), bytes: data.length, diagnosticsWithheld: true }) + '\n', { mode: 0o600 }).catch(() => {});
  });
}
async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((accept, reject) => {
    const finish = () => { clearTimeout(escalation); clearTimeout(deadline); accept(); };
    child.once('close', finish);
    const escalation = setTimeout(() => child.kill('SIGKILL'), 2_000);
    const deadline = setTimeout(() => { child.removeListener('close', finish); reject(new Error('Owned process shutdown timed out')); }, 7_000);
    child.kill('SIGTERM');
  });
}

// Runs inside the existing authorized OMP host. Provider payloads remain in
// memory; the retained assertion uses the complete non-frontmatter body.
function observe(api, settings) {
  const { fs, crypto, path, body, entry, output, expectedModel, fake, invocation, page, cache, home, alias, canonical, mainPath, exportFiles } = settings;
  const record = value => fs.appendFileSync(output, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 });
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const normalize = text => text.replace(/\r\n/g, '\n').trim();
  const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  let marker = normalize(body);
  let escapedMarker = marker.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const refreshExpectation = () => {
    if (!settings.expectationFile || !fs.existsSync(settings.expectationFile)) return;
    marker = normalize(JSON.parse(fs.readFileSync(settings.expectationFile, 'utf8')).body);
    escapedMarker = marker.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  };
  const nativeMarkers = new Map();
  const count = value => {
    refreshExpectation();
    return strings(value).reduce((sum, text) => {
      const normalized = normalize(text);
      return sum + [...new Set([marker, escapedMarker, ...nativeMarkers.values()])].reduce((matches, expected) => matches + normalized.split(expected).length - 1, 0);
    }, 0);
  };
  const secrets = Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL/i.test(key) && value?.length >= 4).map(([, value]) => value);
  const clean = text => {
    let result = String(text);
    for (const secret of secrets) result = result.split(secret).join('[redacted]');
    return result.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"')\]]+/gi, '[url withheld]').replace(/\b(?:Bearer|Basic)\s+[a-z0-9+/._=-]+/gi, '[authorization withheld]').replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|authorization|cookie)\s*[:=]\s*)[^\n,;]+/gi, '$1[redacted]');
  };
  const assertModel = ctx => { if (`${ctx.model?.provider}/${ctx.model?.id}` !== expectedModel) throw new Error('Daily UI unauthorized model selector'); };
  const within = (parent, child) => { const part = path.relative(parent, child); return part !== '..' && !part.startsWith('..' + path.sep) && !path.isAbsolute(part); };
  const stripSelector = input => input.replace(/:(?:raw(?::.*)?|\d.*|-[0-9].*)$/, '');
  const absolute = input => path.resolve(input === '~' ? home : input.startsWith('~/') ? path.join(home, input.slice(2)) : input);
  const snapshotPath = input => {
    const target = absolute(input);
    if (!within(cache, target)) return null;
    const parts = path.relative(cache, target).split(path.sep);
    const selectedRecord = 'notion_page:' + page.replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
    const recordKey = sha(selectedRecord);
    const index = parts.findIndex((part, index) => part === 'records' && parts[index + 1] === recordKey && parts[index + 2] === 'snapshots' && Boolean(parts[index + 3]));
    if (index < 0) return null;
    const root = path.join(cache, ...parts.slice(0, index + 4));
    try { if (!within(fs.realpathSync(cache), fs.realpathSync(root))) return null; } catch { return null; }
    return { target, root, relativePath: path.relative(root, target).split(path.sep).join('/') };
  };
  const selectedRead = input => {
    if (typeof input !== 'string') return null;
    if (input.startsWith('skill://')) {
      const [name, ...parts] = stripSelector(input.slice(8)).split('/');
      if (!new Set([alias, canonical.replace(/[^a-z0-9-]/g, '-'), page]).has(name)) return null;
      const relativePath = parts.join('/');
      if (relativePath.split('/').includes('..')) return null;
      return { kind: relativePath === mainPath || relativePath === 'SKILL.md' ? 'main_entry' : path.basename(relativePath) === '.ntn-skills.json' ? 'metadata' : 'resource', relativePath };
    }
    const selected = snapshotPath(stripSelector(input));
    if (!selected) return null;
    try {
      if (!within(fs.realpathSync(selected.root), fs.realpathSync(selected.target))) return null;
      const kind = fs.statSync(selected.target).isDirectory() ? 'directory' : selected.relativePath === mainPath ? 'main_entry' : path.basename(selected.target) === '.ntn-skills.json' || path.basename(selected.target) === '.broker-snapshot.json' ? 'metadata' : 'resource';
      const pinned = exportFiles.find(file => file.path === selected.relativePath);
      return { kind, relativePath: selected.relativePath, ...(kind === 'resource' && pinned ? { pinnedFileSha256: pinned.sha256, snapshotMatchesPinnedExport: sha(fs.readFileSync(selected.target)) === pinned.sha256 } : {}) };
    } catch { return null; }
  };
  const selectedGlob = input => {
    if (typeof input !== 'string' || !input.trim()) return null;
    const paths = input.split(';').map(part => part.trim());
    const roots = [];
    for (const pattern of paths) {
      const wildcard = pattern.search(/[*?{\[!(]/);
      const prefix = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
      const anchor = wildcard < 0 || prefix.endsWith('/') ? prefix : path.dirname(prefix);
      const selected = snapshotPath(anchor);
      if (!selected || pattern.split('/').includes('..')) return null;
      try {
        if (!within(fs.realpathSync(selected.root), fs.realpathSync(selected.target))) return null;
        // Glob follows directory links; constrain every reachable link as well.
        const pending = [selected.root];
        const visited = new Set();
        while (pending.length) {
          const directory = fs.realpathSync(pending.pop());
          if (visited.has(directory)) continue;
          visited.add(directory);
          for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
            const child = path.join(directory, item.name);
            const actual = fs.realpathSync(child);
            if (!within(fs.realpathSync(selected.root), actual)) return null;
            if (fs.statSync(actual).isDirectory()) pending.push(actual);
          }
        }
      } catch { return null; }
      roots.push(clean(selected.root));
    }
    return { kind: 'glob', snapshotRoots: [...new Set(roots)] };
  };
  const selectedTool = event => event.toolName === 'read' ? selectedRead(event.input?.path) : event.toolName === 'glob' && !fake ? selectedGlob(event.input?.path) : null;
  api.on('session_start', async (_event, ctx) => {
    assertModel(ctx);
    const available = api.getAllTools().map(tool => typeof tool === 'string' ? tool : tool.name);
    const tools = fake ? ['read'] : ['read', 'glob'].filter(name => available.includes(name));
    if (!tools.includes('read')) throw new Error('Daily verification requires the native read tool');
    await api.setActiveTools(tools);
    record({ phase: 'selected', model: expectedModel, invocation, tools, globAvailable: available.includes('glob'), pid: process.pid, sessionFile: ctx.sessionManager?.getSessionFile?.() ?? null });
  });
  api.on('session_switch', (event, ctx) => record({ phase: 'session_switch', reason: event.reason, previousSessionFile: event.previousSessionFile ?? null, pid: process.pid, sessionFile: ctx.sessionManager?.getSessionFile?.() ?? null }));
  api.on('context', async (event, ctx) => {
    assertModel(ctx);
    for (const message of event.messages) {
      if (message.customType !== 'skill-prompt-message' || !message.details?.records?.some(record => String(record.recordId).split(":").at(-1).replaceAll('-', '').toLowerCase() === page)) continue;
      const details = message.details;
      const key = JSON.stringify([details.name, details.path, details.args, details.prompt]);
      if (nativeMarkers.has(key)) continue;
      if (typeof api.pi?.buildSkillPromptMessage !== 'function') throw new Error('Daily UI requires native Skill prompt rendering');
      const expected = await api.pi.buildSkillPromptMessage({ name: details.name, filePath: entry, baseDir: path.dirname(details.path) }, { args: details.args ?? '', prompt: details.prompt });
      const rendered = normalize(expected.message);
      // Count an unchanged or XML-escaped body through its portable marker only.
      if (!rendered.includes(marker) && !rendered.includes(escapedMarker)) nativeMarkers.set(key, rendered);
      record({ phase: 'native_expectation', source: 'pinned-export-rendered-by-installed-host', bytes: Buffer.byteLength(rendered), sha256: sha(rendered) });
    }
    record({ phase: 'context', model: expectedModel, skillBodies: count(event.messages), bodySha256: sha(marker) });
  });
  api.on('before_provider_request', (event, ctx) => { assertModel(ctx); record({ phase: 'request', model: expectedModel, skillBodies: count(event.payload), bodySha256: sha(marker) }); });
  api.on('after_provider_response', event => record({ phase: 'response', status: typeof event.status === 'number' ? event.status : null }));
  api.on('tool_call', event => {
    const selected = selectedTool(event);
    if (!selected) {
      record({ phase: 'tool_blocked', tool: clean(event.toolName), ...(typeof event.input?.path === 'string' ? { path: clean(event.input.path) } : {}), reason: 'outside-selected-snapshot-or-tool' });
      return { block: true, reason: 'Daily verification permits only selected Notion snapshot read/glob operations' };
    }
    record({ phase: 'tool_call', tool: event.toolName, path: clean(event.input.path), ...selected });
  });
  api.on('tool_result', event => {
    const selected = selectedTool(event);
    if (!selected) return;
    const text = (event.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    record({ phase: 'tool_result', tool: event.toolName, path: clean(event.input.path), ...selected, isError: Boolean(event.isError), skillBodies: count(text), bytes: Buffer.byteLength(text), sha256: sha(text) });
  });
  api.on('message_end', event => {
    const message = event.message;
    if (message?.role !== 'assistant') return;
    const text = (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    record({ phase: 'assistant', stopReason: message.stopReason ?? null, success: ['stop', 'length'].includes(message.stopReason) && Boolean(text.trim()), bytes: Buffer.byteLength(text), sha256: sha(text), text: clean(text) });
  });
  api.on('agent_end', () => record({ phase: 'agent_end' }));
  if (fake) {
    api.registerProvider('context-broker-e2e', {
      name: 'Context Broker Daily Capture', api: 'context-broker-e2e-api', apiKey: 'fixture-no-secret', baseUrl: 'http://127.0.0.1',
      models: [{ id: 'fake', name: 'Daily Capture', input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4096 }],
      streamSimple(model, context) {
        record({ phase: 'captured_provider', model: model.provider + '/' + model.id, mainContext: Array.isArray(context.tools), skillBodies: count(context.messages), bodySha256: sha(marker), pid: process.pid, userMessages: context.messages.filter(message => message.role === 'user').length, assistantMessages: context.messages.filter(message => message.role === 'assistant').length });
        const output = { role: 'assistant', content: [{ type: 'text', text: 'OK' }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
        return { push() {}, end() {}, result: async () => output, async *[Symbol.asyncIterator]() {
          yield { type: 'start', partial: output };
          yield { type: 'text_start', contentIndex: 0, partial: output };
          yield { type: 'text_delta', contentIndex: 0, delta: 'OK', partial: output };
          yield { type: 'text_end', contentIndex: 0, content: 'OK', partial: output };
          yield { type: 'done', reason: 'stop', message: output };
        } };
      },
    });
  }
}

try {
  let daily;
  let parseYaml;
  let source;
  let command;
  let canonical;
  let selection;
  let nativeName;
  let body;
  let cache;
  let launcher;
  await stage('daily-installation-and-configuration', async () => {
    const dailyTern = expand(process.env.TERN_CONFIG_DIR ?? join(homedir(), 'Library/Application Support/Tern'));
    const settingsPath = join(dailyTern, 'plugin-data/context-broker/config.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.ok(typeof settings.config === 'string' && typeof settings.agentDir === 'string', 'Daily companion must explicitly identify actual broker config and agentDir');
    const config = await realpath(expand(settings.config));
    const agentDir = await realpath(expand(settings.agentDir));
    const installed = join(dirname(agentDir), 'plugins/node_modules/pi-context-broker');
    const packageRoot = await realpath(installed);
    const meta = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const lockPath = join(dirname(agentDir), 'plugins/omp-plugins.lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(lock.plugins?.[meta.name]?.enabled, true, 'Daily broker must be enabled in the normal OMP plugin registry');
    const require = createRequire(join(packageRoot, 'package.json'));
    parseYaml = require('yaml').parse;
    const parsed = parseYaml(await readFile(config, 'utf8'));
    const sources = (parsed.sources ?? []).filter(item => item.type === 'notion' && item.enabled !== false && (!item.database || normalizedId(item.database) === normalizedId(options.database)));
    assert.equal(sources.length, 1, 'Daily configuration must resolve one enabled Notion source for the selected database');
    source = sources[0];
    assert.ok(source.id, 'Daily Notion source requires an id');
    command = typeof source.command === 'string' ? [source.command] : source.command ?? ['ntn-skills'];
    assert.ok(Array.isArray(command) && command.length && command.every(arg => typeof arg === 'string'), 'Daily source command must be argv');
    const companion = await realpath(join(dailyTern, 'plugins/context-broker'));
    daily = { config, agentDir, companion, node: settings.node ?? process.execPath, settingsPath, packageRoot };
    cache = expand(source.cacheDir ?? join(homedir(), '.cache/context-broker/notion'));
    env = { ...env, PI_CODING_AGENT_DIR: agentDir, OMP_CODING_AGENT_DIR: agentDir, CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_HOST: 'omp' };
    delete env.CONTEXT_BROKER_ROOTS;
    delete env.CONTEXT_BROKER_EXTRA_ROOTS;
    const installedEntry = resolve(packageRoot, meta.omp?.extensions?.[0] ?? meta.pi?.extensions?.[0] ?? '');
    assert.ok(installedEntry !== packageRoot, 'Installed broker must declare a normal extension entry');
    const cliPath = await executable(command[0]);
    manifest.installation = { settingsPath, config, agentDir, installed, packageRoot, installedEntry, packageVersion: meta.version, registeredVersion: lock.plugins[meta.name].version, entrySha256: hash(await readFile(installedEntry)), companion, companionFiles: await inventory(companion), brokerSourceFiles: await inventory(join(packageRoot, 'src')), cliPath, cliSha256: hash(await readFile(cliPath)), source: { id: source.id, namespace: source.namespace ?? source.id, database: source.database ?? null, cacheDir: cache, discovery: source.discovery ?? 'default', activation: source.activation ?? 'default', command: [cliPath], commandArgumentCount: command.length - 1, commandArgumentsWithheld: true }, nodeVersion: process.versions.node, ompVersion: sanitize(run('omp', ['--version']).trim()), ternVersion: sanitize(run('tern', ['--version']).trim()), cliVersion: sanitize(run(command[0], [...command.slice(1), '--version']).trim()), configSha256: hash(await readFile(config)) };
    if (lifecycle) {
      const proxy = join(base, 'metadata-transport.mjs');
      await writeFile(proxy, `import { existsSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const list = args[0] === 'list';
const record = phase => appendFileSync(${JSON.stringify(metadataEvents)}, JSON.stringify({at: new Date().toISOString(), phase, pid: process.pid}) + '\\n', {mode: 0o600});
if (list) { record('list_waiting'); const deadline = Date.now() + 180_000; while (!existsSync(${JSON.stringify(metadataGate)})) { if (Date.now() >= deadline) { record('list_gate_timeout'); process.exit(1); } await new Promise(resolve => setTimeout(resolve, 50)); } record('list_released'); for (let i = args.length - 1; i >= 0; i--) { if (args[i] === '--max-age') args.splice(i, 2); else if (args[i] === '--offline') args.splice(i, 1); } if (!args.includes('--refresh')) args.push('--refresh'); }
const result = spawnSync(${JSON.stringify(cliPath)}, [...${JSON.stringify(command.slice(1))}, ...args], {env: process.env, stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024});
if (list) { let ok = false; try { ok = result.status === 0 && JSON.parse(result.stdout).ok === true; } catch {} record(ok ? 'list_success' : 'list_failed'); }
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
`, { mode: 0o600 });
      cache = join(base, 'cold-broker-cache');
      const controlledConfig = join(base, 'controlled-config.json');
      await save(controlledConfig, { ...parsed, sources: [{ ...source, cacheDir: cache, command: [daily.node, proxy] }] });
      daily.config = controlledConfig;
      env.CONTEXT_BROKER_CONFIG = controlledConfig;
      selection = options['lifecycle-selection'];
      canonical = `${source.namespace ?? source.id}/${selection.slice(0, selection.lastIndexOf('@'))}`;
      body = 'lifecycle-expectation-not-yet-pinned';
      manifest.selection = { invocation: selection, alias: selection.slice(0, selection.lastIndexOf('@')), canonical, pageId: refMatch[1] };
      manifest.lifecycle = { controlled: true, metadataEvents: 'metadata-events.jsonl', cases: [], requiredCases: Object.fromEntries(['lifecycle-cold-first-input', 'lifecycle-new-session', 'lifecycle-restart-retained', 'lifecycle-fresh-process'].map(label => [label, { status: 'not_run' }])), cacheDir: cache, originalConfig: config, controlledConfig };
      manifest.boundary.notion = 'Controlled metadata scheduling only: selected real daily source and CLI, owned cold Broker cache, first list --refresh held until first editor input. CLI content/auth caches are not reset. No initial list/read/query. Live daily acceptance is a separate run.';
      manifest.boundary.isolation += '; lifecycle clones only selected source/config and gates metadata transport';
      manifest.files.push('metadata-events.jsonl');
    }
    await mkdir(join(ternDir, 'plugin-data/context-broker'), { recursive: true, mode: 0o700 });
    await mkdir(sessions, { mode: 0o700 });
    await save(join(ternDir, 'plugin-data/context-broker/config.json'), { config: daily.config, agentDir, node: daily.node });
  });
  async function pinSelection() { await stage('real-notion-list-read-and-installed-query', async () => {
    const invoke = args => {
      const result = JSON.parse(run(command[0], [...command.slice(1), ...args], { timeout: 600_000 }));
      assert.equal(result.ok, true, 'Real Notion CLI operation failed; raw diagnostics withheld');
      return result;
    };
    const listed = invoke(['list', '--database', options.database, '--refresh']);
    assert.ok(listed.coverage && Array.isArray(listed.coverage.failed_sources), 'Selected database must preserve coverage diagnostics');
    manifest.catalogFailures = listed.coverage.failed_sources;
    const selected = listed.records.filter(item => normalizedId(item.locator?.page_id) === page);
    assert.equal(selected.length, 1, 'Selected page must uniquely belong to the actual database catalog');
    const item = selected[0];
    assert.ok(item.name && item.alias && item.ref, 'Real selected skill must expose name, alias and ref');
    if (!coldDollar) {
      const directory = invoke(['list', '--database', options.database, ...(source.default_view_id ? ['--view', source.default_view_id] : ['--default-view']), '--refresh']);
      assert.ok(directory.view?.id, 'Daily native recipe requires an accessible selected View');
      assert.ok(directory.records.some(record => normalizedId(record.locator?.page_id) === page), 'Selected page must belong to the default View; checkbox alone does not grant default discovery');
      manifest.defaultView = { id: directory.view.id, name: directory.view.name, origin: source.default_view_id ? 'configured' : 'first', coverage: directory.coverage };
    }
    const read = invoke(['read', item.ref, '--database', options.database, '--refresh']);
    assert.ok(read.content?.trim() && read.snapshot_id && read.has_more === false, 'Real CLI read must return complete skill body');
    assert.equal(normalizedId(read.record?.locator?.page_id), page, 'Real read must match selected page');
    const exported = invoke(['export', read.snapshot_id, '--projection', 'snapshot', '--format', 'directory', '--output', join(base, 'selected-export')]);
    assert.equal(exported.projection, 'snapshot', 'Consumer proof requires the same snapshot projection as Broker activation');
    const exportRoot = await realpath(expand(exported.output));
    const exportEntry = await realpath(exported.main_path.startsWith('~/') || exported.main_path === '~' ? expand(exported.main_path) : resolve(exportRoot, exported.main_path));
    const entryRelative = relative(exportRoot, exportEntry);
    assert.ok(entryRelative !== '..' && !entryRelative.startsWith('..' + sep) && !isAbsolute(entryRelative), 'Export entry must remain within selected snapshot');
    const exportedContent = await readFile(exportEntry, 'utf8');
    assert.equal(exportedContent, read.content, 'Pinned snapshot export entry must equal the complete live read');
    body = exportedContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/\r\n/g, '\n').trim();
    assert.ok(body, 'Selected export must contain a complete non-frontmatter body');
    manifest.export = { output: exportRoot, entry: exportEntry, snapshotId: read.snapshot_id, sha256: hash(exportedContent), bytes: Buffer.byteLength(exportedContent), files: await inventory(exportRoot) };
    const suffix = listed.coverage.failed_sources.length || listed.records.filter(skill => skill.alias === item.alias).length > 1 ? `@${page}` : '';
    const text = `$${item.alias}${suffix}@${source.namespace ?? source.id}`;
    if (lifecycle) assert.equal(text, `$${options['lifecycle-selection']}`, 'Explicit lifecycle selection must equal the exact live source identity');
    const query = join(daily.companion, 'query/completion.mjs');
    const response = JSON.parse(run(daily.node, [query], { input: JSON.stringify({ version: 1, text, cursor: text.length, cwd: base, config: daily.config }) }));
    const matching = response.items.filter(candidate => candidate.value === text);
    assert.equal(matching.length, 1, 'Actual installed companion query must identify one selected source token');
    canonical = `${source.namespace ?? source.id}/${item.alias}${suffix}`;
    selection = matching[0].value.slice(1);
    if (!coldDollar) {
    // Read an actual generated host catalog stub, rather than assuming the
    // namespace/alias directly equals the native slash command.
    const sourceCache = join(cache, 'scopes');
    const names = new Set();
    for (const scope of await readdir(sourceCache)) {
      let indexes;
      try { indexes = await readdir(join(sourceCache, scope, 'indexes')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const index of indexes) {
        try {
          const path = join(sourceCache, scope, 'indexes', index, hash(item.id), 'SKILL.md');
          const stub = await readFile(path, 'utf8');
          const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(stub);
          const name = frontmatter && parseYaml(frontmatter[1])?.name;
          if (name === canonical.replace(/[^a-z0-9-]/g, '-')) names.add(name);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    assert.equal(names.size, 1, 'Actual source metadata record must provide one native host Skill name');
    nativeName = [...names][0];
    }
    manifest.selection = { pageId: item.id, name: item.name, alias: item.alias, canonical, defaultContext: item.default_context, nativeName: nativeName ?? null, derivation: coldDollar ? 'installed companion query candidate; native catalog not required for explicit dollar selection' : 'installed companion query candidate plus actual daily source metadata index', snapshotId: read.snapshot_id, scope: read.scope, readBytes: Buffer.byteLength(read.content), readSha256: hash(read.content), bodySha256: hash(body), bodyBytes: Buffer.byteLength(body), bodySource: 'selected pinned portable export', coverage: listed.coverage, freshness: { list: listed.freshness, read: read.freshness } };
    manifest.selection.invocation = selection;
    await save(join(base, 'installed-query.json'), { queryPath: query, querySha256: hash(await readFile(query)), selected: matching[0], candidateCount: response.items.length });
    manifest.files.push('installed-query.json');
    if (lifecycle) await save(expectationFile, { body });
  }); }
  if (!lifecycle) await pinSelection();
  await stage('owned-native-host-startup', async () => {
    const copied = join(base, 'daily-companion');
    await cp(daily.companion, copied, { recursive: true, dereference: true });
    const copiedFiles = await inventory(copied);
    assert.deepEqual(copiedFiles, manifest.installation.companionFiles, 'Copied companion must exactly match the daily installed code');
    manifest.installation.copiedCompanion = copied;
    const observer = join(base, 'observe.mjs');
    const settings = { body, entry: manifest.export?.entry ?? '', output: observations, expectedModel: model, fake: mode === 'captured', invocation, page, cache, home: homedir(), alias: manifest.selection.alias, canonical, mainPath: manifest.export ? relative(manifest.export.output, manifest.export.entry) : 'SKILL.md', exportFiles: manifest.export?.files ?? [], ...(lifecycle ? { expectationFile } : {}) };
    await writeFile(observer, `import * as fs from 'node:fs';\nimport * as crypto from 'node:crypto';\nimport * as path from 'node:path';\nexport default function(api) { (${observe.toString()})(api, {...${JSON.stringify(settings)}, fs, crypto, path}); }\n`, { mode: 0o600 });
    const launchArgs = ['omp', '--no-title', '--tools', mode === 'model' ? 'read,glob' : 'read', '--session-dir', sessions, '-e', observer, '--model', model];
    launchArgs.push('--smol', model, '--slow', model, '--plan', model);
    launcher = join(base, 'start.sh');
    await writeFile(launcher, `#!/bin/sh\nexport PI_CODING_AGENT_DIR=${shellQuote(daily.agentDir)}\nexport OMP_CODING_AGENT_DIR=${shellQuote(daily.agentDir)}\nexport CONTEXT_BROKER_CONFIG=${shellQuote(daily.config)}\nexport CONTEXT_BROKER_HOST=omp\nprintf '%s' "$$" > ${shellQuote(activePidFile)}\nexec ${launchArgs.map(shellQuote).join(' ')}\n`, { mode: 0o700 });
    manifest.launch = { args: launchArgs, cwd: base, control: socket, daemonSocket, ternConfigDir: ternDir, sessions, brokerAutoload: true };
    // Remember Not Now in this isolated config before Tern can offer to manage omp.
    await mkdir(join(ternDir, 'omp'), { recursive: true });
    await save(join(ternDir, 'omp/state.json'), { managed: false, checked: 0, no_build: false, offered: true });
    daemon = spawn('tern', ['daemon', '--socket', daemonSocket], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] });
    await own(daemon, 'daemon');
    await until('owned daemon socket', async () => { try { return (await stat(daemonSocket)).isSocket(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } });
    window = spawn('tern', ['--control', socket, '--out', join(base, 'shots'), base], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] });
    await own(window, 'window');
    await until('owned window control socket', async () => { try { return (await stat(socket)).isSocket(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } });
    run('tern', ['plugin', 'install', copied, '--json']);
    const installed = JSON.parse(run('tern', ['plugin', 'list', '--json']));
    assert.ok(installed.plugins.some(plugin => plugin.id === 'context-broker' && plugin.status === 'ready'), 'Daily copied companion must install ready');
    assert.deepEqual(installed.problems, [], 'Isolated plugin installation must have no problems');
    manifest.installation.isolatedPlugins = installed;
    await action('ready');
    await action('run', shellQuote(launcher));
    await until('daily OMP composer', () => editor()?.text === 'What are we cooking?', 60_000);
    if (!lifecycle) await until('observer selects requested model', async () => (await rows(observations)).some(row => row.phase === 'selected' && row.model === model));
    const rect = editor().rect;
    await action('click', String(rect[0] + 100), String(rect[1] + 10));
    await evidence('startup');
  });
  async function submit(label, prompt) {
    const before = (await rows(observations)).length;
    if (prompt) await type(/^\s/.test(prompt) ? prompt : ` ${prompt}`);
    await evidence(`${label}-accepted`);
    await key('enter');
    await until(`${label} complete provider consumption`, async () => {
      const fresh = (await rows(observations)).slice(before);
      if (mode === 'captured') for (const row of fresh.filter(row => row.phase === 'captured_provider' && row.mainContext && row.skillBodies > 0)) assert.equal(row.skillBodies, 1, 'Selections across native slash and dollar must retain exactly one source body');
      const consumed = fresh.some(row => row.phase === (mode === 'captured' ? 'captured_provider' : 'request') && (mode !== 'captured' || row.mainContext) && row.skillBodies > 0 && row.bodySha256 === manifest.selection.bodySha256);
      const responded = fresh.some(row => row.phase === 'assistant' && row.success);
      const network = mode !== 'model' || fresh.some(row => row.phase === 'response' && row.status >= 200 && row.status < 300);
      return consumed && responded && network && fresh.some(row => row.phase === 'agent_end');
    }, mode === 'model' ? 600_000 : 60_000);
    const fresh = (await rows(observations)).slice(before);
    if (mode === 'captured' && coldDollar) {
      const captured = fresh.filter(row => row.phase === 'captured_provider' && row.mainContext);
      assert.equal(captured.length, 1, 'Cold dollar submission must dispatch exactly one main captured provider call');
      assert.equal(captured[0].skillBodies, 1, 'Cold dollar submission must contain the complete selected body exactly once');
      assert.equal(captured[0].bodySha256, manifest.selection.bodySha256, 'Cold dollar body must match the pinned export');
    }
    const toolActions = fresh.filter(row => ['tool_call', 'tool_result', 'tool_blocked'].includes(row.phase));
    const reads = toolActions.filter(row => row.phase === 'tool_result' && row.tool === 'read' && !row.isError);
    const globs = toolActions.filter(row => row.phase === 'tool_result' && row.tool === 'glob' && !row.isError);
    manifest.results[label] = { status: 'passed', invocation: label === 'native-slash' ? 'native' : 'dollar', coldSession: lifecycle ? label !== 'lifecycle-restart-retained' : mode === 'model' || coldDollar, explicitActivation: true, providerBodyObserved: true, successfulAssistantResponse: true, realModel: mode === 'model', observationFrom: before, observationTo: before + fresh.length, autonomousSkillReads: reads.filter(row => row.skillBodies > 0).length, successfulSnapshotReads: reads.length, extraReads: { mainEntry: reads.filter(row => row.kind === 'main_entry').length, metadata: reads.filter(row => row.kind === 'metadata').length, resource: reads.filter(row => row.kind === 'resource').length, directory: reads.filter(row => row.kind === 'directory').length }, successfulSnapshotGlobs: globs.length, blockedToolCalls: toolActions.filter(row => row.phase === 'tool_blocked').length, toolActions, interpretation: 'Additional reads and globs are observations; resource tasks may legitimately use snapshot files' };
    await until('idle composer', () => editor()?.text === 'What are we cooking?', 30_000);
    await evidence(`${label}-response`);
  }
  if (lifecycle) {
    const providerRows = async () => (await rows(observations)).filter(row => row.phase === 'captured_provider' && row.mainContext);
    const selectedRows = async () => (await rows(observations)).filter(row => ['selected', 'session_switch'].includes(row.phase));
    async function capsuleCase(label, first = false) {
      manifest.lifecycle.requiredCases[label] = { status: 'running' };
      await stage(label, async () => {
        const before = (await providerRows()).length;
        if (first) {
          assert.equal(before, 0, 'First input must precede any provider turn');
          assert.ok(!(await rows(metadataEvents)).some(row => row.phase === 'list_success'), 'First input must precede successful source metadata');
        }
        // Do not wait for session_start: metadata discovery must not be a composer readiness prerequisite.
        await type(first ? "$" : `$${selection.slice(0, -1)}`);
        await evidence(`${label}-early-draft`);
        if (first) {
          assert.equal(editor()?.text, "$", 'One bare dollar must be visible before source readiness');
          assert.ok(!(await rows(metadataEvents)).some(row => row.phase === 'list_success'), 'No metadata success before early draft receipt');
          await until('controlled source waiting behind gate', async () => (await rows(metadataEvents)).some(row => row.phase === 'list_waiting'));
          manifest.lifecycle.firstInputAt = new Date().toISOString();
          await writeFile(metadataGate, manifest.lifecycle.firstInputAt, { mode: 0o600 });
          await until('controlled source list success', async () => (await rows(metadataEvents)).some(row => row.phase === 'list_success'), 120_000);
          await until('first bare dollar opens actual candidates', () => ctl('tree', '.sf-overlay .sf-item').nodes.some(node => node.rect?.[2] > 0 && node.rect?.[3] > 0 && node.text?.includes('[skill]')), 60_000);
          await evidence(`${label}-bare-dollar-menu`);
          manifest.lifecycle.firstBareDollarMenu = true;
          await type(selection.slice(0, -1));
        }
        try {
          await until(`${label} actual dollar menu`, () => ctl('tree', '.sf-overlay .sf-item').nodes.some(node => node.rect?.[2] > 0 && node.rect?.[3] > 0 && node.text?.includes(`$${selection}`) && node.text.includes('[skill]')), 60_000);
        } catch (error) { await evidence(`${label}-no-menu`); throw error; }
        await until(`${label} selected exact source`, async () => {
          if (ctl('tree', '.sf-overlay .sf-item.sel').nodes.some(node => node.text?.includes(`$${selection}`) && node.text.includes('[skill]'))) return true;
          await key('down');
          return false;
        });
        await evidence(`${label}-menu`);
        await key('tab');
        const accepted = () => editor()?.text?.replace(/\uf0eb\s*/g, '').trim() === `$${selection}`
          && ctl('tree', '.sf-editor .sf-t-strong').nodes.some(node => node.text === `$${selection}` && node.rect?.[2] > 0 && node.rect?.[3] > 0);
        await until(`${label} accepted capsule`, accepted);
        await evidence(`${label}-capsule`);
        assert.equal((await providerRows()).length, before, 'Accepted capsule must dispatch provider+0');
        if (first) await pinSelection();
        assert.ok(accepted(), 'Exact capsule must remain accepted until submit');
        assert.equal((await providerRows()).length, before, 'Pinned expectation must not submit the accepted capsule');
        await submit(label, ' Apply the selected Skill.');
        const captured = (await providerRows()).at(-1);
        const session = (await selectedRows()).at(-1);
        manifest.lifecycle.cases.push({ label, pid: captured.pid, sessionFile: session?.sessionFile ?? null, userMessages: captured.userMessages, assistantMessages: captured.assistantMessages, selection, sourceId: source.id, recordId: `notion_page:${refMatch[1]}`, acceptedProviderDelta: 0, bodyCount: captured.skillBodies, bodySha256: captured.bodySha256 });
        manifest.lifecycle.requiredCases[label] = { status: 'passed', result: label };
      });
    }
    await capsuleCase('lifecycle-cold-first-input', true);
    const initial = (await selectedRows()).at(-1);
    await stage('lifecycle-new-command', async () => {
      const before = (await selectedRows()).length;
      await draft('/new'); await key('enter');
      await until('/new selects a new session', async () => (await selectedRows()).length > before && (await selectedRows()).at(-1).phase === 'session_switch' && (await selectedRows()).at(-1).reason === 'new');
      const current = (await selectedRows()).at(-1);
      assert.equal(current.pid, initial.pid, '/new must stay in the same OMP process');
      assert.ok(current.sessionFile && initial.sessionFile && current.sessionFile !== initial.sessionFile, '/new must create a different conversation');
      await until('/new idle composer', () => editor()?.text === 'What are we cooking?');
    });
    await capsuleCase('lifecycle-new-session');
    assert.equal(manifest.lifecycle.cases.at(-1).userMessages, 1, '/new must not retain the earlier user turn');
    const retained = (await selectedRows()).at(-1);
    await stage('lifecycle-restart-command', async () => {
      const before = (await selectedRows()).length;
      await draft('/restart'); await key('enter');
      await until('/restart reselects retained session', async () => (await selectedRows()).length > before, 60_000);
      const current = (await selectedRows()).at(-1);
      assert.equal(current.sessionFile, retained.sessionFile, '/restart must retain the conversation file');
      await until('/restart idle composer', () => editor()?.text === 'What are we cooking?');
    });
    await capsuleCase('lifecycle-restart-retained');
    assert.equal(manifest.lifecycle.cases.at(-1).userMessages, 2, '/restart must retain the preceding user turn');
    assert.ok(manifest.lifecycle.cases.at(-1).assistantMessages >= 1, '/restart must retain the preceding assistant turn');
    await stage('lifecycle-new-process-without-restart', async () => {
      const prior = (await selectedRows()).at(-1);
      await draft('/quit'); await key('enter');
      await until('previous owned OMP exits', () => { try { process.kill(prior.pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } });
      manifest.lifecycle.exitedPid = prior.pid;
      manifest.lifecycle.freshProcessPrior = prior;
      await action('run', shellQuote(launcher));
      await until('fresh process composer', () => editor()?.text === 'What are we cooking?', 60_000);
      const rect = editor().rect;
      await action('click', String(rect[0] + 100), String(rect[1] + 10));
    });
    await capsuleCase('lifecycle-fresh-process');
    assert.equal(manifest.lifecycle.cases.at(-1).userMessages, 1, 'Fresh process must have no prior conversation turns');
    assert.notEqual(manifest.lifecycle.cases.at(-1).pid, manifest.lifecycle.freshProcessPrior.pid, 'Final case requires an actual new OMP process');
    assert.notEqual((await selectedRows()).at(-1).sessionFile, manifest.lifecycle.freshProcessPrior.sessionFile, 'Final process must not resume the retained conversation');
    manifest.lifecycle.metadata = await rows(metadataEvents);
  } else {
  if (!coldDollar) {
  await stage('native-slash-menu-selection-and-submission', async () => {
    const full = `/skill:${nativeName}`;
    await draft('/');
    await until('native command menu opens', () => ctl('tree', '.sf-overlay .sf-item').nodes.length > 0);
    await type('skill:');
    await until('actual native slash Skill candidate', () => ctl('tree', '.sf-overlay .sf-item').nodes.some(node => node.rect?.[2] > 0 && node.rect?.[3] > 0 && node.text?.includes(nativeName)));
    await evidence('slash-menu');
    await until('native slash target selected in menu', async () => {
      const selected = ctl('tree', '.sf-overlay .sf-item.sel').nodes;
      if (selected.some(node => node.text?.includes(nativeName))) return true;
      await key('down');
      return false;
    });
    await key('tab');
    await until('native slash menu accepted target', () => {
      if (editor()?.text?.trim() === full) return true;
      const tree = ctl('tree');
      const acceptedEditor = nodes(tree).find(node => typeof node.class === 'string' && node.class.split(' ').includes('sf-editor'));
      const rendered = nodes(acceptedEditor);
      return rendered.some(node => typeof node.class === 'string' && node.class.split(' ').includes('sf-t-icon') && node.text === '\uf0eb')
        && rendered.some(node => typeof node.class === 'string' && node.class.split(' ').includes('sf-t-strong') && node.text === nativeName);
    });
    await submit('native-slash', mode === 'model' ? options['model-prompt'] : ' Read and apply the selected Skill instructions.');
  });
  } else manifest.results['native-slash'] = { status: 'not_run', reason: 'Dollar-only invocation starts cold without native slash or selected-View prerequisites' };
  if (mode === 'captured' || invocation === 'dollar') {
    await stage(coldDollar ? `cold-automatic-dollar-capsule-and-${mode}-submission` : 'automatic-dollar-capsule-and-captured-submission', async () => {
      const beforeSelection = (await rows(observations)).filter(row => ['request', 'captured_provider'].includes(row.phase)).length;
      if (coldDollar) assert.ok(!(await rows(observations)).some(row => ['request', 'captured_provider', 'assistant', 'agent_end'].includes(row.phase)), 'Cold dollar invocation must be the first submitted turn in the owned session');
      await draft('$');
      await until('first bare dollar opens actual candidates', () => ctl('tree', '.sf-overlay .sf-item').nodes.some(node => node.rect?.[2] > 0 && node.rect?.[3] > 0 && node.text?.includes('[skill]')));
      await evidence('first-dollar-menu');
      manifest.results['first-dollar-menu'] = { status: 'passed', input: '$', retyped: false };
      await type(selection.slice(0, -1));
      await until('actual dollar candidate', () => ctl('tree', '.sf-overlay .sf-item').nodes.some(node => node.rect?.[2] > 0 && node.rect?.[3] > 0 && node.text?.includes(`$${selection}`) && node.text.includes('[skill]')));
      await until('dollar target selected in menu', async () => {
        if (ctl('tree', '.sf-overlay .sf-item.sel').nodes.some(node => node.text?.includes(`$${selection}`) && node.text.includes('[skill]'))) return true;
        await key('down');
        return false;
      });
      await evidence('automatic-dollar-menu');
      await key('tab');
      await until('accepted source capsule', () => editor()?.text?.replace(/\uf0eb\s*/g, '').trim() === `$${selection}`
        && ctl('tree', '.sf-editor .sf-t-strong').nodes.some(node => node.text === `$${selection}` && node.rect?.[2] > 0 && node.rect?.[3] > 0));
      await evidence('automatic-dollar-selection');
      const afterSelection = (await rows(observations)).filter(row => ['request', 'captured_provider'].includes(row.phase)).length;
      assert.equal(afterSelection, beforeSelection, 'Dollar menu selection must not submit or dispatch a provider request');
      manifest.results['dollar-selection'] = { status: 'passed', acceptedChip: true, submitted: false, providerEventsBefore: beforeSelection, providerEventsAfter: afterSelection };
      await submit('automatic-dollar', mode === 'model' ? options['model-prompt'] : ' Apply the selected Skill.');
    });
  } else manifest.results['automatic-dollar'] = { status: 'not_run', reason: 'Model mode selected native invocation' };
  if (mode === 'captured' && !coldDollar) {
    await stage('manual-search-selection-and-captured-submission', async () => {
      await draft(`前文😀$${selection.slice(0, -1)} tail`);
      for (let index = 0; index < 5; index++) await key('left');
      await key('escape');
      const before = (await rows(observations)).filter(row => row.phase === 'captured_provider').length;
      await key('ctrl+alt+shift+k');
      await until('manual native picker', () => ctl('tree', 'input').nodes.some(node => node.placeholder === 'Search Context Broker content (insert token only)'));
      await type(selection);
      await until('manual search target', () => nodes(ctl('tree')).some(node => {
        if (!node.class?.split(' ').includes('ck-item') || node['aria-selected'] !== 'true') return false;
        const rendered = texts(node);
        return rendered.includes(selection) && rendered.some(text => text.includes('[skill]'));
      }));
      await evidence('manual-search');
      await key('enter');
      await until('manual selection replaces Unicode draft', () => editor()?.text?.replace(/\uf0eb\s*/g, '') === `前文😀$${selection} tail`);
      assert.equal((await rows(observations)).filter(row => row.phase === 'captured_provider').length, before, 'Manual selection must not submit a provider request');
      await submit('manual-dollar', ' Apply the selected Skill.');
    });
  } else {
    manifest.results['manual-dollar'] = { status: 'not_run', reason: coldDollar ? 'Dollar-only invocation covers cold automatic completion, not manual search' : 'Model mode submits only the selected invocation; manual search is exercised by default captured mode' };
  }
  }
  manifest.status = 'passed';
} catch (error) {
  failure = error;
  manifest.status = 'failed';
  manifest.error = sanitize(error.message);
  if (lifecycle && manifest.lifecycle) for (const [label, receipt] of Object.entries(manifest.lifecycle.requiredCases)) {
    if (receipt.status === 'running') manifest.lifecycle.requiredCases[label] = { status: 'failed', error: manifest.error };
    else if (receipt.status === 'not_run') receipt.reason = 'Earlier lifecycle stage failed';
  }
  try { await evidence('failure'); }
  catch (captureError) { await save(join(base, 'failure-capture.json'), { error: manifest.error, captureError: sanitize(captureError.message) }); }
} finally {
  const cleanup = { startedAt: new Date().toISOString(), status: 'running', processes: [], evidencePreserved: true, remoteWrites: false };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  const ompOwners = [];
  if (lifecycle) {
    try {
      const pid = Number(await readFile(activePidFile, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 1 && alive(pid)) {
        const identity = spawnSync('ps', ['-p', String(pid), '-o', 'pgid=', '-o', 'command='], { encoding: 'utf8' });
        const match = /^\s*(\d+)\s+([\s\S]*)$/.exec(identity.stdout ?? '');
        assert.ok(identity.status === 0 && match && match[2].includes(join(base, 'observe.mjs')), 'Cleanup must verify exact owned OMP command before signaling');
        ompOwners.push({ role: 'omp', pid, pgid: Number(match[1]), processGroupOwned: Number(match[1]) === pid });
      }
    } catch (error) { if (error.code !== 'ENOENT') cleanup.processes.push({ role: 'omp-identity', stopped: false, error: sanitize(error.message) }); }
  }
  try { if (window && window.exitCode === null && window.signalCode === null) await action('quit'); } catch {}
  for (const receipt of [...owned].reverse()) {
    let error;
    try { await stop(receipt.child); } catch (cause) { error = sanitize(cause.message); }
    cleanup.processes.push({ role: receipt.role, pid: receipt.pid, exitCode: receipt.child.exitCode, signal: receipt.child.signalCode, stopped: receipt.child.exitCode !== null || receipt.child.signalCode !== null, ...(error ? { error } : {}) });
  }
  for (const receipt of ompOwners) {
    let error;
    try {
      const target = receipt.processGroupOwned ? -receipt.pgid : receipt.pid;
      if (alive(receipt.pid)) process.kill(target, 'SIGTERM');
      for (let attempt = 0; attempt < 20 && alive(receipt.pid); attempt++) await pause(100);
      if (alive(receipt.pid)) process.kill(target, 'SIGKILL');
      for (let attempt = 0; attempt < 30 && alive(receipt.pid); attempt++) await pause(100);
    } catch (cause) { if (cause.code !== 'ESRCH') error = sanitize(cause.message); }
    cleanup.processes.push({ ...receipt, stopped: !alive(receipt.pid), ...(error ? { error } : {}) });
  }
  if (lifecycle) for (const pid of new Set((await rows(metadataEvents)).map(row => row.pid))) {
    let error;
    try {
      if (alive(pid)) {
        const identity = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
        assert.ok(identity.status === 0 && identity.stdout.includes(join(base, 'metadata-transport.mjs')), 'Cleanup must verify owned metadata proxy identity');
        process.kill(pid, 'SIGTERM');
        for (let attempt = 0; attempt < 20 && alive(pid); attempt++) await pause(100);
        if (alive(pid)) process.kill(pid, 'SIGKILL');
        for (let attempt = 0; attempt < 20 && alive(pid); attempt++) await pause(100);
      }
    } catch (cause) { if (cause.code !== 'ESRCH') error = sanitize(cause.message); }
    cleanup.processes.push({ role: 'metadata-transport', pid, stopped: !alive(pid), ...(error ? { error } : {}) });
  }
  cleanup.status = cleanup.processes.every(receipt => receipt.stopped && !receipt.error) ? 'stopped' : 'failed';
  cleanup.finishedAt = new Date().toISOString();
  if (cleanup.status === 'failed') { manifest.status = 'failed'; manifest.cleanupError = 'Owned process cleanup failed'; }
  await save(join(base, 'cleanup.json'), cleanup);
  manifest.finishedAt = new Date().toISOString();
  await save(join(base, 'manifest.json'), manifest);
  console.log(JSON.stringify({ status: manifest.status, mode, invocation, evidence: base, error: manifest.error, cleanup: cleanup.status }, null, 2));
  if (failure || manifest.status !== 'passed') process.exitCode = 1;
}
