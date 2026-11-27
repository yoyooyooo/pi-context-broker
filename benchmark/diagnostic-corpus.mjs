import assert from 'node:assert/strict';
import { buildCorpus, planCaseVariant, validateCorpus } from './corpus/index.mjs';
import { fingerprint } from './protocol.mjs';

export const STORE_FIRST_USE_GENERATOR = 'owned-store-first-use-v1';
export const LONG_SESSION_GENERATOR = 'long-session-consumption-v1';
const identity = value => { const { content_sha256: ignored, ...body } = value; return fingerprint(body); };
const definitions = [
  { id: 'store-first-grant-a', journey: 'store-first-grant', title: 'Shipping work followed by first-use grant review',
    warmup: 'implicit-01-a', target: 'references-01-a' },
  { id: 'store-first-tariff-a', journey: 'store-first-tariff', title: 'Refund work followed by first-use tariff calculation',
    warmup: 'explicit-01-a', target: 'scripts-assets-02-a' },
];

/** A separate diagnostic corpus; source cases, material and graders are never patched. */
export function buildStoreDiagnosticCorpus({ seed, split = 'development', materialVersion = '2' } = {}) {
  assert.equal(split, 'development', 'Store diagnostics use separately declared development material');
  assert.equal(materialVersion, '2');
  const source = buildCorpus({ seed, split, materialVersion });
  const corpusId = 'benchmark-store-first-use-' + fingerprint({ seed, split, materialVersion }).slice(0, 12);
  const cases = [], controls = [], retainedSkills = new Set(source.publicCorpus.distractor_skill_ids);
  for (const definition of definitions) {
    const warmup = planCaseVariant({ ...source, caseId: definition.warmup });
    const target = planCaseVariant({ ...source, caseId: definition.target, roundCount: 4 });
    assert.equal(warmup.publicCase.turns.length, 1); assert.equal(target.publicCase.turns.length, 4);
    const selectedTurns = target.publicCase.turns.slice(0, 3);
    const turns = [structuredClone(warmup.publicCase.turns[0]), ...selectedTurns.map((turn, index) => ({
      ...structuredClone(turn), id: 'turn-' + (index + 2),
      prompt: (index === 0 ? '前一项工作结束。现在处理另一项业务：' : '') + turn.prompt,
    }))];
    const attachmentPaths = new Set(turns.flatMap(turn => turn.attachment_paths));
    const attachments = [...warmup.publicCase.attachments, ...target.publicCase.attachments]
      .filter(file => attachmentPaths.has(file.path)).map(file => structuredClone(file));
    assert.equal(new Set(attachments.map(file => file.path)).size, attachments.length, 'Diagnostic input paths must not collide');
    const sourceControls = [definition.warmup, definition.target].map(id => source.control.cases.find(item => item.case_id === id));
    const skillIds = [...new Set(sourceControls.flatMap(item => item.target_skill_ids))];
    assert.equal(skillIds.length, 2, 'Each diagnostic has one warmup Skill and one distinct first-use Skill');
    for (const id of skillIds) retainedSkills.add(id);
    const warmupBusiness = warmup.oracle.contracts.filter(contract => contract.kind === 'artifact-json');
    const targetBusiness = target.oracle.contracts.filter(contract => contract.kind === 'artifact-json').slice(0, 3);
    assert.equal(warmupBusiness.length, 1); assert.equal(targetBusiness.length, 3);
    const contracts = [
      ...warmupBusiness.map(contract => ({ ...structuredClone(contract), id: 'warmup-' + contract.id, turn_id: 'turn-1' })),
      ...targetBusiness.map((contract, index) => ({ ...structuredClone(contract), id: 'target-' + contract.id, turn_id: 'turn-' + (index + 2) })),
      ...warmup.oracle.contracts.filter(contract => contract.kind === 'resources').map(contract => ({ ...structuredClone(contract), id: 'warmup-' + contract.id })),
      ...target.oracle.contracts.filter(contract => contract.kind === 'resources').map(contract => ({ ...structuredClone(contract), id: 'target-' + contract.id })),
      { id: 'legal-selection', kind: 'selection', critical: false, allowed_sets: [skillIds] },
    ];
    const selectedSkills = skillIds.map(id => source.publicCorpus.skills.find(skill => skill.id === id));
    const caseSeed = fingerprint({ seed, journey: definition.journey });
    const catalogIds = [...skillIds, ...source.publicCorpus.distractor_skill_ids.slice(0, 16 - skillIds.length)]
      .sort((a, b) => fingerprint(caseSeed + a).localeCompare(fingerprint(caseSeed + b)));
    const item = { id: definition.id, journey_id: definition.journey, family: 'task-switch', title: definition.title,
      material_id: corpusId + '-' + definition.id, cluster_id: definition.journey,
      split, seed: caseSeed, license: source.publicCorpus.license, material_version: materialVersion,
      required_capabilities: [...new Set([warmup, target].flatMap(plan => plan.publicCase.required_capabilities))],
      capability_scope: 'common', default_round_count: 4, catalog: { skill_ids: catalogIds, base_candidate_count: 16 },
      anchors: null, authorization: structuredClone(warmup.publicCase.authorization),
      turns, attachments, completion: { kind: 'artifacts', paths: contracts.filter(contract => contract.kind === 'artifact-json').map(contract => contract.path) },
      contract_sha256: fingerprint(contracts), variants: {}, prompt_sha256: fingerprint(turns),
      initial_state_sha256: fingerprint({ attachments, skills: selectedSkills.map(skill => ({ id: skill.id, files: skill.versions[skill.initial_version].files })) }),
      authorization_sha256: fingerprint(warmup.publicCase.authorization),
    };
    item.content_sha256 = identity(item); cases.push(item);
    controls.push({ case_id: item.id, target_skill_ids: skillIds,
      oracles: { 4: { schema_version: 1, case_id: item.id, capability_scope: 'common', required_capabilities: item.required_capabilities,
        public_sha256: item.content_sha256, contracts } }, events: [], clarification: null,
      diagnostic: { source_case_ids: [definition.warmup, definition.target], source_public_sha256: source.publicCorpus.content_sha256,
        source_case_sha256: [warmup.publicCase.content_sha256, target.publicCase.content_sha256],
        probe_skill_id: sourceControls[0].target_skill_ids[0], expected_target_skill_id: sourceControls[1].target_skill_ids[0],
        expected_target_first_task_turn: 'turn-2', observed_target_consumption: false },
    });
  }
  const publicCorpus = { ...source.publicCorpus, id: corpusId,
    provenance: { ...source.publicCorpus.provenance, source: 'benchmark/diagnostic-corpus.mjs',
      generator: STORE_FIRST_USE_GENERATOR, composition_source_sha256: source.publicCorpus.content_sha256,
      scope: 'two first-use Store diagnostics; not the forty-case corpus' },
    families: [{ id: 'task-switch', journey_count: 2, case_count: 2, weight: 1 }],
    skills: source.publicCorpus.skills.filter(skill => retainedSkills.has(skill.id)), cases };
  publicCorpus.content_sha256 = identity(publicCorpus);
  const control = { ...source.control, corpus_id: corpusId, public_sha256: publicCorpus.content_sha256, cases: controls };
  validateCorpus({ publicCorpus, control });
  return { publicCorpus, control };
}

const longSessionDefinitions = [
  { id: 'long-session-reuse-a', journey: 'long-session-reuse', family: 'continuation', title: '连续八批运输路由',
    schedule: ['routing', 'routing', 'routing', 'routing', 'routing', 'routing', 'routing', 'routing'] },
  { id: 'long-session-switch-a', journey: 'long-session-switch', family: 'task-switch', title: '运输、退货与普通事务交替',
    schedule: ['routing', 'amounts', 'refund', 'statuses', 'routing', 'refund', 'groups', 'routing'] },
];
const rowOrders = [[0, 1, 2, 3], [1, 2, 0, 3], [2, 0, 3, 1], [3, 1, 0, 2],
  [0, 2, 1, 3], [1, 0, 3, 2], [2, 3, 1, 0], [3, 2, 0, 1]];

function skillJson(skill, path) {
  const file = skill.versions[skill.initial_version].files.find(item => item.path === path);
  assert.ok(file && file.encoding === 'utf8', 'Diagnostic needs the original policy resource');
  return JSON.parse(file.content);
}

function longSessionTask({ kind, turn, caseId, seed, routing, refund }) {
  const id = index => 'R' + fingerprint({ seed, caseId, turn, index }).slice(0, 8);
  const reorder = rows => rowOrders[turn - 1].map(index => ({ id: id(index), ...rows[index] }));
  if (kind === 'routing') {
    const policy = skillJson(routing, 'references/routing.json'), limit = policy.express_max_kg;
    const rows = reorder([
      { weight_kg: limit - (turn % 3), fragile: false },
      { weight_kg: limit + turn, fragile: false },
      { weight_kg: limit - 1, fragile: true },
      { weight_kg: limit + turn + 1, fragile: true },
    ]);
    const company = routing.description.replace(/包裹运输路由规则$/u, '');
    return { rows, wording: (turn === 1 ? '请按 ' : '继续按 ') + company + ' 的运输路由规则安排这批包裹的线路', fields: '每个 id 和 route 组成的 JSON 数组',
      expected: rows.map(row => ({ id: row.id, route: row.fragile ? policy.fragile_route
        : row.weight_kg <= limit ? policy.express_route : policy.standard_route })), skill_ids: [routing.id] };
  }
  if (kind === 'refund') {
    const policy = skillJson(refund, 'references/refund.json');
    const rows = reorder([
      { days: policy.max_days, sealed: true, amount_cents: policy.review_above_cents - turn },
      { days: 1, sealed: true, amount_cents: policy.review_above_cents + turn },
      { days: policy.max_days + turn, sealed: true, amount_cents: 100 + turn },
      { days: 0, sealed: false, amount_cents: policy.review_above_cents },
    ]);
    const company = refund.description.replace(/退货审批政策$/u, '');
    return { rows, wording: '现在请按 ' + company + ' 的退货审批政策处理这批申请', fields: '每个 id 和 decision 组成的 JSON 数组',
      expected: rows.map(row => ({ id: row.id, decision: !row.sealed || row.days > policy.max_days ? 'reject'
        : row.amount_cents > policy.review_above_cents ? 'review' : 'approve' })), skill_ids: [refund.id] };
  }
  if (kind === 'amounts') {
    const rows = [0, 1, 2].map(index => ({ id: id(index), quantity: index + turn,
      unit_price_cents: 103 + Number.parseInt(fingerprint({ seed, caseId, turn, index }).slice(0, 3), 16) % 800 }));
    return { rows, wording: '处理一项金额汇总：把下列各行的 quantity 乘以 unit_price_cents 后相加。金额已是整数分，不加税费或折扣',
      fields: '包含 total_cents 的 JSON 对象', expected: { total_cents: rows.reduce((sum, row) => sum + row.quantity * row.unit_price_cents, 0) }, skill_ids: [] };
  }
  if (kind === 'statuses') {
    const rows = ['ready', 'held', 'sent', 'ready', 'ready', 'held'].map((status, index) => ({ id: id(index), status }));
    const expected = {};
    for (const row of rows) expected[row.status] = (expected[row.status] ?? 0) + 1;
    return { rows, wording: '请统计下面各个 status 出现的行数，不做业务判断',
      fields: '以 status 为键、行数为值的 JSON 对象', expected, skill_ids: [] };
  }
  assert.equal(kind, 'groups');
  const rows = ['train', 'meal', 'train', 'hotel'].map((category, index) => ({ id: id(index), category, cents: (index + 1) * 137 + turn }));
  const expected = {};
  for (const row of rows) expected[row.category] = (expected[row.category] ?? 0) + row.cents;
  return { rows, wording: '请把下面各行的 cents 按 category 相加，不做报销合规判断',
    fields: '以 category 为键、整数分合计为值的 JSON 对象', expected, skill_ids: [] };
}

/** New conversational tasks over unchanged source Skills; later inputs appear only in their own prompt. */
export function buildLongSessionDiagnosticCorpus({ seed, split = 'development', materialVersion = '2' } = {}) {
  assert.equal(split, 'development', 'Long-session diagnostics use separately declared development material');
  assert.equal(materialVersion, '2');
  const source = buildCorpus({ seed, split, materialVersion });
  const sourceCases = ['implicit-01-a', 'explicit-01-a'].map(caseId => planCaseVariant({ ...source, caseId }));
  const routing = source.publicCorpus.skills.find(skill => skill.id === 'implicit-01-a-routing');
  const refund = source.publicCorpus.skills.find(skill => skill.id === 'explicit-01-a-refund');
  assert.ok(routing && refund);
  const corpusId = 'benchmark-long-session-' + fingerprint({ seed, split, materialVersion }).slice(0, 12);
  const cases = [], controls = [];
  for (const definition of longSessionDefinitions) {
    const turns = [], contracts = [], requirements = [];
    for (const [index, kind] of definition.schedule.entries()) {
      const turn = index + 1, turnId = 'turn-' + turn;
      const task = longSessionTask({ kind, turn, caseId: definition.id, seed, routing, refund });
      const path = 'output/' + definition.id + '-turn-' + turn + '.json';
      turns.push({ id: turnId, prompt: task.wording + '。资料如下：\n' + JSON.stringify(task.rows) + '\n请将' + task.fields + '保存为 ' + path + '。', attachment_paths: [] });
      contracts.push({ id: 'business-turn-' + turn, kind: 'artifact-json', critical: true, path,
        comparison: Array.isArray(task.expected) ? 'rows-by-key' : 'exact', row_key: 'id',
        expected: task.expected, forbidden_fields: [], turn_id: turnId });
      requirements.push({ turn_id: turnId, task: kind, skill_ids: task.skill_ids });
    }
    const skillIds = [...new Set(requirements.flatMap(item => item.skill_ids))];
    const usedSources = sourceCases.filter(plan => skillIds.some(id => plan.skills.some(skill => skill.id === id)));
    for (const plan of usedSources) for (const contract of plan.oracle.contracts.filter(item => item.kind === 'resources'))
      contracts.push(structuredClone(contract));
    contracts.push({ id: 'legal-selection', kind: 'selection', critical: false, allowed_sets: [skillIds] });
    const selectedSkills = skillIds.map(id => source.publicCorpus.skills.find(skill => skill.id === id));
    const caseSeed = fingerprint({ seed, journey: definition.journey });
    const catalogIds = [...skillIds, ...source.publicCorpus.distractor_skill_ids.slice(0, 16 - skillIds.length)]
      .sort((a, b) => fingerprint(caseSeed + a).localeCompare(fingerprint(caseSeed + b)));
    const authorization = structuredClone(sourceCases[0].publicCase.authorization);
    const requiredCapabilities = [...new Set(usedSources.flatMap(plan => plan.publicCase.required_capabilities))];
    const item = { id: definition.id, journey_id: definition.journey, family: definition.family, title: definition.title,
      material_id: corpusId + '-' + definition.id, cluster_id: corpusId + '-shared-material-a',
      split, seed: caseSeed, license: source.publicCorpus.license, material_version: materialVersion,
      required_capabilities: requiredCapabilities, capability_scope: 'common', default_round_count: 8,
      catalog: { skill_ids: catalogIds, base_candidate_count: 16 }, anchors: null, authorization,
      turns, attachments: [], completion: { kind: 'artifacts', paths: contracts.filter(contract => contract.kind === 'artifact-json').map(contract => contract.path) },
      contract_sha256: fingerprint(contracts), variants: {}, prompt_sha256: fingerprint(turns),
      initial_state_sha256: fingerprint({ attachments: [], skills: selectedSkills.map(skill => ({ id: skill.id, files: skill.versions[skill.initial_version].files })) }),
      authorization_sha256: fingerprint(authorization) };
    item.content_sha256 = identity(item); cases.push(item);
    controls.push({ case_id: item.id, target_skill_ids: skillIds,
      oracles: { 8: { schema_version: 1, case_id: item.id, capability_scope: 'common', required_capabilities: requiredCapabilities,
        public_sha256: item.content_sha256, contracts } }, events: [], clarification: [],
      diagnostic: { source_case_ids: usedSources.map(plan => plan.publicCase.id), source_public_sha256: source.publicCorpus.content_sha256,
        source_case_sha256: usedSources.map(plan => plan.publicCase.content_sha256), turn_requirements: requirements,
        first_required_turns: skillIds.map(skill_id => ({ skill_id, turn_id: requirements.find(item => item.skill_ids.includes(skill_id)).turn_id })),
        resource_scope: 'Whole-episode resource contracts retain their original meaning. Audit delivery by first required turn separately; later turns may reuse session history.',
        prefixes: [1, 2, 4, 8], prefix_scope: 'Correlated prefixes of this eight-turn episode, not independent shorter experiments.' } });
  }
  const publicCorpus = { ...source.publicCorpus, id: corpusId,
    provenance: { ...source.publicCorpus.provenance, source: 'benchmark/diagnostic-corpus.mjs', generator: LONG_SESSION_GENERATOR,
      composition_source_sha256: source.publicCorpus.content_sha256, scope: 'two eight-turn conversations sharing source material; not independent material clusters' },
    families: [{ id: 'continuation', journey_count: 1, case_count: 1, weight: 0.5 }, { id: 'task-switch', journey_count: 1, case_count: 1, weight: 0.5 }], cases };
  publicCorpus.content_sha256 = identity(publicCorpus);
  const control = { ...source.control, corpus_id: corpusId, public_sha256: publicCorpus.content_sha256, cases: controls };
  validateCorpus({ publicCorpus, control });
  return { publicCorpus, control };
}
