import assert from 'node:assert/strict';
import test from 'node:test';
import { BASELINE_DIAGNOSTIC, fingerprint, validateProtocol } from './protocol.mjs';
import { createPreregistrationTemplate } from './templates/preregistration.mjs';
import { plannedStudyDesign, preregisterComparison } from './planning.mjs';
import { configureComparison } from './configure.mjs';
import { scheduleProtocol } from './campaign-selection.mjs';
import { standingCampaignPolicy } from './standing-campaign.mjs';
import { runStandingSlices } from './standing-runner.mjs';
import { createAnalysisPlan, releasePolicy, scoreExperiment } from './analysis/compare.mjs';
import { exampleEpisode } from './analysis/fixtures.mjs';

// Synthetic identities exercise the maintained entry. They never authorize model sends.
function options({ repetitions = 1 } = {}) {
  const p = createPreregistrationTemplate(), h = fingerprint({ synthetic: 'baseline-diagnostic' });
  const environments = p.environments.slice(0, 1);
  for (const e of environments) {
    e.status = 'frozen'; e.build.id = 'synthetic'; e.build.receipt_sha256 = h;
    for (const item of [e.build.cli, e.build.broker]) for (const key of Object.keys(item)) item[key] = key === 'commit' ? '1'.repeat(40) : h;
    for (const [name, runtime] of Object.entries(e.runtime)) Object.assign(runtime, { entry: '/synthetic/' + name, version: '1.0.0', sha256: h });
    e.pi.entry = e.runtime.pi.entry;
    for (const key of Object.keys(e.pi)) if (key.endsWith('_sha256')) e.pi[key] = h;
    for (const x of e.pi.extensions) x.sha256 = h;
    e.manifest_sha256 = fingerprint({ ...e, manifest_sha256: null });
  }
  const started = '2000-01-01T00:00:00Z';
  p.models[0].adapter.verification = 'verified'; p.models[0].adapter.evidence_sha256 = h;
  p.models[0].backend.window = { mode: 'standing', start: started, end: null };
  p.models[0].id = 'synthetic-diagnostic-model'; p.models[0].route = 'fixed/' + p.models[0].id;
  p.models[0].routing = { mode: 'fixed-route', model_variant: p.models[0].id, reported_model_ids: [p.models[0].route] };
  const budget = p.policies.budgets[0]; budget.mode = 'unbounded'; budget.batch.max_concurrency = 1;
  const context = { attemptId: 'unit-experiment', authorization: { value: { id: 'synthetic-grant' } },
    workPlan: { value: { id: 'synthetic-work-plan' } }, item: { id: 'diagnosis', planned_episodes: repetitions },
    conditionEpoch: { id: 'synthetic-epoch', started_at: started, authorization: { path: '/synthetic/grant.json', sha256: h } } };
  return { id: 'unit-experiment', phase: 'pilot', purpose: BASELINE_DIAGNOSTIC,
    environments, models: p.models, corpus: p.corpus,
    cases: p.corpus.cases.map(protocol_case => ({ id: protocol_case.id, protocol_case })), repetitions,
    budget, decision: { ...p.policies.decision, absolute_quality_required: 1, unassisted_quality_required: 1 },
    analysis: { capped_time_horizon_ms: 600000 },
    campaignScope: standingCampaignPolicy(context, { scheduledEpisodes: repetitions }),
    allowedChanges: [], registeredAt: started };
}

test('one baseline freezes supported assessment slots without fabricating an A/A pair', () => {
  const p = preregisterComparison(options());
  assert.equal(validateProtocol(p, { stage: 'execute' }).valid, true);
  assert.equal(p.environments.length, 1); assert.equal(p.conditions.length, 1);
  assert.deepEqual(p.pairs, []); assert.equal(p.assessments.length, 1);
  assert.equal(p.assessments[0].expected_support, 'supported');
  const [slot] = scheduleProtocol(p);
  assert.equal(slot.condition_id, 'm0-e0'); assert.equal(slot.assessment_id, p.assessments[0].id);
  assert.equal(slot.pair_id, undefined);
  assert.deepEqual(createAnalysisPlan(p).slots.map(s => [s.case_id, s.condition_id, s.repeat]),
    [[p.corpus.cases[0].id, 'm0-e0', 0]]);
  for (const metric of ['input_ratio', 'time_ratio', 'version_transition'])
    assert.ok(![...p.metrics.primary, ...p.metrics.secondary].includes(metric));
});

test('diagnostic repeats keep the actual sample units and normal comparison requirements', () => {
  const p = preregisterComparison(options({ repetitions: 2 }));
  assert.deepEqual(scheduleProtocol(p).map(s => s.repeat), [0, 1]);
  const args = options();
  assert.throws(() => preregisterComparison({ ...args, purpose: 'environment_iteration' }), /two environments/);
  assert.throws(() => plannedStudyDesign({ ...args, environmentCount: 2 }), /one environment/);
  assert.throws(() => plannedStudyDesign({ ...args, environmentCount: 1, models: [...args.models, ...args.models] }), /one model/);
  assert.throws(() => plannedStudyDesign({ ...args, environmentCount: 1, environmentPairs: [[0, 0]] }), /no comparison pairs/);
  args.cases[0].protocol_case.split = 'confirmation';
  assert.throws(() => plannedStudyDesign({ ...args, environmentCount: 1 }), /development or pilot/);
});

test('the actual diagnostic schedule must match its standing scientific coverage', () => {
  const args = options({ repetitions: 2 });
  const design = plannedStudyDesign({ ...args, environmentCount: 1 });
  const context = { attemptId: args.id, authorization: { value: { id: 'synthetic-grant' } },
    workPlan: { value: { id: 'synthetic-work-plan' } }, item: { id: 'diagnosis', planned_episodes: 1 },
    conditionEpoch: args.campaignScope.condition_epoch };
  assert.throws(() => standingCampaignPolicy(context, { scheduledEpisodes: design.assessments.length }),
    /STANDING_SCIENTIFIC_COVERAGE_CHANGED/);
  context.item.planned_episodes = 2;
  assert.equal(standingCampaignPolicy(context, { scheduledEpisodes: design.assessments.length }).planned_episodes, 2);
});

test('configure refuses incompatible diagnosis before control writes or credential access', async () => {
  const setup = { version: 1, environment_root: '/not-created-diagnostic', control_root: '/not-created-diagnostic/control',
    purpose: BASELINE_DIAGNOSTIC, phase: 'pilot', candidates: [{}], models: { ids: ['synthetic'] }, standing: {},
    corpus: { split: 'development' }, allowed_changes: [], decision: { mode: 'descriptive' } };
  for (const [change, pattern] of [
    [{ candidates: [{}, {}] }, /one candidate/], [{ models: { ids: ['a', 'b'] } }, /one model/],
    [{ standing: undefined }, /standing authorization/], [{ phase: 'confirmation' }, /not confirmation/],
    [{ corpus: { split: 'confirmation' } }, /development or pilot/], [{ allowed_changes: ['tools'] }, /no comparison changes/],
    [{ environment_pairs: [[0, 0]] }, /no comparison pairs/], [{ decision: { mode: 'acceptance' } }, /cannot decide adoption/],
    [{ decision: { mode: 'descriptive', input_ratio_max: 1.1 } }, /no relative threshold/],
    [{ analysis: { interactions: [{}] } }, /no interactions/],
  ]) await assert.rejects(configureComparison({ ...setup, ...change }), pattern);
});

test('a complete correct baseline has descriptive results and cannot support adoption or a relative gain', () => {
  const p = preregisterComparison(options());
  const result = scoreExperiment({ protocol: p, episodes: [exampleEpisode({ condition: 'm0-e0', caseId: p.corpus.cases[0].id })] });
  assert.equal(result.conditions.length, 1); assert.equal(result.conditions[0].counts.pass, 1);
  assert.deepEqual(result.comparisons, []);
  assert.equal(releasePolicy(result).status, 'inconclusive');
  assert.equal(releasePolicy(result, { requireConfirmation: false }).status, 'inconclusive');
  const missing = scoreExperiment({ protocol: p, episodes: [] });
  assert.equal(missing.completeness.unresolved_slots.length, 1);
  assert.equal(releasePolicy(missing).status, 'incomplete');
});

test('the existing standing runner finishes one assessment and does not dispatch it twice', async () => {
  const protocol = preregisterComparison(options());
  const plan = { id: protocol.id, protocol, slots: scheduleProtocol(protocol) }, rows = [];
  let calls = 0;
  const put = row => rows.push({ seq: rows.length + 1, ...row });
  const run = () => runStandingSlices({ plan, maximumSlice: 1, readRows: async () => structuredClone(rows),
    writeCheckpoint: async () => {}, verifySnapshot: async () => {}, analyzePrefix: async () => {},
    runSlice: async () => {
      calls++; const slot = plan.slots[0], run_id = plan.id + '-001';
      put({ type: 'batch_opened' }); put({ type: 'episode_started', ...slot, run_id });
      put({ type: 'episode_completed', ...slot, run_id, result: { status: 'completed', stop_batch: false, stop_reason: null,
        budget_usage: { model_requests: 1, input_tokens: 100, output_tokens: 10, duration_ms: 100 } } });
      put({ type: 'batch_closed', reason: 'planned_slots_completed', new_episodes: 1 });
    } });
  assert.equal((await run()).action, 'finish'); assert.equal(calls, 1);
  assert.equal((await run()).action, 'finish'); assert.equal(calls, 1);
});
