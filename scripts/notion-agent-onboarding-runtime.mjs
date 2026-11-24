import { parseNativeReference } from '../packages/context-broker/src/native-reference.ts';
/** Internal workers of the existing candidate workflow, invoked only inside paired run.
 * No private oracle is accepted by the subject worker or its Pi process.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { sourceObserverPreloadSource, readSourceObservation } from './skill-consumption-source-observer.mjs';
import { readNotionAgentCliProcesses } from './notion-agent-cli-process.mjs';
import { readConsumptionCostEvents } from './skill-consumption-cost.mjs';
import { readProviderTransport, providerApplicationCompletion } from './skill-consumption-provider.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const file = async path => { const bytes = await readFile(path); return { path, realpath: await realpath(path), bytes: bytes.length, sha256: hash(bytes) }; };
const canonical = value => value.replaceAll('-', '').toLowerCase();
const clock = () => process.hrtime.bigint().toString();
const rows = async path => (await readFile(path, 'utf8')).trimEnd().split('\n').filter(Boolean).map(JSON.parse);
const redact = text => Object.entries(process.env).filter(([name, value]) => /KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL/iu.test(name) && value?.length >= 4)
  .reduce((value, [, secret]) => value.split(secret).join('[redacted]'), String(text));

export function onboardingLoadObserverSource(output) {
  return `import fs from 'node:fs';
export default api => {
  const capture = (phase, ctx) => fs.appendFileSync(${JSON.stringify(output)}, JSON.stringify({phase,
    pid:process.pid,node:process.execPath,argv:process.argv,cwd:process.cwd(),
    model:{provider:ctx.model?.provider,id:ctx.model?.id},
    settings:JSON.parse(fs.readFileSync(process.env.PI_CODING_AGENT_DIR+'/settings.json','utf8')),
    agentDir:process.env.PI_CODING_AGENT_DIR,sessions:process.env.PI_CODING_AGENT_SESSION_DIR,
    cliEntry:process.env.PAIRED_CLI_ENTRY,
    commands:api.getCommands().map(({name,source,sourceInfo})=>({name,source,sourceInfo})),
    tools:api.getAllTools().map(({name,sourceInfo})=>({name,sourceInfo}))
  })+'\\n',{mode:0o600});
  api.on('session_start',(_event,ctx)=>capture('session_start',ctx));
  api.on('before_provider_request',(_event,ctx)=>capture('before_provider_request',ctx));
};\n`;
}

export function validateOnboardingLoaded(observations, run) {
  assert.ok(observations.length > 0, 'Actual native loading was not observed');
  for (const observed of observations) {
    assert.equal(observed.model.provider, 'magpie'); assert.equal(observed.model.id, 'group/worker');
    assert.deepEqual(observed.settings, run.pi_launch.settings); assert.deepEqual(observed.settings.packages, []);
    assert.equal(observed.agentDir, join(run.root, 'pi-agent')); assert.equal(observed.sessions, join(run.root, 'sessions'));
    assert.equal(observed.cliEntry, run.candidate.entries.cli);
    assert.equal(observed.argv[1], run.pi_launch.entry);
    assert.deepEqual(observed.argv.slice(2, 2 + run.pi_launch.argv.length), run.pi_launch.argv, 'The child Pi must use the common launch declaration');
    assert.ok(observed.commands.every(command => command.name !== 'context-broker' && !command.name.startsWith('skill:') && command.source !== 'skill'), 'No Broker or preloaded native Skill is allowed');
    assert.ok(observed.tools.every(tool => !tool.name.startsWith('notion_')), 'Native onboarding cannot load Broker tools');
  }
  return { status: 'passed', observations: observations.length, pids: [...new Set(observations.map(row => row.pid))] };
}

async function privateRun(kind, input) {
  const root = process.env.PAIRED_RUN_ROOT;
  assert.ok(root && isAbsolute(root) && await realpath(root) === root, 'Use the paired command launcher');
  const run = await json(join(root, 'run.json'));
  assert.equal(run.target, 'command'); assert.equal(run.pi_launch.mode, 'native'); assert.equal(run.candidate.mode, 'packed');
  assert.equal(run.pi_launch.native_skill_roots.length, 1);
  assert.deepEqual(await readdir(run.pi_launch.native_skill_roots[0]), [], 'The native Skills directory must start empty');
  assert.deepEqual(await json(join(root, 'config/cli/config.json')), kind === 'library' ? { default_library: input.libraryId } : {});
  for (const path of ['state/cli', 'cache/cli', 'data/cli', 'state/scheduler', 'sessions']) assert.deepEqual(await readdir(join(root, path)), [], 'A fresh run cannot inherit ' + path);
  assert.equal(run.remote[kind], kind === 'library' ? input.libraryId : input.parent);
  assert.equal(run.remote[kind === 'parent' ? 'library' : 'parent'], null);
  assert.equal(process.env.PAIRED_CLI_ENTRY, run.candidate.entries.cli);
  return run;
}

async function notionGet(path) {
  assert.ok(process.env.NOTION_API_TOKEN, 'The authorized Notion identity must be passed by name');
  const origin = process.env.NOTION_API_BASE_URL ?? 'https://api.notion.com';
  const response = await fetch(origin.replace(/\/$/u, '') + '/' + path, { headers: { Authorization: 'Bearer ' + process.env.NOTION_API_TOKEN, 'Notion-Version': '2025-09-03' }, signal: AbortSignal.timeout(30000) });
  const value = await response.json(); assert.ok(response.ok, 'Read-only parent check failed: ' + response.status);
  return value;
}

export async function runOnboardingEpisode(inputPath) {
  const input = await json(inputPath), run = await privateRun('parent', input), root = run.root;
  assert.deepEqual(Object.keys(input).sort(), ['version', 'parent', 'readme', 'turns', 'timeoutMs'].sort(), 'Subject input contains private controller fields');
  const result = { version: 1, status: 'running', runId: run.run_id, parent: input.parent, startedNs: clock(), turns: [],
    sessionFile: null, sessionId: null, remoteEffects: 'unknown_until_independent_readback' };
  const control = join(root, 'observation'), processes = join(control, 'node-processes'); await mkdir(control); await mkdir(processes);
  const observationRoot = dirname(run.pi_launch.extensions.find(extension => extension.path.endsWith('/loaded.mjs')).path);
  let rpc, failure, timer;
  const interrupt = () => { failure ??= new Error('Onboarding episode interrupted; reconcile remote writes before retrying'); void rpc?.stop().catch(() => {}); };
  process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
  try {
    assert.deepEqual(await file(input.readme.path), input.readme, 'The public README changed');
    const parent = await notionGet('v1/pages/' + input.parent), children = await notionGet('v1/blocks/' + input.parent + '/children?page_size=100');
    await save(join(root, 'parent-before.json'), { parent, children });
    assert.equal(canonical(parent.id), canonical(input.parent)); assert.ok(!parent.archived && !parent.in_trash);
    assert.deepEqual(children.results, [], 'The authorized parent must be empty before the first model request');
    assert.equal(children.has_more, false);
    result.initialState = { status: 'empty', parentArtifact: await file(join(root, 'parent-before.json')), config: await file(join(root, 'config/cli/config.json')), state: 'empty', nativeSkills: 'empty' };
    const source = join(control, 'source.mjs'), sourceOutput = join(control, 'source.jsonl');
    await writeFile(source, sourceObserverPreloadSource({ output: sourceOutput, checkoutRoot: resolve(import.meta.dirname, '..'), clockId: randomUUID(),
      processDirectory: processes, cliPath: process.env.PAIRED_CLI_ENTRY, ownerParentPid: process.pid, ownerEntry: join(root, 'bin/pi') }), { flag: 'wx', mode: 0o600 });
    timer = setTimeout(() => { failure = new Error('Onboarding episode timed out; remote effects require reconciliation'); void rpc?.stop().catch(() => {}); }, input.timeoutMs);
    rpc = await startRpc({ host: join(root, 'bin/pi'), cwd: join(root, 'workspace'),
      env: { ...process.env, NODE_OPTIONS: '--import=' + JSON.stringify(source) },
      args: ['--provider', 'magpie', '--model', 'group/worker', '--thinking', 'high'], timeoutMs: input.timeoutMs });
    const state = await rpc.command('get_state'); result.sessionId = state.sessionId; result.sessionFile = state.sessionFile;
    assert.equal(state.model?.provider, 'magpie'); assert.equal(state.model?.id, 'group/worker'); assert.equal(state.thinkingLevel, 'high');
    assert.ok(state.sessionFile.startsWith(join(root, 'sessions') + '/'));
    validateOnboardingLoaded(await rows(join(observationRoot, 'loaded.jsonl')), run);
    for (const turn of input.turns) {
      if (failure) throw failure;
      const record = { id: turn.id, status: 'running', promptSha256: hash(turn.prompt), startedNs: clock() }; result.turns.push(record);
      await rpc.prompt(turn.prompt);
      const after = await rpc.command('get_state');
      assert.equal(after.sessionId, state.sessionId, 'All onboarding turns must stay in the same episode');
      assert.equal(after.sessionFile, state.sessionFile);
      record.endedNs = clock(); record.status = 'completed';
    }
    await rpc.closeInput(); if (failure) throw failure;
    const { inspectNotionAgentSession } = await import('./notion-agent-analysis.mjs');
    const sessionText = await readFile(result.sessionFile, 'utf8');
    result.session = inspectNotionAgentSession(sessionText, { expectedSessionId: result.sessionId, expectedUserMessages: input.turns.length });
    const final = sessionText.trimEnd().split('\n').map(JSON.parse).find(row => row.id === result.session.currentFinal.entryId);
    result.finalOutput = (final.message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    assert.equal(hash(result.finalOutput), result.session.currentFinal.sha256);
    result.loaded = validateOnboardingLoaded(await rows(join(observationRoot, 'loaded.jsonl')), run);
    const sourceObservation = await readSourceObservation(sourceOutput);
    const expectedEntries = [await file(process.env.PAIRED_CLI_ENTRY)];
    result.cliProcesses = await readNotionAgentCliProcesses({ directory: processes, sourceObservation, expectedEntries, min: 1 });
    assert.equal(result.cliProcesses.status, 'passed', 'Actual candidate CLI process identity is unproven');
    for (const turn of result.turns) turn.cliProcesses = await readNotionAgentCliProcesses({ directory: processes, sourceObservation, expectedEntries,
      window: { startNs: turn.startedNs, endNs: turn.endedNs }, min: 0 });
    const cost = await readConsumptionCostEvents(join(observationRoot, 'cost.jsonl'));
    const transport = await readProviderTransport(join(observationRoot, 'transport.jsonl'));
    const { candidateTransportCoverage } = await import('./verify-pi-daily-candidate.mjs');
    result.transportCoverage = candidateTransportCoverage(transport);
    result.requests = cost.events.filter(row => row.phase === 'provider_request').map(request => {
      assert.equal(request.provider, 'magpie'); assert.equal(request.model, 'group/worker'); assert.equal(request.requestModel, 'group/worker');
      const sent = transport.filter(row => row.phase === 'request_sent' && row.requestBodySha256 === request.payload.sha256 && row.requestBodyBytes === request.payload.bytes);
      assert.equal(sent.length, 1, 'A model request must match one actual HTTP body');
      const terminal = transport.find(row => row.phase === 'request_end' && row.id === sent[0].id);
      const message = cost.events.find(row => row.phase === 'message_end' && row.request === request.request && row.message?.role === 'assistant')?.message;
      return { turn: request.turn, request: request.request, provider: request.provider, model: request.model, requestModel: request.requestModel,
        payload: request.payload, transportId: sent[0].id, terminal, response: message ?? null, completion: providerApplicationCompletion(terminal, message) };
    });
    assert.ok(result.requests.length > 0, 'No actual model request was observed');
    for (let turn = 1; turn <= input.turns.length; turn++) assert.ok(result.requests.filter(row => row.turn === turn).at(-1)?.completion, 'A turn has no completed provider response');
    result.status = 'passed';
  } catch (error) { failure ??= error; result.status = 'failed'; result.error = redact(error.message); }
  finally {
    clearTimeout(timer); process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
    if (rpc) {
      await rpc.stop().catch(error => { result.status = 'failed'; result.shutdownError = redact(error.message); });
      await save(join(root, 'rpc-frames.json'), rpc.frames); result.lifecycle = rpc.lifecycle;
    }
    result.endedNs = clock(); await save(join(root, 'episode.json'), result);
  }
  if (result.status !== 'passed') process.exitCode = 1;
}

async function publicCli(run, args, number) {
  const path = join(run.root, 'readback-commands', String(number).padStart(4, '0') + '.json');
  const outcome = await new Promise(resolveCommand => {
    const child = spawn(process.execPath, [process.env.PAIRED_CLI_ENTRY, ...args], { cwd: join(run.root, 'workspace'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [], errors = []; let timedOut = false, spawnError, kill;
    child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk));
    child.once('error', error => { spawnError = error.message; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); kill = setTimeout(() => child.kill('SIGKILL'), 2000); }, 120000);
    child.once('close', (exitCode, signal) => { clearTimeout(timer); clearTimeout(kill); resolveCommand({ exitCode, signal, timedOut,
      stdout: redact(Buffer.concat(output).toString('utf8')), stderr: redact(Buffer.concat(errors).toString('utf8')), ...(spawnError ? { spawnError: redact(spawnError) } : {}) }); });
  });
  await save(path, { argv: [process.execPath, process.env.PAIRED_CLI_ENTRY, ...args], ...outcome });
  assert.equal(outcome.exitCode, 0, 'Public readback command failed; retained ' + path); assert.equal(outcome.timedOut, false);
  const value = JSON.parse(outcome.stdout); assert.equal(value.ok, true);
  return value;
}

export function validateOnboardingLibrary(initialized, inspected, input) {
  assert.equal(initialized.contract, 'current'); assert.equal(initialized.reused, true, 'Fresh grading must attach an existing library without creating or repairing it');
  assert.equal(inspected.contract, 'current'); assert.equal(initialized.library.version, 2);
  assert.deepEqual(initialized.library, inspected.library, 'Schema validation and descriptor inspection disagree');
  assert.deepEqual(initialized.library, input.library, 'The fresh library identity differs from the actual episode output');
  const library = initialized.library;
  assert.equal(canonical(library.library_id), canonical(input.libraryId), 'The Library identity must be its exact root page');
  assert.equal(Object.hasOwn(library, 'parent_page_id'), false, 'Ready descriptors do not retain a second parent identity');
  for (const role of ['skills', 'files', 'records', 'sources']) {
    assert.ok(typeof library[role]?.database_id === 'string' && typeof library[role]?.data_source_id === 'string');
    assert.ok(library[role].property_ids && Object.keys(library[role].property_ids).length > 0);
  }
  assert.equal(new Set(['skills', 'files', 'records', 'sources'].map(role => canonical(library[role].database_id))).size, 4);
  assert.equal(new Set(['skills', 'files', 'records', 'sources'].map(role => canonical(library[role].data_source_id))).size, 4);
  return library;
}

/** Separate real Notion observations from the descriptor being graded. */
export function validateOnboardingPlacement(library, input, observed) {
  const root = observed.root;
  assert.equal(root.object, 'page'); assert.equal(canonical(root.id), canonical(input.libraryId));
  assert.ok(!root.archived && !root.in_trash, 'The Library root must be live');
  assert.equal(root.parent?.type, 'page_id');
  assert.equal(canonical(root.parent.page_id), canonical(input.parent), 'The real root belongs to another authorized container');
  for (const role of ['skills', 'files', 'records', 'sources']) {
    const binding = library[role], database = observed.databases[role], source = observed.dataSources[role];
    assert.equal(database.object, 'database'); assert.equal(canonical(database.id), canonical(binding.database_id));
    assert.ok(!database.archived && !database.in_trash);
    assert.equal(database.parent?.type, 'page_id'); assert.equal(canonical(database.parent.page_id), canonical(input.libraryId), 'A registered DB is not directly under the root');
    assert.equal(database.data_sources?.length, 1); assert.equal(canonical(database.data_sources[0].id), canonical(binding.data_source_id));
    assert.equal(source.object, 'data_source'); assert.equal(canonical(source.id), canonical(binding.data_source_id));
    assert.ok(!source.archived && !source.in_trash);
    assert.equal(source.parent?.type, 'database_id'); assert.equal(canonical(source.parent.database_id), canonical(binding.database_id), 'A data source belongs to another DB');
  }
  return { root: input.libraryId, outerParent: input.parent, verifiedRoles: ['skills', 'files', 'records', 'sources'] };
}

export function validateOnboardingSnapshot(main, listed, record, library) {
  assert.deepEqual(main.record, record); assert.equal(record.locator.type, 'shared_skill');
  assert.equal(record.locator.library_id, library.library_id); assert.equal(canonical(record.locator.database_id), canonical(library.skills.database_id));
  assert.equal(canonical(record.locator.data_source_id), canonical(library.skills.data_source_id));
  assert.equal(main.path, 'SKILL.md'); assert.equal(main.entrypoint, 'SKILL.md');
  assert.ok(typeof main.snapshot_id === 'string' && main.snapshot_id); assert.ok(typeof main.version_id === 'string' && main.version_id);
  assert.equal(main.source, 'notion'); assert.equal(main.freshness.policy, 'refresh'); assert.equal(main.freshness.stale, false);
  assert.equal(main.materialization.manifest_complete, true); assert.equal(typeof main.content, 'string');
  assert.equal(main.has_more, false); assert.equal(main.range.start, 1);
  assert.equal(main.range.end, main.range.total_lines); assert.equal(main.range.total_lines, main.content.split('\n').length);
  assert.equal(main.effects.remote_writes, 'none'); assert.equal(main.effects.author_content, 'unchanged');
  for (const key of ['record', 'scope', 'snapshot_id', 'version_id', 'entrypoint', 'ref', 'file_bindings']) assert.deepEqual(listed[key], main[key], 'Directory differs at ' + key);
  assert.equal(listed.source, 'local_snapshot'); assert.equal(listed.freshness.policy, 'pinned'); assert.equal(listed.materialization.manifest_complete, true);
  // The current files contract is a complete manifest, not a paginated fallback.
  if (Object.hasOwn(listed, 'has_more')) assert.equal(listed.has_more, false, 'A partial file directory cannot be graded');
  if (Object.hasOwn(listed, 'next_cursor')) assert.equal(listed.next_cursor, null);
  assert.ok(Array.isArray(listed.files) && Array.isArray(main.file_bindings));
  assert.equal(new Set(listed.files.map(file => file.path)).size, listed.files.length);
  assert.equal(new Set(main.file_bindings.map(file => file.file_id)).size, main.file_bindings.length);
  assert.ok(main.file_bindings.every(binding => listed.files.some(file => file.path === binding.path)));
  assert.equal(new Set(main.file_bindings.map(file => file.path)).size, main.file_bindings.length);
  assert.equal(new Set(main.file_bindings.map(file => file.page_id)).size, main.file_bindings.length);
  for (const descriptor of listed.files) {
    assert.ok(typeof descriptor.path === 'string' && !isAbsolute(descriptor.path) && !descriptor.path.includes('\\') && !descriptor.path.includes('\0') && descriptor.path.split('/').every(part => part && part !== '.' && part !== '..'));
    assert.ok(Number.isSafeInteger(descriptor.bytes) && descriptor.bytes >= 0); assert.match(descriptor.sha256, /^[a-f0-9]{64}$/u);
    const binding = main.file_bindings.find(file => file.path === descriptor.path), ref = parseNativeReference(descriptor.ref);
    if (binding) assert.ok(typeof binding.file_id === 'string' && binding.file_id && typeof binding.page_id === 'string' && binding.page_id);
    assert.equal(ref.selector, record.id); assert.equal(ref.path, descriptor.path); assert.equal(ref.snapshot, main.snapshot_id);
  }
  const entrypoint = listed.files.find(file => file.path === main.path); assert.ok(entrypoint);
  assert.equal(main.ref, entrypoint.ref); assert.equal(Buffer.byteLength(main.content), entrypoint.bytes); assert.equal(hash(main.content), entrypoint.sha256);
  return listed.files;
}

export function validateOnboardingFileOutput(read, main, descriptor, bytes, output) {
  for (const key of ['record', 'scope', 'snapshot_id', 'version_id', 'entrypoint', 'file_bindings']) assert.deepEqual(read[key], main[key], 'Supporting read differs at ' + key);
  assert.equal(read.path, descriptor.path); assert.equal(read.ref, descriptor.ref);
  assert.equal(read.source, 'local_snapshot'); assert.equal(read.freshness.policy, 'pinned'); assert.equal(read.materialization.manifest_complete, true);
  assert.ok(read.materialization.materialized_paths.includes(descriptor.path));
  assert.equal(read.effects.remote_writes, 'none'); assert.equal(read.effects.author_content, 'unchanged');
  assert.equal(read.output, output); assert.equal(read.reused, false);
  // --output returns full bytes and checksums, including binary/empty files; it has no text range.
  assert.equal(read.bytes, descriptor.bytes); assert.equal(read.sha256, descriptor.sha256); assert.equal(read.entrypoint_sha256, hash(main.content));
  assert.equal(bytes.length, descriptor.bytes); assert.equal(hash(bytes), descriptor.sha256);
}

export async function runOnboardingGrader(inputPath) {
  const input = await json(inputPath), run = await privateRun('library', input);
  const result = { version: 1, status: 'running', complete: false, runId: run.run_id, parent: input.parent, libraryId: input.libraryId, skills: [], commands: 0 };
  await mkdir(join(run.root, 'readback-commands')); await mkdir(join(run.root, 'readback-files'));
  const cli = args => publicCli(run, args, ++result.commands);
  try {
    const initialized = await cli(['ctl', 'library', 'init', '--library', input.libraryId]);
    const inspected = await cli(['ctl', 'library', 'inspect', '--library', input.libraryId]);
    result.library = validateOnboardingLibrary(initialized, inspected, input);
    const placement = { root: await notionGet('v1/pages/' + input.libraryId), databases: {}, dataSources: {} };
    for (const role of ['skills', 'files', 'records', 'sources']) {
      placement.databases[role] = await notionGet('v1/databases/' + result.library[role].database_id);
      placement.dataSources[role] = await notionGet('v1/data_sources/' + result.library[role].data_source_id);
    }
    await save(join(run.root, 'library-placement.json'), placement);
    result.libraryValidation = { status: 'passed', command: 'ctl library init --library', reused: initialized.reused,
      placement: validateOnboardingPlacement(result.library, input, placement), artifact: await file(join(run.root, 'library-placement.json')) };
    const catalog = await cli(['list', '--library', input.libraryId, '--refresh', '--json']);
    assert.equal(canonical(catalog.library_id), canonical(input.libraryId));
    assert.equal(catalog.has_more, false); assert.equal(catalog.next_cursor, null); assert.ok(Array.isArray(catalog.records));
    assert.equal(catalog.count, catalog.records.length); assert.equal(catalog.total_count, catalog.records.length);
    assert.equal(catalog.coverage.method, 'explicit_library'); assert.equal(catalog.coverage.exhaustive, true);
    assert.deepEqual(catalog.coverage.failed_sources, []); assert.equal(catalog.coverage.search_index_limited, false);
    assert.deepEqual(catalog.coverage.queried_data_sources, [result.library.skills.data_source_id]);
    assert.equal(catalog.databases.length, 1); assert.deepEqual(catalog.databases[0].shared_library, result.library);
    assert.equal(catalog.source, 'notion'); assert.equal(catalog.freshness.policy, 'refresh'); assert.equal(catalog.freshness.stale, false);
    // list exposes directory completeness; unlike read it need not emit effects.
    if (catalog.effects !== undefined) assert.equal(catalog.effects.remote_writes, 'none');
    for (const record of catalog.records) {
      const pageId = record.locator?.page_id; assert.ok(typeof pageId === 'string');
      const main = await cli(['read', pageId, '--library', input.libraryId, '--refresh', '--json']);
      assert.equal(main.has_more, false); assert.equal(typeof main.content, 'string'); assert.equal(main.effects?.remote_writes, 'none');
      assert.equal(canonical(main.record.locator.page_id), canonical(pageId)); assert.equal(main.record.id, record.id);
      const listed = await cli(['files', main.snapshot_id]);
      const directory = validateOnboardingSnapshot(main, listed, record, result.library);
      const skill = { name: record.name, record, ref: main.ref, snapshotId: main.snapshot_id, versionId: main.version_id, files: [] }; result.skills.push(skill);
      const base = join(run.root, 'readback-files', String(result.skills.length)); await mkdir(base);
      for (const descriptor of directory) {
        const output = join(base, descriptor.path); await mkdir(dirname(output), { recursive: true });
        let bytes;
        if (descriptor.path === main.path) { bytes = Buffer.from(main.content); await writeFile(output, bytes, { flag: 'wx', mode: 0o600 }); }
        else {
          const read = await cli(['read', descriptor.path, '--from', main.ref, '--output', output, '--json']);
          bytes = await readFile(output); assert.equal(await realpath(output), output);
          validateOnboardingFileOutput(read, main, descriptor, bytes, output);
        }
        skill.files.push({ path: descriptor.path, complete: true, artifact: await file(output), bytes: bytes.length, sha256: hash(bytes), content: bytes.toString('utf8'), descriptor });
      }
    }
    result.status = 'read_back'; result.complete = true;
  } catch (error) { result.status = 'failed'; result.error = redact(error.message); process.exitCode = 1; }
  await save(join(run.root, 'readback.json'), result);
}
