import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { completeDollarRequest, parseCompletionRequest, type ContentCompletionItem } from "../src/completion";
import { bundledBuiltinRecords } from "../src/bundled-builtins";
import { recordIdentity } from "../src/discovery-records";
import { createDollarSkillAutocompleteProvider, dollarAutocompleteItems } from "../src/dollar";
import { completionMenu } from "./fixtures/completion-menu";
import { buildDollarRegistry, invokeForContext } from "../src/index";
import { currentNotionFixture } from "./fixtures/current-notion-source";

const root = await mkdtemp(join(tmpdir(), "broker-completion-"));
await mkdir(join(root, "design-review"));
const remoteRoot = await mkdtemp(join(tmpdir(), "broker-completion-source-"));
await mkdir(join(remoteRoot, "design-review"));
await writeFile(join(remoteRoot, "design-review/SKILL.md"), "---\nname: design-review\ndescription: Source review\n---\nSOURCE_BODY_MARKER\n");
await writeFile(join(root, "design-review/SKILL.md"), "---\nname: design-review\ndescription: Review API boundaries\nautoload:\n  aliases: [架构评审]\n---\nPRIVATE_BODY_MARKER\n");
const localValue = "$design-review@" + encodeURIComponent("local:" + join(root, "design-review/SKILL.md")) + "@local";
const bundledIdentities = new Map(bundledBuiltinRecords().map(record => [recordIdentity(record), record]));
const displaySelectors = (items: ContentCompletionItem[]) => items.map(item => {
  const bundled = bundledIdentities.get(item.identity);
  if (bundled) {
    assert.equal(item.value, "$" + bundled.alias + "@builtin");
    assert.equal(item.source, "local");
    assert.equal(item.ref, bundled.path, "A bundled token must identify the actual packaged file");
    return item.value;
  }
  const match = /^\$(.+)@([^@]+)@([^@]+)$/.exec(item.value);
  assert.ok(match, "Detached completion always returns the existing identity-qualified token");
  if (item.source === "notion") {
    const page = /^skill:\/\/([^/]+)\//.exec(item.ref ?? "")?.[1];
    assert.equal(match[2], decodeURIComponent(page ?? "").replaceAll("-", ""), "The inserted page identity must agree with the selected ref");
  } else assert.equal(decodeURIComponent(match[2]!), "local:" + item.ref);
  return "$" + match[1] + "@" + match[3];
});
const config = { skillRoots: [root], requireAutoload: false };
const draft = "中文😀\n使用 $架构 tail";
const cursor = draft.indexOf(" tail");
const result = await completeDollarRequest(parseCompletionRequest({ version: 1, text: draft, cursor, cwd: root }), config);
assert.deepEqual(result.edit, { from: draft.indexOf("$"), to: cursor, len: draft.length, prefix: "$架构" });
assert.equal(result.items[0]?.value, localValue);
assert.equal(result.items[0]?.kind, "skill");
assert.equal(result.items[0]?.source, "local");
assert.ok(result.items[0]?.ref);
assert.equal(JSON.parse(result.items[0]!.identity!)[2], "skill");
assert.equal(draft.slice(0, result.edit!.from) + result.items[0]!.value + draft.slice(result.edit!.to), "中文😀\n使用 " + localValue + " tail");
assert.ok(!JSON.stringify(result).includes("PRIVATE_BODY_MARKER"));
assert.equal((await completeDollarRequest({ version: 1, text: "$missing", cursor: 8, cwd: root }, config)).items.length, 0);
assert.throws(() => parseCompletionRequest({ version: 1, text: "😀", cursor: 1, cwd: root }), /surrogate/);
assert.throws(() => parseCompletionRequest({ version: 2, text: "$", cursor: 1, cwd: root }), /version/);
const partial = await completeDollarRequest({ version: 1, text: "$des", cursor: 4, cwd: root }, {
  ...config,
  sources: [
    { id: "source", namespace: "notion", type: "filesystem", roots: [remoteRoot], requireAutoload: false },
  ],
});
const selectedLocal = partial.items.find(item => item.value === localValue);
assert.ok(selectedLocal, "A same-name source must leave the local candidate selectable");
assert.ok(displaySelectors(partial.items).includes("$design-review@notion"), "Independent filesystem sources remain visible");
await assert.rejects(completeDollarRequest({ version: 1, text: "$des", cursor: 4, cwd: root }, {
  sources: [{ id: "retired", type: "notion", command: "retired-cli" }],
}), { code: "SOURCE_COMMAND_UNSUPPORTED" });
assert.ok(!JSON.stringify(partial).includes("PRIVATE_BODY_MARKER"));
const mixedConfig = { ...config, sources: [{ id: "source", namespace: "notion", type: "filesystem" as const, roots: [remoteRoot], requireAutoload: false }] };
const { records: mixedRecords } = await buildDollarRegistry(mixedConfig);
const invoke = (value: string) => invokeForContext({ messages: [{ role: "user", content: `${value} Apply the selected instructions.` }] }, Promise.resolve([]), mixedConfig, Promise.resolve(mixedRecords));
const localResult = await invoke(selectedLocal!.value);
assert.match(String(localResult?.messages?.at(-1)?.content), /PRIVATE_BODY_MARKER/);
assert.doesNotMatch(String(localResult?.messages?.at(-1)?.content), /SOURCE_BODY_MARKER/);
const sourceResult = await invoke("$design-review@notion");
assert.match(String(sourceResult?.messages?.at(-1)?.content), /SOURCE_BODY_MARKER/);
assert.doesNotMatch(String(sourceResult?.messages?.at(-1)?.content), /PRIVATE_BODY_MARKER/);
await assert.rejects(invoke("$design-review"), (error: unknown) => {
  const rejected = error as Error & { code: string };
  assert.equal(rejected.code, "INVOCATION_AMBIGUOUS");
  assert.ok(rejected.message.includes("$design-review@local"));
  assert.ok(rejected.message.includes("$design-review@notion"));
  return true;
});
assert.equal((await completeDollarRequest({ version: 1, text: "$des", cursor: 4, cwd: root }, config)).items[0]?.value, localValue, "The exact manual identity is independent of same-name catalog collisions");
assert.equal(await invoke("$design-review@unknown"), undefined, "An unknown qualifier is ordinary user material");
const canonicalResult = await invoke("$notion/design-review");
assert.match(String(canonicalResult?.messages?.at(-1)?.content), /SOURCE_BODY_MARKER/);
const sourceNamedLocalConfig = { ...config, sources: [{ id: "local", type: "filesystem" as const, roots: [remoteRoot], requireAutoload: false }] };
const { records: sourceNamedLocalRecords } = await buildDollarRegistry(sourceNamedLocalConfig);
const localNamespaceResult = await invokeForContext({ messages: [{ role: "user", content: "$local/design-review Apply this source." }] }, Promise.resolve([]), sourceNamedLocalConfig, Promise.resolve(sourceNamedLocalRecords));
assert.match(String(localNamespaceResult?.messages?.at(-1)?.content), /SOURCE_BODY_MARKER/);
const routerCatalog = join(root, "catalog.json");
await writeFile(routerCatalog, JSON.stringify({ records: [{ kind: "router", name: "design-review", description: "Review router", members: { include: ["design-review"] } }] }));
const routerConfig = { ...mixedConfig, discoveryCatalogs: [routerCatalog] };
const { records: routerRecords } = await buildDollarRegistry(routerConfig);
const selectedRouter = routerRecords.find(record => record.kind === "router")!;
const routerCandidate = dollarAutocompleteItems(routerRecords, "design-review").find(item => item.identity === recordIdentity(selectedRouter))!;
assert.ok(routerCandidate.value.startsWith("$"), "the completion replacement includes the invocation prefix");
for (const query of ["$design-review", "$design-review@local"]) {
  await assert.rejects(invokeForContext({ messages: [{ role: "user", content: query + " Show the selected content." }] }, Promise.resolve([]), routerConfig, Promise.resolve(routerRecords)), { code: "INVOCATION_AMBIGUOUS" }, "Bare/short same-name selectors still require a choice");
}
const exactRouter = await invokeForContext({ messages: [{ role: "user", content: `${routerCandidate.value} Show the router index.` }] }, Promise.resolve([]), routerConfig, Promise.resolve(routerRecords));
assert.match(String(exactRouter?.messages?.at(-1)?.content), /<context-broker-record kind="router"/);
assert.doesNotMatch(String(exactRouter?.messages?.at(-1)?.content), /PRIVATE_BODY_MARKER|SOURCE_BODY_MARKER/);
const sameNameLocal = routerRecords.find(record => record.kind === "skill" && !record.sourceId && record.name === "design-review")!;
const sameNameLocalCandidate = dollarAutocompleteItems(routerRecords, "design-review").find(item => item.identity === recordIdentity(sameNameLocal))!;
const exactLocal = await invokeForContext({ messages: [{ role: "user", content: sameNameLocalCandidate.value }] }, Promise.resolve([]), routerConfig, Promise.resolve(routerRecords));
assert.match(String(exactLocal?.messages?.at(-1)?.content), /PRIVATE_BODY_MARKER/);
assert.doesNotMatch(String(exactLocal?.messages?.at(-1)?.content), /<context-broker-record kind="router"|SOURCE_BODY_MARKER/);
await writeFile(routerCatalog, JSON.stringify({ records: [{ kind: "router", name: "review-router", description: "Review router", members: { include: ["design-review"] } }] }));
const { records: distinctRouterRecords } = await buildDollarRegistry(routerConfig);
const distinctRouter = distinctRouterRecords.find(record => record.kind === "router")!;
const distinctRouterCandidate = dollarAutocompleteItems(distinctRouterRecords, "review-router").find(item => item.identity === recordIdentity(distinctRouter))!;
const routerResult = await invokeForContext({ messages: [{ role: "user", content: `${distinctRouterCandidate.value} Show the router index.` }] }, Promise.resolve([]), routerConfig, Promise.resolve(distinctRouterRecords));
assert.match(String(routerResult?.messages?.at(-1)?.content), /<context-broker-record kind="router"/);
assert.doesNotMatch(String(routerResult?.messages?.at(-1)?.content), /SOURCE_BODY_MARKER|PRIVATE_BODY_MARKER/);
await mkdir(join(remoteRoot, "second"));
await writeFile(join(remoteRoot, "second/SKILL.md"), "---\nname: design-review\ndescription: Second source review\n---\nSECOND_SOURCE_BODY_MARKER\n");
const { records: duplicateRecords } = await buildDollarRegistry(mixedConfig);
await assert.rejects(invokeForContext({ messages: [{ role: "user", content: "$design-review@notion Apply it." }] }, Promise.resolve([]), mixedConfig, Promise.resolve(duplicateRecords)), { code: "INVOCATION_AMBIGUOUS" }, "A source-qualified alias matching multiple identities rejects without selecting either record");
for (const selected of duplicateRecords.filter(record => "sourceId" in record && record.sourceId)) {
  const duplicateResult = await invokeForContext({ messages: [{ role: "user", content: `$${selected.token} Apply this page.` }] }, Promise.resolve([]), mixedConfig, Promise.resolve(duplicateRecords));
  assert.equal(String(duplicateResult?.messages?.at(-1)?.content).includes("SECOND_SOURCE_BODY_MARKER"), selected.path.includes("/second/"));
}
// Current Notion completion consumes SDK v2 metadata; it does not execute a CLI.
for (const kind of ["skill", "router", "prompt"] as const) {
  const f = await currentNotionFixture(kind, { name: "current-" + kind, body: "CURRENT_COMPLETION_" + kind + "_BODY\n" });
  const currentCompletion: typeof import("../src/completion") = await import(pathToFileURL(join(f.root, "src/completion.ts")).href);
  const currentIndex: typeof import("../src/index") = await import(pathToFileURL(join(f.root, "src/index.ts")).href);
  const currentConfig = { sources: [f.source] };
  const text = "$current-" + kind;
  const observed = await currentCompletion.completeDollarRequest({ version: 1, text, cursor: text.length, cwd: f.root }, currentConfig);
  assert.equal(observed.items.length, 1);
  const item = observed.items[0]!;
  assert.equal(item.kind, kind); assert.equal(item.source, "notion"); assert.equal(item.ref, f.record.ref);
  assert.ok(f.record.locator.type === "shared_skill");
  assert.equal(item.value, "$current-" + kind + "@" + f.record.locator.page_id.replaceAll("-", "") + "@notion");
  assert.equal(JSON.stringify(observed).includes(f.body.trim()), false);
  assert.deepEqual(f.calls.map(call => call.operation), ["list"]);
  const { records } = await currentIndex.buildDollarRegistry(currentConfig, f.root);
  const selected = await currentIndex.invokeForContext({ messages: [{ role: "user", content: item.value + " Apply this selection." }] },
    Promise.resolve([]), currentConfig, Promise.resolve(records));
  assert.ok(JSON.stringify(selected).includes(f.body.trim()));
  assert.equal(f.calls.filter(call => call.operation === "consume").length, 1);
  f.state.list = () => { throw Object.assign(new Error("controlled current source denial"), { code: "ACCESS_DENIED" }); };
  const failed = await currentCompletion.completeDollarRequest({ version: 1, text: "$des", cursor: 4, cwd: root },
    { ...config, sources: [f.source] });
  assert.ok(failed.items.some(item => item.value === localValue), "A failed SDK source cannot hide local completion");
  assert.deepEqual(failed.failures?.map(value => value.code), ["ACCESS_DENIED"]);
}
const provider = createDollarSkillAutocompleteProvider({
  async getSuggestions() { return null; },
  applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
}, completionMenu([{ name: "design-review", normalizedName: "design-review", description: "Review", normalizedDescription: "review", aliases: [], normalizedAliases: [], path: join(root, "design-review/SKILL.md") }]));
const hostSignal = new AbortController();
assert.equal((await provider.getSuggestions(["$des"], 0, 4, hostSignal.signal))?.items[0]?.value, "$design-review");
const inlineDraft = "中文😀使用$des tail";
const inlineCursor = inlineDraft.indexOf(" tail");
const inlineSuggestions = await provider.getSuggestions([inlineDraft], 0, inlineCursor);
assert.equal(inlineSuggestions?.items[0]?.value, "$design-review");
const inlineCompleted = provider.applyCompletion([inlineDraft], 0, inlineCursor, inlineSuggestions!.items[0], inlineSuggestions!.prefix);
assert.equal(inlineCompleted.lines[0], "中文😀使用$design-review tail");
const repeatedDraft = "先$design-review 再$des";
assert.equal((await provider.getForceFileSuggestions!([repeatedDraft], 0, repeatedDraft.length))?.items[0]?.value, "$design-review");
hostSignal.abort();
assert.equal(await provider.getSuggestions(["$des"], 0, 4, hostSignal.signal), null);
console.log("Current completion behavior passed; fixtures retained: " + root);
