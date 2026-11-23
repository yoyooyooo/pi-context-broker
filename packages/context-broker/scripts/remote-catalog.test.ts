import { nativeFileRef, nativeSkillId, withNativeSnapshot } from "../src/native-reference";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { currentNotionFixture } from "./fixtures/current-notion-source";
import { pathToFileURL } from "node:url";
import { parseCatalogMember, readDiscoveryCatalog, validateDiscoveryRecords, resolveCatalogReference } from "../src/discovery-records";

import type { CatalogRemoteReference, ConfigFile, ContentKind } from "../src/types";

const runtime = await currentNotionFixture(), root = runtime.root;
const { discoverSourceCatalog, loadSourceSkill } = runtime.sources;
const { buildDiscoveryRegistry, buildRawDollarRegistry, buildInjectedPayload, matchDiscoveryRecord, parseInvocations } =
  await import(pathToFileURL(join(root, "src/index.ts")).href);
try {
  const catalog = join(root, "catalog.json");
  const page = "11111111-1111-4111-8111-111111111111", routerPage = "11111111-1111-4111-8111-111111111112";
  const db = "22222222-2222-4222-8222-222222222222", ds = "33333333-3333-4333-8333-333333333333";
  const identity = (owner: string) => nativeSkillId("catalog", String(owner));
  const current = (owner: string, kind: ContentKind, name: string, alias: string) => ({
    id: identity(owner), kind, name, alias, description: "registered " + alias, default_context: false, enabled: true,
    entrypoint: kind === "skill" ? "SKILL.md" : "ROUTER.md",
    locator: { type: "shared_skill" as const, library_id: "catalog", skill_id: owner, page_id: owner, database_id: db, data_source_id: ds },
    ref: nativeFileRef(identity(owner), String((kind === "skill" ? "SKILL.md" : "ROUTER.md"))) });
  const initialRecords = [current(page, "skill", "Precise", "precise"), current(routerPage, "router", "Remote Router", "remote-router")];
  runtime.state.catalog = { ...runtime.state.catalog, scope: "a".repeat(64), records: initialRecords, count: 2,
    databases: [{ database_id: db, title: "Fixture", alias: "fixture", role: "content", data_source_ids: [ds] }],
    coverage: { method: "explicit_database", exhaustive: true, search_index_limited: false, queried_data_sources: [ds], failed_sources: [] } };
  const list = runtime.state.list;
  runtime.state.list = options => { if (options.offline) throw Object.assign(Error("offline fixture"), { code: "CACHE_MISSING" }); return list(options); };
  const local = join(root, "local", "SKILL.md");
  await mkdir(join(root, "local"));
  await writeFile(local, "---\nname: local-helper\ndescription: protected local capability\n---\nLOCAL BODY MUST NOT ENTER INDEX\n");
  const source = { type: "notion" as const, id: "machine-source-id", namespace: "production", cacheDir: join(root, "cache") };
  const secondSource = { ...source, id: "second-id", namespace: "secondary" };
  const config: ConfigFile = { skillRoots: [join(root, "local")], discoveryCatalogs: [catalog], sources: [source, secondSource] };
  const remote: CatalogRemoteReference = { type: "remote", source: { namespace: "production" }, id: initialRecords[0]!.id, locator: initialRecords[0]!.locator, ref: initialRecords[0]!.ref };
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
  const pinned = { ...remote, ref: withNativeSnapshot(remote.ref, "s_" + "c".repeat(64)) };
  assert.equal(resolveCatalogReference(pinned, context, "skill").sourceId, source.id);
  const selectedRecord = metadata.records.find(record => record.sourceId === source.id && record.id === remote.id)!;
  const selectedContext = { ...context, records: [selectedRecord] };
  assert.equal(resolveCatalogReference(remote, selectedContext, "skill"), selectedRecord);
  const retired = [
    { ...remote, id: "notion_page:" + page, locator: { type: "notion_page", page_id: page, database_id: db, data_source_id: ds }, ref: "skill://" + page + "/SKILL.md" },
    { ...remote, id: "notion_subscription:" + page, locator: { type: "notion_subscription", subscription_id: page, database_id: db, data_source_id: ds, target_database_id: db }, ref: "skill://upstream:" + page + "/ROUTER.md" },
  ];
  for (const declaration of retired) {
    assert.throws(() => parseCatalogMember(declaration), /locator/, "Retired locators cannot be normalized through a matching current page");
    await writeFile(catalog, JSON.stringify({ records: [{ kind: "router", name: "retired", members: [declaration] }] }));
    assert.throws(() => readDiscoveryCatalog(catalog, [], {}, selectedContext), /locator/);
  }
  await writeFile(catalog, JSON.stringify({ records: [{ kind: "router", name: "mixed", description: "mixed index", members: [{ type: "local", path: local }, remote, missing] }] }));
  assert.throws(() => resolveCatalogReference(remote, { ...selectedContext, records: [{ ...selectedRecord, enabled: false }] }, "skill"), { code: "CATALOG_MEMBER_UNAVAILABLE" });
  assert.throws(() => resolveCatalogReference(remote, { ...selectedContext, failures: [{ sourceId: source.id, code: "NOTION_UNAUTHORIZED", message: "denied" }] }, "skill"), { code: "NOTION_UNAUTHORIZED" });
  assert.throws(() => resolveCatalogReference(remote, { ...selectedContext, records: [selectedRecord, { ...selectedRecord }] }, "skill"), { code: "CATALOG_MEMBER_AMBIGUOUS" });
  assert.throws(() => resolveCatalogReference(remote, { ...selectedContext, records: [{ ...selectedRecord, id: selectedRecord.id + "-other" }] }, "skill"), { code: "CATALOG_MEMBER_UNAVAILABLE" });
  for (const broken of [
    { ...selectedRecord, ref: "skill://" + page + "/SKILL.md" },
    { ...selectedRecord, sourceScope: "invalid" },
    { ...selectedRecord, kind: "router" as const },
    { ...selectedRecord, locator: { ...remote.locator, page_id: routerPage } },
  ]) assert.throws(() => resolveCatalogReference(remote, { ...selectedContext, records: [broken] }, "skill"), { code: "SOURCE_IDENTITY_MISMATCH" });
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
  const unknownRecord = { ...remote, id: identity(unknownId), locator: { ...remote.locator, page_id: unknownId, skill_id: unknownId }, ref: nativeFileRef(identity(unknownId), "SKILL.md") };
  assert.throws(() => resolveCatalogReference(unknownRecord, context, "skill"), { code: "CATALOG_MEMBER_UNAVAILABLE" });
  // The real SDK decoder rejects the foreign request before Broker's graph guard.
  await assert.rejects(loadSourceSkill(metadata.records.find(record => record.id === remote.id)!, config, root), {
    code: process.env.CONTEXT_BROKER_GRAPH_CORE ? "CONSUME_INVALID_PROOF" : "SOURCE_PREPARATION_INVALID",
  });
  const offline = { ...source, discovery: { offline: true } };
  const unavailable = await discoverSourceCatalog({ sources: [offline] }, root);
  const offlineRouter = readDiscoveryCatalog(catalog, [], {}, { sources: [offline], records: unavailable.records, failures: unavailable.failures })[0]!;
  assert.equal(offlineRouter.members!.length, 3);
  assert.ok(validateDiscoveryRecords([offlineRouter]).some(error => error.includes("CACHE_MISSING")));
  const remoteRouter = { ...remote, id: initialRecords[1]!.id, locator: initialRecords[1]!.locator, ref: initialRecords[1]!.ref };
  await writeFile(catalog, JSON.stringify({ records: [{ kind: "router", ...remoteRouter }] }));
  const direct = readDiscoveryCatalog(catalog, [], {}, context)[0]!;
  assert.equal(direct.sourceId, source.id);
  assert.equal(direct.ref, remoteRouter.ref);
  assert.equal(direct.body, undefined);
  assert.equal(direct.members, undefined);
  assert.equal((await buildRawDollarRegistry(config, root)).records.filter(record => record.id === remoteRouter.id && record.sourceId === source.id).length, 1, "Direct remote Router reference preserves one raw registry record");
  await writeFile(catalog, JSON.stringify({ records: [{ kind: "router", ...remoteRouter, ref: withNativeSnapshot(remoteRouter.ref, "s_" + "c".repeat(64)) }] }));
  assert.throws(() => readDiscoveryCatalog(catalog, [], {}, context), { code: "SOURCE_IDENTITY_MISMATCH" }, "A Library query is current; a snapshot selector still cannot become a direct Router catalog entry");
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
  await writeFile(catalog, JSON.stringify({ records: [{ kind: "router", ...remoteRouter, ref: withNativeSnapshot(remoteRouter.ref, "s_" + "c".repeat(64)) }] }));
  assert.throws(() => readDiscoveryCatalog(catalog, [], {}, context), /canonical unpinned/);
  assert.ok(runtime.calls.every(call => call.operation === "list" || call.operation === "consume"));
  const currentCatalog = structuredClone(runtime.state.catalog);
  const selectedSource = { ...source, id: "runner-source", namespace: "runner", cacheDir: join(root, "runner-cache") };
  const selectedConfig = { sources: [selectedSource] };
  for (const database of [db, db.replaceAll("-", "").toUpperCase(), "fixture"]) {
    runtime.state.catalog = currentCatalog;
    const observed = await discoverSourceCatalog({ sources: [{ ...selectedSource, database }] }, root);
    assert.deepEqual(observed.failures, []);
    assert.equal(observed.records.length, initialRecords.length, "Current physical and configured alias selectors retain the complete directory");
  }
  const retiredPage = { ...initialRecords[0], id: retired[0]!.id, locator: retired[0]!.locator, ref: retired[0]!.ref };
  const retiredSubscription = { ...initialRecords[1], id: retired[1]!.id, locator: retired[1]!.locator, ref: retired[1]!.ref };
  for (const invalidCatalog of [
    { ...currentCatalog, databases: [] },
    { ...currentCatalog, databases: [{ ...currentCatalog.databases[0], role: "upstream" }] },
    { ...currentCatalog, databases: [{ ...currentCatalog.databases[0], role: "unknown" }] },
    { ...currentCatalog, databases: [{ ...currentCatalog.databases[0], data_source_ids: [db] }] },
    { ...currentCatalog, coverage: { ...currentCatalog.coverage, queried_data_sources: [] } },
    { ...currentCatalog, records: [{ ...initialRecords[0], locator: { ...remote.locator, database_id: ds } }], count: 1 },
    { ...currentCatalog, records: [retiredPage], count: 1 },
    { ...currentCatalog, records: [retiredSubscription], count: 1 },
    { ...currentCatalog, records: [{ ...initialRecords[0], upstream: { repo: "retired-repo" } }], count: 1 },
  ]) {
    runtime.state.catalog = invalidCatalog;
    const rejected = await discoverSourceCatalog(selectedConfig, root);
    assert.equal(rejected.records.length, 0);
    assert.deepEqual(rejected.failures.map(failure => [failure.sourceId, failure.namespace, failure.code]), [[selectedSource.id, "runner", "SOURCE_RESPONSE_INVALID"]]);
  }
  runtime.state.catalog = { ...currentCatalog, coverage: { ...currentCatalog.coverage, exhaustive: false, failed_sources: [
    { id: "unavailable-one", code: "ACCESS_DENIED" }, { id: "unavailable-two", code: "NOTION_REQUEST_FAILED" },
  ] } };
  const incomplete = await discoverSourceCatalog(selectedConfig, root);
  assert.equal(incomplete.records.length, initialRecords.length, "A partial source preserves exact valid current records");
  assert.equal(incomplete.failures[0]!.blocking, false);
  const retained = incomplete.records.find(record => record.id === remote.id)!;
  assert.ok(retained);
  assert.equal(matchDiscoveryRecord(retained.selectionToken!, incomplete.records).decision, "inject", "An accepted exact page-qualified token remains usable");
  assert.throws(() => matchDiscoveryRecord(`${retained.alias}@runner`, incomplete.records), { code: "CATALOG_INCOMPLETE" });
  assert.equal(matchDiscoveryRecord(`${retained.alias}@production`, incomplete.records).reason, "not-found");
  assert.deepEqual(incomplete.failures.map(failure => [failure.sourceId, failure.namespace, failure.code]), [[selectedSource.id, "runner", "CATALOG_INCOMPLETE"]]);
  assert.throws(() => resolveCatalogReference({ ...remote, source: { namespace: "runner" } }, { sources: selectedConfig.sources, ...incomplete }, "skill"), { code: "CATALOG_INCOMPLETE" });
  runtime.state.catalog = { ...currentCatalog, coverage: { ...currentCatalog.coverage, method: "search_and_registered", exhaustive: false, failed_sources: [], search_index_limited: true } };
  const searchLimited = await discoverSourceCatalog(selectedConfig, root);
  assert.deepEqual(searchLimited.failures, []);
  const limitedRecord = searchLimited.records.find(record => record.id === retained.id)!;
  assert.notEqual(limitedRecord.selectionToken, `${limitedRecord.alias}@runner`);
  assert.equal(matchDiscoveryRecord(limitedRecord.selectionToken!, searchLimited.records).decision, "inject");
  assert.throws(() => matchDiscoveryRecord(`${limitedRecord.alias}@runner`, searchLimited.records), { code: "CATALOG_INCOMPLETE" });
  runtime.state.catalog = { ...currentCatalog, scope: "invalid-scope" };
  assert.equal((await discoverSourceCatalog(selectedConfig, root)).failures[0]!.code, "SOURCE_RESPONSE_INVALID");
  runtime.state.catalog = currentCatalog;
  assert.equal((await discoverSourceCatalog({ sources: [{ ...selectedSource, database: ds }] }, root)).failures[0]!.code, "SOURCE_RESPONSE_INVALID");
  console.log("remote catalog consumer checks passed: scoped source metadata/localFS/mixed unavailable/ambiguity/ref scope/no body/precise invocation");
} finally {
  console.log(`Remote catalog evidence retained: ${root}`);
}
