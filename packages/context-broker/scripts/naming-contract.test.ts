import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { discoverNotionSource } from "../src/notion-source";
import { configuredRules, matchDiscoveryRecord, parseInvocations } from "../src/index";
import { dedupeDiscoveryRecords, recordIdentity } from "../src/discovery-records";
import { dollarAutocompleteItems } from "../src/dollar";
import { normalizeKey, skillRecordFromFile } from "../src/skill-records";
import type { ContentRecord, SourceConfig } from "../src/types";

const cli = resolve(process.env.NAMING_CLI_ROOT ?? join(import.meta.dirname, "../../../../notion-skills-cli"));
const evidence = process.env.NAMING_EVIDENCE ?? await mkdtemp(join(tmpdir(), "broker-naming-contract-"));
await mkdir(evidence, { recursive: true });
const compiled = join(evidence, "official-list.mjs");
const modules: Record<string, string> = {
  "naming-cli-content": "packages/cli/src/commands-content.ts",
  "naming-cli-notion": "packages/core/src/notion.ts",
  "naming-cli-store": "packages/core/src/store.ts",
  "naming-cli-fixtures": "packages/core/test/fixtures.ts",
};
const result = await Bun.build({
  entrypoints: [join(import.meta.dirname, "fixtures/naming-cli-producer.ts")], target: "node", format: "esm",
  external: ["effect", "effect/*", "@effect/*"],
  plugins: [{ name: "official-cli-source", setup(build) {
    build.onResolve({ filter: /^naming-cli-/ }, ({ path }) => ({ path: join(cli, modules[path]!) }));
  } }],
});
assert.equal(result.success, true, result.logs.map(String).join("\n"));
await writeFile(compiled, await result.outputs[0]!.text());
await symlink(join(cli, "packages/cli/node_modules"), join(evidence, "node_modules"));
const producer = Bun.spawn(["node", compiled, "list"], { stdout: "pipe", stderr: "pipe" });
const stdout = await new Response(producer.stdout).text();
const stderr = await new Response(producer.stderr).text();
assert.equal(await producer.exited, 0, stderr);
const catalog = JSON.parse(stdout) as { records: ContentRecord[] };
assert.equal(catalog.records.length, 14);
await writeFile(join(evidence, "official-list.stdout.json"), stdout);
const source: Extract<SourceConfig, { type: "notion" }> = { type: "notion", id: "official", namespace: "naming.prod", command: ["node", compiled], cacheDir: join(evidence, "cache") };
const remote = await discoverNotionSource(source, evidence);
const second = await discoverNotionSource({ ...source, id: "official-second", namespace: "naming.second" }, evidence);
// The CLI checkout is runtime-selected by NAMING_CLI_ROOT for this source integration test.
const registry = dedupeDiscoveryRecords([...remote, ...second]);
const { parseRef, fileRef } = await import(pathToFileURL(join(cli, "packages/core/src/ref.ts")).href);
const dollar = String.fromCharCode(0x24);
const rows = [];
for (const record of catalog.records) {
  const decoded = remote.find(item => item.id === record.id)!;
  assert.equal(decoded.name, record.name, "Display name survives source decoding exactly");
  assert.equal(decoded.alias, record.alias, "Remote invocation alias is consumed without derivation");
  assert.equal(normalizeKey(record.name), record.alias, "Local producer follows the official CLI naming contract");
  const localDirectory = join(evidence, "local", record.id);
  await mkdir(localDirectory, { recursive: true });
  const localPath = join(localDirectory, "SKILL.md");
  await writeFile(localPath, `---\nname: ${JSON.stringify(record.name)}\ndescription: local naming\n---\nbody\n`);
  const local = skillRecordFromFile(localPath, false)!;
  assert.equal(local.name, record.name);
  assert.equal(local.alias, record.alias);
  const choices = dollarAutocompleteItems(registry, record.alias).filter(item => item.identity === recordIdentity(decoded));
  assert.equal(choices.length, 1);
  const choice = choices[0]!;
  const requests = parseInvocations(choice.value + " invoke", configuredRules({}));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.query, choice.value.slice(1));
  const match = matchDiscoveryRecord(requests[0]!.query, registry);
  assert.equal(match.decision, "inject");
  if (match.decision !== "inject") throw new Error("Expected exact match");
  assert.equal(recordIdentity(match.record), choice.identity);
  assert.equal(match.record.ref, record.ref);
  assert.equal(parseRef(match.record.ref).selector, record.locator.type === "notion_page" ? record.locator.page_id : "unexpected");
  const aliasRef = fileRef(record.alias, record.entrypoint);
  assert.equal(parseRef(aliasRef).selector, record.alias, "Percent payload is decoded exactly once");
  assert.equal(parseRef(aliasRef).path, record.entrypoint);
  rows.push({ name: record.name, alias: record.alias, query: requests[0]!.query, identity: choice.identity, ref: choice.ref, aliasRef });
}
const same = remote.filter(record => record.alias === catalog.records.find(record => record.name === "Same Alias")!.alias);
assert.equal(same.length, 2);
assert.equal(matchDiscoveryRecord(same[0]!.alias!, remote).reason, "ambiguous");
assert.equal(matchDiscoveryRecord(same[0]!.alias! + "@naming.prod", remote).reason, "ambiguous");
const crossSource = remote.find(record => record.name === "Tty7")!;
assert.equal(matchDiscoveryRecord(crossSource.alias!, registry).reason, "ambiguous");
for (const query of ["missing@naming.prod", "name@scope/ref", "skill://tty7/SKILL.md", "../tty7", "tty7\u0000", "tty7\u200b", "name%252540scope%25252Fref@naming.prod"]) {
  assert.equal(matchDiscoveryRecord(query, remote).decision, "skip", query);
}
for (const invalid of ["\u0000", "\u200b", "\ud800"]) assert.equal(normalizeKey("name" + invalid), "");
assert.throws(() => parseRef("skill://name%00/SKILL.md"));
assert.throws(() => parseRef("skill://name%2Fpath/SKILL.md"));
await writeFile(join(evidence, "roundtrips.json"), JSON.stringify(rows, null, 2) + "\n");
await writeFile(join(evidence, "result.json"), JSON.stringify({ passed: true, producer: "official CLI listCommand + catalog + recordFromPage + emit", cases: rows.length, remoteSources: 2, evidence }, null, 2) + "\n");
console.log(`Naming producer-consumer checks passed: ${rows.length} official CLI rows, source decoding, exact candidates, U+0024 parser, identity/ref roundtrips, Unicode/percent payloads and ambiguity. Evidence: ${evidence}`);
