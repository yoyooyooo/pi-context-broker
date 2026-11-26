import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { sourceObserverPreloadSource, readSourceObservation } from './skill-consumption-source-observer.mjs';
import { verifyNextWorktreePair } from './verify-next-worktrees.mjs';
import { verifyArchiveInstallation as packageClosure } from './verify-package-closure.mjs';
import { dailyObserverPreloadSource, observedDailyHostProcess, observedRows, ownedPiProcesses, validateDailyHostProcess } from './pi-host-observation.mjs';
export { dailyObserverPreloadSource, observedDailyHostProcess, observedRows, ownedPiProcesses, validateDailyHostProcess } from './pi-host-observation.mjs';

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
const rootId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
function expectedLibrary(config) {
  assert.ok(rootId(config.library), 'Bind daily verification to one canonical Library root UUID');
  return config.library;
}

function plan(config) {
  return {
    version: 2, kind: 'pi-daily-installation-readonly-diagnostics', status: 'prepared_not_executed', delivery: config.delivery ?? null,
    settings: join(homedir(), '.pi/agent/settings.json'), expected_package_index: config.packageIndex ?? 1,
    expected_package_count: config.packageCount ?? 21, broker_root: config.brokerRoot ?? null,
    cli_root: config.cliRoot ?? null, library: config.library ?? null, next_worktrees: config.worktrees ?? null, required_artifacts: ['delivery', 'library', 'brokerRoot', 'brokerArchive', 'brokerArchiveSha256', 'embeddedCliSha256', 'embeddedSdkSha256', 'cliRoot', 'cliArchive', 'cliArchiveSha256', 'cliEntrySha256'],
    cli_lookup: { selection: 'ntn-skills on the unchanged PATH', expected_path: config.cliShim ?? null, volta_identity: config.voltaIdentity ?? null },
    pi_arguments: ['--mode', 'rpc', '-ns', '--session-dir', '<new owned directory>'],
    rpc_commands: ['get_state', 'get_commands', '/context-broker find ' + (config.findQuery ?? 'pstack'), '/context-broker doctor', 'get_state'],
    expected_find_record: config.expectedFindRecord ?? null,
    reviewed_external_namespace_diagnostics: config.namespaceDiagnosticsReview ?? null,
    observation: 'Actual get_commands.sourceInfo, published-file SHA closure and passive SDK/process/HTTP observation. Every host Notion request and SDK attempt needs an exact independent HTTP match. Only the selected Library root census and its direct table descriptors may precede catalog metadata. Other host HTTP remains unattributed, with failures retained separately. This check does not establish all Pi/plugin HTTP success or zero external traffic. No source.command substitution or target -e argument.',
    preserved: ['HOME and normal agent directory', 'all settings packages and extensions', 'source/auth/model configuration', 'existing sessions', 'PATH and source.command'],
    forbidden: ['provider or tool execution', 'Notion writes or Skill body loading', 'official ntn invocation', 'Tern execution', 'user-session restart'],
    execution: 'Run after both next worktrees are committed, rebuilt and selected by the ordinary daily entries. Bind the same target commits and build bytes on Pro and Mini; the source/build gate precedes a fresh pi -ns process.',
  };
}

function deliveryIntent(config) {
  const delivery = config.delivery;
  assert.ok(delivery && typeof delivery.id === 'string'
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(delivery.id), 'Bind this delivery to one new UUID shared by Pro and Mini');
  const started = Date.parse(delivery.startedAt);
  assert.ok(Number.isFinite(started) && new Date(started).toISOString() === delivery.startedAt && started <= Date.now(),
    'delivery.startedAt must be the UTC start of this delivery, not a future time');
  assert.deepEqual(Object.keys(delivery).sort(), ['id', 'startedAt']);
  return { id: delivery.id, startedAt: delivery.startedAt };
}
function machineIdentity(machine) {
  assert.ok(machine && machine.scheme === 'machine-id-sha256-v1' && ['darwin', 'linux'].includes(machine.platform)
    && /^[a-f0-9]{64}$/.test(machine.sha256), 'A real stable machine fingerprint is required');
  assert.deepEqual(Object.keys(machine).sort(), ['platform', 'scheme', 'sha256']);
  return machine;
}
function buildIdentity(pair) {
  assert.ok(pair && pair.version === 2 && pair.scope === 'next-worktree-source-and-build' && pair.status === 'passed'
    && pair.actual_pi_process === 'not_run', 'Use the current source/build receipt without promoting it to Pi acceptance');
  machineIdentity(pair.machine);
  const identity = {};
  for (const name of ['cli', 'broker']) {
    const source = pair[name];
    assert.ok(source && source.branch === 'next' && /^[a-f0-9]{40}$/.test(source.commit)
      && source.origin_next === source.commit, 'Each target must have matched the real origin/next');
    identity[name] = { commit: source.commit, source_sha256: source.source_sha256, artifacts_sha256: source.artifacts_sha256 };
    if (name === 'broker') identity[name].selected_cli_sha256 = source.selected_cli_sha256;
    for (const [key, value] of Object.entries(identity[name])) if (key !== 'commit') assert.match(value, /^[a-f0-9]{64}$/);
  }
  return identity;
}

function assertCompletedDaily(receipt) {
  assert.ok(receipt && receipt.version === 2 && receipt.kind === 'actual-daily-pi-autoload-and-diagnostics'
    && receipt.scope === 'ordinary-pi-startup-and-metadata' && receipt.status === 'passed',
    'A current passed ordinary-daily receipt is required; plans, candidates and source-only results do not qualify');
}

/** This is the sole completed-daily receipt contract, also used by the producer. */
export function validateDailyReceipt(receipt, config, currentPair) {
  const delivery = deliveryIntent(config);
  const library = expectedLibrary(config);
  assertCompletedDaily(receipt);
  const current = buildIdentity(currentPair);
  for (const name of ['cli', 'broker']) assert.equal(current[name].commit, config.worktrees?.[name]?.commit, 'The declared target differs from the verified current pair');
  assert.deepEqual(receipt.delivery, delivery, 'The daily receipt belongs to another delivery');
  assert.equal(receipt.library, library, 'The daily receipt belongs to another Library');
  const started = Date.parse(receipt.started_at), finished = Date.parse(receipt.finished_at);
  assert.ok(Number.isFinite(started) && Number.isFinite(finished) && started >= Date.parse(delivery.startedAt)
    && finished >= started && finished <= Date.now(), 'A stale or incomplete daily execution cannot close this delivery');
  assert.deepEqual(buildIdentity(receipt.worktrees_before), current, 'The daily receipt uses a different target or build');
  assert.deepEqual(receipt.worktrees_after, receipt.worktrees_before, 'The daily source/build identity changed during execution');
  assert.deepEqual(machineIdentity(receipt.machine), receipt.worktrees_before.machine);
  for (const name of ['worktrees_unchanged', 'configuration_unchanged', 'broker_files_unchanged', 'cli_shim_unchanged', 'host_files_unchanged'])
    assert.equal(receipt[name], true, `Daily proof is incomplete: ${name}`);
  assert.ok(!receipt.error && !receipt.shutdown_error, 'An errored or unfinished process is not a passed daily receipt');
  for (const name of ['user_settings', 'source_config', 'harness_model_credential_files_read', 'old_sessions_read', 'target_extensions_injected', 'source_command_overrides'])
    assert.equal(receipt.modifications?.[name], 0, `The ordinary daily boundary was modified: ${name}`);
  assert.ok(receipt.launch?.host === 'pi' && receipt.launch.normal_user_settings === true
    && Array.isArray(receipt.launch.args) && receipt.launch.args[0] === '--mode' && receipt.launch.args[1] === 'rpc'
    && receipt.launch.args.includes('-ns') && !receipt.launch.args.includes('-e'), 'A fresh ordinary pi -ns launch is required');
  validateDailyHostProcess(receipt.host_process, receipt.host, receipt.owned_pi, receipt.launch.args);
  assert.ok(receipt.autoload?.injected_by_cli === false && receipt.autoload.registration?.source === 'extension'
    && typeof receipt.autoload.actual_entry?.realpath === 'string'
    && inside(receipt.worktrees_before.broker.package_root, receipt.autoload.actual_entry.realpath), 'The actual ordinary Broker registration is missing');
  assert.match(receipt.autoload.actual_entry.sha256, /^[a-f0-9]{64}$/);
  assert.ok(typeof receipt.initial_session?.sessionId === 'string' && receipt.initial_session.sessionId
    && receipt.final_session?.sessionId === receipt.initial_session.sessionId, 'The fresh session identity is missing');
  for (const state of [receipt.initial_session, receipt.final_session]) assert.ok(state.isStreaming === false && state.isCompacting === false);
  assert.ok(Array.isArray(receipt.owned_pi) && receipt.owned_pi.length > 0
    && receipt.owned_pi.every(process => Number.isInteger(process.pid) && process.pid > 0 && process.observed_close === true),
    'Every owned ordinary Pi process must have a witnessed exit');
  assert.ok(receipt.actual_default_sdk?.source_observation_complete === true && receipt.actual_default_sdk.source_command_overridden === false
    && Array.isArray(receipt.actual_default_sdk.operations) && receipt.actual_default_sdk.operations.length > 0
    && Array.isArray(receipt.actual_default_sdk.http) && receipt.actual_default_sdk.http.length > 0, 'Actual default SDK metadata evidence is required');
  validateDailySdkOperations(receipt.actual_default_sdk.operations, library);
  const structure = validateDailyLibraryRequests(receipt.actual_default_sdk.http, library);
  assert.deepEqual(receipt.library_structure, structure);
  assert.ok(Array.isArray(receipt.phases), 'The current daily command phases are required');
  const doctorPhases = receipt.phases.filter(phase => phase.command === '/context-broker doctor');
  assert.equal(doctorPhases.length, 1, 'One explicit doctor phase is required');
  const doctorPhase = doctorPhases[0];
  assert.equal(doctorPhase.disposition, 'handled');
  const doctorStarted = Date.parse(doctorPhase.startedAt), doctorFinished = Date.parse(doctorPhase.finishedAt);
  assert.ok(Number.isFinite(doctorStarted) && Number.isFinite(doctorFinished)
    && doctorStarted >= started && doctorFinished >= doctorStarted && doctorFinished <= finished,
    'The doctor phase must belong to this daily execution');
  const doctor = validateDailyDoctorCli(receipt.explicit_doctor_cli?.observations, {
    library, hostPid: receipt.host_process.pid, entry: join(receipt.worktrees_before.broker.package_root, 'dist/ntn-skills.mjs'),
    sha256: config.embeddedCliSha256, executable: receipt.host_process.node.path, phase: doctorPhase,
  });
  assert.deepEqual(receipt.explicit_doctor_cli, doctor, 'The doctor receipt differs from its independent observations');
  assert.equal(receipt.notion_body_requests, structure.root_children_requests + doctor.library_structure.root_children_requests);
  assert.equal(receipt.actual_default_sdk.owner_pid, receipt.host_process.pid);
  assert.ok(receipt.actual_default_sdk.operations.every(operation => operation.pid === receipt.host_process.pid),
    'Default SDK observations must belong to the actual owned Pi process');
  assert.ok(Number.isInteger(receipt.metadata_http_requests) && receipt.metadata_http_requests > 0);
  assert.equal(receipt.metadata_http_requests, receipt.actual_default_sdk.http.length + doctor.http.length - receipt.notion_body_requests);
  for (const name of ['provider_invocations', 'tool_invocations', 'remote_mutations', 'skill_body_reads']) assert.equal(receipt[name], 0);
  assert.match(receipt.harness?.sha256 ?? '', /^[a-f0-9]{64}$/);
  return { machine: receipt.machine, delivery, builds: current, started_at: receipt.started_at, finished_at: receipt.finished_at,
    actual_entry: receipt.autoload.actual_entry, session_id: receipt.initial_session.sessionId };
}

export async function aggregateDailyDeliveries(config) {
  const result = { version: 2, kind: 'paired-daily-next-delivery', scope: 'two-machine-ordinary-pi-startup-and-metadata', status: 'running',
    provider_model: 'not_run', skill_body_consumption: 'not_run' };
  try {
    result.delivery = deliveryIntent(config);
    assert.ok(config.receipts && Object.keys(config.receipts).sort().join(',') === 'mini,pro', 'Both pro and mini daily receipt paths are required');
    const inputs = {};
    for (const name of ['pro', 'mini']) {
      const path = config.receipts[name];
      assert.ok(typeof path === 'string' && isAbsolute(path), `Missing absolute ${name} daily receipt path`);
      const bytes = await readFile(path), receipt = JSON.parse(bytes.toString('utf8'));
      assertCompletedDaily(receipt);
      inputs[name] = { receipt, reference: { path, sha256: hash(bytes) } };
    }
    const current = await verifyNextWorktreePair(config);
    result.current_source_build = current;
    const harnessSha = hash(await readFile(fileURLToPath(import.meta.url)));
    result.machines = {};
    for (const name of ['pro', 'mini']) {
      const { receipt, reference } = inputs[name];
      const proof = validateDailyReceipt(receipt, config, current);
      assert.equal(receipt.harness.sha256, harnessSha, 'The daily receipt was produced by a different verifier');
      result.machines[name] = { receipt: reference, ...proof };
    }
    assert.notEqual(result.machines.pro.machine.sha256, result.machines.mini.machine.sha256,
      'Pro and Mini must be two different actual machines, not two labels for the same host');
    result.status = 'passed';
  } catch (error) {
    result.status = error.status === 'blocked' ? 'blocked' : 'failed';
    result.error = { code: error.code ?? 'PAIRED_DAILY_VERIFICATION_FAILED', message: error.message };
  }
  return result;
}

export async function verifyDailyPackageSource(spec, settingsPath, brokerRoot) {
  assert.equal(typeof spec, 'string');
  // Pi resolves a user settings package relative to its agent directory.
  const path = await realpath(resolve(dirname(settingsPath), spec));
  assert.equal(path, await realpath(brokerRoot), 'The daily package slot has not been switched to the final Broker');
  return { selected_package: spec, resolved_package: path };
}

async function executableOnPath(name, env) {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    const path = resolve(directory, name);
    try { await access(path, constants.X_OK); return path; }
    catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error(`${name}: executable not found on the normal PATH`);
}

export async function verifyDailyCliShim(config, env = process.env) {
  const standalone = await fileIdentity(join(config.cliRoot, 'dist/ntn-skills.js'));
  assert.equal(standalone.sha256, config.cliEntrySha256);
  const selected = await executableOnPath('ntn-skills', env);
  if (config.cliShim) assert.equal(selected, resolve(config.cliShim), 'The configured CLI shim differs from the normal PATH selection');
  const shim = await fileIdentity(selected);
  let resolution;
  if (shim.realpath === standalone.realpath) {
    assert.equal(shim.sha256, standalone.sha256);
    resolution = { kind: 'direct', entry: standalone };
  } else {
    const volta = await fileIdentity(await executableOnPath('volta', env));
    const dispatcher = await fileIdentity(join(dirname(volta.realpath), 'volta-shim'));
    assert.equal(volta.sha256, config.voltaIdentity?.executable_sha256, 'Freeze the actual Volta executable SHA before daily verification');
    assert.equal(dispatcher.sha256, config.voltaIdentity?.dispatcher_sha256, 'Freeze the actual Volta dispatcher SHA before daily verification');
    assert.equal(shim.realpath, dispatcher.realpath, 'The selected CLI is not the actual Volta dispatcher');
    assert.equal(shim.sha256, dispatcher.sha256);
    const argv = [volta.path, 'which', 'ntn-skills'];
    const path = execFileSync(argv[0], argv.slice(1), {
      env, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    assert.ok(isAbsolute(path) && !/[\r\n]/u.test(path), 'Volta must resolve one absolute CLI entry');
    const entry = await fileIdentity(path);
    assert.equal(entry.realpath, standalone.realpath, 'Volta resolved a different installed CLI');
    assert.equal(entry.sha256, config.cliEntrySha256, 'The Volta-resolved CLI bytes changed');
    resolution = { kind: 'volta', argv, executable: volta, dispatcher, entry };
  }
  return { ...shim, resolution, references_final_cli: true, executed_by_harness: false };
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
  const selectedIdentity = await verifyDailyPackageSource(spec, settingsPath, config.brokerRoot);
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
    assert.ok(source.command === undefined, 'Daily verification must exercise the default bundled SDK');
    assert.ok(source.prefetch === false || source.prefetch === undefined, 'This metadata-only run requires disabled prefetch');
  }
  return {
    settings: { path: settingsPath, sha256: hash(raw), packages: settings.packages.length, selected_index: index, ...selectedIdentity, other_packages_sha256: hash(JSON.stringify(settings.packages.filter((_, i) => i !== index))) },
    source: { path: sourcePath, sha256: hash(sourceBytes), sources: sources.map(source => ({ id: source.id, type: source.type, library: source.library, default_view_id: source.default_view_id, profile_id: source.profile_id, prefetch: source.prefetch ?? false, command_configured: false })) },
  };
}

const safeCommand = command => ({ name: command.name, source: command.source, sourceInfo: command.sourceInfo ? { path: command.sourceInfo.path, scope: command.sourceInfo.scope, origin: command.sourceInfo.origin, baseDir: command.sourceInfo.baseDir, source_sha256: hash(String(command.sourceInfo.source)) } : undefined });
const safeState = state => ({ sessionId: state.sessionId, sessionFile: state.sessionFile, messageCount: state.messageCount, isStreaming: state.isStreaming, isCompacting: state.isCompacting });
const notifications = frames => frames.filter(frame => frame.type === 'extension_ui_request' && frame.method === 'notify').flatMap(strings);
const safeDiagnostic = text => ({ sha256: hash(text), bytes: Buffer.byteLength(text), lines: text.split('\n').filter(line => /^(?:Context Broker Doctor|Config:|Path mode:|Log paths:|Scan:|Skill roots:|Discovery catalogs:|Records:|Config diagnostics:|Namespace:|Source [\w-]+: direct Notion API |context-broker find:|\$|\s+fail |\s*(?:kind|source|page|select|path):)/u.test(line)) });

export function validateDailyFind(reports, expected) {
  assert.ok(expected && typeof expected.selection === 'string', 'Bind the required daily selection identity');
  const records = [];
  for (const report of reports) {
    let record;
    for (const line of report.split('\n')) {
      const selection = /^\$(\S+)$/u.exec(line);
      if (selection) { record = { selection: selection[1] }; records.push(record); continue; }
      const field = /^\s+(kind|source|page): (.+)$/u.exec(line);
      if (field && record) record[field[1]] = field[2];
    }
  }
  const matched = records.filter(record => record.selection === expected.selection);
  assert.equal(matched.length, 1, 'The required qualified daily selection must exist exactly once');
  assert.deepEqual(matched[0], expected, 'The daily selection identity must match the reviewed source');
  return matched[0];
}

export function validateDailyDoctor(reports, review, sourceDatabaseIds, requiredSelection) {
  const lines = reports.flatMap(report => report.split('\n'));
  assert.ok(lines.includes('Config diagnostics: ok'), 'The actual source/config diagnostics must pass');
  assert.ok(!lines.includes('Config diagnostics: failed'), 'Config errors cannot be accepted as external catalog diagnostics');
  const failures = lines.filter(line => /^\s+fail /u.test(line));
  if (lines.includes('Namespace: ok no discovery namespace collisions')) {
    assert.ok(!lines.includes('Namespace: failed'));
    assert.equal(failures.length, 0);
    return { status: 'ok', failures: [] };
  }
  assert.ok(lines.includes('Namespace: failed'), 'Missing actual namespace result');
  assert.equal(review?.kind, 'reviewed-external-catalog-diagnostics');
  assert.equal(review.status, 'outside-delivery-scope');
  assert.ok(sourceDatabaseIds.includes(review.sourceDatabaseId));
  assert.ok(review.declaredDatabaseIds.length > 0);
  assert.ok(review.declaredDatabaseIds.every(id => !sourceDatabaseIds.includes(id)), 'A current-source catalog failure remains in delivery scope');
  assert.ok(review.namespaceDiagnostics.length > 0);
  assert.deepEqual([...failures].sort(), [...review.namespaceDiagnostics].sort(), 'New or changed namespace failures must be reviewed');
  for (const line of failures) {
    const match = /^\s+fail router "([^"]+)" member "notion_page:[0-9a-f-]+" unavailable \(CATALOG_MEMBER_UNAVAILABLE\): /u.exec(line);
    assert.ok(match && review.routerNames.includes(match[1]), 'Only the reviewed external catalog member failures are permitted');
    assert.notEqual(match[1], requiredSelection.split('@')[0], 'The required daily route cannot be excluded');
  }
  return { status: 'retained-external-catalog-diagnostics', failures, catalog: review.catalog, reason: review.reason };
}

export function classifyDailyHttp(observed, sourcePids, hostPids, { sourceObservation } = {}) {
  assert.ok(!observed.some(row => row.event === 'http_observer_error'), 'Independent HTTP observer contains invalid evidence');
  const parents = new Map();
  for (const row of observed) {
    if (row.event === 'process_start' && Number.isInteger(row.ppid)) parents.set(row.pid, row.ppid);
    if (row.event === 'spawn' && Number.isInteger(row.child_pid)) parents.set(row.child_pid, row.pid);
  }
  const sdkAttempts = new Map(), matchedSdk = new Set();
  if (sourceObservation) {
    assert.equal(sourceObservation.complete, true, 'Incomplete SDK observation cannot attribute host HTTP');
    assert.deepEqual(sourceObservation.errors, [], 'SDK observation contains invalid or missing evidence');
    const events = sourceObservation.events;
    assert.ok(Array.isArray(events) && events[0]?.phase === 'source_observer_start'
      && events.at(-1)?.phase === 'source_observer_end' && events.at(-1)?.complete === true);
    const starts = events.filter(event => event.phase === 'started');
    const operations = new Map(starts.map(event => [event.requestId, event]));
    assert.equal(operations.size, starts.length, 'Duplicate source operation');
    for (const attempt of events.filter(event => event.phase === 'attempt')) {
      const operation = operations.get(attempt.requestId);
      assert.ok(operation, 'An HTTP attempt has no original source operation');
      if (operation.kind !== 'sdk') continue;
      assert.ok(hostPids.has(operation.pid), 'SDK operation belongs to another process');
      assert.ok(typeof attempt.request_id === 'string' && attempt.request_id.length > 0,
        'SDK HTTP without a request ID remains unattributed');
      assert.ok(!sdkAttempts.has(attempt.request_id), 'An SDK request ID cannot identify multiple attempts');
      sdkAttempts.set(attempt.request_id, { operation, attempt });
    }
    for (const operation of starts.filter(event => event.kind === 'sdk')) {
      assert.ok(hostPids.has(operation.pid), 'SDK operation belongs to another process');
      assert.ok(['library-selection', 'library', 'list', 'files', 'consume', 'read', 'read-resources', 'resolve'].includes(operation.operation));
      const terminal = events.filter(event => event.phase === 'completed' && event.requestId === operation.requestId);
      assert.equal(terminal.length, 1, 'SDK operation needs one actual terminal');
      assert.equal(terminal[0].pid, operation.pid);
      assert.equal(terminal[0].operation, operation.operation);
      assert.equal(terminal[0].sdkStarted, true);
      assert.equal(terminal[0].status, 'completed');
      const metrics = events.filter(event => event.phase === 'metrics' && event.requestId === operation.requestId);
      assert.equal(metrics.length, 1);
      assert.equal(metrics[0].observed, true);
      assert.equal(metrics[0].complete, true, 'Truncated or absent metrics cannot prove SDK HTTP coverage');
      assert.equal(metrics[0].total_requests, events.filter(event => event.phase === 'attempt' && event.requestId === operation.requestId).length);
      if (operation.operation === 'library-selection') assert.equal(metrics[0].total_requests, 0, 'Local Library selection cannot perform HTTP');
    }
  }
  const source = [], sdk = [], otherPlugins = [], unattributedHostHttp = [], proxyTunnels = [];
  const requests = observed.filter(row => row.event === 'http_start' || row.event === 'http_created' && row.transport === 'proxy-connect'
    && !observed.some(sent => sent.event === 'http_start' && sent.pid === row.pid && sent.id === row.id));
  for (const request of requests) {
    let pid = request.pid, role;
    const visited = new Set();
    while (Number.isInteger(pid) && !visited.has(pid)) {
      visited.add(pid);
      if (sourcePids.has(pid)) { role = 'source'; break; }
      if (hostPids.has(pid)) { role = pid === request.pid ? 'host' : 'other-plugin'; break; }
      pid = parents.get(pid);
    }
    if (request.method === 'CONNECT' || request.transport === 'proxy-connect') {
      assert.ok(['host', 'source', 'other-plugin'].includes(role), 'Proxy tunnel has no verified process ancestry');
      assert.equal(request.method, 'CONNECT'); assert.equal(request.transport, 'proxy-connect');
      const proxy = new URL(request.origin), target = new URL('https://' + request.authority);
      assert.ok(['http:', 'https:'].includes(proxy.protocol) && proxy.origin === request.origin, 'Proxy tunnel has no exact proxy origin');
      assert.ok(typeof request.authority === 'string' && /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+):[0-9]+$/iu.test(request.authority)
        && target.hostname && !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash,
      'Proxy tunnel has no authority-form target');
      assert.equal(request.path, null);
      if (request.event === 'http_start') assert.equal(request.request_bytes, 0, 'CONNECT must not carry an application request body');
      const outcomes = observed.filter(row => ['http_end', 'http_error'].includes(row.event) && row.id === request.id && row.pid === request.pid);
      assert.ok(outcomes.length <= 1 && outcomes.every(row => !sdkAttempts.has(row.response_request_id)),
        'A proxy tunnel cannot replace an SDK response or have multiple terminal outcomes');
      proxyTunnels.push({ ...request, role, outcomes });
      continue;
    }
    if (role === 'host') {
      const origin = new URL(request.origin);
      assert.ok(['http:', 'https:'].includes(origin.protocol) && origin.origin === request.origin, 'Host HTTP has no exact origin');
      const outcomes = observed.filter(row => ['http_end', 'http_error'].includes(row.event) && row.id === request.id && row.pid === request.pid);
      const hasSdkAttempt = outcomes.some(row => sdkAttempts.has(row.response_request_id));
      // The target includes every Notion request and every declared SDK attempt.
      // Other host traffic stays unknown; it cannot satisfy or hide an SDK attempt.
      if (origin.hostname !== 'api.notion.com' && !hasSdkAttempt) {
        unattributedHostHttp.push({ ...request, outcomes });
        continue;
      }
      const terminal = observed.filter(row => row.event === 'http_end' && row.id === request.id && row.pid === request.pid);
      assert.equal(terminal.length, 1, 'Host HTTP needs one independent response');
      const match = sdkAttempts.get(terminal[0].response_request_id);
      assert.ok(match && match.operation.pid === request.pid, 'Host HTTP has no exact SDK request ID match');
      assert.ok(!matchedSdk.has(match.attempt.request_id), 'One SDK attempt cannot account for two HTTP requests');
      assert.equal(match.attempt.method, request.method);
      assert.equal(match.attempt.http_status, terminal[0].status);
      assert.equal(match.attempt.request_bytes, request.request_bytes);
      assert.equal(match.attempt.outcome, 'success');
      const attributed = { ...request, attribution: { kind: 'sdk', operation: match.operation.operation,
        library: match.operation.library, source_id: match.operation.source_id,
        requestId: match.operation.requestId, attempt: match.attempt.attempt, request_id: match.attempt.request_id,
        request_kind: match.attempt.request_kind, response_bytes: match.attempt.response_bytes,
        body_kind: match.attempt.body_kind ?? null, target: match.attempt.target ?? null },
        ...(Object.hasOwn(terminal[0], 'library_structure') ? { structure: terminal[0].library_structure } : {}) };
      matchedSdk.add(match.attempt.request_id); sdk.push(attributed); source.push(attributed);
    } else {
      assert.ok(role === 'source' || role === 'other-plugin', 'HTTP without a verified source or other-plugin process ancestry');
      if (role === 'source') source.push(completedDailyHttp(request, observed));
      else otherPlugins.push(request);
    }
  }
  assert.equal(matchedSdk.size, sdkAttempts.size, 'An SDK attempt lacks independent HTTP evidence');
  return { source, sdk, otherPlugins, unattributedHostHttp, proxyTunnels };
}

export function validateDailySdkOperations(operations, library) {
  assert.ok(rootId(library));
  assert.ok(Array.isArray(operations) && operations.some(row => row.operation === 'list'), 'Actual SDK catalog discovery is required');
  for (const row of operations) {
    assert.ok(['library-selection', 'library', 'list'].includes(row.operation), 'Daily metadata cannot consume Skill bodies or resources');
    if (row.operation === 'library-selection') assert.ok(row.library === null || row.library === library, 'Local selection names another Library');
    else assert.equal(row.library, library, 'Metadata belongs to another Library, even if its Source or Skill name matches');
  }
}

function validateLibraryRequestGroup(group, library, operation, requestId, previous, doctor) {
  const pages = group.filter(row => row.path === '/v1/blocks/' + library + '/children');
  let databases = previous ? new Map(previous.databases) : new Map();
  let dataSources = previous ? new Map(previous.dataSources) : new Map();
  let views = previous ? new Map(previous.views) : new Map();
  if (pages.length) {
    databases = new Map(); dataSources = new Map(); views = new Map();
    const children = new Set(), direct = new Set(); let cursor = null;
    for (const [index, page] of pages.entries()) {
      assert.equal(page.method, 'GET');
      assert.equal(page.cursor_sha256, cursor, 'Root children pagination is missing or reordered');
      const projection = page.structure;
      assert.equal(projection?.kind, 'root-children'); assert.equal(projection.root, library);
      assert.equal(typeof projection.has_more, 'boolean'); assert.ok(Array.isArray(projection.children));
      for (const child of projection.children) {
        assert.ok(rootId(child.id) && !children.has(child.id), 'Root children omit or repeat an identity'); children.add(child.id);
        if (child.type !== 'child_database' || child.in_trash || child.archived) continue;
        assert.deepEqual(child.parent, { type: 'page_id', page_id: library }, 'A database is not a direct child of the selected root');
        direct.add(child.id);
      }
      cursor = projection.next_cursor_sha256;
      if (projection.has_more) assert.match(cursor ?? '', /^[a-f0-9]{64}$/u);
      else { assert.equal(cursor, null); assert.equal(index, pages.length - 1, 'A complete census cannot have extra pages'); }
    }
    assert.equal(pages.at(-1).structure.has_more, false, 'Truncated root children cannot authorize tables');
    for (const request of group.filter(row => /^\/v1\/databases\/[^/]+$/u.test(row.path))) {
      const id = request.path.split('/').at(-1), projection = request.structure;
      assert.ok(direct.has(id), 'A database descriptor was read outside the selected root');
      assert.equal(projection?.kind, 'database'); assert.equal(projection.id, id);
      assert.deepEqual(projection.parent, { type: 'page_id', page_id: library });
      assert.equal(projection.in_trash, false); assert.equal(projection.archived, false);
      assert.ok(Array.isArray(projection.data_source_ids) && projection.data_source_ids.length
        && projection.data_source_ids.every(rootId) && new Set(projection.data_source_ids).size === projection.data_source_ids.length);
      databases.set(id, projection.data_source_ids);
    }
    assert.deepEqual([...databases.keys()].sort(), [...direct].sort(), 'Every direct database needs its actual descriptor response');
  } else assert.ok(operation === 'list' && previous, 'Library validation requires a complete root children census');
  const dataSourceOwners = new Map();
  for (const [database, ids] of databases) for (const id of ids) {
    assert.ok(!dataSourceOwners.has(id) || dataSourceOwners.get(id) === database, 'Data source ownership is ambiguous');
    dataSourceOwners.set(id, database);
  }
  for (const request of group.filter(row => /^\/v1\/data_sources\/[^/]+$/u.test(row.path))) {
    const id = request.path.split('/').at(-1), projection = request.structure;
    assert.equal(projection?.kind, 'data_source'); assert.equal(projection.id, id);
    assert.equal(projection.parent?.type, 'database_id');
    const database = projection.parent.database_id;
    assert.ok(databases.get(database)?.includes(id), 'A data source has no direct-root database binding');
    assert.equal(projection.in_trash, false); assert.equal(projection.archived, false);
    assert.ok(!dataSources.has(id) || dataSources.get(id) === database, 'Data source ownership is ambiguous');
    dataSources.set(id, database);
  }
  assert.deepEqual([...dataSources.keys()].sort(), [...dataSourceOwners.keys()].sort(),
    'Every declared data source needs its actual descriptor response');
  assert.ok(databases.size && dataSources.size, 'The Library structure proof is empty');
  for (const request of group.filter(row => /^\/v1\/views\/[^/]+$/u.test(row.path))) {
    const id = request.path.split('/').at(-1), projection = request.structure;
    assert.equal(request.method, 'GET'); assert.equal(projection?.kind, 'view'); assert.equal(projection.id, id);
    assert.equal(projection.parent?.type, 'database_id');
    const database = projection.parent.database_id, dataSource = projection.data_source_id;
    assert.ok(databases.get(database)?.includes(dataSource) && dataSources.get(dataSource) === database, 'A View has no proven root table owner');
    views.set(id, { database_id: database, data_source_id: dataSource });
  }
  const scope = { library, databases, dataSources, views, ...(doctor ? { doctor } : {}) };
  for (const request of group) {
    const kind = classifyDailyNotionRequest(request, scope);
    if (request.attribution.kind === 'sdk' && request.attribution.request_kind === 'notion_body') assert.equal(kind, 'library-structure', 'A body metric is not an exact root census');
    if (kind === 'library-structure' && request.attribution.kind === 'sdk') assert.equal(request.attribution.request_kind, 'notion_body');
  }
  return { scope, proof: { request_id: requestId, operation, root_children_requests: pages.length,
    databases: [...databases].map(([database_id, data_source_ids]) => ({ database_id, data_source_ids })),
    data_sources: [...dataSources].map(([data_source_id, database_id]) => ({ data_source_id, database_id })),
    views: [...views].map(([view_id, binding]) => ({ view_id, ...binding })) } };
}

/** Establish physical bounds only from independently observed, completed HTTP
 * responses. Names and SDK counters cannot authorize a table or body request. */
export function validateDailyLibraryRequests(requests, library) {
  assert.ok(rootId(library));
  const groups = new Map();
  for (const request of requests) {
    const attribution = request.attribution;
    assert.equal(attribution?.kind, 'sdk');
    assert.ok(['library', 'list'].includes(attribution.operation), 'Only remote Library validation and catalog metadata may use HTTP');
    assert.equal(attribution.library, library, 'SDK HTTP belongs to another Library');
    const group = groups.get(attribution.requestId) ?? [];
    assert.ok(!group.length || group[0].attribution.operation === attribution.operation);
    group.push(request); groups.set(attribution.requestId, group);
  }
  let previous, rootReads = 0;
  const proofs = [];
  for (const [requestId, group] of groups) {
    const { scope, proof } = validateLibraryRequestGroup(group, library, group[0].attribution.operation, requestId, previous);
    proofs.push(proof); rootReads += proof.root_children_requests; previous = scope;
  }
  assert.ok(rootReads > 0, 'No actual Library root validation was observed');
  return { library_id: library, root_children_requests: rootReads, operations: proofs };
}

function completedDailyHttp(request, observed) {
  const terminal = observed.filter(row => ['http_end', 'http_error'].includes(row.event)
    && row.pid === request.pid && row.id === request.id);
  assert.equal(terminal.length, 1, 'A bundled CLI HTTP request needs one independent terminal');
  const response = terminal[0];
  assert.ok(response.event === 'http_end' && response.status >= 200 && response.status < 300,
    'A bundled CLI HTTP request did not complete with HTTP 2xx');
  return { ...request, response,
    ...(Object.hasOwn(response, 'library_structure') ? { structure: response.library_structure } : {}) };
}

/** A CLI receipt has its own process and HTTP evidence; it never supplies SDK metrics. */
export function validateDailyDoctorCli(observed, { library, hostPid, entry, sha256, executable, phase }) {
  assert.ok(rootId(library) && Number.isSafeInteger(hostPid) && hostPid > 0);
  assert.ok(isAbsolute(entry) && isAbsolute(executable)); assert.match(sha256, /^[a-f0-9]{64}$/u);
  assert.ok(Array.isArray(observed) && !observed.some(row => row.event === 'http_observer_error'),
    'Independent doctor observation is missing or invalid');
  assert.equal(phase?.command, '/context-broker doctor'); assert.equal(phase.disposition, 'handled');
  const time = value => { const result = Date.parse(value); assert.ok(Number.isFinite(result), 'Doctor evidence needs an actual timestamp'); return result; };
  const phaseStart = time(phase.startedAt), phaseEnd = time(phase.finishedAt);
  assert.ok(phaseEnd >= phaseStart, 'The explicit doctor phase is incomplete');
  const one = (rows, message) => { assert.equal(rows.length, 1, message); return rows[0]; };
  const spawned = one(observed.filter(row => row.event === 'spawn' && row.bundled_cli), 'One explicit bundled doctor CLI is required');
  const pid = spawned.child_pid, args = ['ctl', 'doctor', '--library', library];
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== hostPid);
  assert.equal(spawned.pid, hostPid, 'The doctor must be a direct child of the owned Pi');
  assert.equal(spawned.executable, executable); assert.equal(spawned.real_script, entry);
  assert.equal(spawned.script_sha256, sha256); assert.deepEqual(spawned.cli_args, args, 'The doctor argv must select only the expected Library');
  const started = one(observed.filter(row => row.event === 'process_start' && row.pid === pid), 'The doctor needs its independent process start');
  assert.equal(started.ppid, hostPid); assert.equal(started.executable, executable);
  assert.equal(started.real_entry, entry); assert.equal(started.entry_sha256, sha256);
  assert.equal(started.args_sha256, hash(JSON.stringify(args)), 'The actual doctor argv differs from its spawn');
  const closed = one(observed.filter(row => row.event === 'child_close' && row.child_pid === pid), 'The doctor needs one parent-observed close');
  assert.equal(closed.pid, hostPid); assert.equal(closed.bundled_cli, true);
  assert.equal(closed.executable, executable); assert.equal(closed.real_script, entry);
  assert.equal(closed.script_sha256, sha256); assert.deepEqual(closed.cli_args, args);
  assert.equal(closed.code, 0); assert.equal(closed.signal, null);
  assert.ok(Number.isSafeInteger(closed.stdout_bytes) && closed.stdout_bytes > 0);
  assert.match(closed.stdout_sha256 ?? '', /^[a-f0-9]{64}$/u);
  assert.equal(closed.receipt?.ok, true); assert.equal(closed.receipt.transport, 'direct_http');
  assert.equal(closed.receipt.notion_api_version, '2026-03-11'); assert.equal(closed.receipt.authentication, 'available');
  assert.equal(closed.receipt.skill_read?.checked, false, 'The doctor must not request a Skill body');
  const exited = one(observed.filter(row => row.event === 'process_exit' && row.pid === pid), 'The doctor needs a witnessed exit');
  assert.equal(exited.code, 0);
  const complete = one(observed.filter(row => row.event === 'http_observer_end' && row.pid === pid), 'The doctor HTTP observer must finish');
  assert.equal(complete.complete, true); assert.equal(complete.errors, 0); assert.deepEqual(complete.pending, []);
  for (const row of [spawned, started, closed, exited, complete])
    assert.ok(time(row.at) >= phaseStart && time(row.at) <= phaseEnd, 'The doctor must stay within its explicit command phase');
  assert.ok(time(closed.at) >= time(started.at) && time(exited.at) >= time(started.at));
  // Preserve descendant observations so a child cannot inherit doctor permission.
  const pids = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of observed) {
      const parent = row.event === 'process_start' ? row.ppid : row.event === 'spawn' ? row.pid : null;
      const child = row.event === 'process_start' ? row.pid : row.event === 'spawn' ? row.child_pid : null;
      if (pids.has(parent) && Number.isSafeInteger(child) && !pids.has(child)) { pids.add(child); changed = true; }
    }
  }
  const rows = observed.filter(row => pids.has(row.pid) || row === spawned || row === closed);
  const transport = row => row.method === 'CONNECT' || row.transport === 'proxy-connect';
  const created = rows.filter(row => row.event === 'http_created' && !transport(row));
  const requests = rows.filter(row => row.event === 'http_start' && !transport(row));
  assert.ok(requests.length > 0 && created.length === requests.length, 'Every doctor HTTP creation needs its actual sent request');
  assert.equal(new Set(requests.map(row => row.pid + ':' + row.id)).size, requests.length, 'Doctor HTTP identities repeat');
  const http = requests.map(request => {
    assert.equal(request.pid, pid, 'A descendant cannot inherit the explicit doctor HTTP owner');
    const creation = one(created.filter(row => row.pid === request.pid && row.id === request.id), 'Doctor HTTP has no unique creation');
    for (const key of ['method', 'origin', 'path']) assert.equal(creation[key], request[key]);
    const normalized = completedDailyHttp(request, rows), ended = time(normalized.response.at);
    assert.ok(time(request.at) >= time(started.at) && ended >= time(request.at) && ended <= time(exited.at),
      'Doctor HTTP escaped its actual process lifetime');
    return { ...normalized, attribution: { kind: 'doctor', operation: 'doctor', library, owner_pid: hostPid, cli_pid: pid } };
  });
  const applicationIds = new Set(created.map(row => row.pid + ':' + row.id));
  for (const row of rows.filter(row => ['http_end', 'http_error'].includes(row.event))) {
    const isTransport = rows.some(request => ['http_created', 'http_start'].includes(request.event)
      && request.pid === row.pid && request.id === row.id && transport(request));
    assert.ok(isTransport || applicationIds.has(row.pid + ':' + row.id), 'An unowned doctor HTTP terminal was observed');
  }
  assert.ok(http.some(request => request.path === '/v1/pages/' + library), 'The doctor must independently read the selected root page');
  const { proof } = validateLibraryRequestGroup(http, library, 'doctor', 'doctor:' + pid, undefined, { pid, owner_pid: hostPid });
  return { entry, sha256, observations: rows, processes: [{ parent_pid: hostPid, pid, executable, script: spawned.script, args }],
    doctor: closed.receipt, http, library_structure: { library_id: library, root_children_requests: proof.root_children_requests, operations: [proof] },
    path_cli_used_for_default_source: false };
}

export function classifyDailyNotionRequest(request, scope) {
  assert.equal(request.origin, 'https://api.notion.com', 'Unexpected provider/external HTTP in the verified Notion consumer');
  const attribution = request.attribution;
  const owner = attribution?.kind === 'sdk' && ['library', 'list'].includes(attribution.operation)
    && attribution.target?.block_id === scope?.library
    || attribution?.kind === 'doctor' && attribution.operation === 'doctor' && scope?.doctor
      && attribution.cli_pid === request.pid && attribution.cli_pid === scope.doctor.pid
      && attribution.owner_pid === scope.doctor.owner_pid;
  const exactRoot = scope && owner && request.method === 'GET' && request.path === '/v1/blocks/' + scope.library + '/children'
    && attribution.library === scope.library && request.structure?.kind === 'root-children' && request.structure.root === scope.library;
  if (exactRoot) return 'library-structure';
  const body = /^\/v1\/blocks(?:\/|$)/u.test(request.path) || /\/(?:markdown|children)(?:\/|$)/u.test(request.path);
  assert.equal(body, false, 'Startup/find/doctor must not load Skill bodies');
  if (scope) {
    const database = /^\/v1\/databases\/([^/]+)(?:\/query)?$/u.exec(request.path);
    const dataSource = /^\/v1\/data_sources\/([^/]+)(?:\/query)?$/u.exec(request.path);
    if (database) assert.ok(scope.databases.has(database[1]), 'Database HTTP escaped the selected root');
    if (dataSource) assert.ok(scope.dataSources.has(dataSource[1]), 'Data source HTTP escaped the selected root');
    if (request.attribution.operation === 'library') {
      assert.equal(request.method, 'GET', 'Library validation only reads structure');
      assert.ok(request.path === '/v1/users/me' || request.path === '/v1/pages/' + scope.library
        || database && request.path === '/v1/databases/' + database[1]
        || dataSource && request.path === '/v1/data_sources/' + dataSource[1], 'Library validation read an unrelated endpoint');
    } else {
      const view = /^\/v1\/views\/([^/]+)(?:\/(queries)(?:\/([0-9a-f-]{36}))?)?$/u.exec(request.path);
      const descriptor = request.method === 'GET' && (request.path === '/v1/users/me' || request.path === '/v1/pages/' + scope.library
        || database && request.path === '/v1/databases/' + database[1]
        || dataSource && request.path === '/v1/data_sources/' + dataSource[1]);
      const query = request.method === 'POST' && dataSource && request.path === '/v1/data_sources/' + dataSource[1] + '/query';
      const viewList = request.method === 'GET' && request.path === '/v1/views' && scope.databases.has(request.view_database_id);
      const viewRequest = view && scope.views.has(view[1]) && (view[2]
        ? view[3] ? request.method === 'GET' : request.method === 'POST'
        : request.method === 'GET');
      assert.ok(descriptor || query || viewList || viewRequest, 'Catalog metadata read an endpoint without a proven Library owner');
    }
    if (request.path === '/v1/pages/' + scope.library) {
      assert.equal(request.structure?.kind, 'page'); assert.equal(request.structure.id, scope.library);
      assert.equal(request.structure.in_trash, false); assert.equal(request.structure.archived, false);
    }
  }
  const readonly = ['GET', 'HEAD'].includes(request.method) || request.method === 'POST' && (/^\/v1\/(?:data_sources|databases)\/[^/]+\/query$/u.test(request.path) || /^\/v1\/views\/[^/]+\/queries$/u.test(request.path) || request.path === '/v1/search');
  assert.ok(readonly, 'A remote mutation was observed in the Notion consumer');
  return 'metadata';
}

async function run(config) {
  for (const key of ['brokerRoot', 'brokerArchive', 'embeddedCliSha256', 'embeddedSdkSha256', 'brokerArchiveSha256', 'cliRoot', 'cliArchive', 'cliArchiveSha256', 'cliEntrySha256', 'evidenceRoot']) assert.equal(typeof config[key], 'string', `Missing final artifact: ${key}`);
  const delivery = deliveryIntent(config), library = expectedLibrary(config), startedAt = new Date().toISOString();
  const findQuery = config.findQuery ?? 'pstack';
  assert.ok(typeof findQuery === 'string' && findQuery.length && !/[\r\n]/u.test(findQuery));
  await mkdir(config.evidenceRoot, { recursive: true });
  const evidence = await mkdtemp(join(config.evidenceRoot, 'daily-pi-'));
  const sessions = join(evidence, 'sessions'), cwd = join(evidence, 'workspace'), observerDir = join(evidence, 'observation');
  await Promise.all([sessions, cwd, observerDir].map(path => mkdir(path)));
  const result = { version: 2, kind: 'actual-daily-pi-autoload-and-diagnostics', scope: 'ordinary-pi-startup-and-metadata', status: 'running',
    delivery, library, started_at: startedAt, evidence, plan: plan(config), harness: await fileIdentity(fileURLToPath(import.meta.url)),
    modifications: { user_settings: 0, source_config: 0, harness_model_credential_files_read: 0, old_sessions_read: 0, target_extensions_injected: 0, source_command_overrides: 0 }, phases: [] };
  let rpc, observedRpc, before, broker;
  try {
    result.worktrees_before = await verifyNextWorktreePair(config);
    result.machine = result.worktrees_before.machine;
    before = await configurationSnapshot(config);
    let namespaceReview;
    if (config.namespaceDiagnosticsReview) {
      const receipt = await readFile(config.namespaceDiagnosticsReview.path);
      assert.equal(hash(receipt), config.namespaceDiagnosticsReview.sha256);
      namespaceReview = JSON.parse(receipt);
      const catalog = await fileIdentity(namespaceReview.catalog.path);
      assert.equal(catalog.sha256, namespaceReview.catalog.sha256);
      assert.equal(catalog.bytes, namespaceReview.catalog.bytes);
      result.namespace_diagnostics_review = { ...config.namespaceDiagnosticsReview, catalog };
    }
    broker = await packageClosure(config.brokerRoot, config.brokerArchive, config.brokerArchiveSha256);
    const cli = await packageClosure(config.cliRoot, config.cliArchive, config.cliArchiveSha256);
    await save(join(evidence, 'installed-broker-files.json'), broker); await save(join(evidence, 'installed-cli-files.json'), cli);
    const embedded = await fileIdentity(join(config.brokerRoot, 'dist/ntn-skills.mjs'));
    assert.equal(embedded.sha256, config.embeddedCliSha256);
    const embeddedSdk = await fileIdentity(join(config.brokerRoot, 'dist/ntn-skills-sdk.mjs'));
    assert.equal(embeddedSdk.sha256, config.embeddedSdkSha256);
    const embeddedRef = await fileIdentity(join(config.brokerRoot, 'dist/ntn-skills-ref.cjs'));
    const sdkManifest = await json(join(config.brokerRoot, 'dist/ntn-skills-runtime.json'));
    assert.equal(sdkManifest.version, 1); assert.equal(sdkManifest.package, 'ntn-skills');
    assert.equal(sdkManifest.sdk_version, 3);
    assert.equal(sdkManifest.cli_sha256, embedded.sha256); assert.equal(sdkManifest.sdk_sha256, embeddedSdk.sha256);
    assert.equal(sdkManifest.skill_ref_version, 2); assert.equal(sdkManifest.ref_sha256, embeddedRef.sha256);
    const selectedRef = await fileIdentity(join(config.cliRoot, 'dist/ref.cjs'));
    assert.equal(embeddedRef.sha256, selectedRef.sha256);
    const standalone = await fileIdentity(join(config.cliRoot, 'dist/ntn-skills.js'));
    assert.equal(standalone.sha256, config.cliEntrySha256);
    const shim = await verifyDailyCliShim(config);
    result.artifacts = { broker: { root: broker.root, archive_sha256: broker.archive.sha256, published_files: broker.file_count, files_sha256: broker.sha256 }, embedded, embeddedSdk, embeddedRef, sdkManifest, standalone, selectedRef, cli_shim: shim };
    result.configuration_before = before;
    const resolvedHost = await resolveHost('pi');
    const host = { ...resolvedHost, launcher: await fileIdentity(resolvedHost.path), parent_pid: process.pid }; result.host = host;
    const preload = join(evidence, 'observe-process.cjs');
    await writeFile(preload, dailyObserverPreloadSource({ directory: observerDir, cliEntry: embedded.realpath, ownerParentPid: process.pid, library }), { mode: 0o600 });
    const sdkPreload = join(evidence, 'observe-source.mjs'), sourceLedger = join(evidence, 'source-operations.jsonl');
    await writeFile(sdkPreload, sourceObserverPreloadSource({ output: sourceLedger, checkoutRoot: resolve(fileURLToPath(new URL('..', import.meta.url))),
      clockId: 'daily-' + Date.now(), cliPath: embedded.realpath, ownerParentPid: process.pid,
      ownerPackage: { packageName: '@earendil-works/pi-coding-agent', binName: 'pi' } }), { mode: 0o600 });
    const processLedger = join(evidence, 'owned-processes.jsonl');
    await writeFile(processLedger, '', { flag: 'wx', mode: 0o600 });
    const env = { ...process.env, BROKER_E2E_PROCESS_LEDGER: processLedger, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require=' + JSON.stringify(preload), '--import=' + JSON.stringify(sdkPreload)].filter(Boolean).join(' ') };
    const args = ['-ns', '--session-dir', sessions];
    result.launch = { host: 'pi', cwd, args: ['--mode', 'rpc', ...args], normal_user_settings: true, preexisting_node_options_preserved: Boolean(process.env.NODE_OPTIONS), observer_sha256: hash(await readFile(preload)), source_observer_sha256: hash(await readFile(sdkPreload)) };
    await save(join(evidence, 'result.json'), result);
    rpc = await startRpc({ host: 'pi', cwd, env, args, timeoutMs: 120000 });
    observedRpc = rpc;
    const initial = safeState(await rpc.command('get_state'));
    assert.ok(initial.sessionId && !initial.isStreaming && !initial.isCompacting);
    result.host_process = observedDailyHostProcess(host, await ownedPiProcesses(processLedger), await observedRows(observerDir),
      result.launch.args, { complete: false });
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
    let doctorReports;
    for (const message of ['/context-broker find ' + findQuery, '/context-broker doctor']) {
      const start = rpc.frames.length;
      const startedAt = new Date().toISOString();
      const acknowledgment = await rpc.command('prompt', { message });
      assert.equal(acknowledgment?.disposition, 'handled', 'A metadata slash command must never dispatch to the model');
      const reports = notifications(rpc.frames.slice(start)).filter(text => /^(?:context-broker find:|Context Broker Doctor)/u.test(text));
      result.phases.push({ command: message, startedAt, finishedAt: new Date().toISOString(), disposition: acknowledgment.disposition, diagnostics: reports.map(safeDiagnostic) });
      assert.ok(reports.length, 'The actual metadata command did not produce its notification');
      if (message.startsWith('/context-broker find ')) result.required_selection = validateDailyFind(reports, config.expectedFindRecord);
      if (message.endsWith('doctor')) {
        assert.ok(reports.some(text => text.includes('direct Notion API 2026-03-11, authentication available')));
        doctorReports = reports;
      }
    }
    const final = safeState(await rpc.command('get_state'));
    assert.equal(final.sessionId, initial.sessionId); assert.equal(final.isStreaming, false); assert.equal(final.isCompacting, false);
    result.final_session = final;
    assert.equal(rpc.frames.filter(frame => ['agent_start', 'tool_execution_start'].includes(frame.type) || frame.type === 'message_start' && frame.message?.role === 'assistant').length, 0, 'Metadata verification must not invoke provider or tools');
    result.rpc_frame_counts = Object.fromEntries([...new Set(rpc.frames.map(frame => frame.type))].map(type => [type, rpc.frames.filter(frame => frame.type === type).length]));
    await rpc.closeInput(); rpc = undefined;
    const observed = await observedRows(observerDir);
    result.host_process = observedDailyHostProcess(host, await ownedPiProcesses(processLedger), observed, result.launch.args);
    const doctorProof = validateDailyDoctorCli(observed, {
      library, hostPid: result.host_process.pid, entry: embedded.realpath, sha256: embedded.sha256,
      executable: result.host_process.node.path, phase: result.phases.find(phase => phase.command === '/context-broker doctor'),
    });
    const owned = (await readFile(processLedger, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    const sourceObservation = await readSourceObservation(sourceLedger);
    const sourceOwners = sourceObservation.events.filter(row => row.phase === 'source_observer_start');
    assert.equal(sourceOwners.length, 1, 'One actual Pi SDK observer owner is required');
    assert.equal(sourceOwners[0].pid, result.host_process.pid, 'SDK observation belongs to a different Pi process');
    const sdkOperations = sourceObservation.events.filter(row => row.kind === 'sdk' && row.phase === 'started');
    validateDailySdkOperations(sdkOperations, library);
    const partition = classifyDailyHttp(observed, new Set(doctorProof.processes.map(row => row.pid)), new Set(owned.filter(row => row.event === 'spawn').map(row => row.pid)), { sourceObservation });
    const http = partition.source;
    result.library_structure = validateDailyLibraryRequests(partition.sdk, library);
    const sourceDatabaseIds = [...new Set(result.library_structure.operations.flatMap(operation => operation.databases.map(database => database.database_id)))];
    result.namespace_diagnostics = validateDailyDoctor(doctorReports, namespaceReview, sourceDatabaseIds, config.expectedFindRecord.selection);
    result.other_plugin_http = partition.otherPlugins.map(request => ({ ...request, process: observed.find(row => row.event === 'process_start' && row.pid === request.pid), outcome: observed.find(row => ['http_end', 'http_error'].includes(row.event) && row.id === request.id) }));
    result.unattributed_host_http = partition.unattributedHostHttp;
    result.proxy_tunnels = partition.proxyTunnels;
    result.http_accounting_scope = 'The verified target includes every host request to api.notion.com, every complete SDK attempt and the verified bundled CLI process tree. SDK attempts are paired by PID, response request ID, method, status and request bytes. Other plugin child-process HTTP is separate. Proxy CONNECT tunnels retain their process ancestry, target and original outcomes separately; they are transport setup, do not count as application requests and cannot satisfy SDK HTTP evidence. Non-Notion host HTTP without SDK attribution remains in unattributed_host_http with its original failures or missing outcomes; it is excluded from target costs and does not establish global Pi/plugin health or zero external traffic. Worker transport is outside this passive process observer.';
    assert.ok(http.length, 'No real HTTP metadata request was observed');
    const doctorRequests = http.filter(request => request.attribution?.kind !== 'sdk');
    assert.deepEqual(doctorRequests.map(request => [request.pid, request.id]), doctorProof.http.map(request => [request.pid, request.id]),
      'Every non-SDK source request must belong to the independently verified doctor');
    for (const request of http) {
      assert.ok(observed.some(row => row.event === 'http_end' && row.pid === request.pid && row.id === request.id && row.status >= 200 && row.status < 300), 'An observed Notion request did not complete with HTTP 2xx');
    }
    assert.ok(!observed.some(row => row.event === 'spawn' && basename(row.executable ?? '') === 'ntn'), 'Official ntn was invoked');
    result.actual_default_sdk = { entry: embeddedSdk.realpath, sha256: embeddedSdk.sha256, owner_pid: sourceOwners[0].pid, operations: sdkOperations,
      http: partition.sdk, source_observation_complete: sourceObservation.complete, source_command_overridden: false, catalog_cli_children: 0 };
    result.explicit_doctor_cli = doctorProof;
    result.notion_body_requests = result.library_structure.root_children_requests + doctorProof.library_structure.root_children_requests;
    result.metadata_http_requests = http.length - result.notion_body_requests;
    result.provider_invocations = 0; result.tool_invocations = 0; result.remote_mutations = 0;
    result.skill_body_reads = 0;
    result.status = 'passed';
  } catch (error) {
    result.status = error.status === 'blocked' ? 'blocked' : 'failed'; result.error = { code: error.code ?? 'DAILY_VERIFICATION_FAILED', message: error.message };
  } finally {
    if (rpc) await rpc.stop().catch(error => { result.shutdown_error = error.message; });
    if (observedRpc) {
      await save(join(evidence, 'rpc.json'), observedRpc.frames);
      await save(join(evidence, 'rpc-lifecycle.json'), observedRpc.lifecycle);
    }
    if (result.worktrees_before) {
      result.worktrees_after = await verifyNextWorktreePair(config).catch(error => ({ status: 'failed', error: error.message }));
      result.worktrees_unchanged = JSON.stringify(result.worktrees_before) === JSON.stringify(result.worktrees_after);
      if (!result.worktrees_unchanged) result.status = 'failed';
    }
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
      result.cli_shim_after = await verifyDailyCliShim(config).catch(() => ({ validation_failed: true }));
      result.cli_shim_unchanged = JSON.stringify(result.cli_shim_after) === JSON.stringify(result.artifacts.cli_shim);
      if (!result.cli_shim_unchanged) result.status = 'failed';
    }
    if (result.host_process) {
      const { version: _version, ...node } = result.host_process.node;
      const files = [result.host.launcher, result.host_process.entry, result.host_process.package.manifest, node];
      result.host_files_unchanged = await Promise.all(files.map(async identity => {
        try { return JSON.stringify(await fileIdentity(identity.path)) === JSON.stringify({ path: identity.path, realpath: identity.realpath, bytes: identity.bytes, sha256: identity.sha256 }); }
        catch { return false; }
      })).then(results => results.every(Boolean));
      if (!result.host_files_unchanged) result.status = 'failed';
    }
    if (result.namespace_diagnostics_review) {
      const reviewed = result.namespace_diagnostics_review;
      result.reviewed_external_catalog_unchanged = hash(await readFile(reviewed.catalog.path)) === reviewed.catalog.sha256 && hash(await readFile(reviewed.path)) === reviewed.sha256;
      if (!result.reviewed_external_catalog_unchanged) result.status = 'failed';
    }
    const ownedPath = join(evidence, 'owned-processes.jsonl');
    if (await exists(ownedPath)) {
      result.owned_pi = await ownedPiProcesses(ownedPath);
      if (result.owned_pi.some(row => !row.observed_close)) result.status = 'failed';
    }
    result.finished_at = new Date().toISOString();
    if (result.status === 'passed') {
      try { validateDailyReceipt(result, config, result.worktrees_before); }
      catch (error) { result.status = 'failed'; result.error = { code: error.code ?? 'DAILY_RECEIPT_INCOMPLETE', message: error.message }; }
    }
    await save(join(evidence, 'result.json'), result);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
    console.log(`Usage:
  node scripts/verify-pi-daily-installation.mjs plan --config ABSOLUTE_CONFIG.json
  node scripts/verify-pi-daily-installation.mjs run --config ABSOLUTE_CONFIG.json
  node scripts/verify-pi-daily-installation.mjs aggregate --config ABSOLUTE_CONFIG.json
  node scripts/verify-pi-daily-installation.mjs candidate-plan --config ABSOLUTE_CONFIG.json
  node scripts/verify-pi-daily-installation.mjs candidate-run --config ABSOLUTE_CONFIG.json --live

plan: describe ordinary daily Pi diagnostics; does not execute Pi.
run: verify the committed next worktree pair, current builds, existing installation and a fresh ordinary Pi process.
aggregate: require current passed Pro/Mini daily receipts from different machines for the same delivery and real origin/next pair.
candidate-plan: validate and describe the separate project-scoped candidate; does not execute Pi.
candidate-run: execute that candidate with its specified provider/model and record actual evidence.

Each action requires an explicit version:1 JSON config and owned absolute evidence paths.
Daily runs require worktrees.cli and worktrees.broker with root and complete commit,
plus the selected cliRoot, brokerRoot, artifact hashes, library:ROOT_UUID and delivery:{id:UUID,startedAt:UTC_ISO}.
Aggregate uses the same delivery/library/worktree inputs and receipts:{pro:ABSOLUTE_RESULT_JSON,mini:ABSOLUTE_RESULT_JSON}.
Only daily receipt version 2 qualifies; candidates and source/build receipts never prove daily execution. Candidate configs require
scope:project-scoped-candidate-precheck and explicit turns, or scope:notion-agent-workflow
with scenarioFile, scenarioId, bindingsFile and profile:daily|no-native-skills.
profile:native-onboarding instead requires pairedEnvironment:{root,build}, parent,
modelsFile, passEnv, oracleFile and evidenceRoot. Build with --install-mode packed.
It uses empty native Skills, one private episode and a fresh explicit-entry grader;
it does not use daily HOME configuration or count as a daily installation result.
Natural workflows use magpie/group/worker with high thinking, retain normal extensions,
and use -ns only for the no-native-skills comparison. Broker local roots remain present.
A plan is prepared_not_executed;
a candidate does not prove the ordinary daily installation or the other machine.
These actions do not install packages or change user settings.`);
    process.exit(0);
  }
  const [action, flag, input, ...extra] = process.argv.slice(2);
  const candidate = action === 'candidate-plan' || action === 'candidate-run';
  assert.ok(['plan', 'run', 'aggregate', 'candidate-plan', 'candidate-run'].includes(action) && flag === '--config' && input
    && (action === 'candidate-run' ? extra.length === 1 && extra[0] === '--live' : !extra.length),
  'Usage: node scripts/verify-pi-daily-installation.mjs plan|run|aggregate|candidate-plan --config ABSOLUTE_CONFIG.json; candidate-run --config ABSOLUTE_CONFIG.json --live');
  const config = await json(resolve(input));
  assert.equal(config.version, 1);
  if (candidate) {
    const { candidatePlan, runCandidate } = await import('./verify-pi-daily-candidate.mjs');
    const result = action === 'candidate-plan' ? await candidatePlan(config) : await runCandidate(config, { packageClosure, fileIdentity });
    console.log(JSON.stringify(result, null, 2));
    if (action === 'candidate-run' && result.status !== 'passed') process.exitCode = 1;
  } else if (action === 'plan') console.log(JSON.stringify(plan(config), null, 2));
  else if (action === 'aggregate') {
    const result = await aggregateDailyDeliveries(config);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'passed') process.exitCode = 1;
  }
  else {
    const result = await run(config);
    console.log(JSON.stringify({ status: result.status, evidence: result.evidence, error: result.error }));
    if (result.status !== 'passed') process.exitCode = 1;
  }
}
