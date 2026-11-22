import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, validateProtocol } from './protocol.mjs';
import { readEvidenceBundle } from './evidence/store.mjs';
import { executionImplementation, instrumentationIdentity } from './implementation.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const inside = (root, file) => { const part = relative(root, file); return part === '' || part !== '..' && !part.startsWith('../') && !isAbsolute(part); };
const derivedIds = new Set(['collection-readback', 'collection-grade']);
const sourceChangeAllowlist = new Set(['implementation.mjs', 'cli.mjs', 'controller.mjs', 'batch.mjs', 'gate.mjs', 'collect.mjs', 'revision.mjs']);
// This one reviewed preparation-only change cannot authorize another corpus edit.
const preparationChange = { path: 'corpus/index.mjs', before: '3f54344d045bdd38798ca6c2cb03991013969e6d7ad2e7fec13fc83d0f2f65cb',
  after: 'cabe4e478fbf566f89b9d3c71384bbf138cee153856497a5773902d259302f03' };
const sourceRoot = dirname(fileURLToPath(import.meta.url));
const identityChanges = new Set(['collector_version', 'collector_source_sha256', 'analysis_implementation', 'reanalysis_of']);
const stableIdentity = value => Object.fromEntries(Object.entries(value).filter(([key]) => !identityChanges.has(key)));
const artifactShape = ({ id, sha256, bytes, kind }) => ({ id, sha256, bytes, kind });
const sourceShape = ({ path, sha256, bytes }) => ({ path, sha256, bytes });
const sorted = values => [...values].sort((a, b) => a.path.localeCompare(b.path));
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
async function owned(file, root) {
  assert.ok(isAbsolute(file) && inside(root, file), 'ANALYSIS_REVISION_PATH_ESCAPE');
  assert.equal(await realpath(file), file, 'ANALYSIS_REVISION_SYMLINK_PATH');
  return file;
}
function known(fact, name, integer = true) {
  assert.ok(fact?.status === 'known' && typeof fact.value === 'number' && Number.isFinite(fact.value) && fact.value >= 0
    && (!integer || Number.isSafeInteger(fact.value)) && Array.isArray(fact.refs) && fact.refs.length > 0, 'ANALYSIS_REVISION_UNKNOWN_' + name);
  return fact.value;
}
function verifyImplementation(value) {
  assert.equal(value?.version, 1);
  assert.ok(Array.isArray(value.files) && value.files.length > 0);
  assert.equal(new Set(value.files.map(file => file.path)).size, value.files.length);
  assert.ok(value.files.every(file => typeof file.path === 'string' && digest(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0));
  assert.equal(value.sha256, fingerprint(value.files), 'ANALYSIS_REVISION_IMPLEMENTATION_HASH');
}
function sourceChanges(before, after) {
  verifyImplementation(before); verifyImplementation(after);
  assert.equal(after.scope, before.scope);
  const old = new Map(before.files.map(file => [file.path, file])), current = new Map(after.files.map(file => [file.path, file]));
  const changes = [];
  for (const path of [...new Set([...old.keys(), ...current.keys()])].sort()) {
    if (fingerprint(old.get(path) ?? null) === fingerprint(current.get(path) ?? null)) continue;
    const preparationOnly = path === preparationChange.path && old.get(path)?.sha256 === preparationChange.before && current.get(path)?.sha256 === preparationChange.after;
    assert.ok(sourceChangeAllowlist.has(path) || preparationOnly, 'ANALYSIS_REVISION_EXECUTION_SOURCE_CHANGED: ' + path);
    assert.ok(current.has(path), 'ANALYSIS_REVISION_SOURCE_REMOVED');
    changes.push({ path, before: old.get(path) ?? null, after: current.get(path),
      ...(preparationOnly ? { kind: 'narrow_nonexecuted_preparation_change', function: 'buildFixtureRecipe',
        change: 'Source fixture preparation retains canonical files; frozen execution consumes existing bindings and inputs.' } : {}) });
  }
  return changes;
}
function verifyInstrumentation(value, expected) {
  assert.equal(value?.version, 1);
  assert.deepEqual(value.runtime_sha256, expected.runtime_sha256, 'ANALYSIS_REVISION_RUNTIME_CHANGED');
  assert.equal(value.collector_sha256, fingerprint(value.collector_files), 'ANALYSIS_REVISION_COLLECTOR_HASH');
}
async function publicInputs(root, prefix = '') {
  const files = [];
  for (const item of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? prefix + '/' + item.name : item.name;
    assert.ok(!item.isSymbolicLink(), 'ANALYSIS_REVISION_INPUT_SYMLINK');
    if (item.isDirectory()) files.push(...await publicInputs(root, path));
    else {
      assert.ok(item.isFile(), 'ANALYSIS_REVISION_INPUT_NOT_FILE');
      const bytes = await readFile(join(root, path));
      files.push({ path, sha256: sha(bytes), bytes: bytes.length, executable: Boolean((await lstat(join(root, path))).mode & 0o111) });
    }
  }
  return files;
}
async function materialBoundary(plan, bindings) {
  const items = [], root = plan.execution.environment_root;
  for (const binding of bindings) {
    const oracle = await readFile(await owned(binding.oracle_path, root));
    assert.equal(sha(oracle), binding.oracle_sha256, 'ANALYSIS_REVISION_ORACLE_BYTES_CHANGED');
    const inputs = await publicInputs(await owned(binding.input_root, root));
    assert.equal(sha(JSON.stringify(inputs)), binding.input_inventory_sha256, 'ANALYSIS_REVISION_PUBLIC_INPUTS_CHANGED');
    const skills = [];
    for (const file of binding.skill_inventory) {
      const bytes = await readFile(await owned(file.path, root));
      assert.equal(sha(bytes), file.sha256, 'ANALYSIS_REVISION_SKILL_BYTES_CHANGED'); assert.equal(bytes.length, file.bytes);
      skills.push({ path: file.path, sha256: file.sha256, bytes: file.bytes });
    }
    const proof = binding.materialization_proof;
    if (proof) assert.equal(sha(await readFile(await owned(proof.path, root))), proof.sha256, 'ANALYSIS_REVISION_MATERIAL_PROOF_CHANGED');
    items.push({ case_id: binding.id, public_case_sha256: fingerprint(binding.public_case), oracle_sha256: binding.oracle_sha256,
      input_inventory_sha256: binding.input_inventory_sha256, inputs, skills, materialization_proof: proof ?? null });
  }
  return { protocol_sha256: plan.protocol.protocol_sha256, case_bindings_sha256: plan.execution.case_bindings_sha256, cases: items };
}
async function retainImplementation(implementation, outputFile, root) {
  const directory = join(dirname(outputFile), 'revision-source', 'sha256');
  await mkdir(directory, { recursive: true }); await owned(directory, root);
  const sources = [];
  for (const file of implementation.files) {
    const bytes = await readFile(join(sourceRoot, file.path));
    assert.equal(sha(bytes), file.sha256, 'ANALYSIS_REVISION_SOURCE_CHANGED_DURING_COPY'); assert.equal(bytes.length, file.bytes);
    const target = join(directory, file.sha256);
    try { await writeFile(target, bytes, { flag: 'wx', mode: 0o400 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    assert.ok((await readFile(await owned(target, root))).equals(bytes), 'ANALYSIS_REVISION_SOURCE_ARCHIVE_CHANGED');
    sources.push({ ...file, source_path: target });
  }
  return sources;
}
async function verifySources(implementation, sources, root) {
  assert.deepEqual(sources.map(sourceShape), implementation.files, 'ANALYSIS_REVISION_SOURCE_INVENTORY');
  for (const file of sources) {
    const bytes = await readFile(await owned(file.source_path, root));
    assert.equal(sha(bytes), file.sha256, 'ANALYSIS_REVISION_SOURCE_ARCHIVE_CHANGED'); assert.equal(bytes.length, file.bytes);
  }
}
async function baseSources(plan, reference) {
  const path = join(plan.execution.control_root, 'original-controller-source-retention.json');
  const bytes = await readFile(await owned(path, plan.execution.control_root)), receipt = JSON.parse(bytes);
  const actual = { path, sha256: sha(bytes) }; if (reference) assert.deepEqual(reference, actual);
  assert.equal(receipt.version, 1); assert.equal(receipt.kind, 'original-controller-source-retention');
  assert.equal(receipt.plan_sha256, plan.plan_sha256); assert.equal(receipt.complete, true);
  await verifySources(plan.execution.implementation, receipt.files.map(file => ({ ...sourceShape(file), source_path: file.archive })), plan.execution.control_root);
  return { reference: actual, files: receipt.files };
}
async function provePreparationBoundary({ changes, sources, base, instrumentation, plan }) {
  if (!changes.some(change => change.kind === 'narrow_nonexecuted_preparation_change')) return null;
  for (const identity of [plan.execution.instrumentation, instrumentation])
    assert.ok(!identity.collector_files.some(file => file.path === 'benchmark/corpus/index.mjs'), 'ANALYSIS_REVISION_PREPARATION_IN_COLLECTOR');
  const before = (await readFile(base.files.find(file => file.path === preparationChange.path).archive)).toString('utf8');
  const after = (await readFile(sources.find(file => file.path === preparationChange.path).source_path)).toString('utf8');
  const oldText = '        // Source bytes come from the exact published member; native input preparation rewrites names.\n'
    + '        // Retain the full canonical tree in expected_inventory for independent exact-byte verification.\n'
    + "        files: where === 'source' ? [] : value.files.map(({ path, content, encoding, mode }) => ({ path, content, encoding, mode })),";
  const newText = '        files: value.files.map(({ path, content, encoding, mode }) => ({ path, content, encoding, mode })),';
  assert.equal(before.split(oldText).length, 2); assert.equal(before.replace(oldText, newText), after, 'ANALYSIS_REVISION_PREPARATION_DIFF');
  const expectations = [];
  for (const condition of Object.values(plan.execution.conditions)) for (const ref of Object.values(condition.expectations)) {
    const visibility = (await readJson(ref.path)).projection.visibility;
    assert.equal(visibility.source_moved_outside_run, true);
    assert.ok(visibility.projection.files.every(file => !/(?:^|\/)(?:corpus|analysis|evidence|tests?)(?:\/|$)|(?:oracle|grader|\.test\.)/.test(file.path)), 'ANALYSIS_REVISION_PRIVATE_SUBJECT_PROJECTION');
    expectations.push({ path: ref.path, sha256: ref.sha256, visibility_sha256: fingerprint(visibility) });
  }
  return { kind: 'nonexecuted_preparation_boundary', source: preparationChange,
    exact_change_verified: true, collector_imports_preparation: false, subject_contains_private_modules: false, expectations };
}
async function frozenPlan(file, expected) {
  assert.ok(isAbsolute(file));
  const bytes = await readFile(file), plan = JSON.parse(bytes);
  assert.equal(plan.version, 1); assert.equal(plan.kind, 'benchmark-batch-plan');
  assert.equal(plan.id, plan.protocol.id);
  assert.equal(plan.plan_sha256, fingerprint({ ...plan, plan_sha256: null }), 'ANALYSIS_REVISION_PLAN_CHANGED');
  const validation = validateProtocol(plan.protocol, { stage: 'execute' });
  assert.ok(validation.valid, JSON.stringify(validation.errors));
  assert.ok(Array.isArray(plan.slots) && new Set(plan.slots.map(slot => slot.slot_id)).size === plan.slots.length);
  assert.equal(file, join(plan.execution.control_root, 'plan.json'), 'ANALYSIS_REVISION_PLAN_LOCATION');
  await owned(file, plan.execution.environment_root);
  if (expected) assert.deepEqual(plan, expected, 'ANALYSIS_REVISION_OTHER_PLAN');
  const bindingBytes = await readFile(await owned(plan.execution.case_bindings_file, plan.execution.environment_root));
  assert.equal(sha(bindingBytes), plan.execution.case_bindings_sha256, 'ANALYSIS_REVISION_INPUTS_CHANGED');
  assert.equal(sha(await readFile(await owned(plan.execution.models_file, plan.execution.environment_root))), plan.execution.models_sha256, 'ANALYSIS_REVISION_MODELS_CHANGED');
  for (const condition of Object.values(plan.execution.conditions)) for (const ref of Object.values(condition.expectations))
    assert.equal(sha(await readFile(await owned(ref.path, plan.execution.environment_root))), ref.sha256, 'ANALYSIS_REVISION_EXPECTATION_CHANGED');
  return { plan, bindings: JSON.parse(bindingBytes), reference: { path: file, sha256: sha(bytes), plan_sha256: plan.plan_sha256 } };
}
async function ledgerPrefix(plan, reference) {
  const path = join(plan.execution.control_root, 'ledger.jsonl'), allBytes = await readFile(path);
  assert.ok(allBytes.length > 0 && allBytes.at(-1) === 10, 'ANALYSIS_REVISION_LEDGER_TRUNCATED');
  const all = allBytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  for (const [index, event] of all.entries()) assert.equal(event.seq, index + 1, 'ANALYSIS_REVISION_LEDGER_SEQUENCE');
  const bytes = reference ? allBytes.subarray(0, reference.bytes) : allBytes;
  if (reference) {
    assert.equal(reference.path, path); assert.ok(reference.bytes > 0 && reference.bytes <= allBytes.length);
    assert.equal(sha(bytes), reference.sha256, 'ANALYSIS_REVISION_LEDGER_PREFIX_CHANGED');
  }
  assert.equal(bytes.at(-1), 10, 'ANALYSIS_REVISION_LEDGER_PREFIX_TRUNCATED');
  const rows = bytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  if (reference) assert.equal(rows.length, reference.through_seq);
  assert.ok(!rows.some(row => row.type === 'analysis_revision_applied'), 'ANALYSIS_REVISION_CHAIN_UNSUPPORTED');
  assert.ok(rows.some(row => row.type === 'batch_opened' && row.plan_sha256 === plan.plan_sha256), 'ANALYSIS_REVISION_LEDGER_OTHER_PLAN');
  return { rows, all, reference: { path, sha256: sha(bytes), bytes: bytes.length, through_seq: rows.length } };
}
function validateAnalysisSource(episode, instrumentation) {
  const implementation = episode.identity.analysis_implementation;
  const { sha256, ...body } = implementation;
  assert.equal(sha256, fingerprint(body), 'ANALYSIS_REVISION_ANALYSIS_SOURCE_HASH');
  assert.deepEqual(sorted(implementation.files.map(sourceShape)), sorted(instrumentation.collector_files.map(sourceShape)), 'ANALYSIS_REVISION_ANALYSIS_SOURCE_MISMATCH');
  const byId = new Map(episode.artifacts.map(artifact => [artifact.id, artifact]));
  for (const source of implementation.files) {
    const artifact = byId.get(source.artifact_id);
    assert.ok(artifact && artifact.sha256 === source.sha256 && artifact.bytes === source.bytes, 'ANALYSIS_REVISION_ANALYSIS_ARTIFACT_MISMATCH');
  }
  assert.equal(episode.identity.collector_source_sha256, implementation.files.find(file => file.path === 'benchmark/collect.mjs')?.sha256);
}
function deriveBudget(oldEpisode, episode, runtime, eventRows, model) {
  const attemptIdentity = value => value.map(({ id, request_id, seq, sent, transport_id }) => ({ id, request_id, seq, sent, transport_id }));
  assert.deepEqual(attemptIdentity(episode.attempts), attemptIdentity(oldEpisode.attempts), 'ANALYSIS_REVISION_ATTEMPTS_CHANGED');
  assert.ok(episode.attempts.every(attempt => typeof attempt.sent === 'boolean'), 'ANALYSIS_REVISION_SEND_UNKNOWN');
  const sent = episode.attempts.filter(attempt => attempt.sent), count = known(episode.measurements.actual_attempts, 'ACTUAL_SENDS');
  assert.equal(count, known(oldEpisode.measurements.actual_attempts, 'OLD_ACTUAL_SENDS')); assert.equal(count, sent.length);
  const rawAttempts = runtime.requests.flatMap(request => request.attempts.map(attempt => ({ ...attempt, request_id: request.id })));
  assert.ok(rawAttempts.every(attempt => typeof attempt.sent === 'boolean'), 'ANALYSIS_REVISION_RAW_SEND_UNKNOWN');
  assert.deepEqual(sent.map(attempt => [attempt.id, attempt.request_id]), rawAttempts.filter(attempt => attempt.sent).map(attempt => [attempt.id, attempt.request_id]), 'ANALYSIS_REVISION_RAW_ATTEMPTS_CHANGED');
  let input = 0, output = 0;
  for (const attempt of sent) {
    assert.equal(attempt.adapter?.verified, true); assert.equal(attempt.adapter.evidence_sha256, model.adapter.evidence_sha256);
    assert.equal(attempt.adapter.input_semantics, 'includes_cache'); assert.equal(attempt.adapter.output_semantics, 'includes_reasoning');
    const fullInput = known(attempt.full_input, 'ATTEMPT_INPUT'), fullOutput = known(attempt.full_output, 'ATTEMPT_OUTPUT');
    const observations = attempt.full_input.refs.filter(ref => ref.artifact_id === 'events' && Number.isSafeInteger(ref.line))
      .map(ref => eventRows[ref.line - 1]).filter(row => row?.type === 'provider_stream_event' && row.data?.request_id === attempt.request_id && row.data?.attempt_id === attempt.id);
    const match = observations.some(row => {
      const data = row.data;
      if (data.api !== model.api || data.model !== model.route) return false;
      if (data.provider !== model.provider && !(data.provider === '[REDACTED_CREDENTIAL]' && attempt.provider_binding?.status === 'known'
        && attempt.provider_binding.value === model.provider && attempt.provider_binding.formula === 'unique-observed-provider-configuration-key/v1')) return false;
      const usage = model.api === 'openai-responses' ? data.event?.response?.usage : model.api === 'openai-completions' ? data.event?.usage : null;
      const observedInput = model.api === 'openai-responses' ? usage?.input_tokens : usage?.prompt_tokens;
      const observedOutput = model.api === 'openai-responses' ? usage?.output_tokens : usage?.completion_tokens;
      return observedInput === fullInput && observedOutput === fullOutput && (usage.total_tokens === undefined || usage.total_tokens === fullInput + fullOutput);
    });
    assert.ok(match, 'ANALYSIS_REVISION_RAW_USAGE_MISMATCH'); input += fullInput; output += fullOutput;
  }
  assert.equal(input, known(episode.measurements.input_total.value, 'INPUT_TOTAL'));
  assert.equal(output, known(episode.measurements.output_total.value, 'OUTPUT_TOTAL'));
  assert.equal(episode.measurements.input_total.observed_items, count); assert.equal(episode.measurements.input_total.total_items, count);
  assert.equal(episode.measurements.output_total.observed_items, count); assert.equal(episode.measurements.output_total.total_items, count);
  const duration = known(episode.timing.duration_ms, 'DURATION', false);
  assert.equal(duration, known(oldEpisode.timing.duration_ms, 'OLD_DURATION', false)); assert.equal(duration, runtime.timing.duration_ms);
  return { model_requests: count, input_tokens: input, output_tokens: output, duration_ms: duration };
}
async function replacementFor({ request, plan, bindings, rows, instrumentation }) {
  const completed = rows.filter(row => row.type === 'episode_completed' && row.run_id === request.run_id);
  assert.equal(completed.length, 1, 'ANALYSIS_REVISION_COMPLETED_RUN_REQUIRED');
  const original = completed[0], starts = rows.filter(row => row.type === 'episode_started' && row.run_id === request.run_id);
  assert.equal(starts.length, 1); assert.equal(starts[0].slot_id, original.slot_id);
  const slot = plan.slots.find(slot => slot.slot_id === original.slot_id); assert.ok(slot);
  for (const key of ['case_id', 'condition_id', 'pair_id', 'repeat', 'seed']) assert.equal(original[key], slot[key]);
  const condition = plan.protocol.conditions.find(condition => condition.id === slot.condition_id), model = plan.protocol.models.find(model => model.id === condition.model_id);
  const binding = bindings.find(binding => binding.id === slot.case_id); assert.ok(binding);
  const root = plan.execution.environment_root, runRoot = join(root, 'runs', request.run_id);
  assert.equal(original.result.run_root, runRoot);
  const oldDirectory = await owned(original.result.normalized_directory, root), directory = await owned(request.directory, plan.execution.control_root);
  assert.notEqual(directory, oldDirectory, 'ANALYSIS_REVISION_MUST_APPEND');
  const oldBundle = await readEvidenceBundle({ directory: oldDirectory, rawRoot: root }), nextBundle = await readEvidenceBundle({ directory, rawRoot: root });
  const old = oldBundle.episode, next = nextBundle.episode;
  assert.equal(old.episode_sha256, original.result.episode_sha256); assert.notEqual(next.episode_sha256, old.episode_sha256);
  assert.equal(old.identity.reanalysis_of, null, 'ANALYSIS_REVISION_CHAIN_UNSUPPORTED');
  const prior = next.identity.reanalysis_of;
  assert.equal(typeof prior === 'string' ? prior : prior?.episode_sha256, old.episode_sha256, 'ANALYSIS_REVISION_REANALYSIS_PARENT');
  if (typeof prior !== 'string') {
    assert.equal(prior.directory, oldDirectory); assert.equal(prior.collector_version, old.identity.collector_version);
    assert.equal(prior.collector_source_sha256, old.identity.collector_source_sha256);
    assert.equal(prior.analysis_implementation_sha256, old.identity.analysis_implementation.sha256);
  }
  assert.deepEqual(stableIdentity(old.identity), stableIdentity(next.identity), 'ANALYSIS_REVISION_SUBJECT_IDENTITY_CHANGED');
  for (const [key, value] of Object.entries({ run_id: request.run_id, episode_id: request.run_id, experiment_id: plan.id, case_id: slot.case_id,
    condition_id: condition.id, environment_id: condition.environment_id, environment_sha256: condition.environment_sha256,
    model_id: model.id, model_route: model.route, pair_id: slot.pair_id ?? null, repeat: slot.repeat, seed: slot.seed ?? null,
    build_id: plan.execution.conditions[condition.id].build_id, budget_id: condition.budget_id,
    corpus_id: plan.protocol.corpus.id, corpus_sha256: plan.protocol.corpus.content_sha256, phase: plan.protocol.phase }))
    assert.equal(next.identity[key], value, 'ANALYSIS_REVISION_PLAN_IDENTITY: ' + key);
  validateAnalysisSource(old, plan.execution.instrumentation); validateAnalysisSource(next, instrumentation);
  const oldArtifacts = new Map(old.artifacts.map(artifact => [artifact.id, artifact])), nextArtifacts = new Map(next.artifacts.map(artifact => [artifact.id, artifact]));
  const protectedArtifacts = [];
  for (const artifact of old.artifacts) {
    if (derivedIds.has(artifact.id) || artifact.id.startsWith('collection-implementation-')) continue;
    assert.deepEqual(artifactShape(nextArtifacts.get(artifact.id) ?? {}), artifactShape(artifact), 'ANALYSIS_REVISION_RAW_SUBSTRATE_CHANGED: ' + artifact.id);
    protectedArtifacts.push(artifactShape(artifact));
  }
  const expected = plan.execution.conditions[condition.id].expectations[slot.case_id];
  for (const artifact of next.artifacts) if (!oldArtifacts.has(artifact.id) && !artifact.id.startsWith('collection-implementation-')) {
    assert.equal(artifact.id, 'collection-provider-binding-expectation', 'ANALYSIS_REVISION_UNDECLARED_NEW_SOURCE');
    assert.equal(artifact.path, expected.path); assert.equal(artifact.sha256, expected.sha256);
  }
  const artifactJson = async (registry, id) => { const artifact = registry.get(id); assert.ok(artifact, 'ANALYSIS_REVISION_MISSING_' + id); return readJson(artifact.path); };
  const oldReadback = await artifactJson(oldArtifacts, 'collection-readback'), readback = await artifactJson(nextArtifacts, 'collection-readback');
  assert.deepEqual(readback.oracle, oldReadback.oracle, 'ANALYSIS_REVISION_ORACLE_CHANGED');
  assert.equal(readback.oracle.sha256, binding.oracle_sha256);
  assert.equal(sha(await readFile(await owned(binding.oracle_path, root))), binding.oracle_sha256, 'ANALYSIS_REVISION_ORACLE_BYTES_CHANGED');
  const runtimeArtifact = nextArtifacts.get('collection-runtime-result'); assert.equal(runtimeArtifact.path, join(runRoot, 'benchmark/runtime/episode-result.json'));
  const runtime = await artifactJson(nextArtifacts, 'collection-runtime-result');
  assert.equal(runtime.correlation.run_id, request.run_id); assert.equal(runtime.correlation.episode_id, request.run_id);
  assert.equal(runtime.status, original.result.status); assert.ok(['completed', 'budget_stopped', 'failed'].includes(runtime.status));
  assert.equal(readback.runtime_result_sha256, runtimeArtifact.sha256); assert.equal(oldReadback.runtime_result_sha256, runtimeArtifact.sha256);
  assert.equal(readback.protocol_sha256, plan.protocol.protocol_sha256); assert.equal(oldReadback.protocol_sha256, plan.protocol.protocol_sha256);
  assert.equal(next.admission.status, 'valid'); assert.equal(next.admission.completeness.attempts, 'complete');
  const events = (await readFile(nextArtifacts.get('events').path, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  const budgetUsage = deriveBudget(old, next, runtime, events, model);
  const collectionPath = join(dirname(directory), 'collection.json'), collectionBytes = await readFile(await owned(collectionPath, root)), collection = JSON.parse(collectionBytes);
  assert.equal(collection.run_id, request.run_id); assert.equal(collection.episode_sha256, next.episode_sha256);
  assert.equal(collection.stop_batch, false, 'ANALYSIS_REVISION_STILL_STOPPED'); assert.equal(collection.validity, 'valid');
  assert.equal(collection.paths.bundle, directory); assert.deepEqual(collection.budget_usage, budgetUsage, 'ANALYSIS_REVISION_COLLECTION_BUDGET_MISMATCH');
  return { run_id: request.run_id, slot_id: slot.slot_id, original_episode_sha256: old.episode_sha256, new_episode_sha256: next.episode_sha256,
    directory, budget_usage: budgetUsage, status: runtime.status, stop_batch: false,
    evidence: { original_directory: oldDirectory, completed_ledger_seq: original.seq, subject_identity_sha256: fingerprint(stableIdentity(next.identity)),
      oracle: readback.oracle, substrate: protectedArtifacts.sort((a, b) => a.id.localeCompare(b.id)),
      collection: { path: collectionPath, sha256: sha(collectionBytes) }, original_collector: old.identity.analysis_implementation.sha256,
      revised_collector: next.identity.analysis_implementation.sha256 } };
}

export async function createAnalysisRevision({ planFile, outputFile, replacements, reason }) {
  assert.ok(typeof reason === 'string' && reason.trim() && reason.length <= 4000, 'ANALYSIS_REVISION_REASON_REQUIRED');
  const frozen = await frozenPlan(planFile), { plan, bindings } = frozen;
  assert.ok(Array.isArray(replacements) && replacements.length > 0 && new Set(replacements.map(item => item.run_id)).size === replacements.length, 'ANALYSIS_REVISION_UNIQUE_REPLACEMENTS');
  assert.ok(isAbsolute(outputFile) && inside(plan.execution.control_root, outputFile));
  const ledger = await ledgerPrefix(plan), implementation = await executionImplementation();
  assert.ok(implementation.files.some(file => file.path === 'revision.mjs'), 'ANALYSIS_REVISION_SOURCE_NOT_REGISTERED');
  const instrumentation = await instrumentationIdentity({ ...plan.execution, implementation });
  verifyInstrumentation(instrumentation, plan.execution.instrumentation);
  const changes = sourceChanges(plan.execution.implementation, implementation), revised = [];
  for (const request of replacements) revised.push(await replacementFor({ request, plan, bindings, rows: ledger.rows, instrumentation }));
  assert.equal(new Set(revised.map(item => item.slot_id)).size, revised.length, 'ANALYSIS_REVISION_DUPLICATE_SLOT');
  const materials = await materialBoundary(plan, bindings), base = await baseSources(plan);
  const sources = await retainImplementation(implementation, outputFile, plan.execution.control_root);
  const preparation = await provePreparationBoundary({ changes, sources, base, instrumentation, plan });
  const revision = { version: 1, kind: 'benchmark-analysis-revision', created_at: new Date().toISOString(), reason,
    scope: 'one analysis repair of the same observed runs; no execution, replacement sample or plan override',
    plan: frozen.reference, implementation, instrumentation, implementation_sources: sources, base_implementation_sources_ref: base.reference,
    material_boundary: materials, preparation_boundary: preparation, sourceChanges: changes, ledger: ledger.reference, replacements: revised, revision_sha256: null };
  revision.revision_sha256 = fingerprint(revision);
  assert.deepEqual(await executionImplementation(), implementation, 'ANALYSIS_REVISION_SOURCE_CHANGED_DURING_CREATE');
  assert.deepEqual(await instrumentationIdentity({ ...plan.execution, implementation }), instrumentation, 'ANALYSIS_REVISION_INSTRUMENTATION_CHANGED_DURING_CREATE');
  assert.deepEqual((await frozenPlan(planFile)).reference, frozen.reference);
  assert.deepEqual((await ledgerPrefix(plan)).reference, ledger.reference, 'ANALYSIS_REVISION_LEDGER_CHANGED_DURING_CREATE');
  await mkdir(dirname(outputFile), { recursive: true }); await owned(dirname(outputFile), plan.execution.control_root);
  const content = JSON.stringify(revision, null, 2) + '\n'; await writeFile(outputFile, content, { flag: 'wx', mode: 0o600 });
  return { reference: { path: outputFile, sha256: sha(content) }, revision };
}

/** Offline verification checks the recorded implementation and immutable raw
 * substrate. Executing a resumed batch separately checks the live source identity. */
export async function verifyAnalysisRevision({ reference, plan }) {
  assert.ok(isAbsolute(reference?.path ?? '') && digest(reference.sha256));
  const bytes = await readFile(reference.path); assert.equal(sha(bytes), reference.sha256, 'ANALYSIS_REVISION_REFERENCE_CHANGED');
  const revision = JSON.parse(bytes);
  const allowed = ['version', 'kind', 'created_at', 'reason', 'scope', 'plan', 'implementation', 'instrumentation', 'implementation_sources',
    'base_implementation_sources_ref', 'material_boundary', 'preparation_boundary', 'sourceChanges', 'ledger', 'replacements', 'revision_sha256'];
  assert.ok(Object.keys(revision).every(key => allowed.includes(key)), 'ANALYSIS_REVISION_UNDECLARED_OVERRIDE');
  assert.equal(revision.version, 1); assert.equal(revision.kind, 'benchmark-analysis-revision');
  assert.equal(revision.revision_sha256, fingerprint({ ...revision, revision_sha256: null }), 'ANALYSIS_REVISION_CONTENT_CHANGED');
  const frozen = await frozenPlan(revision.plan.path, plan); assert.deepEqual(revision.plan, frozen.reference);
  await owned(reference.path, plan.execution.control_root);
  verifyInstrumentation(revision.instrumentation, plan.execution.instrumentation);
  assert.deepEqual(revision.sourceChanges, sourceChanges(plan.execution.implementation, revision.implementation));
  await verifySources(revision.implementation, revision.implementation_sources, plan.execution.control_root);
  const base = await baseSources(plan, revision.base_implementation_sources_ref);
  assert.deepEqual(revision.material_boundary, await materialBoundary(plan, frozen.bindings));
  assert.deepEqual(revision.preparation_boundary, await provePreparationBoundary({ changes: revision.sourceChanges,
    sources: revision.implementation_sources, base, instrumentation: revision.instrumentation, plan }));
  const ledger = await ledgerPrefix(plan, revision.ledger);
  const applications = ledger.all.filter(row => row.type === 'analysis_revision_applied');
  assert.ok(applications.length <= 1, 'ANALYSIS_REVISION_CHAIN_UNSUPPORTED');
  if (applications.length) assert.deepEqual(applications[0].reference, reference, 'ANALYSIS_REVISION_OTHER_REGISTERED_REVISION');
  assert.ok(Array.isArray(revision.replacements) && revision.replacements.length > 0);
  assert.equal(new Set(revision.replacements.map(item => item.run_id)).size, revision.replacements.length);
  assert.equal(new Set(revision.replacements.map(item => item.slot_id)).size, revision.replacements.length);
  for (const replacement of revision.replacements) {
    const actual = await replacementFor({ request: replacement, plan, bindings: frozen.bindings, rows: ledger.rows, instrumentation: revision.instrumentation });
    assert.deepEqual(replacement, actual, 'ANALYSIS_REVISION_REPLACEMENT_CHANGED');
  }
  return revision;
}
