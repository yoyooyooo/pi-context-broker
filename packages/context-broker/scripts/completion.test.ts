import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeDollarRequest, parseCompletionRequest } from "../src/completion";
import { recordIdentity } from "../src/discovery-records";
import { createDollarSkillAutocompleteProvider, dollarAutocompleteItems } from "../src/dollar";
import { buildDollarRegistry, invokeForContext } from "../src/index";
import { createNotionFixture, canary, secondCanary } from "../../../scripts/notion-integration-fixture.mjs";

const root = await mkdtemp(join(tmpdir(), "broker-completion-"));
await mkdir(join(root, "design-review"));
const remoteRoot = await mkdtemp(join(tmpdir(), "broker-completion-source-"));
await mkdir(join(remoteRoot, "design-review"));
await writeFile(join(remoteRoot, "design-review/SKILL.md"), "---\nname: design-review\ndescription: Source review\n---\nSOURCE_BODY_MARKER\n");
await writeFile(join(root, "design-review/SKILL.md"), "---\nname: design-review\ndescription: Review API boundaries\nautoload:\n  aliases: [架构评审]\n---\nPRIVATE_BODY_MARKER\n");
const localValue = "$design-review@" + encodeURIComponent("local:" + join(root, "design-review/SKILL.md")) + "@local";
// Manual values bind a page identity; these assertions also check that identity against its ref.
const displaySelectors = (items: Array<{ value: string; source?: string; ref?: string }>) => items.map(item => {
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
    { id: "broken", namespace: "remote", type: "notion", command: join(root, "absent-source-cli") },
    { id: "source", namespace: "notion", type: "filesystem", roots: [remoteRoot], requireAutoload: false },
  ],
});
const selectedLocal = partial.items.find(item => item.value === localValue);
assert.ok(selectedLocal, "A same-name source must leave the local candidate selectable");
assert.ok(displaySelectors(partial.items).includes("$design-review@notion"), "A failed remote source must preserve later filesystem sources");
assert.deepEqual(partial.failures?.map(({ sourceId, namespace, code }) => ({ sourceId, namespace, code })), [{ sourceId: "broken", namespace: "remote", code: "SOURCE_COMMAND_UNAVAILABLE" }]);
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
const notionFixture = await createNotionFixture(join(root, "notion-fixture"));
const notionSource = { id: "notion", type: "notion" as const, command: notionFixture.command, cacheDir: join(root, "notion-cache") };
const notionConfig = { sources: [notionSource] };
const notionQuery = (config = notionConfig) => completeDollarRequest({ version: 1, text: "$ui-a", cursor: 5, cwd: root }, config);
const invokeNotion = async (selector: string, config = notionConfig) => {
  const { records } = await buildDollarRegistry(config, root);
  return invokeForContext({ messages: [{ role: "user", content: `${selector} Apply the selected page.` }] }, Promise.resolve([]), config, Promise.resolve(records));
};
assert.deepEqual(displaySelectors((await notionQuery()).items), ["$ui-alpha@notion"]);
const detachedFixture = await createNotionFixture(join(root, "detached-default-context"));
await detachedFixture.setScenario("normal", { includeUnflagged: true });
const detachedConfig = { sources: [{ ...notionSource, command: detachedFixture.command, cacheDir: join(root, "detached-cache") }] };
const detached = await completeDollarRequest({ version: 1, text: "$ui-", cursor: 4, cwd: root }, detachedConfig);
assert.deepEqual(new Set(displaySelectors(detached.items)), new Set(["$ui-alpha@notion", "$ui-beta@notion", "$ui-gamma@notion"]));
assert.ok(!JSON.stringify(detached).includes(canary));
const detachedCalls = (await readFile(detachedFixture.callsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
assert.equal(detachedCalls.some(call => ["read", "export"].includes(call.command)), false, "Detached completion never prepares even explicitly flagged Default Context entries");
assert.match(String((await invokeNotion("$ui-alpha@notion"))?.messages?.at(-1)?.content), new RegExp(canary));
const alphaRoot = await mkdtemp(join(tmpdir(), "broker-completion-alpha-"));
await mkdir(join(alphaRoot, "ui-alpha"));
await writeFile(join(alphaRoot, "ui-alpha/SKILL.md"), "---\nname: ui-alpha\n---\nLOCAL_ALPHA_BODY\n");
const notionLocalConfig = { ...notionConfig, skillRoots: [alphaRoot], requireAutoload: false };
assert.deepEqual(new Set(displaySelectors((await notionQuery(notionLocalConfig)).items)), new Set(["$ui-alpha@local", "$ui-alpha@notion"]));
const localAlpha = await invokeNotion("$ui-alpha@local", notionLocalConfig);
assert.match(String(localAlpha?.messages?.at(-1)?.content), /LOCAL_ALPHA_BODY/);
assert.doesNotMatch(String(localAlpha?.messages?.at(-1)?.content), new RegExp(canary));
await notionFixture.setScenario("normal", { upstream: { repo: "pstack" }, includeUnflagged: true });
const upstreamQuery = (prefix: string) => completeDollarRequest({ version: 1, text: "$" + prefix, cursor: prefix.length + 1, cwd: root }, notionConfig);
const upstreamMembers = await upstreamQuery("pstack/");
assert.deepEqual(displaySelectors(upstreamMembers.items).sort(), ["$ui-alpha@notion", "$ui-beta@notion", "$ui-gamma@notion"]);
assert.deepEqual(displaySelectors((await upstreamQuery("pstack/ui-b")).items), ["$ui-beta@notion"]);
assert.equal(displaySelectors((await upstreamQuery("notion/ui-alpha")).items)[0], "$ui-alpha@notion", "Subscription browsing preserves canonical source lookup");
const { records: upstreamRecords } = await buildDollarRegistry(notionConfig, root);
const foreignMember = { ...upstreamRecords.find(record => record.source === "notion")!, upstream: { repo: "matt" }, description: "pstack/ui-alpha", normalizedDescription: "pstack/ui-alpha", path: "/foreign/SKILL.md", selectionToken: "foreign@notion" };
assert.deepEqual(dollarAutocompleteItems([...upstreamRecords, foreignMember], "pstack/").map(item => item.value).sort(), displaySelectors(upstreamMembers.items).sort(), "A namespace query cannot include another subscription merely because its description mentions the namespace");
assert.equal((await upstreamQuery("pstack/ui-missing")).items.length, 0);
await notionFixture.setScenario("duplicates", { upstream: { repo: "fixture-repo" } });
const pages = ["11111111111141118111111111111111", "22222222222242228222222222222222"];
assert.deepEqual(new Set((await notionQuery()).items.map(item => item.value)), new Set(pages.map(page => `$ui-alpha@${page}@notion`)));
assert.deepEqual(new Set((await upstreamQuery("fixture-repo/")).items.map(item => item.value)), new Set(pages.map(page => `$ui-alpha@${page}@notion`)), "Subscription browsing retains exact page selectors for duplicate names");
await assert.rejects(invokeNotion("$ui-alpha@notion"), { code: "INVOCATION_AMBIGUOUS" }, "A source-qualified alias matching multiple pages rejects without selecting either page");
for (const [index, page] of pages.entries()) {
  const selected = String((await invokeNotion(`$ui-alpha@${page}@notion`))?.messages?.at(-1)?.content);
  assert.match(selected, new RegExp(index ? secondCanary : canary));
  assert.doesNotMatch(selected, new RegExp(index ? canary : secondCanary));
}
await notionFixture.setScenario("normal");
const twoNotionConfig = { sources: [notionSource, { ...notionSource, id: "second", namespace: "team" }] };
assert.deepEqual(new Set(displaySelectors((await notionQuery(twoNotionConfig)).items)), new Set(["$ui-alpha@notion", "$ui-alpha@team"]));
const dottedNotionConfig = { sources: [{ ...notionSource, id: "team.prod" }] };
assert.deepEqual(displaySelectors((await notionQuery(dottedNotionConfig)).items), ["$ui-alpha@team.prod"]);
assert.match(String((await invokeNotion("$ui-alpha@team.prod.", dottedNotionConfig))?.messages?.at(-1)?.content), new RegExp(canary));
const localNamespaceNotion = { ...notionLocalConfig, sources: [{ ...notionSource, id: "local" }] };
const localNamespaceItems = (await notionQuery(localNamespaceNotion)).items;
assert.equal(localNamespaceItems.length, 2);
assert.equal(new Set(localNamespaceItems.map(item => item.identity)).size, 2);
assert.equal(new Set(localNamespaceItems.map(item => item.value)).size, 2, "a source named local must not hide either exact selector");
const localNamespaceFile = localNamespaceItems.find(item => item.source === "local")!;
const localNamespacePage = localNamespaceItems.find(item => item.source === "notion")!;
assert.ok(localNamespaceFile && localNamespacePage, "source enum is independent of sourceId local");
assert.equal(JSON.parse(localNamespacePage.identity)[0], "local");
assert.equal(JSON.parse(localNamespacePage.identity)[3], "notion_page");
const localNamespaceFileResult = await invokeNotion(localNamespaceFile.value, localNamespaceNotion);
assert.match(String(localNamespaceFileResult?.messages?.at(-1)?.content), /LOCAL_ALPHA_BODY/);
assert.doesNotMatch(String(localNamespaceFileResult?.messages?.at(-1)?.content), new RegExp(canary));
const localNamespacePageResult = await invokeNotion(localNamespacePage.value, localNamespaceNotion);
assert.match(String(localNamespacePageResult?.messages?.at(-1)?.content), new RegExp(canary));
assert.doesNotMatch(String(localNamespacePageResult?.messages?.at(-1)?.content), /LOCAL_ALPHA_BODY/);
const provider = createDollarSkillAutocompleteProvider({
  async getSuggestions() { return null; },
  applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
}, Promise.resolve([{ name: "design-review", normalizedName: "design-review", description: "Review", normalizedDescription: "review", aliases: [], normalizedAliases: [], path: join(root, "design-review/SKILL.md") }]));
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
// Each explicit Prompt invocation adds user-task content, retaining the images and original material.
await notionFixture.setScenario("normal", { kind: "prompt", defaultContext: true });
const promptCandidates = await completeDollarRequest({ version: 1, text: "$ui-a", cursor: 5, cwd: root }, notionConfig);
assert.equal(promptCandidates.items[0]?.kind, "prompt");
assert.equal(promptCandidates.items[0]?.source, "notion");
assert.match(promptCandidates.items[0]!.ref!, /PROMPT.md$/);
const { records: promptCatalog } = await buildDollarRegistry(notionConfig, root);
const prompts = promptCatalog.filter(record => record.kind === "prompt");
assert.notEqual(prompts[0]!.defaultDiscovery, true);
const image = { type: "image" as const, data: "image-bytes" };
let history = [{ role: "user", content: [{ type: "text" as const, text: "$missing@unknownsource $ui-alpha@notion $ui-alpha@notion FIRST_MATERIAL" }, image] }];
const firstPrompt = await invokeForContext({ messages: history }, Promise.resolve([]), notionConfig, Promise.resolve(prompts));
assert.equal(firstPrompt!.messages![0]!.role, "user");
assert.ok(JSON.stringify(firstPrompt).includes("FIRST_MATERIAL"));
assert.ok(JSON.stringify(firstPrompt).includes(canary));
assert.ok(JSON.stringify(firstPrompt).includes("image-bytes"));
assert.equal(firstPrompt!.messages![0]!.content instanceof Array && firstPrompt!.messages![0]!.content[1], image, "Prompt expansion preserves the original image object");
assert.equal(JSON.stringify(firstPrompt).split(canary).length - 1, 1, "Repeated valid refs load and append one Prompt beside an unknown ref");
await notionFixture.setScenario("normal", { kind: "prompt", defaultContext: true, revision: "SECOND_PROMPT_REVISION" });
const secondPrompt = await invokeForContext({ messages: [...firstPrompt!.messages!, { role: "user", content: "$missing@unknownsource $ui-alpha@notion SECOND_MATERIAL" }] }, Promise.resolve([]), notionConfig, Promise.resolve(prompts));
assert.match(String(secondPrompt!.messages!.at(-1)!.content), /SECOND_MATERIAL/);
assert.match(String(secondPrompt!.messages!.at(-1)!.content), new RegExp(canary));
assert.match(String(secondPrompt!.messages!.at(-1)!.content), /SECOND_PROMPT_REVISION/, "the next submission resolves its own Prompt snapshot");
assert.doesNotMatch(JSON.stringify(firstPrompt), /SECOND_PROMPT_REVISION/, "a later revision cannot change the prepared first submission");
assert.notEqual(recordIdentity({ ...prompts[0]!, sourceId: "a:b", sourceScope: "c" }), recordIdentity({ ...prompts[0]!, sourceId: "a", sourceScope: "b:c" }));
assert.notEqual(recordIdentity(prompts[0]!), recordIdentity({ ...prompts[0]!, kind: "router" }));
console.log("Completion behavior passed; fixtures retained: " + root);
