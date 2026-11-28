import { expect, test, setSystemTime } from "bun:test";
import { presentPiAuthorization } from "../src/pi-authorization";
import type { ExtensionContext, ExtensionWidgetComponent } from "../src/types";

function foreground() {
  let component: ExtensionWidgetComponent | undefined;
  let presentations = 0;
  const ctx: ExtensionContext = { hasUI: true, mode: "tui", ui: {
    custom<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => ExtensionWidgetComponent): Promise<T> {
      presentations++;
      return new Promise(resolve => {
        component = factory({ requestRender() {} }, {}, {}, resolve);
      });
    },
  } };
  return { ctx, presentations: () => presentations, component: () => {
    if (!component) throw new Error("Expected authorization presentation");
    return component;
  } };
}
const url = "https://mcp.notion.com/authorize?state=PRIVATE_STATE&code_challenge=PRIVATE_CHALLENGE";

test("foreground authorization opens the system-browser boundary once and closes when its core waiter finishes", async () => {
  const ui = foreground(), controller = new AbortController();
  const opened: string[] = [];
  const operation = presentPiAuthorization({ url, signal: controller.signal, deadline: Date.now() + 1000 }, ui.ctx,
    async value => { opened.push(value); });
  await Promise.resolve();
  expect(opened).toEqual([url]);
  const rendered = ui.component().render(80).join("\n");
  expect(rendered).toContain("mcp.notion.com");
  expect(rendered).not.toContain("PRIVATE_STATE");
  expect(rendered).not.toContain("PRIVATE_CHALLENGE");
  controller.abort();
  await operation;
  ui.component().dispose?.();
  expect(opened).toHaveLength(1);
});

test("Esc rejects only its authorization waiter and closes its browser operation", async () => {
  const one = foreground(), two = foreground(), first = new AbortController(), second = new AbortController();
  const pending = presentPiAuthorization({ url, signal: first.signal, deadline: Date.now() + 1000 }, one.ctx, async () => {});
  const other = presentPiAuthorization({ url, signal: second.signal, deadline: Date.now() + 1000 }, two.ctx, async () => {});
  const rejected = pending.then(() => undefined, error => error);
  one.component().handleInput?.("\u001b");
  expect(await rejected).toMatchObject({ code: "MCP_AUTH_CANCELLED" });
  expect(first.signal.aborted).toBe(false);
  expect(second.signal.aborted).toBe(false);
  second.abort();
  await other;
});

test("headless and non-TUI modes do not present authorization or open a browser", async () => {
  for (const mode of ["rpc", "print", "json"] as const) {
    const ui = foreground(), calls: string[] = [];
    await expect(presentPiAuthorization({ url, signal: new AbortController().signal, deadline: Date.now() + 1000 },
      { ...ui.ctx, mode }, async value => { calls.push(value); })).rejects.toMatchObject({ code: "MCP_AUTH_INTERACTION_REQUIRED" });
    expect(calls).toEqual([]); expect(ui.presentations()).toBe(0);
  }
  await expect(presentPiAuthorization({ url, signal: new AbortController().signal, deadline: Date.now() + 1000 },
    { hasUI: false, mode: "tui" }, async () => { throw new Error("Must not open"); }))
    .rejects.toMatchObject({ code: "MCP_AUTH_INTERACTION_REQUIRED" });
});

test("retired, expired and unsafe presentations perform no browser side effect", async () => {
  const ui = foreground(), controller = new AbortController(), calls: string[] = [];
  const open = async (value: string) => { calls.push(value); };
  controller.abort();
  await presentPiAuthorization({ url, signal: controller.signal, deadline: Date.now() + 1000 }, ui.ctx, open);
  await expect(presentPiAuthorization({ url, signal: new AbortController().signal, deadline: Date.now() - 1 }, ui.ctx, open))
    .rejects.toMatchObject({ code: "MCP_AUTH_TIMEOUT" });
  for (const unsafe of ["javascript:alert(1)", "http://mcp.notion.com/authorize", "https://secret@mcp.notion.com/authorize"])
    await expect(presentPiAuthorization({ url: unsafe, signal: new AbortController().signal, deadline: Date.now() + 1000 }, ui.ctx, open))
      .rejects.toMatchObject({ code: "MCP_AUTH_URL_INVALID" });
  expect(calls).toEqual([]); expect(ui.presentations()).toBe(0);
});

test("a deadline that passes while custom UI installs blocks the browser before the timer fires", async () => {
  const ui = foreground(), controller = new AbortController(), calls: string[] = [];
  const now = Date.now();
  try {
    const operation = presentPiAuthorization({ url, signal: controller.signal, deadline: now + 1000 }, ui.ctx,
      async value => { calls.push(value); });
    const rejected = operation.then(() => undefined, error => error);
    setSystemTime(now + 1001);
    expect(await rejected).toMatchObject({ code: "MCP_AUTH_TIMEOUT" });
    expect(calls).toEqual([]);
  } finally { controller.abort(); setSystemTime(); }
});

test("browser failures are local codes and never expose process diagnostics", async () => {
  const ui = foreground();
  const operation = presentPiAuthorization({ url, signal: new AbortController().signal, deadline: Date.now() + 1000 }, ui.ctx,
    async () => { throw new Error("PRIVATE_TOKEN PRIVATE_VERIFIER"); });
  await expect(operation).rejects.toMatchObject({ code: "MCP_AUTH_BROWSER_UNAVAILABLE", message: "MCP_AUTH_BROWSER_UNAVAILABLE" });
});
