#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { createRequestLedger } from './notion-default-context.mjs';
import { observe } from './notion-integration-model.mjs';
import { verificationCliEnvironment } from './verification-paths.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const rows = async path => { try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const hash = value => createHash('sha256').update(value).digest('hex');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function requestCounts(events) {
  const starts = events.filter(row => row.phase === 'started');
  const remote = events.filter(row => row.kind === 'http' && row.phase === 'attempt' && row.request_kind !== 'provider');
  const body = remote.filter(row => row.request_kind === 'notion_body');
  const writes = remote.filter(row => row.request_kind === 'notion_write');
  const complete = starts.filter(row => row.kind === 'cli').every(row => events.some(receipt => receipt.kind === 'metrics' && receipt.phase === 'metrics' && receipt.requestId === row.requestId && receipt.observed === true && receipt.complete === true));
  return { complete, cli: starts.filter(row => row.kind === 'cli').length, reads: starts.filter(row => row.kind === 'cli' && row.command === 'read').length, exports: starts.filter(row => row.kind === 'cli' && row.command === 'export').length, notion: remote.length, notionBody: body.length, notionWrites: writes.length };
}

export function cacheCaseDirectory(scratch, evidence, name) {
  assert.ok(isAbsolute(scratch) && isAbsolute(evidence) && /^[a-z0-9-]+$/.test(name));
  return join(scratch, 'runs', basename(evidence), name);
}

export function modelAvailabilityFailure(events) {
  const responses = events.filter(event => event.phase === 'response');
  const final = events.filter(event => event.phase === 'assistant_final').at(-1);
  const status = responses.find(event => [401, 402, 403, 404, 429, 503].includes(event.status))?.status;
  const notice = final?.text && /(?:requires? (?:a )?premium|premium (?:license|subscription)|license (?:is )?required|insufficient (?:credits|quota)|model (?:is )?(?:unavailable|not available|not found)|模型.{0,16}(?:不可用|无权限)|余额不足)/i.test(final.text);
  return Boolean(status || notice && !events.some(event => event.phase === 'tool_call'));
}

export function assertModelCase(events, expected, { native = false, explicit = false, cold = false, warm = false, coldCli = false, warmBroker = false, revalidated = false, expectedSnapshot, requestEvents = [] } = {}) {
  const requests = events.filter(row => row.phase === 'request');
  const finals = events.filter(row => row.phase === 'assistant_final' && row.success && row.bytes > 0);
  const toolResults = events.filter(row => row.phase === 'tool_result');
  const counts = requestCounts(requestEvents);
  assert.equal(counts.complete, true, 'Every driven CLI operation must retain a complete HTTP attempt ledger; missing metrics do not prove zero requests');
  assert.ok(requests.length && events.some(row => row.phase === 'response' && row.status >= 200 && row.status < 300), 'Actual provider request and HTTP success required');
  assert.ok(finals.length, 'Successful nonempty real-model final required');
  const final = finals.at(-1);
  for (const token of expected) assert.ok(final.text.includes(token), `Final answer must use the selected source value: ${token}`);
  assert.ok(requests.every(row => row.skillBodies <= 1), 'Repeated loading must never duplicate the instruction body');
  assert.ok(requests.some(row => row.skillBodies === 1), 'Provider must receive the selected instruction body');
  assert.ok(requests.some(row => row.resourceBodies > 0), 'Provider must consume actual resource bytes, including a retained prior tool result');
  assert.ok(requests.every(row => Array.isArray(row.completeContents)), 'Every actual provider request must retain complete-file byte/hash receipts');
  assert.ok(requests.every(row => row.completeContents.filter(item => item.role === 'entrypoint').reduce((sum, item) => sum + item.copies, 0) <= 1), 'Complete main instruction bytes must remain a single provider copy');
  assert.ok(requests.some(row => row.completeContents.some(item => item.role === 'entrypoint' && item.copies === 1 && item.manifestComplete)), 'Provider must receive the complete verified main, not only its marker');
  assert.ok(requests.some(row => row.completeContents.some(item => item.role === 'resource' && item.copies > 0 && item.manifestComplete)), 'Provider must receive a complete verified resource file');
  assert.ok(!toolResults.some(row => row.isError), 'A claimed pass cannot hide a failed selected-resource read');
  assert.ok(!events.some(row => row.phase === 'tool_call' && row.allowed === false), 'A claimed pass cannot hide a blocked out-of-scope read');
  if (expectedSnapshot) {
    assert.ok(toolResults.filter(row => row.receiptValidated).every(row => row.snapshot === expectedSnapshot), 'Entry and resources must use the expected fixed snapshot, regardless of the final answer');
    assert.ok(requests.flatMap(row => row.completeContents).every(row => row.snapshot === expectedSnapshot), 'Complete provider files must use the expected fixed snapshot');
  }
  if (native) {
    assert.equal(requests[0].skillBodies, 0, 'Autonomous first request must see metadata, not a pre-injected body');
    assert.ok(toolResults.some(row => row.kind === 'skill' && row.role === 'entrypoint' && row.bodyMatchesFile && row.receiptValidated), 'Model must choose and successfully read the exact native entry');
  }
  if (explicit) assert.equal(requests[0].skillBodies, 1, 'Explicit dollar/native activation must finish before the first provider request');
  if (cold) {
    assert.ok(counts.notionBody > 0, 'Empty CLI/Broker caches must produce an actual Notion body read');
    assert.ok(counts.exports > 0 || requests.some(row => row.completeContents.some(item => item.materialization === 'entry' && item.manifestComplete)), 'Cold content needs a verified complete export or an explicit complete-manifest entry materialization');
  }
  if (warm) assert.equal(counts.notionBody, 0, 'Warm content reuse must not download Notion bodies');
  if (coldCli) assert.ok(counts.notionBody > 0, 'An empty CLI cannot claim a verified current body from a Broker directory alone');
  if (warmBroker) assert.equal(counts.exports, 0, 'An already verified immutable Broker export should not be exported again');
  if (revalidated) assert.ok(counts.notion > 0, 'Expired current state must actually revalidate Notion');
  assert.equal(counts.notionWrites, 0, 'Ordinary host loading must not mutate the pre-initialized fixture');
  return { requests: counts, providerRequests: requests.length, completeProviderContents: requests.map(row => row.completeContents), skillReads: toolResults.filter(row => row.kind === 'skill' && row.bodyMatchesFile).length, resourceReads: toolResults.filter(row => row.resourceSuccess).length, snapshots: [...new Set([...toolResults.map(row => row.snapshot), ...requests.flatMap(row => row.completeContents.map(item => item.snapshot))].filter(Boolean))], final: { text: final.text, textSha256: final.textSha256, stopReason: final.stopReason, usage: final.usage } };
}

export async function runMatrix(options) {
  const fixture = await json(options.fixture);
  assert.ok(['magpie/group/flash-free', 'magpie/group/worker'].includes(options.model), 'Use one of the explicitly authorized model selectors');
  for (const key of ['fixture', 'extension', 'cli', 'evidence-root']) assert.ok(isAbsolute(options[key] ?? ''), `${key} must be absolute`);
  let previousFailure;
  if (options.model === 'magpie/group/worker') {
    assert.ok(isAbsolute(options['previous-failure'] ?? ''), 'Worker requires this final package\'s retained actual flash-free availability failure');
    const prior = await json(options['previous-failure']);
    assert.equal(prior.model, 'magpie/group/flash-free'); assert.equal(prior.status, 'failed'); assert.equal(prior.availabilityFailure, true);
    assert.equal(prior.extensionSha256, hash(await readFile(options.extension))); assert.equal(prior.cliSha256, hash(await readFile(options.cli)));
    previousFailure = { path: await realpath(options['previous-failure']), sha256: hash(await readFile(options['previous-failure'])) };
  } else assert.equal(options['previous-failure'], undefined, 'Flash-free runs do not inherit a fallback failure');
  assert.ok(fixture.record?.locator?.type === 'shared_skill' && fixture.record.enabled && fixture.expected?.length === 4 && fixture.resourceContent && fixture.marker);
  const evidence = await mkdtemp(join(options['evidence-root'], 'pi-cache-evidence-'));
  const scratch = options.resume ? (await json(join(options.resume, 'manifest.json'))).scratch : await mkdtemp(join(await realpath(tmpdir()), 'pi-model-cache-'));
  const phase = options.resume ? 'updated' : 'initial';
  if (!options.resume) await save(join(scratch, 'ownership.json'), { evidence });
  else assert.equal((await json(join(scratch, 'ownership.json'))).evidence, options.resume);
  const manifest = { version: 1, status: 'running', phase, evidence, scratch, resumeCase: options['resume-case'] ?? 'cold-autonomous-native', model: options.model, previousFailure, availabilityFailure: false, fixture: options.fixture, runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))), extension: options.extension, extensionSha256: hash(await readFile(options.extension)), cli: options.cli, cliSha256: hash(await readFile(options.cli)), cases: [], notRun: ['OMP/Tern', 'native visual composer interactions', 'provider server-side cache control'], boundary: 'Real installed Pi and Broker, project direct HTTP attempt ledger, real model; source/model credentials consumed in place and never copied. Oracle roots are never used as consumer roots.' };
  await save(join(evidence, 'manifest.json'), manifest);
  console.log(JSON.stringify({ evidence, scratch, phase, model: options.model }));
  const ledgerFile = join(evidence, 'owned-processes.jsonl');
  await writeFile(ledgerFile, '', { mode: 0o600 });
  // Keep the effective source command byte-for-byte stable across an A/B
  // continuation. Replacing a tracing wrapper changes model-visible CLI
  // guidance and is not part of a native content update.
  const requestsRoot = join(scratch, 'initial-requests');
  let ledger;
  if (options.resume) {
    const commandFile = join(requestsRoot, 'source-ledger.json'), cfg = await json(commandFile);
    const originalStates = await json(join(options.resume, 'states.json'));
    const originalState = originalStates[manifest.resumeCase];
    assert.ok(originalState?.base?.startsWith(scratch + '/'), 'Resume case must belong to the original owned scratch');
    const originalConfig = await json(join(originalState.base, 'broker-initial.json'));
    const originalCommand = originalConfig.sources?.[0]?.command;
    assert.deepEqual(originalCommand, [process.execPath, fileURLToPath(new URL('./notion-default-context.mjs', import.meta.url)), '--request-ledger', commandFile]);
    assert.deepEqual(cfg.command, [process.execPath, options.cli], 'Resumed source command must select the same installed CLI');
    assert.equal(cfg.ledger, join(options.resume, 'safe-source-requests.jsonl'));
    assert.equal(await realpath(commandFile), commandFile);
    ledger = { command: originalCommand, ledger: cfg.ledger };
  } else {
    await mkdir(requestsRoot, { recursive: true, mode: 0o700 });
    ledger = await createRequestLedger({ scratch: requestsRoot, evidence, command: [process.execPath, options.cli] });
  }
  const phaseLedgerStart = (await rows(ledger.ledger)).length;
  manifest.requestLedger = { path: ledger.ledger, firstRow: phaseLedgerStart, stableCommand: ledger.command };
  const selector = fixture.record.id;
  const selected = { selector, physicalSelector: fixture.record.locator.page_id, locator: fixture.record.locator, id: selector, kind: fixture.record.kind, entry: fixture.record.entrypoint, ref: fixture.record.ref };
  const prompt = `请使用 ${fixture.alias} 工作流。实际读取附带的 ${fixture.resource}，只报告当前已选版本的工作流修订、检查表修订、发布闸门、证据代号，再用一句话解释结论。不要猜测版本，不执行任何写入。`;
  const invocation = `$${fixture.alias}@notion ${prompt}`;
  const nativeName = `notion-${fixture.alias}`.replace(/[^a-z0-9-]/g, '-');
  let active;
  const states = options.resume ? (await json(join(options.resume, 'states.json'))) : {};
  const stop = async () => { if (active) { const value = active; active = undefined; await value.rpc.stop(); } };
  async function boot(name, { cliRoot, cache, sessionDir, session, maxAge, newSession = true } = {}) {
    await stop();
    const base = cacheCaseDirectory(scratch, evidence, name);
    await mkdir(base, { recursive: true, mode: 0o700 });
    cliRoot ??= join(base, 'cli'); cache ??= join(base, 'broker-cache'); sessionDir ??= join(base, 'sessions');
    const cliExistedBeforeHost = await access(cliRoot).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    await mkdir(cache, { recursive: true, mode: 0o700 }); const brokerEntriesBeforeHost = (await readdir(cache)).length; await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const config = join(base, 'broker-' + phase + '.json');
    await save(config, { sources: [{ type: 'notion', id: 'notion', namespace: 'notion', command: ledger.command, database: fixture.database, default_view_id: fixture.view, prefetch: false, cacheDir: cache, requestTimeoutMs: 30000, ...(maxAge ? { activation: { maxAge }, discovery: { maxAge } } : {}) }] });
    const capture = join(evidence, name + '-observer.jsonl');
    await writeFile(capture, '', { mode: 0o600 });
    const slash = options.model.indexOf('/');
    const settings = { model: options.model, provider: options.model.slice(0, slash), id: options.model.slice(slash + 1), marker: fixture.marker, alias: fixture.alias, selected, cache: await realpath(cache), cwd: base, output: capture, expectedResourceBodies: [fixture.resourceContent] };
    if (options.resume) settings.expectedResourceBodies.push((await json((await json(join(options.resume, 'manifest.json'))).fixture)).resourceContent);
    const observer = join(base, 'model-observer-' + phase + '.mjs');
    await writeFile(observer, `import * as fs from 'node:fs';import * as crypto from 'node:crypto';import * as path from 'node:path';export default api=>(${observe.toString()})(api,{...${JSON.stringify(settings)},fs,crypto,path});\n`, { mode: 0o600 });
    const env = { ...verificationCliEnvironment(cliRoot), CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_HOST: 'pi', CONTEXT_BROKER_LOG_FILE: join(evidence, name + '-decisions.jsonl'), BROKER_E2E_PROCESS_LEDGER: ledgerFile };
    const args = ['--no-extensions', '--session-dir', sessionDir, '--no-mcp', '--no-context-files', '--no-prompt-templates', '--tools', 'read', '-e', options.extension, '-e', observer, '--model', options.model, ...(session ? ['--session', session] : [])];
    const startupAt = Date.now();
    const rpc = await startRpc({ host: 'pi', cwd: base, env, args, timeoutMs: 300000 });
    const state = await rpc.command('get_state');
    active = { rpc, base, cliRoot, cache, sessionDir, capture, state, env, name, newSession, cliExistedBeforeHost, brokerEntriesBeforeHost, startupMs: Date.now() - startupAt, firstTurn: true };
    return active;
  }
  async function turn(name, message, policy = {}, expected = fixture.expected) {
    assert.ok(active, 'A real host must be running');
    if (policy.coldCli || policy.cold) assert.equal(active.cliExistedBeforeHost, false, 'Cold case must allocate a new CLI root, including after a prior failed run');
    const frameBefore = active.rpc.frames.length;
    const obsBefore = (await rows(active.capture)).length, traceBefore = (await rows(ledger.ledger)).length, started = Date.now();
    const result = { name, status: 'running', model: options.model, session: active.state.sessionFile ?? null, cacheRoot: active.cache, cliRoot: active.cliRoot, prelaunch: { cliRootExisted: active.cliExistedBeforeHost, brokerRootEntries: active.brokerEntriesBeforeHost }, policy, startupMs: active.firstTurn ? active.startupMs : 0, startedAt: new Date(started).toISOString() };
    manifest.cases.push(result); await save(join(evidence, 'manifest.json'), manifest);
    try {
      await active.rpc.prompt(message);
      const events = (await rows(active.capture)).slice(obsBefore), requests = (await rows(ledger.ledger)).slice(traceBefore);
      Object.assign(result, assertModelCase(events, expected, { expectedSnapshot: fixture.snapshot, explicit: message.startsWith('$') || message.startsWith('/skill:'), ...policy, requestEvents: requests }), { status: 'passed' });
      const state = await active.rpc.command('get_state');
      result.session = state.sessionFile; assert.ok(result.session, 'Real Pi must return an actual session file');
      states[name] = { base: active.base, cliRoot: active.cliRoot, cache: active.cache, sessionDir: active.sessionDir, session: state.sessionFile, expected, snapshots: result.snapshots };
      await save(join(evidence, 'states.json'), states);
    } catch (error) {
      result.status = 'failed'; result.error = error?.code === 'ERR_ASSERTION' ? error.message : 'Real host/provider execution failed; raw diagnostic withheld';
      result.availabilityFailure = modelAvailabilityFailure((await rows(active.capture)).slice(obsBefore));
      result.failureKind = result.availabilityFailure ? 'model_availability' : error?.code === 'ERR_ASSERTION' ? 'assertion' : 'host_or_provider';
      if (result.availabilityFailure) manifest.availabilityFailure = true;
    }
    result.elapsedMs = Date.now() - started; result.startupAndTurnMs = result.elapsedMs + result.startupMs; active.firstTurn = false;
    result.hostDiagnostics = active.rpc.frames.slice(frameBefore).filter(frame => ['extension_error', 'error'].includes(frame.type)).map(frame => ({ type: frame.type, code: typeof frame.code === 'string' && /^[A-Z_]+$/.test(frame.code) ? frame.code : undefined }));
    await save(join(evidence, name + '-result.json'), result); await save(join(evidence, 'manifest.json'), manifest);
    console.log(JSON.stringify(result));
    if (result.availabilityFailure) throw Object.assign(new Error('Actual authorized model is unavailable; preserve this failed sample before considering the permitted fallback'), { code: 'MODEL_UNAVAILABLE' });
    return result.status === 'passed';
  }
  try {
    if (phase === 'initial') {
      const first = await boot('autonomous');
      assert.equal(first.cliExistedBeforeHost, false, 'Cold CLI root must not exist before host launch');
      assert.equal(first.brokerEntriesBeforeHost, 0, 'Broker cache must be empty before host launch');
      if (await turn('cold-autonomous-native', prompt, { native: true, cold: true })) {
        await turn('same-session-repeat', '沿用当前已加载的工作流和检查表，重新报告四项原始值；无需重复读取已知内容。', { warm: true });
        await turn('same-session-native-switch', `/skill:${nativeName} 沿用当前版本，报告四项原始值。`, { warm: true });
        await stop();
        await boot('warm-new-process', { cliRoot: first.cliRoot, cache: first.cache });
        await turn('warm-new-process', invocation, { warm: true });
        const original = states['cold-autonomous-native'];
        await boot('resumed-original', { cliRoot: first.cliRoot, cache: first.cache, sessionDir: original.sessionDir, session: original.session });
        await turn('persisted-session-resume', invocation, { warm: true });
      }
      await boot('cold-dollar'); await turn('cold-dollar', invocation, { cold: true });
      await boot('cold-native-command'); await turn('cold-native-command', `/skill:${nativeName} ${prompt}`, { cold: true });
      if (states['cold-autonomous-native']) {
        const original = states['cold-autonomous-native'];
        await boot('expired-unchanged', { cliRoot: original.cliRoot, cache: original.cache, maxAge: '0' });
        await turn('explicit-revalidation-unchanged', invocation, { revalidated: true });
        await boot('cli-warm-broker-empty', { cliRoot: original.cliRoot });
        await turn('cli-warm-broker-empty', invocation, { warm: true });
        await boot('broker-warm-cli-empty', { cache: original.cache });
        await turn('broker-warm-cli-empty', invocation, { coldCli: true, warmBroker: true });
        await boot('short-ttl-expired', { cliRoot: original.cliRoot, cache: original.cache, maxAge: '1s' });
        await new Promise(done => setTimeout(done, 1100));
        await turn('elapsed-short-ttl-revalidation', invocation, { revalidated: true });
      }
    } else {
      const original = states[manifest.resumeCase]; assert.ok(original?.snapshots?.length, 'Updated phase requires a successful original cold case with a verified snapshot');
      await boot('old-session-after-edit', { cliRoot: original.cliRoot, cache: original.cache, sessionDir: original.sessionDir, session: original.session });
      await turn('old-session-pinned-after-edit', invocation, { warm: true, expectedSnapshot: original.snapshots[0] }, original.expected);
      await boot('fresh-session-after-edit', { cliRoot: original.cliRoot, cache: original.cache, maxAge: '0' });
      if (await turn('refreshed-new-session-b', invocation, {})) {
        const current = states['refreshed-new-session-b'];
        assert.ok(current.snapshots.length && !current.snapshots.some(snapshot => original.snapshots.includes(snapshot)), 'Refreshed B must select a new snapshot');
        await boot('warm-b-new-process', { cliRoot: original.cliRoot, cache: original.cache });
        await turn('warm-b-new-process', invocation, { warm: true });
        await boot('resumed-b', { cliRoot: original.cliRoot, cache: original.cache, sessionDir: current.sessionDir, session: current.session });
        await turn('resumed-b', invocation, { warm: true });
        await boot('broker-warm-cli-empty-b', { cache: original.cache });
        await turn('broker-warm-cli-empty-b', invocation, { coldCli: true, warmBroker: true });
        await boot('short-ttl-expired-b', { cliRoot: original.cliRoot, cache: original.cache, maxAge: '1s' });
        await new Promise(done => setTimeout(done, 1100));
        await turn('elapsed-short-ttl-revalidation-b', invocation, { revalidated: true });
      }
    }
    manifest.status = manifest.cases.length && manifest.cases.every(item => item.status === 'passed') ? 'passed' : 'failed';
  } catch (error) {
    manifest.status = 'failed'; manifest.error = error?.code === 'ERR_ASSERTION' ? error.message : 'Runner/host did not complete; retained per-case evidence identifies the last step.';
  } finally {
    try { await stop(); } catch { manifest.status = 'failed'; manifest.shutdownError = true; }
    const processes = await rows(ledgerFile), started = processes.filter(row => row.event === 'spawn');
    manifest.processes = { started: started.length, missingExit: started.filter(row => !processes.some(end => end.event === 'close' && end.pid === row.pid && end.observedExit)).map(row => row.pid) };
    if (manifest.processes.missingExit.length) manifest.status = 'failed';
    await writeFile(join(evidence, 'phase-source-requests.jsonl'), (await rows(ledger.ledger)).slice(phaseLedgerStart).map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    await save(join(evidence, 'manifest.json'), manifest);
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  if (args.includes('--help')) console.log('Usage: node scripts/verify-pi-notion-model-cache.mjs --fixture ABSOLUTE_JSON --extension INSTALLED_EXTENSION --cli INSTALLED_CLI --model magpie/group/flash-free|magpie/group/worker --evidence-root ABSOLUTE_DIRECTORY [--previous-failure ABSOLUTE_FLASH_FREE_MANIFEST (required for worker)] [--resume INITIAL_EVIDENCE --resume-case ORIGINAL_CASE]. Initial phase uses separate empty CLI/Broker roots; resume phase verifies a separately approved owned remote edit without changing user configuration. An actual model availability failure stops that matrix and remains retained; assertions never authorize fallback.');
  else {
    while (args.length) { const key = args.shift(); assert.ok(['--fixture', '--extension', '--cli', '--model', '--evidence-root', '--previous-failure', '--resume', '--resume-case'].includes(key) && args.length, 'Unknown option or missing value'); assert.ok(options[key.slice(2)] === undefined, 'Repeated option'); options[key.slice(2)] = args.shift(); }
    const result = await runMatrix(options); console.log(JSON.stringify({ status: result.status, evidence: result.evidence, passed: result.cases.filter(item => item.status === 'passed').length, total: result.cases.length })); if (result.status !== 'passed') process.exitCode = 1;
  }
}
