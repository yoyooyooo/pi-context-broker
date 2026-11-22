import test from 'node:test';
import assert from 'node:assert/strict';
import {fingerprint,validateAnalysisPolicy} from './protocol.mjs';
import {normalizeEpisode} from './evidence/normalize.mjs';
import {exampleProtocol,exampleEpisode,exampleEnvelope,exampleEpisodes} from './analysis/fixtures.mjs';
import {scoreExperiment,costFrontier,createAnalysisPlan,ANALYSIS_VERSION} from './analysis/compare.mjs';
import {evaluateMetric} from './analysis/metrics.mjs';
import {reportTables,renderAnalysisMarkdown} from './analysis/report.mjs';

const freeze=p=>(p.protocol_sha256=fingerprint({...p,protocol_sha256:null}),p);
const score=(p,episodes=exampleEpisodes(p))=>scoreExperiment({protocol:p,episodes});
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);
const modelProtocol=(options={})=>{
  const p=exampleProtocol(options);
  p.conditions.push(...p.conditions.map(c=>({...c,id:c.id+'-new',model_id:'new-model'})));
  p.models.push({id:'new-model',backend:{window:{start:'2026-01-01',end:'2026-01-02'}}});
  p.pairs.push(...p.pairs.map(pair=>({...pair,id:pair.id+'-new',condition_ids:pair.condition_ids.map(id=>id+'-new')})));
  return freeze(p);
};
const costBound=()=>({upper:5,currency:'USD',verified:true,evidence_sha256:fingerprint('independently-verified-population-cost-bound')});
const pricedEpisode=({currency='USD',...options})=>{
  const fixture=exampleEnvelope(options);
  for(const attempt of fixture.input.attempts)attempt.cost.value.currency=currency;
  return normalizeEpisode(fixture.input).episode;
};
const interactionEpisodes=p=>p.pairs.flatMap(pair=>pair.condition_ids.map(condition=>{
  const values={candidate:[100,1],'reference':[200,2],'candidate-new':[500,4],'reference-new':[400,3]}[condition];
  return pricedEpisode({condition,caseId:pair.case_id,repeat:pair.repeat,successTime:values[0],cost:values[1],
    outcome:condition==='candidate-new'&&pair.case_id==='c1'?'fail':'pass'});
}));

test('per-success cost uses actual valid-run totals, not the fixed-family quality denominator',()=>{
  const p=exampleProtocol();
  const episodes=exampleEpisodes(p,{cost:1}).map(e=>e.identity.condition_id==='candidate'&&e.identity.case_id==='c2'?
    exampleEpisode({caseId:'c2',outcome:'fail',cost:1}):e);
  const metrics=score(p,episodes).conditions[0].metrics;
  close(metrics.verified_quality.estimate,.75);
  close(metrics.currency_cost.estimate,1);
  close(metrics.cost_per_success.estimate,3/2);
  assert.notEqual(metrics.cost_per_success.estimate,4/3);
  assert.equal(metrics.cost_per_success.total_valid_cost,3);
  assert.equal(metrics.cost_per_success.valid_episodes,3);
  assert.equal(metrics.cost_per_success.verified_successes,2);
});

test('scoreExperiment passes complete mean cost to environment frontier, including all failure costs',()=>{
  const cases=Array.from({length:100},(_,i)=>({id:'c'+i,family:'f',cluster_id:'k'+i,material_id:'m'+i}));
  const p=exampleProtocol({cases});p.policies.decision.absolute_quality_required=.1;freeze(p);
  const episodes=p.pairs.flatMap((pair,i)=>pair.condition_ids.map(condition=>exampleEpisode({condition,caseId:pair.case_id,cost:1,outcome:i<50?'pass':'fail'})));
  const analysis=score(p,episodes);
  assert.equal(analysis.cost_frontier.status,'available');
  assert.equal(analysis.cost_frontier.frontier.length,2);
  for(const winner of analysis.cost_frontier.frontier){close(winner.cost.estimate,1);assert.ok(winner.quality.interval.lower>=.1);}
  for(const condition of analysis.conditions)close(condition.metrics.cost_per_success.estimate,2);
});

test('frontier selects one minimum-cost level across models, not a quality-cost Pareto set',()=>{
  const config=(id,quality,cost,environment='env',support='supported')=>({id,model_id:id,
    scope:{environment_id:environment,task_scope_sha256:fingerprint('same-tasks'),planned_units:[{case_id:'case',repeat:0,seed:0,expected_support:support}]},
    quality:{status:'available',estimate:quality,interval:{status:'available',lower:quality-.01,upper:quality+.01}},
    cost:{status:'available',complete:true,estimate:cost,currency:'USD'},confirmation:true});
  const items=[config('cheap',.6,1),config('high-quality',.95,1.5),config('subthreshold',.3,.1)];
  const result=costFrontier(items,.4);
  assert.deepEqual(result.frontier.map(c=>c.id),['cheap']);
  assert.deepEqual(result.eligible,['cheap','high-quality']);
  assert.equal(result.frontier[0].independently_confirmed,false);
  assert.equal(result.frontier[0].confirmation,'requires_independent_confirmation');
  const none=costFrontier(items,.99);assert.equal(none.status,'not_reached');assert.equal(none.groups[0].estimate,null);
  const separate=costFrontier([...items,config('other-environment',.9,.5,'other'),config('other-support',.9,.2,'env','unsupported')],.4);
  assert.equal(separate.groups.length,3);
  assert.deepEqual(separate.frontier.map(c=>c.id),['cheap','other-environment','other-support']);
});

test('frontier rejects incomplete cost and separates currencies, even when both pass quality',()=>{
  const common={quality:{status:'available',estimate:1,interval:{status:'available',lower:.9}},scope:{environment_id:'same',task_scope_sha256:fingerprint('same-tasks')}};
  const result=costFrontier([
    {...common,id:'USD',cost:{status:'available',complete:true,estimate:2,currency:'USD'}},
    {...common,id:'EUR',cost:{status:'available',complete:true,estimate:1,currency:'EUR'}},
    {...common,id:'partial',cost:{status:'available',complete:false,estimate:.1,currency:'USD'}},
  ],.8);
  assert.equal(result.groups.length,2);assert.deepEqual(result.eligible,['USD','EUR']);
  assert.ok(result.excluded.some(c=>c.id==='partial'&&/Complete/.test(c.reason)));
});

test('budget intervals preserve shared clusters and pairing; analytical radius uses the whole claim ledger',()=>{
  const p=exampleProtocol({repeats:4});p.policies.analysis={success_budgets:{time_ms:[100],input_tokens:[100]}};freeze(p);
  const episodes=p.pairs.flatMap(pair=>pair.condition_ids.map(condition=>exampleEpisode({condition,caseId:pair.case_id,repeat:pair.repeat,
    attemptInputs:[condition==='candidate'?100:150],successTime:condition==='candidate'?100:200})));
  const analysis=score(p,episodes),point=analysis.conditions[0].metrics.success_by_budget.input_tokens[0],paired=analysis.comparisons[0].success_by_budget.input_tokens[0];
  assert.equal(point.interval.clusters,2);assert.equal(point.case_values[0].planned_repeats,4);
  assert.equal(paired.estimate,1);assert.equal(paired.paired_units.length,12);assert.equal(paired.interval.clusters,2);
  const m=analysis.statistical_policy.simultaneous_claim_count;
  const radius=Math.sqrt(Math.log(2*m/.05)*(.5*.5+.5*.5)/2);
  close(point.interval.radius,radius);close(paired.interval.radius,2*radius);
  assert.equal(m,analysis.statistical_policy.claim_ledger.claims.length);
  const p1=exampleProtocol();p1.policies.analysis=p.policies.analysis;freeze(p1);
  const one=score(p1,exampleEpisodes(p1)).conditions[0].metrics.success_by_budget.time_ms[0];
  close(point.interval.radius,one.interval.radius);
});

test('budget unknown business receives zero credit without failure; missing usage or slots prevents a complete interval',()=>{
  const p=exampleProtocol();p.policies.analysis={success_budgets:{time_ms:[100],input_tokens:[100]}};freeze(p);
  const unknown=score(p,exampleEpisodes(p,{outcome:'unknown'})).conditions[0].metrics.success_by_budget.input_tokens[0];
  assert.equal(unknown.estimate,0);assert.equal(unknown.counts.unknown,3);assert.equal(unknown.counts.fail,0);assert.equal(unknown.interval.status,'available');
  const episodes=exampleEpisodes(p).map(e=>e.identity.condition_id==='candidate'&&e.identity.case_id==='c1'?exampleEpisode({attemptInputs:[null]}):e);
  const partial=score(p,episodes),point=partial.conditions[0].metrics.success_by_budget.input_tokens[0];
  assert.equal(point.estimate,null);assert.equal(point.interval.status,'unavailable');assert.equal(point.counts.success_usage_unknown,1);
  close(point.identification_bounds.lower,.5);close(point.identification_bounds.upper,1);
  const missing=score(p,exampleEpisodes(p).filter(e=>!(e.identity.condition_id==='candidate'&&e.identity.case_id==='c2')));
  const paired=missing.comparisons[0].success_by_budget.time_ms[0];
  assert.equal(paired.estimate,null);assert.equal(paired.interval.status,'unavailable');assert.equal(paired.planned_repeats,3);
});

test('nine transition intervals retain actual unknowns and repeat clusters while missing sides stay unresolved',()=>{
  const states=['pass','fail','unknown'],cases=Array.from({length:9},(_,i)=>({id:'c'+i,family:'f',cluster_id:'k'+Math.floor(i/3),material_id:'m'+i}));
  const p=exampleProtocol({cases,repeats:2});
  const episodes=p.pairs.flatMap(pair=>{const i=Number(pair.case_id.slice(1));return [
    exampleEpisode({condition:'candidate',caseId:pair.case_id,repeat:pair.repeat,outcome:states[i%3]}),
    exampleEpisode({condition:'reference',caseId:pair.case_id,repeat:pair.repeat,outcome:states[Math.floor(i/3)]})];});
  const matrix=score(p,episodes).comparisons[0].version_transition;
  assert.equal(matrix.cells.length,9);assert.equal(matrix.observed_unknown_pairs,10);
  for(const cell of matrix.cells){assert.equal(cell.observed_count,2);close(cell.estimate,1/9);assert.equal(cell.interval.clusters,3);assert.ok(cell.interval.radius>0);}
  const partial=score(p,episodes.filter(e=>!(e.identity.condition_id==='reference'&&e.identity.case_id==='c0'&&e.identity.repeat===0))).comparisons[0].version_transition;
  assert.equal(partial.unresolved_pairs,1);assert.equal(partial.observed_pairs,17);assert.equal(partial.observed_unknown_pairs,10);
  assert.ok(partial.cells.every(c=>c.interval.status==='unavailable'));
  const assigned=partial.cells.find(c=>c.from==='unknown'&&c.to==='pass');
  assert.equal(assigned.count,3);assert.equal(assigned.observed_count,2);assert.equal(assigned.unresolved_assigned_count,1);
  close(partial.cells.reduce((sum,c)=>sum+c.weight,0),1);
});

test('four-cell interactions estimate quality, capped time and cost from common paired units',()=>{
  const p=modelProtocol();p.policies.analysis={resource_bounds:{currency_cost:costBound()}};freeze(p);
  const analysis=score(p,interactionEpisodes(p)),interaction=analysis.model_environment_interaction.comparisons[0];
  close(interaction.metrics.quality.estimate,.5);
  close(interaction.metrics.time.estimate,-450);
  close(interaction.metrics.cost.estimate,-2);
  assert.equal(interaction.metrics.cost.currency,'USD');
  for(const metric of Object.values(interaction.metrics)){assert.equal(metric.interval.status,'available');assert.equal(metric.interval.clusters,2);assert.equal(metric.case_values.length,3);}
  const m=analysis.statistical_policy.simultaneous_claim_count;
  const base=Math.sqrt(Math.log(2*m/.05)*.5/2);
  close(interaction.metrics.quality.interval.radius,4*base);
  close(interaction.metrics.time.interval.radius,4000*base);
  close(interaction.metrics.cost.interval.radius,20*base);
  assert.equal(interaction.confirmation,false);assert.equal(interaction.confirmation_status,'exploratory_only');
});

test('complete currency interaction without a verified bound keeps only its point estimate',()=>{
  const p=modelProtocol(),interaction=score(p,interactionEpisodes(p)).model_environment_interaction.comparisons[0];
  close(interaction.metrics.cost.estimate,-2);assert.equal(interaction.metrics.cost.interval.status,'unavailable');
  assert.match(interaction.metrics.cost.interval.reason,/bound/);assert.equal(interaction.metrics.time.interval.status,'available');
  p.policies.analysis={resource_bounds:{currency_cost:{...costBound(),currency:'EUR'}}};freeze(p);
  assert.equal(score(p,interactionEpisodes(p)).model_environment_interaction.comparisons[0].metrics.cost.interval.status,'unavailable');
});

test('cost intervals reject observed bound violations even when the weighted case mean stays under the bound',()=>{
  const p=modelProtocol();p.policies.analysis={resource_bounds:{currency_cost:costBound()}};freeze(p);
  const episodes=interactionEpisodes(p).map(e=>e.identity.condition_id==='candidate'&&e.identity.case_id==='c2'?
    pricedEpisode({caseId:'c2',cost:10}):e);
  const analysis=score(p,episodes),condition=analysis.conditions[0].metrics.currency_cost;
  assert.ok(condition.estimate<5);assert.equal(condition.interval.status,'unavailable');
  assert.match(analysis.model_environment_interaction.comparisons[0].metrics.cost.interval.reason,/exceeds/);
});

test('mixed currency and missing actual cells cannot become numeric cost or complete four-cell intervals',()=>{
  const p=modelProtocol(),episodes=interactionEpisodes(p);
  const mixed=episodes.map(e=>e.identity.condition_id==='candidate-new'&&e.identity.case_id==='c2'?
    pricedEpisode({condition:'candidate-new',caseId:'c2',cost:4,currency:'EUR'}):e);
  const metric=score(p,mixed).model_environment_interaction.comparisons[0].metrics.cost;
  assert.equal(metric.estimate,null);assert.equal(metric.interval.status,'unavailable');
  const missing=score(p,episodes.slice(1)).model_environment_interaction.comparisons[0];
  assert.equal(missing.metrics.quality.estimate,null);assert.equal(missing.metrics.time.estimate,null);
  assert.equal(missing.paired_units.length,3);assert.ok(missing.paired_units.some(row=>row.episode_ids.includes(null)));
});

test('different four-cell repeat keys or seeds are rejected before global means can conceal mispairing',()=>{
  for(const change of ['repeat','seed']){
    const p=modelProtocol();
    for(const pair of p.pairs)if(pair.id.endsWith('-new'))pair[change]=1;
    freeze(p);const result=score(p,exampleEpisodes(p)).model_environment_interaction;
    assert.equal(result.status,'unavailable');assert.match(result.comparisons[0].reason,change==='repeat'?/case\/repeat/:/seeds/);
  }
});

test('claim family is fixed by planned cells and cutoffs, never by successes, missing data or cost availability',()=>{
  const p=modelProtocol();p.phase='confirmation';freeze(p);
  const full=score(p,interactionEpisodes(p)),missing=score(p,[]),failed=score(p,exampleEpisodes(p,{outcome:'fail'}));
  assert.deepEqual(full.statistical_policy.claim_ledger,missing.statistical_policy.claim_ledger);
  assert.deepEqual(full.statistical_policy.claim_ledger,failed.statistical_policy.claim_ledger);
  assert.equal(full.statistical_policy.claim_ledger.claims.filter(c=>c.kind==='transition').length,18);
  assert.equal(full.statistical_policy.claim_ledger.claims.filter(c=>c.kind==='interaction').length,3);
  assert.equal(full.model_environment_interaction.comparisons[0].confirmation,false);
});

test('currency bound is optional frozen schema and cannot be injected through an analysis-plan override',()=>{
  const p=exampleProtocol();p.policies.analysis={resource_bounds:{currency_cost:costBound()}};freeze(p);
  assert.equal(validateAnalysisPolicy(p).valid,true);
  const plan=createAnalysisPlan(p);plan.resource_bounds.currency_cost.upper=100;
  assert.throws(()=>scoreExperiment({protocol:p,episodes:exampleEpisodes(p),plan}),/frozen protocol expansion/);
  for(const invalid of [{upper:0},{verified:false},{currency:''},{evidence_sha256:'not-a-sha'}]){
    p.policies.analysis.resource_bounds.currency_cost={...costBound(),...invalid};freeze(p);
    assert.equal(validateAnalysisPolicy(p).valid,false);
  }
});

test('quality ratio and percentage remain explicit through the primary result and report without double scaling',()=>{
  const p=exampleProtocol(),episodes=exampleEpisodes(p).map(e=>e.identity.condition_id==='candidate'&&e.identity.case_id==='c2'?exampleEpisode({caseId:'c2',outcome:'fail'}):e);
  const analysis=score(p,episodes),quality=analysis.conditions[0].metrics.verified_quality,entry=evaluateMetric('metric:quality.verified/v1',{analysis,condition_id:'candidate'});
  assert.equal(entry.unit,'percent');close(entry.estimate,75);close(entry.quality_ratio.estimate,.75);close(entry.interval.upper,100*entry.quality_ratio.interval.upper);
  assert.equal(quality.unit,'ratio');close(quality.estimate,.75);assert.equal(quality.score_percent.unit,'percent');close(quality.score_percent.estimate,75);
  close(quality.score_percent.interval.lower,100*quality.interval.lower);close(quality.score_percent.interval.upper,100*quality.interval.upper);
  const tables=reportTables(analysis);assert.equal(tables.conditions[0].score_percent,75);assert.ok(tables.budget_curves.length>0);
  assert.ok(tables.transitions.every(row=>typeof row.interval_status==='string'));
  assert.match(renderAnalysisMarkdown(analysis),/75\.0%/);assert.doesNotMatch(renderAnalysisMarkdown(analysis),/7500/);
  assert.equal(ANALYSIS_VERSION,'1.1.0');assert.equal(analysis.metric_version,'1.0.0');
});


test('score frontier keeps different frozen unsupported scopes in separate groups',()=>{
  const p=modelProtocol();p.policies.decision.absolute_quality_required=0;
  p.assessments=[{id:'unsupported-assessment',condition_id:'candidate-new',case_id:'c1',repeat:1,seed:0,expected_support:'unsupported'}];freeze(p);
  const result=score(p,exampleEpisodes(p,{cost:1})).cost_frontier;
  assert.equal(result.groups.length,3);
  const candidateGroups=result.groups.filter(group=>group.scope.environment_id==='candidate-environment');
  assert.equal(candidateGroups.length,2);
  assert.notEqual(candidateGroups[0].scope.task_scope_sha256,candidateGroups[1].scope.task_scope_sha256);
  assert.ok(candidateGroups.some(group=>group.scope.planned_units.some(unit=>unit.expected_support==='unsupported')));
  assert.ok(result.frontier.every(winner=>winner.cost_advantage_claim===false));
});
