import assert from 'node:assert/strict';
import { buildCorpus, planCaseVariant, validateCorpus } from './corpus/index.mjs';
import { fingerprint } from './protocol.mjs';

export const STORE_FIRST_USE_GENERATOR = 'owned-store-first-use-v1';
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
