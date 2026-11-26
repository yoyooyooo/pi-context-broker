import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { currentNotionFixture } from "./fixtures/current-notion-source";
import type { AutocompleteProvider, ExtensionAPI, ExtensionContext, NativeSkillSearchDefinition } from "../src/types";

async function within<T>(pending: Promise<T>, description: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Timed out: " + description)), 5_000);
    })]);
  } finally { clearTimeout(timeout); }
}

const fixture = await currentNotionFixture("skill", { name: "ui-alpha" });
const root = fixture.root;
const { default: contextBroker }: typeof import("../src/index") = await import(pathToFileURL(join(root, "src/index.ts")).href);
const { buildDollarRegistryForContext }: typeof import("../src/dollar") = await import(pathToFileURL(join(root, "src/dollar.ts")).href);
const environmentKeys = ["CONTEXT_BROKER_CONFIG", "CONTEXT_BROKER_ROOTS", "CONTEXT_BROKER_EXTRA_ROOTS", "CONTEXT_BROKER_DISCOVERY_CATALOGS", "CONTEXT_BROKER_EXTRA_DISCOVERY_CATALOGS", "CONTEXT_BROKER_HOST"];
const previous = new Map(environmentKeys.map(key => [key, process.env[key]]));
const refreshEntered = Promise.withResolvers<AbortSignal>();
const releaseRefresh = Promise.withResolvers<void>();
const shutdownEntered = Promise.withResolvers<AbortSignal>();
const shutdownAborted = Promise.withResolvers<void>();
const releaseShutdownSettlement = Promise.withResolvers<void>();
let closeSession = async () => {};
try {
  const publishCatalog = (name: string, stale: boolean) => {
    fixture.state.catalog = { ...fixture.state.catalog, records: [{ ...fixture.record, name, alias: name }],
      freshness: { policy: "max_age", validated_at: new Date().toISOString(), age_ms: stale ? 120_000 : 0, max_age_ms: 1_000, stale } };
    fixture.state.directory = { ...fixture.state.catalog, records: [], count: 0, view: null, view_selection: "none" };
  };
  publishCatalog("ui-alpha", true);
  const list = fixture.state.list.bind(fixture.state);
  let requests = 0;
  fixture.state.list = async options => {
    assert.ok(options.signal, "Every owned SDK catalogue operation receives a cancellation signal");
    if (++requests > 1) {
      refreshEntered.resolve(options.signal);
      await releaseRefresh.promise;
      options.signal.throwIfAborted();
    }
    return list(options);
  };
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ skillRoots: [], sources: [fixture.source] }));
  for (const key of environmentKeys) delete process.env[key];
  process.env.CONTEXT_BROKER_CONFIG = config;
  process.env.CONTEXT_BROKER_HOST = "pi";
  const nativePrompt = async (name: string) => {
    const directory = join(root, name);
    await mkdir(directory);
    const path = join(directory, "SKILL.md");
    await writeFile(path, `---\nname: ${name}\ndescription: Native ${name}\n---\nNative body\n`);
    return `<skill><name>${name}</name><description>Native ${name}</description><location>${path}</location></skill>`;
  };
  const firstPrompt = await nativePrompt("native-first");
  const nextPrompt = await nativePrompt("native-next");
  const listeners = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  const providers: AutocompleteProvider[] = [];
  const notices: string[] = [];
  const current: AutocompleteProvider = { async getSuggestions() { return null; }, applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }) };
  const ui = { addAutocompleteProvider(factory: (provider: AutocompleteProvider) => AutocompleteProvider) { providers.push(factory(current)); }, notify(message: string) { notices.push(message); } };
  let retired = false;
  let retiredReads = 0;
  const first = new Proxy<ExtensionContext>({ cwd: root, ui, getSystemPrompt: () => firstPrompt }, {
    get(target, key, receiver) { if (retired) { retiredReads++; throw new Error("This extension ctx is stale after session replacement or reload."); } return Reflect.get(target, key, receiver); },
  });
  const next: ExtensionContext = { cwd: root, ui, getSystemPrompt: () => nextPrompt };
  let metadataTool: NativeSkillSearchDefinition | undefined;
  const api: ExtensionAPI = { on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler as (event: never, ctx: ExtensionContext) => unknown]); },
    registerTool(tool) { if (tool.name === "notion_list") metadataTool = tool; } };
  const emit = async (name: string, ctx: ExtensionContext) => {
    for (const listener of listeners.get(name) ?? []) await listener({ type: name } as never, ctx);
  };
  closeSession = () => within(emit("session_shutdown", next), "session cleanup");
  await contextBroker(api);
  assert.ok(metadataTool);
  // Registration alone performs no selection or directory I/O. An explicit tool
  // invocation now selects the current Library, so start the real session first.
  assert.deepEqual(fixture.calls, [], "Pi registration must not query a directory before its first session context");
  await emit("session_start", first);
  await within(refreshEntered.promise, "SDK catalogue refresh");
  assert.equal(providers.length, 1);
  const provider = providers[0]!;
  const initial = await provider.getSuggestions(["$"], 0, 1);
  assert.ok(initial?.items.some(item => item.value === "$ui-alpha@notion"));
  await emit("session_before_switch", first);
  assert.ok((await provider.getSuggestions(["$"], 0, 1))?.items.some(item => item.value === "$native-first"), "A cancelled switch retains the active menu context");
  const refreshing = Promise.withResolvers<void>();
  const oldMenu = provider.getSuggestions(["$"], 0, 1, undefined, () => refreshing.resolve());
  await within(refreshing.promise, "old menu partial delivery");
  await emit("session_before_switch", first);
  retired = true;
  await emit("session_switch", next);
  await emit("session_start", next);
  publishCatalog("refreshed-skill", false);
  releaseRefresh.resolve();
  const completed = await within(oldMenu, "old menu refresh");
  assert.ok(completed?.items.some(item => item.value === "$refreshed-skill@notion"));
  assert.ok(completed?.items.some(item => item.value === "$native-first"));
  assert.ok(!completed?.items.some(item => item.value === "$native-next"), "An old menu retains its own prompt snapshot");
  assert.equal(providers.length, 1, "The same editor retains its provider across sessions");
  const replacement = await provider.getSuggestions(["$"], 0, 1);
  assert.ok(replacement?.items.some(item => item.value === "$native-next"), "A retained provider reads the current session");
  assert.ok(!replacement?.items.some(item => item.value === "$native-first"));
  assert.deepEqual(notices, [], "Delayed refresh must not read or notify the retired context");
  await closeSession();
  assert.equal(retiredReads, 0, "Delayed work must never dereference a retired context, even if its error would be caught");
  const registry = Promise.withResolvers<[]>();
  let helperRetired = false;
  const merged = buildDollarRegistryForContext({ getSystemPrompt() { if (helperRetired) throw new Error("stale helper ctx"); return nextPrompt; } }, registry.promise);
  helperRetired = true;
  registry.resolve([]);
  assert.deepEqual((await merged).map(record => record.name), ["native-next"]);

  await writeFile(config, JSON.stringify({ skillRoots: [], sources: [{ ...fixture.source, cacheDir: join(root, "shutdown-cache") }] }));
  listeners.clear();
  let sdkSettled = false;
  const sdkSettlement = Promise.withResolvers<void>();
  fixture.state.list = async options => {
    assert.ok(options.signal, "Pending SDK operations must remain owned by the session");
    const signal = options.signal;
    const observeAbort = () => shutdownAborted.resolve();
    signal.addEventListener("abort", observeAbort, { once: true });
    if (signal.aborted) observeAbort();
    shutdownEntered.resolve(signal);
    try {
      await shutdownAborted.promise;
      // The signal is observed before SDK cleanup completes. Cleanup may stall,
      // so it cannot own the user's session shutdown.
      await releaseShutdownSettlement.promise;
      signal.throwIfAborted();
      return list(options);
    } finally {
      signal.removeEventListener("abort", observeAbort);
      sdkSettled = true;
      sdkSettlement.resolve();
    }
  };
  await contextBroker(api);
  await emit("session_start", next);
  const shutdownSignal = await within(shutdownEntered.promise, "owned SDK catalogue request");
  assert.equal(shutdownSignal.aborted, false);
  assert.equal(sdkSettled, false);
  let shutdownReturned = false;
  const closing = emit("session_shutdown", next).then(() => { shutdownReturned = true; });
  await within(shutdownAborted.promise, "SDK cancellation");
  await within(closing, "nonblocking session shutdown");
  assert.equal(shutdownSignal.aborted, true);
  assert.equal(shutdownReturned, true, "Shutdown cannot wait for SDK cleanup after cancelling its catalogue operation");
  assert.equal(sdkSettled, false);
  releaseShutdownSettlement.resolve();
  await within(sdkSettlement.promise, "cancelled SDK settlement");
  assert.equal(sdkSettled, true, "Owned SDK cleanup still settles independently after shutdown");
  assert.deepEqual(notices, [], "A cancelled catalogue must not notify a retired session");
  const callsAfterShutdown = fixture.calls.length;
  assert.equal(await providers.at(-1)!.getSuggestions(["$"], 0, 1), null, "The retired menu cannot restart catalogue discovery");
  assert.equal(fixture.calls.length, callsAfterShutdown, "A retired provider must not start another SDK operation");
  console.log("catalog session checks passed: current paired SDK metadata; delayed refresh survives context retirement; old menu stays pinned; retained provider uses the replacement session; shutdown cancels without joining SDK settlement");
} finally {
  releaseRefresh.resolve();
  shutdownAborted.resolve();
  releaseShutdownSettlement.resolve();
  try { await closeSession(); }
  finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    console.log(`Catalog session artifacts retained: ${root}`);
  }
}
