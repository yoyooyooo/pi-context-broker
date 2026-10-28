import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSourceCatalog, loadSourceSkill } from "../src/sources";
import { parseCatalogMember, readDiscoveryCatalog, validateDiscoveryRecords, resolveCatalogReference } from "../src/discovery-records";
import { buildDiscoveryRegistry, buildRawDollarRegistry, buildInjectedPayload, matchDiscoveryRecord, parseInvocations } from "../src/index";
import type { CatalogRemoteReference, ConfigFile } from "../src/types";

const root = await mkdtemp(join(tmpdir(), "broker-remote-catalog-"));
try {
  const log = join(root, "calls.jsonl"), fixture = join(root, "source.mjs"), catalog = join(root, "catalog.json");
  const page = "11111111-1111-4111-8111-111111111111", routerPage = "11111111-1111-4111-8111-111111111112";
  const db = "22222222-2222-4222-8222-222222222222", ds = "33333333-3333-4333-8333-333333333333";
  await writeFile(fixture, `import {appendFile} from 'node:fs/promises';
const [log,mode,...args]=process.argv.slice(2); await appendFile(log,JSON.stringify({mode,args})+'\\n');
const scope='a'.repeat(64), db=${JSON.stringify(db)}, ds=${JSON.stringify(ds)};
const records=[['${page}','skill','Precise','precise'],['${routerPage}','router','Remote Router','remote-router']].map(([page,kind,name,alias])=>({id:'notion_page:'+page,kind,name,alias,description:'registered '+alias,default_context:false,entrypoint:kind==='skill'?'SKILL.md':'ROUTER.md',locator:{type:'notion_page',page_id:page,database_id:db,data_source_id:ds},ref:'skill://'+page+'/'+(kind==='skill'?'SKILL.md':'ROUTER.md')}));
if(mode==='offline'){console.log(JSON.stringify({ok:false,error:{code:'CACHE_MISSING'}}));process.exitCode=1;}
else if(args[0]==='list')console.log(JSON.stringify({ok:true,scope,fetched_at:0,records,count:records.length,databases:[{database_id:db,title:'Fixture',alias:'fixture',data_source_ids:[ds]}],coverage:{method:'explicit_database',exhaustive:true,search_index_limited:false,queried_data_sources:[ds],failed_sources:[]},freshness:{policy:'default',validated_at:new Date(0).toISOString(),age_ms:0,max_age_ms:60000,stale:false}}));
else if(args[0]==='read')console.log(JSON.stringify({ok:true,scope:'b'.repeat(64),record:records[0],snapshot_id:'s_'+'c'.repeat(64),version_id:'v1'}));
else throw Error('Unexpected body/export operation');
`);
  const local = join(root, "local", "SKILL.md");
  await mkdir(join(root, "local"));
  await writeFile(local, "---\nname: local-helper\ndescription: protected local capability\n---\nLOCAL BODY MUST NOT ENTER INDEX\n");
  const source = { type: "notion" as const, id: "machine-source-id", namespace: "production", command: [process.execPath, fixture, log, "online"], cacheDir: join(root, "cache") };
  const secondSource = { ...source, id: "second-id", namespace: "secondary" };
  const config: ConfigFile = { skillRoots: [join(root, "local")], discoveryCatalogs: [catalog], sources: [source, secondSource] };
  const remote: CatalogRemoteReference = { type: "remote", source: { namespace: "production" }, id: "notion_page:" + page, locator: { type: "notion_page", page_id: page, database_id: db, data_source_id: ds }, ref: "skill://" + page + "/SKILL.md" };
  const missing = { ...remote, source: { namespace: "unknown" } };
  await writeFile(catalog, JSON.stringify({ records: [{ kind: "router", name: "mixed", description: "mixed index", members: [{ type: "local", path: local }, remote, missing] }] }));
  const metadata = await discoverSourceCatalog(config, root);
  assert.equal(metadata.failures.length, 0);
  assert.equal(metadata.records.length, 4);
  assert.ok(metadata.records.every(record => record.body === undefined));
  const { records } = await buildDiscoveryRegistry(config, root);
  const mixed = records.find(record => record.name === "mixed")!;
  assert.equal(mixed.members!.length, 3);
  const selected = mixed.members!.find(member => member.type === "remote" && member.source.namespace === "production")!;
  assert.equal(selected.type, "remote");
  assert.equal(selected.path, undefined);
  assert.equal(selected.ref, remote.ref);
  if (selected.type === "remote") assert.equal(selected.sourceId, source.id);
  const unknown = mixed.members!.find(member => member.type === "remote" && member.source.namespace === "unknown")!;
  assert.equal(unknown.type === "remote" && unknown.unavailable?.code, "SOURCE_UNAVAILABLE");
  assert.ok(validateDiscoveryRecords(records).some(error => error.includes("SOURCE_UNAVAILABLE")));
  const payload = String(buildInjectedPayload(mixed, "mixed").content);
  assert.ok(payload.includes('ref="' + remote.ref + '"'));
  assert.ok(payload.includes('unavailable="SOURCE_UNAVAILABLE"'));
  assert.ok(payload.includes("local-helper"));
  assert.ok(!payload.includes("LOCAL BODY"));
  const raw = await buildRawDollarRegistry(config, root);
  assert.equal(raw.records.find(record => record.name === "mixed")!.members!.length, 3);
  assert.equal(matchDiscoveryRecord("precise", records).reason, "ambiguous");
  const exact = String.fromCharCode(0x24) + "precise@production";
  const requests = parseInvocations(exact, [{ id: "dollar-skill", match: [{ regex: [{ pattern: "\\$([^\\s]+)", flags: "gu" }] }] }]);
  assert.equal(requests[0]!.query, "precise@production");
  const decision = matchDiscoveryRecord(requests[0]!.query, records);
  assert.equal(decision.decision, "inject");
  if (decision.decision === "inject") assert.equal(decision.record.ref, remote.ref);
  const preciseRequests = parseInvocations(String.fromCharCode(0x24) + "precise", [{ id: "dollar-skill", match: [{ regex: [{ pattern: "\\$([^\\s]+)", flags: "gu" }] }] }]);
  const preciseDecision = matchDiscoveryRecord(preciseRequests[0]!.query, records.filter(record => record.sourceId !== secondSource.id));
  assert.equal(preciseDecision.decision, "inject");
  if (preciseDecision.decision === "inject") assert.equal(preciseDecision.record.ref, remote.ref, "Actual precise invocation retains the registered exact entry ref");
  const context = { sources: config.sources, records: metadata.records, failures: metadata.failures };
  const pinned = { ...remote, ref: remote.ref + "?snapshot=s_" + "c".repeat(64) };
  assert.equal(resolveCatalogReference(pinned, context, "skill").sourceId, source.id);
  assert.throws(() => parseCatalogMember({ ...remote, scope: "a".repeat(64) }), /Unknown catalog member field/);
  assert.throws(() => parseCatalogMember({ ...remote, path: "/fake/cache/SKILL.md" }), /Unknown catalog member field/);
  assert.throws(() => parseCatalogMember({ ...remote, ref: "skill://" + routerPage + "/SKILL.md" }), /ref\/identity mismatch/);
  assert.throws(() => parseCatalogMember({ path: local }), /type must be/);
  assert.throws(() => resolveCatalogReference({ ...remote, locator: { ...remote.locator, database_id: ds } }, context, "skill"), { code: "SOURCE_IDENTITY_MISMATCH" });
  const duplicates = { ...context, sources: [source, { ...secondSource, namespace: "production" }] };
  assert.throws(() => resolveCatalogReference(remote, duplicates, "skill"), error => Boolean(error && typeof error === "object" && "code" in error && error.code === "CATALOG_MEMBER_AMBIGUOUS" && "candidates" in error && Array.isArray(error.candidates) && error.candidates.length === 2));
  const secondRecord = metadata.records.find(record => record.sourceId === secondSource.id && record.id === remote.id)!;
  assert.equal(resolveCatalogReference(remote, { ...duplicates, records: metadata.records.map(record => record === secondRecord ? { ...record, locator: { ...remote.locator, database_id: ds } } : record) }, "skill").sourceId, source.id, "Full locator resolves sources sharing a namespace");
  assert.throws(() => resolveCatalogReference(remote, { ...context, records: metadata.records.map(record => ({ ...record, sourceScope: "invalid" })) }, "skill"), { code: "SOURCE_IDENTITY_MISMATCH" });
  const unknownId = "11111111-1111-4111-8111-111111111199";
  const unknownRecord = { ...remote, id: "notion_page:" + unknownId, locator: { ...remote.locator, page_id: unknownId }, ref: "skill://" + unknownId + "/SKILL.md" };
  assert.throws(() => resolveCatalogReference(unknownRecord, context, "skill"), { code: "CATALOG_MEMBER_UNAVAILABLE" });
  await assert.rejects(loadSourceSkill(metadata.records.find(record => record.id === remote.id)!, config, root), { code: "SOURCE_IDENTITY_MISMATCH" });
  const offline = { ...source, command: [process.execPath, fixture, log, "offline"], discovery: { offline: true } };
  const unavailable = await discoverSourceCatalog({ sources: [offline] }, root);
  const offlineRouter = readDiscoveryCatalog(catalog, [], {}, { sources: [offline], records: unavailable.records, failures: unavailable.failures })[0]!;
  assert.equal(offlineRouter.members!.length, 3);
  assert.ok(validateDiscoveryRecords([offlineRouter]).some(error => error.includes("CACHE_MISSING")));
  const remoteRouter = { ...remote, id: "notion_page:" + routerPage, locator: { type: "notion_page", page_id: routerPage, database_id: db, data_source_id: ds }, ref: "skill://" + routerPage + "/ROUTER.md" };
  await writeFile(catalog, JSON.stringify({ records: [{ kind: "router", ...remoteRouter }] }));
  const direct = readDiscoveryCatalog(catalog, [], {}, context)[0]!;
  assert.equal(direct.sourceId, source.id);
  assert.equal(direct.ref, remoteRouter.ref);
  assert.equal(direct.body, undefined);
  assert.equal(direct.members, undefined);
  assert.equal((await buildRawDollarRegistry(config, root)).records.filter(record => record.id === remoteRouter.id && record.sourceId === source.id).length, 1, "Direct remote Router reference preserves one raw registry record");
  await writeFile(catalog, JSON.stringify({ records: [{ kind: "router", name: "local-only", members: [{ type: "local", path: local }] }] }));
  assert.equal(readDiscoveryCatalog(catalog)[0]!.members![0]!.name, "local-helper", "Local catalog remains independent of source discovery");
  const vanished = join(root, "vanished", "SKILL.md");
  const notDirectory = join(local, "SKILL.md");
  const missingDeclarations = [
    { type: "local", path: vanished, name: "declared-missing", description: "Declared missing capability", aliases: ["missing-alias"] },
    { type: "local", path: notDirectory },
  ];
  await writeFile(catalog, JSON.stringify({ records: [{ kind: "router", name: "missing-local", members: [{ type: "local", path: local }, ...missingDeclarations] }] }));
  const missingLocal = readDiscoveryCatalog(catalog)[0]!;
  assert.equal(missingLocal.members!.length, 3, "Missing local entries preserve declared membership count");
  const vanishedMember = missingLocal.members!.find(member => member.ref === vanished)!;
  assert.equal(vanishedMember.name, "declared-missing");
  assert.equal(vanishedMember.description, "Declared missing capability");
  assert.deepEqual(vanishedMember.aliases, ["missing-alias"]);
  assert.equal(vanishedMember.id, "local:" + vanished);
  assert.equal(vanishedMember.path, vanished);
  assert.equal(vanishedMember.unavailable?.code, "ENOENT");
  assert.equal(missingLocal.members!.find(member => member.ref === notDirectory)!.unavailable?.code, "ENOTDIR");
  assert.ok(missingLocal.members!.every(member => !("body" in member)), "Member indexes never contain bodies");
  await writeFile(catalog, JSON.stringify({ records: [{ kind: "router", name: "bad-entry", members: [{ type: "local", path: join(root, "vanished", "README.md") }] }] }));
  assert.throws(() => readDiscoveryCatalog(catalog), /exact Skill entry path/);
  await writeFile(catalog, JSON.stringify({ records: [{ kind: "router", name: "bad-schema", members: [{ ...missingDeclarations[0], unexpected: true }] }] }));
  assert.throws(() => readDiscoveryCatalog(catalog), /Unknown catalog member field/);
  const limited = join(root, "limited", "SKILL.md");
  await mkdir(join(root, "limited"));
  await writeFile(limited, "---\nname: limited\ndescription: policy limited capability\n---\nBODY\n");
  await writeFile(catalog, JSON.stringify({ records: [{ kind: "router", name: "limited", members: [{ type: "local", path: limited }] }] }));
  const limitedMember = readDiscoveryCatalog(catalog, [], { maxSkillBytes: 1 })[0]!.members![0]!;
  assert.equal(limitedMember.unavailable?.code, "LOCAL_ENTRY_TOO_LARGE");
  assert.match(limitedMember.unavailable!.message, /bytes; maxSkillBytes=1/);
  assert.equal(limitedMember.ref, limited);
  assert.ok(!("body" in limitedMember));
  assert.equal(readDiscoveryCatalog(catalog, [], { maxSkillBytes: 0 })[0]!.members![0]!.name, "limited");
  assert.ok(validateDiscoveryRecords(readDiscoveryCatalog(catalog, [], { maxSkillBytes: 1 })).some(error => error.includes("LOCAL_ENTRY_TOO_LARGE") && error.includes("scan_size_limit")));
  await writeFile(catalog, JSON.stringify({ records: [{ kind: "router", ...remoteRouter, ref: remoteRouter.ref + "?snapshot=s_" + "c".repeat(64) }] }));
  assert.throws(() => readDiscoveryCatalog(catalog, [], {}, context), /canonical unpinned/);
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.filter(call => call.args[0] === "read").length, 1, "Only explicit scope mismatch activation reads a body");
  // Frozen real metadata/body; only producer role/coverage is projected below.
  const captured = JSON.parse(await readFile(new URL("./fixtures/upstream-catalog.json", import.meta.url), "utf8"));
  const routerRead = captured.routerRead;
  const upstream = routerRead.record;
  const upstreamDatabase = { database_id: upstream.locator.database_id, title: "Upstream", alias: "upstream", role: "upstream", data_source_ids: [upstream.locator.data_source_id] };
  const corrected = { ...captured.catalog, records: [upstream], count: 1, databases: [...captured.catalog.databases, upstreamDatabase], coverage: { ...captured.catalog.coverage, queried_data_sources: [...captured.catalog.coverage.queried_data_sources, upstream.locator.data_source_id] } };
  const responsePath = join(root, "upstream-response.json"), upstreamAdapter = join(root, "upstream-source.mjs");
  await writeFile(responsePath, JSON.stringify(corrected));
  await writeFile(upstreamAdapter, `import {appendFile,readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto'; import {join} from 'node:path';
const [log,response,...args]=process.argv.slice(2); await appendFile(log,JSON.stringify({mode:'upstream',args})+'\\n');
const read=${JSON.stringify(routerRead)};
if(args[0]==='list') console.log(await readFile(response,'utf8'));
else if(args[0]==='read') console.log(JSON.stringify(read));
else if(args[0]==='export') {
 const output=args[args.indexOf('--output')+1]; await mkdir(output,{recursive:true});
 const manifest=JSON.stringify({format:'ntn-skills',version:2,kind:read.record.kind,main:read.entrypoint,name:read.record.name,description:read.record.description});
 const files=[]; for(const [path,content,role] of [[read.entrypoint,read.content,'entrypoint'],['.ntn-skills.json',manifest,'manifest']]) { await writeFile(join(output,path),content); files.push({path,bytes:Buffer.byteLength(content),hash:createHash('sha256').update(content).digest('hex'),role}); }
 console.log(JSON.stringify({ok:true,operation:'export',format:'directory',projection:'snapshot',output,reused:false,record:read.record,scope:read.scope,snapshot_id:read.snapshot_id,version_id:read.version_id,entrypoint:read.entrypoint,main_path:read.entrypoint,ref:read.ref,content_id:'d'.repeat(64),freshness:{policy:'pinned'},files}));
} else throw Error('Unexpected command');
`);
  const upstreamSource = { ...source, id: "runner-source", namespace: "runner", command: [process.execPath, upstreamAdapter, log, responsePath], cacheDir: join(root, "runner-cache") };
  const upstreamConfig = { sources: [upstreamSource] };
  const upstreamMetadata = await discoverSourceCatalog(upstreamConfig, root);
  assert.deepEqual(upstreamMetadata.failures, []);
  assert.equal(upstreamMetadata.records.length, 1);
  const upstreamRecord = upstreamMetadata.records[0]!;
  assert.equal(upstreamRecord.body, undefined);
  assert.equal(upstreamRecord.sourceId, upstreamSource.id);
  assert.equal(upstreamRecord.sourceScope, routerRead.scope);
  const upstreamIdentity = upstream.locator.type === "notion_subscription" ? upstream.locator.subscription_id : upstream.locator.page_id;
  assert.equal(upstreamRecord.selectionToken, upstream.alias + "@" + upstreamIdentity.replaceAll("-", "") + "@runner", "The captured search-limited catalog exposes an exact returned identity");
  const upstreamReference: CatalogRemoteReference = { type: "remote", source: { namespace: "runner" }, id: upstream.id, locator: upstream.locator, ref: upstream.ref };
  const candidate = resolveCatalogReference(upstreamReference, { sources: upstreamConfig.sources, ...upstreamMetadata }, "router");
  assert.equal(candidate.sourceId, upstreamSource.id);
  assert.equal(candidate.ref, upstream.ref);
  assert.equal(candidate.sourceScope, routerRead.scope);
  const exactUpstream = matchDiscoveryRecord(upstreamRecord.selectionToken!, upstreamMetadata.records);
  assert.throws(() => matchDiscoveryRecord(upstream.alias + "@runner", upstreamMetadata.records), { code: "CATALOG_INCOMPLETE" }, "Search-limited discovery cannot establish short-alias uniqueness");
  assert.equal(exactUpstream.decision, "inject");
  if (exactUpstream.decision === "inject") assert.equal(exactUpstream.record.ref, upstream.ref);
  const beforeActivation = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(call => call.mode === "upstream");
  assert.equal(beforeActivation.some(call => ["read", "export"].includes(call.args[0])), false, "Discovery and registration never read a body");
  const activated = await loadSourceSkill(candidate, upstreamConfig, root);
  assert.equal(activated.body, routerRead.content);
  assert.equal(activated.snapshotId, routerRead.snapshot_id);
  assert.equal(activated.sourceId, upstreamSource.id);
  assert.equal(activated.sourceScope, routerRead.scope);
  const activationCalls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(call => call.mode === "upstream" && ["read", "export"].includes(call.args[0]));
  assert.equal(activationCalls[0].args[1], upstream.ref, "Activation uses the exact registered upstream ref");
  assert.equal(activationCalls[1].args[1], routerRead.snapshot_id);
  await assert.rejects(loadSourceSkill({ ...candidate, sourceScope: "b".repeat(64) }, upstreamConfig, root), { code: "SOURCE_IDENTITY_MISMATCH" });
  await assert.rejects(loadSourceSkill({ ...candidate, sourceId: "unknown-source" }, upstreamConfig, root), { code: "SOURCE_UNAVAILABLE" });
  assert.throws(() => resolveCatalogReference({ ...upstreamReference, source: { namespace: "unknown" } }, { sources: upstreamConfig.sources, ...upstreamMetadata }, "router"), { code: "SOURCE_UNAVAILABLE" });
  for (const database of [upstream.locator.target_database_id, upstream.locator.target_database_id.replaceAll("-", "").toUpperCase(), "content-d9091165"]) {
    const selected = await discoverSourceCatalog({ sources: [{ ...upstreamSource, database }] }, root);
    assert.deepEqual(selected.failures, [], "Explicit content selection accepts subscription target " + database);
    assert.equal(selected.records.length, 1);
  }
  const absentTarget = structuredClone(corrected);
  absentTarget.databases = [upstreamDatabase];
  await writeFile(responsePath, JSON.stringify(absentTarget));
  assert.equal((await discoverSourceCatalog(upstreamConfig, root)).records.length, 1, "Unscoped search-limited catalog need not discover the target content DB");
  await writeFile(responsePath, JSON.stringify(corrected));
  for (const database of [upstream.locator.database_id, "upstream", db]) {
    const rejected = await discoverSourceCatalog({ sources: [{ ...upstreamSource, database }] }, root);
    assert.equal(rejected.records.length, 0);
    assert.equal(rejected.failures[0]!.code, "SOURCE_RESPONSE_INVALID");
  }
  const invalidCatalogs = [
    { ...corrected, databases: captured.catalog.databases },
    { ...corrected, databases: [...captured.catalog.databases, { ...upstreamDatabase, role: "content" }] },
    { ...corrected, databases: [...captured.catalog.databases, { ...upstreamDatabase, role: "unknown" }] },
    { ...corrected, databases: [...captured.catalog.databases, { ...upstreamDatabase, role: undefined }] },
    { ...corrected, databases: [...captured.catalog.databases, { ...upstreamDatabase, data_source_ids: [ds] }] },
    { ...corrected, coverage: captured.catalog.coverage },
    { ...corrected, records: [{ ...upstream, locator: { ...upstream.locator, database_id: db } }] },
    { ...corrected, records: [{ id: "notion_page:" + page, kind: "skill", locator: { type: "notion_page", page_id: page, database_id: upstreamDatabase.database_id, data_source_id: upstream.locator.data_source_id }, name: "Precise", alias: "precise", description: "wrong role", default_context: false, entrypoint: "SKILL.md", ref: "skill://" + page + "/SKILL.md" }] },
  ];
  for (const invalidCatalog of invalidCatalogs) {
    await writeFile(responsePath, JSON.stringify(invalidCatalog));
    const rejected = await discoverSourceCatalog(upstreamConfig, root);
    assert.equal(rejected.records.length, 0);
    assert.deepEqual(rejected.failures.map(failure => [failure.sourceId, failure.namespace, failure.code]), [[upstreamSource.id, "runner", "SOURCE_RESPONSE_INVALID"]]);
  }
  // Exact control/fixes/content-directory/current-list.json receipt, SHA-256
  // 2c1924999510cc3709add9fab03abf6babb7396ceb494b00caf998c142caa2a2.
  // Preserve both real remote failures; healthy activation above is controlled.
  const currentListBytes = await readFile(new URL("./fixtures/upstream-current-list.json", import.meta.url), "utf8");
  const currentList = JSON.parse(currentListBytes);
  assert.equal(currentList.coverage.failed_sources.length, 2);
  assert.ok(currentList.databases.some((database: { role: string }) => database.role === "upstream"));
  assert.ok(currentList.coverage.queried_data_sources.includes(upstream.locator.data_source_id));
  await writeFile(responsePath, currentListBytes);
  const incomplete = await discoverSourceCatalog(upstreamConfig, root);
  assert.equal(incomplete.records.length, currentList.records.length, "A partial source preserves exact valid records");
  assert.equal(incomplete.failures[0]!.blocking, false);
  const retained = incomplete.records.find(record => record.sourceId === upstreamSource.id && record.id === currentList.records[0].id)!;
  assert.ok(retained, "The retained record belongs to the selected incomplete source");
  assert.equal(matchDiscoveryRecord(retained.selectionToken!, incomplete.records).decision, "inject", "An accepted exact page-qualified token remains usable");
  assert.throws(() => matchDiscoveryRecord(`${retained.alias}@${upstreamSource.namespace}`, incomplete.records), { code: "CATALOG_INCOMPLETE" }, "Partial discovery must not prove a short alias unique");
  assert.equal(matchDiscoveryRecord(`${retained.alias}@${source.namespace}`, incomplete.records).reason, "not-found", "An unrelated unknown namespace remains ordinary text");
  assert.deepEqual(incomplete.failures.map(failure => [failure.sourceId, failure.namespace, failure.code]), [[upstreamSource.id, "runner", "CATALOG_INCOMPLETE"]]);
  assert.throws(() => resolveCatalogReference(upstreamReference, { sources: upstreamConfig.sources, ...incomplete }, "router"), { code: "CATALOG_INCOMPLETE" });
  // Search coverage can be incomplete without a failed request. Display tokens
  // must still carry identity, so a typed short alias cannot establish uniqueness.
  await writeFile(responsePath, JSON.stringify({ ...currentList, coverage: { ...currentList.coverage, method: "search_and_registered", exhaustive: false, failed_sources: [], search_index_limited: true } }));
  const searchLimited = await discoverSourceCatalog(upstreamConfig, root);
  assert.deepEqual(searchLimited.failures, []);
  const limitedRecord = searchLimited.records.find(record => record.sourceId === upstreamSource.id && record.id === retained.id)!;
  assert.ok(limitedRecord);
  assert.notEqual(limitedRecord.selectionToken, `${limitedRecord.alias}@${upstreamSource.namespace}`, "Incomplete coverage never emits a short selector as an exact identity");
  assert.equal(matchDiscoveryRecord(limitedRecord.selectionToken!, searchLimited.records).decision, "inject", "A returned exact identity remains usable with search-limited coverage");
  assert.throws(() => matchDiscoveryRecord(`${limitedRecord.alias}@${upstreamSource.namespace}`, searchLimited.records), { code: "CATALOG_INCOMPLETE" });
  await writeFile(responsePath, JSON.stringify({ ...corrected, scope: "invalid-scope" }));
  const invalidScope = await discoverSourceCatalog(upstreamConfig, root);
  assert.equal(invalidScope.records.length, 0);
  assert.equal(invalidScope.failures[0]!.code, "SOURCE_RESPONSE_INVALID");
  const contentDatabase = captured.catalog.databases[0];
  const pageRecord = { id: "notion_page:" + page, kind: "skill", locator: { type: "notion_page", page_id: page, database_id: contentDatabase.database_id, data_source_id: contentDatabase.data_source_ids[0] }, name: "Precise", alias: "precise", description: "content page", default_context: false, entrypoint: "SKILL.md", ref: "skill://" + page + "/SKILL.md" };
  await writeFile(responsePath, JSON.stringify({ ...corrected, records: [pageRecord] }));
  assert.equal((await discoverSourceCatalog({ sources: [{ ...upstreamSource, database: contentDatabase.alias }] }, root)).records.length, 1);
  assert.equal((await discoverSourceCatalog({ sources: [{ ...upstreamSource, database: upstreamDatabase.database_id }] }, root)).failures[0]!.code, "SOURCE_RESPONSE_INVALID");
  console.log("remote catalog consumer checks passed: scoped source metadata/localFS/mixed unavailable/ambiguity/ref scope/no body/precise invocation");
} finally {
  console.log(`Remote catalog evidence retained: ${root}`);
}
