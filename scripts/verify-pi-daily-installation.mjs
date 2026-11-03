import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';

// The run action is deliberately explicit. Merely importing/checking this file
// or generating a plan never launches Pi or changes the daily installation.
const hash = value => createHash('sha256').update(value).digest('hex');
const { parse: parseYaml } = createRequire(new URL('../packages/context-broker/package.json', import.meta.url))('yaml');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const pause = ms => new Promise(accept => setTimeout(accept, ms));
const exists = path => access(path).then(() => true, () => false);
const fileIdentity = async path => { const bytes = await readFile(path); return { path, realpath: await realpath(path), bytes: bytes.length, sha256: hash(bytes) }; };
const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const inside = (root, path) => { const local = relative(root, path); return local === '' || (!local.startsWith('..' + sep) && local !== '..' && !isAbsolute(local)); };

function plan(config) {
  return {
    version: 1, kind: 'pi-daily-installation-metadata-only', status: 'prepared_not_executed',
    settings: join(homedir(), '.pi/agent/settings.json'), expected_package_index: config.packageIndex ?? 1,
    expected_package_count: config.packageCount ?? 21, broker_root: config.brokerRoot ?? null,
    cli_root: config.cliRoot ?? null, required_artifacts: ['brokerRoot', 'brokerArchive', 'brokerArchiveSha256', 'embeddedCliSha256', 'cliRoot', 'cliArchive', 'cliArchiveSha256', 'cliEntrySha256'],
    pi_arguments: ['--mode', 'rpc', '--session-dir', '<new owned directory>'],
    rpc_commands: ['get_state', 'get_commands', '/context-broker find ' + (config.findQuery ?? 'pstack'), '/context-broker doctor', 'get_state'],
    observation: 'Actual get_commands.sourceInfo, published-file SHA closure, passive child_process spawn/exit and fetch metadata in the owned process tree. No source.command substitution or target -e argument.',
    preserved: ['HOME and normal agent directory', 'all settings packages and extensions', 'source/auth/model configuration', 'existing sessions', 'PATH and source.command'],
    forbidden: ['provider or tool execution', 'current body loading', 'remote writes', 'official ntn invocation', 'Tern execution', 'user-session restart'],
    execution: 'Run only after root activates the final immutable package and CLI shim. Supply final package paths/hashes; run refuses an old settings package before launching Pi.',
  };
}

// This recorder observes the real child and HTTP calls without replacing any
// arguments, configuration, response bodies, or source command. It reads no
// credential files and never logs environment values, headers, or raw payloads.
function installPassiveObserver(config) {
  const fs = require('node:fs');
  const cp = require('node:child_process');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const file = path.join(config.directory, `observer-${process.pid}.jsonl`);
  const write = value => fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...value }) + '\n', { mode: 0o600 });
  const canonical = value => { try { return fs.realpathSync(value); } catch { return undefined; } };
  const entry = typeof process.argv[1] === 'string' ? process.argv[1] : undefined;
  write({ event: 'process_start', ppid: process.ppid, executable: process.execPath, entry, real_entry: entry ? canonical(entry) : undefined, entry_sha256: entry && canonical(entry) === config.cliEntry ? digest(fs.readFileSync(entry)) : undefined });
  process.once('exit', code => write({ event: 'process_exit', code }));
  const nativeSpawn = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function(options) {
    const result = Reflect.apply(nativeSpawn, this, [options]);
    const args = options.args ?? [];
    const script = typeof args[1] === 'string' && path.isAbsolute(args[1]) && /\.[cm]?[jt]s$/u.test(args[1]) ? args[1] : undefined;
    const actual = script ? canonical(script) : undefined;
    const bundled = actual === config.cliEntry;
    const safeArgs = bundled ? args.slice(2).map(value => /^(?:--[a-z-]+|list|views|ctl|doctor|cache|identity|[0-9a-f-]{32,36}|[0-9]+(?:ms|s|m|h)?)$/u.test(value) ? value : '[unrecorded-argument]') : undefined;
    const meta = { child_pid: this.pid, executable: options.file, script, real_script: actual, bundled_cli: bundled, ...(bundled ? { cli_args: safeArgs, script_sha256: digest(fs.readFileSync(script)) } : {}) };
    write({ event: 'spawn', ...meta });
    const output = [];
    let outputBytes = 0;
    if (bundled && this.stdout) this.stdout.on('data', chunk => { outputBytes += chunk.length; if (outputBytes <= 16 * 1024 * 1024) output.push(Buffer.from(chunk)); });
    this.once('error', error => write({ event: 'spawn_error', ...meta, code: error.code }));
    this.once('close', (code, signal) => {
      let receipt;
      if (bundled && outputBytes <= 16 * 1024 * 1024) {
        try {
          const value = JSON.parse(Buffer.concat(output).toString('utf8'));
          receipt = { ok: value.ok, error_code: value.error?.code, transport: value.transport, notion_api_version: value.notion_api_version, authentication: ['available', 'missing', 'unavailable'].includes(value.authentication) ? value.authentication : undefined, record_count: Array.isArray(value.records) ? value.records.length : undefined, view_count: Array.isArray(value.views) ? value.views.length : undefined };
        } catch { receipt = { json_parse_failed: true }; }
      }
      write({ event: 'child_close', ...meta, code, signal, ...(bundled ? { stdout_bytes: outputBytes, stdout_sha256: outputBytes <= 16 * 1024 * 1024 ? digest(Buffer.concat(output)) : undefined, receipt } : {}) });
    });
    return result;
  };
  const nativeFetch = globalThis.fetch;
  let sequence = 0;
  if (typeof nativeFetch === 'function') globalThis.fetch = function(...args) {
    const input = args[0], init = args[1];
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    const id = `${process.pid}:${++sequence}`;
    const body = init?.body;
    const requestBytes = typeof body === 'string' ? Buffer.byteLength(body) : body instanceof Uint8Array ? body.byteLength : body == null ? 0 : null;
    write({ event: 'http_start', id, method, origin: url.origin, path: url.pathname, request_bytes: requestBytes });
    return Reflect.apply(nativeFetch, this, args).then(response => {
      write({ event: 'http_end', id, status: response.status });
      return response;
    }, error => {
      write({ event: 'http_error', id, code: error?.code ?? error?.name ?? 'unknown' });
      throw error;
    });
  };
}

async function packageClosure(root, archive, expectedHash) {
  assert.ok(isAbsolute(root) && isAbsolute(archive));
  const canonicalRoot = await realpath(root);
  const archiveIdentity = await fileIdentity(archive);
  assert.equal(archiveIdentity.sha256, expectedHash, 'Final package archive SHA mismatch');
  const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).split('\n').filter(value => value && !value.endsWith('/'));
  const files = [];
  for (const entry of entries) {
    assert.ok(entry.startsWith('package/'));
    const local = entry.slice('package/'.length), path = resolve(root, local);
    assert.ok(inside(root, path), 'Unsafe package member');
    assert.ok(inside(canonicalRoot, await realpath(path)), 'A package member escapes the installed package');
    const packed = execFileSync('tar', ['-xOf', archive, entry], { maxBuffer: 32 * 1024 * 1024 });
    const actual = await fileIdentity(path);
    assert.equal(actual.sha256, hash(packed), `Installed package differs: ${local}`);
    files.push({ path: local, sha256: actual.sha256, bytes: actual.bytes, runtime: /^(?:src|dist)\//u.test(local) || local === 'package.json' });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root, archive: archiveIdentity, file_count: files.length, files, sha256: hash(JSON.stringify(files)) };
}

async function configurationSnapshot(config) {
  const agent = join(homedir(), '.pi/agent'), settingsPath = join(agent, 'settings.json');
  if (process.env.PI_CODING_AGENT_DIR) assert.equal(await realpath(process.env.PI_CODING_AGENT_DIR), await realpath(agent), 'Use the normal daily Pi agent directory');
  assert.ok(!process.env.CONTEXT_BROKER_CONFIG, 'A source configuration override would not verify normal daily settings');
  assert.ok(!process.env.NOTION_API_BASE_URL || process.env.NOTION_API_BASE_URL.replace(/\/$/u, '') === 'https://api.notion.com', 'Daily verification must not target a controlled service');
  const raw = await readFile(settingsPath);
  let settings;
  try { settings = JSON.parse(raw.toString('utf8')); }
  catch { throw new Error('The daily Pi settings cannot be parsed'); }
  assert.equal(settings.packages?.length, config.packageCount ?? 21);
  const index = config.packageIndex ?? 1, selected = settings.packages[index];
  const spec = typeof selected === 'string' ? selected : selected?.source;
  assert.equal(typeof spec, 'string');
  assert.equal(await realpath(spec), await realpath(config.brokerRoot), 'The daily package slot has not been switched to the final Broker');
  const candidates = ['.yml', '.yaml', '.json'].map(ext => join(agent, 'context-broker', 'config' + ext));
  const sourcePath = (await Promise.all(candidates.map(async path => await exists(path) ? path : undefined))).find(Boolean);
  assert.ok(sourcePath, 'The existing daily source configuration is required');
  const sourceBytes = await readFile(sourcePath);
  let parsed;
  try { parsed = parseYaml(sourceBytes.toString('utf8')); }
  catch { throw new Error('The daily Broker source configuration cannot be parsed'); }
  const sources = (parsed.sources ?? []).filter(source => source.type === 'notion' && source.enabled !== false);
  assert.ok(sources.length, 'No enabled Notion source');
  for (const source of sources) {
    assert.ok(source.command === undefined, 'Daily verification must exercise the default bundled CLI');
    assert.ok(source.prefetch === false || source.prefetch === undefined, 'This metadata-only run requires disabled prefetch');
  }
  return {
    settings: { path: settingsPath, sha256: hash(raw), packages: settings.packages.length, selected_index: index, selected_package: spec, other_packages_sha256: hash(JSON.stringify(settings.packages.filter((_, i) => i !== index))) },
    source: { path: sourcePath, sha256: hash(sourceBytes), sources: sources.map(source => ({ id: source.id, type: source.type, database: source.database, default_view_id: source.default_view_id, profile_id: source.profile_id, prefetch: source.prefetch ?? false, command_configured: false })) },
  };
}

async function observedRows(directory) {
  const names = (await readdir(directory)).filter(name => /^observer-[0-9]+\.jsonl$/u.test(name));
  return (await Promise.all(names.map(async name => (await readFile(join(directory, name), 'utf8')).split('\n').filter(Boolean).map(JSON.parse)))).flat();
}
const safeCommand = command => ({ name: command.name, source: command.source, sourceInfo: command.sourceInfo ? { path: command.sourceInfo.path, scope: command.sourceInfo.scope, origin: command.sourceInfo.origin, baseDir: command.sourceInfo.baseDir, source_sha256: hash(String(command.sourceInfo.source)) } : undefined });
const safeState = state => ({ sessionId: state.sessionId, sessionFile: state.sessionFile, messageCount: state.messageCount, isStreaming: state.isStreaming, isCompacting: state.isCompacting });
const notifications = frames => frames.filter(frame => frame.type === 'extension_ui_request' && frame.method === 'notify').flatMap(strings);
const safeDiagnostic = text => ({ sha256: hash(text), bytes: Buffer.byteLength(text), lines: text.split('\n').filter(line => /^(?:Context Broker Doctor|Config:|Path mode:|Log paths:|Scan:|Skill roots:|Discovery catalogs:|Records:|Config diagnostics:|Namespace:|Source [\w-]+: direct Notion API |context-broker find:|\$|\s*(?:kind|source|page|select|path):)/u.test(line)) });

async function run(config) {
  for (const key of ['brokerRoot', 'brokerArchive', 'embeddedCliSha256', 'brokerArchiveSha256', 'cliRoot', 'cliArchive', 'cliArchiveSha256', 'cliEntrySha256', 'evidenceRoot']) assert.equal(typeof config[key], 'string', `Missing final artifact: ${key}`);
  const findQuery = config.findQuery ?? 'pstack';
  assert.ok(typeof findQuery === 'string' && findQuery.length && !/[\r\n]/u.test(findQuery));
  await mkdir(config.evidenceRoot, { recursive: true });
  const evidence = await mkdtemp(join(config.evidenceRoot, 'daily-pi-'));
  const sessions = join(evidence, 'sessions'), cwd = join(evidence, 'workspace'), observerDir = join(evidence, 'observation');
  await Promise.all([sessions, cwd, observerDir].map(path => mkdir(path)));
  const result = { version: 1, kind: 'actual-daily-pi-autoload-metadata', status: 'running', evidence, plan: plan(config), modifications: { user_settings: 0, source_config: 0, harness_model_credential_files_read: 0, old_sessions_read: 0, target_extensions_injected: 0, source_command_overrides: 0 }, phases: [] };
  let rpc, before, broker;
  try {
    before = await configurationSnapshot(config);
    broker = await packageClosure(config.brokerRoot, config.brokerArchive, config.brokerArchiveSha256);
    const cli = await packageClosure(config.cliRoot, config.cliArchive, config.cliArchiveSha256);
    await save(join(evidence, 'installed-broker-files.json'), broker); await save(join(evidence, 'installed-cli-files.json'), cli);
    const embedded = await fileIdentity(join(config.brokerRoot, 'dist/ntn-skills.mjs'));
    assert.equal(embedded.sha256, config.embeddedCliSha256);
    const standalone = await fileIdentity(join(config.cliRoot, 'dist/ntn-skills.js'));
    assert.equal(standalone.sha256, config.cliEntrySha256);
    const shim = await fileIdentity(config.cliShim ?? join(homedir(), '.local/bin/ntn-skills'));
    const shimReferencesFinalCli = inside(await realpath(config.cliRoot), shim.realpath) || (await readFile(shim.path, 'utf8')).includes(standalone.path);
    assert.ok(shimReferencesFinalCli, 'The daily CLI shim has not been switched to the final CLI');
    result.artifacts = { broker: { root: broker.root, archive_sha256: broker.archive.sha256, published_files: broker.file_count, files_sha256: broker.sha256 }, embedded, standalone, cli_shim: { ...shim, references_final_cli: shimReferencesFinalCli, executed_by_harness: false } };
    result.configuration_before = before;
    const host = await resolveHost('pi'); result.host = host;
    assert.ok(host.identity.includes('/@earendil-works/pi-coding-agent/'), 'The daily host must be actual Pi');
    const preload = join(evidence, 'observe-process.cjs');
    await writeFile(preload, `(${installPassiveObserver.toString()})(${JSON.stringify({ directory: observerDir, cliEntry: embedded.realpath })});\n`, { mode: 0o600 });
    const processLedger = join(evidence, 'owned-processes.jsonl');
    await writeFile(processLedger, '', { flag: 'wx', mode: 0o600 });
    const env = { ...process.env, BROKER_E2E_PROCESS_LEDGER: processLedger, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require=' + JSON.stringify(preload)].filter(Boolean).join(' ') };
    const args = ['--session-dir', sessions];
    result.launch = { host: 'pi', cwd, args: ['--mode', 'rpc', ...args], normal_user_settings: true, preexisting_node_options_preserved: Boolean(process.env.NODE_OPTIONS), observer_sha256: hash(await readFile(preload)) };
    await save(join(evidence, 'result.json'), result);
    rpc = await startRpc({ host: 'pi', cwd, env, args, timeoutMs: 120000 });
    const initial = safeState(await rpc.command('get_state'));
    assert.ok(initial.sessionId && !initial.isStreaming && !initial.isCompacting);
    if (initial.sessionFile) assert.ok(inside(sessions, resolve(initial.sessionFile)), 'Only the new owned session may be used');
    result.initial_session = initial;
    const commands = (await rpc.command('get_commands')).commands.map(safeCommand);
    await save(join(evidence, 'registered-commands.json'), { commands });
    const registrations = commands.filter(command => command.name === 'context-broker');
    assert.equal(registrations.length, 1, 'Exactly one actual context-broker command must be registered');
    const registered = registrations[0];
    assert.equal(registered.source, 'extension');
    const loadedEntry = await fileIdentity(registered.sourceInfo.path);
    assert.ok(inside(await realpath(config.brokerRoot), loadedEntry.realpath), 'The actual registered Broker came from a different package');
    const member = broker.files.find(file => resolve(config.brokerRoot, file.path) === loadedEntry.path);
    assert.ok(member && member.sha256 === loadedEntry.sha256);
    result.autoload = { registration: registered, actual_entry: loadedEntry, injected_by_cli: false };
    for (const message of ['/context-broker find ' + findQuery, '/context-broker doctor']) {
      const start = rpc.frames.length;
      const acknowledgment = await rpc.command('prompt', { message });
      assert.equal(acknowledgment?.disposition, 'handled', 'A metadata slash command must never dispatch to the model');
      const reports = notifications(rpc.frames.slice(start)).filter(text => /^(?:context-broker find:|Context Broker Doctor)/u.test(text));
      assert.ok(reports.length, 'The actual metadata command did not produce its notification');
      if (message.endsWith('doctor')) {
        assert.ok(reports.some(text => text.includes('direct Notion API 2026-03-11, authentication available')));
        assert.ok(reports.every(text => !text.includes('Config diagnostics: failed') && !text.includes('Namespace: failed')));
      }
      result.phases.push({ command: message, disposition: acknowledgment.disposition, diagnostics: reports.map(safeDiagnostic) });
    }
    const final = safeState(await rpc.command('get_state'));
    assert.equal(final.sessionId, initial.sessionId); assert.equal(final.isStreaming, false); assert.equal(final.isCompacting, false);
    result.final_session = final;
    assert.equal(rpc.frames.filter(frame => ['agent_start', 'tool_execution_start'].includes(frame.type) || frame.type === 'message_start' && frame.message?.role === 'assistant').length, 0, 'Metadata verification must not invoke provider or tools');
    result.rpc_frame_counts = Object.fromEntries([...new Set(rpc.frames.map(frame => frame.type))].map(type => [type, rpc.frames.filter(frame => frame.type === type).length]));
    await rpc.closeInput(); rpc = undefined;
    const observed = await observedRows(observerDir);
    const spawned = observed.filter(row => row.event === 'spawn' && row.bundled_cli);
    assert.ok(spawned.length, 'No actual bundled CLI child was observed');
    for (const child of spawned) {
      assert.equal(child.real_script, embedded.realpath); assert.equal(child.script_sha256, embedded.sha256);
      const closed = observed.find(row => row.event === 'child_close' && row.pid === child.pid && row.child_pid === child.child_pid);
      assert.ok(closed && closed.code === 0 && !closed.signal, 'Every observed bundled CLI must finish successfully');
      assert.ok(['list', 'views'].includes(child.cli_args[0]) || child.cli_args[0] === 'ctl' && (child.cli_args[1] === 'doctor' || child.cli_args[1] === 'cache' && child.cli_args[2] === 'identity'), 'A non-metadata CLI command ran');
      assert.ok(observed.some(row => row.event === 'process_start' && row.pid === child.child_pid && row.real_entry === embedded.realpath && row.entry_sha256 === embedded.sha256), 'The real CLI child did not independently observe its installed entry');
    }
    const doctor = observed.find(row => row.event === 'child_close' && row.bundled_cli && row.cli_args[0] === 'ctl' && row.cli_args[1] === 'doctor' && row.receipt?.ok === true && row.receipt.transport === 'direct_http' && row.receipt.notion_api_version === '2026-03-11');
    assert.ok(doctor, 'No actual successful direct-HTTP doctor receipt');
    const http = observed.filter(row => row.event === 'http_start');
    assert.ok(http.length, 'No real HTTP metadata request was observed');
    for (const request of http) {
      assert.equal(request.origin, 'https://api.notion.com', 'Unexpected provider/external HTTP during metadata verification');
      const readonly = ['GET', 'HEAD'].includes(request.method) || request.method === 'POST' && (/^\/v1\/(?:data_sources|databases)\/[^/]+\/query$/u.test(request.path) || /^\/v1\/views\/[^/]+\/queries$/u.test(request.path) || request.path === '/v1/search');
      assert.ok(readonly && !/\/(?:markdown|children)$/u.test(request.path), 'A body read or remote mutation was observed');
      assert.ok(observed.some(row => row.event === 'http_end' && row.id === request.id && row.status >= 200 && row.status < 400), 'An observed metadata request did not complete successfully');
    }
    assert.ok(!observed.some(row => row.event === 'spawn' && basename(row.executable ?? '') === 'ntn'), 'Official ntn was invoked');
    result.actual_default_cli = { entry: embedded.realpath, sha256: embedded.sha256, processes: spawned.map(row => ({ parent_pid: row.pid, pid: row.child_pid, executable: row.executable, script: row.script, args: row.cli_args })), doctor: doctor.receipt, source_command_overridden: false, path_cli_used_for_default_source: false };
    result.metadata_http_requests = http.length; result.provider_invocations = 0; result.tool_invocations = 0; result.remote_mutations = 0; result.current_body_reads = 0;
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.error = { code: error.code ?? 'DAILY_VERIFICATION_FAILED', message: error.message };
  } finally {
    if (rpc) await rpc.stop().catch(error => { result.shutdown_error = error.message; });
    if (before) {
      result.configuration_after = await configurationSnapshot(config).catch(() => ({ validation_failed: true }));
      if (JSON.stringify(before) !== JSON.stringify(result.configuration_after)) { result.status = 'failed'; result.configuration_unchanged = false; }
      else result.configuration_unchanged = true;
    }
    if (broker) {
      result.broker_files_unchanged = (await Promise.all(broker.files.map(async file => hash(await readFile(join(broker.root, file.path))) === file.sha256))).every(Boolean);
      if (!result.broker_files_unchanged) result.status = 'failed';
    }
    if (result.artifacts?.cli_shim) {
      result.cli_shim_unchanged = hash(await readFile(result.artifacts.cli_shim.path)) === result.artifacts.cli_shim.sha256;
      if (!result.cli_shim_unchanged) result.status = 'failed';
    }
    const ownedPath = join(evidence, 'owned-processes.jsonl');
    if (await exists(ownedPath)) {
      const owned = (await readFile(ownedPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
      result.owned_pi = owned.filter(row => row.event === 'spawn').map(row => ({ pid: row.pid, file: row.file, args: row.args, cwd: row.cwd, observed_close: owned.some(end => end.event === 'close' && end.pid === row.pid && end.observedExit) }));
      if (result.owned_pi.some(row => !row.observed_close)) result.status = 'failed';
    }
    await save(join(evidence, 'result.json'), result);
  }
  return result;
}

const [action, flag, input, ...extra] = process.argv.slice(2);
assert.ok(['plan', 'run'].includes(action) && flag === '--config' && input && !extra.length, 'Usage: node scripts/verify-pi-daily-installation.mjs plan|run --config ABSOLUTE_CONFIG.json');
const config = await json(resolve(input));
assert.equal(config.version, 1);
if (action === 'plan') console.log(JSON.stringify(plan(config), null, 2));
else {
  const result = await run(config);
  console.log(JSON.stringify({ status: result.status, evidence: result.evidence, error: result.error }));
  if (result.status !== 'passed') process.exitCode = 1;
}
