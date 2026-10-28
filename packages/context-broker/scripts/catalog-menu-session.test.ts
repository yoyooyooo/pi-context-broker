import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createNotionFixture } from "../../../scripts/notion-integration-fixture.mjs";
import type { AutocompleteProvider, ExtensionAPI, ExtensionContext } from "../src/types";

const entry = process.env.CONTEXT_BROKER_SESSION_TEST_ENTRY ?? resolve(import.meta.dirname, "../src/index.ts");
const { default: contextBroker, buildDiscoveryRegistry } = await import(pathToFileURL(entry).href);
const { buildDollarRegistryForContext } = await import(pathToFileURL(join(dirname(entry), "dollar.ts")).href);
const root = await mkdtemp(join(tmpdir(), "broker-menu-session-"));
const environmentKeys = ["CONTEXT_BROKER_CONFIG", "CONTEXT_BROKER_ROOTS", "CONTEXT_BROKER_EXTRA_ROOTS", "CONTEXT_BROKER_DISCOVERY_CATALOGS", "CONTEXT_BROKER_EXTRA_DISCOVERY_CATALOGS", "CONTEXT_BROKER_HOST"];
const previous = new Map(environmentKeys.map(key => [key, process.env[key]]));
const sockets = new Set<Socket>();
const connected = Promise.withResolvers<void>();
const server = createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); connected.resolve(); });
let releaseRefresh = () => {};
try {
  const fixture = await createNotionFixture(join(root, "fixture"));
  await fixture.setScenario("normal", { cacheIdentity: true, defaultContext: false, catalogAgeMs: 120_000 });
  const source = { id: "notion", type: "notion", command: fixture.command, cacheDir: join(root, "cache") };
  await buildDiscoveryRegistry({ skillRoots: [], sources: [source] }, root);
  await fixture.setScenario("normal", { cacheIdentity: true, defaultContext: false, alias: "refreshed-skill" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const wire = join(root, "catalog-wire.mjs");
  await writeFile(wire, `
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
const args = process.argv.slice(2);
if (args[0] === "list" && !args.includes("--default-view") && !args.includes("--view")) {
  const socket = connect(${address.port}, "127.0.0.1");
  await once(socket, "data");
  socket.end();
}
const command = ${JSON.stringify(fixture.command)};
const result = spawnSync(command[0], [...command.slice(1), ...args], { encoding: "utf8" });
process.stdout.write(result.stdout ?? "");
process.exitCode = result.status ?? 1;
`);
  releaseRefresh = () => { for (const socket of sockets) socket.end("release"); };
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ skillRoots: [], sources: [{ ...source, command: [process.execPath, wire] }] }));
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
  const first = new Proxy<ExtensionContext>({ cwd: root, ui, getSystemPrompt: () => firstPrompt }, {
    get(target, key, receiver) { if (retired) throw new Error("This extension ctx is stale after session replacement or reload."); return Reflect.get(target, key, receiver); },
  });
  const next: ExtensionContext = { cwd: root, ui, getSystemPrompt: () => nextPrompt };
  const api: ExtensionAPI = { on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler as (event: never, ctx: ExtensionContext) => unknown]); } };
  const emit = async (name: string, ctx: ExtensionContext) => {
    for (const listener of listeners.get(name) ?? []) await listener({ type: name } as never, ctx);
  };
  await contextBroker(api);
  await emit("session_start", first);
  await connected.promise;
  const provider = providers[0]!;
  const initial = await provider.getSuggestions(["$"], 0, 1);
  assert.ok(initial?.items.some(item => item.value === "$ui-alpha@notion"));
  await emit("session_before_switch", first);
  assert.ok((await provider.getSuggestions(["$"], 0, 1))?.items.some(item => item.value === "$native-first"), "A cancelled switch retains the active menu context");
  const refreshing = Promise.withResolvers<void>();
  const oldMenu = provider.getSuggestions(["$"], 0, 1, undefined, () => refreshing.resolve());
  await refreshing.promise;
  await emit("session_before_switch", first);
  retired = true;
  await emit("session_switch", next);
  await emit("session_start", next);
  releaseRefresh();
  const completed = await oldMenu;
  assert.ok(completed?.items.some(item => item.value === "$refreshed-skill@notion"));
  assert.ok(completed?.items.some(item => item.value === "$native-first"));
  assert.ok(!completed?.items.some(item => item.value === "$native-next"), "An old menu retains its own prompt snapshot");
  const replacement = await provider.getSuggestions(["$"], 0, 1);
  assert.ok(replacement?.items.some(item => item.value === "$native-next"), "A retained provider reads the current session");
  assert.ok(!replacement?.items.some(item => item.value === "$native-first"));
  assert.equal(notices.length, 0);
  await emit("session_shutdown", next);
  const registry = Promise.withResolvers<[]>();
  let helperRetired = false;
  const merged = buildDollarRegistryForContext({ getSystemPrompt() { if (helperRetired) throw new Error("stale helper ctx"); return nextPrompt; } }, registry.promise);
  helperRetired = true;
  registry.resolve([]);
  assert.deepEqual((await merged).map((record: { name: string }) => record.name), ["native-next"]);
  console.log("catalog session checks passed: delayed refresh survives context retirement; old menu stays pinned; retained provider uses the replacement session");
} finally {
  releaseRefresh();
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  console.log(`Catalog session artifacts retained: ${root}`);
}
