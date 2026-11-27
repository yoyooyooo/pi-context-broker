import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const read=async name=>JSON.parse(await readFile(join(root,name),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const result=await read('results.json');
const integrity=await read('integrity.json');
for(const file of integrity.files)assert.equal(hash(await readFile(join(root,file.path))),file.sha256,file.path);
assert.equal(result.issue,'AH-1363');
const rows=result.observations;
assert.deepEqual(rows.map(r=>r.id),['B0-r0','G-r0','G-r1','B0-r1']);
assert.equal(new Set(rows.map(r=>r.id)).size,4);
assert.ok(rows.every(r=>r.validity==='valid'));
const metrics=['model_requests','input_tokens','output_tokens','duration_ms'];
const close=(a,b)=>assert.ok(Math.abs(a-b)<=Math.max(1e-8,Math.abs(a)*1e-12),`${a} != ${b}`);
for(const key of metrics)close(result.totals[key],rows.reduce((n,r)=>n+r.usage[key],0));
for(const arm of ['B0','G'])for(const key of metrics)close(result.arm_totals[arm][key],rows.filter(r=>r.arm===arm).reduce((n,r)=>n+r.usage[key],0));
for(const pair of result.pairs){
 const b=rows.find(r=>r.id===pair.baseline),g=rows.find(r=>r.id===pair.candidate);
 assert.equal(pair.direction,'G/B0');
 close(pair.input_ratio,g.usage.input_tokens/b.usage.input_tokens);
 close(pair.observed_elapsed_ratio,g.usage.duration_ms/b.usage.duration_ms);
 assert.equal(pair.capped_time_ratio,1);
}
for(const row of rows){
 assert.equal(row.gateway.requests,row.usage.model_requests);
 assert.equal(row.gateway.input_tokens+row.gateway.cache_read_tokens,row.usage.input_tokens);
 assert.equal(row.gateway.output_tokens,row.usage.output_tokens);
 assert.equal(row.scorer_capped_time_ms,600000);
 assert.equal(row.final_answer_delivered,typeof row.final_answer_sha256==='string');
}
for(const key of Object.keys(result.gateway_totals))close(result.gateway_totals[key],rows.reduce((n,r)=>n+r.gateway[key],0));
assert.deepEqual(rows.map(r=>r.independent_business_semantics),['unknown','unknown','fail','unknown']);
assert.deepEqual(rows.map(r=>r.generic_outcome),['fail','fail','unknown','fail']);
assert.equal(result.generic_analysis.candidate,'B0');assert.equal(result.generic_analysis.reference,'G');
close(result.generic_analysis.input_ratio,1/result.aggregate_resource_ratios.input);
assert.equal(result.decision.status,'no_adoption');assert.equal(result.decision.candidate_confirmed_passes,0);
assert.equal(result.decision.confirmation_opened,false);assert.equal(result.decision.product_changed,false);
assert.equal(rows.filter(r=>r.final_answer_delivered).length,1);
assert.equal(rows.filter(r=>r.blinding.known_condition_path_exposure).length,1);
assert.equal(hash(await readFile(join(root,result.source.G_patch))),result.source.G_patch_sha256);
console.log(JSON.stringify({status:'passed',slots:rows.length,valid:4,model_requests:result.totals.model_requests,input_tokens:result.totals.input_tokens,output_tokens:result.totals.output_tokens,decision:result.decision.status,model_calls_performed:0}));
