/** Empty-parent adapter for the existing candidate-plan/candidate-run workflow.
 * Paired environments own launching and state; the independent grader owns business claims.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { checkEnvironment, runEnvironment } from './paired-environment.mjs';
import { loadAgentCorpus, bindAgentScenario, checkAgentContractCoverage } from './notion-agent-scenarios.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const file = async path => { const bytes = await readFile(path); return { path, realpath: await realpath(path), bytes: bytes.length, sha256: hash(bytes) }; };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
const canonical = value => value.replaceAll('-', '').toLowerCase();
const keys = (value, allowed, required, label) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), label + ' must be an object');
  assert.ok(Object.keys(value).every(key => allowed.includes(key)), label + ': unsupported field');
  assert.ok(required.every(key => Object.hasOwn(value, key)), label + ': missing field');
};

export function validateOnboardingConfig(config) {
  const required = ['version', 'scope', 'profile', 'scenarioFile', 'scenarioId', 'bindingsFile', 'pairedEnvironment', 'parent', 'modelsFile', 'passEnv', 'evidenceRoot', 'oracleFile', 'model', 'thinkingLevel'];
  keys(config, [...required, 'timeoutMs', 'retestOf'], required, 'native-onboarding config');
  assert.equal(config.version, 1); assert.equal(config.scope, 'notion-agent-workflow');
  assert.equal(config.profile, 'native-onboarding'); assert.equal(config.model, 'magpie/group/worker'); assert.equal(config.thinkingLevel, 'high');
  assert.ok(uuid(config.parent), 'Select one authorized empty parent UUID for the new Library root');
  for (const key of ['scenarioFile', 'bindingsFile', 'modelsFile', 'evidenceRoot', 'oracleFile']) assert.ok(isAbsolute(config[key]), key + ' must be absolute');
  keys(config.pairedEnvironment, ['root', 'build'], ['root', 'build'], 'pairedEnvironment');
  assert.ok(isAbsolute(config.pairedEnvironment.root) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(config.pairedEnvironment.build));
  assert.ok(Array.isArray(config.passEnv) && config.passEnv.includes('NOTION_API_TOKEN') && new Set(config.passEnv).size === config.passEnv.length);
  assert.ok(config.passEnv.every(name => /^[A-Z][A-Z0-9_]*$/u.test(name)), 'Credentials are environment variable names');
  assert.ok(Number.isSafeInteger(config.timeoutMs ?? 1_800_000) && (config.timeoutMs ?? 1_800_000) > 0 && (config.timeoutMs ?? 1_800_000) <= 3_500_000);
  return config;
}

export function validateOnboardingOracle(oracle) {
  keys(oracle, ['version', 'skills', 'allowAdditionalSkills', 'output'], ['version', 'skills', 'allowAdditionalSkills'], 'onboarding oracle');
  assert.equal(oracle.version, 1); assert.equal(typeof oracle.allowAdditionalSkills, 'boolean');
  assert.ok(Array.isArray(oracle.skills) && oracle.skills.length > 0, 'Declare a nonempty business result');
  assert.equal(new Set(oracle.skills.map(skill => skill.name)).size, oracle.skills.length);
  if (oracle.output !== undefined) {
    keys(oracle.output, ['contains'], ['contains'], 'output criterion');
    assert.ok(Array.isArray(oracle.output.contains) && oracle.output.contains.length > 0 && oracle.output.contains.every(text => typeof text === 'string' && text.length));
  }
  for (const skill of oracle.skills) {
    keys(skill, ['name', 'files'], ['name', 'files'], 'oracle skill');
    assert.ok(typeof skill.name === 'string' && skill.name.trim());
    assert.ok(Array.isArray(skill.files) && skill.files.some(file => file.path === 'SKILL.md'), 'The oracle must include the main text');
    assert.equal(new Set(skill.files.map(file => file.path)).size, skill.files.length);
    for (const file of skill.files) {
      keys(file, ['path', 'sha256', 'contains'], ['path'], 'oracle file');
      assert.ok(typeof file.path === 'string' && !isAbsolute(file.path) && !file.path.includes('\\') && !file.path.includes('\0') && file.path.split('/').every(part => part && part !== '.' && part !== '..'));
      assert.ok(file.sha256 !== undefined || file.contains !== undefined, 'Every file needs a content criterion');
      if (file.sha256 !== undefined) assert.match(file.sha256, /^[a-f0-9]{64}$/u);
      if (file.contains !== undefined) assert.ok(Array.isArray(file.contains) && file.contains.length > 0 && file.contains.every(text => typeof text === 'string' && text.length));
    }
  }
  return oracle;
}

async function input(config) {
  validateOnboardingConfig(config);
  const checked = await checkEnvironment(config.pairedEnvironment), build = await json(join(checked.root, 'build.json'));
  assert.equal(checked.candidate_mode, 'packed', 'Native onboarding must select a build made with --install-mode packed');
  const corpus = await loadAgentCorpus(config.scenarioFile), bindings = await json(config.bindingsFile);
  checkAgentContractCoverage(corpus, await json(join(checked.root, 'source/cli/verification/skill-domains.json')));
  for (const name of ['objects', 'bodies', 'facts']) assert.deepEqual(bindings.private?.[name], {}, 'No pre-seeded identities, bodies or private answers in onboarding bindings');
  assert.equal(bindings.private.fixture, undefined, 'Do not borrow a prepared daily fixture');
  const readme = await file(join(build.candidate.packages.cli.root, 'README.md'));
  const publicBindings = { ...bindings.public, 'parent.url': 'https://www.notion.so/' + canonical(config.parent), 'readme.path': readme.path };
  const scenario = bindAgentScenario(corpus, config.scenarioId, { ...bindings, public: publicBindings }, { profile: config.profile });
  assert.equal(scenario.fixture.kind, 'empty-parent');
  const oracle = validateOnboardingOracle(await json(config.oracleFile));
  return { checked, build, scenario, oracle, readme };
}

export async function planOnboardingWorkflow(config) {
  const { checked, build, scenario, readme } = await input(config);
  return { version: 1, scope: config.scope, profile: config.profile, status: 'prepared_not_executed', scenario: scenario.id,
    contracts: scenario.contract_ids, parent: config.parent, libraryId: null,
    provider: 'magpie', model: 'group/worker', thinkingLevel: 'high',
    candidate: { build: checked.build_id, sourceHeads: checked.source_heads_at_build, mode: checked.candidate_mode,
      packages: Object.fromEntries(Object.entries(build.candidate.packages).map(([name, value]) => [name, { name: value.name, version: value.version, entry: value.entry, sdk: value.sdk, archive: value.closure.archive }])) },
    pi: { mode: 'native', nativeSkills: 'new empty run-owned directory', broker: 'not_loaded', declaration: 'paired pi-launch.json shared by direct and private wrapper' },
    publicMaterials: { readme, cli: 'ntn-skills on the private PATH', helpAndBootstrap: 'available through public CLI; not preloaded' },
    turns: scenario.turns.map(turn => ({ id: turn.id, promptSha256: hash(turn.prompt), assertions: turn.expect.map(row => row.kind) })),
    initialState: { remote: 'authorized empty parent; checked before the first model request', local: 'new config/cache/Store/scheduler/Pi/session', precreatedObjects: 0 },
    episode: 'one private paired command run and one continuous native RPC session',
    grader: 'fresh paired command run; init --library verifies all four schemas and produced identity; complete current main text and pinned supporting bytes via public CLI',
    timeoutMs: config.timeoutMs ?? 1_800_000, oracle: 'controller-only; never passed to the subject',
    scopeBoundary: 'isolated native onboarding; does not count as daily or two-machine acceptance' };
}

/** Accept only successful native tool-result JSON, not the assistant's claimed URL. */
export function onboardingProducedLibraries(sessionText) {
  const libraries = new Map();
  for (const line of sessionText.split('\n').filter(Boolean)) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== 'message' || row.message?.role !== 'toolResult' || row.message.isError) continue;
    for (const part of row.message.content ?? []) {
      if (part.type !== 'text') continue;
      const text = part.text;
      for (let start = 0; start < text.length; start++) {
        if (text[start] !== '{') continue;
        let depth = 0, quoted = false, escaped = false;
        for (let end = start; end < text.length; end++) {
          const char = text[end];
          if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
          else if (char === '"') quoted = true;
          else if (char === '{') depth++;
          else if (char === '}' && --depth === 0) {
            try {
              const value = JSON.parse(text.slice(start, end + 1)), library = value.library;
              if (value.ok === true && library?.version === 2 && uuid(library.library_id)
                && uuid(library.skills?.database_id) && !Object.hasOwn(library, 'parent_page_id'))
                libraries.set(canonical(library.library_id), { libraryId: library.library_id, library, toolCallId: row.message.toolCallId, sessionEntryId: row.id });
            } catch { /* A non-JSON tool result is not Library evidence. */ }
            start = end; break;
          }
        }
      }
    }
  }
  return [...libraries.values()];
}

export function gradeOnboardingReadback(oracle, observed) {
  validateOnboardingOracle(oracle);
  const failures = [];
  if (observed?.status !== 'read_back' || observed.complete !== true || observed.libraryValidation?.status !== 'passed') return { status: 'blocked', failures: ['complete independent readback is unavailable'] };
  const actualNames = observed.skills.map(skill => skill.name), expectedNames = oracle.skills.map(skill => skill.name);
  if (!oracle.allowAdditionalSkills && JSON.stringify([...actualNames].sort()) !== JSON.stringify([...expectedNames].sort())) failures.push('The complete Skill set differs');
  for (const expected of oracle.skills) {
    const choices = observed.skills.filter(skill => skill.name === expected.name);
    if (choices.length !== 1) { failures.push('Expected one Skill: ' + expected.name); continue; }
    const actual = choices[0];
    if (JSON.stringify(actual.files.map(file => file.path).sort()) !== JSON.stringify(expected.files.map(file => file.path).sort())) failures.push('Incomplete file set: ' + expected.name);
    for (const wanted of expected.files) {
      const found = actual.files.find(file => file.path === wanted.path);
      if (!found || !found.complete) { failures.push('Missing complete file: ' + expected.name + '/' + wanted.path); continue; }
      if (wanted.sha256 !== undefined && wanted.sha256 !== found.sha256) failures.push('File bytes differ: ' + expected.name + '/' + wanted.path);
      if (wanted.contains?.some(text => typeof found.content !== 'string' || !found.content.includes(text))) failures.push('Required content missing: ' + expected.name + '/' + wanted.path);
    }
  }
  return { status: failures.length ? 'failed' : 'passed', failures };
}

export function gradeOnboardingAssertions(scenario, episode, business) {
  const assertions = scenario.turns.flatMap(turn => turn.expect.map(expected => {
    const actual = episode?.turns?.find(item => item.id === turn.id);
    const passed = expected.kind === 'completed' ? actual?.status === 'completed'
      : expected.kind === 'candidate-cli' ? actual?.cliProcesses?.status === 'passed' && actual.cliProcesses.matchedCliCount >= expected.min
      : expected.kind === 'business-readback' ? business?.status === 'passed' : false;
    return { turn: turn.id, kind: expected.kind, status: passed ? 'passed' : 'failed' };
  }));
  return { status: assertions.length && assertions.every(row => row.status === 'passed') ? 'passed' : 'failed', assertions };
}

export function gradeOnboardingBusiness(oracle, observed, episode) {
  const readback = gradeOnboardingReadback(oracle, observed);
  const output = oracle.output === undefined ? { status: 'not_requested' }
    : { status: typeof episode?.finalOutput === 'string' && oracle.output.contains.every(text => episode.finalOutput.includes(text)) ? 'passed' : 'failed' };
  return { status: readback.status === 'passed' && output.status !== 'failed' ? 'passed' : readback.status === 'blocked' ? 'blocked' : 'failed', readback, output };
}

export function onboardingResult({ episode, episodeRun, graderRun, business, hardContracts }) {
  const valid = episodeRun?.status === 'passed' && episodeRun.runtime_check?.status === 'unchanged' && episodeRun.frozen_artifacts === 'passed'
    && graderRun?.status === 'passed' && graderRun.runtime_check?.status === 'unchanged' && graderRun.frozen_artifacts === 'passed';
  return { status: valid && episode?.status === 'passed' && business?.status === 'passed' && hardContracts?.status === 'passed' ? 'passed' : 'failed',
    validity: valid ? 'valid' : 'invalid', process: episodeRun?.command_status ?? 'not_run',
    episodeStatus: episode?.status ?? 'unknown', business: business ?? { status: 'not_run' },
    remoteEffects: graderRun?.status === 'passed' ? 'independently_read_back' : 'unknown_reconcile_before_retry',
    daily: 'not_run' };
}

const invoke = (method, inputPath) => ['node', '--input-type=module', '--eval',
  `const {pathToFileURL}=await import('node:url');const m=await import(pathToFileURL(process.env.PAIRED_BROKER_SOURCE+'/scripts/notion-agent-onboarding-runtime.mjs'));await m.${method}(process.argv[1]);`, inputPath];

export async function runOnboardingWorkflow(config) {
  const selected = await input(config), plan = await planOnboardingWorkflow(config);
  await mkdir(config.evidenceRoot, { recursive: true, mode: 0o700 });
  const evidence = await mkdtemp(join(await realpath(config.evidenceRoot), 'native-onboarding-'));
  const nativeSkills = join(evidence, 'empty-native-skills'); await mkdir(nativeSkills);
  const episodeId = 'onboarding-' + randomUUID(), graderId = 'grader-' + randomUUID();
  const publicInput = join(evidence, 'public-input.json'), privateInput = join(evidence, 'private-oracle.json');
  await save(publicInput, { version: 1, parent: config.parent, readme: selected.readme,
    turns: selected.scenario.turns.map(({ id, prompt }) => ({ id, prompt })), timeoutMs: plan.timeoutMs });
  await save(privateInput, selected.oracle); await save(join(evidence, 'plan.json'), plan); await save(join(evidence, 'config.json'), config);
  const { consumptionCostExtensionSource } = await import('./skill-consumption-cost.mjs');
  const { providerTransportExtensionSource } = await import('./skill-consumption-provider.mjs');
  const { candidateTaskExtensionSource } = await import('./verify-pi-daily-candidate.mjs');
  const { onboardingLoadObserverSource } = await import('./notion-agent-onboarding-runtime.mjs');
  const episodeRoot = join(config.pairedEnvironment.root, 'runs', episodeId), observation = join(evidence, 'observation');
  await mkdir(observation);
  for (const name of ['payloads', 'branches', 'tool-results']) await mkdir(join(observation, name));
  const clockId = randomUUID(), checkoutRoot = resolve(import.meta.dirname, '..');
  const extensions = [];
  for (const [name, source] of [
    ['cost', consumptionCostExtensionSource({ output: join(observation, 'cost.jsonl'), checkoutRoot, runId: episodeId, sampleId: selected.scenario.id, clockId })],
    ['transport', providerTransportExtensionSource({ output: join(observation, 'transport.jsonl'), checkoutRoot, clockId })],
    ['tasks', candidateTaskExtensionSource({ output: join(observation, 'tasks.jsonl'), bodyFiles: [], payloadDirectory: join(observation, 'payloads'), branchDirectory: join(observation, 'branches'), toolResultDirectory: join(observation, 'tool-results') })],
    ['loaded', onboardingLoadObserverSource(join(observation, 'loaded.jsonl'))],
  ]) { const path = join(observation, name + '.mjs'); await writeFile(path, source, { flag: 'wx', mode: 0o600 }); extensions.push(path); }
  const common = { ...config.pairedEnvironment, target: 'command', 'pi-mode': 'native', 'native-skills': nativeSkills, 'pass-env': config.passEnv, args: [] };
  const result = { version: 1, scope: config.scope, profile: config.profile, scenario: selected.scenario.id, evidence, plan,
    startedAt: new Date().toISOString(), retestOf: config.retestOf ?? null, episodeRun: null, graderRun: null, business: { status: 'not_run' } };
  await save(join(evidence, 'started.json'), result);
  try {
    result.episodeRun = await runEnvironment({ ...common, id: episodeId, parent: config.parent, models: config.modelsFile,
      'pi-extension': extensions, 'timeout-ms': String(plan.timeoutMs + 30000), args: invoke('runOnboardingEpisode', publicInput) });
    result.episode = await json(join(episodeRoot, 'episode.json')).catch(() => ({ status: 'unknown' }));
    const sessionPath = result.episode.sessionFile;
    const session = sessionPath && sessionPath.startsWith(episodeRoot + '/sessions/') ? await readFile(sessionPath, 'utf8').catch(() => '') : '';
    const libraries = onboardingProducedLibraries(session); result.producedLibraries = libraries;
    if (libraries.length === 1) {
      const graderInput = join(evidence, 'grader-input.json');
      await save(graderInput, { version: 1, libraryId: libraries[0].libraryId, parent: config.parent, library: libraries[0].library });
      result.graderRun = await runEnvironment({ ...common, id: graderId, library: libraries[0].libraryId,
        'pass-env': config.passEnv.filter(name => name === 'NOTION_API_TOKEN' || name === 'NODE_EXTRA_CA_CERTS' || /PROXY$/u.test(name)),
        'timeout-ms': '600000', args: invoke('runOnboardingGrader', graderInput) });
      result.readback = await json(join(result.graderRun.root, 'readback.json')).catch(() => null);
      result.business = gradeOnboardingBusiness(selected.oracle, result.readback, result.episode);
    } else result.business = { status: 'blocked', failures: ['Expected one actual Library root from native tool results; reconcile the authorized parent before retrying'] };
  } catch (error) { result.error = error.message; }
  result.hardContracts = gradeOnboardingAssertions(selected.scenario, result.episode, result.business);
  Object.assign(result, onboardingResult(result)); result.finishedAt = new Date().toISOString();
  await save(join(evidence, 'result.json'), result);
  return result;
}
