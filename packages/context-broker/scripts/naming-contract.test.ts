import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuredRules, matchDiscoveryRecord, parseInvocations } from "../src/index";
import { dedupeDiscoveryRecords, recordIdentity } from "../src/discovery-records";
import { dollarAutocompleteItems } from "../src/dollar";
import { normalizeKey, skillRecordFromFile } from "../src/skill-records";
import { parseNativeReference } from "../src/native-reference";
import { currentNotionFixture } from "./fixtures/current-notion-source";

const runtime = await currentNotionFixture(), evidence = runtime.root;
const cases = [
  ["Tty7", "tty7"], ["n8n-workflow", "n8n-workflow"], ["React19", "react19"], ["中文", "中文"],
  ["  Two   Words  ", "two-words"], ["name@scope/ref", "name%40scope%2Fref"],
  ["name%40scope%2Fref", "name%2540scope%252fref"], ["Same Alias", "same-alias"], ["Same Alias", "same-alias"],
  ["--option", "%2D-option"], ["A_B", "a_b"], ["Café", "café"], ["Café", "café"], ["dot.name", "dot.name"],
] as const;
const records = cases.map(([rawName, alias], index) => {
  const skill = "name-" + index, id = "shared_skill:current-source:" + skill;
  return { ...runtime.record, id, name: rawName.trim(), alias,
    locator: { ...runtime.record.locator, skill_id: skill, page_id: "11111111-1111-4111-8111-" + String(index + 1).padStart(12, "0") },
    ref: "skill://" + encodeURIComponent(id) + "/SKILL.md" };
});
runtime.state.catalog = { ...runtime.state.catalog, records, count: records.length };
const source = { ...runtime.source, id: "official", namespace: "naming.prod" };
const remote = await runtime.boundary.discoverNotionSource(source, evidence);
const second = await runtime.boundary.discoverNotionSource({ ...source, id: "second", namespace: "naming.second" }, evidence);
const registry = dedupeDiscoveryRecords([...remote, ...second]);
const rows = [];
for (const [index, record] of records.entries()) {
  const decoded = remote.find(item => item.id === record.id)!;
  assert.equal(decoded.name, record.name, "Current SDK display metadata stays exact");
  assert.equal(decoded.alias, record.alias, "Remote invocation aliases stay opaque");
  assert.equal(normalizeKey(cases[index]![0]), record.alias, "Local naming matches the explicit Unicode and percent oracle");
  const localDirectory = join(evidence, "local", String(index));
  await mkdir(localDirectory, { recursive: true });
  const localPath = join(localDirectory, "SKILL.md");
  await writeFile(localPath, "---\nname: " + JSON.stringify(record.name) + "\ndescription: local naming\n---\nbody\n");
  const local = skillRecordFromFile(localPath, false)!;
  assert.equal(local.name, record.name); assert.equal(local.alias, record.alias);
  const choices = dollarAutocompleteItems(registry, record.alias).filter(item => item.identity === recordIdentity(decoded));
  assert.equal(choices.length, 1);
  const choice = choices[0]!, requests = parseInvocations(choice.value + " invoke", configuredRules({}));
  assert.equal(requests.length, 1); assert.equal(requests[0]!.query, choice.value.slice(1));
  const match = matchDiscoveryRecord(requests[0]!.query, registry);
  assert.equal(match.decision, "inject");
  if (match.decision !== "inject") throw new Error("Expected exact current selection");
  assert.equal(recordIdentity(match.record), choice.identity); assert.equal(match.record.ref, record.ref);
  assert.equal(parseNativeReference(match.record.ref!).selector, record.id);
  const aliasRef = "skill://" + encodeURIComponent(record.alias) + "/" + record.entrypoint;
  assert.equal(parseNativeReference(aliasRef).selector, record.alias, "Percent payload is decoded once");
  rows.push({ name: record.name, alias: record.alias, query: requests[0]!.query, identity: choice.identity, ref: choice.ref });
}
const same = remote.filter(record => record.alias === "same-alias");
assert.equal(same.length, 2);
assert.equal(matchDiscoveryRecord("same-alias", remote).reason, "ambiguous");
assert.equal(matchDiscoveryRecord("same-alias@naming.prod", remote).reason, "ambiguous");
assert.equal(matchDiscoveryRecord("tty7", registry).reason, "ambiguous");
for (const namespace of ["naming.prod", "naming.second"]) {
  const selection = matchDiscoveryRecord("tty7@" + namespace, registry);
  assert.equal(selection.decision, "inject");
  if (selection.decision === "inject") assert.equal(selection.record.sourceId, namespace === "naming.prod" ? source.id : "second");
  const choices = dollarAutocompleteItems(registry, "tty7@" + namespace);
  assert.ok(choices.some(choice => choice.value === "$tty7@" + namespace));
  for (const choice of choices) {
    const result = matchDiscoveryRecord(choice.value.slice(1), registry);
    assert.equal(result.decision, "inject");
    if (result.decision === "inject") assert.equal(recordIdentity(result.record), choice.identity, "Autocomplete never substitutes the other source");
  }
}
for (const query of ["missing@naming.prod", "name@scope/ref", "skill://tty7/SKILL.md", "../tty7", "tty7\u0000", "tty7\u200b", "name%252540scope%25252Fref@naming.prod"])
  assert.equal(matchDiscoveryRecord(query, remote).decision, "skip", query);
for (const invalid of ["\u0000", "\u200b", "\ud800"]) assert.equal(normalizeKey("name" + invalid), "");
assert.throws(() => parseNativeReference("skill://name%00/SKILL.md"));
assert.throws(() => parseNativeReference("skill://name%2Fpath/SKILL.md"));
assert.ok(runtime.calls.every(call => call.operation === "list"), "Names and autocomplete never prepare bodies");
await writeFile(join(evidence, "roundtrips.json"), JSON.stringify(rows, null, 2) + "\n");
console.log("Current naming checks passed: Unicode/percent aliases, local parity, source decoding, exact autocomplete and ambiguity. Evidence: " + evidence);
