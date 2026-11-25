import { createHash } from 'node:crypto';
import environmentSchema from './schemas/environment-manifest.schema.json' with { type: 'json' };
import protocolSchema from './schemas/protocol.schema.json' with { type: 'json' };
import metricDictionary from './metrics.json' with { type: 'json' };
import { canonicalAutoGroupLabel, validateRoutingPolicy } from './reported-model.mjs';
import { scheduleProtocol, UNSTARTED_FOLLOWUP, CONFIRMATION_CONTINUATION, ENGINEERING_WINDOW_CONTINUATION, selectsUnstartedSlots } from './campaign-selection.mjs';
import { isStandingWindow, modelWindowCondition, modelWindowEnd, validModelWindow } from './model-window.mjs';

const REQUIRED_EVIDENCE = ['runtime_identity', 'loaded_manifest', 'visible_materials',
  'model_requests', 'usage', 'tool_lineage', 'business_readback', 'completion_boundary', 'interventions'];
const SCHEMAS = new Map([[environmentSchema.$id, environmentSchema], [protocolSchema.$id, protocolSchema]]);
const ENVIRONMENT_COMPONENTS = {
  build: e => ({ cli_source: e.build.cli.source_sha256, cli_package: e.build.cli.package_sha256,
    sdk_package: e.build.cli.sdk_sha256, broker_source: e.build.broker.source_sha256,
    broker_package: e.build.broker.package_sha256 }),
  runtime: e => e.runtime,
  pi_mode: e => e.pi.mode,
  config: e => e.pi.config_sha256,
  extensions: e => e.pi.extensions,
  tools: e => ({ declared: e.pi.tools, active: e.pi.active_tools }),
  catalog: e => e.pi.catalog_sha256,
  sources: e => e.pi.sources,
  native_root: e => e.pi.native_root,
  guidance: e => e.pi.guidance_sha256,
  injection: e => e.pi.injection_sha256,
  return_contract: e => e.pi.return_contract_sha256,
  error_contract: e => e.pi.error_contract_sha256,
  cache: e => e.policies.cache,
  session: e => e.policies.session,
  recovery: e => e.policies.recovery,
  code_mode: e => e.policies.code_mode,
};

/** Stable JSON only: plain objects, finite numbers and dense arrays. Never coerce. */
export function canonicalJson(value) {
  const ancestors = new Set();
  function serialize(v, depth) {
    if (depth > 128) throw new TypeError('JSON exceeds the supported depth of 128');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== 'object') throw new TypeError('Expected a finite JSON value');
    if (ancestors.has(v)) throw new TypeError('Cyclic values are not JSON');
    if (Object.getOwnPropertySymbols(v).length) throw new TypeError('Symbol properties are not JSON');
    const prototype = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && prototype !== Object.prototype && prototype !== null)
      throw new TypeError('Expected a plain JSON object');
    ancestors.add(v);
    let serialized;
    if (Array.isArray(v)) {
      const members = [];
      for (let i = 0; i < v.length; i += 1) {
        if (!Object.hasOwn(v, i)) throw new TypeError('Sparse arrays are not JSON');
        members.push(serialize(v[i], depth + 1));
      }
      if (Object.keys(v).some(k => !/^(0|[1-9]\d*)$/.test(k) || Number(k) >= v.length))
        throw new TypeError('Array properties are not JSON');
      serialized = '[' + members.join(',') + ']';
    } else {
      serialized = '{' + Object.keys(v).sort().map(k =>
        JSON.stringify(k) + ':' + serialize(v[k], depth + 1)).join(',') + '}';
    }
    ancestors.delete(v);
    return serialized;
  }
  return serialize(value, 0);
}

export function fingerprint(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function pointer(path, key) {
  return path + '/' + String(key).replaceAll('~', '~0').replaceAll('/', '~1');
}

function issue(errors, path, code, message) {
  errors.push({ path: path || '', code, message });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function same(a, b) { return canonicalJson(a) === canonicalJson(b); }
function setSame(a, b) { return same([...a].sort(), [...b].sort()); }
function modelCondition(model) {
  return {
    provider: model.provider, route: model.route, api: model.api, parameters: model.parameters,
    ...(model.routing ? { routing: model.routing } : {}),
    backend: { identity: model.backend.identity, observability: model.backend.observability,
      window: modelWindowCondition(model.backend.window) },
  };
}
function validTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}

/*
 * Deliberately limited to the keywords used by the two committed schemas.
 * This is a boundary validator for these documents, not an arbitrary-schema API.
 */
function validateShape(value, schema, path, errors) {
  if (schema.$ref) return validateShape(value, SCHEMAS.get(schema.$ref), path, errors);
  if (schema.anyOf) {
    const matches = schema.anyOf.some(candidate => {
      const alternatives = [];
      validateShape(value, candidate, path, alternatives);
      return alternatives.length === 0;
    });
    if (!matches) issue(errors, path, 'schema_type', 'Value does not match any permitted shape');
    return;
  }
  if (Object.hasOwn(schema, 'const') && !same(value, schema.const))
    issue(errors, path, 'schema_const', 'Value must equal the declared protocol constant');
  if (schema.enum && !schema.enum.some(candidate => same(value, candidate)))
    issue(errors, path, 'schema_enum', 'Value is not a permitted protocol value');
  if (schema.type) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const matches = schema.type === 'integer' ? Number.isSafeInteger(value) : actual === schema.type;
    if (!matches) {
      issue(errors, path, 'schema_type', 'Expected ' + schema.type);
      return;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength)
      issue(errors, path, 'schema_length', 'String is too short');
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength)
      issue(errors, path, 'schema_length', 'String is too long');
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      issue(errors, path, 'schema_pattern', 'String does not match its declared format');
    if (schema.format === 'date-time' && !validTimestamp(value))
      issue(errors, path, 'schema_datetime', 'Use a valid UTC ISO timestamp');
  }
  if (typeof value === 'number') {
    for (const [keyword, violated] of [
      ['minimum', value < schema.minimum], ['maximum', value > schema.maximum],
      ['exclusiveMinimum', value <= schema.exclusiveMinimum],
    ]) if (schema[keyword] !== undefined && violated)
      issue(errors, path, 'schema_range', 'Number violates ' + keyword);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      issue(errors, path, 'schema_items', 'Array has too few entries');
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      issue(errors, path, 'schema_items', 'Array has too many entries');
    if (schema.items) value.forEach((item, i) => validateShape(item, schema.items, pointer(path, i), errors));
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key))
      issue(errors, pointer(path, key), 'schema_required', 'Required field is missing');
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validateShape(item, schema.properties[key], pointer(path, key), errors);
      else if (schema.additionalProperties === false)
        issue(errors, pointer(path, key), 'schema_unknown_field', 'Unknown field is not allowed');
    }
  }
}

function unique(values, path, errors, key = value => value) {
  const seen = new Set();
  values.forEach((value, i) => {
    const item = key(value);
    if (seen.has(item)) issue(errors, pointer(path, i), 'duplicate_identity', 'Duplicate identity: ' + item);
    seen.add(item);
  });
}

function boundary(value, options, schema) {
  const errors = [];
  const stage = options?.stage ?? 'phase0';
  if (!['phase0', 'execute'].includes(stage))
    issue(errors, '/options/stage', 'invalid_stage', 'Stage must be phase0 or execute');
  try { canonicalJson(value); }
  catch (error) { issue(errors, '', 'invalid_json', error.message); return { errors, stage }; }
  validateShape(value, schema, '', errors);
  return { errors, stage };
}

function documentHash(value, field) {
  return fingerprint({ ...value, [field]: null });
}

function requireValue(value, path, errors) {
  if (value === null) issue(errors, path, 'unresolved_policy', 'Executable identity or policy must be explicitly resolved');
}

function checkHash(value, hashField, errors, path = '') {
  const expected = documentHash(value, hashField);
  if (value[hashField] !== null && value[hashField] !== expected)
    issue(errors, pointer(path, hashField), 'fingerprint_mismatch', 'Content changed after the recorded fingerprint');
  if (value.status === 'frozen' && value[hashField] === null)
    issue(errors, pointer(path, hashField), 'unsealed_identity', 'Frozen documents require a matching fingerprint');
  return expected;
}

function unresolved(value, path, errors) {
  if (value === null) return requireValue(value, path, errors);
  if (Array.isArray(value)) value.forEach((item, i) => unresolved(item, pointer(path, i), errors));
  else if (isObject(value)) for (const [key, item] of Object.entries(value))
    unresolved(item, pointer(path, key), errors);
}

export function validateEnvironmentManifest(value, options = {}) {
  const { errors, stage } = boundary(value, options, environmentSchema);
  if (errors.length) return { valid: false, errors };
  const hash = checkHash(value, 'manifest_sha256', errors);
  if (stage === 'execute' && value.status !== 'frozen')
    issue(errors, '/status', 'unfrozen_identity', 'Paid execution requires a frozen environment manifest');
  unique(value.pi.extensions, '/pi/extensions', errors, item => item.id);
  unique(value.pi.extensions, '/pi/extensions', errors, item => item.path);
  unique(value.pi.tools, '/pi/tools', errors, item => item.name);
  unique(value.pi.active_tools, '/pi/active_tools', errors);
  unique(value.pi.sources, '/pi/sources', errors, item => item.id);
  const toolNames = new Set(value.pi.tools.map(item => item.name));
  value.pi.active_tools.forEach((name, index) => {
    if (!toolNames.has(name)) issue(errors, '/pi/active_tools/' + index, 'unknown_tool', 'Active tool has no declaration');
  });
  const brokerExtensions = value.pi.extensions.filter(item => item.role === 'broker');
  if (value.pi.mode === 'native') {
    if (brokerExtensions.length) issue(errors, '/pi/extensions', 'native_broker_loaded', 'Native conditions cannot declare a Broker extension');
    if (!value.pi.native_root) issue(errors, '/pi/native_root', 'native_root_required', 'Native consumption requires an explicit Skill root');
    if (value.pi.sources.some(item => item.kind !== 'native'))
      issue(errors, '/pi/sources', 'native_source_mismatch', 'Native corpus bindings must be native sources');
  } else {
    if (brokerExtensions.length !== 1) issue(errors, '/pi/extensions', 'broker_extension_required', 'Broker mode requires one identified Broker extension');
    if (value.pi.native_root !== null) issue(errors, '/pi/native_root', 'broker_native_root', 'Broker mode does not declare a native Skill root');
    if (value.pi.sources.some(item => item.kind === 'native'))
      issue(errors, '/pi/sources', 'broker_source_mismatch', 'Broker bindings cannot claim the native consumer');
  }
  if (value.runtime.pi.entry !== value.pi.entry)
    issue(errors, '/pi/entry', 'pi_entry_mismatch', 'Pi runtime and launch entries must identify the same maintained entry');
  if (value.status === 'frozen' || stage === 'execute') {
    unresolved(value.build, '/build', errors);
    unresolved(value.runtime, '/runtime', errors);
    for (const key of ['config_sha256', 'extensions', 'catalog_sha256', 'sources', 'guidance_sha256', 'injection_sha256', 'return_contract_sha256', 'error_contract_sha256'])
      unresolved(value.pi[key], '/pi/' + key, errors);
    if (value.pi.mode === 'native') unresolved(value.pi.native_root, '/pi/native_root', errors);
  }
  return { valid: errors.length === 0, errors, fingerprint: hash };
}

function checkReferences(value, errors) {
  const maps = {};
  for (const key of ['environments', 'models', 'conditions', 'pairs', 'assessments']) {
    unique(value[key], '/' + key, errors, item => item.id);
    maps[key] = new Map(value[key].map(item => [item.id, item]));
  }
  for (const key of ['cases', 'capabilities']) {
    unique(value.corpus[key], '/corpus/' + key, errors, item => item.id);
    maps[key] = new Map(value.corpus[key].map(item => [item.id, item]));
  }
  unique(value.policies.budgets, '/policies/budgets', errors, item => item.id);
  maps.budgets = new Map(value.policies.budgets.map(item => [item.id, item]));
  const ref = (map, id, path) => {
    if (!map.has(id)) issue(errors, path, 'unknown_reference', 'No declaration exists for ' + id);
    return map.get(id);
  };
  value.conditions.forEach((condition, i) => {
    const path = '/conditions/' + i;
    const environment = ref(maps.environments, condition.environment_id, path + '/environment_id');
    ref(maps.models, condition.model_id, path + '/model_id');
    ref(maps.budgets, condition.budget_id, path + '/budget_id');
    unique(condition.case_ids, path + '/case_ids', errors);
    condition.case_ids.forEach((id, j) => ref(maps.cases, id, path + '/case_ids/' + j));
    if (condition.corpus_id !== value.corpus.id || condition.corpus_sha256 !== value.corpus.content_sha256)
      issue(errors, path + '/corpus_sha256', 'corpus_mismatch', 'Condition must bind this exact canonical corpus');
    if (environment) {
      if (condition.environment_sha256 !== documentHash(environment, 'manifest_sha256'))
        issue(errors, path + '/environment_sha256', 'environment_mismatch', 'Condition must bind its complete environment content, not only its name');
      if (condition.code_mode !== environment.policies.code_mode)
        issue(errors, path + '/code_mode', 'code_mode_mismatch', 'Condition and environment disagree on Code Mode policy');
    }
  });
  value.corpus.capabilities.forEach((capability, i) => {
    unique(capability.environment_ids, '/corpus/capabilities/' + i + '/environment_ids', errors);
    capability.environment_ids.forEach((id, j) => ref(maps.environments, id, '/corpus/capabilities/' + i + '/environment_ids/' + j));
    if (capability.scope === 'common') {
      const used = new Set(value.conditions.map(condition => condition.environment_id));
      if ([...used].some(id => !capability.environment_ids.includes(id)))
        issue(errors, '/corpus/capabilities/' + i, 'common_capability_scope', 'Every compared environment must promise each common capability');
    }
  });
  const materials = new Map();
  value.corpus.cases.forEach((item, i) => {
    const path = '/corpus/cases/' + i;
    unique(item.capability_ids, path + '/capability_ids', errors);
    item.capability_ids.forEach((id, j) => ref(maps.capabilities, id, path + '/capability_ids/' + j));
    const prior = materials.get(item.material_id);
    if (prior && (prior.content_sha256 !== item.content_sha256 || prior.split !== item.split || prior.cluster_id !== item.cluster_id))
      issue(errors, path + '/material_id', 'material_identity_conflict', 'Shared material identity must retain content, split and cluster');
    materials.set(item.material_id, item);
  });
  maps.materials = materials;
  return { maps, ref };
}

function comparisonChecks(value, maps, ref, errors) {
  const usedConditions = new Set();
  const occupiedEpisodes = new Set();
  const pairOrientations = new Map();
  const pairCells = [];
  const useEpisode = (condition, item, repeat, path) => {
    usedConditions.add(condition.id);
    const key = canonicalJson([condition.id, item.id, repeat]);
    if (occupiedEpisodes.has(key)) issue(errors, path, 'duplicate_episode', 'A condition/case/repeat is scheduled more than once');
    occupiedEpisodes.add(key);
    if (!condition.case_ids.includes(item.id))
      issue(errors, path, 'case_scope_mismatch', 'The condition did not declare this case');
  };
  const commonCases = condition => condition.case_ids.filter(id => {
    const item = maps.cases.get(id);
    return item && item.capability_ids.every(capability => maps.capabilities.get(capability)?.scope === 'common');
  });
  value.pairs.forEach((pair, i) => {
    const path = '/pairs/' + i;
    unique(pair.condition_ids, path + '/condition_ids', errors);
    const orientationKey = canonicalJson([...pair.condition_ids].sort());
    const priorOrientation = pairOrientations.get(orientationKey);
    if (priorOrientation && !same(priorOrientation, pair.condition_ids))
      issue(errors, path + '/condition_ids', 'pair_orientation', 'Comparison roles stay fixed; randomize execution order through the ordering policy');
    pairOrientations.set(orientationKey, pair.condition_ids);
    const item = ref(maps.cases, pair.case_id, path + '/case_id');
    const conditions = pair.condition_ids.map((id, j) => ref(maps.conditions, id, path + '/condition_ids/' + j));
    if (!item || conditions.some(condition => !condition)) return;
    const [a, b] = conditions;
    conditions.forEach(condition => useEpisode(condition, item, pair.repeat, path));
    if (!item.capability_ids.every(id => maps.capabilities.get(id)?.scope === 'common'))
      issue(errors, path + '/case_id', 'noncommon_pair', 'Added or withdrawn capabilities require separate assessments, not the common pair denominator');
    if (!setSame(commonCases(a), commonCases(b)))
      issue(errors, path, 'fixed_denominator_mismatch', 'Paired conditions must retain the same common case set');
    for (const field of ['corpus_id', 'corpus_sha256', 'initial_state_sha256', 'authorization_sha256', 'budget_id'])
      if (!same(a[field], b[field])) issue(errors, path, 'fairness_mismatch', 'Pair differs in fixed ' + field);
    const ea = maps.environments.get(a.environment_id), eb = maps.environments.get(b.environment_id);
    const ma = maps.models.get(a.model_id), mb = maps.models.get(b.model_id);
    if (!ea || !eb || !ma || !mb) return;
    if (value.purpose === 'model_evolution' || value.purpose === 'model_crosssection') {
      if (a.environment_sha256 !== b.environment_sha256 || a.environment_id !== b.environment_id)
        issue(errors, path, 'model_comparison_environment', 'Model comparison fixes one exact environment');
      if (a.model_id === b.model_id) issue(errors, path, 'model_comparison_identity', 'Model comparison needs distinct configured models');
      if (same(modelCondition(ma), modelCondition(mb)))
        issue(errors, path, 'model_condition_same', 'Renaming a model or its verification receipt does not change the actual model condition');
      if (value.purpose === 'model_evolution' && ma.family !== mb.family)
        issue(errors, path, 'model_family_mismatch', 'Model evolution compares members of one declared family');
    } else {
      if (a.model_id !== b.model_id) issue(errors, path, 'environment_comparison_model', 'Environment pairs fix the same model and effective configuration');
      const differences = Object.entries(ENVIRONMENT_COMPONENTS).filter(([, select]) => !same(select(ea), select(eb))).map(([key]) => key);
      for (const key of differences) if (!value.allowed_changes.includes(key))
        issue(errors, path, 'undeclared_change', 'Environment differs in undeclared component ' + key);
      if (!differences.length) issue(errors, path, 'no_candidate_change', 'Renaming an environment or build receipt does not create a distinct candidate');
      if (value.purpose === 'native_calibration' && setSame([ea.pi.mode, eb.pi.mode], ['broker', 'native']) === false)
        issue(errors, path, 'native_calibration_modes', 'Native calibration pairs Broker and native without fixing their A/B order');
    }
    if (!value.allowed_changes.includes('code_mode') && a.code_mode !== b.code_mode)
      issue(errors, path, 'undeclared_code_mode', 'Code Mode policy differs without a registered change');
    const start = Math.max(Date.parse(ma.backend.window.start), Date.parse(mb.backend.window.start));
    const end = Math.min(modelWindowEnd(ma.backend.window), modelWindowEnd(mb.backend.window));
    if (start >= end && value.purpose !== 'model_evolution')
      issue(errors, path, 'route_window_mismatch', 'Contemporary comparisons require overlapping route observation windows');
    pairCells.push({ pair, conditions, item });
  });
  value.assessments.forEach((assessment, i) => {
    const path = '/assessments/' + i;
    const condition = ref(maps.conditions, assessment.condition_id, path + '/condition_id');
    const item = ref(maps.cases, assessment.case_id, path + '/case_id');
    if (!condition || !item) return;
    useEpisode(condition, item, assessment.repeat, path);
    const supported = item.capability_ids.every(id => maps.capabilities.get(id)?.environment_ids.includes(condition.environment_id));
    if (item.capability_ids.every(id => maps.capabilities.get(id)?.scope === 'common'))
      issue(errors, path, 'common_assessment', 'Common tasks belong in pairs, not unpaired capability assessments');
    if ((assessment.expected_support === 'supported') !== supported)
      issue(errors, path, 'support_mismatch', 'Unsupported is a declared capability scope, not an outcome override');
    if (assessment.expected_support === 'unsupported' && item.capability_ids.some(id => maps.capabilities.get(id)?.scope === 'common'))
      issue(errors, path, 'common_cannot_be_unsupported', 'A promised common capability cannot be removed from the result denominator');
  });
  value.conditions.forEach((condition, i) => {
    if (!usedConditions.has(condition.id)) issue(errors, '/conditions/' + i, 'unscheduled_condition', 'Declared condition has no planned pair or assessment');
    condition.case_ids.forEach(caseId => {
      if (![...occupiedEpisodes].some(key => { const tuple = JSON.parse(key); return tuple[0] === condition.id && tuple[1] === caseId; }))
        issue(errors, '/conditions/' + i + '/case_ids', 'unscheduled_case', 'Each declared case requires a scheduled unit; no hidden matrix is generated');
    });
  });
  if (value.purpose === 'model_environment_interaction') {
    const modelIds = new Set(value.conditions.map(c => c.model_id));
    const environmentIds = new Set(value.conditions.map(c => c.environment_id));
    const cells = new Set(value.conditions.map(c => canonicalJson([c.model_id, c.environment_id])));
    if (modelIds.size !== 2 || environmentIds.size !== 2 || cells.size !== 4 || value.conditions.length !== 4)
      issue(errors, '/conditions', 'interaction_grid', 'One finite interaction requires exactly two models by the same two environments');
    const interactionModels = [...modelIds].map(id => maps.models.get(id)).filter(Boolean);
    if (interactionModels.length === 2 && same(modelCondition(interactionModels[0]), modelCondition(interactionModels[1])))
      issue(errors, '/models', 'model_condition_same', 'Interaction requires two actual model conditions, not two labels for the same one');
    const groups = new Map();
    for (const cell of pairCells) {
      const key = canonicalJson([cell.pair.case_id, cell.pair.repeat, cell.pair.seed]);
      const group = groups.get(key) ?? [];
      group.push(cell);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (group.length !== 2 || new Set(group.map(cell => cell.conditions[0].model_id)).size !== 2)
        issue(errors, '/pairs', 'interaction_pairing', 'Each interaction task/repeat/seed needs both within-model environment pairs');
      if (group.length === 2 && !setSame(group[0].conditions.map(c => c.environment_id), group[1].conditions.map(c => c.environment_id)))
        issue(errors, '/pairs', 'interaction_environment', 'Both models must use the same two environment identities');
      if (group.length === 2) {
        if (!same(group[0].conditions.map(c => c.environment_id), group[1].conditions.map(c => c.environment_id)))
          issue(errors, '/pairs', 'interaction_orientation', 'Both model pairs preserve candidate/reference orientation');
        const first = group[0].conditions[0], second = group[1].conditions[0];
        for (const field of ['corpus_id', 'corpus_sha256', 'initial_state_sha256', 'authorization_sha256', 'budget_id', 'code_mode'])
          if (!same(first[field], second[field]))
            issue(errors, '/pairs', 'interaction_fairness', 'Interaction changes fixed ' + field + ' between its model groups');
        const modelA = maps.models.get(first.model_id), modelB = maps.models.get(second.model_id);
        if (modelA && modelB && Math.max(Date.parse(modelA.backend.window.start), Date.parse(modelB.backend.window.start))
          >= Math.min(modelWindowEnd(modelA.backend.window), modelWindowEnd(modelB.backend.window)))
          issue(errors, '/pairs', 'interaction_window', 'Interaction model groups require overlapping observation windows');
      }
    }
  }
  return pairCells;
}

function policyChecks(value, maps, pairCells, stage, errors) {
  const policies = value.policies;
  const standing = policies.campaign?.kind === 'benchmark-standing-campaign';
  unique(value.allowed_changes, '/allowed_changes', errors);
  unique(policies.ordering.condition_order, '/policies/ordering/condition_order', errors);
  if (!setSame(policies.ordering.condition_order, value.conditions.map(c => c.id)))
    issue(errors, '/policies/ordering/condition_order', 'order_scope_mismatch', 'Ordering must list every selected condition exactly once');
  unique(policies.evidence.required, '/policies/evidence/required', errors);
  for (const kind of REQUIRED_EVIDENCE) if (!policies.evidence.required.includes(kind))
    issue(errors, '/policies/evidence/required', 'missing_evidence_contract', 'Missing required observation: ' + kind);
  const families = new Set(pairCells.map(cell => cell.item.family));
  unique(policies.statistics.family_weights, '/policies/statistics/family_weights', errors, item => item.family);
  if (!setSame(policies.statistics.family_weights.map(item => item.family), [...families]))
    issue(errors, '/policies/statistics/family_weights', 'weight_scope_mismatch', 'Weights must cover exactly the declared common-task families');
  if (Math.abs(policies.statistics.family_weights.reduce((sum, item) => sum + item.weight, 0) - 1) > 1e-12)
    issue(errors, '/policies/statistics/family_weights', 'weight_sum', 'Frozen family weights must sum to one');
  const allMetrics = [...value.metrics.primary, ...value.metrics.secondary];
  unique(allMetrics, '/metrics', errors);
  const knownMetrics = new Set(metricDictionary.metrics.map(metric => metric.id));
  for (const metric of allMetrics) if (!knownMetrics.has(metric))
    issue(errors, '/metrics', 'unknown_metric', 'Metric has no versioned formula and evidence contract: ' + metric);
  if (!allMetrics.includes('verified_quality'))
    issue(errors, '/metrics', 'quality_metric_required', 'Business quality cannot be replaced by efficiency measures');
  if (value.metrics.dictionary_sha256 !== fingerprint(metricDictionary))
    issue(errors, '/metrics/dictionary_sha256', 'metric_dictionary_mismatch', 'Metric dictionary content must match this versioned implementation');
  let selectedSlots;
  const followup = policies.campaign?.role === UNSTARTED_FOLLOWUP;
  const confirmationContinuation = policies.campaign?.role === CONFIRMATION_CONTINUATION;
  if (selectsUnstartedSlots(policies.campaign?.role)) {
    try { selectedSlots = scheduleProtocol(value); }
    catch (error) { issue(errors, '/policies/campaign/selection', 'followup_selection', error.message); }
  } else if (policies.campaign?.selection !== undefined)
    issue(errors, '/policies/campaign/selection', 'followup_role_required', 'Only an explicitly authorized unstarted follow-up may select a schedule suffix');
  const totalScheduled = selectedSlots?.length ?? (value.pairs.length * 2 + value.assessments.filter(a => a.expected_support === 'supported').length);
  if (standing) {
    const scope = policies.campaign;
    if (policies.pilot.scope)
      issue(errors, '/policies/campaign', 'standing_legacy_scope', 'Standing execution cannot inherit a legacy finite scope');
    if (scope.planned_episodes !== totalScheduled)
      issue(errors, '/policies/campaign/planned_episodes', 'standing_schedule', 'The work item must describe the complete frozen scientific schedule');
    if (policies.pilot.max_scheduled_episodes !== null || policies.pilot.route_gate_episodes !== null
        || policies.reruns.max_episodes !== null || policies.budgets.some(budget => budget.mode !== 'unbounded'))
      issue(errors, '/policies', 'standing_resource_policy', 'Standing execution has no authorization quotas, gate allowance or rerun budget');
    if (value.models.some(model => !model.routing))
      issue(errors, '/models', 'campaign_routing', 'Every standing campaign model requires a frozen reported-model routing contract');
    if (!Number.isSafeInteger(policies.analysis?.capped_time_horizon_ms) || policies.analysis.capped_time_horizon_ms <= 0)
      issue(errors, '/policies/analysis/capped_time_horizon_ms', 'standing_analysis_horizon', 'Register a positive measurement horizon separately from unbounded execution resources');
  } else if (policies.campaign) {
    const scope = policies.campaign;
    if (policies.pilot.scope || !['pilot', 'confirmation'].includes(value.phase))
      issue(errors, '/policies/campaign', 'campaign_phase', 'A finite campaign requires its own pilot or confirmation contract without a legacy scope');
    if (scope.reservation_limit !== totalScheduled || totalScheduled > 144)
      issue(errors, '/policies/campaign/reservation_limit', 'campaign_schedule', 'The finite allowance must equal the complete frozen schedule inside the shared 144 cap');
    if (policies.budgets.length !== 1 || policies.budgets[0].batch.max_episodes !== totalScheduled
        || policies.budgets[0].episode.max_retries !== 0 || policies.reruns.max_episodes !== 0)
      issue(errors, '/policies/campaign', 'campaign_budget', 'The finite schedule requires one exact episode allowance and no retries or replacements');
    if (value.models.some(model => !model.routing))
      issue(errors, '/models', 'campaign_routing', 'Every finite campaign model requires a frozen reported-model routing contract');
    if (followup && (value.phase !== 'pilot' || policies.decision.mode !== 'descriptive'))
      issue(errors, '/policies/campaign', 'followup_descriptive_pilot', 'An unstarted follow-up keeps the full scientific denominator and remains a descriptive pilot');
    if (confirmationContinuation && (value.phase !== 'confirmation' || policies.decision.mode !== 'acceptance'))
      issue(errors, '/policies/campaign', 'continuation_original_confirmation', 'A confirmation continuation retains the original confirmation design and acceptance policy');
    if (scope.role === ENGINEERING_WINDOW_CONTINUATION && (value.phase !== 'pilot' || policies.decision.mode !== 'descriptive'))
      issue(errors, '/policies/campaign', 'engineering_window_descriptive_pilot', 'An engineering window continuation retains the original descriptive pilot design');
    if (scope.role === 'route_gate_only') {
      const cases = value.corpus.cases.map(item => item.id), modes = value.environments.map(environment => environment.pi.mode);
      if (value.phase !== 'pilot' || value.purpose !== 'native_calibration' || value.models.length !== 1
          || value.environments.length !== 2 || !setSame(modes, ['broker', 'native'])
          || value.conditions.length !== 2 || cases.length !== 4 || totalScheduled !== 8 || value.assessments.length
          || value.pairs.some(pair => pair.repeat !== 0) || value.conditions.some(condition => !setSame(condition.case_ids, cases))
          || new Set(value.conditions.map(condition => condition.environment_id)).size !== 2)
        issue(errors, '/policies/campaign', 'finite_route_gate_shape', 'A route-only gate is one model in Broker/native with the same four cases, once per condition');
    }
  }
  if (!standing && (policies.pilot.max_scheduled_episodes !== 144 || policies.pilot.route_gate_episodes !== 24))
    issue(errors, '/policies/pilot', 'legacy_pilot_limits', 'Historical finite protocols retain their registered 144/24 limits');
  if (policies.pilot.scope) {
    const scope = policies.pilot.scope;
    if (value.phase !== 'pilot') issue(errors, '/policies/pilot/scope', 'pilot_scope_phase', 'A prospective scope remains inside the pilot campaign');
    if (scope.kind === 'benchmark-prospective-cohort') {
      const conditionCount = scope.model_count * 2, caseCount = scope.role === 'gate' ? 4 : 8;
      if (value.models.length !== scope.model_count || value.environments.length !== 2
          || !setSame(value.environments.map(e => e.pi.mode), ['broker', 'native']))
        issue(errors, '/policies/pilot/scope', 'cohort_conditions', 'The cohort fixes its declared models in Broker and native');
      if (value.conditions.length !== conditionCount
          || new Set(value.conditions.map(c => canonicalJson([c.model_id, c.environment_id]))).size !== conditionCount
          || value.models.some(model => value.environments.some(environment =>
            !value.conditions.some(c => c.model_id === model.id && c.environment_id === environment.id))))
        issue(errors, '/conditions', 'cohort_cells', 'Every declared model/environment cell must occur exactly once');
      if (scope.gate_episodes !== conditionCount * 4 || scope.reservation_limit !== conditionCount * 12)
        issue(errors, '/policies/pilot/scope', 'cohort_limits', 'The finite cohort has four gate and eight expansion cases per condition');
      const caseIds = new Set(value.pairs.map(pair => pair.case_id));
      if (value.assessments.length || caseIds.size !== caseCount || totalScheduled !== conditionCount * caseCount
          || value.conditions.some(c => !setSame(c.case_ids, [...caseIds])
            || value.pairs.reduce((n, pair) => n + pair.condition_ids.filter(id => id === c.id).length, 0) !== caseCount))
        issue(errors, '/policies/pilot/scope', 'cohort_schedule', 'Every condition requires exactly the same declared gate or expansion case set');
      if (value.pairs.some(pair => pair.repeat !== 0) || policies.reruns.max_episodes !== 0)
        issue(errors, '/policies/pilot/scope', 'cohort_repetitions', 'Each cohort case runs once per condition with no replacement allowance');
      if (value.models.some(model => !model.routing))
        issue(errors, '/models', 'cohort_routing_required', 'Each prospective cohort model freezes its route and reported-model contract');
    } else {
      if (value.models.length !== 2 || value.environments.length !== 2 || !setSame(value.environments.map(e => e.pi.mode), ['broker', 'native']))
        issue(errors, '/policies/pilot/scope', 'pilot_scope_conditions', 'The registered scope requires two selected models in Broker and native');
      if (value.conditions.length !== 4 || new Set(value.conditions.map(c => c.model_id + '/' + c.environment_id)).size !== 4)
        issue(errors, '/conditions', 'pilot_scope_cells', 'Every selected model/environment cell must occur exactly once');
      if (scope.role === 'gate' && (totalScheduled !== 16 || value.conditions.some(c => value.pairs.reduce((n, pair) => n + pair.condition_ids.filter(id => id === c.id).length, 0) !== 4)))
        issue(errors, '/policies/pilot/scope', 'pilot_scope_gate_schedule', 'The prospective gate requires sixteen new episodes, four per condition');
    }
  }
  if (!standing && value.phase === 'pilot' && totalScheduled + (policies.reruns.max_episodes ?? 0) > policies.pilot.max_scheduled_episodes)
    issue(errors, '/pairs', 'pilot_episode_limit', 'Pilot planned attempts plus reserved replacements cannot exceed 144 including the first 24');
  for (const [i, budget] of policies.budgets.entries()) {
    const path = '/policies/budgets/' + i;
    if (budget.mode === 'unbounded') {
      if (!standing)
        issue(errors, path + '/mode', 'standing_authorization_required', 'Unbounded resources require a standing campaign with its authorization binding');
      if (Object.values(budget.episode).some(item => item !== null)
          || Object.entries(budget.batch).some(([key, item]) => key !== 'max_concurrency' && item !== null)
          || budget.monetary.policy !== 'unpriced')
        issue(errors, path, 'unbounded_resource_limits', 'Unbounded resources use explicit null limits and retain actual usage accounting');
    }
    const selected = new Set(value.conditions.filter(c => c.budget_id === budget.id).map(c => c.id));
    const scheduled = selectedSlots ? selectedSlots.filter(slot => selected.has(slot.condition_id)).length
      : value.pairs.reduce((count, p) => count + p.condition_ids.filter(id => selected.has(id)).length, 0)
        + value.assessments.filter(a => selected.has(a.condition_id) && a.expected_support === 'supported').length;
    if (budget.batch.max_episodes !== null && scheduled + (policies.reruns.max_episodes ?? 0) > budget.batch.max_episodes)
      issue(errors, path + '/batch/max_episodes', 'batch_episode_limit', 'Plan and reserved reruns exceed the frozen scheduling budget');
    if (!standing && value.phase === 'pilot' && budget.batch.max_episodes > 144)
      issue(errors, path + '/batch/max_episodes', 'pilot_episode_limit', 'Pilot budgets cannot authorize more than 144 scheduled episodes');
    if (policies.ordering.concurrency !== null && budget.batch.max_concurrency !== null && policies.ordering.concurrency > budget.batch.max_concurrency)
      issue(errors, path + '/batch/max_concurrency', 'concurrency_limit', 'Declared global concurrency exceeds this batch budget');
    for (const field of ['max_model_requests', 'max_input_tokens', 'max_output_tokens', 'max_duration_ms']) {
      if (budget.episode[field] !== null && budget.batch[field] !== null && budget.batch[field] < budget.episode[field])
        issue(errors, path + '/batch/' + field, 'budget_inconsistent', 'Batch bound cannot be below one episode bound');
    }
    if (budget.episode.max_http_attempts !== null && budget.episode.max_model_requests !== null
      && budget.episode.max_http_attempts < budget.episode.max_model_requests)
      issue(errors, path + '/episode/max_http_attempts', 'attempt_budget_inconsistent', 'HTTP attempt budget must cover declared model requests');
    if (budget.monetary.policy === 'priced') unresolved(budget.monetary, path + '/monetary', errors);
    else if (Object.entries(budget.monetary).some(([key, item]) => key !== 'policy' && item !== null))
      issue(errors, path + '/monetary', 'unpriced_cost_claim', 'Unpriced routes report token and network vectors without invented money');
  }
  if (value.purpose === 'model_evolution' || value.purpose === 'model_crosssection') {
    if (!setSame(value.allowed_changes, ['model']))
      issue(errors, '/allowed_changes', 'model_axis_changes', 'A model-only comparison changes only the configured model');
  } else if (value.purpose !== 'model_environment_interaction' && value.allowed_changes.includes('model'))
    issue(errors, '/allowed_changes', 'environment_axis_changes', 'Environment-only comparisons cannot also change the model');
  if (value.purpose === 'model_environment_interaction' && !value.allowed_changes.includes('model'))
    issue(errors, '/allowed_changes', 'interaction_model_change', 'The finite interaction explicitly declares its model factor');
  value.models.forEach((model, i) => {
    const path = '/models/' + i;
    if (model.routing) {
      const routing = model.routing, auto = model.route.startsWith('auto/');
      try { validateRoutingPolicy(routing); }
      catch (error) { issue(errors, path + '/routing', 'routing_policy_invalid', error.message); }
      const matchesVariant = id => id === routing.model_variant || id.endsWith('/' + routing.model_variant);
      if ((routing.mode === 'auto-route') !== auto || /(^|\/)group\//.test(model.route)
          || (routing.mode === 'auto-route' && model.route !== 'auto/' + routing.model_variant)
          || (routing.mode === 'fixed-route' && /(^|\/)auto\//.test(model.route)))
        issue(errors, path + '/routing/mode', 'routing_mode_mismatch', 'Auto routes must declare auto-route; fixed routes cannot use group aliases');
      if (auto && model.backend.observability !== 'opaque_alias')
        issue(errors, path + '/backend', 'auto_backend_unverified', 'An auto route is an opaque backend condition; a returned route label is not backend attestation');
      if (!matchesVariant(model.route))
        issue(errors, path + '/routing/model_variant', 'route_variant_mismatch', 'The requested route must name the declared concrete model variant');
      unique(routing.reported_model_ids, path + '/routing/reported_model_ids', errors);
      if (routing.reported_model_ids.some(id => !(routing.mode === 'auto-route' && id === canonicalAutoGroupLabel(routing.model_variant)) &&
          (/(^|\/)group\//.test(id) || (/(^|\/)auto\//.test(id) && !(routing.mode === 'auto-route' && id === model.route)) || !matchesVariant(id))))
        issue(errors, path + '/routing/reported_model_ids', 'reported_model_alias', 'Reported labels must name the declared variant or its exact authorized auto route or canonical group');
    }
    if (!validModelWindow(model.backend.window))
      issue(errors, path + '/backend/window', 'route_window_invalid', 'Route window start must precede its end');
    if (standing ? !isStandingWindow(model.backend.window)
        || model.backend.window.start !== policies.campaign.condition_epoch.started_at : model.backend.window.mode !== undefined || model.backend.window.end === null)
      issue(errors, path + '/backend/window', 'condition_epoch_mismatch', 'An open model epoch requires the same standing campaign condition start');
    if (model.backend.observability === 'reported' && model.backend.identity === null)
      issue(errors, path + '/backend/identity', 'reported_identity_missing', 'A reported backend must include the observed identity');
    if (model.backend.observability === 'opaque_alias' && model.backend.identity !== null)
      issue(errors, path + '/backend/identity', 'opaque_identity_claim', 'Opaque aliases cannot claim a verified backend version');
    if (model.adapter.verification === 'verified' && !model.adapter.evidence_sha256)
      issue(errors, path + '/adapter', 'adapter_evidence_missing', 'Adapter verification requires its receipt fingerprint');
    for (const field of ['development_material_ids', 'confirmation_material_ids'])
      unique(model.adoption[field], path + '/adoption/' + field, errors);
    if (model.adoption.development_material_ids.some(id => model.adoption.confirmation_material_ids.includes(id)))
      issue(errors, path + '/adoption', 'tuning_confirmation_leak', 'Tuning and confirmation materials must be disjoint');
    for (const materialId of model.adoption.confirmation_material_ids) {
      const material = maps.materials.get(materialId);
      if (!material || material.split !== 'confirmation')
        issue(errors, path + '/adoption/confirmation_material_ids', 'confirmation_material_missing', 'Confirmation material must exist and retain its unseen split');
    }
    for (const materialId of model.adoption.development_material_ids) {
      const material = maps.materials.get(materialId);
      if (!material || material.split !== 'development')
        issue(errors, path + '/adoption/development_material_ids', 'development_material_missing', 'Tuning must reference declared development material');
    }
    const developed = model.adoption.development_material_ids.map(id => maps.materials.get(id)).filter(Boolean);
    const materialIdentity = material => ({ content_sha256: material.content_sha256, prompt_sha256: material.prompt_sha256,
      contract_sha256: material.contract_sha256, initial_state_sha256: material.initial_state_sha256,
      authorization_sha256: material.authorization_sha256 });
    for (const materialId of model.adoption.confirmation_material_ids) {
      const confirmation = maps.materials.get(materialId);
      if (!confirmation) continue;
      if (developed.some(material => material.content_sha256 === confirmation.content_sha256))
        issue(errors, path + '/adoption/confirmation_material_ids', 'tuning_material_reused', 'Renaming developed business material cannot make it unseen confirmation material');
      if (developed.some(material => same(materialIdentity(material), materialIdentity(confirmation))))
        issue(errors, path + '/adoption/confirmation_material_ids', 'tuning_material_tuple_reused', 'Confirmation repeats the developed content, task, contract and initial-state identity');
    }
    if (model.adoption.mode === 'tuned') {
      if (!model.adoption.development_budget_id || !maps.budgets.has(model.adoption.development_budget_id)
        || !model.adoption.development_material_ids.length || !model.adoption.confirmation_material_ids.length)
        issue(errors, path + '/adoption', 'tuning_unbounded', 'Tuning needs a declared development budget and disjoint unseen confirmation materials');
    } else if (model.adoption.development_budget_id !== null || model.adoption.development_material_ids.length)
      issue(errors, path + '/adoption', 'as_is_tuning_claim', 'As-is adoption cannot hide development tuning');
  });
  const selectedCases = new Set(value.conditions.flatMap(condition => condition.case_ids));
  value.corpus.cases.forEach((item, i) => {
    if (!selectedCases.has(item.id)) return;
    if (value.phase === 'confirmation' && item.split !== 'confirmation')
      issue(errors, '/corpus/cases/' + i + '/split', 'confirmation_split', 'Primary confirmation batches use unseen confirmation material');
    if (['development', 'pilot'].includes(value.phase) && item.split === 'confirmation')
      issue(errors, '/corpus/cases/' + i + '/split', 'confirmation_exposed', 'Development and pilot execution cannot consume unseen confirmation material');
  });
  if (value.status === 'frozen' || stage === 'execute') {
    requireValue(value.registered_at, '/registered_at', errors);
    for (const [i, budget] of policies.budgets.entries()) {
      if (budget.mode !== 'unbounded') {
        unresolved(budget.episode, '/policies/budgets/' + i + '/episode', errors);
        unresolved(budget.batch, '/policies/budgets/' + i + '/batch', errors);
      } else requireValue(budget.batch.max_concurrency, '/policies/budgets/' + i + '/batch/max_concurrency', errors);
    }
    requireValue(policies.ordering.concurrency, '/policies/ordering/concurrency', errors);
    if (!standing) requireValue(policies.reruns.max_episodes, '/policies/reruns/max_episodes', errors);
    for (const key of ['interval_method', 'boundary_method', 'multiple_comparisons'])
      requireValue(policies.statistics[key], '/policies/statistics/' + key, errors);
    for (const key of ['absolute_quality_required', 'unassisted_quality_required'])
      requireValue(policies.decision[key], '/policies/decision/' + key, errors);
    if (policies.decision.mode === 'acceptance')
      requireValue(policies.decision.quality_delta_min, '/policies/decision/quality_delta_min', errors);
    for (const [metric, field] of [['input_ratio', 'input_ratio_max'], ['time_ratio', 'capped_time_ratio_max']])
      if (value.metrics.primary.includes(metric)) requireValue(policies.decision[field], '/policies/decision/' + field, errors);
    for (const key of ['observer_version', 'normalizer_version', 'scoring_version'])
      requireValue(policies.evidence[key], '/policies/evidence/' + key, errors);
  }
  if (stage === 'execute') value.models.forEach((model, i) => {
    if (model.adapter.verification !== 'verified')
      issue(errors, '/models/' + i + '/adapter', 'unverified_adapter', 'Paid task execution needs verified API and usage semantics');
  });
}

/** Analysis additions are registered protocol policy, never post-outcome plan overrides. */
export function validateAnalysisPolicy(protocol) {
  const policy = protocol.policies?.analysis;
  if (policy === undefined) return { valid: true, errors: [] };
  const errors = [], root = '/policies/analysis';
  try { canonicalJson(policy); }
  catch (error) { issue(errors, root, 'analysis_policy_json', error.message); return { valid: false, errors }; }
  validateShape(policy, protocolSchema.properties.policies.properties.analysis, root, errors);
  if (errors.length) return { valid: false, errors };
  for (const [name, cutoffs] of Object.entries(policy.success_budgets ?? {})) {
    if (cutoffs.some((value, index) => index > 0 && value <= cutoffs[index - 1]))
      issue(errors, root + '/success_budgets/' + name, 'analysis_budget_order', 'Registered budget cutoffs must be strictly increasing');
  }
  const conditions = new Map((protocol.conditions ?? []).map(condition => [condition.id, condition]));
  const interactions = policy.interactions ?? [];
  unique(interactions, root + '/interactions', errors, item => item.id);
  for (const [index, interaction] of interactions.entries()) {
    const path = root + '/interactions/' + index;
    if (new Set(interaction.condition_ids).size !== 4) {
      issue(errors, path + '/condition_ids', 'analysis_interaction_cells', 'An interaction requires four distinct frozen condition cells');
      continue;
    }
    const cells = interaction.condition_ids.map(id => conditions.get(id));
    if (cells.some(cell => !cell)) {
      issue(errors, path + '/condition_ids', 'analysis_condition_reference', 'Interaction conditions must belong to this frozen protocol');
      continue;
    }
    const [a, b, c, d] = cells;
    for (const pair of [[a, b], [c, d]]) {
      if (!(protocol.pairs ?? []).some(item => same(item.condition_ids, pair.map(cell => cell.id))))
        issue(errors, path + '/condition_ids', 'analysis_oriented_pair', 'Both interaction pairs must use their preregistered candidate/reference orientation');
    }
    const expectedPairs = [[a.environment_id, b.environment_id], [c.environment_id, d.environment_id]];
    if (interaction.environment_pairs && !same(interaction.environment_pairs, expectedPairs))
      issue(errors, path + '/environment_pairs', 'analysis_environment_pairs', 'Environment pairs must match the declared condition cells');
    if (interaction.kind === 'model_environment') {
      if (!(a.model_id === b.model_id && c.model_id === d.model_id && a.model_id !== c.model_id
          && a.environment_id === c.environment_id && b.environment_id === d.environment_id
          && cells.every(cell => cell.code_mode === a.code_mode)))
        issue(errors, path, 'analysis_interaction_axes', 'Model interaction requires the same two environments and Code Mode at each of two models');
    } else {
      if (!interaction.environment_pairs)
        issue(errors, path + '/environment_pairs', 'analysis_environment_pairs', 'Code Mode interaction must register both environment pairs');
      if (!(cells.every(cell => cell.model_id === a.model_id) && a.code_mode === b.code_mode
          && c.code_mode === d.code_mode && a.code_mode !== c.code_mode))
        issue(errors, path, 'analysis_interaction_axes', 'Code Mode interaction requires one model and two distinct matched Code Mode policies');
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateProtocol(value, options = {}) {
  const { errors, stage } = boundary(value, options, protocolSchema);
  if (errors.length) return { valid: false, errors };
  const hash = checkHash(value, 'protocol_sha256', errors);
  if (stage === 'execute' && (value.status !== 'frozen' || value.phase === 'phase0'))
    issue(errors, '/status', 'unfrozen_execution', 'Phase 0 and draft plans cannot authorize paid task requests');
  value.environments.forEach((environment, i) => {
    const result = validateEnvironmentManifest(environment, { stage });
    for (const error of result.errors) errors.push({ ...error, path: '/environments/' + i + error.path });
    if (value.status === 'frozen' && environment.status !== 'frozen')
      issue(errors, '/environments/' + i + '/status', 'unfrozen_identity', 'A frozen protocol cannot bind a draft environment');
  });
  const { maps, ref } = checkReferences(value, errors);
  const pairCells = comparisonChecks(value, maps, ref, errors);
  policyChecks(value, maps, pairCells, stage, errors);
  errors.push(...validateAnalysisPolicy(value).errors);
  return { valid: errors.length === 0, errors, fingerprint: hash };
}
