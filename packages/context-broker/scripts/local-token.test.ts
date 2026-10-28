import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { completeDollarRequest } from "../src/completion";
import { buildDollarRegistry, buildRegistry, configuredRules, invokeForContext, matchDiscoveryRecord, parseInvocations } from "../src/index";
import { recordIdentity } from "../src/discovery-records";
import { buildDollarRegistryForContext } from "../src/dollar";
import { preserveTemp } from "./context-broker-e2e-fixture.mjs";
import type { ConfigFile } from "../src/types";

const root = await mkdtemp(join(tmpdir(), "broker-local-token-"));
try {
  const names = ["Scoped Evidence", "跨 源 能力", "Scoped Evidence"];
  const roots = names.map((_, index) => join(root, String(index)));
  for (const [index, name] of names.entries()) {
    await mkdir(roots[index]!);
    await writeFile(join(roots[index]!, "SKILL.md"), `---\nname: ${JSON.stringify(name)}\ndescription: local token fixture ${index}\n---\nowned body ${index}\n`);
  }
  const config: ConfigFile = { skillRoots: [], sources: roots.map((path, index) => ({ type: "filesystem", id: "source-" + index, namespace: index === 0 ? "owned-local" : index === 1 ? "团队.prod" : "second.prod", roots: [path], requireAutoload: false })) };
  const { records } = await buildDollarRegistry(config, root);
  const dollar = String.fromCharCode(0x24);
  for (const [prefix, namespace, name, index] of [["scoped-evidence", "owned-local", names[0], 0], ["跨-源-能力", "团队.prod", names[1], 1], ["scoped-evidence", "second.prod", names[2], 2]] as const) {
    const text = dollar + prefix;
    const response = await completeDollarRequest({ version: 1, text, cursor: text.length, cwd: root }, config);
    const expected = records.find(record => record.token?.startsWith(namespace + "/"))!;
    const choice = response.items.find(item => item.identity === recordIdentity(expected))!;
    assert.ok(choice);
    const reference = await realpath(join(roots[index]!, "SKILL.md"));
    assert.equal(choice.value, `${dollar}${prefix}@${encodeURIComponent("local:" + reference)}@${namespace}`,
      "Public completion retains exact local identity even when the name is unique in its namespace");
    assert.equal(choice.ref, reference);
    assert.ok(!/\s/.test(choice.value));
    assert.equal(expected.name, name, "Display name remains frontmatter metadata");
    const submitted = text.slice(0, response.edit!.from) + choice.value + text.slice(response.edit!.to);
    const requests = parseInvocations(submitted, configuredRules(config));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.query, choice.value.slice(1));
    const selected = matchDiscoveryRecord(requests[0]!.query, records);
    assert.equal(selected.decision, "inject");
    if (selected.decision === "inject") {
      assert.equal(recordIdentity(selected.record), choice.identity);
      assert.equal(selected.record.ref, reference);
    }
  }
  for (const [preferred, shadowed, expectedBody, rejectedBody] of [[0, 2, "owned body 0", "owned body 2"], [2, 0, "owned body 2", "owned body 0"]] as const) {
    const localConfig: ConfigFile = { skillRoots: [roots[preferred]!, roots[shadowed]!], requireAutoload: false };
    const configured = await buildRegistry(localConfig);
    const discovery = await buildDollarRegistry(localConfig, root);
    const merged = await buildDollarRegistryForContext({
      getSystemPrompt: () => `<skill><name>Scoped Evidence</name><description>Native fallback</description><location>${join(roots[shadowed]!, "SKILL.md")}</location></skill>`,
    }, Promise.resolve(discovery.records));
    const response = await completeDollarRequest({ version: 1, text: dollar + "scoped-evidence", cursor: 16, cwd: root }, localConfig);
    const preferredPath = join(roots[preferred]!, "SKILL.md");
    const precise = `${dollar}scoped-evidence@${encodeURIComponent("local:" + preferredPath)}@local`;
    assert.deepEqual(response.items.filter(item => item.value.startsWith(dollar + "scoped-evidence")).map(item => [item.value, item.ref]),
      [[precise, preferredPath]]);
    assert.deepEqual(merged.filter(record => record.name === "Scoped Evidence").map(record => record.path), [join(roots[preferred]!, "SKILL.md")]);
    for (const invocation of [precise, dollar + "scoped-evidence", dollar + "scoped-evidence@local", "skill: Scoped Evidence"]) {
      const injected = await invokeForContext({ messages: [{ role: "user", content: invocation }] }, Promise.resolve(configured), localConfig, Promise.resolve(merged));
      const body = JSON.stringify(injected?.messages ?? []);
      assert.match(body, new RegExp(expectedBody));
      assert.doesNotMatch(body, new RegExp(rejectedBody));
    }
    const quotedError = "Error: context-broker: $ notify-me@local: ambiguous; run /context-broker find notify-me";
    assert.deepEqual(parseInvocations(quotedError, configuredRules(localConfig)), []);
    assert.equal(await invokeForContext({ messages: [{ role: "user", content: quotedError }] }, Promise.resolve(configured), localConfig, Promise.resolve(merged)), undefined);
  }
  console.log("local token checks passed: first-root completion and invocation, reversed precedence, native fallback, stable @local selectors and independent source identities");
} finally {
  preserveTemp(root);
}
