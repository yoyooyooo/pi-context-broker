import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2);assert.equal(args[0],'--out');assert.equal(args.length,2);assert.ok(path.isAbsolute(args[1]));
const repo=fileURLToPath(new URL('../',import.meta.url)),out=args[1];fs.mkdirSync(out,{recursive:false});
const hash=x=>createHash('sha256').update(x).digest('hex');
const cases=[
 {name:'observation-order',file:'src/consumer-observation.ts',old:'if (previous && (previous.live',replacement:'if (false && previous && (previous.live',test:'consumer-observation.test.ts',pattern:'late old failures'},
 {name:'effective-cursor',file:'src/host-skills.ts',old:'record.description, observations.state(record)]), views, coverage, failures]',replacement:'record.description, record.enabled]), views, coverage, failures]',test:'host-prepare.test.ts',pattern:'F5:'},
];
const summary=[];
for(const item of cases){
 const dir=path.join(out,item.name);fs.mkdirSync(dir);for(const name of ['src','scripts'])fs.cpSync(path.join(repo,'packages/context-broker',name),path.join(dir,name),{recursive:true,errorOnExist:true,force:false});
 fs.copyFileSync(path.join(repo,'packages/context-broker/package.json'),path.join(dir,'package.json'));fs.symlinkSync(path.join(repo,'packages/context-broker/node_modules'),path.join(dir,'node_modules'),'dir');
 const file=path.join(dir,item.file),original=fs.readFileSync(file,'utf8');assert.equal(original.split(item.old).length,2,item.name+' guard changed; review mutation first');
 const run=phase=>{const p=spawnSync('bun',['test',path.join(dir,'scripts',item.test),'--test-name-pattern',item.pattern,'--timeout','30000'],{cwd:dir,encoding:'utf8',timeout:60000});fs.writeFileSync(path.join(dir,phase+'.stdout'),p.stdout??'');fs.writeFileSync(path.join(dir,phase+'.stderr'),p.stderr??'');return p;};
 const before=run('baseline');assert.equal(before.status,0,item.name+' baseline');
 fs.writeFileSync(file,original.replace(item.old,item.replacement));const mutated=run('mutated');
 assert.equal(mutated.status,1,item.name+' mutant must fail assertions');assert.match(mutated.stderr,/error: expect|Expected:/);assert.doesNotMatch(mutated.stderr,/SyntaxError|Cannot find module/);
 fs.writeFileSync(file,original);const restored=run('restored');assert.equal(restored.status,0,item.name+' restore');assert.equal(hash(fs.readFileSync(file)),hash(Buffer.from(original)));
 const result={name:item.name,source:path.join(repo,'packages/context-broker',item.file),sourceSha256:hash(fs.readFileSync(path.join(repo,'packages/context-broker',item.file))),baseline:before.status,mutated:mutated.status,restored:restored.status,originalWorkspaceChanged:false};summary.push(result);console.log(JSON.stringify(result));
}
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({complete:true,cases:summary},null,2)+'\n');
