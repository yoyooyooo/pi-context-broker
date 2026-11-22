export const METRIC_VERSION='1.0.0';
const names={
  verified_quality:'metric:quality.verified/v1',
  known_failure:'metric:quality.known_failure/v1',
  evidence_coverage:'metric:quality.coverage/v1',
  success_identification_bounds:'metric:quality.identification_bounds/v1',
  input_first:'metric:context.first/v1',
  input_peak:'metric:context.peak/v1',
  input_total:'metric:context.total/v1',
  input_ratio:'metric:context.ratio/v1',
  capped_time:'metric:time.capped/v1',
  time_ratio:'metric:time.ratio/v1',
  success_by_budget:'metric:budget.quality/v1',
  unassisted_quality:'metric:quality.unassisted/v1',
  interface_misuse_rate:'metric:interface.misuse/v1',
  cost_per_success:'metric:cost.per_success/v1',
  version_transition:'metric:quality.transitions/v1',
  model_environment_interaction:'metric:interaction.model_environment/v1',
  code_mode_interaction:'metric:interaction.code_mode/v1',
  cost_frontier:'metric:cost.frontier/v1',
};
const paired=new Set(['input_ratio','time_ratio','version_transition']);
const global=new Set(['model_environment_interaction','code_mode_interaction','cost_frontier']);
export const METRIC_ENTRIES=Object.freeze(Object.fromEntries(Object.entries(names).map(([id,entry])=>[entry,{
  id,entry,version:METRIC_VERSION,scope:global.has(id)?'experiment':paired.has(id)?'comparison':'condition',
  ...(id==='verified_quality'?{unit:'percent',value_path:'condition.metrics.verified_quality.score_percent'}:{}),
}])));
export function evaluateMetric(entry,{analysis,condition_id,candidate,reference}) {
  const definition=METRIC_ENTRIES[entry];
  if(!definition)throw new Error('Unsupported versioned metric entry: '+entry);
  if(analysis?.kind!=='benchmark-analysis')throw new Error('A scored versioned experiment is required');
  if(definition.scope==='experiment')return analysis[definition.id];
  if(definition.scope==='comparison') {
    const comparison=analysis.comparisons.find(c=>c.candidate===candidate&&c.reference===reference);
    if(!comparison)throw new Error('No such preregistered oriented comparison');
    return comparison[definition.id];
  }
  const condition=analysis.conditions.find(c=>c.condition_id===condition_id);
  if(!condition)throw new Error('No such analyzed condition');
  const value=condition.metrics[definition.id];
  if(definition.id==='verified_quality') {
    if(!value.score_percent)throw new Error('The declared percentage entry requires analysis 1.1.0; replay historical analyses with their retained implementation');
    return {...value.score_percent,quality_ratio:{unit:'ratio',status:value.status,estimate:value.estimate,interval:value.interval},
      analysis_version:analysis.analysis_version};
  }
  return value;
}
