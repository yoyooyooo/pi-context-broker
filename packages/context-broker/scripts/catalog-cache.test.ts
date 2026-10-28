import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNotionFixture, database } from "../../../scripts/notion-integration-fixture.mjs";

const root = await mkdtemp(join(tmpdir(), "broker-catalog-cache-"));
const fixture = await createNotionFixture(join(root, "fixture"));
const source = { type: "notion", id: "notion", command: fixture.command, database, cacheDir: join(root, "cache") };
const worker = join(root, "worker.ts");
await writeFile(worker, `import { discoverNotionSource, loadNotionSkill } from ${JSON.stringify(resolve(import.meta.dirname, "../src/notion-source.ts"))};
const [source, cwd, options, activate] = JSON.parse(process.argv[2]!);
const records = await discoverNotionSource(source, cwd, options);
console.log(JSON.stringify({ records: activate ? await Promise.all(records.map(record => loadNotionSkill(record, source, cwd))) : records, list: records.list }));\n`);
const discover = (options = {}, selected = source, cwd = root, activate = false) => JSON.parse(execFileSync(process.execPath, [worker, JSON.stringify([selected, cwd, options, activate])], { encoding: "utf8", timeout: 15_000 }));
const calls = async () => (await readFile(fixture.callsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
const lists = async () => (await calls()).filter(row => row.command === "list").length;

await fixture.setScenario("normal", { cacheIdentity: true });
const cold = discover();
const metadata = cold.records[0].metadataIndexPath;
const originalStat = await stat(metadata);
await fixture.setScenario("normal", { cacheIdentity: true, alias: "changed-remotely" });
const beforeWarm = await lists();
const warm = discover();
assert.equal(warm.records[0].selectionToken, "$ui-alpha@notion".slice(1));
assert.equal(warm.records[0].metadataIndexPath, metadata, "Another process reuses the same metadata index");
assert.equal((await stat(metadata)).mtimeMs, originalStat.mtimeMs, "A cache hit does not rewrite metadata files");
assert.equal(await lists(), beforeWarm, "A valid shared catalog does not launch list again");
assert.equal(warm.records[0].body, undefined);

const projectA = join(root, "project-a"), projectB = join(root, "project-b");
await mkdir(projectA); await mkdir(projectB);
const commandAlias = join(root, "source-alias.mjs");
await symlink(fixture.command[1], commandAlias);
const otherHost = { ...source, id: "other-host", namespace: "other", command: [process.execPath, commandAlias, ...fixture.command.slice(2)], requestTimeoutMs: 10_000, activation: { maxAge: "1m" } };
const beforeProjects = await lists();
const projectHit = discover({}, source, projectA);
const hostHit = discover({}, otherHost, projectB);
assert.equal(projectHit.records[0].metadataIndexPath, metadata, "Changing projects reuses the original catalog");
assert.equal(hostHit.records[0].metadataIndexPath, metadata, "Host labels and equivalent command spellings share remote metadata");
assert.equal(hostHit.records[0].selectionToken, "ui-alpha@other", "Presentation uses the current host namespace");
assert.equal(hostHit.list.validatedAt, cold.list.validatedAt, "Another host cannot renew the shared validation time");
assert.equal(await lists(), beforeProjects, "Projects and host configuration do not launch another list");

await fixture.setScenario("normal", { cacheIdentity: true });
const firstLoad = discover({}, source, projectA, true).records[0];
const exportsBefore = (await calls()).filter(row => row.command === "export").length;
const secondLoad = discover({}, otherHost, projectB, true).records[0];
assert.equal(secondLoad.path, firstLoad.path, "Hosts and projects share the same immutable export");
assert.equal(secondLoad.body, await readFile(firstLoad.path, "utf8"));
assert.equal((await calls()).filter(row => row.command === "export").length, exportsBefore, "The second consumer does not export the same snapshot again");
assert.equal(discover({}, { ...source, database: "fixture" }, projectB).records[0].metadataIndexPath, metadata, "A registered alias shares the selected database catalog");

await fixture.setScenario("normal", { cacheIdentity: true, catalogAgeMs: 120_000 });
const aged = discover({ refresh: true });
await fixture.setScenario("normal", { cacheIdentity: true, alias: "after-refresh" });
const beforeStale = await lists();
const stale = discover({ stale: true });
assert.equal(stale.records[0].alias, "ui-alpha");
assert.equal(stale.list.stale, true);
assert.equal(await lists(), beforeStale, "Startup can publish expired metadata before the authoritative refresh");
const longerPolicy = discover({}, { ...otherHost, discovery: { maxAge: "5m" } }, projectB);
assert.equal(longerPolicy.records[0].metadataIndexPath, aged.records[0].metadataIndexPath, "TTL is evaluated on the shared observation");
assert.equal(longerPolicy.list.stale, false, "Another consumer's shorter TTL cannot mark this policy stale");
assert.equal(await lists(), beforeStale);
const refreshed = discover();
assert.equal(refreshed.records[0].alias, "after-refresh");
assert.equal(refreshed.list.stale, false);
const refreshedOther = discover({}, otherHost, projectB);
assert.equal(refreshedOther.records[0].alias, "after-refresh");
assert.equal(refreshedOther.records[0].metadataIndexPath, refreshed.records[0].metadataIndexPath, "Expiry refresh is shared across projects and hosts");
await fixture.setScenario("normal", { cacheIdentity: true, alias: "forced-refresh" });
const forced = discover({ refresh: true }, otherHost, projectB);
assert.equal(discover({}, source, projectA).records[0].metadataIndexPath, forced.records[0].metadataIndexPath, "Explicit refresh replaces the same shared catalog");
assert.equal(discover({}, source, projectA).records[0].alias, "forced-refresh");

await fixture.setScenario("normal", { cacheIdentity: true, account: "another-account", alias: "other-account" });
assert.equal(discover({ stale: true }).records[0].alias, "other-account", "Account changes cannot reuse the previous process catalog");
const beforeNamespace = await lists();
assert.equal(discover({}, { ...source, namespace: "different" }).records[0].selectionToken, "other-account@different");
assert.equal(await lists(), beforeNamespace, "Display namespaces do not partition remote catalogs");
const catalogs = join(root, "cache", "catalogs-v4");
async function selectedReceipts() {
  return Promise.all((await readdir(catalogs)).map(async key => {
    const directory = join(catalogs, key, "published");
    const order = (await readdir(directory)).filter(name => /^[0-9]{20}$/.test(name)).sort().at(-1)!;
    return join(directory, order, "receipt.json");
  }));
}
for (const path of await selectedReceipts()) {
  const legacy = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...legacy, version: 1, result: { ...legacy.result, records: legacy.result.records.map(record => ({ ...record, upstream: { repo: "plugins" } })) } }));
}
await fixture.setScenario("normal", { cacheIdentity: true, account: "another-account", alias: "other-account", upstream: { repo: "pstack" } });
const beforeUpgrade = await lists();
assert.equal(discover({ stale: true }).records[0].upstream.repo, "pstack", "Upgrade must discard old repository labels even when startup permits expired metadata");
assert.equal(await lists(), beforeUpgrade + 1);
for (const path of await selectedReceipts()) await writeFile(path, "invalid-json");
const beforeCorrupt = await lists();
assert.equal(discover().records[0].alias, "other-account");
assert.equal(await lists(), beforeCorrupt + 1, "A corrupt derived receipt rebuilds using the source CLI");

console.log(JSON.stringify({ ok: true, coldProcess: true, warmProcess: true, sameIndex: true, crossProject: true, crossHost: true, commandSpelling: true, sharedExport: true, sharedRefresh: true, ttl: true, expiredStartup: true, refreshedAlias: refreshed.records[0].alias, accountIsolation: true, namespacePresentation: true, corruptIndexRecovery: true, evidence: root }));
