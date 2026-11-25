import assert from 'node:assert/strict';
import {fingerprint,validateProtocol,validateAnalysisPolicy} from '../protocol.mjs';
import {scheduleProtocol} from '../campaign-selection.mjs';
import {ANALYSIS_VERSION,createAnalysisPlan,prepareAnalysisRecords,summarizeAnalysisRecords,inferenceClaims,scoreExperiment} from './compare.mjs';
import {INTERVAL_METHOD,BOUNDARY_METHOD,MULTIPLICITY_METHOD} from './statistics.mjs';

export const STUDY_VERSION='1.0.0';
const clone=value=>structuredClone(value);
const sorted=values=>[...values].sort();
const same=(a,b,message)=>assert.equal(fingerprint(a),fingerprint(b),message);
const names=(value,expected)=>assert.deepEqual(sorted(Object.keys(value)),sorted(expected),'Study record fields changed');
const id=value=>assert.ok(typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value),'Use a stable study identifier');
const unique=(values,message)=>assert.equal(new Set(values).size,values.length,message);
const timestamp=value=>assert.ok(typeof value==='string'&&Number.isFinite(Date.parse(value)),'Use an explicit registration timestamp');
const digest=value=>assert.match(value,/^[a-f0-9]{64}$/);
const seal=(value,field)=>({...value,[field]:fingerprint({...value,[field]:null})});
const verify=(value,field)=>same(value[field],fingerprint({...value,[field]:null}),'Frozen study identity changed');
const clean=value=>Array.isArray(value)?value.map(clean):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).filter(([key])=>!key.startsWith('_')).map(([key,item])=>[key,clean(item)])):value;

/** Material-specific catalogs, paths, config and prompts remain in each bound manifest.
 * This projection freezes the product, runtime, tools, observable contracts and policy. */
export function studyConditionProfile(protocol,conditionId) {
  const condition=protocol.conditions.find(row=>row.id===conditionId);assert.ok(condition,'Unknown panel condition');
  const environment=protocol.environments.find(row=>row.id===condition.environment_id);assert.ok(environment,'Unknown panel environment');
  const model=protocol.models.find(row=>row.id===condition.model_id),budget=protocol.policies.budgets.find(row=>row.id===condition.budget_id);
  assert.ok(model&&budget,'Missing panel model or resource policy');
  return clone({model,environment:{build:environment.build,runtime:environment.runtime,paired_environment_id:environment.paired_environment_id,
    pi:{mode:environment.pi.mode,entry_kind:environment.pi.entry_kind??null,entry:environment.pi.entry,
      extensions:environment.pi.extensions.map(({id,role,sha256})=>({id,role,sha256})),tools:environment.pi.tools,active_tools:environment.pi.active_tools,
      return_contract_sha256:environment.pi.return_contract_sha256,error_contract_sha256:environment.pi.error_contract_sha256},policies:environment.policies},
    budget:{mode:budget.mode??'bounded',episode:budget.episode},evidence:protocol.policies.evidence});
}

function analysisContext(series,confidence,{cases=series.cases,records=[],groups}={}) {
  const caseIds=cases.map(c=>c.id),taskHash=fingerprint(cases),models=[...new Map(series.conditions.map(c=>[c.profile.model.id,c.profile.model])).values()];
  const budgets=[{id:'study-budget',...clone(series.conditions[0].profile.budget)}];
  // These are analysis-role keys, not replacement environment manifests.
  const conditions=series.conditions.map(c=>({id:c.id,environment_id:c.role,environment_sha256:fingerprint(c.profile.environment),
    model_id:c.profile.model.id,case_ids:caseIds,budget_id:'study-budget',code_mode:c.profile.environment.policies.code_mode,
    corpus_id:series.id,corpus_sha256:taskHash,initial_state_sha256:taskHash,authorization_sha256:taskHash}));
  const statistics={confidence,interval_method:INTERVAL_METHOD,boundary_method:BOUNDARY_METHOD,multiple_comparisons:MULTIPLICITY_METHOD,
    family_weights:series.family_weights,cluster_unit:'cluster_id',case_aggregation:'mean_repeats'};
  const protocol={id:series.id,phase:series.phase,conditions,models,corpus:{cases},metrics:{primary:series.primary_metrics},
    policies:{statistics,budgets,analysis:series.analysis,decision:{mode:'descriptive'}},
    pairs:series.comparisons.map((p,index)=>({id:'comparison-'+index,condition_ids:[p.candidate,p.reference]}))};
  const plan={confirmation:series.phase==='confirmation',resource_bounds:series.analysis.resource_bounds??{},
    capped_time_horizon_ms:series.analysis.capped_time_horizon_ms,success_budgets:series.analysis.success_budgets,
    interactions:series.analysis.interactions};
  const comparisons=groups??series.comparisons.map(p=>({aId:p.candidate,bId:p.reference,pairs:[]}));
  const specifications=Object.fromEntries(['model_environment','code_mode'].map(kind=>[kind,series.analysis.interactions.filter(i=>i.kind===kind)]));
  return {protocol,plan,maps:{cases:new Map(cases.map(c=>[c.id,c])),conditions:new Map(conditions.map(c=>[c.id,c]))},records,
    activeConditions:conditions,groups:comparisons,specifications,
    claimPolicy:inferenceClaims(protocol,plan,conditions,comparisons,Object.values(specifications).flat())};
}

function validateSeries(series,confidence) {
  names(series,['id','phase','conditions','comparisons','cases','repetitions','ordering_seed','family_weights','analysis','primary_metrics','panels']);
  id(series.id);assert.ok(['pilot','confirmation','regression'].includes(series.phase));
  assert.ok(Number.isSafeInteger(series.repetitions)&&series.repetitions>0);assert.ok(Number.isSafeInteger(series.ordering_seed));
  for(const key of ['conditions','comparisons','cases','family_weights','primary_metrics','panels'])assert.ok(Array.isArray(series[key])&&series[key].length,'Empty '+key);
  unique(series.conditions.map(c=>c.id),'Duplicate logical condition');unique(series.cases.map(c=>c.id),'Duplicate study case');unique(series.panels.map(p=>p.id),'Duplicate panel');
  const roles=new Map(),models=new Map(),conditions=new Map(series.conditions.map(c=>[c.id,c]));
  for(const c of series.conditions) {
    names(c,['id','role','profile']);id(c.id);id(c.role);
    names(c.profile,['model','environment','budget','evidence']);
    assert.ok(c.profile.model.id&&c.profile.environment.build&&c.profile.environment.runtime&&c.profile.environment.pi);
    assert.ok(['bounded','unbounded'].includes(c.profile.budget.mode));
    if(roles.has(c.role))same(roles.get(c.role),c.profile.environment,'One role changes product/runtime/tools across models');
    roles.set(c.role,c.profile.environment);
    if(models.has(c.profile.model.id))same(models.get(c.profile.model.id),c.profile.model,'One model ID has conflicting conditions');
    models.set(c.profile.model.id,c.profile.model);
    same(c.profile.budget,series.conditions[0].profile.budget,'A series cannot mix resource modes or episode conditions');
    same(c.profile.evidence,series.conditions[0].profile.evidence,'A series cannot mix observer or scoring semantics');
  }
  const used=[];
  for(const p of series.comparisons) {
    names(p,['candidate','reference']);assert.notEqual(p.candidate,p.reference);
    const a=conditions.get(p.candidate),b=conditions.get(p.reference);assert.ok(a&&b,'Unknown comparison condition');
    same(a.profile.model,b.profile.model,'A within-model comparison changes its model');used.push(a.id,b.id);
  }
  same(sorted(used),sorted([...conditions.keys()]),'Each condition belongs to one complete oriented comparison');
  for(const c of series.cases) {names(c,['id','family','cluster_id']);id(c.id);id(c.family);id(c.cluster_id);}
  const clusters=new Map();
  for(const c of series.cases){if(clusters.has(c.cluster_id))assert.equal(clusters.get(c.cluster_id),c.family,'A cluster spans inconsistent families');clusters.set(c.cluster_id,c.family);}
  unique(series.family_weights.map(w=>w.family),'Duplicate family weight');
  for(const w of series.family_weights){names(w,['family','weight']);assert.ok(Number.isFinite(w.weight)&&w.weight>0);}
  assert.ok(Math.abs(series.family_weights.reduce((n,w)=>n+w.weight,0)-1)<1e-9);
  same(sorted(series.family_weights.map(w=>w.family)),sorted([...new Set(series.cases.map(c=>c.family))]),'Global weights must cover every family');
  const assigned=[];
  for(const panel of series.panels){names(panel,['id','case_ids']);id(panel.id);assert.ok(panel.case_ids.length);assigned.push(...panel.case_ids);}
  same(sorted(assigned),sorted(series.cases.map(c=>c.id)),'Panels must partition the complete case roster, without duplicated repeats');
  names(series.analysis,['capped_time_horizon_ms','success_budgets','resource_bounds','interactions']);
  assert.ok(Number.isFinite(series.analysis.capped_time_horizon_ms)&&series.analysis.capped_time_horizon_ms>0);
  same(series.analysis.resource_bounds,{},'Study v1 registers no total-input or currency population bound; those intervals remain unavailable');
  unique(series.primary_metrics,'Duplicate primary metric');
  const context=analysisContext(series,confidence),check=validateAnalysisPolicy(context.protocol);
  assert.ok(check.valid,JSON.stringify(check.errors));
  return context;
}

function claimLedger(series,confidence) {
  const claims=[];let count=0;
  for(const item of series) {
    const ledger=analysisContext(item,confidence).claimPolicy;
    // Conservative allocation includes local panel reports and series aggregates,
    // even when one panel happens to give an identical aggregate claim.
    for(const namespace of [...item.panels.map(p=>'panel/'+item.id+'/'+p.id),'series/'+item.id]) {
      claims.push(...ledger.claims.map(c=>({...c,id:namespace+'/'+c.id})));
      for(let n=ledger.claims.length;n<ledger.count;n++)claims.push({id:namespace+'/primary-floor/'+n,kind:'reserved-primary-floor',origin:'registered-analysis'});
      count+=ledger.count;
    }
  }
  unique(claims.map(c=>c.id),'Duplicate study claim');assert.equal(count,claims.length);
  return {count,claims,allocation:'Bonferroni over every registered panel and series claim; ratio allocations split between both bounded means.',
    unavailable_claims_retained:true,identical_single_panel_claims_deduplicated:false};
}

/** Freeze sample, weights, profiles and inference before revealing confirmation material.
 * No panel contents, results, filesystem or provider are read by this function. */
export function createStudyDesign({id:studyId,registeredAt,confidence=.95,series,commitments=[]}) {
  id(studyId);timestamp(registeredAt);assert.ok(confidence>0&&confidence<1);
  assert.ok(Array.isArray(series)&&series.length);unique(series.map(s=>s.id),'Duplicate series');
  series.forEach(s=>validateSeries(s,confidence));
  for(const c of commitments){names(c,['id','sha256']);id(c.id);digest(c.sha256);}
  unique(commitments.map(c=>c.id),'Duplicate prior commitment');
  return seal({schema_version:1,kind:'benchmark-study-design',version:STUDY_VERSION,id:studyId,status:'frozen',registered_at:registeredAt,
    confidence,series:clone(series),commitments:clone(commitments),claim_ledger:claimLedger(series,confidence),
    interpretation:'Prespecified weighted mixture of distinct panel environments; descriptive study, not an execution authorization or unseen-material certificate.',
    design_sha256:null},'design_sha256');
}

export function validateStudyDesign(design) {
  verify(design,'design_sha256');
  same(design,createStudyDesign({id:design.id,registeredAt:design.registered_at,confidence:design.confidence,series:design.series,commitments:design.commitments}),
    'Study design differs from its canonical declaration');return design;
}

function validatePanelPlan(plan) {
  assert.equal(plan.kind,'benchmark-batch-plan');assert.equal(plan.version,1);assert.equal(plan.id,plan.protocol.id);
  assert.equal(plan.plan_sha256,fingerprint({...plan,plan_sha256:null}),'Panel execution plan changed');
  const checked=validateProtocol(plan.protocol,{stage:'execute'});assert.ok(checked.valid,JSON.stringify(checked.errors));
  same(plan.slots,scheduleProtocol(plan.protocol),'Panel dispatch schedule changed');
  // This validates scientific identity only. It never activates a campaign or reads credentials.
  return prepareAnalysisRecords({protocol:plan.protocol,episodes:[]});
}

function panelBinding(design,series,panel,entry,registeredAt) {
  names(entry,['series_id','panel_id','plan','condition_map']);assert.equal(entry.series_id,series.id);assert.equal(entry.panel_id,panel.id);
  const {plan,condition_map:mapping}=entry,context=validatePanelPlan(plan),protocol=plan.protocol;
  timestamp(plan.registered_at);assert.ok(Date.parse(plan.registered_at)>=Date.parse(design.registered_at),'Panel was frozen before this study design');
  assert.ok(Date.parse(plan.registered_at)<=Date.parse(registeredAt),'Binding precedes the panel registration');
  assert.equal(protocol.phase,series.phase,'Panel changes the registered phase');
  assert.equal(protocol.policies.statistics.confidence,design.confidence,'Panel confidence differs from study allocation');
  same(protocol.metrics.primary,series.primary_metrics,'Panel changes the primary metric family');
  same(sorted(Object.keys(mapping)),sorted(protocol.conditions.map(c=>c.id)),'Every physical condition must be mapped');
  same(sorted(Object.values(mapping)),sorted(series.conditions.map(c=>c.id)),'Logical conditions must be a bijection');
  const expectedCases=series.cases.filter(c=>panel.case_ids.includes(c.id));
  same(protocol.corpus.cases.map(({id,family,cluster_id})=>({id,family,cluster_id})).sort((a,b)=>a.id.localeCompare(b.id)),
    [...expectedCases].sort((a,b)=>a.id.localeCompare(b.id)),'Panel changes cases, families or clusters');
  for(const condition of protocol.conditions) {
    const expected=series.conditions.find(c=>c.id===mapping[condition.id]);
    same(studyConditionProfile(protocol,condition.id),expected.profile,'Panel changes the registered condition profile');
    same(sorted(condition.case_ids),sorted(panel.case_ids),'Panel omits a condition case');
  }
  assert.equal(protocol.assessments.length,0,'Study v1 uses complete paired common-business cells; unsupported assessments remain separate');
  const expectedUnits=[];
  for(const c of panel.case_ids)for(let repeat=0;repeat<series.repetitions;repeat++)for(const pair of series.comparisons)
    expectedUnits.push({case_id:c,repeat,seed:series.ordering_seed+repeat,condition_ids:[pair.candidate,pair.reference]});
  const actualUnits=protocol.pairs.map(p=>({case_id:p.case_id,repeat:p.repeat,seed:p.seed,condition_ids:p.condition_ids.map(c=>mapping[c])}));
  const order=rows=>rows.map(fingerprint).sort();same(order(actualUnits),order(expectedUnits),'Panel changes the full planned pair/repeat/seed denominator');
  const mappedAnalysis=clone(protocol.policies.analysis??{});
  mappedAnalysis.resource_bounds??={};mappedAnalysis.interactions??=[];
  mappedAnalysis.interactions=mappedAnalysis.interactions.map(i=>({...i,condition_ids:i.condition_ids.map(c=>mapping[c]),
    ...(i.environment_pairs?{environment_pairs:i.condition_ids.reduce((pairs,c,index)=>{if(index%2===0)pairs.push([]);pairs.at(-1).push(series.conditions.find(x=>x.id===mapping[c]).role);return pairs;},[])}:{})}));
  same(mappedAnalysis,series.analysis,'Panel changes the registered horizon, cutoffs, bounds or interactions');
  assert.equal(context.claimPolicy.count,analysisContext(series,design.confidence).claimPolicy.count,'Panel changes the claim family');
  const preview=summarizeAnalysisRecords(context);
  for(const key of ['model_environment_interaction','code_mode_interaction'])for(const interaction of preview[key].comparisons)
    assert.equal(interaction.reason,undefined,'Panel interaction does not have a matched common scope: '+interaction.reason);
  return {series_id:series.id,panel_id:panel.id,plan_sha256:plan.plan_sha256,protocol_sha256:protocol.protocol_sha256,
    analysis_plan_sha256:fingerprint(createAnalysisPlan(protocol)),condition_map:clone(mapping),
    conditions:protocol.conditions.map(c=>({condition_id:c.id,logical_condition_id:mapping[c.id],environment_id:c.environment_id,
      environment_sha256:c.environment_sha256,catalog_sha256:protocol.environments.find(e=>e.id===c.environment_id).pi.catalog_sha256,
      model_id:c.model_id,corpus_sha256:c.corpus_sha256,initial_state_sha256:c.initial_state_sha256,authorization_sha256:c.authorization_sha256})),
    planned_slots:context.records.length,dispatch_slots:plan.slots.length};
}

/** Bind exact zero-model panel plans after material preparation, before dispatch.
 * The prior design remains unchanged and never gains outcomes during binding. */
export function bindStudyPlan({design,panels,registeredAt}) {
  validateStudyDesign(design);timestamp(registeredAt);assert.ok(Date.parse(registeredAt)>=Date.parse(design.registered_at));
  assert.ok(Array.isArray(panels));unique(panels.map(p=>p.series_id+'/'+p.panel_id),'Duplicate panel binding');
  unique(panels.map(p=>p.plan.id),'One physical plan cannot be counted in two study panels');
  const bindings=[];
  for(const series of design.series)for(const panel of series.panels) {
    const entry=panels.find(p=>p.series_id===series.id&&p.panel_id===panel.id);assert.ok(entry,'Missing planned panel binding');
    bindings.push(panelBinding(design,series,panel,entry,registeredAt));
  }
  assert.equal(bindings.length,panels.length,'Unplanned panel binding');
  return seal({schema_version:1,kind:'benchmark-study-plan',version:STUDY_VERSION,id:design.id,status:'frozen',registered_at:registeredAt,
    design:clone(design),panels:bindings,planned_slots:bindings.reduce((n,p)=>n+p.planned_slots,0),plan_sha256:null},'plan_sha256');
}

function joinedRecords(design,series,verified) {
  const records=[],groups=new Map(series.comparisons.map(p=>[p.candidate+'\0'+p.reference,{aId:p.candidate,bId:p.reference,pairs:[]}]));
  const materialClusters=new Map();
  for(const panel of series.panels) {
    const value=verified.find(p=>p.binding.series_id===series.id&&p.binding.panel_id===panel.id),mapping=value.binding.condition_map;
    const byOriginal=new Map();
    for(const c of value.plan.protocol.corpus.cases) {
      if(materialClusters.has(c.material_id))assert.equal(materialClusters.get(c.material_id),c.cluster_id,'One material cannot acquire a second independent cluster');
      materialClusters.set(c.material_id,c.cluster_id);
    }
    for(const original of value.context.records) {
      const record={...original,slot:{...original.slot,id:panel.id+'/'+original.slot.id,condition_id:mapping[original.slot.condition_id],
        pair_id:panel.id+'/'+original.slot.pair_id},panel_id:panel.id,original_slot:original.slot};
      records.push(record);byOriginal.set(original,record);
    }
    for(const group of value.context.groups) {
      const target=groups.get(mapping[group.aId]+'\0'+mapping[group.bId]);assert.ok(target,'Panel comparison is not registered');
      target.pairs.push(...group.pairs.map(p=>({...p,id:panel.id+'/'+p.id,a:byOriginal.get(p.a),b:byOriginal.get(p.b)})));
    }
  }
  return analysisContext(series,design.confidence,{records,groups:[...groups.values()]});
}

function exposedResult(result,conditions,members) {
  const value=clean(result);
  value.conditions=value.conditions.map(c=>{
    const {environment_id,...metrics}=c;
    return {...metrics,analysis_role:conditions.find(x=>x.id===c.condition_id).role,
      panel_conditions:members.filter(m=>m.logical_condition_id===c.condition_id)};
  });
  return value;
}

/** Every supplied panel analysis must equal a fresh canonical replay of its own inputs.
 * All global inference then uses the original episodes and the registered full ledger. */
export function scoreStudy({plan,panels}) {
  verify(plan,'plan_sha256');validateStudyDesign(plan.design);
  const supplied=panels.map(p=>({series_id:p.series_id,panel_id:p.panel_id,plan:p.plan,condition_map:plan.panels.find(b=>b.series_id===p.series_id&&b.panel_id===p.panel_id)?.condition_map}));
  same(plan,bindStudyPlan({design:plan.design,panels:supplied,registeredAt:plan.registered_at}),'Study bindings changed');
  const verified=[],allEpisodes=new Map(),runs=new Set();
  for(const input of panels) {
    const binding=plan.panels.find(p=>p.series_id===input.series_id&&p.panel_id===input.panel_id);
    const expected=scoreExperiment({protocol:input.plan.protocol,episodes:input.episodes});
    same(expected,input.analysis,'Panel analysis does not reproduce from its original protocol and episodes');
    for(const e of input.episodes) {
      const existing=allEpisodes.get(e.identity.episode_id);
      if(existing){same(existing.episode,e,'Conflicting episode view');assert.equal(existing.panel,binding.panel_id,'One episode cannot enter multiple panels');continue;}
      assert.ok(!runs.has(e.identity.run_id),'One physical run cannot become multiple study observations');runs.add(e.identity.run_id);
      allEpisodes.set(e.identity.episode_id,{episode:e,panel:binding.panel_id,series:binding.series_id});
    }
    const context=prepareAnalysisRecords({protocol:input.plan.protocol,episodes:input.episodes});
    verified.push({...input,binding,context,canonical_analysis_sha256:expected.analysis_sha256});
  }
  const count=plan.design.claim_ledger.count;
  const panelResults=verified.map(v=>{
    const context={...v.context,protocol:{...v.context.protocol,policies:{...v.context.protocol.policies,decision:{mode:'descriptive'}}}};
    return {series_id:v.series_id,panel_id:v.panel_id,plan_sha256:v.plan.plan_sha256,
      original_analysis_sha256:v.canonical_analysis_sha256,interval_allocation:'study-wide',
      analysis:clean(summarizeAnalysisRecords(context,{comparisons:count})),conditions:clone(v.binding.conditions)};
  });
  const seriesResults=plan.design.series.map(series=>{
    const context=joinedRecords(plan.design,series,verified),raw=summarizeAnalysisRecords(context,{comparisons:count});
    const members=plan.panels.filter(p=>p.series_id===series.id).flatMap(p=>p.conditions.map(c=>({...c,panel_id:p.panel_id})));
    return {id:series.id,estimand:'Registered fixed-family mixture of the listed distinct panel environments',
      analysis:exposedResult(raw,series.conditions,members),
      completeness:{planned_slots:context.records.length,valid_slots:context.records.filter(r=>r.episode).length,
        unresolved_slots:context.records.filter(r=>!r.episode).map(r=>({panel_id:r.panel_id,original_slot:clone(r.original_slot),logical_condition_id:r.slot.condition_id,
          run_ids:r.runs.map(e=>e.identity.run_id)}))}};
  });
  const episodes=[...allEpisodes.values()].map(v=>v.episode);
  const incomplete=episodes.filter(e=>['input_total','output_total'].some(k=>e.measurements[k].value.status!=='known')||e.measurements.actual_attempts.status!=='known');
  const total=get=>episodes.every(e=>get(e).status==='known')?episodes.reduce((n,e)=>n+get(e).value,0):null;
  const costs=episodes.filter(e=>e.measurements.cost.status==='known').map(e=>e.measurements.cost.value);
  const currencies=sorted([...new Set(costs.map(c=>c.currency))]);
  const costLedger={actual_runs:episodes.length,invalid_runs:episodes.filter(e=>e.admission.status==='invalid').length,
    known_actual_attempts:episodes.reduce((n,e)=>n+e.measurements.known_actual_attempts,0),
    known_input_subtotal:episodes.reduce((n,e)=>n+e.measurements.input_total.known_subtotal,0),
    known_output_subtotal:episodes.reduce((n,e)=>n+e.measurements.output_total.known_subtotal,0),
    usage_incomplete_run_ids:incomplete.map(e=>e.identity.run_id),complete_actual_attempts:total(e=>e.measurements.actual_attempts),
    complete_input_total:total(e=>e.measurements.input_total.value),complete_output_total:total(e=>e.measurements.output_total.value),
    known_duration_ms:episodes.reduce((n,e)=>n+(e.timing.duration_ms.status==='known'?e.timing.duration_ms.value:0),0),
    complete_duration_ms:total(e=>e.timing.duration_ms),
    known_currency_subtotals:currencies.map(currency=>({currency,amount:costs.filter(c=>c.currency===currency).reduce((n,c)=>n+c.amount,0)})),
    monetary_incomplete_run_ids:episodes.filter(e=>e.measurements.cost.status!=='known').map(e=>e.identity.run_id),
    complete_currency_totals:costs.length===episodes.length?currencies.map(currency=>({currency,amount:costs.filter(c=>c.currency===currency).reduce((n,c)=>n+c.amount,0)})):null,
    invalid:verified.flatMap(p=>p.analysis.cost_ledger.invalid.map(row=>({...clone(row),series_id:p.series_id,panel_id:p.panel_id}))),
    accounting_scope:'All retained actual runs, including invalid originals and linked replacements. Not a planned quality denominator.'};
  return seal({schema_version:1,kind:'benchmark-study-analysis',version:STUDY_VERSION,analysis_version:ANALYSIS_VERSION,
    study_id:plan.id,study_plan_sha256:plan.plan_sha256,design_sha256:plan.design.design_sha256,
    inference:{confidence:plan.design.confidence,claim_ledger:clone(plan.design.claim_ledger),interval_method:INTERVAL_METHOD,
      cluster_unit:'Original cluster_id across panels; cases and repeats stay nested',decision:'descriptive',cost_frontier:'not_computed'},
    panels:panelResults,series:seriesResults,cost_ledger:costLedger,
    episode_refs:[...allEpisodes.values()].map(({episode,panel,series})=>({series_id:series,panel_id:panel,episode_id:episode.identity.episode_id,
      run_id:episode.identity.run_id,episode_sha256:episode.episode_sha256})),
    limitations:['Binding verifies scientific identity, not dispatch authorization or whether an author saw confirmation material.',
      'Original panel analyses remain unchanged. Every interval shown here uses the full registered study claim count.',
      'Invalid-only and missing slots retain the fixed denominator. Valid unknown outcomes earn no success credit and remain unknown.',
      'No input/currency population bound is invented from observed maxima or unbounded execution.',
      'A wider or inconclusive interval is a valid result. Repeats, panels and new labels do not prove 3pp noninferiority.'],analysis_sha256:null},'analysis_sha256');
}
