import { fingerprint, validateAnalysisPolicy } from '../protocol.mjs';
import { clusterInterval, differenceInterval, ratioInterval, weightedMean, weightedQuantile,
  INTERVAL_METHOD, BOUNDARY_METHOD, MULTIPLICITY_METHOD } from './statistics.mjs';

export const ANALYSIS_VERSION = '1.0.0';
const keyFor = value => [value.condition_id,value.case_id,value.repeat].join('\u0000');
const present = fact => fact?.status === 'known' && fact.precision !== 'estimated' ? fact.value : null;
const mean = values => values.reduce((n,v)=>n+v,0)/values.length;
const statusValue = (value, extra = {}) => value === null ? {status:'unknown',estimate:null,...extra} : {status:'available',estimate:value,...extra};

export function createAnalysisPlan(protocol) {
  const policyCheck = validateAnalysisPolicy(protocol);
  if (!policyCheck.valid) throw new Error('Invalid preregistered analysis policy: ' + JSON.stringify(policyCheck.errors));
  const policy = protocol.policies.analysis ?? {};
  const slots = new Map();
  for (const pair of protocol.pairs ?? []) for (const condition_id of pair.condition_ids) {
    const slot = { id: pair.id + '/' + condition_id, pair_id: pair.id, condition_id,
      case_id: pair.case_id, repeat: pair.repeat, seed: pair.seed, expected_support:'supported' };
    const key = keyFor(slot), prior = slots.get(key);
    if (prior && prior.seed !== slot.seed) throw new Error('Conflicting seeds for one planned unit');
    if (!prior) slots.set(key,slot);
  }
  for (const assessment of protocol.assessments ?? []) {
    const slot = { ...assessment, pair_id:null };
    if (slots.has(keyFor(slot))) throw new Error('Assessment duplicates a paired slot');
    slots.set(keyFor(slot),slot);
  }
  return {schema_version:1,id:protocol.id + '/analysis-plan',protocol_sha256:protocol.protocol_sha256,
    slots:[...slots.values()],confirmation:protocol.phase === 'confirmation',
    resource_bounds:structuredClone(policy.resource_bounds ?? {}),
    ...(policy.success_budgets ? {success_budgets:structuredClone(policy.success_budgets)} : {}),
    ...(policy.interactions ? {interactions:structuredClone(policy.interactions)} : {})};
}
function validatePlan(protocol, plan) {
  if (fingerprint(plan) !== fingerprint(createAnalysisPlan(protocol)))
    throw new Error('Analysis plan must match the frozen protocol expansion, including every slot, support, confirmation and registered policy');
  const cases = new Map(protocol.corpus.cases.map(c=>[c.id,c]));
  const conditions = new Map(protocol.conditions.map(c=>[c.id,c]));
  if (!Array.isArray(plan.slots) || !plan.slots.length) throw new Error('Analysis needs an explicit nonempty batch plan');
  if (plan.protocol_sha256 && plan.protocol_sha256 !== protocol.protocol_sha256) throw new Error('Plan belongs to another protocol');
  const ids=new Set(),keys=new Set();
  for (const slot of plan.slots) {
    if (typeof slot.id !== 'string' || !slot.id || ids.has(slot.id) || keys.has(keyFor(slot))) throw new Error('Plan slot IDs and units must be unique');
    ids.add(slot.id);keys.add(keyFor(slot));
    if (!cases.has(slot.case_id) || !conditions.has(slot.condition_id) || !conditions.get(slot.condition_id).case_ids.includes(slot.case_id) ||
      !Number.isSafeInteger(slot.repeat) || slot.repeat<0) throw new Error('Plan contains an undeclared case, condition or repeat');
  }
  return {cases,conditions};
}
function caseRows(records, caseMap, familyWeights, valueOf, { missingAs = null } = {}) {
  const grouped=new Map();
  for(const record of records) {
    if(record.slot.expected_support==='unsupported') continue;
    const info=caseMap.get(record.slot.case_id);
    if(!grouped.has(info.id)) grouped.set(info.id,{info,records:[]});
    grouped.get(info.id).records.push(record);
  }
  if (!grouped.size) return {rows:[],complete:false,estimate:null};
  const familyCounts=new Map();
  for(const {info} of grouped.values()) familyCounts.set(info.family,(familyCounts.get(info.family)??0)+1);
  const activeWeights=familyWeights.filter(f=>familyCounts.has(f.family));
  if(activeWeights.length!==familyWeights.length || [...familyCounts.keys()].some(f=>!familyWeights.some(w=>w.family===f)))
    throw new Error('Frozen family weights must exactly cover this batch condition; never drop or renormalize an absent family');
  if(Math.abs(familyWeights.reduce((sum,f)=>sum+f.weight,0)-1)>1e-9) throw new Error('Frozen family weights must sum to one');
  let complete=true;
  const rows=[...grouped.values()].sort((a,b)=>a.info.id.localeCompare(b.info.id)).map(({info,records:items})=>{
    const values=items.map(valueOf);
    if(values.some(value=>value===null)) complete=false;
    const value=values.some(value=>value===null) && missingAs===null ? null : mean(values.map(v=>v===null?missingAs:v));
    return {case_id:info.id,family:info.family,cluster_id:info.cluster_id,
      weight:familyWeights.find(f=>f.family===info.family).weight/familyCounts.get(info.family),value,
      planned_repeats:items.length,known_repeats:values.filter(v=>v!==null).length};
  });
  return {rows,complete,estimate:complete && rows.length?weightedMean(rows):null};
}
function resource(records, maps, weights, get) {
  const result=caseRows(records,maps.cases,weights,r=>r.episode?get(r.episode):null);
  return {...statusValue(result.estimate),complete:result.complete,case_values:result.rows};
}
function intervalFor(resource, options) {
  return resource.complete && resource.rows.length ? clusterInterval(resource.rows,options) : {status:'unavailable',reason:'Incomplete fixed batch'};
}
function outcomeFor(record) {
  if(!record.episode || record.episode.result.outcome==='not_applicable') return null;
  return record.episode.result.outcome;
}
const qualityValue=r=>outcomeFor(r)===null?null:outcomeFor(r)==='pass'?1:0;
const failureValue=r=>outcomeFor(r)===null?null:outcomeFor(r)==='fail'?1:0;
const coverageValue=r=>outcomeFor(r)===null?null:['pass','fail'].includes(outcomeFor(r))?1:0;
const upperValue=r=>outcomeFor(r)===null?null:outcomeFor(r)==='fail'?0:1;

function metricsForCondition(condition, records, protocol, plan, maps, comparisons) {
  const weights=protocol.policies.statistics.family_weights;
  const confidence=protocol.policies.statistics.confidence;
  const quality=caseRows(records,maps.cases,weights,qualityValue);
  const planned=caseRows(records,maps.cases,weights,qualityValue,{missingAs:0});
  const failure=caseRows(records,maps.cases,weights,failureValue);
  const coverage=caseRows(records,maps.cases,weights,coverageValue);
  const possible=caseRows(records,maps.cases,weights,upperValue);
  const unassisted=caseRows(records,maps.cases,weights,r=>r.episode&&outcomeFor(r)!==null?r.episode.result.unassisted_success===true?1:0:null);
  const counts={pass:0,fail:0,unknown:0,unsupported:0,unresolved:0,invalid_runs:0,planned:records.length,valid:0};
  for(const record of records) {
    counts.invalid_runs+=record.runs.filter(e=>e.admission.status==='invalid').length;
    if(!record.episode)counts.unresolved++;
    else if(record.episode.result.outcome==='not_applicable')counts.unsupported++;
    else {counts[record.episode.result.outcome]++;counts.valid++;}
  }
  const validDenominator=counts.valid;
  const qInterval=intervalFor(quality,{confidence,comparisons});
  const uInterval=intervalFor(unassisted,{confidence,comparisons});
  const rawRatios={verified_quality:validDenominator?counts.pass/validDenominator:null,
    known_failure:validDenominator?counts.fail/validDenominator:null,
    evidence_coverage:validDenominator?(counts.pass+counts.fail)/validDenominator:null,
    identification_bounds:validDenominator?[counts.pass/validDenominator,(counts.pass+counts.unknown)/validDenominator]:null};
  const inputFirst=resource(records,maps,weights,e=>present(e.measurements.input_first));
  const inputPeak=resource(records,maps,weights,e=>present(e.measurements.input_peak));
  const inputTotal=resource(records,maps,weights,e=>present(e.measurements.input_total.value));
  const outputTotal=resource(records,maps,weights,e=>present(e.measurements.output_total.value));
  const rawTime=resource(records,maps,weights,e=>present(e.timing.duration_ms));
  const budget=protocol.policies.budgets.find(b=>b.id===condition.budget_id);
  const tau=budget?.episode.max_duration_ms;
  if(!Number.isFinite(tau)||tau<=0)throw new Error('Capped-time analysis requires the preregistered positive episode duration');
  const capped=r=>{
    if(!r.episode||outcomeFor(r)===null)return null;
    if(r.episode.result.outcome!=='pass')return tau;
    const t=present(r.episode.timing.time_to_success_ms);
    return t===null?null:Math.min(t,tau);
  };
  const cappedRows=caseRows(records,maps.cases,weights,capped);
  const within=(r,b)=>{
    if(!r.episode||outcomeFor(r)===null)return null;
    if(r.episode.result.outcome!=='pass')return 0;
    const t=present(r.episode.timing.time_to_success_ms);
    return t===null?null:t<=b?1:0;
  };
  const successAtTau=caseRows(records,maps.cases,weights,r=>within(r,tau));
  let successP95={status:'unknown',value_ms:null,denominator:'all valid planned episodes'};
  if(successAtTau.complete&&successAtTau.estimate<0.95)successP95={status:'not_reached',value_ms:null,denominator:'all valid planned episodes'};
  else if(successAtTau.complete) {
    const rows=[];
    for(const row of quality.rows) {
      const matching=records.filter(r=>r.slot.case_id===row.case_id);
      for(const r of matching)if(r.episode?.result.outcome==='pass') {
        const t=present(r.episode.timing.time_to_success_ms);
        if(t!==null&&t<=tau)rows.push({value:t,weight:row.weight/matching.length});
      }
    }
    const p95=weightedQuantile(rows,0.95);
    successP95=p95===null?successP95:{status:'available',value_ms:p95,denominator:'all valid planned episodes'};
  }
  const misuse=resource(records,maps,weights,e=>present(e.measurements.interface_misuse));
  const currencies=[...new Set(records.flatMap(r=>r.episode?.measurements.cost.status==='known'?[r.episode.measurements.cost.value.currency]:[]))];
  const currencyCost=resource(records,maps,weights,e=>e.measurements.cost.status==='known'&&currencies.length===1?e.measurements.cost.value.amount:null);
  let costPerSuccess={status:'unknown',estimate:null,currency:currencies.length===1?currencies[0]:null};
  if(quality.complete&&quality.estimate===0)costPerSuccess={...costPerSuccess,status:'not_reached',reason:'Zero verified successes'};
  else if(quality.complete&&currencyCost.complete)costPerSuccess={...costPerSuccess,status:'available',estimate:currencyCost.estimate/quality.estimate,
    formula:'fixed_weight_mean_all_valid_cost / fixed_weight_verified_quality/v1'};
  const timeBudgets=plan.success_budgets?.time_ms??[Math.round(tau/4),Math.round(tau/2),tau];
  const inputBudgets=plan.success_budgets?.input_tokens??(budget.episode.max_input_tokens?[Math.round(budget.episode.max_input_tokens/4),Math.round(budget.episode.max_input_tokens/2),budget.episode.max_input_tokens]:[]);
  const curves={time_ms:timeBudgets.map(b=>({budget:b,...statusValue(caseRows(records,maps.cases,weights,r=>within(r,b)).estimate)})),
    input_tokens:inputBudgets.map(b=>({budget:b,...statusValue(caseRows(records,maps.cases,weights,r=>{
      if(!r.episode||outcomeFor(r)===null)return null;
      if(r.episode.result.outcome!=='pass')return 0;
      const value=present(r.episode.measurements.input_total.value);
      return value===null?null:value<=b?1:0;
    }).estimate)})),
    interpretation:'Observed completion within each cutoff on the fixed denominator; not a counterfactual rerun with another budget policy.'};
  const metrics={
    verified_quality:{...statusValue(quality.estimate),interval:qInterval,planned_verified_lower_bound:weightedMean(planned.rows),
      valid_episode_ratio:rawRatios.verified_quality,counts},
    known_failure:{...statusValue(failure.estimate),valid_episode_ratio:rawRatios.known_failure},
    evidence_coverage:{...statusValue(coverage.estimate),valid_episode_ratio:rawRatios.evidence_coverage},
    success_identification_bounds:quality.complete&&possible.complete?{status:'available',lower:quality.estimate,upper:possible.estimate,
      interpretation:'Identification bounds for unknown outcomes; not a confidence interval.'}:{status:'incomplete',lower:null,upper:null},
    input_first:inputFirst,input_peak:inputPeak,input_total:{...inputTotal,
      known_subtotal:records.reduce((sum,r)=>sum+(r.episode?.measurements.input_total.known_subtotal??0),0)},
    output_total:outputTotal,capped_time:{...statusValue(cappedRows.estimate),tau_ms:tau,
      interval:intervalFor(cappedRows,{lower:0,upper:tau,confidence,comparisons}),case_values:cappedRows.rows,
      raw_elapsed_ms:rawTime,p95_success_time:successP95},
    success_by_budget:curves,unassisted_quality:{...statusValue(unassisted.estimate),interval:uInterval,
      unknown_intervention_observation:records.filter(r=>r.episode?.result.unassisted_success===null).length},
    interface_misuse_rate:{...misuse,denominator:'episodes, not tool calls'},
    cost_per_success:costPerSuccess,currency_cost:currencyCost,
  };
  return {condition_id:condition.id,environment_id:condition.environment_id,model_id:condition.model_id,
    metrics,counts,complete:quality.complete,case_weights:quality.rows.map(({case_id,family,cluster_id,weight})=>({case_id,family,cluster_id,weight})),
    critical_failures:records.flatMap(r=>r.episode?.result.critical_failures.map(id=>({episode_id:r.episode.identity.episode_id,contract_id:id}))??[]),
    _quality:quality,_input:inputTotal,_time:cappedRows,_unassisted:unassisted};
}
function gateLower(interval, required, label) {
  if(required===null||required===undefined)return {gate:label,status:'not_required'};
  if(interval?.status!=='available')return {gate:label,status:'inconclusive',required,reason:'A complete conservative interval is unavailable'};
  return {gate:label,required,lower:interval.lower,upper:interval.upper,status:interval.lower>=required?'pass':interval.upper<required?'fail':'inconclusive'};
}
function gateUpper(interval, required, label) {
  if(required===null||required===undefined)return {gate:label,status:'not_required'};
  if(interval?.status!=='available')return {gate:label,status:'inconclusive',required,reason:'A finite conservative ratio interval is unavailable'};
  return {gate:label,required,lower:interval.lower,upper:interval.upper,status:interval.upper<=required?'pass':interval.lower>required?'fail':'inconclusive'};
}
function adoptionDecision(candidate, comparison, policy, confirmation) {
  if(candidate.critical_failures.length)return {status:'rejected',stage:'critical_contracts',critical_failures:candidate.critical_failures};
  if(policy.mode!=='acceptance')return {status:'descriptive',stage:'no_acceptance_claim'};
  const quality=[
    gateLower(candidate.metrics.verified_quality.interval,policy.absolute_quality_required,'absolute_quality'),
    gateLower(candidate.metrics.unassisted_quality.interval,policy.unassisted_quality_required,'unassisted_quality'),
    gateLower(comparison.quality_delta.interval,policy.quality_delta_min,'paired_quality_delta'),
  ];
  if(quality.some(g=>g.status==='fail'))return {status:'rejected',stage:'quality',gates:quality};
  if(quality.some(g=>g.status==='inconclusive')||!candidate.complete)return {status:'inconclusive',stage:'quality',gates:quality};
  const efficiency=[gateUpper(comparison.input_ratio.interval,policy.input_ratio_max,'input_ratio'),
    gateUpper(comparison.time_ratio.interval,policy.capped_time_ratio_max,'capped_time_ratio')];
  if(policy.efficiency_ratio_max!==null&&policy.efficiency_ratio_max!==undefined)
    efficiency.push(gateUpper(comparison.input_ratio.interval,policy.efficiency_ratio_max,'input_efficiency'));
  const status=efficiency.some(g=>g.status==='fail')?'rejected':efficiency.some(g=>g.status==='inconclusive')?'inconclusive':
    confirmation?'accepted':'needs_independent_confirmation';
  return {status,stage:'efficiency',gates:[...quality,...efficiency]};
}
function pairTransitions(pairRecords,maps,weights) {
  const states=['pass','fail','unknown'];
  const cells=Object.fromEntries(states.flatMap(from=>states.map(to=>[from+'->'+to,{from,to,count:0,weight:0}])));
  const groups=new Map();
  for(const item of pairRecords) {
    if(!groups.has(item.case_id))groups.set(item.case_id,[]);
    groups.get(item.case_id).push(item);
  }
  const familyCases=new Map();
  for(const caseId of groups.keys()) {
    const family=maps.cases.get(caseId).family;familyCases.set(family,(familyCases.get(family)??0)+1);
  }
  for(const [caseId,items] of groups) {
    const info=maps.cases.get(caseId),familyWeight=weights.find(f=>f.family===info.family)?.weight;
    if(familyWeight===undefined)throw new Error('Missing transition family weight');
    for(const item of items) {
      const from=outcomeFor(item.b)??'unknown',to=outcomeFor(item.a)??'unknown';
      const cell=cells[from+'->'+to];cell.count++;cell.weight+=familyWeight/familyCases.get(info.family)/items.length;
    }
  }
  return {status:'available',orientation:'reference -> candidate',cells:Object.values(cells),
    unresolved_pairs:pairRecords.filter(p=>outcomeFor(p.a)===null||outcomeFor(p.b)===null).length,
    interpretation:'Descriptive paired transitions, including unknown. A single flip is not a causal conclusion.'};
}
function clean(value) {
  if(Array.isArray(value))return value.map(clean);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!k.startsWith('_')).map(([k,v])=>[k,clean(v)]));
  return value;
}
export function scoreExperiment({protocol,episodes,plan=createAnalysisPlan(protocol)}) {
  if(protocol.policies.statistics.interval_method!==INTERVAL_METHOD||protocol.policies.statistics.boundary_method!==BOUNDARY_METHOD||
    protocol.policies.statistics.multiple_comparisons!==MULTIPLICITY_METHOD)throw new Error('Unsupported or unfrozen statistical method');
  if(protocol.protocol_sha256!==fingerprint({...protocol,protocol_sha256:null}))throw new Error('Frozen protocol fingerprint mismatch');
  const maps=validatePlan(protocol,plan),bySlot=new Map(plan.slots.map(slot=>[keyFor(slot),{slot,runs:[],episode:null}]));
  const episodeIds=new Map(),runIds=new Set();
  for(const episode of episodes) {
    if(episode?.schema_version!==1||episode?.kind!=='benchmark-normalized-episode'||episode.episode_sha256!==fingerprint({...episode,episode_sha256:null}))
      throw new Error('Analysis requires an intact versioned normalized episode');
    if(protocol.policies.evidence?.normalizer_version && episode.normalizer_version!==protocol.policies.evidence.normalizer_version)
      throw new Error('Different normalizer semantics require a separate explicit analysis stratum');
    const prior=episodeIds.get(episode.identity.episode_id);
    if(prior) {
      if(prior.episode_sha256!==episode.episode_sha256)throw new Error('Conflicting reanalysis views of one episode');
      continue;
    }
    if(runIds.has(episode.identity.run_id))throw new Error('One actual run cannot become multiple independent episodes');
    episodeIds.set(episode.identity.episode_id,episode);runIds.add(episode.identity.run_id);
    if(episode.identity.experiment_id!==protocol.id)throw new Error('Episode belongs to another experiment');
    const record=bySlot.get(keyFor(episode.identity));
    if(!record)throw new Error('Unplanned episode cannot enter a frozen batch');
    record.runs.push(episode);
  }
  for(const record of bySlot.values()) {
    const valid=record.runs.filter(e=>e.admission.status==='valid');
    if(valid.length>1)throw new Error('Multiple valid executions of one planned slot require a new declared repeat, not outcome selection');
    for(const episode of record.runs) if(episode.identity.retest_of) {
      const prior=episodeIds.get(episode.identity.retest_of);
      if(!prior||keyFor(prior.identity)!==keyFor(episode.identity)||prior.admission.status!=='invalid')
        throw new Error('Replacement must explicitly reference an invalid original in the same planned slot');
    }
    if(record.runs.length>1&&record.runs.filter(e=>!e.identity.retest_of).length!==1)
      throw new Error('Every replacement must retain and link its invalid original');
    for(const episode of record.runs) {
      const seen=new Set([episode.identity.episode_id]);let predecessor=episode.identity.retest_of;
      while(predecessor) {
        if(seen.has(predecessor))throw new Error('Replacement ancestry must be acyclic');
        seen.add(predecessor);predecessor=episodeIds.get(predecessor)?.identity.retest_of;
      }
    }
    record.episode=valid[0]??null;
  }
  const records=[...bySlot.values()],activeConditions=protocol.conditions.filter(c=>records.some(r=>r.slot.condition_id===c.id));
  const comparisonGroups=new Map();
  for(const pair of protocol.pairs??[]) {
    if(pair.condition_ids.length!==2)throw new Error('This scorer requires two explicitly oriented conditions per pair');
    const [aId,bId]=pair.condition_ids,a=bySlot.get(keyFor({...pair,condition_id:aId})),b=bySlot.get(keyFor({...pair,condition_id:bId}));
    if(!a||!b)continue;
    const key=aId+'\u0000'+bId;
    if(!comparisonGroups.has(key))comparisonGroups.set(key,{aId,bId,pairs:[]});
    comparisonGroups.get(key).pairs.push({id:pair.id,case_id:pair.case_id,repeat:pair.repeat,a,b});
  }
  const primaryCount=new Set(protocol.metrics.primary).size;
  const comparisons=Math.max(1,primaryCount*(activeConditions.length+comparisonGroups.size));
  const conditionResults=activeConditions.map(c=>metricsForCondition(c,records.filter(r=>r.slot.condition_id===c.id),protocol,plan,maps,comparisons));
  const conditions=new Map(conditionResults.map(c=>[c.condition_id,c]));
  const compare=[];
  for(const group of comparisonGroups.values()) {
    const a=conditions.get(group.aId),b=conditions.get(group.bId);
    const pairRecords=group.pairs.map(p=>({slot:{case_id:p.case_id,repeat:p.repeat},episode:null,pair:p}));
    const deltaRows=caseRows(pairRecords,maps.cases,protocol.policies.statistics.family_weights,r=>{
      const av=qualityValue(r.pair.a),bv=qualityValue(r.pair.b);return av===null||bv===null?null:av-bv;
    });
    const delta={...statusValue(deltaRows.estimate),interval:deltaRows.complete?differenceInterval(deltaRows.rows,{confidence:protocol.policies.statistics.confidence,comparisons}):
      {status:'unavailable',reason:'Incomplete paired plan'}};
    const inputA=a.metrics.input_total,inputB=b.metrics.input_total;
    const bound=plan.resource_bounds?.input_total;
    const inputUpper=bound?.verified===true&&Number.isFinite(bound.upper)?bound.upper:null;
    const inputRatio=inputA.estimate===null||inputB.estimate===null?{status:'unknown',estimate:null,interval:{status:'unavailable',reason:'Incomplete cumulative input usage'}}:
      {status:inputB.estimate===0?'undefined':'available',estimate:inputB.estimate===0?null:inputA.estimate/inputB.estimate,
        absolute_difference:inputA.estimate-inputB.estimate,
        interval:inputUpper!==null&&[...inputA.case_values,...inputB.case_values].every(r=>r.value<=inputUpper)
          ?ratioInterval(inputA.case_values,inputB.case_values,{upper:inputUpper,confidence:protocol.policies.statistics.confidence,comparisons})
          :{status:'unavailable',reason:'No preregistered independently verified bound on total input; the observed maximum is not a population bound'}};
    const timeA=a.metrics.capped_time,timeB=b.metrics.capped_time;
    const timeRatio=timeA.estimate===null||timeB.estimate===null||timeA.tau_ms!==timeB.tau_ms?{status:'unknown',estimate:null,interval:{status:'unavailable',reason:'Missing or incompatible capped time'}}:
      {status:timeB.estimate===0?'undefined':'available',estimate:timeB.estimate===0?null:timeA.estimate/timeB.estimate,
        absolute_difference:timeA.estimate-timeB.estimate,
        interval:ratioInterval(timeA.case_values,timeB.case_values,{upper:timeA.tau_ms,confidence:protocol.policies.statistics.confidence,comparisons})};
    const result={candidate:group.aId,reference:group.bId,paired_units:group.pairs.length,
      quality_delta:delta,input_ratio:inputRatio,time_ratio:timeRatio,
      version_transition:pairTransitions(group.pairs,maps,protocol.policies.statistics.family_weights),
      both_success_auxiliary:{pairs:group.pairs.filter(p=>outcomeFor(p.a)==='pass'&&outcomeFor(p.b)==='pass').length,
        role:'Auxiliary only; primary resources include failures and unknown outcomes.'}};
    result.decision=adoptionDecision(a,result,protocol.policies.decision,plan.confirmation===true);
    compare.push(result);
  }
  const invalid=[...episodeIds.values()].filter(e=>e.admission.status==='invalid').map(e=>({
    episode_id:e.identity.episode_id,run_id:e.identity.run_id,retest_of:e.identity.retest_of??null,
    reasons:e.admission.reasons??[],actual_attempts:e.measurements.actual_attempts,
    known_actual_attempts:e.measurements.known_actual_attempts,input_total:e.measurements.input_total,output_total:e.measurements.output_total,cost:e.measurements.cost}));
  const required=protocol.policies.decision.absolute_quality_required;
  const frontier=costFrontier(conditionResults.map(c=>({id:c.condition_id,quality:c.metrics.verified_quality,
    cost:c.metrics.cost_per_success,confirmation:plan.confirmation===true,scope:{model_id:c.model_id}})),required);
  const output={schema_version:1,kind:'benchmark-analysis',analysis_version:ANALYSIS_VERSION,
    protocol_id:protocol.id,protocol_sha256:protocol.protocol_sha256,metric_version:'1.0.0',scoring_version:ANALYSIS_VERSION,metric_dictionary_sha256:protocol.metrics.dictionary_sha256??null,plan_id:plan.id,plan_sha256:fingerprint(plan),
    normalizer_versions:[...new Set([...episodeIds.values()].map(e=>e.normalizer_version))].sort(),
    statistical_policy:{...protocol.policies.statistics,simultaneous_claim_count:comparisons,
      inference_unit:'cluster_id; cases and repeats remain nested',input_ratio_bound:plan.resource_bounds?.input_total??null},
    primary_metrics:protocol.metrics.primary,conditions:conditionResults,comparisons:compare,
    completeness:{planned_slots:records.length,valid_slots:records.filter(r=>r.episode).length,
      unresolved_slots:records.filter(r=>!r.episode).map(r=>({id:r.slot.id,condition_id:r.slot.condition_id,case_id:r.slot.case_id,
        repeat:r.slot.repeat,status:r.slot.status??'unresolved',reason:r.slot.stop_reason??'No valid execution',run_ids:r.runs.map(e=>e.identity.run_id)}))},
    cost_ledger:{actual_runs:episodeIds.size,valid_runs:episodeIds.size-invalid.length,invalid_runs:invalid.length,
      known_actual_attempts:[...episodeIds.values()].reduce((s,e)=>s+e.measurements.known_actual_attempts,0),
      known_input_subtotal:[...episodeIds.values()].reduce((s,e)=>s+e.measurements.input_total.known_subtotal,0),invalid},
    cost_frontier:frontier,model_environment_interaction:computeInteractions(protocol,plan,compare,conditions,'model_environment'),
    code_mode_interaction:computeInteractions(protocol,plan,compare,conditions,'code_mode'),
    episode_refs:[...episodeIds.values()].map(e=>({episode_id:e.identity.episode_id,run_id:e.identity.run_id,
      episode_sha256:e.episode_sha256,raw_artifacts:e.artifacts.map(a=>({id:a.id,sha256:a.sha256,path:a.path}))})),
    limitations:['Model quality uses verified business success and applicable contracts; unknown earns no success credit.',
      'Invalid runs and replacements retain their own costs. Missing planned slots prevent complete quality estimates.',
      'Cluster Hoeffding intervals are conservative and assume independent declared clusters. Repeats do not create new clusters.',
      'Input ratio inference needs an independently verified preregistered bound; missing bounds never yield noninferiority.',
      'No reanalysis can create a new model execution, unseen confirmation or a missing model-by-environment cell.'],
    analysis_sha256:null};
  const result=clean(output);result.analysis_sha256=fingerprint(result);return result;
}
export function costFrontier(configurations,qualityRequired) {
  if(!Number.isFinite(qualityRequired))return {status:'unavailable',reason:'No preregistered absolute quality requirement',eligible:[],frontier:[]};
  const eligible=configurations.filter(c=>c.quality.interval?.status==='available'&&c.quality.interval.lower>=qualityRequired&&
    c.cost.status==='available'&&Number.isFinite(c.cost.estimate));
  const frontier=eligible.filter(c=>!eligible.some(other=>other.id!==c.id&&JSON.stringify(other.scope)===JSON.stringify(c.scope)&&
    other.cost.currency===c.cost.currency&&other.cost.estimate<=c.cost.estimate&&other.quality.estimate>=c.quality.estimate&&
    (other.cost.estimate<c.cost.estimate||other.quality.estimate>c.quality.estimate)));
  return {status:'available',quality_required:qualityRequired,eligible:eligible.map(c=>c.id),
    frontier:frontier.map(c=>({id:c.id,cost:c.cost,quality:c.quality,confirmation:c.confirmation?'independently_confirmed':'requires_independent_confirmation'})),
    interpretation:'Only observed tested configurations within comparable scopes. Unknown cost and subthreshold quality are excluded.'};
}
export function differenceInDifferences({cells,comparable,reason}) {
  if(comparable!==true)return {status:'unavailable',reason:reason??'A common task/environment/policy/window scope has not been established'};
  if(!Array.isArray(cells)||cells.length!==4||cells.some(c=>!Number.isFinite(c.estimate)))
    return {status:'unavailable',reason:'All four observed cells are required'};
  return {status:'descriptive',estimate:(cells[0].estimate-cells[1].estimate)-(cells[2].estimate-cells[3].estimate),
    formula:'(A,new - B,new) - (A,old - B,old)/v1',cells,
    interval:{status:'unavailable',reason:'No preregistered joint four-cell interval supplied'},causal_claim:false};
}
function computeInteractions(protocol,plan,comparisons,results,kind) {
  const conditionMap=new Map(protocol.conditions.map(c=>[c.id,c]));
  const modelMap=new Map((protocol.models??[]).map(m=>[m.id,m]));
  const budgetMap=new Map(protocol.policies.budgets.map(b=>[b.id,b]));
  const scope=c=>({corpus_id:c.corpus_id,corpus_sha256:c.corpus_sha256,
    cases:[...c.case_ids].sort(),initial_state_sha256:c.initial_state_sha256,
    authorization_sha256:c.authorization_sha256,budget:budgetMap.get(c.budget_id),
    window:modelMap.get(c.model_id)?.backend?.window??null,
    adoption:modelMap.get(c.model_id)?.adoption?.mode??'as_is'});
  let specifications=(plan.interactions??[]).filter(i=>i.kind===kind);
  if(!specifications.length&&kind==='model_environment') {
    specifications=[];
    for(let i=0;i<comparisons.length;i++)for(let j=i+1;j<comparisons.length;j++) {
      const x=comparisons[i],y=comparisons[j],a=conditionMap.get(x.candidate),b=conditionMap.get(x.reference),c=conditionMap.get(y.candidate),d=conditionMap.get(y.reference);
      if(a.model_id===b.model_id&&c.model_id===d.model_id&&a.model_id!==c.model_id&&a.environment_id===c.environment_id&&b.environment_id===d.environment_id)
        specifications.push({id:x.candidate+'--'+y.candidate,kind,condition_ids:[a.id,b.id,c.id,d.id],origin:'observed-descriptive-model-pairs'});
    }
  }
  if(!specifications.length)return {status:'not_planned',comparisons:[],reason:'No complete declared four-cell interaction; reanalysis cannot create missing cells'};
  const output=specifications.map(spec=>{
    if(!Array.isArray(spec.condition_ids)||spec.condition_ids.length!==4)return {id:spec.id,status:'unavailable',reason:'Four distinct condition cells are required'};
    const conditions=spec.condition_ids.map(id=>conditionMap.get(id));
    if(new Set(spec.condition_ids).size!==4||conditions.some(c=>!c))return {id:spec.id,status:'unavailable',reason:'Missing or repeated condition cell'};
    const [a,b,c,d]=conditions;
    if(conditions.some(row=>!results.has(row.id)||!results.get(row.id).complete)||conditions.some(row=>!scope(row).window))
      return {id:spec.id,status:'unavailable',reason:'Complete observations and declared model windows are required'};
    if(conditions.some(row=>fingerprint(scope(row))!==fingerprint(scope(a))))return {id:spec.id,status:'unavailable',reason:'Tasks, material, state, authorization, budget, adoption mode or model window differ'};
    if(kind==='model_environment'&&!(a.model_id===b.model_id&&c.model_id===d.model_id&&a.model_id!==c.model_id&&a.environment_id===c.environment_id&&b.environment_id===d.environment_id))
      return {id:spec.id,status:'unavailable',reason:'Model-by-environment requires the same two environments at each model'};
    if(kind==='code_mode'&&!(a.model_id===b.model_id&&b.model_id===c.model_id&&c.model_id===d.model_id&&a.code_mode===b.code_mode&&c.code_mode===d.code_mode&&a.code_mode!==c.code_mode&&
      Array.isArray(spec.environment_pairs)&&fingerprint(spec.environment_pairs)===fingerprint([[a.environment_id,b.environment_id],[c.environment_id,d.environment_id]])))
      return {id:spec.id,status:'unavailable',reason:'Code Mode interaction requires declared environment pairs, one model and two distinct matched Code Mode policies'};
    const first=comparisons.find(p=>p.candidate===a.id&&p.reference===b.id),second=comparisons.find(p=>p.candidate===c.id&&p.reference===d.id);
    if(!first||!second)return {id:spec.id,status:'unavailable',reason:'Both oriented within-scope environment pairs must be observed'};
    const cells=conditions.map(row=>({condition_id:row.id,estimate:results.get(row.id).metrics.verified_quality.estimate}));
    const result=differenceInDifferences({cells,comparable:true});
    const x=first.quality_delta.interval,y=second.quality_delta.interval;
    if(x.status==='available'&&y.status==='available')result.interval={status:'available',lower:Math.max(-2,x.lower-y.upper),upper:Math.min(2,x.upper-y.lower),
      method:'simultaneous-paired-delta-interval-difference/v1',confidence:protocol.policies.statistics.confidence};
    return {id:spec.id,kind,...result,origin:spec.origin??'preregistered-plan',confirmation:plan.confirmation===true};
  });
  return {status:output.some(x=>x.status==='descriptive')?'descriptive':'unavailable',comparisons:output,
    interpretation:'Difference of within-model or within-Code-Mode environment differences. No isolated flip implies general model ability.'};
}

export function selectRegression({cases,anchorCaseIds=[],changedFamilies=[],changedCapabilities=[],maxCases=8}) {
  if(!Number.isSafeInteger(maxCases)||maxCases<1)throw new TypeError('Regression case cap must be positive');
  const anchors=new Set(anchorCaseIds),families=new Set(changedFamilies),capabilities=new Set(changedCapabilities);
  const ranked=cases.map(c=>({case:c,priority:anchors.has(c.id)?0:families.has(c.family)||c.capability_ids?.some(id=>capabilities.has(id))?1:2}))
    .sort((a,b)=>a.priority-b.priority||a.case.id.localeCompare(b.case.id));
  const selected=[],clusters=new Set();
  for(const row of ranked)if(row.priority<2&&!clusters.has(row.case.cluster_id)&&selected.length<maxCases) {
    selected.push(row.case);clusters.add(row.case.cluster_id);
  }
  for(const row of ranked)if(row.priority<2&&!selected.some(c=>c.id===row.case.id)&&selected.length<maxCases)selected.push(row.case);
  return {case_ids:selected.map(c=>c.id),purpose:'scoped_regression',independent_clusters:new Set(selected.map(c=>c.cluster_id)).size,
    noninferiority_proof:false,max_cases:maxCases,manual_release_policy:'Require an explicit frozen bounded plan and independent result review before adoption; preserve the daily gate.'};
}
export function releasePolicy(analysis,{requireConfirmation=true}={}) {
  const unresolved=analysis.completeness.unresolved_slots.length;
  const critical=analysis.conditions.flatMap(c=>c.critical_failures);
  const accepted=analysis.comparisons.length>0&&analysis.comparisons.every(c=>c.decision.status==='accepted'||
    !requireConfirmation&&c.decision.status==='needs_independent_confirmation');
  return {status:critical.length?'blocked':unresolved?'incomplete':accepted?'reviewable':'inconclusive',
    manual_review_required:true,unresolved_slots:unresolved,critical_failures:critical,
    daily_gate:'unchanged',reason:accepted?'Evidence is ready for explicit release review.':'A Benchmark report alone does not authorize adoption.'};
}
