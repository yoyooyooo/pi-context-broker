import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runtimeEnvironment } from '../scripts/paired-environment.mjs';
import { prepareAgentFixtures, readAgentFixture, runAgentFixtureEvent, planAgentFixturePreparation } from '../scripts/notion-agent-fixtures.mjs';
import { ensureRemoteParent } from './remote.mjs';
import { validateCorpus, planCaseVariant, rebindCorpusCatalog, buildFixtureRecipe, bindPublicCaseToFixture,
  verifyMaterialization, auditVisibleMaterial, writeCorpus } from './corpus/index.mjs';

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(modulePath), '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const json = path => readFile(path, 'utf8').then(JSON.parse);
const exists = path => access(path).then(() => true, () => false);
const now = () => new Date().toISOString();
const stable = value => JSON.stringify(value, Object.keys(value ?? {}).sort());
const digest = value => sha(JSON.stringify(value));
const inside = (base, path) => { const r = relative(base, path); return r === '' || r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r); };
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/u.test(value);
const splitMain = text => { const header = text.match(/^(---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/u)?.[1] ?? ''; return { header, body: text.slice(header.length) }; };
const faultModes = new Set(['missing-object', 'missing-manifest', 'store-unavailable']);
const eventKinds = new Set(['publish-version', 'set-enabled', 'readback', 'fault', 'restore-fault', 'interrupt-source-write', 'resume-source-write']);
const byteArtifact = async path => { const bytes = await readFile(path); return { path, sha256: sha(bytes), bytes: bytes.length }; };
const errorValue = error => ({ code: error.code ?? null, message: error.message, ...(error.details ? { details: error.details } : {}) });
const failure = (code, message, details) => Object.assign(new Error(message), { code, ...(details ? { details } : {}) });

async function save(path, value) {
  assert.equal(await canonicalTarget(dirname(path)), dirname(path), 'Evidence cannot escape through a symlink');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return byteArtifact(path);
}
async function put(path, bytes, mode = '100644') {
  assert.equal(await canonicalTarget(dirname(path)), dirname(path), 'Material cannot escape through a symlink');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { await writeFile(path, bytes, { flag: 'wx', mode: mode === '100755' ? 0o500 : 0o400 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const s = await lstat(path); assert.ok(s.isFile() && !s.isSymbolicLink(), 'Owned files must be regular');
    assert.equal(sha(await readFile(path)), sha(bytes), 'Refusing to replace different retained evidence');
    assert.equal(Boolean(s.mode & 0o111), mode === '100755', 'Retained executable mode changed');
  }
  return byteArtifact(path);
}
async function canonicalTarget(path) {
  assert.ok(isAbsolute(path), 'Use an absolute controller path');
  path = resolve(path);
  let ancestor = path; const tail = [];
  for (;;) {
    try { const actual = await realpath(ancestor); assert.equal(actual, ancestor, 'Controller ancestors cannot be symlinks'); return join(actual, ...tail.reverse()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; const parent = dirname(ancestor); assert.notEqual(parent, ancestor); tail.push(relative(parent, ancestor)); ancestor = parent; }
  }
}
function validatePrivateRoot(root, buildRoot) {
  assert.ok(isAbsolute(root) && isAbsolute(buildRoot));
  assert.ok(!inside(repositoryRoot, root) && !inside(root, repositoryRoot), 'Fixture control must remain outside the repository');
  assert.ok(!inside(buildRoot, root) && !inside(root, buildRoot), 'Fixture control and immutable build must be disjoint');
}
function targetUnion(corpus, caseIds) {
  const skills = new Map(corpus.publicCorpus.skills.map(skill => [skill.id, skill]));
  const selected = new Set();
  const visit = value => { assert.ok(skills.has(value), 'Unknown Skill dependency'); if (selected.has(value)) return; selected.add(value); skills.get(value).requires.forEach(visit); };
  for (const caseId of caseIds) {
    const item = corpus.control.cases.find(item => item.case_id === caseId);
    assert.ok(item, 'Unknown case ID: ' + caseId); item.target_skill_ids.forEach(visit);
  }
  return [...selected].sort();
}

/** Freeze a complete controller plan. This function has no filesystem, provider or model effects. */
export function planBenchmarkFixture({
  corpus, caseIds, scopeId, controlRoot, projectPageId, buildRoot, node,
  cli = join(buildRoot ?? '', 'cli/dist/ntn-skills.js'), placement = 'notion',
  sourceBindings = {}, git = null, access: accessMode = 'shared-readonly', episodeId = null,
  candidateCount = 16, roundCount, catalogSkillIds, events = [], initiallyAbsentSkillIds = [], ownedRuntimeRoot = null,
} = {}) {
  validateCorpus(corpus);
  assert.ok(!['sealed'].includes(corpus.control.seal.state), 'Confirmation remains sealed until candidate and budget registration');
  assert.ok(Array.isArray(caseIds) && caseIds.length > 0 && new Set(caseIds).size === caseIds.length);
  assert.ok(id(scopeId) && /^[a-z0-9][a-z0-9-]{3,79}$/u.test(scopeId), 'Use one bounded owned scope ID');
  assert.match(projectPageId, /^[a-f0-9-]{32,36}$/iu);
  validatePrivateRoot(controlRoot, buildRoot);
  assert.ok(isAbsolute(node) && isAbsolute(cli) && inside(buildRoot, cli), 'Use the maintained Node and a CLI inside the selected build');
  assert.ok(['notion', 'project', 'mixed'].includes(placement));
  if(git!==null)assert.ok(isAbsolute(git),'Select an existing Git by absolute path');
  if (ownedRuntimeRoot !== null) { validatePrivateRoot(ownedRuntimeRoot, buildRoot); assert.ok(!inside(ownedRuntimeRoot, controlRoot), 'The runtime cannot enclose controller evidence'); }
  assert.ok(['shared-readonly', 'episode-owned'].includes(accessMode));
  assert.ok([16, 64, 256].includes(candidateCount));
  if (accessMode === 'episode-owned') assert.ok(id(episodeId), 'Mutable scopes belong to one explicit episode');
  else assert.equal(episodeId, null, 'A shared scope cannot also claim one episode');
  const required = targetUnion(corpus, caseIds);
  let boundCorpus = structuredClone(corpus), selectedIds;
  if (candidateCount === 16) {
    if (catalogSkillIds) selectedIds = [...catalogSkillIds];
    else if (caseIds.length === 1) selectedIds = [...corpus.publicCorpus.cases.find(item => item.id === caseIds[0]).catalog.skill_ids];
    else {
      assert.ok(required.length <= 16, 'The required Skill union exceeds the shared sixteen-candidate catalog');
      const allTargets = new Set(corpus.control.cases.flatMap(item => item.target_skill_ids));
      const fillers = corpus.publicCorpus.skills.filter(skill => !allTargets.has(skill.id)).map(skill => skill.id);
      selectedIds = [...required, ...fillers.slice(0, 16 - required.length)].sort();
    }
    assert.equal(selectedIds.length, 16, 'A shared base catalog must contain sixteen Skills');
    const same = caseIds.every(caseId => JSON.stringify(corpus.publicCorpus.cases.find(item => item.id === caseId).catalog.skill_ids) === JSON.stringify(selectedIds));
    if (!same) boundCorpus = rebindCorpusCatalog({ corpus, caseIds, skillIds: selectedIds, reason: 'Frozen shared fixture catalog before this batch registration' });
  } else {
    assert.equal(caseIds.length, 1, 'Scale anchors use one declared journey per scope');
    assert.equal(catalogSkillIds, undefined, 'Scale variants use their declared catalog');
    selectedIds = planCaseVariant({ ...corpus, caseId: caseIds[0], candidateCount, roundCount }).skills.map(skill => skill.id);
  }
  const casePlans = caseIds.map(caseId => planCaseVariant({ ...boundCorpus, caseId, candidateCount, roundCount }));
  const fixture = buildFixtureRecipe({ publicCorpus: boundCorpus.publicCorpus, caseId: caseIds[0], scopeId, placement, sourceBindings, candidateCount, roundCount });
  assert.deepEqual(Object.keys(fixture.skill_mapping).sort(), [...selectedIds].sort());
  for (const key of Object.keys(sourceBindings)) assert.ok(fixture.skill_mapping[key], 'A source binding is outside the frozen catalog');
  const plannedEvents = [...casePlans.flatMap((plan, index) => (plan.events ?? []).map(event => ({ ...event, case_id: caseIds[index] }))), ...structuredClone(events)];
  assert.equal(new Set(plannedEvents.map(event => event.id)).size, plannedEvents.length, 'Event IDs must be unique in one scope');
  for (const event of plannedEvents) {
    assert.ok(id(event.id) && eventKinds.has(event.kind) && fixture.skill_mapping[event.skill_id], 'Events must name a supported operation on one owned Skill');
    if (event.kind === 'fault') assert.ok(faultModes.has(event.mode), 'Unsupported owned Store fault');
    if (event.kind === 'set-enabled') assert.equal(typeof event.enabled, 'boolean');
    if (event.kind === 'publish-version') {
      const object = fixture.recipe.objects.find(item => item.id === fixture.skill_mapping[event.skill_id].object_id);
      assert.equal(object.placement, 'notion', 'Version changes require a native Notion owner');
      assert.ok(object.versions[event.version], 'An event cannot invent a version');
    }
    event.logical_operation ??= { skill_id: event.skill_id, path: event.path ?? 'SKILL.md', intent: event.kind };
  }
  if (fixture.mutable || plannedEvents.length > 0) {
    assert.equal(accessMode, 'episode-owned', 'Mutable or faulted scopes must be isolated per episode');
    assert.equal(caseIds.length, 1, 'Mutable scopes cannot be shared across cases');
  }
  assert.equal(new Set(initiallyAbsentSkillIds).size, initiallyAbsentSkillIds.length);
  for (const skillId of initiallyAbsentSkillIds) {
    const mapping = fixture.skill_mapping[skillId]; assert.ok(mapping && mapping.placement === 'source');
    assert.equal(accessMode, 'episode-owned');
    assert.ok(plannedEvents.some(event => event.skill_id === skillId && event.kind === 'interrupt-source-write'), 'Absent source setup requires a frozen interrupted-write diagnostic');
    const object = fixture.recipe.objects.find(item => item.id === mapping.object_id);
    object.initial = 'absent';
    // The existing cold-source helper hydrates its retained provider tree itself.
    for (const version of Object.values(object.versions)) version.files = [];
  }
  planAgentFixturePreparation(fixture.recipe);
  const value = {
    schema_version: 1, kind: 'benchmark-controller-fixture', scope_id: scopeId, control_root: resolve(controlRoot),
    project_page_id: projectPageId, build_root: resolve(buildRoot), node: resolve(node), cli: resolve(cli), git,
    access: accessMode, episode_id: episodeId, owned_runtime_root: ownedRuntimeRoot, placement, candidate_count: candidateCount,
    case_ids: [...caseIds], catalog_skill_ids: selectedIds, required_skill_ids: required,
    corpus: boundCorpus, case_plans: casePlans, fixture, events: plannedEvents,
    initially_absent_skill_ids: [...initiallyAbsentSkillIds],
    evidence_scope: initiallyAbsentSkillIds.length ? 'diagnostic-extension' : 'complete-initial-material',
  };
  return { ...value, plan_sha256: digest(value) };
}

async function readPlan(root) {
  root = await canonicalTarget(root);
  const plan = await json(join(root, 'plan.json'));
  const { plan_sha256, ...value } = plan;
  assert.equal(digest(value), plan_sha256, 'Frozen fixture plan changed');
  assert.equal(root, plan.control_root);
  validatePrivateRoot(root, plan.build_root);
  const owner = await json(join(root, 'owner.json'));
  assert.equal(owner.kind, 'benchmark-controller-fixture'); assert.equal(owner.plan_sha256, plan_sha256);
  return plan;
}
async function initializePlan(plan) {
  const root = await canonicalTarget(plan.control_root); assert.equal(root, plan.control_root);
  if (await exists(join(root, 'owner.json'))) {
    const previous = await readPlan(root); assert.equal(previous.plan_sha256, plan.plan_sha256, 'An existing scope belongs to another frozen plan');
    return previous;
  }
  const entries = await readdir(root).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  assert.equal(entries.length, 0, 'Use a fresh or matching owned controller root');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await save(join(root, 'owner.json'), { schema_version: 1, kind: 'benchmark-controller-fixture', plan_sha256: plan.plan_sha256, created_at: now() });
  await save(join(root, 'plan.json'), plan);
  return plan;
}
async function takeLease(root, action) {
  await mkdir(join(root, 'history'), { recursive: true, mode: 0o700 });
  const path = join(root, 'worker-lease.json');
  if (await exists(path)) {
    const previous = await json(path); let live = true;
    try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') live = false; else throw error; }
    assert.equal(live, false, 'An owned fixture worker is already running');
    await rename(path, join(root, 'history', 'expired-worker-' + randomUUID() + '.json'));
  }
  await save(path, { pid: process.pid, action, started_at: now() });
  return async () => { await rename(path, join(root, 'history', 'finished-worker-' + randomUUID() + '.json')); };
}
async function command(plan, args, label, env, { timeoutMs = 660000, dispatchIntent = null } = {}) {
  const path = join(plan.control_root, 'commands', label + '-' + randomUUID() + '.json');
  const started = now();
  const result = await new Promise(resolveResult => {
    const child = spawn(plan.node, [plan.cli, ...args], { env, cwd: plan.control_root, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; let timedOut = false, spawnError;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', value => stdout.push(value)); child.stderr.on('data', value => stderr.push(value));
    child.once('error', error => { spawnError = errorValue(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, timedOut, spawn_error: spawnError ?? null, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }); });
  });
  const receipt = await save(path, { started_at: started, completed_at: now(), command: [plan.node, plan.cli, ...args], dispatch_intent: dispatchIntent, ...result });
  let value; try { value = JSON.parse(result.stdout); } catch { /* exact output already retained */ }
  if (result.code !== 0 || result.timedOut || value?.ok !== true) throw failure('BENCHMARK_FIXTURE_COMMAND_UNKNOWN', 'The public CLI did not complete; no mutation is automatically repeated', { receipt, public_error: value?.error ?? null });
  return { value, receipt };
}

async function preparePrivateEnvironment(plan, env) {
  for (const key of ['TMPDIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
    'NTN_SKILLS_HOME', 'NTN_SKILLS_CONFIG_HOME', 'NTN_SKILLS_CACHE_HOME', 'NTN_SKILLS_DATA_HOME', 'NTN_SKILLS_SCHEDULER_ROOT', 'PI_CODING_AGENT_DIR']) {
    const path = env[key]; if (!path) continue;
    assert.ok(inside(plan.control_root, path), 'Controller environment roots must stay privately owned');
    assert.equal(await canonicalTarget(path), path);
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
}
async function operationObservation(plan, bindings, owned, kind) {
  const ownerId = kind === 'source' ? owned.sourceId ?? 'agent-workflow-' + plan.scope_id + '-' + owned.id : owned.skillId;
  const result = await command(plan, ['ctl', 'library', 'operation', ownerId, '--kind', kind, '--entry', bindings.private.fixture.entry],
    'reconcile-' + kind, fixtureEnvironment(plan, bindings));
  assert.equal(result.value.owner?.kind, kind); assert.equal(result.value.owner?.id, ownerId);
  assert.equal(result.value.library.database_id.replaceAll('-', ''), bindings.private.fixture.entry.replaceAll('-', ''));
  assert.equal(result.value.request_metrics.requests.notion_write, 0, 'Operation reconciliation must be read-only');
  return { kind, owner_id: ownerId, status: result.value.status, operation: result.value.operation, receipt: result.receipt };
}

async function sourceAbsenceObservation(plan, bindings, owned) {
  const context=bindings.private.fixture, sourceId=owned.sourceId ?? 'agent-workflow-'+plan.scope_id+'-'+owned.id;
  const sourceTable=context.library.sources, property=sourceTable.property_ids['Source ID'];
  assert.ok(property && typeof process.env.NOTION_API_TOKEN==='string');
  const url='https://api.notion.com/v1/data_sources/'+sourceTable.data_source_id+'/query';
  const body={filter:{property,rich_text:{equals:sourceId}},page_size:100};
  const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+process.env.NOTION_API_TOKEN,'Notion-Version':context.apiVersion,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  const text=await response.text();
  const receipt=await save(join(plan.control_root,'reconciliations','source-inventory-'+randomUUID()+'.json'),{
    method:'POST',url,request:body,status:response.status,response:text,semantic_writes:'none',at:now(),
  });
  assert.equal(response.ok,true,'Read-only source inventory failed; no creation is allowed');
  const value=JSON.parse(text);
  assert.equal(value.has_more,false,'Source ownership inventory must be complete');
  assert.ok(Array.isArray(value.results));
  return {source_id:sourceId,rows:value.results.map(row=>({page_id:row.id,archived:row.archived,in_trash:row.in_trash})),receipt};
}

async function priorDispatches(plan, owned) {
  const output = [], roots = [join(plan.control_root, 'objects/commands'), join(plan.control_root, 'commands')];
  for (const root of roots) for (const name of await readdir(root).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (!name.endsWith('.json')) continue;
    const path = join(root, name), record = await json(path), argv = record.command ?? [];
    const source = argv.includes('apply') && argv.includes('source') && owned.declarationPath && argv.includes(owned.declarationPath);
    const native = argv.includes('create') && argv.includes('--skill-id') && argv.includes(owned.skillId);
    if (!source && !native) continue;
    let value; try { value = JSON.parse(record.stdout); } catch { /* retain an unknown dispatch */ }
    output.push({ source, native, code: record.code ?? record.status, value, dispatch_intent: record.dispatch_intent ?? null, receipt: await byteArtifact(path) });
  }
  return output;
}
function isConfirmedPrewriteFailure(dispatch) {
  // This public adapter error is emitted while allocating its Git input snapshot,
  // before source planning or a content coordinator write. Other errors stay unknown.
  return dispatch.source && dispatch.code !== 0 && dispatch.value?.ok === false &&
    ['UPSTREAM_TEMP_FAILED','UPSTREAM_GIT_RUNTIME_UNSUPPORTED'].includes(dispatch.value.error?.code);
}

/** Owner absence, no unfinished operation, and accounted dispatch history are different facts. */
export function preparationResumeDecision({ absence, sourceInventory = null, sourceRequired = false,
  operation, sourceOperation = null, allClaimsAccounted, knownNeverDispatched, confirmedPrewriteFailures = false } = {}) {
  if (absence?.status !== 'passed' || absence.observed?.absent !== true || !absence.artifact?.sha256) return 'unknown';
  if (sourceRequired && (!sourceInventory?.receipt?.sha256 || !Array.isArray(sourceInventory.rows) || sourceInventory.rows.length !== 0)) return 'unknown';
  if (operation?.status !== 'not_found' || operation.operation !== null) return 'unknown';
  if (sourceRequired && (sourceOperation?.status !== 'not_found' || sourceOperation.operation !== null)) return 'unknown';
  if (allClaimsAccounted !== true || !(knownNeverDispatched === true || confirmedPrewriteFailures === true)) return 'unknown';
  return 'absent-before-write';
}

async function observePreparation(plan) {
  const { bindings } = await bindingsFor(plan), context = bindings.private.fixture, observations = [];
  assert.equal(context.runId, plan.scope_id);
  let stoppedAt = -1;
  const failedPath = join(context.root, 'preparation-failed.json');
  if (await exists(failedPath)) {
    const failed = await json(failedPath), ref = failed.details?.artifact;
    if (ref) {
      assert.equal((await byteArtifact(ref.path)).sha256, ref.sha256);
      const argv = (await json(ref.path)).command ?? [];
      stoppedAt = context.preparationPlan.order.findIndex(alias => { const owned=context.objects[alias]; return [owned.skillId,owned.pageId,owned.declarationPath,...Object.values(owned.versionInputs).map(input=>input.directory)].filter(Boolean).some(value=>argv.includes(value)); });
    }
  }
  for (const alias of context.preparationPlan.order) {
    const owned = context.objects[alias], skillId = plan.catalog_skill_ids.find(id => plan.fixture.skill_mapping[id].object_id === alias);
    assert.ok(owned && skillId);
    if (plan.initially_absent_skill_ids.includes(skillId)) { observations.push({ object_id: alias, state: 'declared-absent' }); continue; }
    if (['project','global'].includes(owned.placement)) {
      try {
        const proof = await readAgentFixture(bindings, alias, { version: plan.fixture.skill_mapping[skillId].initial_version, key: alias, preserveBindings: true });
        observations.push({ object_id: alias, state: 'ready', readback: proof.artifact });
      } catch (error) { observations.push({ object_id: alias, state: 'unknown', error: errorValue(error) }); }
      continue;
    }
    try {
      let live;
      try { live=await readAgentFixture(bindings,alias,{version:plan.fixture.skill_mapping[skillId].initial_version,key:alias,preserveBindings:true}); } catch { /* only a separate absence read can establish absence */ }
      if(live) {
        if(owned.placement==='source')assert.ok(live.observed.projection,'Source reading projection must be present');
        observations.push({object_id:alias,state:'ready',readback:live.artifact}); continue;
      }
      const absence=await readAgentFixture(bindings,alias,{state:'absent',key:alias+'-absent-before-resume',preserveBindings:true});
      assert.equal(absence.observed.absent,true);
      const sourceInventory=owned.placement==='source'?await sourceAbsenceObservation(plan,bindings,owned):null;
      if(sourceInventory)assert.equal(sourceInventory.rows.length,0,'A Source owner exists without its expected ready child');
      const skill = await operationObservation(plan, bindings, owned, 'skill');
      const source = owned.placement === 'source' ? await operationObservation(plan, bindings, owned, 'source') : null;
      if (skill.status === 'not_found' && (!source || source.status === 'not_found')) {
        const dispatches = await priorDispatches(plan, owned);
        const claims=[];
        for(const name of await readdir(join(plan.control_root,'resume-dispatches')).catch(error=>error.code==='ENOENT'?[]:Promise.reject(error))) {
          const path=join(plan.control_root,'resume-dispatches',name), claim=await json(path);
          if(claim.object_id===alias)claims.push(await byteArtifact(path));
        }
        const allClaimsAccounted=claims.every(claim=>dispatches.some(dispatch=>dispatch.dispatch_intent?.path===claim.path && dispatch.dispatch_intent?.sha256===claim.sha256 && isConfirmedPrewriteFailure(dispatch)));
        const neverDispatched=dispatches.length===0 && claims.length===0 && stoppedAt>=0 && context.preparationPlan.order.indexOf(alias)>stoppedAt;
        const decision=preparationResumeDecision({absence,sourceInventory,sourceRequired:owned.placement==='source',operation:skill,sourceOperation:source,allClaimsAccounted,knownNeverDispatched:neverDispatched,confirmedPrewriteFailures:dispatches.length>0 && dispatches.every(isConfirmedPrewriteFailure)});
        observations.push({ object_id: alias, state: decision, absence:absence.artifact, source_inventory:sourceInventory, skill, source,
          previous_dispatches: dispatches.map(item => ({ receipt: item.receipt, confirmed_prewrite_failure: isConfirmedPrewriteFailure(item) })),
          dispatch_never_started: neverDispatched, all_dispatch_claims_accounted: allClaimsAccounted });
      } else {
        const proof = await readAgentFixture(bindings, alias, { version: plan.fixture.skill_mapping[skillId].initial_version, key: alias, preserveBindings: true });
        if (owned.placement === 'source') assert.ok(proof.observed.projection, 'A source without its reading projection is not a completed fixture');
        observations.push({ object_id: alias, state: 'ready', skill, source, readback: proof.artifact });
      }
    } catch (error) { observations.push({ object_id: alias, state: 'unknown', error: errorValue(error) }); }
  }
  const receipt = await save(join(plan.control_root, 'reconciliations', randomUUID() + '.json'), {
    schema_version: 1, scope_id: plan.scope_id, observed_at: now(), remote_writes: 'none', observations,
    status: observations.some(item => item.state === 'unknown') ? 'unknown' : observations.some(item => item.state === 'absent-before-write') ? 'known-incomplete' : 'ready',
  });
  return { bindings, observations, receipt };
}
async function resumePreparationWorker(plan) {
  const observed = await observePreparation(plan), bindings = observed.bindings, context = bindings.private.fixture;
  if (observed.observations.some(item => item.state === 'unknown')) return saveOperationResult(plan, 'resume', {
    status: 'unknown', effect_unknown: true, reconciliation: observed.receipt, reason: 'An earlier write is unresolved; no new creation was dispatched' });
  await persistOwnedBindings(plan, bindings);
  for (const item of observed.observations) {
    if (item.state !== 'absent-before-write') continue;
    const owned = context.objects[item.object_id], object = context.recipe.objects.find(value => value.id === item.object_id);
    assert.ok(['notion','source'].includes(owned.placement), 'Only declared remote object preparation is resumed');
    // Prove absence again immediately before this new, uniquely journaled dispatch.
    const absence=await readAgentFixture(bindings,item.object_id,{state:'absent',key:item.object_id+'-immediate-absence',preserveBindings:true});
    assert.equal(absence.observed.absent,true);
    if(owned.placement==='source')assert.equal((await sourceAbsenceObservation(plan,bindings,owned)).rows.length,0);
    const skill = await operationObservation(plan, bindings, owned, 'skill');
    assert.equal(skill.status, 'not_found');
    if (owned.placement === 'source') assert.equal((await operationObservation(plan, bindings, owned, 'source')).status, 'not_found');
    const input = owned.versionInputs[object.initial];
    if (owned.placement === 'source') {
      const declaration = structuredClone(object.source.declaration);
      declaration.definition.source_id = 'agent-workflow-' + plan.scope_id + '-' + object.id;
      declaration.definition.name = owned.name;
      declaration.contributions = [{ member_key: object.source.memberKey, skill_id: owned.skillId, mount_path: '', mapping: {}, exclude: [] }];
      const path = join(context.root, 'inputs', object.id + '-source.json');
      if (await exists(path)) assert.deepEqual(await json(path), declaration);
      else await save(path, declaration);
      owned.declarationPath = path; owned.sourceId = declaration.definition.source_id;
      bindings.private.objects[object.id].sourceId = owned.sourceId;
    }
    const intent = await save(join(plan.control_root, 'resume-dispatches', item.object_id + '-' + randomUUID() + '.json'),
      { object_id: item.object_id, skill_id: owned.skillId, source_id: owned.sourceId ?? null, at: now(),
        reconciliation: observed.receipt, immediate_absence: absence.artifact, no_pending_operation:skill.receipt, original_plan_sha256: plan.plan_sha256 });
    await persistOwnedBindings(plan, bindings);
    if (owned.placement === 'source') {
      const result = await command(plan, ['ctl','library','source','apply',owned.declarationPath,'--entry',context.entry], 'resume-source-apply', fixtureEnvironment(plan, bindings), {dispatchIntent:intent});
      const selected = result.value.targets?.filter(value => value.skill_id === owned.skillId);
      assert.equal(selected?.length,1); assert.equal(result.value.targets.length,1);
      owned.pageId=selected[0].page_id; owned.sourcePageId=result.value.source_page_id;
      await persistOwnedBindings(plan, bindings);
      await command(plan, ['ctl','library','projection',owned.pageId,'--entry',context.entry], 'resume-projection', fixtureEnvironment(plan, bindings));
      owned.projectionRequired=true;
    } else {
      const args=['ctl','library','skill','create',input.directory,'--entry',context.entry,'--skill-id',owned.skillId,'--name',owned.name,'--description',object.description];
      for (const field of ['requires','members']) for (const target of input[field] ?? []) {
        assert.ok(context.objects[target]?.pageId, 'A prerequisite must be independently ready before creation'); args.push('--'+field,context.objects[target].pageId);
      }
      if(input.enabled!==undefined)args.push('--enabled',String(input.enabled));
      if(input.defaultContext!==undefined)args.push('--default-context',String(input.defaultContext));
      const created=await command(plan,args,'resume-create',fixtureEnvironment(plan,bindings),{dispatchIntent:intent});
      owned.pageId=created.value.page_id; assert.match(owned.pageId,/^[a-f0-9-]{32,36}$/iu);
    }
    const proof=await readAgentFixture(bindings,object.id,{version:object.initial,key:object.id,preserveBindings:true});
    if(owned.placement==='source')assert.ok(proof.observed.projection);
    await persistOwnedBindings(plan,bindings);
    await save(join(plan.control_root,'resume-completed',object.id+'-'+randomUUID()+'.json'),{intent,readback:proof.artifact,at:now()});
  }
  return verifyWorker(plan,{refresh:false,preparationRecovery:true});
}
/** Explicit continuation is allowed only for independently absent, never-dispatched or confirmed prewrite-rejected objects. */
export async function resumeBenchmarkFixturePreparation({controlRoot}={}) {
  await readPlan(controlRoot); return isolatedWorker(controlRoot,'resume');
}


/** Select an already-installed Git in this controller's private bin; never install or edit global settings. */
export async function bindBenchmarkFixtureGit({controlRoot,git}={}) {
  const plan=await readPlan(controlRoot); assert.ok(isAbsolute(git));
  const real=await realpath(git), identity=await byteArtifact(real);
  const result=await new Promise((resolveResult,reject)=>{
    const child=spawn(real,['--no-lazy-fetch','--version'],{stdio:['ignore','pipe','pipe']});
    const out=[],err=[];child.stdout.on('data',data=>out.push(data));child.stderr.on('data',data=>err.push(data));
    child.once('error',reject);child.once('close',code=>resolveResult({code,stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(err).toString()}));
  });
  assert.equal(result.code,0,'The selected existing Git must support --no-lazy-fetch');
  const value={schema_version:1,scope_id:plan.scope_id,git:identity,version:result.stdout.trim(),probe:result,
    selection_scope:'controller-private-bin',global_changes:false,installed:false};
  const path=join(controlRoot,'git-runtime.json');
  if(await exists(path))assert.deepEqual(await json(path),value,'One fixture retains one Git identity');
  else await save(path,value);
  return {status:'selected',receipt:await byteArtifact(path),git:identity,version:value.version};
}
async function installPrivateGitSelection(plan,env) {
  const path=join(plan.control_root,'git-runtime.json'); if(!(await exists(path)))return;
  const selected=await json(path);
  assert.equal((await byteArtifact(selected.git.path)).sha256,selected.git.sha256,'Selected Git bytes changed');
  const bin=env.PATH.split(':')[0];assert.ok(inside(plan.control_root,bin));
  assert.equal(await canonicalTarget(bin),bin);await mkdir(bin,{recursive:true,mode:0o700});
  const target=join(bin,'git');
  if(await exists(target))assert.equal(await realpath(target),selected.git.path,'Private Git target differs');
  else await symlink(selected.git.path,target);
}

async function isolatedWorker(root, action, request = {}) {
  const plan = await readPlan(root);
  const requestPath = join(root, 'requests', action + '-' + randomUUID() + '.json');
  const implementationBytes = await readFile(modulePath);
  const implementation = await put(join(root, 'implementations', sha(implementationBytes) + '.mjs'), implementationBytes);
  await save(requestPath, { action, control_root: root, controller_implementation: implementation, ...request });
  const env = runtimeEnvironment(join(root, 'controller'), plan.build_root, process.env, ['NOTION_API_TOKEN'], plan.node);
  await preparePrivateEnvironment(plan, env);
  await installPrivateGitSelection(plan, env);
  const output = await new Promise((resolveResult, reject) => {
    const child = spawn(plan.node, [modulePath, '--fixture-worker', requestPath], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', value => stdout.push(value)); child.stderr.on('data', value => stderr.push(value));
    child.once('error', reject);
    child.once('close', (code, signal) => resolveResult({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
  const receipt = await save(join(root, 'workers', action + '-' + randomUUID() + '.json'), { completed_at: now(), request: await byteArtifact(requestPath), ...output });
  const resultPath = requestPath + '.result.json';
  if (!(await exists(resultPath))) return { status: 'unknown', effect_unknown: true, worker_receipt: receipt, reason: 'Worker ended without a terminal receipt; reconcile without replaying writes' };
  const result = await json(resultPath);
  return { ...result, worker_receipt: receipt };
}

/** Preparation may allocate only a new task-owned child scope. Re-entry reconciles retained writes. */
export async function prepareBenchmarkFixture(options) {
  const plan = options?.kind === 'benchmark-controller-fixture' ? options : planBenchmarkFixture(options);
  await initializePlan(plan);
  if(plan.git)await bindBenchmarkFixtureGit({controlRoot:plan.control_root,git:plan.git});
  return isolatedWorker(plan.control_root, 'prepare');
}
export async function verifyBenchmarkFixture({ controlRoot } = {}) {
  await readPlan(controlRoot);
  return isolatedWorker(controlRoot, 'verify');
}
export async function reconcileBenchmarkFixture({ controlRoot } = {}) {
  await readPlan(controlRoot);
  return isolatedWorker(controlRoot, 'reconcile');
}
export async function inspectBenchmarkFixture({ controlRoot } = {}) {
  const plan = await readPlan(controlRoot);
  const prepared = await exists(join(controlRoot, 'prepared.json')) ? await json(join(controlRoot, 'prepared.json')) : null;
  const initStarted = await exists(join(controlRoot, 'init-started.json'));
  const objectsStarted = await exists(join(controlRoot, 'objects-started.json'));
  return { schema_version: 1, status: prepared ? 'ready' : initStarted || objectsStarted ? 'pending-reconciliation' : 'planned',
    effect_unknown: !prepared && (initStarted || objectsStarted), plan_sha256: plan.plan_sha256,
    scope_id: plan.scope_id, access: plan.access, episode_id: plan.episode_id, case_ids: plan.case_ids,
    catalog_skill_ids: plan.catalog_skill_ids, prepared, remote_writes: 'none', model_calls: 0 };
}
async function bindingsFor(plan) {
  const path = join(plan.control_root, 'objects', 'bindings.json'), bindings = await json(path);
  assert.equal(bindings.private.fixture.root, join(plan.control_root, 'objects'));
  assert.equal(bindings.private.fixture.runId, plan.scope_id);
  const context=bindings.private.fixture, owner=await json(join(context.root,'ownership.json'));
  assert.equal(owner.runId,plan.scope_id); assert.equal(owner.root,context.root); assert.equal(owner.token,context.ownership.token);
  assert.deepEqual(context.recipe,plan.fixture.recipe,'Fixture declarations changed after freezing');
  assert.deepEqual(Object.keys(context.objects).sort(),Object.values(plan.fixture.skill_mapping).map(item=>item.object_id).sort());
  for(const [skillId,mapping] of Object.entries(plan.fixture.skill_mapping)) { const owned=context.objects[mapping.object_id];
    assert.equal(owned.skillId,'agent-workflow-'+plan.scope_id+'-'+mapping.object_id);
    assert.equal(owned.placement,mapping.placement); assert.equal(owned.external,undefined);
  }
  return { path, bindings };
}
function fixtureEnvironment(plan, bindings) {
  return { ...runtimeEnvironment(join(plan.control_root, 'controller'), plan.build_root, process.env, ['NOTION_API_TOKEN'], plan.node), ...bindings.private.fixture.env };
}

function scopeFetch(plan) {
  return async (url,init) => {
    for(let attempt=1;;attempt++){
      const response=await fetch(url,init);
      if(init.method!=='GET' || response.status!==429 || attempt>=3)return response;
      const body=await response.clone().text();
      let value;try{value=JSON.parse(body);}catch{return response;}
      if(value.code!=='rate_limited')return response;
      const seconds=Number(response.headers.get('retry-after') ?? value.additional_data?.retry_after ?? '1');
      const delay=Math.min(10000,Math.max(250,Number.isFinite(seconds)?seconds*1000:1000));
      await save(join(plan.control_root,'remote-parent','read-retry-'+randomUUID()+'.json'),{
        method:'GET',url,status:response.status,response:body,attempt,retry_after_ms:delay,semantic_writes:'none',at:now(),
      });
      await new Promise(resolveWait=>setTimeout(resolveWait,delay));
    }
  };
}

async function prepareWorker(plan) {
  const root = plan.control_root;
  if(plan.fixture.recipe.objects.some(object=>object.placement==='source'))assert.ok(await exists(join(root,'git-runtime.json')),'Pinned source preparation requires an explicitly selected supported Git before any remote setup');
  if (await exists(join(root, 'prepared.json'))) return verifyWorker(plan);
  let initialized;
  if (await exists(join(root, 'library.json'))) initialized = await json(join(root, 'library.json'));
  else if (await exists(join(root, 'init-started.json'))) {
    return saveOperationResult(plan, 'preparation', { status: 'unknown', effect_unknown: true, reason: 'Library initialization was dispatched without a verified terminal receipt. Retain the same parent and operation for public recovery.' });
  } else {
    const parent = await ensureRemoteParent({ projectPageId: plan.project_page_id, scopeId: plan.scope_id,
      title: 'Benchmark material ' + plan.scope_id, controlDir: join(root, 'remote-parent'), fetchImpl:scopeFetch(plan) });
    await save(join(root, 'init-started.json'), { parent, at: now(), plan_sha256: plan.plan_sha256 });
    const env = runtimeEnvironment(join(root, 'init'), plan.build_root, process.env, ['NOTION_API_TOKEN'], plan.node);
    await preparePrivateEnvironment(plan, env);
    const init = await command(plan, ['ctl', 'library', 'init', '--parent', parent.page_id], 'library-init', env);
    const entry = init.value.library?.skills?.database_id ?? init.value.result?.library?.skills?.database_id;
    assert.match(entry, /^[a-f0-9-]{32,36}$/iu, 'A successful init must expose its actual library entry');
    initialized = { parent_page_id: parent.page_id, entry, command: init.receipt };
    await save(join(root, 'library.json'), initialized);
  }
  const fixtureRoot = join(root, 'objects');
  if (await exists(fixtureRoot) || await exists(join(root, 'objects-started.json'))) {
    return verifyWorker(plan, { preparationRecovery: true });
  }
  await save(join(root, 'objects-started.json'), { at: now(), entry: initialized.entry, plan_sha256: plan.plan_sha256 });
  await prepareAgentFixtures({ recipe: plan.fixture.recipe, runId: plan.scope_id, root: fixtureRoot, entry: initialized.entry,
    cli: plan.cli, node: plan.node, globalSkillsRoot: join(root, 'unused-global-skills') });
  return verifyWorker(plan, { refresh: false });
}
async function saveOperationResult(plan, action, value) {
  const result = { schema_version: 1, action, scope_id: plan.scope_id, at: now(), model_calls: 0, ...value };
  const receipt = await save(join(plan.control_root, 'results', action + '-' + randomUUID() + '.json'), result);
  return { ...result, receipt };
}
async function verifyWorker(plan, { refresh = true, preparationRecovery = false } = {}) {
  const root = plan.control_root, original = await bindingsFor(plan), bindings = original.bindings, context = bindings.private.fixture;
  const aliases = Object.values(plan.fixture.skill_mapping).map(item => item.object_id);
  if (refresh) {
    for (const alias of aliases) {
      const stableId = Object.keys(plan.fixture.skill_mapping).find(id => plan.fixture.skill_mapping[id].object_id === alias);
      if (plan.initially_absent_skill_ids.includes(stableId)) continue;
      assert.ok(context.objects[alias], 'Preparation has not produced this owned object; no fresh creation is allowed');
      await readAgentFixture(bindings, alias, { version: plan.fixture.skill_mapping[stableId].initial_version, key: alias, preserveBindings: true });
    }
  }
  const versionRoot = join(root, 'verified', randomUUID()); await mkdir(versionRoot, { recursive: true, mode: 0o700 });
  const bindingsSnapshot = await save(join(versionRoot, 'fixture-bindings.json'), bindings);
  const publicCases = [], identity = {};
  for (const selected of plan.case_plans) {
    const bound = bindPublicCaseToFixture({ publicCase: selected.publicCase, skillMapping: plan.fixture.skill_mapping, bindings });
    publicCases.push(bound.publicCase); Object.assign(identity, bound.identity_map);
  }
  for(const [skillId,mapping] of Object.entries(plan.fixture.skill_mapping)) {
    const actual=identity[skillId].bound_name; assert.match(actual,/^[a-z0-9][a-z0-9-]{0,63}$/u,'Actual Skill names must be safe native directory names');
    if(!plan.initially_absent_skill_ids.includes(skillId))assert.equal(actual,mapping.placement==='source'?mapping.name:context.objects[mapping.object_id].name,'Actual invocation names differ from the declared source/native binding');
  }
  const remoteIds = plan.catalog_skill_ids.filter(id => !['project', 'global'].includes(plan.fixture.skill_mapping[id].placement) && !plan.initially_absent_skill_ids.includes(id));
  const listed = await command(plan, ['list', '--database', context.entry, '--refresh', '--limit', '500', '--json'], 'catalog', fixtureEnvironment(plan, bindings), { timeoutMs: 240000 });
  const catalog = listed.value;
  assert.equal(catalog.coverage?.exhaustive, true, 'Catalog coverage must be exhaustive');
  assert.deepEqual(catalog.coverage.failed_sources, []); assert.equal(catalog.has_more, false);
  assert.deepEqual(catalog.records.map(item => item.name).sort(), remoteIds.map(id => identity[id].bound_name).sort(), 'The actual remote catalog differs from the declared placement');
  const packageRoot = dirname(dirname(plan.cli)), manifest = await json(join(packageRoot, 'package.json'));
  const exported = manifest.exports['./sdk'], sdkPath = join(packageRoot, typeof exported === 'string' ? exported : exported.import ?? exported.default);
  const sdk = await import(pathToFileURL(sdkPath).href), sdkArtifact = await byteArtifact(sdkPath);
  const expected = plan.fixture.expected_inventory.filter(item => !plan.initially_absent_skill_ids.includes(item.skill_id));
  const observedFiles = [], comparisons = [], evidence = [];
  for (const wanted of expected) {
    const mapping = plan.fixture.skill_mapping[wanted.skill_id], alias = mapping.object_id, observed = context.observedReadbacks[alias];
    assert.equal(observed?.status, 'passed'); assert.equal(observed.externalRepair, false);
    if (mapping.placement === 'source') assert.ok(observed.observed.projection, 'Pinned source preparation requires its real reading projection');
    if (!['project', 'global'].includes(mapping.placement)) assert.ok(observed.assertions.some(item => item.id === 'normal-consumption-zero-writes' && item.status === 'passed'));
    const file = observed.observed.files.find(item => item.path === wanted.path); assert.ok(file, 'An expected resource is absent from actual consumption');
    const bodyKey = file.bodyKey ?? alias + '@' + wanted.version + '/' + wanted.path;
    const body = bindings.private.bodies[bodyKey]; assert.ok(body);
    const bytes = await readFile(body.path); assert.equal(sha(bytes), body.sha256); assert.equal(sha(bytes), file.sha256);
    assert.equal(bytes.length, file.bytes); assert.equal(file.mode, wanted.mode, 'Executable/resource modes must match');
    const canonicalBytes = Buffer.from(wanted.content, wanted.encoding);
    const canonical = await put(join(versionRoot, 'canonical', wanted.skill_id, wanted.path), canonicalBytes, wanted.mode);
    const preparedInput = context.objects[alias].versionInputs[wanted.version].files.find(item => item.path === wanted.path);
    const prepared = preparedInput ? await byteArtifact(preparedInput.input) : canonical;
    if (preparedInput) assert.equal(prepared.sha256, preparedInput.sha256);
    const sources = { canonical_source: canonical, prepared_source: prepared, actual_source: await byteArtifact(body.path), receipt: observed.artifact, raw_receipt: observed.rawEvidence };
    const actual = { ...wanted, content: bytes.toString(wanted.encoding), sha256: sha(bytes), bytes: bytes.length, mode: file.mode, authorized: true,
      actual_path: body.path, bound_name: identity[wanted.skill_id].bound_name };
    let comparison;
    if (wanted.path === 'SKILL.md' && mapping.placement !== 'source') {
      const intended = splitMain((await readFile(prepared.path)).toString('utf8')), served = splitMain(bytes.toString('utf8')), canonicalMain = splitMain(wanted.content);
      assert.equal(served.header, intended.header, 'The actual frontmatter differs from the public name binding');
      const cb = sdk.compareNativeMarkdown({ expected: canonicalMain.body, observed: served.body });
      const pb = sdk.compareNativeMarkdown({ expected: intended.body, observed: served.body });
      assert.ok(['exact', 'normalized'].includes(cb) && ['exact', 'normalized'].includes(pb), 'Public native Markdown comparison failed');
      comparison = { method: 'public-sdk-native-structural-equivalence', canonical_body_comparison: cb, prepared_body_comparison: pb,
        frontmatter_matches_prepared: true, prepared_header_sha256: sha(intended.header), actual_header_sha256: sha(served.header),
        public_sdk_path: sdkPath, public_sdk_sha256: sdkArtifact.sha256, public_name_binding: { canonical: mapping.name, actual: actual.bound_name } };
    } else {
      assert.equal(actual.sha256, wanted.sha256, 'An exact source/resource differs from the full public material');
      comparison = { method: 'exact-bytes', canonical_body_comparison: 'exact', prepared_body_comparison: 'exact' };
    }
    comparisons.push({ skill_id: wanted.skill_id, path: wanted.path, ...sources, ...comparison, matched: true,
      comparison: { matched: true, method: comparison.method }, canonical_sha256: wanted.sha256, prepared_sha256: prepared.sha256, actual_sha256: actual.sha256 });
    observedFiles.push(actual);
    evidence.push({ evidence_id: 'fixture-' + plan.scope_id + '-' + alias + '-' + wanted.path, kind: 'resource', skill_id: wanted.skill_id,
      path: wanted.path, ...sources, canonical_sha256: wanted.sha256, actual_sha256: actual.sha256, source: sources.actual_source });
  }
  for (const alias of aliases) {
    const skillId = plan.catalog_skill_ids.find(id => plan.fixture.skill_mapping[id].object_id === alias);
    if (plan.initially_absent_skill_ids.includes(skillId)) continue;
    assert.deepEqual(context.observedReadbacks[alias].observed.files.map(item => item.path).sort(),
      expected.filter(item => item.skill_id === skillId).map(item => item.path).sort(), 'Unexpected files change the whole-tree parity');
  }
  const parity = verifyMaterialization({ expected, observed: observedFiles, skillMapping: plan.fixture.skill_mapping,
    compareMain: ({ expected: wanted, observed }) => comparisons.some(item => item.skill_id === wanted.skill_id && item.path === wanted.path &&
      item.actual_sha256 === observed.sha256 && item.comparison.matched) });
  assert.equal(parity.status, 'valid');
  const nativeRoot = join(versionRoot, 'native-equivalent'), nativeSkillRoot = join(nativeRoot, '.agents/skills'), files = [];
  for (const file of observedFiles) {
    const relativePath = '.agents/skills/' + file.bound_name + '/' + file.path, path = join(nativeRoot, relativePath);
    const artifact = await put(path, await readFile(file.actual_path), file.mode);
    files.push({ ...artifact, relative_path: relativePath, skill_id: file.skill_id, resource_path: file.path, mode: file.mode });
  }
  for (const publicCase of publicCases) for (const input of publicCase.attachments) await put(join(versionRoot, 'business-inputs', publicCase.id, input.path), Buffer.from(input.content, input.encoding), input.mode);
  const visibility = await auditVisibleMaterial({ roots: [nativeRoot], canaries: plan.corpus.control.canaries,
    forbiddenPaths: [join(root, 'plan.json'), join(root, 'objects/commands'), join(root, 'objects/readbacks')] });
  assert.equal(visibility.status, 'valid');
  const source = plan.fixture.recipe.objects.filter(item => item.placement === 'source').map(item => ({
    object_id: item.id, commit: item.source.declaration.definition.adapter.ref,
    url: item.source.declaration.definition.adapter.url, member_key: item.source.memberKey, verified: !plan.initially_absent_skill_ids.some(id => plan.fixture.skill_mapping[id].object_id === item.id),
  }));
  const proof = { schema_version: 1, status: 'passed', completed_at: now(), scope_id: plan.scope_id, evidence_scope: plan.evidence_scope,
    public_sha256: plan.corpus.publicCorpus.content_sha256, entry: context.entry, parent_page_id: (await json(join(root, 'library.json'))).parent_page_id,
    candidate_count: plan.candidate_count, actual_remote_candidates: remoteIds.length, actual_local_candidates: plan.catalog_skill_ids.length - remoteIds.length - plan.initially_absent_skill_ids.length,
    initially_absent_skill_ids: plan.initially_absent_skill_ids, case_ids: plan.case_ids, catalog_skill_ids: plan.catalog_skill_ids,
    parity, canonical_to_actual: comparisons, identity_map: identity, public_cases: publicCases, files, evidence, visibility,
    catalog: { ...listed.receipt, candidates: catalog.records.length, exhaustive: true }, source_materials: source,
    native_root: nativeRoot, native_skill_root: nativeSkillRoot, fixture_bindings: bindingsSnapshot,
    fidelity: { native_body: 'Public SDK structural equivalence; both conditions receive exact served bytes',
      resource_bytes: 'Exact complete canonical content and executable mode', permission: 'Declared credential scope and public zero-write consumption receipts',
      remote_management: 'Public product interfaces only', local_discovery: 'Filesystem preparation alone does not prove model admission' },
    controller_git: await exists(join(root,'git-runtime.json')) ? await byteArtifact(join(root,'git-runtime.json')) : null,
    model_calls: 0, remote_repairs: 0, preparation_reconciled: preparationRecovery };
  const proofRef = await save(join(versionRoot, 'materialization-proof.json'), proof);
  const saved = await writeCorpus({ corpus: plan.corpus, publicRoot: join(root, 'public-corpus'), controlRoot: join(root, 'private-corpus') });
  const binding = { schema_version: 1, status: 'ready', public_corpus_path: saved.public_path, control_path: saved.control_path,
    public_sha256: plan.corpus.publicCorpus.content_sha256, control_root: root, scope_id: plan.scope_id, access: plan.access, episode_id: plan.episode_id,
    entry: context.entry, parent_page_id: proof.parent_page_id, case_ids: plan.case_ids, catalog_skill_ids: plan.catalog_skill_ids,
    placements:Object.fromEntries(Object.entries(plan.fixture.skill_mapping).map(([id,item])=>[id,item.placement])),
    local_skill_ids:plan.catalog_skill_ids.filter(id=>['project','global'].includes(plan.fixture.skill_mapping[id].placement)),
    identity_map: identity, materialization_proof: proofRef, native_root: nativeRoot, native_skill_root: nativeSkillRoot,
    fixture_bindings_path: original.path, prepared_bindings: bindingsSnapshot,
    events: plan.events.map(event => ({ id: event.id, ...(event.case_id ? { case_id: event.case_id } : {}), before_turn: event.before_turn ?? null, logical_operation: event.logical_operation })),
    clarification: plan.case_plans.flatMap(item => item.clarification ?? []).map(({ topic_id, max_questions, response }) => ({ topic_id, max_questions, response })),
    evidence_scope: plan.evidence_scope };
  const bindingRef = await save(join(versionRoot, 'binding.json'), binding);
  const result = { status: 'ready', effect_unknown: false, binding_path: bindingRef.path, binding: bindingRef, materialization_proof: proofRef,
    entry: context.entry, native_skill_root: nativeSkillRoot, case_ids: plan.case_ids, source_materials: source,
    actual_remote_candidates: remoteIds.length, actual_local_candidates: proof.actual_local_candidates, model_calls: 0, remote_repairs: 0 };
  if (!(await exists(join(root, 'prepared.json')))) await save(join(root, 'prepared.json'), result);
  return saveOperationResult(plan, 'verification', result);
}

const runtimeRootKeys = ['NTN_SKILLS_HOME', 'NTN_SKILLS_CONFIG_HOME', 'NTN_SKILLS_CACHE_HOME', 'NTN_SKILLS_DATA_HOME'];
function selectedRuntimeEnvironment(value = {}) {
  return Object.fromEntries(runtimeRootKeys.map(key => { assert.ok(isAbsolute(value[key] ?? ''), 'All actual runtime Store roots are required'); return [key, value[key]]; }));
}
async function validateEpisode(plan, episodeId, { mutation = true } = {}) {
  assert.ok(id(episodeId) && episodeId === plan.episode_id, 'An event must belong to its frozen episode');
  if (mutation) assert.equal(plan.access, 'episode-owned', 'Shared read-only fixtures cannot be mutated');
}
async function frozenEvent(plan, eventId, episodeId) {
  await validateEpisode(plan, episodeId);
  const event = plan.events.find(item => item.id === eventId);
  assert.ok(event, 'Unknown frozen event');
  return event;
}
function eventDirectory(plan, eventId, episodeId) {
  assert.ok(id(eventId) && id(episodeId));
  return join(plan.control_root, 'events', eventId + '-' + sha(episodeId).slice(0, 12));
}
async function eventReceipt(plan, event, episodeId, status, details = {}, terminal = false) {
  const directory = eventDirectory(plan, event.id, episodeId);
  const value = { schema_version: 1, event_id: event.id, episode_id: episodeId, status,
    logical_operation: event.logical_operation, effect_unknown: status === 'unknown', observed_at: now(),
    evidence_id: 'fixture-event-' + plan.scope_id + '-' + event.id + '-' + randomUUID(), model_calls: 0, ...details };
  const path = join(directory, terminal ? 'terminal.json' : 'readback-' + randomUUID() + '.json');
  const receipt = await save(path, value);
  return { ...value, receipt };
}
async function retainedTerminal(plan, event, episodeId) {
  const path = join(eventDirectory(plan, event.id, episodeId), 'terminal.json');
  if (!(await exists(path))) return null;
  const value = await json(path);
  assert.equal(value.event_id, event.id); assert.equal(value.episode_id, episodeId);
  assert.ok(['applied', 'blocked', 'failed', 'unknown'].includes(value.status));
  if (value.status === 'applied') {
    assert.equal(value.effect_verified, true);
    assert.ok(Array.isArray(value.effect_evidence) && value.effect_evidence.length > 0, 'Applied requires independent effect evidence');
    for (const artifact of value.effect_evidence ?? []) assert.equal((await byteArtifact(artifact.path)).sha256, artifact.sha256, 'Retained effect evidence changed');
  }
  return { ...value, receipt: await byteArtifact(path), reused: true };
}

/** Bind only an already-created episode Store; this does not seed its content or snapshots. */
export async function attachBenchmarkFixtureRuntime({ controlRoot, episodeId, ownedStateRoot, runtimeEnv } = {}) {
  const plan = await readPlan(controlRoot); await validateEpisode(plan, episodeId);
  assert.ok(plan.owned_runtime_root, 'Freeze the runtime root before attaching a Store');
  const env = selectedRuntimeEnvironment(runtimeEnv);
  assert.equal(ownedStateRoot, env.NTN_SKILLS_HOME);
  assert.equal(new Set(Object.values(env)).size, runtimeRootKeys.length);
  for (const path of Object.values(env)) {
    assert.ok(inside(plan.owned_runtime_root, path), 'Runtime roots must remain inside the frozen episode root');
    assert.equal(await canonicalTarget(path), path);
  }
  assert.equal(await realpath(ownedStateRoot), ownedStateRoot);
  assert.ok((await lstat(ownedStateRoot)).isDirectory());
  const runPath=join(plan.owned_runtime_root,'run.json'), runtimeEvents=join(plan.owned_runtime_root,'benchmark/runtime/events.jsonl');
  const runBytes=await readFile(runPath), run=JSON.parse(runBytes), eventBytes=await readFile(runtimeEvents);
  const firstLF=eventBytes.indexOf(10); assert.ok(firstLF>=0,'Runtime ownership needs a complete recorded start event');
  const startBytes=eventBytes.subarray(0,firstLF+1), start=JSON.parse(startBytes.toString('utf8'));
  assert.equal(run.run_id,episodeId); assert.equal(start.type,'runtime_start');
  assert.equal(start.run_id,run.run_id); assert.equal(start.episode_id,episodeId);
  assert.ok(typeof start.candidate_id==='string' && typeof start.task_id==='string');
  assert.ok(inside(plan.owned_runtime_root,start.data.cwd),'Actual runtime cwd must belong to its frozen root');
  const existingBindingPath=join(controlRoot,'runtime-binding.json');
  if(await exists(existingBindingPath)) {
    const previous=await json(existingBindingPath); assert.equal(previous.episode_id,episodeId);
    assert.equal(previous.owned_state_root,ownedStateRoot); assert.deepEqual(previous.runtime_env,env);
    assert.equal(previous.runtime_start.sha256,sha(startBytes),'Runtime start changed');
    return {status:'attached',receipt:await byteArtifact(existingBindingPath),reused:true,seeded_content:false};
  }
  const runSnapshot=await put(join(controlRoot,'runtime-observations','run-'+randomUUID()+'.json'),runBytes);
  const startSnapshot=await put(join(controlRoot,'runtime-observations','start-'+randomUUID()+'.jsonl'),startBytes);
  const { bindings } = await bindingsFor(plan), context = bindings.private.fixture;
  const marker = { runId: context.runId, fixtureRoot: context.root, token: context.ownership.token };
  const markerPath = join(ownedStateRoot, 'agent-workflow-owner.json');
  if (await exists(markerPath)) assert.deepEqual(await json(markerPath), marker, 'The runtime Store belongs to another fixture');
  else await save(markerPath, marker);
  const binding = { schema_version: 1, episode_id: episodeId, owned_state_root: ownedStateRoot, runtime_env: env, ownership_marker: await byteArtifact(markerPath), run_snapshot:runSnapshot, runtime_start:{...startSnapshot,source_path:runtimeEvents,source_line:1}, actual_run_path:runPath };
  const path = join(controlRoot, 'runtime-binding.json');
  if (await exists(path)) assert.deepEqual(await json(path), binding, 'Runtime attachment cannot change within one episode');
  else await save(path, binding);
  return { status: 'attached', effect: 'ownership-marker-only', receipt: await byteArtifact(path), seeded_content: false };
}
async function attachedRuntime(plan) {
  const runtime = await json(join(plan.control_root, 'runtime-binding.json'));
  assert.equal(runtime.episode_id, plan.episode_id);
  const env = selectedRuntimeEnvironment(runtime.runtime_env);
  assert.equal(env.NTN_SKILLS_HOME, runtime.owned_state_root);
  for (const path of Object.values(env)) assert.ok(plan.owned_runtime_root && inside(plan.owned_runtime_root, path));
  return { ...runtime, runtime_env: env };
}
async function runtimeProbe(plan, bindings, alias, runtime, label, expectedFailure = false) {
  const object = bindings.private.objects[alias], version = object.versions[object.currentVersion];
  const main = version.bodyKeys.map(key => bindings.private.bodies[key]).find(item => item.resourcePath === 'SKILL.md');
  assert.ok(main && /^s_[a-f0-9]{64}$/u.test(version.snapshot_id), 'A runtime probe needs a real consumed snapshot');
  let response;
  try { response = await command(plan, ['read', version.snapshot_id, '--offline', '--json', '--metrics'], label,
    { ...fixtureEnvironment(plan, bindings), ...runtime.runtime_env }, { timeoutMs: 60000 }); }
  catch (error) {
    if (!expectedFailure) throw error;
    const ref = error.details?.receipt; assert.ok(ref);
    const retained = await json(ref.path), value = JSON.parse(retained.stdout);
    assert.equal(value.ok, false); assert.equal(value.error.code, 'STATE_UNAVAILABLE');
    return { status: 'unavailable', receipt: ref, error: value.error };
  }
  assert.equal(expectedFailure, false, 'The faulted runtime unexpectedly remained readable');
  const value = response.value;
  assert.equal(value.snapshot_id, version.snapshot_id); assert.equal(value.version_id, version.version_id);
  assert.equal(value.record?.id, object.owner); assert.equal(value.scope, object.scope);
  assert.equal(value.path, 'SKILL.md'); assert.equal(sha(value.content), main.sha256);
  assert.equal(value.has_more, false); assert.equal(value.effects?.remote_writes, 'none');
  assert.equal(value.request_metrics?.total_requests, 0);
  return { status: 'ready', receipt: response.receipt, snapshot_id: version.snapshot_id, sha256: main.sha256 };
}
async function frozenVersionExport(plan, bindings, skillId, version, eventId) {
  const mapping = plan.fixture.skill_mapping[skillId], alias = mapping.object_id;
  const wanted = plan.fixture.planned_inventory.filter(item => item.skill_id === skillId && item.version === version);
  const identity = bindings.private.objects[alias], observed = bindings.private.fixture.observedReadbacks[alias];
  // A version-specific helper receipt may use a distinct key.
  const readbackKey = identity.versions[version]?.readback;
  const readback = bindings.private.fixture.observedReadbacks[readbackKey] ?? observed;
  assert.equal(readback?.status, 'passed');
  assert.match(identity.name,/^[a-z0-9][a-z0-9-]{0,63}$/u,'An observed version needs a safe owned invocation name');
  const root = join(plan.control_root, 'event-native-versions', eventId + '-' + randomUUID()), files = [];
  assert.deepEqual(readback.observed.files.map(item => item.path).sort(), wanted.map(item => item.path).sort());
  for (const file of readback.observed.files) {
    const body = bindings.private.bodies[file.bodyKey], bytes = await readFile(body.path);
    assert.equal(sha(bytes), file.sha256);
    const expected = wanted.find(item => item.path === file.path); assert.equal(file.mode, expected.mode);
    if (file.path !== 'SKILL.md') assert.equal(file.sha256, expected.sha256);
    const path = join(root, identity.name, file.path);
    files.push({ ...(await put(path, bytes, file.mode)), skill_id: skillId, resource_path: file.path, mode: file.mode, version });
  }
  return { skill_root: root, files, readback: readback.artifact, raw_readback: readback.rawEvidence,
    target_name: identity.name, applies_to: 'Controller must install this verified tree at the declared between-turn boundary for a native subject' };
}
async function persistOwnedBindings(plan, bindings) {
  const path = join(plan.control_root, 'objects', 'bindings.json');
  await save(join(plan.control_root, 'history', 'bindings-before-' + randomUUID() + '.json'), await json(path));
  const temporary = join(plan.control_root, 'objects', 'bindings-controller-' + randomUUID() + '.json');
  await save(temporary, bindings); await rename(temporary, path);
  return byteArtifact(path);
}
async function restoreFault(plan, bindings, event, runtime) {
  const mapping = plan.fixture.skill_mapping[event.skill_id], context = bindings.private.fixture;
  const fault = [...(context.faults ?? [])].reverse().find(item => item.object === mapping.object_id && item.status !== 'restored');
  assert.ok(fault, 'No owned fault is available to restore');
  assert.ok(inside(join(context.root, 'quarantine'), fault.target) && inside(plan.owned_runtime_root, fault.source));
  assert.ok(await exists(fault.target), 'A missing quarantine outcome requires read-only reconciliation');
  assert.ok(!(await lstat(fault.target)).isSymbolicLink());
  if (await exists(fault.source)) {
    assert.equal(fault.mode, 'store-unavailable');
    const marker = await json(fault.source);
    assert.equal(marker.fixtureFault, context.ownership.token); assert.equal(marker.restoreFrom, fault.target);
    await rename(fault.source, join(context.root, 'quarantine', 'retained-fault-marker-' + randomUUID()));
  }
  await mkdir(dirname(fault.source), { recursive: true, mode: 0o700 });
  await rename(fault.target, fault.source);
  const proof = await runtimeProbe(plan, bindings, mapping.object_id, runtime, 'restore-runtime-read');
  fault.status = 'restored'; fault.restoration = { at: now(), proof };
  await persistOwnedBindings(plan, bindings);
  return { status: 'passed', result: { kind: 'restore-owned-fault', proof } };
}
async function applyEventWorker(plan, { eventId, episodeId }) {
  const event = await frozenEvent(plan, eventId, episodeId), prior = await retainedTerminal(plan, event, episodeId);
  if (prior) return prior;
  const directory = eventDirectory(plan, eventId, episodeId), claimPath = join(directory, 'started.json');
  if (await exists(claimPath)) return reconcileEventWorker(plan, { eventId, episodeId });
  const { path: bindingsPath, bindings } = await bindingsFor(plan), mapping = plan.fixture.skill_mapping[event.skill_id];
  const context = bindings.private.fixture, owned = context.objects[mapping.object_id];
  assert.ok(owned && !owned.external, 'Only exact owned objects may receive events');
  let runtime;
  if (['fault', 'restore-fault'].includes(event.kind)) runtime = await attachedRuntime(plan);
  const before = event.kind === 'fault' ? await runtimeProbe(plan, bindings, mapping.object_id, runtime, 'fault-runtime-before') : null;
  await save(claimPath, { event_id: eventId, episode_id: episodeId, plan_sha256: plan.plan_sha256,
    logical_operation: event.logical_operation, dispatch_state: 'claimed-before-dispatch', at: now(), before });
  try {
    let result, readback, nativeVersion;
    if (event.kind === 'restore-fault') result = await restoreFault(plan, bindings, event, runtime);
    else if (event.kind === 'readback') {
      readback = await readAgentFixture(bindings, mapping.object_id, { key: event.id + '-readback', preserveBindings: true });
      result = { status: 'passed', result: { readback }, artifact: readback.artifact };
    } else {
      const legacy = { kind: event.kind, object: mapping.object_id };
      for (const key of ['version', 'maxRequests', 'enabled', 'defaultContext', 'mode']) if (event[key] !== undefined) legacy[key] = event[key];
      result = await runAgentFixtureEvent(legacy, { bindings, bindingsPath,
        ...(runtime ? { ownedStateRoot: runtime.owned_state_root, runtimeEnv: runtime.runtime_env } : {}) });
    }
    assert.equal(result.status, 'passed');
    const effectEvidence = [result.artifact, result.result?.artifact, result.result?.readback?.artifact, result.result?.readback?.rawEvidence,
      result.result?.proof?.receipt, result.result?.proof?.after?.command].filter(Boolean);
    if (event.kind === 'publish-version' || event.kind === 'resume-source-write') {
      const version = event.version ?? owned.currentVersion;
      readback = await readAgentFixture(bindings, mapping.object_id, { version, key: event.id + '-verified', preserveBindings: true });
      nativeVersion = await frozenVersionExport(plan, bindings, event.skill_id, version, event.id);
      effectEvidence.push(readback.artifact, readback.rawEvidence);
    } else if (event.kind === 'set-enabled') {
      readback = await readAgentFixture(bindings, mapping.object_id, { properties: { enabled: event.enabled,
        ...(event.defaultContext === undefined ? {} : { defaultContext: event.defaultContext }) }, key: event.id + '-verified', preserveBindings: true });
      effectEvidence.push(readback.artifact, readback.rawEvidence);
    } else if (event.kind === 'fault') {
      assert.equal(result.result.verifiedAbsent, true);
      if (event.mode === 'store-unavailable') {
        assert.equal(result.result.proof?.before?.status, 'passed');
        assert.equal(result.result.proof?.after?.expected, true);
        effectEvidence.push(result.result.proof.before.command, result.result.proof.after.command, result.result.proof.blocker.artifact);
      } else {
        assert.equal(await exists(result.result.source), false); assert.equal(await exists(result.result.quarantine), true);
      }
    } else if (event.kind === 'interrupt-source-write') {
      assert.equal(result.result?.status, 'passed');
      assert.equal(result.result?.observed?.state, 'applying');
      assert.equal(result.result?.observed?.skillState, 'ready');
      assert.equal(result.result?.observed?.skillOperation, '');
      assert.equal(result.result?.observed?.operationId, owned.sourceOperation.id);
    }
    assert.ok(effectEvidence.length, 'A controller event needs retained independent effect evidence');
    for (const artifact of effectEvidence) assert.equal((await byteArtifact(artifact.path)).sha256, artifact.sha256);
    return eventReceipt(plan, event, episodeId, 'applied', { effect_verified: true, effect_evidence: effectEvidence,
      result, ...(nativeVersion ? { native_version: nativeVersion } : {}), ...(before ? { before } : {}) }, true);
  } catch (error) {
    // Dispatch has been claimed. Neither rejection nor an exception proves that no effect occurred.
    return eventReceipt(plan, event, episodeId, 'unknown', { effect_verified: false,
      error: errorValue(error), ...(error.fixtureEventArtifact ? { raw_event: await byteArtifact(error.fixtureEventArtifact).catch(() => null) } : {}),
      recovery: 'Use read-only reconciliation. No automatic event replay follows an unknown outcome.' }, true);
  }
}
async function reconcileEventWorker(plan, { eventId, episodeId }) {
  const event = await frozenEvent(plan, eventId, episodeId), prior = await retainedTerminal(plan, event, episodeId);
  const claimed = await exists(join(eventDirectory(plan, eventId, episodeId), 'started.json'));
  const { bindings } = await bindingsFor(plan), mapping = plan.fixture.skill_mapping[event.skill_id], owned = bindings.private.fixture.objects[mapping.object_id];
  try {
    if (event.kind === 'publish-version' || event.kind === 'resume-source-write' || event.kind === 'readback') {
      const targetVersion = event.version ?? owned.currentVersion;
      const readback = await readAgentFixture(bindings, mapping.object_id, { version: targetVersion, key: event.id + '-reconciled', preserveBindings: true });
      const evidence = [readback.artifact, readback.rawEvidence].filter(Boolean);
      if (!claimed && event.kind !== 'readback') {
        // Target bytes already present before a dispatch are not proof this controller caused them.
        return eventReceipt(plan, event, episodeId, 'unknown', { effect_verified: false, effect_evidence: evidence, reason: 'Target state exists without an owned event dispatch' });
      }
      const nativeVersion = event.kind === 'readback' ? null : await frozenVersionExport(plan, bindings, event.skill_id, targetVersion, event.id);
      return eventReceipt(plan, event, episodeId, 'applied', { effect_verified: true, reconciled: true, effect_evidence: evidence, ...(nativeVersion ? { native_version: nativeVersion } : {}) });
    }
    if (event.kind === 'set-enabled') {
      const readback = await readAgentFixture(bindings, mapping.object_id, { properties: { enabled: event.enabled }, key: event.id + '-reconciled', preserveBindings: true });
      if (!claimed) return eventReceipt(plan, event, episodeId, 'unknown', { effect_verified: false, reason: 'Observed metadata without an owned dispatch', effect_evidence: [readback.artifact] });
      return eventReceipt(plan, event, episodeId, 'applied', { effect_verified: true, reconciled: true, effect_evidence: [readback.artifact, readback.rawEvidence].filter(Boolean) });
    }
    if (event.kind === 'fault' || event.kind === 'restore-fault') {
      const runtime = await attachedRuntime(plan);
      const fault = [...(bindings.private.fixture.faults ?? [])].reverse().find(item => item.object === mapping.object_id);
      if (claimed && fault) {
        if (event.kind === 'fault') {
          assert.ok(await exists(fault.target));
          assert.equal(await exists(fault.source), fault.mode === 'store-unavailable');
          const proof = fault.mode === 'store-unavailable' ? await runtimeProbe(plan, bindings, mapping.object_id, runtime, 'reconcile-fault', true) : null;
          const state = await save(join(eventDirectory(plan, eventId, episodeId), 'fault-observation-' + randomUUID() + '.json'),
            { fault, source_exists: await exists(fault.source), quarantine_exists: true, probe: proof, at: now() });
          return eventReceipt(plan, event, episodeId, 'applied', { effect_verified: true, reconciled: true, effect_evidence: [state, proof?.receipt].filter(Boolean) });
        }
        const proof = await runtimeProbe(plan, bindings, mapping.object_id, runtime, 'reconcile-restored');
        assert.equal(await exists(fault.target), false);
        return eventReceipt(plan, event, episodeId, 'applied', { effect_verified: true, reconciled: true, effect_evidence: [proof.receipt] });
      }
      if (!claimed) {
        const proof = await runtimeProbe(plan, bindings, mapping.object_id, runtime, 'reconcile-before-dispatch');
        return eventReceipt(plan, event, episodeId, 'not_applied', { effect_verified: true, dispatch_absent: true, effect_evidence: [proof.receipt] });
      }
    }
    return eventReceipt(plan, event, episodeId, 'unknown', { effect_verified: false, reason: 'No complete read-only proof of the requested effect', retained_terminal: prior?.receipt ?? null });
  } catch (error) {
    if (!claimed && ['publish-version', 'set-enabled'].includes(event.kind)) {
      try {
        const baseline = await readAgentFixture(bindings, mapping.object_id, { version: mapping.initial_version, key: event.id + '-unchanged-baseline', preserveBindings: true });
        return eventReceipt(plan, event, episodeId, 'not_applied', { effect_verified: true, dispatch_absent: true,
          effect_evidence: [baseline.artifact, baseline.rawEvidence].filter(Boolean) });
      } catch { /* an incomplete initial state never establishes not-applied */ }
    }
    return eventReceipt(plan, event, episodeId, 'unknown', { effect_verified: false, error: errorValue(error), retained_terminal: prior?.receipt ?? null });
  }
}
async function eventCall(action, { controlRoot, eventId, episodeId } = {}) {
  const plan = await readPlan(controlRoot), event = await frozenEvent(plan, eventId, episodeId);
  if (action === 'event') { const prior = await retainedTerminal(plan, event, episodeId); if (prior) return prior; }
  const result = await isolatedWorker(controlRoot, action, { eventId, episodeId });
  if (result.event_id === eventId && result.episode_id === episodeId && result.receipt) return result;
  const prior = await retainedTerminal(plan, event, episodeId);
  if (prior) return prior;
  return eventReceipt(plan, event, episodeId, 'unknown', { effect_verified: false, worker_result: result, reason: 'Worker ended without a verified event terminal' });
}
export const applyBenchmarkFixtureEvent = options => eventCall('event', options);
export const reconcileBenchmarkFixtureEvent = options => eventCall('reconcile-event', options);

async function worker(requestPath) {
  const request = await json(requestPath), plan = await readPlan(request.control_root);
  assert.ok(inside(join(plan.control_root, 'requests'), requestPath));
  if (request.controller_implementation) {
    assert.equal((await byteArtifact(request.controller_implementation.path)).sha256, request.controller_implementation.sha256);
    assert.equal((await byteArtifact(modulePath)).sha256, request.controller_implementation.sha256, 'Controller implementation changed during worker launch');
  }
  const release = await takeLease(plan.control_root, request.action);
  let result;
  try {
    if (request.action === 'prepare') result = await prepareWorker(plan);
    else if (request.action === 'verify' || request.action === 'reconcile') result = await verifyWorker(plan, { preparationRecovery: request.action === 'reconcile' });
    else if (request.action === 'resume') result = await resumePreparationWorker(plan);
    else if (request.action === 'event') result = await applyEventWorker(plan, request);
    else if (request.action === 'reconcile-event') result = await reconcileEventWorker(plan, request);
    else throw failure('BENCHMARK_FIXTURE_ACTION', 'Unknown controller worker action');
  } catch (error) {
    result = await saveOperationResult(plan, request.action, { status: 'unknown', effect_unknown: true, error: errorValue(error),
      recovery: 'Retained owned state requires read-only reconciliation or explicit public product recovery. No new scope or duplicate write is created.' });
  } finally { await release(); }
  await save(requestPath + '.result.json', result);
}
async function cliMain(argv) {
  if (argv[0] === '--fixture-worker') { await worker(argv[1]); return; }
  const [action, ...args] = argv, flags = {};
  assert.equal(args.length % 2, 0, 'Use named option/value pairs');
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--plan', '--root', '--event', '--episode'].includes(args[i]) && !flags[args[i]], 'Unknown or duplicate fixture option');
    flags[args[i]] = args[i + 1];
  }
  let result;
  if (action === 'plan') {
    const options = await json(flags['--plan']); result = planBenchmarkFixture(options);
  } else if (action === 'prepare') result = await prepareBenchmarkFixture(await json(flags['--plan']));
  else if (action === 'resume') result = await resumeBenchmarkFixturePreparation({ controlRoot: flags['--root'] });
  else if (action === 'verify') result = await verifyBenchmarkFixture({ controlRoot: flags['--root'] });
  else if (action === 'reconcile') result = await reconcileBenchmarkFixture({ controlRoot: flags['--root'] });
  else if (action === 'status') result = await inspectBenchmarkFixture({ controlRoot: flags['--root'] });
  else if (action === 'event' || action === 'reconcile-event') result = await eventCall(action, { controlRoot: flags['--root'], eventId: flags['--event'], episodeId: flags['--episode'] });
  else throw failure('BENCHMARK_FIXTURE_USAGE', 'Usage: fixture.mjs plan|prepare --plan PRIVATE_JSON; status|verify|reconcile --root OWNED_ROOT; event|reconcile-event --root OWNED_ROOT --event ID --episode ID');
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status === 'unknown' || result.status === 'blocked' || result.status === 'failed') process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === modulePath) cliMain(process.argv.slice(2)).catch(error => {
  process.stderr.write(JSON.stringify({ status: 'failed', error: errorValue(error) }) + '\n'); process.exitCode = 1;
});
