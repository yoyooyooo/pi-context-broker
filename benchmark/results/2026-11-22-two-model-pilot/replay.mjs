import assert from 'node:assert/strict';
import {readFile,readdir,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {deriveReleaseEvidence} from './accounting.mjs';
const root=await realpath(dirname(fileURLToPath(import.meta.url))),hash=b=>createHash('sha256').update(b).digest('hex');
const read=async p=>JSON.parse(await readFile(join(root,p),'utf8'));
const manifest=await read('release-manifest.json');
assert.equal(manifest.kind,'benchmark-two-model-results-release');
assert.equal(hash(JSON.stringify({...manifest,manifest_sha256:null})),manifest.manifest_sha256);
const declared=new Set();
for(const item of manifest.files){
 assert.ok(!isAbsolute(item.path));const p=await realpath(resolve(root,item.path)),part=relative(root,p);
 assert.ok(part&&part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part));
 assert.ok(!declared.has(item.path));declared.add(item.path);
 const b=await readFile(p);assert.equal(hash(b),item.sha256,item.path);assert.equal(b.length,item.bytes,item.path);
}
async function enumerate(dir,prefix=''){const out=[];for(const item of await readdir(dir,{withFileTypes:true})){const name=prefix+item.name;if(item.isDirectory())out.push(...await enumerate(join(dir,item.name),name+'/'));else{assert.ok(item.isFile());out.push(name);}}return out;}
assert.deepEqual((await enumerate(root)).sort(),[...declared,'release-manifest.json'].sort());
const childEnv={PATH:dirname(process.execPath)+':/usr/bin:/bin',LANG:'C.UTF-8'};
for(const p of ['history',...manifest.packages.filter(x=>x.role!=='history').map(x=>x.path)]){
 const receipt=JSON.parse(execFileSync(process.execPath,[join(root,p,'replay.mjs')],{encoding:'utf8',env:childEnv,timeout:60000,maxBuffer:16777216}).trim());
 assert.equal(receipt.status,'verified');assert.equal(receipt.model_requests,0);
 if(p==='history')assert.equal(receipt.release_manifest_sha256,manifest.history.release_manifest_sha256);
}
const groups=[];for(const descriptor of manifest.packages)groups.push({descriptor,input:await read(descriptor.path+'/analysis-input.json'),analysis:await read(descriptor.path+'/analysis.json'),manifest:await read(descriptor.path+'/public-manifest.json')});
const reservations=[];for(const item of manifest.reservations)reservations.push({...item,receipt:await read(item.path)});
const scopeDocuments=[];for(const item of manifest.scope_projections)scopeDocuments.push(await read(item.path));
const revisionDocuments=[];for(const item of manifest.analysis_revision_projections??[]){const value=await read(item.path);assert.equal(value.source_file_sha256,item.source_sha256);revisionDocuments.push(value);}
const derived=deriveReleaseEvidence({groups,reservations,intent:await read('coverage-intent.json'),scopeDocuments,revisionDocuments});
assert.deepEqual(derived.accounting,await read('accounting.json'));assert.deepEqual(derived.coverage,await read('coverage.json'));
process.stdout.write(JSON.stringify({status:'verified',release_manifest_sha256:manifest.manifest_sha256,shared_campaign:derived.accounting.shared_campaign,coverage:derived.coverage,scope:'Public hashes, locators, separate-plan normalized analyses and physical-reservation accounting; no private regrading or private gate rerun',model_requests:0})+'\n');
