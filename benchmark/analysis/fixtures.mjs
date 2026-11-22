// Synthetic unit-test observations only. Never import these as model executions.
import {createHash} from 'node:crypto';
import {canonicalJson,fingerprint} from '../protocol.mjs';
import {normalizeEpisode,known,unknown} from '../evidence/normalize.mjs';
import {INTERVAL_METHOD,BOUNDARY_METHOD,MULTIPLICITY_METHOD} from './statistics.mjs';
export function exampleProtocol({repeats=1,cases=[
  {id:'c1',family:'f1',cluster_id:'k1',material_id:'m1'},
  {id:'c2',family:'f2',cluster_id:'k2',material_id:'m2'},
  {id:'c3',family:'f2',cluster_id:'k2',material_id:'m3'},
]}={}) {
  const conditions=['candidate','reference'].map(id=>({id,environment_id:id+'-environment',model_id:'model',
    case_ids:cases.map(c=>c.id),budget_id:'budget',corpus_id:'unit-corpus',corpus_sha256:'a'.repeat(64),
    initial_state_sha256:'b'.repeat(64),authorization_sha256:'c'.repeat(64),code_mode:'free'}));
  const families=[...new Set(cases.map(c=>c.family))];
  const protocol={schema_version:1,id:'unit-experiment',protocol_sha256:'d'.repeat(64),phase:'pilot',
    corpus:{id:'unit-corpus',cases},conditions,models:[{id:'model',backend:{window:{start:'2026-01-01',end:'2026-01-02'}}}],
    pairs:cases.flatMap(c=>Array.from({length:repeats},(_,repeat)=>({id:c.id+'-r'+repeat,case_id:c.id,repeat,seed:repeat,condition_ids:['candidate','reference']}))),
    assessments:[],metrics:{primary:['verified_quality','input_ratio','time_ratio','unassisted_quality']},
    policies:{statistics:{confidence:0.95,interval_method:INTERVAL_METHOD,boundary_method:BOUNDARY_METHOD,multiple_comparisons:MULTIPLICITY_METHOD,
      family_weights:families.map(family=>({family,weight:1/families.length})),cluster_unit:'cluster_id',case_aggregation:'mean_repeats'},
      budgets:[{id:'budget',episode:{max_duration_ms:1000,max_input_tokens:10000}}],
      decision:{mode:'acceptance',absolute_quality_required:.95,unassisted_quality_required:.95,quality_delta_min:-.03,
        input_ratio_max:1.1,capped_time_ratio_max:1.15,efficiency_ratio_max:null}}};
  protocol.protocol_sha256=fingerprint({...protocol,protocol_sha256:null});
  return protocol;
}
export function exampleEnvelope({condition='candidate',caseId='c1',repeat=0,outcome='pass',valid=true,
  capability='supported',attemptInputs=[100],inputSemantics='includes_cache',cacheRead=80,cacheWrite=0,
  attemptsComplete=true,interventionsComplete=true,rescue=false,tools=[],criticalFail=false,duration=100,
  successTime=100,cost=null,retestOf=null,episodeId=null,rawPath='/unit/raw.json',adapterVerified=true}={}) {
  const episode_id=episodeId??condition+'-'+caseId+'-'+repeat;
  const raw={unit_test_only:true,identity:{episode_id},admission:{valid,attemptsComplete,interventionsComplete},
    attempts:attemptInputs.map((input,i)=>({id:'a'+i,input,cacheRead,cacheWrite,output:10,reasoning:5})),
    business:{outcome,capability},contracts:[{id:'business-contract',status:criticalFail?'fail':'pass',critical:criticalFail}],
    tools,interventions:rescue?[{id:'rescue-1',kind:'human_rescue'}]:[],timing:{duration,successTime}};
  const text=canonicalJson(raw)+'\n',sha256=createHash('sha256').update(text).digest('hex');
  const artifact={id:'raw',path:rawPath,sha256,bytes:Buffer.byteLength(text),kind:'json'};
  const ref=pointer=>({artifact_id:'raw',sha256,pointer});
  const fact=(value,pointer)=>value===null?unknown('Unit fixture has missing observation',[ref(pointer)]):known(value,[ref(pointer)],'reported');
  return {rawText:text,input:{
    identity:{episode_id,run_id:'run-'+episode_id,experiment_id:'unit-experiment',condition_id:condition,case_id:caseId,repeat,
      ...(retestOf?{retest_of:retestOf}:{})},
    admission:{status:valid?'valid':'invalid',reasons:valid?[]:['unit admission failure'],refs:[ref('/admission')],
      completeness:{attempts:attemptsComplete?'complete':'partial',tools:'complete',interventions:interventionsComplete?'complete':'partial'}},
    attempts:raw.attempts.map((a,i)=>({id:a.id,request_id:'request-'+i,seq:i,sent:true,refs:[ref('/attempts/'+i)],
      adapter:{id:'unit-adapter',version:'1',verified:adapterVerified,evidence_sha256:sha256,input_semantics:inputSemantics,output_semantics:'includes_reasoning'},
      usage:{input:fact(a.input,'/attempts/'+i+'/input'),output:fact(a.output,'/attempts/'+i+'/output'),
        cache_read:fact(cacheRead,'/attempts/'+i+'/cacheRead'),cache_write:fact(cacheWrite,'/attempts/'+i+'/cacheWrite'),
        reasoning:fact(5,'/attempts/'+i+'/reasoning')},
      ...(cost===null?{}:{cost:known({amount:cost,currency:'USD'},[ref('/attempts/'+i)],'reported'),pricing_verified:true})})),
    tools:tools.map((t,i)=>({...t,refs:[ref('/tools/'+i)]})),
    business:{status:outcome,capability_status:capability,capability_scope:'common',refs:[ref('/business')]},
    contracts:raw.contracts.map((c,i)=>({...c,refs:[ref('/contracts/'+i)]})),
    interventions:raw.interventions.map((i,index)=>({...i,refs:[ref('/interventions/'+index)]})),
    timing:{duration_ms:fact(duration,'/timing/duration'),time_to_success_ms:fact(successTime,'/timing/successTime')},
    artifacts:[artifact],
  }};
}
export function exampleEpisode(options={}) {return normalizeEpisode(exampleEnvelope(options).input).episode;}
export function exampleEpisodes(protocol,options={}) {
  return protocol.pairs.flatMap(pair=>pair.condition_ids.map(condition=>exampleEpisode({...options,condition,caseId:pair.case_id,repeat:pair.repeat})));
}
