import { fingerprint, validateAnalysisPolicy } from '../protocol.mjs';
import { clusterInterval, differenceInterval, ratioInterval, weightedMean, weightedQuantile,
  INTERVAL_METHOD, BOUNDARY_METHOD, MULTIPLICITY_METHOD } from './statistics.mjs';

export const ANALYSIS_VERSION = '1.1.0';
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
    ...(policy.capped_time_horizon_ms !== undefined ? {capped_time_horizon_ms:policy.capped_time_horizon_ms} : {}),
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
      planned_repeats:items.length,known_repeats:values.filter(v=>v!==null).length,
       known_sum:values.reduce((n,v)=>n+(v??0),0)};
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

function budgetCutoffs(condition,protocol,plan) {
  const policy=protocol.policies.budgets.find(b=>b.id===condition.budget_id),budget=policy?.episode;
  return {time_ms:plan.success_budgets?.time_ms??(policy?.mode==='unbounded'?[]:[Math.round(budget.max_duration_ms/4),Math.round(budget.max_duration_ms/2),budget.max_duration_ms]),
    input_tokens:plan.success_budgets?.input_tokens??(policy?.mode!=='unbounded'&&budget.max_input_tokens?[Math.round(budget.max_input_tokens/4),Math.round(budget.max_input_tokens/2),budget.max_input_tokens]:[])};
}
function budgetValue(record,axis,cutoff) {
  const outcome=outcomeFor(record);
  if(outcome===null)return null;
  if(outcome!=='pass')return 0;
  const usage=axis==='time_ms'?present(record.episode.timing.time_to_success_ms):present(record.episode.measurements.input_total.value);
  return usage===null?null:Number(usage<=cutoff);
}
function cappedValue(record,tau) {
  const outcome=outcomeFor(record);
  if(outcome===null)return null;
  if(outcome!=='pass')return tau;
  const time=present(record.episode.timing.time_to_success_ms);
  return time===null?null:Math.min(time,tau);
}
function costValue(record) {
  return outcomeFor(record)===null?null:present(record.episode.measurements.cost);
}
function boundedSummary(result,{lower=0,upper=1,confidence,comparisons,reason='Incomplete fixed batch'}={}) {
  const rows=result.rows;
  return {...statusValue(result.estimate),complete:result.complete,case_values:rows,
    interval:result.complete&&rows.length?clusterInterval(rows,{lower,upper,confidence,comparisons}):{status:'unavailable',reason},
    identification_bounds:rows.length?{
      lower:weightedMean(rows.map(r=>({...r,value:r.value??(r.known_sum+(r.planned_repeats-r.known_repeats)*lower)/r.planned_repeats}))),
      upper:weightedMean(rows.map(r=>({...r,value:r.value??(r.known_sum+(r.planned_repeats-r.known_repeats)*upper)/r.planned_repeats}))),
      interpretation:'Unresolved observations range over the declared outcome bounds; this is not a sampling interval.'}:null,
    planned_repeats:rows.reduce((n,r)=>n+r.planned_repeats,0),known_repeats:rows.reduce((n,r)=>n+r.known_repeats,0)};
}
function currencyBound(plan,currency) {
  const bound=plan.resource_bounds?.currency_cost;
  return bound?.verified===true&&bound.currency===currency&&Number.isFinite(bound.upper)&&bound.upper>0?bound.upper:null;
}
function costInterval(result,plan,currency,options) {
  if(!result.complete)return {status:'unavailable',reason:'Incomplete fixed-denominator currency cost'};
  const upper=currencyBound(plan,currency);
  if(upper===null)return {status:'unavailable',reason:'No preregistered independently verified population cost bound in this currency'};
  if(result.rows.some(r=>r.value<0||r.value>upper)||(options.observations??[]).some(value=>value<0||value>upper))return {status:'unavailable',reason:'Observed cost exceeds the registered bound; no observed maximum is substituted'};
  return intervalFor(result,{...options,lower:0,upper});
}
function interactionSpecifications(protocol,plan,groups,kind) {
  const registered=(plan.interactions??[]).filter(i=>i.kind===kind);
  if(registered.length||kind!=='model_environment')return registered;
  const conditions=new Map(protocol.conditions.map(c=>[c.id,c])),specs=[];
  for(let i=0;i<groups.length;i++)for(let j=i+1;j<groups.length;j++) {
    const x=groups[i],y=groups[j],a=conditions.get(x.aId),b=conditions.get(x.bId),c=conditions.get(y.aId),d=conditions.get(y.bId);
    if(a.model_id===b.model_id&&c.model_id===d.model_id&&a.model_id!==c.model_id&&a.environment_id===c.environment_id&&b.environment_id===d.environment_id)
      specs.push({id:a.id+'--'+c.id,kind,condition_ids:[a.id,b.id,c.id,d.id],origin:'protocol-derived-exploratory'});
  }
  return specs;
}
function inferenceClaims(protocol,plan,conditions,groups,specifications) {
  const claims=[],add=(id,kind,origin='registered-analysis')=>claims.push({id,kind,origin});
  for(const condition of conditions) {
    for(const metric of ['verified_quality','unassisted_quality','capped_time','currency_cost'])add('condition/'+condition.id+'/'+metric,'condition');
    for(const [axis,budgets] of Object.entries(budgetCutoffs(condition,protocol,plan)))
      for(const budget of budgets)add('condition/'+condition.id+'/budget/'+axis+'/'+budget,'budget');
  }
  const conditionMap=new Map(conditions.map(c=>[c.id,c]));
  for(const group of groups) {
    const prefix='pair/'+group.aId+'/'+group.bId;
    for(const metric of ['quality_delta','input_ratio','time_ratio'])add(prefix+'/'+metric,'paired');
    for(const from of ['pass','fail','unknown'])for(const to of ['pass','fail','unknown'])add(prefix+'/transition/'+from+'/'+to,'transition');
    const a=budgetCutoffs(conditionMap.get(group.aId),protocol,plan),b=budgetCutoffs(conditionMap.get(group.bId),protocol,plan);
    for(const axis of Object.keys(a))for(const budget of a[axis].filter(n=>b[axis].includes(n)))add(prefix+'/budget/'+axis+'/'+budget,'paired-budget');
  }
  for(const spec of specifications)for(const metric of ['quality','time','cost'])add('interaction/'+spec.kind+'/'+spec.id+'/'+metric,'interaction',spec.origin??'registered-analysis');
  const primaryFloor=new Set(protocol.metrics.primary).size*(conditions.length+groups.length);
  return {count:Math.max(1,primaryFloor,claims.length),primary_family_floor:primaryFloor,claims,
    allocation:'Bonferroni over this outcome-independent ledger, retaining the registered primary-family floor. A ratio divides its allocation between its two bounded means.',
    unavailable_claims_retained:true,exploratory_interactions_confirmatory:false};
}

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
  const tau=plan.capped_time_horizon_ms??budget?.episode.max_duration_ms;
  if(!Number.isFinite(tau)||tau<=0)throw new Error('Capped-time analysis requires a preregistered positive measurement horizon or bounded episode duration');
  const capped=r=>cappedValue(r,tau);
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
  const validRecords=records.filter(r=>outcomeFor(r)!==null);
  const costs=validRecords.map(costValue),currencies=[...new Set(costs.filter(Boolean).map(c=>c.currency))];
  const currency=currencies.length===1?currencies[0]:null;
  const costRows=caseRows(records,maps.cases,weights,r=>{const cost=costValue(r);return cost&&currency?cost.amount:null;});
  const currencyCost={...statusValue(costRows.estimate),complete:costRows.complete,currency,unit:'currency',case_values:costRows.rows,
    formula:'fixed_weight_mean_all_valid_episode_cost/v1',
    interval:costInterval(costRows,plan,currency,{confidence,comparisons,observations:costs.filter(Boolean).map(c=>c.amount)}),
    known_subtotals:currencies.map(unit=>({currency:unit,amount:costs.filter(c=>c?.currency===unit).reduce((n,c)=>n+c.amount,0)}))};
  const completeValidCost=validRecords.length>0&&currency!==null&&costs.every(Boolean);
  const totalValidCost=completeValidCost?costs.reduce((n,c)=>n+c.amount,0):null;
  let costPerSuccess={status:'unknown',estimate:null,currency,unit:'currency',
    formula:'sum_all_valid_episode_cost / verified_success_count/v1',total_valid_cost:totalValidCost,
    valid_episodes:counts.valid,verified_successes:counts.pass,planned_episodes:counts.planned,unresolved_episodes:counts.unresolved,
    complete_valid_cost:completeValidCost,known_subtotals:currencyCost.known_subtotals};
  if(counts.valid&&counts.pass===0)costPerSuccess={...costPerSuccess,status:'not_reached',reason:'Zero verified successes'};
  else if(completeValidCost&&counts.pass>0)costPerSuccess={...costPerSuccess,status:'available',estimate:totalValidCost/counts.pass};
  const curves={};
  for(const [axis,budgets] of Object.entries(budgetCutoffs(condition,protocol,plan)))curves[axis]=budgets.map(budget=>({budget,unit:'ratio',
    ...boundedSummary(caseRows(records,maps.cases,weights,r=>budgetValue(r,axis,budget)),{confidence,comparisons}),
    counts:{...counts,success_usage_unknown:records.filter(r=>outcomeFor(r)==='pass'&&budgetValue(r,axis,budget)===null).length},
    paired_unit_ids:records.map(r=>({case_id:r.slot.case_id,repeat:r.slot.repeat,seed:r.slot.seed,pair_id:r.slot.pair_id??null}))}));
  curves.interpretation='Observed completion within each cutoff on the fixed denominator; not a counterfactual rerun with another budget policy.';
  const metrics={
    verified_quality:{...statusValue(quality.estimate),unit:'ratio',score_percent:{...statusValue(quality.estimate===null?null:100*quality.estimate),unit:'percent',
        interval:qInterval.status==='available'?{...qInterval,estimate:100*qInterval.estimate,lower:100*qInterval.lower,upper:100*qInterval.upper,radius:100*qInterval.radius}:qInterval},
      interval:qInterval,planned_verified_lower_bound:weightedMean(planned.rows),
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
    _quality:quality,_input:inputTotal,_time:cappedRows,_unassisted:unassisted,_records:records};
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
function pairTransitions(pairRecords,maps,weights,options) {
  const states=['pass','fail','unknown'],records=pairRecords.map(pair=>({slot:{case_id:pair.case_id,repeat:pair.repeat},pair}));
  const actual=pair=>({from:outcomeFor(pair.b),to:outcomeFor(pair.a)});
  const unresolved=pairRecords.filter(pair=>{const {from,to}=actual(pair);return from===null||to===null;});
  const cells=states.flatMap(from=>states.map(to=>{
    const match=pair=>{const state=actual(pair);return state.from===from&&state.to===to;};
    const observed=caseRows(records,maps.cases,weights,r=>{
      const state=actual(r.pair);return state.from===null||state.to===null?null:Number(match(r.pair));
    });
    const descriptive=caseRows(records,maps.cases,weights,r=>{
      const state=actual(r.pair);return Number((state.from??'unknown')===from&&(state.to??'unknown')===to);
    });
    const lower=caseRows(records,maps.cases,weights,r=>Number(match(r.pair)));
    const upper=caseRows(records,maps.cases,weights,r=>{
      const state=actual(r.pair);return Number((state.from===null||state.from===from)&&(state.to===null||state.to===to));
    });
    const count=pairRecords.filter(pair=>{const state=actual(pair);return (state.from??'unknown')===from&&(state.to??'unknown')===to;}).length;
    const observedCount=pairRecords.filter(match).length;
    return {from,to,count,weight:descriptive.estimate,observed_count:observedCount,unresolved_assigned_count:count-observedCount,
      ...boundedSummary(observed,{...options,reason:'Missing or invalid-only paired slots cannot be sampled as observed unknown outcomes'}),
      identification_bounds:{lower:lower.estimate,upper:upper.estimate,interpretation:'Possible transition mass from unresolved sides; not a sampling interval.'}};
  }));
  return {status:unresolved.length?'incomplete':'available',orientation:'reference -> candidate',cells,
    unresolved_pairs:unresolved.length,observed_pairs:pairRecords.length-unresolved.length,
    observed_unknown_pairs:pairRecords.filter(pair=>{const s=actual(pair);return s.from!==null&&s.to!==null&&(s.from==='unknown'||s.to==='unknown');}).length,
    paired_units:pairRecords.map(pair=>({id:pair.id,case_id:pair.case_id,repeat:pair.repeat,cluster_id:maps.cases.get(pair.case_id).cluster_id,
      reference_outcome:outcomeFor(pair.b),candidate_outcome:outcomeFor(pair.a)})),
    interpretation:'Count/weight retain the full planned descriptive matrix with unresolved sides assigned to unknown. Observed counts and intervals exclude that assignment; missing pairs prevent complete inference. A flip alone is not a causal conclusion.'};
}
function pairedBudgetCurves(group,protocol,plan,maps,options) {
  const a=protocol.conditions.find(c=>c.id===group.aId),b=protocol.conditions.find(c=>c.id===group.bId),
    cutA=budgetCutoffs(a,protocol,plan),cutB=budgetCutoffs(b,protocol,plan),curves={};
  const records=group.pairs.map(pair=>({slot:{case_id:pair.case_id,repeat:pair.repeat},pair}));
  for(const axis of Object.keys(cutA))curves[axis]=cutA[axis].filter(budget=>cutB[axis].includes(budget)).map(budget=>({budget,unit:'ratio_difference',
    ...boundedSummary(caseRows(records,maps.cases,protocol.policies.statistics.family_weights,r=>{
      const x=budgetValue(r.pair.a,axis,budget),y=budgetValue(r.pair.b,axis,budget);return x===null||y===null?null:x-y;
    }),{...options,lower:-1,upper:1,reason:'Incomplete paired budget observations'}),
    paired_units:group.pairs.map(pair=>({id:pair.id,case_id:pair.case_id,repeat:pair.repeat,
      candidate_outcome:outcomeFor(pair.a),reference_outcome:outcomeFor(pair.b),
      candidate_value:budgetValue(pair.a,axis,budget),reference_value:budgetValue(pair.b,axis,budget)}))}));
  return {...curves,orientation:'candidate minus reference',interpretation:'Within-case/repeat contrasts on shared frozen cutoffs, followed by fixed weights and cluster inference.'};
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
  const groups=[...comparisonGroups.values()];
  const specifications=Object.fromEntries(['model_environment','code_mode'].map(kind=>[kind,interactionSpecifications(protocol,plan,groups,kind)]));
  const claimPolicy=inferenceClaims(protocol,plan,activeConditions,groups,Object.values(specifications).flat());
  const comparisons=claimPolicy.count;
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
      version_transition:pairTransitions(group.pairs,maps,protocol.policies.statistics.family_weights,{confidence:protocol.policies.statistics.confidence,comparisons}),
      success_by_budget:pairedBudgetCurves(group,protocol,plan,maps,{confidence:protocol.policies.statistics.confidence,comparisons}),_pairs:group.pairs,
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
  const frontier=costFrontier(conditionResults.map(c=>{
    const definition=maps.conditions.get(c.condition_id),model=protocol.models?.find(m=>m.id===c.model_id);
    const taskScope={corpus_id:definition.corpus_id,corpus_sha256:definition.corpus_sha256,case_ids:[...definition.case_ids].sort(),
      family_weights:protocol.policies.statistics.family_weights,initial_state_sha256:definition.initial_state_sha256,
      authorization_sha256:definition.authorization_sha256,adoption:model?.adoption?.mode??'as_is',window:model?.backend?.window??null,
      planned_units:c._records.map(r=>({case_id:r.slot.case_id,repeat:r.slot.repeat,seed:r.slot.seed,expected_support:r.slot.expected_support})).sort((a,b)=>a.case_id.localeCompare(b.case_id)||a.repeat-b.repeat)};
    return {id:c.condition_id,model_id:c.model_id,quality:c.metrics.verified_quality,cost:c.metrics.currency_cost,
      confirmation:plan.confirmation===true,policy:{budget_id:definition.budget_id,code_mode:definition.code_mode},
      scope:{environment_id:c.environment_id,environment_sha256:definition.environment_sha256??null,
        ...taskScope,task_scope_sha256:fingerprint(taskScope)}};
  }),required);
  const output={schema_version:1,kind:'benchmark-analysis',analysis_version:ANALYSIS_VERSION,
    protocol_id:protocol.id,protocol_sha256:protocol.protocol_sha256,metric_version:'1.0.0',scoring_version:ANALYSIS_VERSION,metric_dictionary_sha256:protocol.metrics.dictionary_sha256??null,plan_id:plan.id,plan_sha256:fingerprint(plan),
    normalizer_versions:[...new Set([...episodeIds.values()].map(e=>e.normalizer_version))].sort(),
    statistical_policy:{...protocol.policies.statistics,simultaneous_claim_count:comparisons,claim_ledger:claimPolicy,
      inference_unit:'cluster_id; cases and repeats remain nested',input_ratio_bound:plan.resource_bounds?.input_total??null},
    primary_metrics:protocol.metrics.primary,conditions:conditionResults,comparisons:compare,
    completeness:{planned_slots:records.length,valid_slots:records.filter(r=>r.episode).length,
      unresolved_slots:records.filter(r=>!r.episode).map(r=>({id:r.slot.id,condition_id:r.slot.condition_id,case_id:r.slot.case_id,
        repeat:r.slot.repeat,status:r.slot.status??'unresolved',reason:r.slot.stop_reason??'No valid execution',run_ids:r.runs.map(e=>e.identity.run_id)}))},
    cost_ledger:{actual_runs:episodeIds.size,valid_runs:episodeIds.size-invalid.length,invalid_runs:invalid.length,
      known_actual_attempts:[...episodeIds.values()].reduce((s,e)=>s+e.measurements.known_actual_attempts,0),
      known_input_subtotal:[...episodeIds.values()].reduce((s,e)=>s+e.measurements.input_total.known_subtotal,0),invalid},
    cost_frontier:frontier,model_environment_interaction:computeInteractions(protocol,plan,compare,conditions,'model_environment',specifications.model_environment,maps,comparisons),
    code_mode_interaction:computeInteractions(protocol,plan,compare,conditions,'code_mode',specifications.code_mode,maps,comparisons),
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
  if(!Number.isFinite(qualityRequired)||qualityRequired<0||qualityRequired>1)return {status:'unavailable',reason:'No preregistered absolute quality requirement',eligible:[],frontier:[],groups:[]};
  const scopes=new Map(),excluded=[];
  for(const config of configurations) {
    if(!config.scope?.environment_id||!/^[a-f0-9]{64}$/.test(config.scope.task_scope_sha256??'')){excluded.push({id:config.id,reason:'No explicit environment and frozen common-task scope fingerprint'});continue;}
    const scopeKey=fingerprint(config.scope);
    if(!scopes.has(scopeKey))scopes.set(scopeKey,{scope:config.scope,configurations:[]});
    scopes.get(scopeKey).configurations.push(config);
  }
  const groups=[],frontier=[],eligible=[];
  for(const {scope,configurations:items} of scopes.values()) {
    const currencies=[...new Set(items.map(c=>c.cost.currency).filter(c=>typeof c==='string'&&c.length))];
    for(const currency of currencies.length?currencies:[null]) {
      const admitted=[];
      for(const c of items) {
        let reason=null;
        if(c.quality.status!=='available'||c.quality.interval?.status!=='available'||!Number.isFinite(c.quality.interval.lower))reason='Quality lower bound unavailable';
        else if(c.quality.interval.lower<qualityRequired)reason='Quality lower bound does not attain the threshold';
        else if(c.cost.status!=='available'||c.cost.complete!==true||!Number.isFinite(c.cost.estimate)||c.cost.estimate<0)reason='Complete all-valid weighted mean cost unavailable';
        else if(!currency||c.cost.currency!==currency)reason='Different or unknown currency';
        if(reason)excluded.push({id:c.id,scope,currency,reason});else admitted.push(c);
      }
      const minimum=admitted.length?Math.min(...admitted.map(c=>c.cost.estimate)):null;
      const selected=admitted.filter(c=>c.cost.estimate===minimum);
      groups.push({scope,currency,status:admitted.length?'available':'not_reached',estimate:minimum,eligible:admitted.map(c=>c.id),selected:selected.map(c=>c.id)});
      eligible.push(...admitted.map(c=>c.id));
      frontier.push(...selected.map(c=>({id:c.id,model_id:c.model_id??null,scope,policy:c.policy??null,cost:c.cost,quality:c.quality,
        confirmation:'requires_independent_confirmation',observed_phase:c.confirmation?'confirmation':'development_or_pilot',
        selection_status:'empirical_minimum_selected_on_this_data',independently_confirmed:false,cost_advantage_claim:false,
        quality_confirmation:c.confirmation?'observed_confirmation_phase':'not_confirmation'})));
    }
  }
  return {status:frontier.length?'available':'not_reached',quality_required:qualityRequired,eligible:[...new Set(eligible)],frontier,groups,excluded,
    formula:'min_tested_fixed_weight_mean_cost_subject_to_quality_LCB/v1',
    interpretation:'Within each environment, common task scope and currency, select the lowest complete mean cost among tested model/policy configurations that attain the quality lower bound. This is not a Pareto set or cost per success. Selection on confirmation data is not independent confirmation of the selected winner.'};
}
export function differenceInDifferences({cells,comparable,reason}) {
  if(comparable!==true)return {status:'unavailable',reason:reason??'A common task/environment/policy/window scope has not been established'};
  if(!Array.isArray(cells)||cells.length!==4||cells.some(c=>!Number.isFinite(c.estimate)))
    return {status:'unavailable',reason:'All four observed cells are required'};
  return {status:'descriptive',estimate:(cells[0].estimate-cells[1].estimate)-(cells[2].estimate-cells[3].estimate),
    formula:'(A,new - B,new) - (A,old - B,old)/v1',cells,
    interval:{status:'unavailable',reason:'No preregistered joint four-cell interval supplied'},causal_claim:false};
}
function computeInteractions(protocol,plan,comparisons,results,kind,specifications,maps,claimCount) {
  const conditionMap=new Map(protocol.conditions.map(c=>[c.id,c]));
  const modelMap=new Map((protocol.models??[]).map(m=>[m.id,m]));
  const budgetMap=new Map(protocol.policies.budgets.map(b=>[b.id,b]));
  const scope=c=>({corpus_id:c.corpus_id,corpus_sha256:c.corpus_sha256,
    cases:[...c.case_ids].sort(),initial_state_sha256:c.initial_state_sha256,
    authorization_sha256:c.authorization_sha256,budget:budgetMap.get(c.budget_id),
    window:modelMap.get(c.model_id)?.backend?.window??null,
    adoption:modelMap.get(c.model_id)?.adoption?.mode??'as_is'});
  if(!specifications.length)return {status:'not_planned',comparisons:[],reason:'No declared four-cell interaction; reanalysis cannot create missing cells'};
  const unavailable=(spec,reason)=>({id:spec.id,kind,status:'unavailable',reason,origin:spec.origin??'preregistered-plan',confirmation:false,
    metrics:Object.fromEntries(['quality','time','cost'].map(metric=>[metric,{status:'unavailable',estimate:null,interval:{status:'unavailable',reason}}]))});
  const output=specifications.map(spec=>{
    if(!Array.isArray(spec.condition_ids)||spec.condition_ids.length!==4)return unavailable(spec,'Four distinct condition cells are required');
    const conditions=spec.condition_ids.map(id=>conditionMap.get(id));
    if(new Set(spec.condition_ids).size!==4||conditions.some(c=>!c||!results.has(c.id)))return unavailable(spec,'Missing or repeated condition cell');
    const [a,b,c,d]=conditions;
    if(conditions.some(row=>!scope(row).window))return unavailable(spec,'Declared comparable model windows are required');
    if(conditions.some(row=>fingerprint(scope(row))!==fingerprint(scope(a))))return unavailable(spec,'Tasks, material, state, authorization, budget, adoption mode or model window differ');
    if(kind==='model_environment'&&!(a.model_id===b.model_id&&c.model_id===d.model_id&&a.model_id!==c.model_id&&
      a.environment_id===c.environment_id&&b.environment_id===d.environment_id&&conditions.every(row=>row.code_mode===a.code_mode)&&
      (a.environment_sha256??null)===(c.environment_sha256??null)&&(b.environment_sha256??null)===(d.environment_sha256??null)))
      return unavailable(spec,'Model-by-environment requires the same two environment versions and policy at each model');
    if(kind==='code_mode'&&!(a.model_id===b.model_id&&b.model_id===c.model_id&&c.model_id===d.model_id&&a.code_mode===b.code_mode&&c.code_mode===d.code_mode&&a.code_mode!==c.code_mode&&
      Array.isArray(spec.environment_pairs)&&fingerprint(spec.environment_pairs)===fingerprint([[a.environment_id,b.environment_id],[c.environment_id,d.environment_id]])))
      return unavailable(spec,'Code Mode interaction requires declared environment pairs, one model and two distinct matched Code Mode policies');
    const first=comparisons.find(p=>p.candidate===a.id&&p.reference===b.id),second=comparisons.find(p=>p.candidate===c.id&&p.reference===d.id);
    if(!first||!second)return unavailable(spec,'Both oriented within-scope environment pairs must be planned');
    const pairKey=p=>JSON.stringify([p.case_id,p.repeat]),other=new Map(second._pairs.map(p=>[pairKey(p),p]));
    if(first._pairs.length!==second._pairs.length||first._pairs.some(p=>!other.has(pairKey(p))))return unavailable(spec,'All four cells must share the same frozen case/repeat units');
    const joint=first._pairs.map(p=>({slot:{case_id:p.case_id,repeat:p.repeat},pairs:[p,other.get(pairKey(p))],records:[p.a,p.b,other.get(pairKey(p)).a,other.get(pairKey(p)).b]}));
    if(joint.some(row=>new Set(row.records.map(r=>r.slot.seed)).size!==1))return unavailable(spec,'Cross-model or policy cells have different pairing seeds');
    const jointKeys=new Set(joint.map(row=>pairKey(row.slot)));
    if(conditions.some(condition=>{const supported=results.get(condition.id)._records.filter(r=>r.slot.expected_support!=='unsupported');
      return supported.length!==joint.length||supported.some(r=>!jointKeys.has(pairKey(r.slot)));}))
      return unavailable(spec,'Supported frozen slot scope does not equal the common four-cell paired denominator');
    const tau=results.get(a.id).metrics.capped_time.tau_ms;
    const allCosts=joint.flatMap(row=>row.records.map(costValue));
    const currencies=[...new Set(allCosts.filter(Boolean).map(value=>value.currency))],currency=currencies.length===1?currencies[0]:null;
    const bound=currencyBound(plan,currency);
    const dimensions=[
      {name:'quality',unit:'ratio_difference',get:qualityValue,lower:-2,upper:2,source:'verified_quality'},
      {name:'time',unit:'milliseconds',get:r=>cappedValue(r,tau),lower:-2*tau,upper:2*tau,source:'capped_time'},
      {name:'cost',unit:'currency',currency,get:r=>{const cost=costValue(r);return cost&&currency?cost.amount:null;},
        lower:bound===null?null:-2*bound,upper:bound===null?null:2*bound,source:'currency_cost'},
    ];
    const metrics=Object.fromEntries(dimensions.map(dimension=>{
      const rows=caseRows(joint,maps.cases,protocol.policies.statistics.family_weights,row=>{
        const values=row.records.map(dimension.get);
        return values.some(value=>value===null)?null:(values[0]-values[1])-(values[2]-values[3]);
      });
      let interval;
      if(!rows.complete)interval={status:'unavailable',reason:dimension.name==='cost'&&!currency?'Missing or incompatible currency cost':'Incomplete matched four-cell observations'};
      else if(dimension.name==='cost'&&bound===null)interval={status:'unavailable',reason:'No preregistered independently verified cost bound in the observed currency'};
      else if(dimension.name==='cost'&&allCosts.some(cost=>cost&&cost.amount>bound))interval={status:'unavailable',reason:'Observed episode cost exceeds the registered bound; no sample maximum is substituted'};
      else interval=clusterInterval(rows.rows,{lower:dimension.lower,upper:dimension.upper,confidence:protocol.policies.statistics.confidence,comparisons:claimCount});
      return [dimension.name,{...statusValue(rows.estimate),unit:dimension.unit,...(dimension.name==='cost'?{currency}:{}),
        interval,case_values:rows.rows,complete:rows.complete,
        cells:conditions.map(row=>({condition_id:row.id,estimate:results.get(row.id).metrics[dimension.source].estimate})),
        formula:'(cell_0 - cell_1) - (cell_2 - cell_3)/v1',paired_units:joint.length,
        inference_role:spec.origin?'exploratory':'preregistered',causal_claim:false}];
    }));
    const quality=metrics.quality;
    return {id:spec.id,kind,status:quality.status==='available'?'descriptive':'unavailable',
      estimate:quality.estimate,interval:quality.interval,cells:quality.cells,formula:quality.formula,primary_dimension:'quality',metrics,
      contrast:{positive_pair:[a.id,b.id],negative_pair:[c.id,d.id]},
      paired_units:joint.map(row=>({case_id:row.slot.case_id,repeat:row.slot.repeat,seed:row.records[0].slot.seed,pair_ids:row.pairs.map(p=>p.id),
        outcomes:row.records.map(outcomeFor),episode_ids:row.records.map(r=>r.episode?.identity.episode_id??null)})),
      origin:spec.origin??'preregistered-plan',confirmation:!spec.origin&&plan.confirmation===true,
      confirmation_status:spec.origin?'exploratory_only':plan.confirmation?'preregistered_confirmation_analysis':'not_confirmation',causal_claim:false};
  });
  return {status:output.some(x=>x.status==='descriptive')?'descriptive':'unavailable',comparisons:output,
    interpretation:'Paired four-cell quality, capped-time and complete currency-cost contrasts, averaged within cases before cluster inference. Exploratory combinations do not become confirmation claims.'};
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
