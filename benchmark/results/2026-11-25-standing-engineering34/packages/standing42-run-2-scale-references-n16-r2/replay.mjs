import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,resolve,isAbsolute,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fingerprint} from './offline/benchmark/protocol.mjs';
import {scoreExperiment} from './offline/benchmark/analysis/compare.mjs';
import {writeAnalysisReport} from './offline/benchmark/analysis/report.mjs';
import {verifyBundle} from './offline/benchmark/evidence/store.mjs';
const root=dirname(fileURLToPath(import.meta.url)),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function verifyBinaryPublication(manifest, episodes) {
  const approved = manifest.policy.reviewed_binary_artifacts ?? [];
  assert.ok(Array.isArray(approved));
  const bySha = new Map(approved.map(entry => [entry.sha256, entry]));
  assert.equal(bySha.size, approved.length, 'Duplicate public binary approval');
  const rows = manifest.raw_mapping.filter(row => row.format === 'binary');
  assert.equal(rows.length, approved.length, 'Public binary approvals differ from the released files');
  for (const row of rows) {
    const entry = bySha.get(row.source_sha256); assert.ok(entry, 'Public binary approval missing');
    assert.equal(entry.kind, 'source-bytes'); assert.equal(entry.purpose, 'public-synthetic-fixture');
    assert.equal(entry.bytes, row.source_bytes); assert.equal(row.source_bytes, row.public_bytes);
    assert.equal(row.source_sha256, row.public_sha256); assert.equal(row.changed, false);
  }
  for (const episode of episodes) for (const artifact of episode.artifacts) {
    const entry = bySha.get(artifact.sha256);
    if (entry) assert.equal(artifact.kind, entry.kind, 'Public binary artifact kind mismatch');
  }
}
const manifest=JSON.parse(await readFile(join(root,'public-manifest.json'),'utf8'));
assert.equal(manifest.kind,'benchmark-public-evidence-package');
assert.equal(manifest.manifest_sha256,fingerprint({...manifest,manifest_sha256:null}));
assert.equal(manifest.raw_mapping_sha256,fingerprint(manifest.raw_mapping));
for(const file of manifest.files){
 assert.ok(!isAbsolute(file.path));
 const path=resolve(root,file.path),part=relative(root,path);
 assert.ok(part && part!=='..' && !part.startsWith('..'+sep) && !isAbsolute(part));
 const bytes=await readFile(path);assert.equal(hash(bytes),file.sha256);assert.equal(bytes.length,file.bytes);
}
const input=JSON.parse(await readFile(join(root,'analysis-input.json'),'utf8'));
verifyBinaryPublication(manifest,input.episodes);
const pathsBySha256=Object.fromEntries(manifest.raw_mapping.map(item=>[item.public_sha256,join(root,item.public_path)]));
const publicProjection={raw_mapping_sha256:manifest.raw_mapping_sha256,raw_mapping:manifest.raw_mapping};
for(const episode of input.episodes)await verifyBundle({episode},{root,pathsBySha256,publicProjection});
const analysis=scoreExperiment(input);assert.equal(analysis.analysis_sha256,manifest.public_analysis_sha256);
const flag=process.argv.indexOf('--out');
if(flag>=0){assert.ok(process.argv[flag+1] && isAbsolute(process.argv[flag+1]));await writeAnalysisReport({directory:resolve(process.argv[flag+1]),analysis});}
process.stdout.write(JSON.stringify({status:'verified',scope:manifest.replay_scope,analysis_sha256:analysis.analysis_sha256,original_analysis_sha256:manifest.source_analysis_sha256,model_requests:0})+'\n');
