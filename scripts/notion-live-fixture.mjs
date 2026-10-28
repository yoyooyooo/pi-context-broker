import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
const save=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n');
import { invokeJson } from './verification-command.mjs';
import { archiveOwnedFixture } from './notion-fixture-cleanup.mjs';
export async function createLiveFixture({scratch,evidence,command,database,onOwned,resumeEvidence,ntnCommand=['ntn']}) {
 let directory,name,alias,canary,resourceCanary,created;
 if(!resumeEvidence){let prior;try{prior=JSON.parse(await readFile(join(evidence,'live-fixture-intent.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}assert.ok(!prior,'Existing fixture intent must be reconciled by exact ID; create will not be repeated');}
 const invoke = (cmd, args, input) => invokeJson(cmd, args, { input, cwd: scratch, evidence: join(evidence, 'command-receipts.jsonl'), category: 'live-fixture', deadline: args[0] === 'create' ? 900000 : 120000 });
 const listedDatabase=await invoke(ntnCommand,['api',`v1/databases/${database}`,'--notion-version','2026-03-11']);
 const dataSources=listedDatabase.data_sources??[];assert.ok(dataSources.length,'Live fixture requires database data source metadata');
 const schemaReceipts=[];
 for(const source of dataSources){
  const schema=await invoke(ntnCommand,['api',`v1/data_sources/${source.id}`,'--notion-version','2026-03-11']);
  const existing=schema.properties?.['Default Context'];assert.ok(!existing||existing.type==='checkbox','Default Context property must be a checkbox');
  if(!existing)await invoke(ntnCommand,['api',`v1/data_sources/${source.id}`,'--notion-version','2026-03-11','-X','PATCH','--data','@-'],{properties:{'Default Context':{checkbox:{}}}});
  const observed=await invoke(ntnCommand,['api',`v1/data_sources/${source.id}`,'--notion-version','2026-03-11']);assert.equal(observed.properties?.['Default Context']?.type,'checkbox');
  schemaReceipts.push({dataSourceId:source.id,property:'Default Context',type:'checkbox',added:!existing});
 }
 await save(join(evidence,'live-fixture-schema.json'),schemaReceipts);
 if(resumeEvidence){
  assert.ok(isAbsolute(resumeEvidence),'Resume evidence must be absolute');const previous=JSON.parse(await readFile(join(resumeEvidence,'manifest.json'),'utf8'));const oldScratch=await realpath(previous.scratch);assert.equal((JSON.parse(await readFile(join(oldScratch,'ownership.json'),'utf8'))).evidence,resumeEvidence,'Resume scratch must belong to supplied evidence');directory=join(oldScratch,'live-fixture-input');const manifest=JSON.parse(await readFile(join(directory,'.ntn-skills.json'),'utf8'));name=manifest.name;assert.match(name,/^Broker Integration [a-p]{32}$/);alias=name.toLowerCase().replaceAll(' ','-');const suffix=name.split(' ').at(-1);canary='BROKER_LIVE_BODY_'+suffix;resourceCanary='BROKER_LIVE_RESOURCE_'+suffix;
  const prior=JSON.parse(await readFile(join(resumeEvidence,'live-fixture-create.json'),'utf8'));assert.equal(prior.owned,true);assert.ok(prior.pageId,'Recovery requires exact original page ID; reconcile original operation receipt first');
  const listed=await invoke(command,['list','--database',database,'--refresh']);assert.deepEqual(listed.coverage?.failed_sources,[]);const matches=listed.records.filter(skill=>skill.locator?.page_id===prior.pageId&&skill.name===name&&skill.locator.database_id.replaceAll('-','')===database.replaceAll('-',''));assert.equal(matches.length,1,'Recovery must select the exact owned fixture ID');created={record:matches[0],operation_id:prior.operationId};const observed=await invoke(command,['read',`skill://${created.record.locator.page_id}/SKILL.md`,'--refresh']);assert.ok(observed.content.includes(canary),'Recovery must match owned source body');created.snapshot_id=observed.snapshot_id;created.version_id=observed.version_id;
  await save(join(evidence,'live-fixture-recovery.json'),{recoveredFrom:resumeEvidence,pageId:created.record.locator.page_id,name,database,sourceInput:directory,snapshotId:observed.snapshot_id,bodyOwnershipVerified:true});
 }else{
  directory=join(scratch,'live-fixture-input');await mkdir(join(directory,'references'),{recursive:true});const suffix=[...randomUUID().replaceAll('-','')].map(char=>String.fromCharCode(97+parseInt(char,16))).join('');name='Broker Integration '+suffix;alias=name.toLowerCase().replaceAll(' ','-');canary='BROKER_LIVE_BODY_'+suffix;resourceCanary='BROKER_LIVE_RESOURCE_'+suffix;
  await save(join(directory,'.ntn-skills.json'),{format:'ntn-skills',version:2,kind:'skill',name,description:'Use this ledger verification skill to inspect the linked guide and report its boundary check.',main:'SKILL.md'});await writeFile(join(directory,'SKILL.md'),`---\nname: ${alias}\ndescription: Use this ledger verification skill to inspect the linked guide and report its boundary check.\n---\n${canary}\nRead [the guide](references/guide.md) before answering ledger verification questions.\n`);await writeFile(join(directory,'references/guide.md'),resourceCanary+'\nBoundary check: verified.\n');
  await save(join(evidence,'live-fixture-intent.json'),{name,database,input:directory,stage:'create-started',startedAt:new Date().toISOString()});
  try{created=await invoke(command,['create',directory,'--database',database]);}catch(error){
   const recovery=error.recovery;const details=recovery?.error?.details;
   await save(join(evidence,'live-fixture-create.json'),{pageId:details?.page_id,operationId:details?.operation_id,receiptPath:details?.receipt_path,name,alias,database,owned:!!details?.page_id,status:details?.page_id?'outcome-unknown':'blocked',recovery,error:error.message});
   await save(join(evidence,'live-fixture-cleanup.json'),{pageId:details?.page_id,status:'blocked',attempt:0,knownIds:details?.page_id?[details.page_id]:[],receipts:details?.page_id?[{pageId:details.page_id,status:'blocked',patch:{attempted:false},readback:{attempted:false},reason:'Reconcile original publication operation before cleanup'}]:[],recovery});
   await save(join(evidence,'live-fixture-intent.json'),{name,database,input:directory,stage:'create-outcome-unknown',recovery,error:error.message,next:'Inspect original operation receipt and reconcile exact known IDs; never repeat create'});throw error;
  }
 }
 assert.ok(created.record?.locator?.page_id,'Create or recovery must return owned page id');const pageId=created.record.locator.page_id;
 await save(join(evidence,'live-fixture-create.json'),{pageId,operationId:created.operation_id,name,alias,database,snapshotId:created.snapshot_id,versionId:created.version_id,owned:true,status:'created',...(resumeEvidence?{recoveredFrom:resumeEvidence}: {})});
 const archive=()=>archiveOwnedFixture({evidence,invoke:(args,input)=>invoke(ntnCommand,args,input)});
 const flagReceipts=[];
 const setDefaultContext=async checked=>{
  assert.equal(typeof checked,'boolean');
  await invoke(ntnCommand,['api',`v1/pages/${pageId}`,'--notion-version','2026-03-11','-X','PATCH','--data','@-'],{properties:{'Default Context':{checkbox:checked}}});
  const observed=await invoke(ntnCommand,['api',`v1/pages/${pageId}`,'--notion-version','2026-03-11']);assert.equal(observed.properties?.['Default Context']?.checkbox,checked);
  flagReceipts.push({pageId,checked,readback:true,at:new Date().toISOString()});await save(join(evidence,'live-fixture-default-context.json'),flagReceipts);
  const listed=await invoke(command,['list','--database',database,'--refresh']);const item=listed.records?.find(skill=>skill.locator?.page_id===pageId);assert.equal(item?.default_context,checked,'CLI must expose checked value from owned page');
 };
 const fixture={alias,canary,resourceCanary,resourcePath:'references/guide.md',skillRef:`skill://${pageId}/SKILL.md`,archive,setDefaultContext};
 onOwned?.(fixture);
 await setDefaultContext(true);
 return fixture;
}
