import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fingerprint} from './protocol.mjs';
import {normalizeEpisode} from './evidence/normalize.mjs';
import {exampleProtocol,exampleEnvelope,exampleEpisode,exampleEpisodes} from './analysis/fixtures.mjs';
import {clusterInterval,differenceInterval,ratioInterval} from './analysis/statistics.mjs';
import {scoreExperiment,createAnalysisPlan,costFrontier,differenceInDifferences,selectRegression,releasePolicy} from './analysis/compare.mjs';
import {METRIC_ENTRIES,evaluateMetric} from './analysis/metrics.mjs';
import {reportTables,renderMetricSvg,writeAnalysisReport} from './analysis/report.mjs';
const run=promisify(execFile);
const score=(protocol,episodes,plan)=>scoreExperiment({protocol,episodes,plan});

test('fixed family weight and case mean differ correctly from pooled episode rate',()=>{
  const p=exampleProtocol(),episodes=exampleEpisodes(p).map(e=>e.identity.condition_id==='candidate'&&e.identity.case_id==='c2'?
    exampleEpisode({caseId:'c2',outcome:'fail'}):e);
  const result=score(p,episodes),c=result.conditions[0];
  assert.equal(c.metrics.verified_quality.estimate,.75);
  assert.equal(c.metrics.verified_quality.valid_episode_ratio,2/3);
  assert.equal(c.metrics.known_failure.estimate,.25);
  assert.equal(c.metrics.input_total.estimate,100);
});
test('repeat averaging and shared materials never multiply independent clusters',()=>{
  const p1=exampleProtocol(),p2=exampleProtocol({repeats:4});
  const a=score(p1,exampleEpisodes(p1)),b=score(p2,exampleEpisodes(p2));
  assert.deepEqual(a.conditions[0].metrics.verified_quality.interval,b.conditions[0].metrics.verified_quality.interval);
  assert.equal(b.conditions[0].metrics.verified_quality.interval.clusters,2);
});
test('all-success paired ties have nonzero conservative width and do not prove 3pp noninferiority',()=>{
  const p=exampleProtocol(),s=score(p,exampleEpisodes(p)),comparison=s.comparisons[0];
  assert.equal(comparison.quality_delta.estimate,0);
  assert.ok(comparison.quality_delta.interval.lower<-.03);
  assert.ok(comparison.quality_delta.interval.upper>0);
  assert.equal(comparison.decision.status,'inconclusive');
});
test('weighted cluster duplication leaves interval width invariant',()=>{
  const rows=[{cluster_id:'a',weight:.4,value:1},{cluster_id:'b',weight:.6,value:0}];
  const split=rows.flatMap(r=>[{...r,weight:r.weight/2},{...r,weight:r.weight/2}]);
  assert.deepEqual(clusterInterval(rows),clusterInterval(split));
});
test('conservative boundary covers exact Bernoulli enumeration including no and few failures',()=>{
  const choose=(n,k)=>{let v=1;for(let i=1;i<=k;i++)v=v*(n-i+1)/i;return v;};
  for(let n=1;n<=12;n++)for(let step=0;step<=20;step++) {
    const p=step/20;let noncoverage=0;
    for(let k=0;k<=n;k++) {
      const ci=clusterInterval(Array.from({length:n},(_,i)=>({cluster_id:String(i),weight:1/n,value:i<k?1:0})));
      if(p<ci.lower-1e-12||p>ci.upper+1e-12)noncoverage+=choose(n,k)*p**k*(1-p)**(n-k);
    }
    assert.ok(noncoverage<=.05+1e-10,'n='+n+' p='+p+' noncoverage='+noncoverage);
  }
});
test('missing usage on one side retains failure costs and known subtotal, no partial ratio',()=>{
  const p=exampleProtocol(),episodes=exampleEpisodes(p).map(e=>e.identity.condition_id==='candidate'&&e.identity.case_id==='c2'?
    exampleEpisode({caseId:'c2',outcome:'fail',attemptInputs:[100,null]}):e);
  const s=score(p,episodes);
  assert.equal(s.conditions[0].metrics.input_total.status,'unknown');
  assert.equal(s.conditions[0].metrics.input_total.known_subtotal,300);
  assert.equal(s.comparisons[0].input_ratio.status,'unknown');
  assert.equal(s.cost_ledger.known_input_subtotal,600);
});
test('invalid original and explicitly linked replacement retain distinct actual costs',()=>{
  const p=exampleProtocol(),original=exampleEpisode({valid:false,episodeId:'original',attemptInputs:[70]});
  const replacement=exampleEpisode({retestOf:'original',episodeId:'replacement',attemptInputs:[100]});
  const episodes=exampleEpisodes(p).filter(e=>!(e.identity.condition_id==='candidate'&&e.identity.case_id==='c1'));
  const s=score(p,[original,replacement,...episodes]);
  assert.equal(s.cost_ledger.actual_runs,7);assert.equal(s.cost_ledger.invalid_runs,1);
  assert.equal(s.cost_ledger.known_input_subtotal,670);
  assert.equal(s.conditions[0].metrics.verified_quality.estimate,1);
  assert.equal(s.cost_ledger.invalid[0].input_total.value.value,70);
});
test('missing or invalid-only planned slot prevents a complete quality conclusion without becoming failure',()=>{
  const p=exampleProtocol(),episodes=exampleEpisodes(p).filter(e=>!(e.identity.condition_id==='candidate'&&e.identity.case_id==='c1'));
  const s=score(p,[...episodes,exampleEpisode({valid:false})]);
  const c=s.conditions[0];
  assert.equal(c.metrics.verified_quality.status,'unknown');assert.equal(c.counts.fail,0);
  assert.equal(c.metrics.verified_quality.planned_verified_lower_bound,.5);
  assert.equal(c.metrics.verified_quality.valid_episode_ratio,1);
  assert.equal(s.completeness.unresolved_slots.length,1);
});
test('one original cannot gain a sample through reanalysis or two valid outcome choices',()=>{
  const p=exampleProtocol(),episodes=exampleEpisodes(p),a=score(p,[...episodes,episodes[0]]);
  assert.equal(a.cost_ledger.actual_runs,6);
  assert.throws(()=>score(p,[...episodes,exampleEpisode({episodeId:'another'})]),/Multiple valid/);
});
test('all failures use capped time and cost per success/p95 are not_reached',()=>{
  const p=exampleProtocol(),s=score(p,exampleEpisodes(p,{outcome:'fail',duration:10,cost:.1}));
  const c=s.conditions[0].metrics;
  assert.equal(c.capped_time.estimate,1000);
  assert.equal(c.capped_time.raw_elapsed_ms.estimate,10);
  assert.equal(c.cost_per_success.status,'not_reached');
  assert.equal(c.capped_time.p95_success_time.status,'not_reached');
});
test('unknown outcomes get no success credit without becoming known failures',()=>{
  const p=exampleProtocol(),s=score(p,exampleEpisodes(p,{outcome:'unknown'})),c=s.conditions[0].metrics;
  assert.equal(c.verified_quality.estimate,0);assert.equal(c.known_failure.estimate,0);assert.equal(c.evidence_coverage.estimate,0);
  assert.equal(c.success_identification_bounds.lower,0);assert.equal(c.success_identification_bounds.upper,1);
});
test('rescues affect Q_unassisted while ordinary successful quality remains',()=>{
  const p=exampleProtocol(),s=score(p,exampleEpisodes(p,{rescue:true}));
  assert.equal(s.conditions[0].metrics.verified_quality.estimate,1);
  assert.equal(s.conditions[0].metrics.unassisted_quality.estimate,0);
});
test('every outcome migration cell is preserved with unknowns',()=>{
  const cases=Array.from({length:9},(_,i)=>({id:'c'+i,family:'f1',cluster_id:'k'+i,material_id:'m'+i}));
  const p=exampleProtocol({cases}),states=['pass','fail','unknown'];
  const episodes=p.pairs.flatMap((pair,i)=>[
    exampleEpisode({condition:'candidate',caseId:pair.case_id,outcome:states[i%3]}),
    exampleEpisode({condition:'reference',caseId:pair.case_id,outcome:states[Math.floor(i/3)]}),
  ]);
  const cells=score(p,episodes).comparisons[0].version_transition.cells;
  assert.equal(cells.length,9);assert.ok(cells.every(c=>c.count===1));
  assert.ok(Math.abs(cells.reduce((n,c)=>n+c.weight,0)-1)<1e-12);
});
test('zero reference input uses absolute difference and no finite ratio interval',()=>{
  const p=exampleProtocol(),s=score(p,exampleEpisodes(p).map(e=>e.identity.condition_id==='reference'?
    exampleEpisode({condition:'reference',caseId:e.identity.case_id,attemptInputs:[0]}):e));
  assert.equal(s.comparisons[0].input_ratio.status,'undefined');
  assert.equal(s.comparisons[0].input_ratio.estimate,null);assert.equal(s.comparisons[0].input_ratio.absolute_difference,100);
  const interval=ratioInterval([{cluster_id:'a',weight:1,value:1}],[{cluster_id:'a',weight:1,value:0}],{upper:2});
  assert.equal(interval.status,'undefined');
});
test('critical confirmed failures reject before any efficiency tradeoff',()=>{
  const p=exampleProtocol(),s=score(p,exampleEpisodes(p,{criticalFail:true,attemptInputs:[1],duration:1}));
  assert.equal(s.comparisons[0].decision.status,'rejected');
  assert.equal(s.comparisons[0].decision.stage,'critical_contracts');
});
test('misuse rate denominator is episodes and cannot improve by adding useless tools',()=>{
  const p=exampleProtocol(),tool={id:'t',parent_id:null,name:'bad_call',args:{},status:'fail',interface_misuse:true};
  const a=score(p,exampleEpisodes(p,{tools:[tool]})),b=score(p,exampleEpisodes(p,{tools:[tool,...Array.from({length:20},(_,i)=>({...tool,id:'extra'+i,interface_misuse:false}))]}));
  assert.equal(a.conditions[0].metrics.interface_misuse_rate.estimate,1);
  assert.equal(b.conditions[0].metrics.interface_misuse_rate.estimate,1);
});
test('currency frontier excludes unknown cost and subthreshold quality',()=>{
  const quality={status:'available',estimate:.99,interval:{status:'available',lower:.98,upper:1}};
  const result=costFrontier([{id:'a',quality,cost:{status:'available',estimate:2,currency:'USD'},confirmation:true,scope:'same'},
    {id:'b',quality,cost:{status:'unknown',estimate:null},confirmation:true,scope:'same'},
    {id:'c',quality:{...quality,interval:{status:'available',lower:.9}},cost:{status:'available',estimate:1,currency:'USD'},confirmation:false,scope:'same'}],.95);
  assert.deepEqual(result.eligible,['a']);assert.equal(result.frontier[0].id,'a');
});
test('four-cell interactions reject missing cells and unverified common scope',()=>{
  const cells=[{estimate:.9},{estimate:.8},{estimate:.8},{estimate:.85}];
  assert.equal(differenceInDifferences({cells,comparable:false}).status,'unavailable');
  assert.equal(differenceInDifferences({cells:cells.slice(1),comparable:true}).status,'unavailable');
  assert.ok(Math.abs(differenceInDifferences({cells,comparable:true}).estimate-.15)<1e-12);
});
test('all 18 registered logical metric entries resolve only to appropriate declared scopes',()=>{
  const p=exampleProtocol(),analysis=score(p,exampleEpisodes(p));
  assert.equal(Object.keys(METRIC_ENTRIES).length,18);
  for(const entry of Object.keys(METRIC_ENTRIES))assert.notEqual(evaluateMetric(entry,{analysis,condition_id:'candidate',candidate:'candidate',reference:'reference'}),undefined);
  assert.throws(()=>evaluateMetric('metric:invented/v1',{analysis}),/Unsupported/);
});
test('regression selector uses impacted families and independent anchors within bounded cap',()=>{
  const p=exampleProtocol(),selection=selectRegression({cases:p.corpus.cases,anchorCaseIds:['c1'],changedFamilies:['f2'],maxCases:2});
  assert.deepEqual(selection.case_ids,['c1','c2']);assert.equal(selection.noninferiority_proof,false);
  const analysis=score(p,exampleEpisodes(p));assert.equal(releasePolicy(analysis).status,'inconclusive');
});
test('changed family weights or unknown inference method cannot silently alter analysis',()=>{
  const p=exampleProtocol(),episodes=exampleEpisodes(p);
  p.policies.statistics.family_weights=[{family:'f1',weight:1}];p.protocol_sha256=fingerprint({...p,protocol_sha256:null});assert.throws(()=>score(p,episodes),/family weights/);
  p.policies.statistics.interval_method='naive-bootstrap';assert.throws(()=>score(p,episodes),/Unsupported/);
});
test('reports preserve source values and unknown labels without fabricated points',()=>{
  const p=exampleProtocol(),analysis=score(p,exampleEpisodes(p,{attemptInputs:[null]}));
  assert.equal(reportTables(analysis).conditions[0].input_total,null);
  const svg=renderMetricSvg(analysis,{metric:'input_total'});
  assert.match(svg,/<svg/);assert.match(svg,/unknown/);assert.doesNotMatch(svg,/NaN|Infinity/);
});
test('offline evidence package independently verifies raw and regenerates identical analysis without models',async()=>{
  const root=await mkdtemp(join(tmpdir(),'benchmark-replay-test-')),p=exampleProtocol(),episodes=[];
  for(const pair of p.pairs)for(const condition of pair.condition_ids) {
    const rawPath=join(root,condition+'-'+pair.case_id+'.json');
    const fixture=exampleEnvelope({condition,caseId:pair.case_id,rawPath});
    await writeFile(rawPath,fixture.rawText);episodes.push(normalizeEpisode(fixture.input).episode);
  }
  const input={protocol:p,episodes},analysis=scoreExperiment(input),directory=join(root,'package');
  await writeAnalysisReport({directory,analysis,input,rawRoot:root});
  const out=join(root,'replayed'),result=await run(process.execPath,[join(directory,'replay.mjs'),'--out',out]);
  assert.equal(JSON.parse(result.stdout).model_requests,0);
  assert.equal(JSON.parse(await readFile(join(out,'analysis.json'),'utf8')).analysis_sha256,analysis.analysis_sha256);
  assert.equal(JSON.parse(await readFile(join(directory,'report-manifest.json'),'utf8')).raw_evidence_included,true);
});

test('observed four-cell model interaction is calculated only across the same scope and windows',()=>{
  const p=exampleProtocol();
  const added=p.conditions.map(c=>({...c,id:c.id+'-new',model_id:'new-model'}));
  p.models.push({id:'new-model',backend:{window:{start:'2026-01-01',end:'2026-01-02'}}});
  p.conditions.push(...added);
  p.pairs.push(...p.pairs.map(pair=>({...pair,id:pair.id+'-new',condition_ids:pair.condition_ids.map(id=>id+'-new')})));
  const episodes=exampleEpisodes(p).map(e=>e.identity.condition_id==='candidate-new'&&e.identity.case_id==='c1'?
    exampleEpisode({condition:'candidate-new',caseId:'c1',outcome:'fail'}):e);
  p.protocol_sha256=fingerprint({...p,protocol_sha256:null});
  const result=score(p,episodes).model_environment_interaction;
  assert.equal(result.status,'descriptive');
  assert.equal(result.comparisons[0].estimate,.5);
  p.models[1].backend.window.end='2026-02-01';p.protocol_sha256=fingerprint({...p,protocol_sha256:null});
  assert.equal(score(p,episodes).model_environment_interaction.status,'unavailable');
});
test('declared Code Mode interaction uses four actual paired cells',()=>{
  const p=exampleProtocol();
  const added=p.conditions.map(c=>({...c,id:c.id+'-code',environment_id:c.environment_id+'-code',code_mode:'required'}));
  p.conditions.push(...added);
  p.pairs.push(...p.pairs.map(pair=>({...pair,id:pair.id+'-code',condition_ids:pair.condition_ids.map(id=>id+'-code')})));
  p.protocol_sha256=fingerprint({...p,protocol_sha256:null});
  const plan=createAnalysisPlan(p);
  plan.interactions=[{id:'code-interaction',kind:'code_mode',condition_ids:['candidate','reference','candidate-code','reference-code'],
    environment_pairs:[['candidate-environment','reference-environment'],['candidate-environment-code','reference-environment-code']]}];
  const result=score(p,exampleEpisodes(p),plan).code_mode_interaction;
  assert.equal(result.status,'descriptive');assert.equal(result.comparisons[0].estimate,0);
  assert.ok(result.comparisons[0].interval.lower<0);
});

test('changed frozen weights cannot retain the original protocol identity',()=>{
  const p=exampleProtocol(),episodes=exampleEpisodes(p);
  p.policies.statistics.family_weights[0].weight=.7;
  p.policies.statistics.family_weights[1].weight=.3;
  assert.throws(()=>scoreExperiment({protocol:p,episodes}),/Frozen protocol fingerprint/);
});
test('semantic normalizer versions cannot silently share one frozen analysis stratum',()=>{
  const p=exampleProtocol(),episodes=exampleEpisodes(p);
  p.policies.evidence={normalizer_version:'1.0.0'};p.protocol_sha256=fingerprint({...p,protocol_sha256:null});
  episodes[0].normalizer_version='2.0.0';episodes[0].episode_sha256=fingerprint({...episodes[0],episode_sha256:null});
  assert.throws(()=>scoreExperiment({protocol:p,episodes}),/separate explicit analysis stratum/);
});
