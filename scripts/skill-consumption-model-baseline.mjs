#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { resolveHost, runCommand } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { createRequestLedger } from './notion-default-context.mjs';
import { systemTempRoot, evidenceRoot, verificationCliEnvironment } from './verification-paths.mjs';
import { safeDiagnostic } from './verification-command.mjs';
import { consumptionCostExtensionSource, readConsumptionCostEvents, consumptionMetricStats } from './skill-consumption-cost.mjs';
import { providerTransportExtensionSource, readProviderTransport } from './skill-consumption-provider.mjs';
import { sourceObserverPreloadSource, readSourceObservation } from './skill-consumption-source-observer.mjs';
import { packageIdentity } from './notion-skill-graph-model.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const rows = async path => { try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const comparisonRoles = ['previous-broker', 'notion-candidate', 'pi-native-local'];
const nativeLocal = config => config.role === 'pi-native-local';
const usage = 'Usage: node scripts/skill-consumption-model-baseline.mjs doctor|selection|run --config ABSOLUTE_JSON [--evidence-root ABSOLUTE_DIR]; evidence|cleanup --evidence ABSOLUTE_DIR. Real model is restricted to magpie/group/flash-free. Normal Pi tools; source consumption may perform adoption/Records writes, no generated task guidance or forced tool choices. Broker config: {version:1,extension,transport?:"cli"|"sdk",command?:[absoluteNode,absoluteCLI],database,prompt,expectedAnswers:[string],counts:{cold:5,warm:20},packagePath?,toolProfile?:"standard"|"native-skills"|"legacy-skills"}. Standard preserves the original seven tools; native-skills adds notion_list/notion_use without removing normal tools; legacy-skills is explicit historical compatibility. Deferred notion_ctl is absent by default. Missing transport preserves legacy CLI mode; explicit sdk forbids command. Comparison roles previous-broker|notion-candidate|pi-native-local require comparison:ABS_FROZEN_MANIFEST. Pure pi-native-local omits extension/transport/command/database/packagePath, uses standard tools and Pi native --skill/read, and loads no Broker. Comparison v1 freezes one candidate; v2 preserves the complete existing View and inspects one same-byte Skill plus required UTF-8 resources. Run selection on the v2 Notion config for separate metadata-only installed-Pi evidence before Doctor; actual catalog name/description differences fail Doctor before model calls. Comparison visibilityPolicy defaults to strict; v2 native-default-policy retains the full authored inventory and installed native visibility rules, while each arm checks its own actual provider catalog. This measures system-default workflow cost, not Broker net cost under identical visibility. Automatic Requires and /skill expansion are separate semantics. Cold=new isolated process/cache (native files already exist; OS page cache is uncontrolled); warm=ordinary turns in the final cold process with history counted. All attempts and unrun planned samples remain recorded.';

async function tree(directory) {
  const output = {};
  async function walk(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const next = join(path, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'Runtime tree must not contain symlinks');
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) output[relative(directory, next)] = hash(await readFile(next));
    }
  }
  await walk(directory); return { files: output, sha256: hash(JSON.stringify(output)) };
}
export function validateModelBaselineConfig(config) {
  assert.equal(config.version, 1);
  assert.ok(Object.keys(config).every(key => ['version','extension','transport','command','database','prompt','expectedAnswers','counts','packagePath','toolProfile','role','comparison'].includes(key)));
  if (config.role !== undefined) {
    assert.ok(comparisonRoles.includes(config.role), 'Unknown comparison role');
    assert.ok(typeof config.comparison === 'string' && isAbsolute(config.comparison), 'Comparison roles require a frozen absolute comparison manifest');
  } else assert.equal(Object.hasOwn(config, 'comparison'), false, 'A comparison must name its role');
  if (nativeLocal(config)) {
    for (const key of ['extension','transport','command','database','packagePath'])
      assert.equal(Object.hasOwn(config, key), false, 'Pure Pi native local must omit ' + key);
    assert.ok(config.toolProfile === undefined || config.toolProfile === 'standard', 'Pure Pi native local uses the ordinary Pi tool profile');
  } else {
    assert.ok(isAbsolute(config.extension));
    assert.ok(config.transport === undefined || ['cli','sdk'].includes(config.transport));
    if(config.transport==='sdk') assert.equal(Object.hasOwn(config,'command'),false,'SDK mode must omit command, not wrap the default source');
    else assert.ok(Array.isArray(config.command) && config.command.length === 2 && config.command.every(isAbsolute));
    assert.match(config.database, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  }
  assert.ok(typeof config.prompt === 'string' && config.prompt.trim() && Array.isArray(config.expectedAnswers) && config.expectedAnswers.length
    && config.expectedAnswers.every(value => typeof value === 'string' && value.trim()));
  assert.ok(['cold','warm'].every(key => Number.isSafeInteger(config.counts?.[key]) && config.counts[key] >= 1 && config.counts[key] <= 20));
  modelBaselineTools(config);
  return config;
}
export function modelBaselineTools(config) {
  const profile=config.toolProfile===undefined?'standard':config.toolProfile;
  assert.ok(['standard','native-skills','legacy-skills'].includes(profile),'Unsupported model tool profile');
  if (nativeLocal(config)) assert.equal(profile, 'standard', 'Pure Pi native local cannot load product tools');
  const tools=['read','bash','edit','write','grep','find','ls'];
  if(profile==='native-skills') return [...tools,'notion_list','notion_use'];
  if(profile==='legacy-skills') return [...tools,'skill_search','skill_prepare','skill_graph'];
  return tools;
}
async function configAt(path) {
  assert.ok(isAbsolute(path ?? ''), 'Config path must be absolute');
  return validateModelBaselineConfig(JSON.parse(await readFile(path, 'utf8')));
}
export function modelBaselineSource(config, { cacheDir, command, viewId } = {}) {
  assert.equal(nativeLocal(config), false, 'Pure Pi native local has no Broker source');
  const source={id:'notion',namespace:'notion',type:'notion',database:config.database,prefetch:false,cacheDir};
  if (viewId !== undefined) source.default_view_id = viewId;
  if(config.transport==='sdk') {
    assert.equal(Object.hasOwn(config,'command'),false,'SDK mode must omit command');
    assert.equal(command,undefined,'SDK mode must not install a source wrapper');
    return source;
  }
  assert.ok(Array.isArray(command)&&command.length>0,'Legacy CLI mode requires its explicit ledger command');
  return {...source,command};
}

/** Compare actual Pi/Notion metadata without rewriting source frontmatter.
 * One selected Skill is inspected; all visible candidates remain in the catalog. */
function comparisonCatalogBlock(payload,allowPending=false) {
  const text = value => typeof value === 'string' ? value : (Array.isArray(value) ? value : [])
    .filter(part => ['text','input_text'].includes(part?.type)).map(part => part.text ?? '').join('\n');
  const systems = [payload?.system, payload?.instructions, payload?.systemPrompt,
    ...(payload?.messages ?? []).filter(message => ['system','developer'].includes(message.role)).map(message => message.content)]
    .map(text).filter(Boolean);
  const blocks = systems.flatMap(value => [...value.matchAll(/<ntn-skills-view-catalog>[\s\S]*?<\/ntn-skills-view-catalog>/g)].map(match => match[0]));
  const pending=systems.flatMap(value=>[...value.matchAll(/<ntn-skills-discovery\b[^>]*\bstatus="pending"[^>]*>/g)]);
  if(blocks.length===0&&pending.length===1) {
    assert.ok(allowPending,'Pending or failed discovery cannot freeze an empty catalog');
    return null;
  }
  assert.equal(blocks.length, 1, 'Comparison needs the actual ready Notion provider catalog');
  return blocks[0];
}
export function comparisonCatalog(payload) {
  const block=comparisonCatalogBlock(payload);
  assert.ok(/<view\s[^>]*\bid="/.test(block) && !/<view\s[^>]*\bstatus="(?:pending|error)"/.test(block), 'Pending or failed discovery cannot freeze an empty catalog');
  assert.equal(/<router\b/.test(block), false, 'Router routing is outside the first common native-read inspect task');
  const unescape = value => value.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  const records = [...block.matchAll(/<skill>([\s\S]*?)<\/skill>/g)].map(match => {
    const field = name => { const matches = [...match[1].matchAll(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'g'))];
      assert.equal(matches.length, 1, 'Each comparison candidate needs one ' + name); return unescape(matches[0][1]); };
    return { name: field('name'), description: field('description'), location: field('location') };
  });
  assert.ok(records.length > 0, 'Comparison needs at least one actual visible Skill candidate');
  assert.equal(new Set(records.map(record=>record.name)).size,records.length,'Duplicate visible names cannot be normalized into native aliases');
  assert.equal(new Set(records.map(record=>record.location)).size,records.length,'Each candidate needs a distinct exact entry');
  for(const record of records) assert.ok(record.name && record.description && /^(?:sr:C[A-Za-z0-9_-]{22}|skill:\/\/\S+)$/.test(record.location), 'Notion candidate needs its actual exact entry');
  return records;
}

export function verifyComparisonCatalog(nativeSkills, notionCatalog, visibilityPolicy = 'strict') {
  assert.ok(['strict','native-default-policy'].includes(visibilityPolicy),'Unknown comparison visibility policy');
  assert.ok(nativeSkills.length > 0 && nativeSkills.length === notionCatalog.length, 'Native discovery must expose the same complete candidate set');
  assert.equal(new Set(nativeSkills.map(skill=>skill.name)).size,nativeSkills.length,'Native name collisions cannot be normalized away');
  assert.equal(new Set(notionCatalog.map(skill=>skill.name)).size,notionCatalog.length,'Notion name collisions cannot be normalized away');
  for(const skill of nativeSkills) {
    assert.equal(typeof skill.disableModelInvocation,'boolean','Native authored visibility policy must be known');
    if(visibilityPolicy==='strict')assert.equal(skill.disableModelInvocation, false, 'The native Skill must be normally model-visible');
  }
  const metadata=skills=>skills.map(({name,description})=>({name,description})).sort((a,b)=>a.name.localeCompare(b.name));
  assert.deepEqual(metadata(nativeSkills), metadata(notionCatalog),
    'Actual candidate names/descriptions differ; do not normalize names or rewrite source frontmatter');
}

function comparisonVisibilityPolicy(descriptor) {
  const policy=descriptor.visibilityPolicy===undefined?'strict':descriptor.visibilityPolicy;
  assert.ok(['strict','native-default-policy'].includes(policy),'Unknown comparison visibility policy');
  if(policy==='native-default-policy')assert.equal(descriptor.version,2,'Native default policy requires the complete version 2 inventory');
  return policy;
}

function nativePromptCatalog(prompt) {
  assert.equal(typeof prompt,'string','The installed native formatter must return its actual prompt');
  const blocks=[...prompt.matchAll(/<available_skills>([\s\S]*?)<\/available_skills>/g)];
  assert.ok(blocks.length<=1,'Native formatting must have one catalog or no visible candidates');
  if(!blocks.length){assert.equal(prompt,'','An absent native catalog must have an empty formatter result');return [];}
  const unescape=value=>value.replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
  return [...blocks[0][1].matchAll(/<skill>([\s\S]*?)<\/skill>/g)].map(match=>{
    const field=name=>{const values=[...match[1].matchAll(new RegExp('<'+name+'>([\\s\\S]*?)</'+name+'>','g'))];
      assert.equal(values.length,1,'Each native candidate needs one '+name);return unescape(values[0][1]);};
    return {name:field('name'),description:field('description'),filePath:field('location')};
  });
}

async function installedPiPackage(host) {
  const executable=await realpath(host.identity);
  // Use the same installed-package walk as the existing SDK/host-help drivers.
  // Pi may publish its bin under dist/bundle while its public modules are in dist.
  for(let directory=dirname(executable);;) {
    const packagePath=join(directory,'package.json');
    try {
      const bytes=await readFile(packagePath),pkg=JSON.parse(bytes.toString('utf8'));
      if(pkg.name==='@earendil-works/pi-coding-agent') {
        const bin=typeof pkg.bin==='string'?pkg.bin:pkg.bin?.pi;
        assert.ok(typeof bin==='string','The installed Pi package must declare its real executable');
        assert.equal(await realpath(resolve(directory,bin)),executable,'The discovered Pi package must own the executing bin');
        return {directory,name:pkg.name,version:pkg.version,path:packagePath,sha256:hash(bytes)};
      }
    } catch(error) { if(!['ENOENT','ENOTDIR'].includes(error.code))throw error; }
    const parent=dirname(directory);assert.notEqual(parent,directory,'Cannot identify the actual installed Pi package');directory=parent;
  }
}

async function frozenJson(identity) {
  assert.ok(identity && typeof identity.path === 'string' && isAbsolute(identity.path));
  assert.match(identity.sha256, /^[a-f0-9]{64}$/);
  const bytes=await readFile(identity.path);
  assert.equal(hash(bytes),identity.sha256,'Frozen comparison input changed: '+identity.path);
  return JSON.parse(bytes.toString('utf8'));
}

export async function modelBaselineComparison(config, host) {
  if (!config.comparison) return null;
  const descriptorBytes = await readFile(config.comparison), descriptor = JSON.parse(descriptorBytes.toString('utf8'));
  assert.ok([1,2].includes(descriptor.version)); assert.equal(descriptor.intent, 'inspect'); assert.equal(descriptor.entry, 'read');
  const visibilityPolicy=comparisonVisibilityPolicy(descriptor);
  assert.deepEqual(descriptor.roles, comparisonRoles, 'Declare previous Broker, candidate and pure native roles separately');
  assert.equal(descriptor.model, 'magpie/group/flash-free'); assert.equal(descriptor.promptSha256, hash(config.prompt));
  assert.equal(descriptor.expectedAnswersSha256, hash(JSON.stringify(config.expectedAnswers))); assert.deepEqual(descriptor.counts, config.counts);
  assert.ok(!/^\s*(?:\$|\/skill:)/.test(config.prompt), 'Native read inspection cannot be relabelled explicit use or /skill expansion');
  const selection = await frozenJson(descriptor.notionSelection), payload = await frozenJson(descriptor.notionProviderPayload);
  const catalogSource = await frozenJson(descriptor.notionCatalogSource);
  assert.equal(selection.status, 'passed');
  assert.equal(selection.kind,descriptor.version===1?'installed-pi-selection-preflight':'installed-pi-catalog-preflight');
  assert.equal(selection.sourceMode, 'sdk', 'The candidate catalog must be the default SDK path');
  assert.equal(selection.bodyRequests, 0); assert.equal(selection.realModelRequests, 0); assert.equal(selection.processesClosed, true);
  assert.equal(selection.defaultDiscovery?.status, 'passed'); assert.equal(selection.defaultDiscovery?.catalog?.status, 'ready');
  assert.ok(selection.files.includes(relative(selection.evidence, descriptor.notionProviderPayload.path)), 'Catalog payload must belong to the frozen metadata selection');
  assert.ok(selection.files.includes(relative(selection.evidence, descriptor.notionCatalogSource.path)), 'Catalog source receipt must belong to that same selection');
  assert.equal(catalogSource.transport, 'sdk'); assert.equal(catalogSource.operation, 'list'); assert.equal(catalogSource.status, 'completed'); assert.equal(catalogSource.resultObserved, true);
  assert.equal(catalogSource.value.coverage?.exhaustive, true); assert.equal(catalogSource.value.count, catalogSource.value.records.length);
  assert.equal(catalogSource.value.coverage.search_index_limited, false); assert.deepEqual(catalogSource.value.coverage.failed_sources, []);
  const actualCatalog=comparisonCatalog(payload),records=catalogSource.value.records;
  assert.equal(new Set(records.map(record=>record.id)).size,records.length,'The source catalog must retain distinct owners');
  verifyComparisonCatalog(records.map(record=>({...record,disableModelInvocation:false})),actualCatalog);
  const candidates=descriptor.version===1?[{manifest:descriptor.manifest,directory:descriptor.directory,recordId:selection.record.id}]:descriptor.candidates;
  assert.ok(Array.isArray(candidates)&&candidates.length>0&&candidates.length===records.length,'Every visible candidate needs one frozen source tree');
  assert.equal(new Set(candidates.map(candidate=>candidate.recordId)).size,candidates.length,'Duplicate frozen owners are not separate candidates');
  const selectedRecordId=descriptor.version===1?selection.record.id:descriptor.selectedRecordId;
  assert.equal(selection.record.id,selectedRecordId);
  assert.deepEqual(records.filter(record=>record.id===selectedRecordId),[selection.record],'The selected owner must match its authorized SDK metadata');
  if(descriptor.version===2) {
    assert.equal(selection.runtimeUnchanged,true,'Metadata selection inputs changed during observation');
    assert.equal(selection.viewId,descriptor.viewId); assert.equal(catalogSource.value.view?.id,descriptor.viewId);
    assert.deepEqual(selection.catalog,actualCatalog,'Selection must retain the same actual provider catalog');
  }
  assert.ok(typeof descriptor.directory === 'string' && isAbsolute(descriptor.directory));
  const directory = await realpath(descriptor.directory), files = await tree(directory);
  const frozen=[],inventory={};
  for(const candidate of candidates) {
    const manifest=await frozenJson(candidate.manifest),record=records.find(record=>record.id===candidate.recordId);
    assert.ok(record,'Frozen owner is outside the actual visible catalog');
    assert.equal(manifest.complete,true);assert.equal(manifest.record?.kind,'skill');assert.equal(manifest.entrypoint,'SKILL.md');
    assert.equal(manifest.record.id,record.id);
    for(const key of ['ref','name','description'])assert.equal(manifest.record[key],record[key],'Frozen source metadata differs: '+key);
    assert.match(manifest.scope,/^[a-f0-9]{64}$/);assert.match(manifest.snapshot_id,/^s_[a-f0-9]{64}$/);assert.match(manifest.version_id,/^[a-f0-9]{64}$/);
    assert.equal(manifest.scope,catalogSource.value.scope,'Frozen bytes and visible metadata must share authorization scope');
    assert.ok(typeof candidate.directory==='string'&&isAbsolute(candidate.directory));
    const candidateDirectory=await realpath(candidate.directory),prefix=relative(directory,candidateDirectory);
    assert.ok(!prefix.startsWith('..')&&!isAbsolute(prefix),'Every native candidate must be inside the frozen catalog root');
    if(descriptor.version===2)assert.ok(prefix&&prefix.split('/').length===1,'Multi-candidate trees must be distinct direct children');
    const candidateTree=await tree(candidateDirectory);
    assert.ok(Array.isArray(manifest.files)&&manifest.files.length>0);
    assert.deepEqual(Object.keys(candidateTree.files).sort(),manifest.files.map(file=>file.path).sort(),'Native tree must retain every frozen source file and no replacements');
    const source={scope:manifest.scope,snapshotId:manifest.snapshot_id,versionId:manifest.version_id,recordId:record.id,entrypoint:manifest.entrypoint};
    const candidateFiles=[];
    for(const file of manifest.files) {
      assert.ok(typeof file.path==='string'&&file.path.split('/').every(part=>part&&part!=='.'&&part!=='..')&&!file.path.includes('\\'));
      assert.equal(candidateTree.files[file.path],file.sha256,'Native file differs from fixed Notion source: '+file.path);
      const absolutePath=join(candidateDirectory,file.path);
      assert.equal((await readFile(absolutePath)).length,file.bytes);
      const bindings=(manifest.file_bindings??[]).filter(binding=>binding.path===file.path);
      assert.ok(bindings.length<=1,'A frozen path cannot have ambiguous File IDs');
      candidateFiles.push({...file,absolutePath,recordId:record.id,...(bindings[0]?{fileId:bindings[0].file_id}:{})});
      const path=relative(directory,absolutePath);assert.equal(Object.hasOwn(inventory,path),false,'Native source trees cannot share a file');
      inventory[path]=file.sha256;
    }
    frozen.push({record,manifest,directory:candidateDirectory,tree:candidateTree,files:candidateFiles,source});
  }
  assert.deepEqual(files.files,inventory,'The catalog root cannot contain extra native files or replacement wrappers');
  const selected=frozen.find(candidate=>candidate.record.id===selectedRecordId);
  assert.ok(selected,'The inspect task must select exactly one authorized frozen owner');
  const manifest=selected.manifest;
  assert.ok(Array.isArray(descriptor.requiredResources) && descriptor.requiredResources.length > 0 && descriptor.requiredResources.length <= 16);
  const required = [manifest.entrypoint, ...descriptor.requiredResources];
  assert.equal(new Set(required).size, required.length);
  const requiredFiles = [];
  for (const name of required) {
    const file = manifest.files.find(file => file.path === name); assert.ok(file, 'Required inspect resource absent from source manifest: ' + name);
    const bytes = await readFile(join(selected.directory, name));
    assert.ok(bytes.length > 0 && Buffer.from(bytes.toString('utf8')).equals(bytes), 'First common inspect case requires complete nonempty UTF-8 files');
    requiredFiles.push(selected.files.find(file=>file.path===name));
  }
  const nativePackage=await installedPiPackage(host);
  if(descriptor.version===2) {
    assert.equal(nativePackage.version,descriptor.piVersion,'Comparison must retain its actual frozen Pi version');
    assert.equal(selection.pi.version,nativePackage.version);
    assert.equal(selection.pi.sha256,nativePackage.sha256,'Metadata selection and task must use the same Pi package');
  }
  const skillsModule = await realpath(join(nativePackage.directory,'dist/core/skills.js'));
  const { loadSkills, formatSkillsForPrompt } = await import(pathToFileURL(skillsModule).href);
  const discovered = loadSkills({cwd: directory, agentDir: join(directory, '.unused-agent'), skillPaths: [directory], includeDefaults: false});
  assert.ok(!discovered.diagnostics.some(item=>['error','collision'].includes(item.type)), 'Native discovery errors or collisions cannot be normalized away');
  verifyComparisonCatalog(discovered.skills, actualCatalog, visibilityPolicy);
  const nativePrompt=formatSkillsForPrompt(discovered.skills),nativeVisible=nativePromptCatalog(nativePrompt);
  const nativeInventory=discovered.skills.map(({name,description,filePath,disableModelInvocation})=>({name,description,filePath,disableModelInvocation}));
  assert.deepEqual(nativeVisible,nativeInventory.filter(skill=>!skill.disableModelInvocation).map(({name,description,filePath})=>({name,description,filePath})),
    'Native catalog differences must be explained by unchanged authored visibility flags and the installed formatter');
  const nativeNames=new Set(nativeVisible.map(skill=>skill.name)),notionNames=new Set(actualCatalog.map(skill=>skill.name));
  const notionOnly=actualCatalog.filter(skill=>!nativeNames.has(skill.name)),nativeOnly=nativeVisible.filter(skill=>!notionNames.has(skill.name));
  const visibility={policy:visibilityPolicy,costQuestion:visibilityPolicy==='strict'?'same-visible-candidates':'system-default-workflow',
    sameVisibleCandidates:notionOnly.length===0&&nativeOnly.length===0,nativeInventory,nativeVisible,notionVisible:actualCatalog,notionOnly,nativeOnly};
  for(const candidate of frozen) {
    const skill=discovered.skills.find(skill=>skill.name===candidate.record.name);
    assert.equal(await realpath(skill.filePath),join(candidate.directory,candidate.manifest.entrypoint),'Native metadata must belong to its exact frozen owner');
  }
  if (!nativeLocal(config)) {
    assert.equal(config.database, selection.database);
    if (config.role === 'notion-candidate') {
      assert.equal(config.transport, 'sdk');
      assert.equal(hash(await readFile(config.extension)), selection.artifacts.extension.sha256, 'Candidate catalog must use this actual installed extension');
      assert.ok(config.packagePath); assert.equal(hash(await readFile(config.packagePath)), selection.artifacts.package.sha256);
    }
  }
  const sourceSetup=descriptor.sourceFreezeSetup?await frozenJson(descriptor.sourceFreezeSetup):null;
  return {version: descriptor.version, path: await realpath(config.comparison), sha256: hash(descriptorBytes), role: config.role,
    directory, tree: files, requiredFiles, catalog:nativeLocal(config)?nativeVisible:actualCatalog,visibility,
    nativePrompt:{text:nativePrompt,bytes:Buffer.byteLength(nativePrompt),sha256:hash(nativePrompt)},
    source:selected.source,selectedRecordId,
    candidates:frozen.map(candidate=>({recordId:candidate.record.id,ref:candidate.record.ref,directory:candidate.directory,source:candidate.source})),
    unselectedFiles:frozen.filter(candidate=>candidate!==selected).flatMap(candidate=>candidate.files),
    unselectedSources:frozen.filter(candidate=>candidate!==selected).map(candidate=>({...candidate.source,name:candidate.record.name,ref:candidate.record.ref})),
    viewId: selection.viewId, selectionReceipt: descriptor.notionSelection, catalogPayload: descriptor.notionProviderPayload, catalogSource: descriptor.notionCatalogSource,
    setupCost: selection.setupCost,sourceSetupCost:sourceSetup?.setupCost??null,
    frozenSourceBytes:frozen.flatMap(candidate=>candidate.files).reduce((total,file)=>total+file.bytes,0),
    nativeDiscoveryDiagnostics:discovered.diagnostics,
    nativeFilesystemCache:'File fingerprinting and native metadata parsing are setup reads; OS page cache is uncontrolled, never claimed cold.',
    nativePackage,nativeLoader: {path: skillsModule, sha256: hash(await readFile(skillsModule))},
    entry: 'Pi native discovery and read; explicit --skill directory with ambient Skills disabled',
    automaticRequires: 'not-compared; native inspection does not claim Broker automatic Requires activation',
    sourceBytes: 'same complete fixed source tree, including unchanged authored member directory; no instruction preloading or rewriting'};
}

export function modelBaselineHostArgs(config, {base, observer, transport, inspection, comparison} = {}) {
  const args = ['--no-extensions','--no-mcp','--no-context-files','--no-prompt-templates','--session-dir',join(base,'sessions'),
    '--tools',modelBaselineTools(config).join(',')];
  if (comparison) args.push('--no-skills');
  if (nativeLocal(config)) {
    assert.ok(comparison && isAbsolute(comparison.directory), 'Native local requires its verified frozen Skill directory');
    args.push('--skill', comparison.directory);
  } else args.push('-e', config.extension);
  args.push('-e', transport, '-e', observer);
  if (inspection) args.push('-e', inspection);
  return [...args, '--model', 'magpie/group/flash-free'];
}

/** Passive proof for the native arm. Expected inputs contain hashes, never
 * instruction bodies. A body becomes known only after the actual read result;
 * the exact same outer tool output must subsequently reach the provider. */
export function observeNativeInspection(api, settings) {
  const {fs,crypto,path,diagnostics,output,files,catalog,clockId,source,rawDirectory,validateResourceReadProjection,unselectedFiles=[],unselectedSources=[]} = settings;
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const fd = fs.openSync(output, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  const expected = new Map(files.map(file => [file.absolutePath, file])), calls = new Map(), delivered = new Map(), subscriptions = [];
  const unselected=new Map(unselectedFiles.map(file=>[file.absolutePath,file])),unselectedRefs=new Map(),unselectedOutputs=new Map();
  let sequence = 0, previous = null, turn = 0, closed = false, errors = 0, rawPayloads = 0;
  const append = (phase, values = {}) => {
    const row = {version:1,sequence:++sequence,previousSha256:previous,clockId,monotonicNs:process.hrtime.bigint().toString(),phase,turn,...values};
    row.eventSha256 = sha(JSON.stringify(row)); previous = row.eventSha256; fs.writeSync(fd, JSON.stringify(row) + '\n');
  };
  const text = value => typeof value === 'string' ? value : (Array.isArray(value) ? value : [])
    .filter(part => ['text','input_text','output_text'].includes(part?.type)).map(part => part.text ?? '').join('\n');
  const guard = handler => (...args) => { if (closed) return; try { handler(...args); } catch { errors++; try { append('observer_error'); } catch { /* Observation stays incomplete; the original tool proceeds unchanged. */ } } };
  const on = (event, handler) => api.on(event, guard(handler));
  const subscribe = (name, handler) => { const callback = guard(handler); diagnostics.subscribe(name,callback); subscriptions.push([name,callback]); };
  append('native_observer_start',{method:'native-read-result-to-provider-output',bodyInput:'none; only frozen file hashes',fileCount:files.length,
    ...(rawDirectory?{rawEvidence:'private-provider-body-v1'}:{})});
  if(!source)subscribe('context-broker.notion-sdk', () => append('unexpected_sdk_operation'));
  if(!source)subscribe('tracing:child_process.spawn:start', ({process:child}) => {
    const id = sequence + 1; append('child_start',{id});
    child.once('close', guard((code,signal) => append('child_close',{id,code,signal})));
  });
  on('input', () => {turn++;});
  on('tool_call', event => {
    const pathname = event.toolName === 'read' && typeof event.input?.path === 'string' ? path.resolve(process.cwd(),event.input.path) : null;
    const file = pathname ? expected.get(pathname) : undefined;
    const other=pathname?unselected.get(pathname):undefined;
    if ((file||other||source&&event.toolName==='read') && typeof event.toolCallId === 'string' && event.toolCallId) {
      calls.set(event.toolCallId,{file,other,input:event.input}); append('native_read_call',{toolCallIdSha256:sha(event.toolCallId),path:file?.path??other?.path??null});
    }
    if (!source&&/^(?:notion_|skill_(?:search|prepare|graph))/.test(event.toolName)) append('unexpected_product_tool');
  });
  on('tool_result', event => {
    const call = calls.get(event.toolCallId); if (!call) return;
    const outputText = text(event.content), observed=[];
    const valid=event.toolName==='read'&&event.isError!==true&&!event.parentToolCallId&&Array.isArray(event.content)&&event.content.every(part=>part.type==='text');
    const owner=event.details?.contextBrokerRead?.binding?.record?.id??event.details?.contextBrokerResource?.selection?.owner??event.details?.contextBrokerResource?.id;
    const inputRefs=[call.input?.path,...(Array.isArray(call.input?.paths)?call.input.paths:[])].filter(value=>typeof value==='string');
    const otherRef=inputRefs.find(ref=>unselectedRefs.has(ref));
    let canonicalOwner;
    if(source)for(const ref of inputRefs)try{const parsed=new URL(ref),id=decodeURIComponent(parsed.hostname);if(parsed.protocol==='skill:'&&id.startsWith('shared_skill:')&&id!==source.recordId)canonicalOwner=id;}catch{}
    if(valid&&outputText&&(call.other||source&&owner&&owner!==source.recordId||otherRef||canonicalOwner)) {
      const rejected={recordId:call.other?.recordId??canonicalOwner??owner??unselectedRefs.get(otherRef),path:call.other?.path??null,
        toolCallIdSha256:sha(event.toolCallId),bytes:Buffer.byteLength(outputText),sha256:sha(outputText)};
      append('unselected_read_result',rejected);unselectedOutputs.set(event.toolCallId,{outputText,...rejected});
    }
    const remember=(file,body,span,wholeOutput=false)=>{
      const complete=valid&&file&&sha(body)===file.sha256&&Buffer.byteLength(body)===file.bytes;
      append('native_read_result',{toolCallIdSha256:sha(event.toolCallId),path:file?.path??null,sha256:sha(body),bytes:Buffer.byteLength(body),complete:Boolean(complete)});
      if(complete)observed.push({file,body,span,wholeOutput});
    };
    if(!source)remember(call.file,outputText,{start:0,end:outputText.length,encoding:'raw'},true);
    else if(valid) {
      const canonical=(ref,file)=>{try{const parsed=new URL(ref);return parsed.protocol==='skill:'&&decodeURIComponent(parsed.hostname)===source.recordId
        &&decodeURIComponent(parsed.pathname.slice(1))===file.path&&parsed.searchParams.get('snapshot')===source.snapshotId
        &&(file.fileId===undefined||parsed.searchParams.get('file_id')===file.fileId);}catch{return false;}};
      const sameSelection=(value,ownerKey='owner')=>value?.scope===source.scope&&value[ownerKey]===source.recordId
        &&value.snapshot_id===source.snapshotId&&value.version_id===source.versionId;
      const main=event.details?.contextBrokerRead,binding=main?.binding;
      if([2,3].includes(main?.version)&&main.toolCallId===event.toolCallId&&main.snapshotId===source.snapshotId
        &&main.contentIdentity===JSON.stringify([source.scope,source.recordId])&&binding?.scope===source.scope&&binding.record?.id===source.recordId
        &&binding.record.entrypoint===source.entrypoint&&binding.snapshot_id===source.snapshotId&&binding.version_id===source.versionId) {
        const file=files.find(file=>file.path===source.entrypoint),span=main.version===3?main.delivery:{start:0,end:outputText.length,encoding:'raw'};
        if(file&&span?.start===0&&span.encoding==='raw'&&Number.isSafeInteger(span.end)&&span.end>0&&span.end<=outputText.length
          &&main.bodySha256===file.sha256&&main.bytes===file.bytes&&binding.body_sha256===file.sha256&&canonical(binding.ref,file))
          remember(file,outputText.slice(0,span.end),span);
      }
      const resource=event.details?.contextBrokerResource;
      if(resource?.version===1&&resource.toolCallId===event.toolCallId&&resource.loaded===false&&resource.delivered_complete_text===true&&sameSelection(resource,'id')) {
        const file=files.find(file=>file.path===resource.path&&file.path!==source.entrypoint);
        if(file&&resource.sha256===file.sha256&&resource.bytes===file.bytes&&(file.fileId===undefined||resource.file_id===file.fileId)&&canonical(resource.ref,file))
          remember(file,outputText,{start:0,end:outputText.length,encoding:'raw'},true);
      } else if(resource?.version===2&&resource.toolCallId===event.toolCallId&&sameSelection(resource.selection)&&typeof validateResourceReadProjection==='function') {
        const proof=validateResourceReadProjection(outputText,resource);
        if(proof&&!proof.projection.derived)for(const item of proof.files) {
          const file=files.find(file=>file.path===item.path&&file.path!==source.entrypoint),span=item.delivery;
          if(file&&item.state==='source'&&item.delivered_complete_text&&span?.encoding==='json'&&item.sha256===file.sha256&&item.bytes===file.bytes
            &&(file.fileId===undefined||item.file_id===file.fileId)&&canonical(item.ref,file))
            remember(file,JSON.parse('"'+outputText.slice(span.start,span.end)+'"'),span,true);
        }
      }
    }
    if(observed.length)delivered.set(event.toolCallId,{outputText,files:observed});
  });
  on('before_provider_request', event => {
    const payload = event.payload, outputs = [];
    const serialized=JSON.stringify(payload),rawPayload=rawDirectory?'provider-'+(++rawPayloads)+'.json':undefined;
    if(rawPayload)fs.writeFileSync(path.join(rawDirectory,rawPayload),serialized,{flag:'wx',mode:0o600});
    for (const message of payload?.messages ?? []) {
      if (message.role === 'tool' && typeof message.tool_call_id === 'string') outputs.push({id:message.tool_call_id,text:text(message.content)});
      for (const part of Array.isArray(message.content) ? message.content : [])
        if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') outputs.push({id:part.tool_use_id,text:text(part.content)});
    }
    for (const item of Array.isArray(payload?.input) ? payload.input : [])
      if (item.type === 'function_call_output' && typeof item.call_id === 'string') outputs.push({id:item.call_id,text:text(item.output)});
    const matches = [];
    for (const output of outputs) {
      const observed = delivered.get(output.id);
      if(observed)for(const item of observed.files)if(item.wholeOutput?output.text===observed.outputText:output.text.startsWith(item.body))
        matches.push({path:item.file.path,sha256:item.file.sha256,bytes:item.file.bytes,
          toolCallIdSha256:sha(output.id),span:item.span});
    }
    const systems = [payload?.system,payload?.instructions,payload?.systemPrompt,
      ...(payload?.messages ?? []).filter(message => ['system','developer'].includes(message.role)).map(message => message.content)].map(text).join('\n');
    const unescape = value => value.replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
    const catalogs = [...systems.matchAll(/<available_skills>([\s\S]*?)<\/available_skills>/g)];
    const actual = catalogs.flatMap(block => [...block[1].matchAll(/<skill>([\s\S]*?)<\/skill>/g)].map(match => {
      const field = name => unescape(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(match[1])?.[1] ?? '');
      return {name:field('name'),description:field('description'),filePath:field('location')};
    }));
    for(const item of actual) {
      const other=unselectedSources.find(candidate=>candidate.name===item.name);
      if(other)unselectedRefs.set(item.filePath,other.recordId);
    }
    const unselectedBodies=outputs.filter(item=>unselectedOutputs.get(item.id)?.outputText===item.text)
      .map(item=>({recordId:unselectedOutputs.get(item.id).recordId,toolCallIdSha256:sha(item.id)}));
    const catalogState=source?(/<(?:view|ntn-skills-discovery)\s[^>]*\bstatus="pending"/.test(systems)?'pending':
      /<(?:view|ntn-skills-discovery)\s[^>]*\bstatus="error"/.test(systems)?'error':/<ntn-skills-view-catalog>/.test(systems)?'ready':'absent'):'ready';
    const metadata=items=>items.map(({name,description})=>({name,description})).sort((a,b)=>a.name.localeCompare(b.name));
    const productTools = (payload?.tools ?? []).some(tool => /^(?:notion_|skill_(?:search|prepare|graph))/.test(tool.function?.name ?? tool.name ?? ''));
    append('native_provider',{payloadSha256:sha(serialized),payloadBytes:Buffer.byteLength(serialized),...(rawPayload?{rawPayload}:{}),files:matches,
      catalogState,unselectedBodies,catalogMatches:source?(catalogState==='pending'?null:JSON.stringify(metadata(actual))===JSON.stringify(metadata(catalog))):
        JSON.stringify(actual) === JSON.stringify(catalog),brokerAbsent:source?null:!productTools && !/<ntn-skills-(?:guidance|view-catalog)>/.test(systems)});
  });
  const finish = () => {
    if (closed) return;
    for (const [name,callback] of subscriptions) diagnostics.unsubscribe(name,callback);
    append('native_observer_end',{complete:errors === 0,errors,...(rawDirectory?{rawPayloads}:{})}); closed = true; fs.closeSync(fd);
  };
  on('session_shutdown',finish);
  return {finish};
}

export function nativeInspectionExtensionSource(settings) {
  const validator=settings.validatorPath?"import {validateResourceReadProjection} from "+JSON.stringify(pathToFileURL(settings.validatorPath).href)+";\n":'';
  return "import fs from 'node:fs';\nimport crypto from 'node:crypto';\nimport path from 'node:path';\nimport diagnostics from 'node:diagnostics_channel';\n"
    +validator+'export default api => (' + observeNativeInspection.toString() + ')(api,{fs,crypto,path,diagnostics,'
    +(settings.validatorPath?'validateResourceReadProjection,':'')+'...' + JSON.stringify(settings) + '});\n';
}

export function verifyNativeInspectionEvents(events) {
  assert.ok(events.length >= 2 && events[0]?.phase === 'native_observer_start' && events.at(-1)?.phase === 'native_observer_end', 'Native observer needs both lifecycle boundaries');
  let previous = null;
  for (const [index,event] of events.entries()) {
    const {eventSha256,...body} = event;
    assert.equal(event.version,1); assert.equal(event.sequence,index+1); assert.equal(event.previousSha256,previous);
    assert.equal(event.clockId,events[0].clockId); assert.equal(hash(JSON.stringify(body)),eventSha256,'Native evidence hash chain changed'); previous=eventSha256;
  }
  assert.equal(events.at(-1).complete,true); assert.equal(events.at(-1).errors,0);
  assert.equal(events.some(event=>event.phase==='unselected_read_result'),false,'An unselected candidate body was read');
  return events;
}

/** Private originals are separate from the body-free metrics ledger. Only the
 * provider payload is retained; the hook event and HTTP headers are not copied. */
export async function verifyModelRawEvidence({processEvidence,events,costEvents,answers=[]}) {
  verifyNativeInspectionEvents(events);
  assert.equal(events[0].rawEvidence,'private-provider-body-v1');
  const providers=events.filter(event=>event.phase==='native_provider'),directory=join(processEvidence,'provider-payloads');
  assert.ok(providers.length>0,'No actual provider original was observed');
  assert.equal(events.at(-1).rawPayloads,providers.length,'Raw writes need their completed observer terminal');
  const names=providers.map((event,index)=>{assert.equal(event.rawPayload,'provider-'+(index+1)+'.json');return event.rawPayload;});
  assert.deepEqual((await readdir(directory)).sort(),[...names].sort(),'Missing or extra provider originals');
  for(const event of providers) {
    const bytes=await readFile(join(directory,event.rawPayload));
    assert.equal(bytes.length,event.payloadBytes);assert.equal(hash(bytes),event.payloadSha256,'Raw provider body changed');
    assert.equal(JSON.stringify(JSON.parse(bytes.toString('utf8'))),bytes.toString('utf8'),'Raw provider original must be the exact serialized payload');
  }
  assert.deepEqual(providers.map(event=>[event.turn,event.payloadSha256,event.payloadBytes]),
    costEvents.filter(event=>event.phase==='provider_request').map(event=>[event.turn,event.payload.sha256,event.payload.bytes]),
    'Raw provider originals must bind every cost event, including repeated payloads');
  for(const sample of answers) {
    assert.equal(sample.answerFile,sample.id+'-answer.json');
    const answer=JSON.parse(await readFile(join(processEvidence,sample.answerFile),'utf8'));
    assert.equal(answer.version,1);assert.equal(answer.sampleId,sample.id);assert.equal(answer.turn,sample.turn);
    assert.equal(answer.stopReason,sample.stopReason);assert.equal(hash(answer.text),sample.answerSha256);
    assert.equal(Buffer.byteLength(answer.text),sample.answerBytes);
    const ends=costEvents.filter(event=>event.phase==='agent_end'&&event.turn===sample.turn);
    assert.equal(ends.length,1,'Final answer requires its actual agent terminal');
    assert.equal(ends[0].final?.text?.sha256,sample.answerSha256);assert.equal(ends[0].final?.text?.bytes,sample.answerBytes);
  }
  return {complete:true,providerOriginals:providers.length,finalAnswers:answers.length,contentPolicy:'private provider body and actual final text; no HTTP headers'};
}

/** A reviewer may stop future samples after a natural terminal; this cannot
 * mark a sample successful, change a prompt or authorize a replacement run. */
export async function readModelReviewStop(evidence,completed) {
  const path=join(evidence,'semantic-stop-request.json');let bytes;
  try{bytes=await readFile(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const request=JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(request).sort(),['version','kind','sampleId','answerSha256','reason'].sort());
  assert.equal(request.version,1);assert.equal(request.kind,'semantic-failure');
  assert.ok(typeof request.reason==='string'&&request.reason.trim()&&request.reason.length<=5000);
  const samples=completed.filter(sample=>sample.id===request.sampleId&&typeof sample.answerSha256==='string');
  assert.equal(samples.length,1,'Semantic stop must name one completed answer');
  assert.equal(request.answerSha256,samples[0].answerSha256,'Semantic stop must bind the exact observed answer');
  return {...request,path,requestSha256:hash(bytes)};
}

export function summarizeNativeSource(events, transport, ownedLifecycle, requiredFiles) {
  let observed = false;
  try {verifyNativeInspectionEvents(events); observed=true;} catch { /* Preserve unknown on a missing or invalid observer. */ }
  const starts=ownedLifecycle.filter(row=>row.event==='spawn'),ends=ownedLifecycle.filter(row=>row.event==='close');
  const hostClosed=starts.length>0&&starts.length===ends.length&&starts.every(row=>ends.filter(end=>end.pid===row.pid&&end.observedExit===true).length===1);
  const reads=events.filter(row=>row.phase==='native_read_result'&&row.complete),providers=events.filter(row=>row.phase==='native_provider');
  const otherHttp=transport.filter(row=>row.phase==='request_start'&&row.category!=='model');
  const children=events.filter(row=>row.phase==='child_start');
  const complete=observed&&hostClosed&&transport.at(-1)?.complete===true&&otherHttp.length===0&&children.length===0
    &&!events.some(row=>['unexpected_sdk_operation','unexpected_product_tool'].includes(row.phase))
    &&providers.length>0&&providers.every(row=>row.catalogMatches&&row.brokerAbsent);
  return {complete,transport:'pi-native-local',sourceObserved:observed,sourceObserverComplete:observed,hostClosed,
    cliStarts:complete?0:null,cliCloses:complete?0:null,sdkStarts:complete?0:null,sdkCloses:complete?0:null,
    unmatchedChildren:children.length,httpAttempts:complete?0:null,observedNonModelHttpAttempts:otherHttp.length,
    requestBodyBytes:complete?0:null,decodedResponseBytes:complete?0:null,
    nativeFileReadResults:reads.length,nativeFileReadBytes:reads.reduce((total,row)=>total+row.bytes,0),filesystemSyscalls:null,
    requiredPaths:requiredFiles.map(file=>file.path),wireBytes:null,
    method:'Actual Pi native read outputs; no Broker extension or source. Complete passive observer and owned host closure, zero SDK/product calls, zero child starts, zero non-model Undici attempts. OS page cache and filesystem syscall counts are not observed.'};
}
async function bundledRuntimeAt(extension) {
  const locate=async name=>{
    for(const path of [join(dirname(extension),name),resolve(dirname(extension),'../dist',name)]) {
      try { await access(path); return {path:await realpath(path),sha256:hash(await readFile(path))}; }
      catch(error) { if(error.code!=='ENOENT')throw error; }
    }
    throw new Error('Bundled runtime artifact missing: '+name);
  };
  const cli=await locate('ntn-skills.mjs'),sdk=await locate('ntn-skills-sdk.mjs');
  const manifestPath=join(dirname(sdk.path),'ntn-skills-runtime.json'),manifestBytes=await readFile(manifestPath);
  const manifest=JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest.version,1);assert.equal(manifest.package,'ntn-skills');assert.equal(manifest.sdk_version,1);assert.equal(manifest.consumer_contract_version,1);
  return {cli,sdk,manifest:{path:await realpath(manifestPath),sha256:hash(manifestBytes),packageVersion:manifest.package_version}};
}
async function doctor(config) {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24 && !process.versions.bun, 'Use supported Node runtime');
  const host = await resolveHost('pi');
  const version = await runCommand('pi', ['--version'], { cwd: root, env: process.env, timeoutMs: 10000 });
  const comparison = await modelBaselineComparison(config, host);
  if(!nativeLocal(config)&&config.transport!=='sdk')for (const path of config.command) await access(path);
  const bundledRuntime=config.transport==='sdk'?await bundledRuntimeAt(config.extension):null;
  const runtimeDirectory = nativeLocal(config) ? join(comparison.nativePackage.directory,'dist') : dirname(config.extension);
  const runtime = await tree(runtimeDirectory);
  return { status:'ready', node:process.versions.node, pi:version.stdout.trim(), piIdentity:host.identity,
    piSha256:hash(await readFile(host.identity)), runtime, runtimeDirectory, extension:config.extension??null,
    role:config.role??null,comparison,sourceTransport:nativeLocal(config)?'pi-native-local':config.transport??'cli',bundledRuntime,
    cliSha256:nativeLocal(config)?null:bundledRuntime?.cli.sha256??hash(await readFile(config.command[1])),
    packageSha256:config.packagePath ? hash(await readFile(config.packagePath)) : null,
    model:'magpie/group/flash-free',toolProfile:config.toolProfile??'standard',tools:modelBaselineTools(config), authentication:'not-probed' };
}

function observeComparisonCatalog(api,{fs,crypto,path,directory,output}) {
  let turn=0,number=0,errors=0,closed=false;
  const append=value=>fs.appendFileSync(output,JSON.stringify(value)+'\n');
  const guard=handler=>(...args)=>{if(closed)return;try{handler(...args);}catch{errors++;}};
  api.on('input',guard(()=>{turn++;}));
  api.on('tool_call',guard(event=>append({phase:'tool_call',turn,name:event.toolName,id:event.toolCallId,input:event.input})));
  api.on('tool_result',guard(event=>append({phase:'tool_result',turn,name:event.toolName,id:event.toolCallId,isError:event.isError===true})));
  api.on('before_provider_request',guard(event=>{
    const bytes=JSON.stringify(event.payload),name='payload-'+(++number)+'.json';
    fs.writeFileSync(path.join(directory,name),bytes,{flag:'wx',mode:0o600});
    append({phase:'provider',turn,number,file:name,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
  }));
  api.on('session_shutdown',guard(()=>{append({phase:'end',complete:errors===0,errors});closed=true;}));
}

function observeComparisonCatalogSources({fs,diagnostics,directory}) {
  let count=0,errors=0;
  diagnostics.subscribe('context-broker.notion-sdk-result',event=>{
    try {
      if(event?.version!==1||event.operation!=='list'||typeof event.id!=='string')throw new Error('Only metadata results belong to catalog selection');
      fs.writeFileSync(directory+'/source-'+(++count)+'.json',JSON.stringify({version:1,id:event.id,pid:process.pid,
        transport:'sdk',operation:'list',status:'completed',resultObserved:true,value:event.value}),{flag:'wx',mode:0o600});
    } catch {errors++;}
  });
  process.once('exit',()=>{try{fs.writeFileSync(directory+'/capture-end.json',JSON.stringify({complete:errors===0,count,errors}),{flag:'wx',mode:0o600});}catch{}});
}

export function verifyComparisonSelection({hooks,wires,sources,sourceEvents,expectedRecords,viewId}) {
  const providers=hooks.filter(row=>row.phase==='provider'),calls=hooks.filter(row=>row.phase==='tool_call');
  assert.deepEqual(providers.map(row=>row.turn),[1,1,2],'A ready catalog needs a separate ordinary continuation');
  assert.equal(wires.length,3);assert.equal(hooks.at(-1)?.phase,'end');assert.equal(hooks.at(-1)?.complete,true);
  assert.equal(calls.length,1);assert.equal(calls[0].name,'notion_list');assert.deepEqual(calls[0].input,{});
  assert.equal(hooks.filter(row=>row.phase==='tool_result'&&row.id===calls[0].id&&row.name==='notion_list'&&!row.isError).length,1);
  const expected=expectedRecords.map(record=>({...record,disableModelInvocation:false}));
  for(const [index,provider]of providers.entries()) {
    assert.equal(provider.number,index+1);assert.equal(provider.sha256,hash(JSON.stringify(provider.payload)),'Catalog hook payload changed');
    assert.equal(provider.sha256,wires[index].sha256,'Actual catalog hook differs from the HTTP serializer');
    const block=comparisonCatalogBlock(provider.payload,index<2);
    if(index<2&&(block===null||/<view\s[^>]*\bstatus="pending"/.test(block)))continue;
    verifyComparisonCatalog(expected,comparisonCatalog(provider.payload));
  }
  const catalog=comparisonCatalog(providers.at(-1).payload);
  const starts=sourceEvents.filter(row=>row.phase==='started');
  assert.ok(starts.length>0&&starts.every(row=>row.kind==='sdk'&&row.operation==='list'),'Catalog selection permits only SDK metadata operations');
  assert.equal(sources.length,starts.length,'Every actual metadata operation needs its raw SDK result');
  for(const source of sources) {
    assert.equal(source.operation,'list');assert.equal(source.transport,'sdk');assert.equal(source.status,'completed');assert.equal(source.resultObserved,true);
    const requestId='sdk:'+source.pid+':'+source.id;
    assert.equal(starts.filter(row=>row.requestId===requestId).length,1,'Raw catalog result must bind one actual SDK operation');
    assert.equal(sourceEvents.filter(row=>row.phase==='completed'&&row.requestId===requestId&&row.status==='completed').length,1);
  }
  const ids=records=>records.map(record=>record.id).sort();
  const matching=sources.filter(source=>source.value?.view?.id===viewId);
  assert.ok(matching.length>0,'The actual SDK must return this existing View');
  for(const source of matching) {
    assert.equal(source.value.coverage?.exhaustive,true);assert.equal(source.value.coverage.search_index_limited,false);
    assert.deepEqual(source.value.coverage.failed_sources,[]);assert.equal(source.value.count,source.value.records.length);
    assert.deepEqual(ids(source.value.records),ids(expectedRecords),'The View owner set differs from the frozen inputs');
    for(const record of source.value.records) {
      const expectedRecord=expectedRecords.find(item=>item.id===record.id);
      for(const key of ['id','ref','kind','name','description'])assert.equal(record[key],expectedRecord[key],'The SDK candidate differs: '+key);
    }
    verifyComparisonCatalog(source.value.records.map(record=>({...record,disableModelInvocation:false})),catalog);
  }
  return {catalog,payload:providers.at(-1),source:matching.at(-1)};
}

async function selection(config,parent) {
  assert.equal(config.role,'notion-candidate');assert.equal(config.transport,'sdk');
  const descriptor=JSON.parse(await readFile(config.comparison,'utf8'));
  assert.equal(descriptor.version,2);assert.match(descriptor.viewId,/^[a-f0-9-]{36}$/);
  const visibilityPolicy=comparisonVisibilityPolicy(descriptor);
  assert.ok(Array.isArray(descriptor.candidates)&&descriptor.candidates.length>0);
  const expectedRecords=[];
  for(const candidate of descriptor.candidates) {
    const manifest=await frozenJson(candidate.manifest);assert.equal(manifest.record.id,candidate.recordId);
    expectedRecords.push(manifest.record);
  }
  assert.equal(new Set(expectedRecords.map(record=>record.id)).size,expectedRecords.length);
  assert.ok(expectedRecords.some(record=>record.id===descriptor.selectedRecordId));
  const host=await resolveHost('pi'),pi=await installedPiPackage(host),artifacts=await packageIdentity(config),runtime=await bundledRuntimeAt(config.extension);
  assert.equal(pi.version,descriptor.piVersion,'Use the comparison frozen Pi version for metadata selection');
  const evidence=await mkdtemp(join(await evidenceRoot(parent,await systemTempRoot()),'skill-model-catalog-'));
  const scratch=await mkdtemp(join(await systemTempRoot(),'skill-model-catalog-scratch-')),runId=randomUUID(),clockId=runId;
  const payloads=join(evidence,'provider-payloads'),sourceDirectory=join(evidence,'source-results');
  await Promise.all([payloads,sourceDirectory].map(path=>mkdir(path)));
  const output=join(evidence,'catalog-hooks.jsonl'),ledger=join(evidence,'source.jsonl'),wire=join(evidence,'wire.jsonl'),owned=join(evidence,'owned-processes.jsonl');
  await Promise.all([output,wire].map(path=>writeFile(path,'',{flag:'wx',mode:0o600})));
  const report={version:1,kind:'installed-pi-catalog-preflight',status:'running',runId,evidence,scratch,sourceMode:'sdk',
    database:config.database,viewId:descriptor.viewId,visibilityPolicy,artifacts,pi,bodyRequests:null,realModelRequests:0,
    input:{path:config.comparison,sha256:hash(await readFile(config.comparison))},
    driverSha256:hash(await readFile(fileURLToPath(import.meta.url))),processes:[]};
  await save(join(scratch,'owner.json'),{runId,evidence});
  await save(join(evidence,'ownership.json'),{runId,evidence,scratch,kind:report.kind});
  await save(join(evidence,'intent.json'),report);
  const brokerConfig=join(scratch,'broker.json');
  await save(brokerConfig,{pathMode:'hash',logPaths:false,skillRoots:[],extraSkillRoots:[],
    sources:[modelBaselineSource(config,{cacheDir:join(scratch,'broker-cache'),viewId:descriptor.viewId})]});
  const observer=join(scratch,'cost.mjs'),transport=join(scratch,'transport.mjs'),capture=join(scratch,'catalog.mjs'),preload=join(scratch,'source.mjs');
  await writeFile(observer,consumptionCostExtensionSource({output:join(evidence,'cost.jsonl'),checkoutRoot:root,runId,sampleId:'catalog',clockId}),{flag:'wx',mode:0o600});
  await writeFile(transport,providerTransportExtensionSource({output:join(evidence,'transport.jsonl'),checkoutRoot:root,clockId}),{flag:'wx',mode:0o600});
  await writeFile(capture,"import fs from 'node:fs';import crypto from 'node:crypto';import path from 'node:path';export default api=>("
    +observeComparisonCatalog.toString()+')(api,{fs,crypto,path,...'+JSON.stringify({directory:payloads,output})+'});\n',{flag:'wx',mode:0o600});
  await writeFile(preload,sourceObserverPreloadSource({output:ledger,checkoutRoot:root,clockId,cliPath:runtime.cli.path,ownerEntry:host.identity,ownerParentPid:process.pid})
    +'\nif(owned)('+observeComparisonCatalogSources.toString()+')({fs,diagnostics,directory:'+JSON.stringify(sourceDirectory)+'});\n',{flag:'wx',mode:0o600});
  let wireCount=0,wireFailure;
  const server=createServer(async(request,response)=>{
    try {
      let raw='';for await(const chunk of request)raw+=chunk;
      const body=JSON.parse(raw),number=++wireCount;
      await writeFile(wire,JSON.stringify({number,sha256:hash(raw),bytes:Buffer.byteLength(raw),body})+'\n',{flag:'a'});
      assert.ok(number<=3,'Only one metadata tool call and one ordinary continuation are planned');
      assert.deepEqual(body.tools.map(tool=>tool.function?.name??tool.name).sort(),modelBaselineTools(config).sort());
      const tool=number===1,chunk=(delta,finish_reason=null)=>'data: '+JSON.stringify({id:'catalog-'+number,object:'chat.completion.chunk',
        created:1,model:'metadata',choices:[{index:0,delta,finish_reason}]})+'\n\n';
      response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
      response.end(chunk({role:'assistant'})+chunk(tool?{tool_calls:[{index:0,id:'catalog-list',type:'function',function:{name:'notion_list',arguments:'{}'}}]}:
        {content:'Metadata observation complete.'})+chunk({},tool?'tool_calls':'stop')+'data: [DONE]\n\n');
    } catch(error) {wireFailure=error;response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:error.message}}));}
  });
  await new Promise(accept=>server.listen(0,'127.0.0.1',accept));server.unref();
  const provider=join(scratch,'provider.mjs'),model='skill-model-catalog/metadata';
  await writeFile(provider,"export default api=>api.registerProvider('skill-model-catalog',{name:'Metadata-only catalog observation',baseUrl:"
    +JSON.stringify('http://127.0.0.1:'+server.address().port+'/v1')+",api:'openai-completions',apiKey:'controlled-no-secret',models:[{id:'metadata',name:'Controlled metadata observer',input:['text'],contextWindow:1000000,maxTokens:256,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});\n",{flag:'wx',mode:0o600});
  const env=verificationCliEnvironment(join(scratch,'cli'));
  Object.assign(env,{CONTEXT_BROKER_CONFIG:brokerConfig,CONTEXT_BROKER_HOST:'pi',CONTEXT_BROKER_LOG_FILE:join(evidence,'broker.jsonl'),
    BROKER_E2E_PROCESS_LEDGER:owned,NTN_SKILLS_REQUEST_TRACE_LIMIT:'10000',PWD:scratch});
  for(const key of ['NODE_OPTIONS','CONTEXT_BROKER_ROOTS','CONTEXT_BROKER_EXTRA_ROOTS','CONTEXT_BROKER_DISCOVERY_CATALOGS','CONTEXT_BROKER_EXTRA_DISCOVERY_CATALOGS','OLDPWD','INIT_CWD'])delete env[key];
  env.NODE_OPTIONS='--import='+pathToFileURL(preload).href;
  const args=modelBaselineHostArgs(config,{base:scratch,observer,transport,inspection:capture,comparison:{directory:descriptor.directory}});
  args.splice(args.length-2,2,'-e',provider,'--model',model);
  let rpc,boundary;
  try {
    rpc=await startRpc({host:'pi',cwd:scratch,env,args,timeoutMs:90000,waitForState:false});
    for(const prompt of ['Inspect the available Notion metadata directory only. Do not load instructions or resources.','Continue by reporting the current default directory state only.'])await rpc.prompt(prompt);
    if(wireFailure)throw wireFailure;
    boundary=await settleSource(ledger,'sdk');assert.ok(boundary.quiet&&boundary.observed);
    await rpc.closeInput();
  } catch(error){report.error=safeDiagnostic(Buffer.from(error.message));if(rpc)try{await rpc.stop();}catch{}}
  finally {server.closeAllConnections();await new Promise(accept=>server.close(accept));if(rpc)await save(join(evidence,'pi-rpc.json'),rpc.frames);}
  try {
    const observation=await readSourceObservation(ledger),lifecycle=await rows(owned);
    const source=summarizeSource(observation.events,{transport:'sdk',sourceObservation:observation,ownedLifecycle:lifecycle,
      beforeCloseRequestIds:boundary?.requestIds,beforeCloseChildIds:boundary?.childIds});
    report.processes=[{id:'.',sourceTransport:'sdk',source}];report.sourceAccounting=source;
    report.bodyRequests=source.requestKinds.notion_body;report.processesClosed=source.hostClosed;
    report.setupCost={httpAttempts:source.httpAttempts,observedHttpAttempts:source.observedHttpAttempts,
      requestBytes:source.requestBodyBytes,responseBytes:source.decodedResponseBytes,
      scope:'Metadata selection/setup only, including failed observations; separate from source acquisition and later task consumers.'};
    assert.ok(source.complete,'Metadata source and host lifecycle must close completely');
    const attempts=observation.events.filter(row=>row.phase==='attempt');
    assert.ok(attempts.every(row=>row.request_kind==='notion_metadata'),'Catalog selection must not read bodies or write Notion');
    const captureEnd=JSON.parse(await readFile(join(sourceDirectory,'capture-end.json'),'utf8'));
    assert.equal(captureEnd.complete,true);
    const sources=await Promise.all((await readdir(sourceDirectory)).filter(name=>/^source-\d+\.json$/.test(name)).sort()
      .map(async name=>({...JSON.parse(await readFile(join(sourceDirectory,name),'utf8')),file:'source-results/'+name})));
    assert.equal(sources.length,captureEnd.count);
    const hooks=await rows(output);
    for(const row of hooks.filter(row=>row.phase==='provider'))row.payload=JSON.parse(await readFile(join(payloads,row.file),'utf8'));
    const checked=verifyComparisonSelection({hooks,wires:await rows(wire),sources,sourceEvents:observation.events,expectedRecords,viewId:descriptor.viewId});
    report.catalog=checked.catalog;report.record=checked.source.value.records.find(record=>record.id===descriptor.selectedRecordId);
    report.defaultDiscovery={status:'passed',catalog:{status:'ready'},ordinaryTurns:2,controlledProviderRequests:3};
    report.providerPayload='provider-payloads/'+checked.payload.file;report.catalogSource=checked.source.file;
    assert.equal(report.bodyRequests,0);
    assert.equal(hash(await readFile(fileURLToPath(import.meta.url))),report.driverSha256,'Metadata driver changed during observation');
    assert.equal(hash(await readFile(config.comparison)),report.input.sha256,'Metadata selection input changed');
    for(const file of artifacts.runtimeFiles)assert.equal(hash(await readFile(join(artifacts.packageRoot,file.path))),file.sha256,'Installed candidate changed');
    assert.deepEqual(await installedPiPackage(await resolveHost('pi')),pi,'Installed Pi identity changed');
    report.runtimeUnchanged=true;
    assert.equal(report.error,undefined,'A failed metadata run cannot be relabelled by later observations');
    report.status='passed';
  } catch(error) {report.status='failed';report.error??=safeDiagnostic(Buffer.from(error.message));}
  report.files=Object.keys((await tree(evidence)).files);
  await save(join(evidence,'report.json'),report);
  const artifact=async name=>({path:join(evidence,name),sha256:hash(await readFile(join(evidence,name)))});
  const inputs=report.status==='passed'?{notionSelection:await artifact('report.json'),notionProviderPayload:await artifact(report.providerPayload),notionCatalogSource:await artifact(report.catalogSource)}:null;
  await save(join(evidence,'comparison-artifacts.json'),inputs);
  await save(join(evidence,'retained.json'),await tree(evidence));
  console.log(JSON.stringify({status:report.status,evidence,setupCost:report.setupCost,comparisonArtifacts:inputs,error:report.error},null,2));
  if(report.status!=='passed')process.exitCode=1;
}

function textOf(frame) {
  const message = [...(frame?.messages ?? [])].reverse().find(message => message.role === 'assistant');
  return { text: (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n'), stopReason:message?.stopReason };
}
export function verifyModelAnswer(answer, expectedAnswers) {
  if (answer?.stopReason !== 'stop' || typeof answer.text !== 'string' || !answer.text.trim()) return false;
  const permissionOnly = answer.text.length < 1200 && /(?:please\s+(?:approve|authorize|confirm)|(?:need|require|await)\w*\s+(?:your\s+)?(?:approval|permission)|(?:请|需要|等待).{0,15}(?:授权|批准|确认))/iu.test(answer.text);
  return !permissionOnly && expectedAnswers.some(value => answer.text.includes(value));
}
function summarizeTurn(sample, events, transport) {
  const selected = events.filter(event => event.turn === sample.turn);
  const requests = selected.filter(event => event.phase === 'provider_request');
  const assistants = selected.filter(event => event.phase === 'message_end' && event.message?.role === 'assistant');
  const firstText = selected.find(event => event.phase === 'message_update' && event.firstEffectiveText);
  const elapsed = event => event ? Number(BigInt(event.monotonicNs) - BigInt(sample.submitNs)) / 1e6 : null;
  const add = values => values.length && values.every(value => typeof value === 'number' && Number.isFinite(value)) ? values.reduce((a,b) => a+b,0) : null;
  const active = transport.filter(event => event.phase === 'request_start' && event.category === 'model' && BigInt(event.monotonicNs) >= BigInt(sample.submitNs)
    && BigInt(event.monotonicNs) <= BigInt(sample.completeNs));
  const ids = new Set(active.map(event => event.id));
  const sent = transport.filter(event => event.phase === 'request_sent' && ids.has(event.id));
  const completed = transport.filter(event => event.phase === 'request_end' && ids.has(event.id));
  const payloadsMatch = requests.length > 0 && requests.every(event => sent.some(request => request.requestBodySha256 === event.payload.sha256));
  return { ...sample, observedProviderHooks:requests.length, toolCalls:selected.filter(event => event.phase === 'tool_call').length,
    toolRounds:new Set(selected.filter(event => event.phase === 'tool_call').map(event => event.request)).size,
    providerPayloadJsonBytes:add(requests.map(event => event.payload.bytes)), firstProviderPayloadJsonBytes:requests[0]?.payload.bytes ?? null,
    providerToolSchemaJsonBytes:add(requests.map(event=>event.payload.components.filter(part=>part.group==='tools').reduce((total,part)=>total+part.bytes,0))),
    providerDiagnosticSpanBytes:Object.fromEntries(['catalog','native-skill-directory','native-router-directory','guidance'].map(kind=>[kind,
      add(requests.map(event=>event.payload.diagnosticSpans.filter(part=>part.kind===kind).reduce((total,part)=>total+part.bytes,0)))])),
    providerComponentMethod:'All requests, including repeated history; diagnostic spans overlap and are not additive token estimates',
    reportedUsage:Object.fromEntries(['input','output','cacheRead','cacheWrite','totalTokens'].map(key => [key,add(assistants.map(event => event.message.usage[key]))])),
    submitToFirstProviderMs:elapsed(requests[0]), submitToFirstModelHttpMs:elapsed(active[0]), submitToFirstEffectiveTextMs:elapsed(firstText),
    submitToCompletionMs:Number(BigInt(sample.completeNs)-BigInt(sample.submitNs))/1e6,
    modelHttp:{ attempts:active.length, completed:completed.length, successful:completed.filter(event => event.status >= 200 && event.status < 300 && event.outcome === 'completed').length,
      requestBodyBytes:add(sent.map(event => event.requestBodyBytes)), responseEntityBytes:add(completed.map(event => event.responseEntityBytes)),
      decodedResponseBytes:add(completed.map(event => event.decodedResponseBytes)), payloadHashesMatchObservedRequests:payloadsMatch,
      method:'Node Undici diagnostics; HTTP entity chunks, not TCP/TLS wire', retryWaitMs:null, queueWaitMs:null, wireBytes:null },
    observationComplete:events.at(-1)?.phase === 'observer_end' && events.at(-1)?.complete === true
      && transport.at(-1)?.complete === true && transport.at(-1)?.selectedModel === hash('magpie/group/flash-free')
      && payloadsMatch && active.length === completed.length };
}
export function modelProcessTerminalFailure(result,{costEvents,transportEvents,inspectionRequired=false}) {
  if(result.status!=='closed'||result.source?.hostClosed!==true)
    return 'Owned process has no complete close boundary; no later sample will be submitted';
  if(result.source?.complete!==true||result.observedSourcesQuiet!==true)
    return 'Source observation is incomplete; no later sample will be submitted';
  if(costEvents.at(-1)?.phase!=='observer_end'||costEvents.at(-1)?.complete!==true)
    return 'Provider cost observation is incomplete; no later sample will be submitted';
  if(transportEvents.at(-1)?.phase!=='transport_end'||transportEvents.at(-1)?.complete!==true)
    return 'Provider transport observation is incomplete; no later sample will be submitted';
  if(inspectionRequired&&(result.inspectionComplete!==true||result.rawEvidence?.complete!==true))
    return 'Raw provider/answer observation is incomplete; no later sample will be submitted';
}
export function summarizeSource(ledger, { beforeCloseRequestIds, beforeCloseChildIds, ownedLifecycle = [], transport = 'cli', sourceObservation } = {}) {
  const starts=ledger.filter(row=>row.phase==='started'), ends=ledger.filter(row=>row.phase==='completed');
  const metrics=ledger.filter(row=>row.phase==='metrics'), attempts=ledger.filter(row=>row.phase==='attempt'), waits=ledger.filter(row=>row.phase==='wait');
  const ids=starts.map(row=>row.requestId), hostStarts=ownedLifecycle.filter(row=>row.event==='spawn'), hostEnds=ownedLifecycle.filter(row=>row.event==='close');
  const hostClosed=hostStarts.length>0&&hostStarts.every(row=>hostEnds.filter(end=>end.pid===row.pid&&end.observedExit===true).length===1)
    &&hostEnds.length===hostStarts.length;
  const boundaryObserved=Array.isArray(beforeCloseRequestIds);
  const lateStarts=boundaryObserved?ids.filter(id=>!beforeCloseRequestIds.includes(id)):null;
  const sdkStarts=starts.filter(row=>row.kind==='sdk'),sdkEnds=ends.filter(row=>row.kind==='sdk');
  const cliStarts=starts.filter(row=>row.kind!=='sdk'),cliEnds=ends.filter(row=>row.kind!=='sdk');
  const unmatchedStarts=ledger.filter(row=>row.phase==='unmatched_child_start'),unmatchedChildren=unmatchedStarts.length;
  const lateChildStarts=Array.isArray(beforeCloseChildIds)?unmatchedStarts.map(row=>row.childId).filter(id=>!beforeCloseChildIds.includes(id)):null;
  const complete=starts.length>0&&new Set(ids).size===ids.length&&boundaryObserved&&lateStarts.length===0&&hostClosed
    &&(transport!=='sdk'||sourceObservation?.complete===true&&unmatchedChildren===0)
    &&starts.every(row=>ends.filter(end=>end.requestId===row.requestId).length===1
      &&metrics.filter(metric=>metric.requestId===row.requestId&&metric.observed&&metric.complete).length===1)
    &&ends.length===starts.length&&metrics.length===starts.length;
  const add=values=>values.every(value=>typeof value==='number'&&Number.isFinite(value))?values.reduce((a,b)=>a+b,0):null;
  return {complete,transport,cliStarts:cliStarts.length,cliCloses:cliEnds.length,sdkStarts:sdkStarts.length,sdkCloses:sdkEnds.length,
    cliSpawnEvents:ledger.filter(row=>row.phase==='child-started').length,sdkEntered:sdkEnds.filter(row=>row.sdkStarted===true).length,
    operationStarts:starts.length,operationCloses:ends.length,unmatchedChildren,
    unmatchedChildLifecycle:sourceObservation?.unmatchedChildLifecycle??null,lateChildStarts,
    sourceObserverComplete:transport==='sdk'?sourceObservation?.complete===true:null,
    sourceObserverErrors:transport==='sdk'?(sourceObservation?.errors??['missing-observer']):[],
    httpAttempts:complete?attempts.length:null,observedHttpAttempts:attempts.length,
    sourceObserved:starts.length>0,hostClosed,beforeCloseBoundaryObserved:boundaryObserved,lateStarts,
    completenessScope:'observed source operations through final ledger reconciliation; quiet is not a metadata-producer terminal receipt',
    requestKinds:Object.fromEntries(['notion_metadata','notion_body','notion_write','provider'].map(kind=>[kind,complete?attempts.filter(row=>row.request_kind===kind).length:null])),
    requestBodyBytes:complete?add(attempts.map(row=>row.request_bytes)):null,decodedResponseBytes:complete?add(attempts.map(row=>row.response_bytes)):null,
    queueWaitMs:complete?add(waits.filter(row=>row.wait_kind==='queue').map(row=>row.milliseconds)):null,
    retryWaitMs:complete?add(waits.filter(row=>row.wait_kind==='retry').map(row=>row.milliseconds)):null,
    wireBytes:null,method:transport==='sdk'?'public SDK diagnostics and unchanged direct bundled CLI stdout request_metrics; includes observed source work after model completion'
      :'project request_metrics; includes observed source work after model completion'};
}
async function sourceRows(path,transport,final=false) {
  return transport==='sdk'?readSourceObservation(path,{final}):{events:await rows(path),complete:null,errors:[]};
}
export async function settleSource(path,transport='cli') {
  let last = -1, quietSince = process.hrtime.bigint();
  const started = process.hrtime.bigint();
  while (Number(process.hrtime.bigint()-started)/1e6 < 120000) {
    const observation=await sourceRows(path,transport),ledger=observation.events,pending=new Set(),pendingChildren=new Set();
    for (const row of ledger) { if (row.phase === 'started') pending.add(row.requestId); if (row.phase === 'completed') pending.delete(row.requestId); }
    const childStarts=ledger.filter(row=>row.phase==='unmatched_child_start');
    for (const row of ledger) {
      if (row.phase==='unmatched_child_start') pendingChildren.add(row.childId);
      if (row.phase==='unmatched_child_close') pendingChildren.delete(row.childId);
    }
    if (ledger.length !== last) { last=ledger.length; quietSince=process.hrtime.bigint(); }
    if (!pending.size&&!pendingChildren.size&&!(observation.errors?.length) && Number(process.hrtime.bigint()-quietSince)/1e6 >= 700) return {
      quiet:true, observed:ledger.some(row=>row.phase==='started'), rows:ledger.length,
      requestIds:ledger.filter(row=>row.phase==='started').map(row=>row.requestId),childIds:childStarts.map(row=>row.childId) };
    await sleep(50);
  }
  return { quiet:false, observed:false, rows:(await sourceRows(path,transport)).events.length, requestIds:[],childIds:[] };
}
async function run(config, parent) {
  const preflight = await doctor(config);
  const sourceTransport = preflight.sourceTransport;
  const evidence = await mkdtemp(join(await evidenceRoot(parent, await systemTempRoot()), 'skill-model-cost-'));
  const scratch = await mkdtemp(join(await systemTempRoot(), 'skill-model-cost-scratch-'));
  const runId = randomUUID(), clockId = runId, planned = [
    ...Array.from({length:config.counts.cold},(_,i)=>({id:'cold-'+(i+1),cache:'cold',session:'new'})),
    ...Array.from({length:config.counts.warm},(_,i)=>({id:'warm-'+(i+1),cache:'warm',session:'existing'}))];
  const harnessPaths=['scripts/skill-consumption-model-baseline.mjs','scripts/skill-consumption-cost.mjs','scripts/skill-consumption-provider.mjs',
    'scripts/notion-default-context.mjs',...(config.transport==='sdk'?['scripts/skill-consumption-source-observer.mjs']:[])];
  const harnessFiles=await Promise.all(harnessPaths.map(async path=>({path,sha256:hash(await readFile(join(root,path)))})));
  const plan = { version:1, kind:'skill-consumption-model-baseline', runId, clockId, config, preflight,harnessFiles,
    frozenAt:new Date().toISOString(), samples:planned, freshness:'unchanged production defaults; prefetch false',
    isolation:'disjoint production source/Broker caches; normal authentication only; no oracle preparation',
    warmCondition:'same process and existing session after final cold task; context history is retained and counted',
    answerPredicate:'normal stop, nonblank final text, no permission-only reply, and a frozen expected-answer substring; semantic correctness still requires review',
    earlyStop:'after first failed task/availability/owned-process failure, or a completed-answer semantic stop request; preserve remaining not-run entries',
    rawEvidence:preflight.comparison?'Private before_provider_request payloads and actual final answers, hash/byte bound to cost events; no HTTP headers. Semantic review may stop future samples at a natural turn terminal.':null,
    role:config.role??null,comparison:preflight.comparison,
    nativeCondition:nativeLocal(config)?'Local fixed files already exist; provider/session cold, OS page cache uncontrolled. Doctor hashes fixed inputs separately; no body is injected into the consumer.':null,
    toolProfile:config.toolProfile??'standard',tools:modelBaselineTools(config), observer:'passive hooks plus Node Undici diagnostics',sourceTransport,
    driverSha256:hash(await readFile(fileURLToPath(import.meta.url))),
    networkCondition:'same machine; run real service batches serially; ambient network is measured rather than controlled',
    observerSha256:hash(await readFile(join(root,'scripts/skill-consumption-cost.mjs'))),
    transportObserverSha256:hash(await readFile(join(root,'scripts/skill-consumption-provider.mjs'))),
    sourceObserverSha256:config.transport==='sdk'?hash(await readFile(join(root,'scripts/skill-consumption-source-observer.mjs'))):null };
  await save(join(evidence,'plan.json'),plan);
  await save(join(scratch,'owner.json'),{runId,evidence});
  await save(join(evidence,'ownership.json'),{runId,evidence,scratch,kind:plan.kind});
  const samples = [], processes = []; let stoppedReason,reviewStop;
  const checkReviewStop=async local=>{
    if(stoppedReason||reviewStop)return;
    const completed=[...samples,...local];
    try {
      const request=await readModelReviewStop(evidence,completed);if(!request)return;
      reviewStop={status:'accepted',...request};
      const sample=completed.find(sample=>sample.id===request.sampleId);
      sample.automatedStatus=sample.status;sample.status='failed';sample.semanticReview={status:'failed',reason:request.reason,requestSha256:request.requestSha256};
      stoppedReason='Semantic review failed for '+request.sampleId+'; no later sample will be submitted';
    } catch(error) {reviewStop={status:'rejected',error:safeDiagnostic(Buffer.from(error.message))};stoppedReason='Invalid semantic stop request; no later sample will be submitted';}
    await save(join(evidence,'semantic-stop-applied.json'),reviewStop);
  };
  console.log(JSON.stringify({status:'running',evidence,planned:planned.length}));
  for (let processIndex=1;processIndex<=config.counts.cold;processIndex++) {
    await checkReviewStop([]);
    if(stoppedReason) break;
    const id='process-'+processIndex, base=join(scratch,id), processEvidence=join(evidence,id);
    await mkdir(base,{recursive:true,mode:0o700}); await mkdir(processEvidence,{mode:0o700});
    const ledger=nativeLocal(config)?{ledger:join(processEvidence,'native-inspection.jsonl')}:config.transport==='sdk'?{ledger:join(processEvidence,'safe-source-requests.jsonl')}
      :await createRequestLedger({scratch:base,evidence:processEvidence,command:config.command});
    const brokerConfig=join(base,'broker.json'), observation=join(processEvidence,'observer.jsonl'), network=join(processEvidence,'transport.jsonl');
    if(!nativeLocal(config)) await save(brokerConfig,{pathMode:'hash',logPaths:false,
      ...(preflight.comparison?{skillRoots:[],extraSkillRoots:[]}:{}),
      sources:[modelBaselineSource(config,{command:ledger.command,cacheDir:join(base,'broker-cache'),viewId:preflight.comparison?.viewId})]});
    const observer=join(base,'cost.mjs'), transport=join(base,'transport.mjs');
    await writeFile(observer,consumptionCostExtensionSource({output:observation,checkoutRoot:root,runId,sampleId:id,clockId}),{mode:0o600,flag:'wx'});
    await writeFile(transport,providerTransportExtensionSource({output:network,checkoutRoot:root,clockId}),{mode:0o600,flag:'wx'});
    const env=verificationCliEnvironment(join(base,'cli'));
    Object.assign(env,{CONTEXT_BROKER_CONFIG:brokerConfig,CONTEXT_BROKER_HOST:'pi',CONTEXT_BROKER_LOG_FILE:join(processEvidence,'broker.jsonl'),
      BROKER_E2E_PROCESS_LEDGER:join(processEvidence,'owned-processes.jsonl'),NTN_SKILLS_REQUEST_TRACE_LIMIT:'10000',PWD:base});
    for(const key of ['NODE_OPTIONS','CONTEXT_BROKER_ROOTS','OLDPWD','INIT_CWD']) delete env[key];
    let inspection,inspectionLog;
    if(nativeLocal(config)) {
      for(const key of Object.keys(env)) if(key.startsWith('CONTEXT_BROKER_')) delete env[key];
    }
    if(preflight.comparison) {
      inspection=join(base,'native-inspection.mjs');
      inspectionLog=nativeLocal(config)?ledger.ledger:join(processEvidence,'read-inspection.jsonl');
      const rawDirectory=join(processEvidence,'provider-payloads');await mkdir(rawDirectory,{mode:0o700});
      let validatorPath;
      if(!nativeLocal(config)) {
        const candidate=join(dirname(config.extension),'resource-read-projection.ts');
        try{await access(candidate);validatorPath=candidate;}catch(error){if(error.code!=='ENOENT')throw error;}
      }
      await writeFile(inspection,nativeInspectionExtensionSource({output:inspectionLog,clockId,rawDirectory,
        files:preflight.comparison.requiredFiles,catalog:preflight.comparison.catalog,
        unselectedFiles:preflight.comparison.unselectedFiles,unselectedSources:preflight.comparison.unselectedSources,
        ...(!nativeLocal(config)?{source:preflight.comparison.source,...(validatorPath?{validatorPath}:{})}:{})}),{mode:0o600,flag:'wx'});
    }
    if(config.transport==='sdk') {
      const preload=join(base,'source-observer.mjs');
      await writeFile(preload,sourceObserverPreloadSource({output:ledger.ledger,checkoutRoot:root,clockId,
        cliPath:preflight.bundledRuntime.cli.path,ownerEntry:preflight.piIdentity,ownerParentPid:process.pid}),{mode:0o600,flag:'wx'});
      env.NODE_OPTIONS='--import='+pathToFileURL(preload).href;
    }
    const args=modelBaselineHostArgs(config,{base,observer,transport,inspection,comparison:preflight.comparison});
    let rpc, turn=0; const local=[]; const processResult={id,status:'running',observedSourcesQuiet:false,sourceTransport};
    try {
      rpc=await startRpc({host:'pi',cwd:base,env,args,timeoutMs:120000,waitForState:false});
      const tasks=[planned[processIndex-1],...(processIndex===config.counts.cold?planned.slice(config.counts.cold):[])];
      for(const task of tasks) {
        await checkReviewStop(local);if(stoppedReason)break;
        const sourceStartRow=(await sourceRows(ledger.ledger,sourceTransport)).events.length;
        const sample={...task,process:id,turn:++turn,status:'running',submitNs:process.hrtime.bigint().toString(),promptSha256:hash(config.prompt),sourceStartRow};
        try {
          const pending=rpc.prompt(config.prompt).then(frame=>({frame,completeNs:process.hrtime.bigint().toString()}),error=>({error,completeNs:process.hrtime.bigint().toString()}));
          await save(join(processEvidence,task.id+'-submission.json'),{...sample,prompt:config.prompt});
          const completed=await pending;sample.completeNs=completed.completeNs;if(completed.error)throw completed.error;
          const answer=textOf(completed.frame);
          sample.answerSha256=hash(answer.text); sample.answerBytes=Buffer.byteLength(answer.text); sample.stopReason=answer.stopReason;
          sample.answerFile=task.id+'-answer.json';
          await save(join(processEvidence,sample.answerFile),{version:1,sampleId:sample.id,turn:sample.turn,stopReason:answer.stopReason,text:answer.text});
          sample.taskVerified=verifyModelAnswer(answer,config.expectedAnswers);
          assert.ok(sample.taskVerified,'Successful final must answer the frozen task');
          if(preflight.comparison) {
            const cost=(await readConsumptionCostEvents(observation)).events;
            const providers=cost.filter(event=>event.phase==='provider_request'&&event.turn===sample.turn);
            const inspectionEvents=await rows(inspectionLog);
            assert.equal(inspectionEvents.some(event=>event.phase==='unselected_read_result'),false,'An inspect task cannot read an unselected candidate body');
            assert.equal(inspectionEvents.some(event=>event.phase==='native_provider'&&event.catalogMatches===false),false,'The actual provider candidate set changed');
            const delivered=inspectionEvents.filter(event=>event.phase==='native_provider'&&event.turn===sample.turn)
              .filter(event=>providers.some(provider=>provider.payload.sha256===event.payloadSha256)).flatMap(event=>event.files);
            sample.inspection={entry:'read',paths:preflight.comparison.requiredFiles.map(file=>({path:file.path,sha256:file.sha256,
              delivered:delivered.some(actual=>actual.path===file.path&&actual.sha256===file.sha256&&actual.bytes===file.bytes)})),
              providerRequiredFileBytes:delivered.reduce((total,file)=>total+file.bytes,0),
              identity:nativeLocal(config)?'exact native path and full read result':'fixed source scope/owner/snapshot/version/File ID plus actual read proof',
              brokerAbsent:nativeLocal(config)?inspectionEvents.filter(event=>event.phase==='native_provider').every(event=>event.brokerAbsent):null};
            assert.ok(sample.inspection.paths.every(file=>file.delivered),'The complete frozen main and every required resource must reach actual provider content');
            assert.equal(cost.some(event=>event.phase==='tool_call'&&event.turn===sample.turn
              &&['notion_use','skill_prepare','skill_graph'].some(name=>hash(name)===event.toolNameSha256)),false,'An inspect comparison cannot substitute explicit use/Requires activation');
          }
          sample.status='passed';
        } catch(error) {
          sample.completeNs??=process.hrtime.bigint().toString();sample.status='failed';sample.error=safeDiagnostic(Buffer.from(error.message));
          stoppedReason='A planned sample failed; no fallback, replacement or deletion';
        }
        sample.sourceEndRow=(await sourceRows(ledger.ledger,sourceTransport)).events.length;
        await save(join(processEvidence,task.id+'-outcome.json'),sample); local.push(sample);
        await checkReviewStop(local);
        if(stoppedReason) break;
      }
      if(!nativeLocal(config)) {
        processResult.sourceBoundary=await settleSource(ledger.ledger,sourceTransport);
        processResult.observedSourcesQuiet=processResult.sourceBoundary.quiet&&processResult.sourceBoundary.observed;
        assert.ok(processResult.observedSourcesQuiet,'Source work is unobserved or still active; quiet alone is not a producer terminal');
      }
      await rpc.closeInput(); processResult.status='closed';
    } catch(error) {
      processResult.status='failed';processResult.error=safeDiagnostic(Buffer.from(error.message));stoppedReason??='Owned process failed';
      if(rpc) try { await rpc.stop(); } catch {}
    } finally {
      if(rpc) processResult.lifecycle=rpc.lifecycle;
      let events=[],transportEvents=[];
      try { events=(await readConsumptionCostEvents(observation)).events;transportEvents=await readProviderTransport(network); }
      catch(error) { processResult.observationError=safeDiagnostic(Buffer.from(error.message)); }
      const sourceObservation=await sourceRows(ledger.ledger,sourceTransport,true);
      const lifecycle=await rows(join(processEvidence,'owned-processes.jsonl'));
      processResult.source=nativeLocal(config)?summarizeNativeSource(sourceObservation.events,transportEvents,lifecycle,preflight.comparison.requiredFiles):summarizeSource(sourceObservation.events,{
        beforeCloseRequestIds:processResult.sourceBoundary?.requestIds,
        beforeCloseChildIds:processResult.sourceBoundary?.childIds,
        transport:sourceTransport,sourceObservation,ownedLifecycle:lifecycle });
      if(nativeLocal(config)) processResult.observedSourcesQuiet=processResult.source.complete;
      if(inspectionLog) {
        try{
          const inspectionEvents=await rows(inspectionLog);verifyNativeInspectionEvents(inspectionEvents);processResult.inspectionComplete=true;
          processResult.rawEvidence=await verifyModelRawEvidence({processEvidence,events:inspectionEvents,costEvents:events,
            answers:local.filter(sample=>sample.answerFile)});
        }
        catch(error){processResult.inspectionComplete=false;processResult.inspectionError=safeDiagnostic(Buffer.from(error.message));}
      }
      stoppedReason??=modelProcessTerminalFailure(processResult,{costEvents:events,transportEvents,
        inspectionRequired:Boolean(inspectionLog)});
      processResult.sourceLedger=ledger.ledger;
      await save(join(processEvidence,'process.json'),processResult);processes.push(processResult);
      for(const sample of local) samples.push(summarizeTurn(sample,events,transportEvents));
    }
  }
  for(const sample of planned) if(!samples.some(value=>value.id===sample.id)) samples.push({...sample,status:'not_run',reason:stoppedReason??'Process did not reach submission'});
  // Re-read after the entire batch: a slow source wrapper may log its start only
  // after its Pi host has closed. Retain process.json as the capture-time receipt.
  for(const item of processes) {
    const sourceObservation=await sourceRows(item.sourceLedger,item.sourceTransport,true);
    const lifecycle=await rows(join(evidence,item.id,'owned-processes.jsonl'));
    let nativeTransport=[];
    if(nativeLocal(config))try{nativeTransport=await readProviderTransport(join(evidence,item.id,'transport.jsonl'));}catch(error){item.observationError=safeDiagnostic(Buffer.from(error.message));}
    item.source=nativeLocal(config)?summarizeNativeSource(sourceObservation.events,nativeTransport,lifecycle,preflight.comparison.requiredFiles):summarizeSource(sourceObservation.events,{
      beforeCloseRequestIds:item.sourceBoundary?.requestIds,
      beforeCloseChildIds:item.sourceBoundary?.childIds,
      transport:item.sourceTransport,sourceObservation,
      ownedLifecycle:lifecycle });
    item.sourceReconciledAt=new Date().toISOString();
    await save(join(evidence,item.id,'process-reconciliation.json'),item);
  }
  const after=await tree(preflight.runtimeDirectory);
  const harnessUnchanged=(await Promise.all(harnessFiles.map(async file=>hash(await readFile(join(root,file.path)))===file.sha256))).every(Boolean);
  const runtimeBundleUnchanged=config.transport!=='sdk'||JSON.stringify(await bundledRuntimeAt(config.extension))===JSON.stringify(preflight.bundledRuntime);
  let comparisonUnchanged=!preflight.comparison, comparisonError;
  if(preflight.comparison)try{comparisonUnchanged=JSON.stringify(await modelBaselineComparison(config,await resolveHost('pi')))===JSON.stringify(preflight.comparison);}
  catch(error){comparisonError=safeDiagnostic(Buffer.from(error.message));}
  const observed=samples.filter(sample=>sample.status!=='not_run');
  const sourceComplete=processes.length===config.counts.cold&&processes.every(item=>item.status==='closed'&&item.observedSourcesQuiet&&item.source.complete
    &&(!preflight.comparison||item.inspectionComplete===true));
  const report={version:1,kind:plan.kind,runId,status:sourceComplete&&observed.every(sample=>sample.status==='passed'&&sample.observationComplete)&&observed.length===planned.length?'observed':'incomplete',
    evidence,scratch,planSha256:hash(await readFile(join(evidence,'plan.json'))),runtimeUnchanged:after.sha256===preflight.runtime.sha256&&runtimeBundleUnchanged&&comparisonUnchanged&&harnessUnchanged,
    role:config.role??null,comparison:preflight.comparison,comparisonUnchanged,comparisonError,sourceTransport,runtimeBundleUnchanged,
    sourceComplete,stoppedReason,reviewStop,harnessUnchanged,samples,processes,notClaimed:['Skill task or graph acceptance','installed candidate acceptance','metadata-producer completion inferred from a quiet interval','model SDK retry/queue wait attribution','TCP/TLS wire bytes',
      ...(preflight.comparison?.visibility.policy==='native-default-policy'?['Broker net cost under identical visibility; default visibility policy is an experiment variable']:[])],
    groups:Object.fromEntries(['cold','warm'].map(cache=>[cache,{planned:planned.filter(sample=>sample.cache===cache).length,observed:observed.filter(sample=>sample.cache===cache).length,
      metrics:Object.fromEntries(['submitToFirstProviderMs','submitToFirstModelHttpMs','submitToFirstEffectiveTextMs','submitToCompletionMs','providerPayloadJsonBytes','toolRounds']
        .map(key=>[key,consumptionMetricStats(observed.filter(sample=>sample.cache===cache).map(sample=>sample[key]??null))]))}]))};
  if(!report.runtimeUnchanged) report.status='incomplete';
  await save(join(evidence,'report.json'),report);
  const inventory=await tree(evidence);await save(join(evidence,'retained.json'),inventory);
  console.log(JSON.stringify({status:report.status,evidence,samples:report.samples.length,observed:observed.length,runtimeUnchanged:report.runtimeUnchanged,groups:report.groups},null,2));
  if(report.status!=='observed') process.exitCode=1;
}
async function evidence(path,cleanup=false) {
  assert.ok(isAbsolute(path??''));path=await realpath(path);
  const report=JSON.parse(await readFile(join(path,'report.json'),'utf8')), inventory=JSON.parse(await readFile(join(path,'retained.json'),'utf8'));
  for(const [name,sha] of Object.entries(inventory.files)) assert.equal(hash(await readFile(join(path,name))),sha,'Retained evidence changed: '+name);
  if(cleanup) {
    try {
      const prior=JSON.parse(await readFile(join(path,'cleanup.json'),'utf8'));
      assert.equal(prior.runId,report.runId);assert.equal(prior.evidencePreserved,true);
      await assert.rejects(access(report.scratch),{code:'ENOENT'},'A cleanup receipt cannot replace checking scratch absence');
      console.log(JSON.stringify({status:'already-trashed',functionalStatus:report.status,evidence:path,files:Object.keys(inventory.files).length}));return;
    } catch(error) { if(error.code!=='ENOENT')throw error; }
    const owner=JSON.parse(await readFile(join(path,'ownership.json'),'utf8')), scratch=owner.scratch;
    assert.equal(owner.evidence,path);assert.equal(owner.runId,report.runId);
    assert.ok(['skill-consumption-model-baseline','installed-pi-catalog-preflight'].includes(report.kind));assert.equal(owner.kind,report.kind);
    const prefix=report.kind==='installed-pi-catalog-preflight'?'skill-model-catalog-scratch-':'skill-model-cost-scratch-';
    assert.ok(dirname(scratch)===await systemTempRoot()&&scratch.startsWith(join(await systemTempRoot(),prefix)));
    for(const item of report.processes){
      const ledger=await rows(join(path,item.id,'owned-processes.jsonl'));
      const spawned=ledger.filter(row=>row.event==='spawn');
      assert.ok(spawned.length>0&&spawned.every(row=>ledger.filter(end=>end.event==='close'&&end.pid===row.pid&&end.observedExit).length===1),'Missing or unclosed owned process');
      if(item.sourceTransport==='pi-native-local') {
        assert.equal(item.source.sourceObserverComplete,true,'Missing native observer terminal cannot prove safe cleanup');
        assert.equal(item.source.unmatchedChildren,0,'Unmatched native child descendants remain unknown');
        assert.equal(item.source.complete,true,'Incomplete native source evidence must remain available');
      } else if((item.sourceTransport??'cli')==='sdk') {
        assert.equal(item.source.sourceObserverComplete,true,'Missing passive source terminal cannot prove safe cleanup');
        assert.equal(item.source.unmatchedChildren,0,'Unmatched child descendant transport remains unknown');
        assert.equal(item.source.sdkStarts,item.source.sdkCloses,'Unclosed source SDK operation');
      } else assert.ok(item.source.cliStarts>0,'Missing source lifecycle cannot prove safe cleanup');
      assert.equal(item.source.cliStarts,item.source.cliCloses,'Unclosed source CLI');
    }
    const marker=JSON.parse(await readFile(join(scratch,'owner.json'),'utf8'));assert.deepEqual(marker,{runId:owner.runId,evidence:path});
    await runCommand('/usr/bin/trash',[scratch],{cwd:path,env:process.env,timeoutMs:30000});
    await save(join(path,'cleanup.json'),{status:'trashed',scratch,evidencePreserved:true,runId:owner.runId});
    for(const [name,sha] of Object.entries(inventory.files)) assert.equal(hash(await readFile(join(path,name))),sha);
  }
  console.log(JSON.stringify({status:'preserved',functionalStatus:report.status,evidence:path,files:Object.keys(inventory.files).length,cleanup},null,2));
}
async function main() {
  const args=process.argv.slice(2);if(args.some(arg=>['--help','-h','help'].includes(arg))){console.log(usage);return;}
  const action=args.shift(),options={};while(args.length){const key=args.shift();assert.ok(key?.startsWith('--')&&args.length);options[key.slice(2)]=args.shift();}
  if(action==='evidence'||action==='cleanup')return evidence(options.evidence,action==='cleanup');
  assert.ok(['doctor','selection','run'].includes(action),usage);
  const config=await configAt(options.config);
  if(action==='doctor')console.log(JSON.stringify(await doctor(config),null,2));
  else if(action==='selection')await selection(config,options['evidence-root']);
  else await run(config,options['evidence-root']);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(safeDiagnostic(Buffer.from(error.message)));process.exitCode=1;});

