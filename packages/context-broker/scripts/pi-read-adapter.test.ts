import { expect, test } from "bun:test";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import type { ExtensionAPI, ExtensionContext, NativeReadResult, PiReadDefinition } from "../src/types";

function fixture(owner = "builtin", enabled = true) {
  const handlers: Array<(event: never, ctx: ExtensionContext) => unknown> = [];
  const parameters = { type: "object", properties: { path: { type: "string", description: "Path to the file to read (relative or absolute)" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] };
  const calls: unknown[] = [], factories: unknown[] = [];
  const content: NativeReadResult = { content: [{ type: "image", data: "native-image", mimeType: "image/png" }], details: { native: true }, structuredContent: { type: "image", data: "native-image", mimeType: "image/png", note: "native" } };
  const native: PiReadDefinition = { name: "read", label: "read", description: "native", parameters, outputSchema: { type: "string" }, promptSnippet: "native snippet", promptGuidelines: ["native guideline"],
    async execute(id, input, signal, onUpdate, ctx) { calls.push({ id, input, signal, onUpdate, ctx }); onUpdate?.(content); return content; },
    renderCall: (args, theme, context) => ({ args, theme, context }), renderResult: () => "native rendering",
  };
  let current = { ...native, sourceInfo: { source: owner, path: "builtin:read" } };
  const api: ExtensionAPI = {
    on(name, handler) { if (name === "session_start") handlers.push(handler as (event: never, ctx: ExtensionContext) => unknown); },
    getAllTools: () => [current], getActiveTools: () => enabled ? ["read"] : [], getSettings: () => ({ images: { autoResize: false } }),
    registerTool(tool) { if (tool.name === "read") current = { ...tool, sourceInfo: { source: "local", path: "/extension/index.ts" } }; },
  };
  const ctx: ExtensionContext = { cwd: "/current/cwd" }, adapter = createPiHostAdapter(api, async () => (cwd, options) => { factories.push({ cwd, options }); return native; });
  const start = async () => { for (const handler of handlers) await handler({ type: "session_start" } as never, ctx); };
  return { api, adapter, native, content, calls, factories, ctx, start, current: () => current,
    replace() { current = { ...native, parameters: { type: "object", properties: { thirdParty: { type: "string" } } }, sourceInfo: { source: "local", path: "/other/index.ts" } }; } };
}

test("Pi scalar read preserves the public native executor, images, settings and renderers", async () => {
  const f = fixture(), ids: string[] = [];
  const owns = f.adapter.registerReadExecutor!((input, ctx, signal, read, id) => { ids.push(id); return read({ ...input, path: "/resolved/image.png" }, signal); })!;
  await f.start();
  expect(owns()).toBe(true);
  expect(f.factories).toEqual([{ cwd: "/current/cwd", options: { autoResizeImages: false } }]);
  const signal = new AbortController().signal, updates: unknown[] = [];
  const result = await f.current().execute("scalar-id", { path: "image.png", offset: 2, limit: 3 }, signal, value => updates.push(value), f.ctx);
  expect(result).toBe(f.content); expect(updates).toEqual([f.content]); expect(ids).toEqual(["scalar-id"]);
  expect(f.calls[0]).toMatchObject({ id: "scalar-id", input: { path: "/resolved/image.png", offset: 2, limit: 3 }, signal, ctx: f.ctx });
  expect(f.current().renderResult).toBe(f.native.renderResult);
  expect(f.current().promptGuidelines).toEqual(f.native.promptGuidelines);
  expect(f.current().outputSchema).toMatchObject({ anyOf: [f.native.outputSchema, { type: "object" }] });
  f.replace(); expect(owns()).toBe(false);
});

test("Pi batch is one branch of read and retains structured results without entering scalar execution", async () => {
  const f = fixture(), batch = { content: [{ type: "text" as const, text: "batch" }], structuredContent: { status: "ready", files: [] } };
  const ref = "sr:R" + "a".repeat(22);
  f.adapter.registerReadExecutor!(async (input, _ctx, _signal, _read, id) => { expect(input).toEqual({ paths: [ref] }); expect(id).toBe("batch-id"); return batch; });
  await f.start();
  expect(await f.current().execute("batch-id", { paths: [ref] }, undefined, undefined, f.ctx)).toBe(batch);
  expect(f.calls).toHaveLength(0);
  for (const input of [{}, { path: "one", paths: ["two"] }, { paths: ["one"], offset: 2 }, { paths: "one" }]) {
    await expect(f.current().execute("invalid", input, undefined, undefined, f.ctx)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  }
  expect(f.current().renderCall?.({ paths: ["one", "two"] }, {}, {})).toMatchObject({ args: { path: "one, two" } });
  expect(f.current().parameters).toMatchObject({ type: "object", properties: { paths: { type: "array", minItems: 1, maxItems: 16 } } });
  expect(f.current().parameters.required ?? []).not.toContain("path");
});

test("Pi read advertises an object schema without provider-rejected top-level combinators", async () => {
  const f = fixture();
  f.adapter.registerReadExecutor!((_input, _ctx, _signal, read) => read({ path: "unused" }));
  await f.start();
  const schema = f.current().parameters;
  expect(schema.type).toBe("object");
  // The actual provider rejects these root keywords before invoking any tool.
  expect(Object.keys(schema).filter(key => ["oneOf", "anyOf", "allOf", "enum", "const", "not"].includes(key))).toEqual([]);
  expect(schema.properties).toHaveProperty("path");
  expect(schema.properties).toHaveProperty("paths");
});

test("AH639 public batch read preserves the three issued refs and explicit read-only policy", async () => {
  const f = fixture(), calls: unknown[] = [];
  const paths = ["sr:RouocPFZv5M2VY1whhsEmpw", "sr:RTewfftdPpctkYChWg0myJA", "sr:R6LBduFSn5Pij6sdLTsoEZg"];
  const batch = { content: [{ type: "text" as const, text: "batch" }] };
  f.adapter.registerReadExecutor!(async (input, _ctx, _signal, _read, id) => { calls.push({ id, input }); return batch; });
  await f.start();
  expect(f.current().parameters).toMatchObject({ properties: { paths: { type: "array" }, readOnly: { type: "boolean" } } });
  const id = "call-56bb786b-68ea-44cc-af6a-8b9ce087776b-3__rk16__T8Q_3Wz_5W-D8F5y";
  for (const readOnly of [true, false]) {
    expect(await f.current().execute(id, { paths, readOnly }, undefined, undefined, f.ctx)).toBe(batch);
    expect(calls.at(-1)).toEqual({ id, input: { paths, readOnly } });
  }
  expect(calls).toHaveLength(2); expect(f.calls).toHaveLength(0);
});

test("Pi read rejects invalid scalar and batch arguments before shared preparation or native I/O", async () => {
  const f = fixture(), ref = "sr:R" + "a".repeat(22);
  let preparations = 0;
  f.adapter.registerReadExecutor!((input, _ctx, signal, read) => { preparations++; return read(input, signal); });
  await f.start();
  for (const input of [
    {}, { path: "one", paths: [ref] }, { path: undefined }, { path: null }, { path: 7 },
    { path: "one", offset: "2" }, { path: "one", limit: null }, { path: "one", offset: Number.NaN },
    { path: "one", limit: Number.POSITIVE_INFINITY }, { paths: "one" }, { paths: [] },
    { paths: [null] }, { paths: [7] }, { paths: [""] }, { paths: ["references/one.md"] },
    { paths: ["sr:R"] }, { paths: ["sr:C" + "a".repeat(22)] }, { paths: [ref], offset: 2 },
    { paths: [ref], limit: 3 }, { paths: [ref], extra: true }, { paths: Array.from({ length: 17 }, () => ref) },
    { paths: [ref], readOnly: "true" }, { paths: [ref], readOnly: null }, { paths: [ref], readOnly: 1 },
  ]) {
    await expect(f.current().execute("invalid", input, undefined, undefined, f.ctx)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  }
  expect(preparations).toBe(0); expect(f.calls).toHaveLength(0);
});

test("Pi resource schema distinguishes complete issued handles from category prefixes", async () => {
  const f = fixture();
  f.adapter.registerReadExecutor!((_input, _ctx, _signal, read) => read({ path: "unused" }));
  await f.start();
  const schema = f.current().parameters as { properties: { paths: { items: { pattern: string } } } };
  const accepts = new RegExp(schema.properties.paths.items.pattern);
  expect(accepts.test("sr:R" + "a".repeat(22))).toBe(true);
  expect(accepts.test("skill://notion/owner?file=references/example.md&snapshot=s_fixed")).toBe(true);
  for (const value of ["sr:R", "sr:S", "sr:C" + "a".repeat(22), "sr:R" + "a".repeat(21), "sr:R" + "a".repeat(23), "references/example.md"]) {
    expect(accepts.test(value)).toBe(false);
  }
});

test("Pi scalar read advertises issued Skill refs without changing the native definition", async () => {
  const f = fixture(), before = JSON.stringify(f.native.parameters);
  f.adapter.registerReadExecutor!((_input, _ctx, _signal, read) => read({ path: "unused" }));
  await f.start();
  const schema = f.current().parameters as { properties: { path: { description: string } } };
  expect(schema.properties.path.description).toContain("relative or absolute");
  expect(schema.properties.path.description).toContain("skill://");
  expect(schema.properties.path.description).toContain("sr:");
  expect(schema.properties.path.description).toContain("verbatim");
  expect(f.current().description).toStartWith("For Notion introductions, summaries or inspection,");
  expect(f.current().description).toContain("without loading Requires or activating its workflow");
  expect(JSON.stringify(f.native.parameters)).toBe(before);
});

test("Pi preserves disabled read and never replaces a third-party read", async () => {
  const disabled = fixture("builtin", false);
  disabled.adapter.registerReadExecutor!((_input, _ctx, _signal, read) => read({ path: "unused" })); await disabled.start();
  expect(disabled.current().defaultActive).toBe(false);
  const thirdParty = fixture("local"), owns = thirdParty.adapter.registerReadExecutor!((_input, _ctx, _signal, read) => read({ path: "unused" }))!;
  await thirdParty.start();
  expect(owns()).toBe(false); expect(thirdParty.factories).toHaveLength(0); expect(thirdParty.current().parameters).toBe(thirdParty.native.parameters);
});
