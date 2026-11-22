import { canonicalJson, fingerprint } from '../protocol.mjs';

const digest = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function runtimeIdentity(runtime) {
  const select = (value, names) => Object.fromEntries(names.filter(name => value?.[name] !== undefined).map(name => [name, value[name]]));
  const fileFields = ['invocation_path', 'path', 'sha256', 'status', 'reason'];
  return {
    node: select(runtime.node, [...fileFields, 'version']),
    bun: select(runtime.bun, [...fileFields, 'version']),
    pi: { ...select(runtime.pi, [...fileFields, 'version', 'package_version']),
      package_manifest: select(runtime.pi?.package_manifest, [...fileFields, 'name', 'version']),
      runtime_module: select(runtime.pi?.runtime_module, fileFields) },
    scope: 'selected-runtime-files-and-versions-at-run-start',
  };
}

function portable(value, replacements) {
  if (typeof value === 'string') {
    let text = value;
    for (const [path, token] of replacements) {
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(escaped + '(?=$|[\\/\\s"\'\\]\\[()<>:,])', 'g'), () => token);
    }
    return text;
  }
  if (Array.isArray(value)) return value.map(item => portable(item, replacements));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item, replacements)]));
  return value;
}

export function projectObservation(snapshot, run, build) {
  if (snapshot?.schema_version !== 1 || snapshot?.kind !== 'benchmark-pi-observation') throw new Error('Unrecognized Pi observation');
  if (!run?.root || !run?.build_root || !build?.sources || !build?.packages) throw new Error('Missing native run/build identity');
  const replacements = [[run.root, '${RUN_ROOT}'], [run.build_root, '${BUILD_ROOT}']].sort((a, b) => b[0].length - a[0].length);
  const source = name => ({ commit: build.sources[name].commit, sha256: build.sources[name].sha256 ?? fingerprint(build.sources[name].files) });
  const sorted = values => [...values].sort((a, b) => a.name.localeCompare(b.name));
  const value = {
    build: { environment_id: build.environment_id, id: build.build_id,
      sources: { cli: source('cli'), broker: source('broker') },
      packages: { cli: build.packages.cli.sha256, broker: build.packages.broker.sha256 },
      selected_cli_sha256: build.selected_cli_sha256 },
    launch: run.pi_launch,
    launcher: run.launcher ?? null, runtime_observer: run.runtime_observer ?? null,
    runtime: { tools: runtimeIdentity(run.runtime), node: { entry: snapshot.process.node, version: snapshot.process.version },
      pi_entry: snapshot.process.argv[1], argv: snapshot.process.argv.slice(2), cwd: snapshot.process.cwd },
    roots: snapshot.roots, settings: snapshot.settings,
    model_selection: snapshot.model_selection, thinking_level: snapshot.thinking_level,
    commands: sorted(snapshot.commands), tools: sorted(snapshot.tools), active_tools: snapshot.active_tools,
    prompt_options: snapshot.prompt_options, system_prompt: snapshot.system_prompt,
  };
  return portable(value, replacements);
}

export function inspectObservation(snapshot, run) {
  const errors = [];
  const check = (pass, code, message) => { if (!pass) errors.push({ code, message }); };
  check(snapshot?.schema_version === 1 && snapshot?.kind === 'benchmark-pi-observation', 'observation_schema', 'Expected a version 1 Pi observation');
  if (!snapshot?.process || !run?.pi_launch) return { valid: false, errors: [...errors, { code: 'missing_identity', message: 'Missing process or launch identity' }] };
  if (!Array.isArray(snapshot.process.argv) || !Array.isArray(run.pi_launch.argv)) return { valid: false, errors: [...errors, { code: 'missing_argv', message: 'Missing actual or declared Pi arguments' }] };
  for (const name of ['node', 'pi', 'bun']) check(run.runtime?.[name]?.status === 'observed' && digest.test(run.runtime[name].sha256 ?? '') && typeof run.runtime[name].version === 'string',
    'runtime_identity', 'Missing actual ' + name + ' identity');
  check(snapshot.process.node === run.runtime?.node?.path, 'node_entry', 'Pi did not use the selected maintained Node entry');
  check(snapshot.process.version === run.runtime?.node?.version, 'node_version', 'Pi Node version differs from the launch observation');
  check(snapshot.process.argv?.[1] === run.pi_launch.entry, 'pi_entry', 'Pi JavaScript entry differs from the selected launch');
  check(canonicalJson(snapshot.process.argv?.slice(2, 2 + run.pi_launch.argv.length)) === canonicalJson(run.pi_launch.argv),
    'pi_arguments', 'Actual Pi arguments differ from the fixed launch definition');
  check(snapshot.roots?.PAIRED_RUN_ROOT === run.root, 'run_root', 'Observer belongs to another isolated run');
  for (const name of ['PI_CODING_AGENT_DIR', 'NTN_SKILLS_CONFIG_HOME', 'NTN_SKILLS_HOME', 'NTN_SKILLS_CACHE_HOME', 'NTN_SKILLS_DATA_HOME', 'NTN_SKILLS_SCHEDULER_ROOT']) {
    check(typeof snapshot.roots?.[name] === 'string' && snapshot.roots[name].startsWith(run.root + '/'), 'state_root', name + ' is outside the owned run');
  }
  for (const name of ['commands', 'tools', 'active_tools']) check(Array.isArray(snapshot[name]), 'missing_registry', 'Missing actual ' + name);
  check(typeof snapshot.system_prompt === 'string' && object(snapshot.prompt_options), 'missing_context', 'Initial system prompt and construction inputs were not observed');
  check(snapshot.model_selection?.provider === 'benchmark-phase0' && snapshot.model_selection?.id === 'no-request',
    'phase0_provider', 'Phase 0 must use its non-networking sentinel provider');
  check(snapshot.thinking_level === 'off', 'phase0_thinking', 'Phase 0 must disable model reasoning');
  return { valid: errors.length === 0, errors };
}

export function createExpectation(projection, conditionId, observedEvidence) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(conditionId)) throw new Error('Use a bounded condition ID');
  return { schema_version: 1, kind: 'benchmark-load-expectation', status: 'draft', condition_id: conditionId,
    scope: 'phase0-registered-resources', task_execution_enabled: false,
    projection, observed_evidence: observedEvidence, expectation_sha256: null };
}

function expectationDigest(value) { return fingerprint({ ...value, expectation_sha256: null }); }

export function validateExpectation(value, { frozen = true } = {}) {
  const errors = [];
  const check = (pass, code, message) => { if (!pass) errors.push({ code, message }); };
  check(value?.schema_version === 1 && value?.kind === 'benchmark-load-expectation', 'expectation_schema', 'Expected a version 1 load expectation');
  check(value?.scope === 'phase0-registered-resources' && value?.task_execution_enabled === false, 'scope', 'This expectation cannot authorize model tasks');
  check(typeof value?.condition_id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value.condition_id), 'condition_id', 'Missing bounded condition ID');
  check(object(value?.projection) && object(value?.projection?.build) && object(value?.projection?.launch), 'projection', 'Missing observed build and load projection');
  check(Array.isArray(value?.projection?.tools) && Array.isArray(value?.projection?.commands) && typeof value?.projection?.system_prompt === 'string', 'resources', 'Missing actual resource projection');
  check(object(value?.observed_evidence) && digest.test(value.observed_evidence.sha256 ?? ''), 'evidence', 'Missing source observation digest');
  check(['draft', 'frozen'].includes(value?.status), 'status', 'Unknown expectation status');
  if (frozen) check(value?.status === 'frozen', 'not_frozen', 'Freeze a reviewed load expectation before comparing it');
  if (value?.status === 'frozen') check(digest.test(value.expectation_sha256 ?? '') && value.expectation_sha256 === expectationDigest(value),
    'fingerprint_mismatch', 'Frozen expectation changed');
  return { valid: errors.length === 0, errors };
}

export function freezeExpectation(value) {
  const validation = validateExpectation(value, { frozen: false });
  if (!validation.valid) throw new Error(validation.errors.map(error => error.message).join('; '));
  const frozen = { ...structuredClone(value), status: 'frozen', expectation_sha256: null };
  frozen.expectation_sha256 = expectationDigest(frozen);
  return frozen;
}

export function compareObservation(expected, actual) {
  const validation = validateExpectation(expected);
  if (!validation.valid) return { matched: false, errors: validation.errors, differences: [] };
  const differences = [];
  const walk = (left, right, path) => {
    if (differences.length >= 40 || left === undefined && right === undefined) return;
    const absent = { benchmark_missing_field: true };
    if (left === undefined || right === undefined) {
      differences.push({ path, expected_sha256: fingerprint(left === undefined ? absent : left), actual_sha256: fingerprint(right === undefined ? absent : right) });
      return;
    }
    if (canonicalJson(left) === canonicalJson(right)) return;
    if (object(left) && object(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) walk(left[key], right[key], path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'));
    } else differences.push({ path, expected_sha256: fingerprint(left), actual_sha256: fingerprint(right) });
  };
  walk(expected.projection, actual, '');
  return { matched: differences.length === 0, errors: [], differences,
    scope: expected.scope, task_execution_enabled: false };
}
