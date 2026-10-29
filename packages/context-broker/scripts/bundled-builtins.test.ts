import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { BUNDLED_SKILL_NAMES, bundledBuiltinRoot, configuredBundledBuiltinRecords, isBundledBuiltin, readBundledBuiltinRecords } from "../src/bundled-builtins";
import { dedupeDiscoveryRecords, recordIdentity, recordToken } from "../src/discovery-records";
import { dollarAutocompleteItems } from "../src/dollar";
import { completeDollarRequest } from "../src/completion";
import { buildCliGuidance, buildDollarRegistry, buildRawDollarRegistry, buildRegistry, matchDiscoveryRecord } from "../src/index";
import { skillRecordFromFile } from "../src/skill-records";
import { discoverSources, loadSourceSkill } from "../src/sources";
import type { ConfigFile, SkillRecord } from "../src/types";

const root = await mkdtemp(join(tmpdir(), "broker-bundled-"));
try {
  const bundledRoot = join(root, "query", "builtin-skills");
  for (const name of BUNDLED_SKILL_NAMES) {
    const directory = join(bundledRoot, name);
    await mkdir(join(directory, "references"), { recursive: true });
    await writeFile(join(directory, "SKILL.md"), "---\nname: " + name + "\ndescription: Bundled " + name + "\n---\nRead references/task.md.\n");
    await writeFile(join(directory, "references", "task.md"), "Bundled resource: " + name);
  }
  assert.equal(bundledBuiltinRoot(pathToFileURL(join(root, "query", "completion.mjs")).href), bundledRoot + "/");
  const bundled = readBundledBuiltinRecords(bundledRoot);
  assert.equal(bundled.length, 3);
  for (const record of bundled) {
    assert.equal(isBundledBuiltin(record), true);
    assert.equal(record.sourceId, undefined);
    const loaded = await loadSourceSkill(record, { sources: [] }, root);
    assert.match(loaded.body ?? "", /references\/task.md/);
    assert.equal(await readFile(join(dirname(loaded.path), "references", "task.md"), "utf8"), "Bundled resource: " + record.alias);
  }

  const target = bundled.find(record => record.alias === "ntn-skills-maintain")!;
  const localRoot = join(root, "user");
  await mkdir(localRoot);
  await writeFile(join(localRoot, "SKILL.md"), "---\nname: ntn-skills-maintain\ndescription: User-owned content\n---\nUser content.\n");
  const local = skillRecordFromFile(join(localRoot, "SKILL.md"), false)!;
  const config: ConfigFile = { sources: [{ type: "filesystem", id: "user-source", namespace: "builtin", roots: [localRoot], requireAutoload: false }] };

  // A bundled file remains readable offline, but it must not be offered as a
  // Notion workflow until an enabled Notion source opts into that feature.
  const disabledNotion: ConfigFile = { sources: [{ type: "notion", id: "disabled-notion", enabled: false, command: join(root, "missing-cli") }] };
  for (const inactive of [{}, { sources: [] }, config, disabledNotion] satisfies ConfigFile[]) {
    assert.deepEqual(configuredBundledBuiltinRecords(inactive), [], "No enabled Notion source means no bundled candidates");
    const standard = await buildRegistry({ ...inactive, requireAutoload: false });
    const complete = await buildDollarRegistry(inactive, root);
    const raw = await buildRawDollarRegistry(inactive, root);
    for (const records of [standard, complete.records, raw.records]) {
      assert.equal(records.some(record => isBundledBuiltin(record)), false, "All discovery paths must hide Notion builtins when disabled");
    }
    assert.deepEqual(complete.failures, [], "Disabled Notion sources must not be queried");
    const suggestions = await completeDollarRequest({ version: 1, text: "$ntn-", cursor: 5, cwd: root }, inactive);
    assert.equal(suggestions.items.some(item => BUNDLED_SKILL_NAMES.some(name => item.value === `$${name}@builtin`)), false,
      "Standalone/Tern completion must hide the official builtin tokens, not unrelated source-qualified candidates");
  }
  const filesystemOnly = await buildDollarRegistry(config, root);
  assert.ok(filesystemOnly.records.some(record => record.sourceId === "user-source" && record.name === "ntn-skills-maintain"),
    "Hiding packaged Notion workflows must not hide a user-owned, same-name filesystem source");

  const awaitingConnection: ConfigFile = { sources: [{ type: "notion", id: "notion-setup", command: join(root, "missing-cli") }] };
  assert.equal(configuredBundledBuiltinRecords(awaitingConnection).length, 3, "Configured Notion enables offline setup workflows even without credentials");
  const unconnected = await buildDollarRegistry(awaitingConnection, root);
  assert.equal(unconnected.records.filter(isBundledBuiltin).length, 3);
  assert.ok(unconnected.failures.length > 0, "This case intentionally uses an unavailable source, not a working Notion connection");
  assert.equal((await buildRegistry({ ...awaitingConnection, requireAutoload: false })).filter(isBundledBuiltin).length, 3);
  assert.equal((await buildRawDollarRegistry(awaitingConnection, root)).records.filter(isBundledBuiltin).length, 3);
  const setupSuggestions = await completeDollarRequest({ version: 1, text: "$ntn-", cursor: 5, cwd: root }, awaitingConnection);
  assert.deepEqual(setupSuggestions.items.map(item => item.value).sort(), BUNDLED_SKILL_NAMES.map(name => `$${name}@builtin`).sort(),
    "Explicit Notion opt-in restores the same ordinary builtin candidates before connecting");

  const configured = await discoverSources(config, root);
  const remote: SkillRecord = {
    ...target, source: "notion", sourceId: "remote",
    id: "notion_page:11111111-1111-4111-8111-111111111111",
    locator: { type: "notion_page", page_id: "11111111-1111-4111-8111-111111111111", database_id: "22222222-2222-4222-8222-222222222222", data_source_id: "33333333-3333-4333-8333-333333333333" },
    path: "", body: undefined,
    token: "builtin/ntn-skills-maintain",
    selectionToken: "ntn-skills-maintain@builtin",
  };
  const registry = dedupeDiscoveryRecords([...bundled, local, ...configured, remote]);
  const candidates = registry.filter(record => record.name === "ntn-skills-maintain");
  assert.equal(candidates.length, 4, "Bundled, first local root, configured filesystem and Notion keep independent identities");
  assert.equal(new Set(candidates.map(recordToken)).size, 4, "A configured builtin namespace cannot impersonate the bundled candidate");
  for (const record of candidates) {
    const decision = matchDiscoveryRecord(recordToken(record), registry);
    assert.equal(decision.decision, "inject");
    if (decision.decision === "inject") assert.equal(recordIdentity(decision.record), recordIdentity(record));
  }
  const ownChoice = dollarAutocompleteItems(registry, "ntn-skills-maintain").find(item => item.identity === recordIdentity(target))!;
  assert.equal(ownChoice.value, "$ntn-skills-maintain@builtin");
  assert.match(ownChoice.description ?? "", /bundled builtin/);
  const reloaded = await loadSourceSkill(target, config, root);
  assert.doesNotMatch(reloaded.body ?? "", /User content/);
  assert.equal(matchDiscoveryRecord("not-a-skill", registry).decision, "skip");

  const guidance = buildCliGuidance({ sources: [
    { type: "notion", id: "first", command: ["first-cli", "--profile", "one"], database: "one" },
    { type: "notion", id: "second", command: ["second-cli", "--profile", "two"], database: "two" },
  ] });
  const content = String(guidance.content);
  assert.match(content, /source="first"/);
  assert.match(content, /source="second"/);
  assert.match(content, /first-cli/);
  assert.match(content, /second-cli/);
  assert.match(content, /never choose the first source implicitly/);

  console.log("bundled builtin checks passed: Notion opt-in gates all discovery and detached completion, disconnected setup still works, offline files/resources, independent source identities and CLI guidance");
} finally {
  await rm(root, { recursive: true, force: true });
}
