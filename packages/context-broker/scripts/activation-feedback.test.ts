import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { ACTIVATION_MESSAGE, createActivationFeedback } from "../src/activation-feedback";
import type { AgentMessage, ExtensionAPI, ExtensionContext, ExtensionWidgetComponent, SessionEntry, SkillRecord } from "../src/types";

class Text {
  constructor(readonly text: string, _x: number, _y: number, readonly background?: (text: string) => string) {}
  render() { return this.text.split("\n").map(line => this.background?.(line) ?? line); }
  invalidate() {}
}
const record: SkillRecord = { name: "reframe", description: "Reframe the task", path: "/selected/SKILL.md", source: "notion", sourceId: "notion", token: "reframe", body: "Selected instructions", versionId: "v1", snapshotId: "snapshot-1" };
const source = { type: "notion" as const, id: "notion", preparation: { maxNodes: 8, maxDepth: 4, maxInstructionBytes: 8192, maxContextBytes: 131072 } };
type Message = Parameters<NonNullable<ExtensionAPI["sendMessage"]>>[0];
type Renderer = Parameters<NonNullable<ExtensionAPI["registerMessageRenderer"]>>[1];
type EntryRenderer = Parameters<NonNullable<ExtensionAPI["registerEntryRenderer"]>>[1];
async function fixture(presentation: "entry" | "message" = "entry") {
  const messages: Message[] = [], entries: SessionEntry[] = [];
  const widgets: unknown[] = [], backgrounds: string[] = [];
  const theme = { fg: (_color: string, value: string) => value, bg(color: string, value: string) { backgrounds.push(color); return value; } };
  let renderer: Renderer | undefined, entryRenderer: EntryRenderer | undefined, session = "session-one", branch: SessionEntry[] = [];
  const api: ExtensionAPI & { pi: { Text: typeof Text } } = {
    pi: { Text }, on() {},
    registerMessageRenderer(type, value) { expect(type).toBe(ACTIVATION_MESSAGE); renderer = value; },
    registerEntryRenderer(type, value) { expect(type).toBe(ACTIVATION_MESSAGE); entryRenderer = value; },
    sendMessage(message, options) { expect(options).toEqual({ triggerTurn: false }); messages.push(message); },
    appendEntry(customType, data) { const entry = { type: "custom", customType, data }; entries.push(entry); branch.push(entry); },
  };
  const ctx: ExtensionContext = {
    hasUI: true, mode: "tui", ui: { setWidget(...args) { widgets.push(args); } },
    sessionManager: { getSessionId: () => session, getBranch: () => branch },
  };
  const feedback = await createActivationFeedback(api, () => {}, presentation);
  const visible = (component: ExtensionWidgetComponent | undefined) => stripVTControlCharacters(component?.render(160).join("\n") ?? "");
  const rows = () => entries.filter(entry => entry.customType === ACTIVATION_MESSAGE);
  const options = (expanded: boolean) => ({ expanded, keyText(action: string) { expect(action).toBe("app.tools.expand"); return "alt+o"; } });
  const component = (expanded = false, index = 0) => {
    if (presentation === "message") {
      const message = messages[index]; if (!message || !renderer) throw new Error("Expected a rendered preparation message");
      return renderer({ ...message, role: "custom", timestamp: 0 } satisfies AgentMessage, options(expanded), theme);
    }
    const entry = rows()[index]; if (!entry || !entryRenderer) throw new Error("Expected a rendered preparation entry");
    return entryRenderer(entry, options(expanded), theme);
  };
  return { api, ctx, feedback, widgets, backgrounds, entries, messages, rows, component, visible,
    switchSession() { session = "session-two"; branch = []; },
    render(expanded = false, index = 0) { return visible(component(expanded, index)); },
  };
}

test("Pi preparation immediately appends one expandable transcript entry and updates that row through delivery", async () => {
  const f = await fixture();
  const finish = f.feedback.begin([record, { ...record, name: "sharpen", token: "sharpen" }], f.ctx, "use", source);
  const row = f.component();
  expect(f.rows()).toHaveLength(1);
  expect(f.visible(row)).toBe("[skill@notion] reframe, sharpen · loading… (alt+o to expand)");
  expect(f.visible(row)).not.toContain("bytes");
  expect(f.backgrounds).toContain("toolPendingBg");
  expect(f.widgets).toEqual([]);
  expect(f.messages).toEqual([]);
  finish?.({ value: record });
  expect(f.rows()).toHaveLength(1);
  expect(f.visible(row)).toBe("[skill@notion] reframe, sharpen · ready (alt+o to expand)");
  expect(f.render(true)).toContain("Limits: up to 8 nodes, depth 4, 8192 instruction bytes, 131072 context bytes.");
  expect(f.render(true)).toContain("Snapshot: snapshot-1");
  expect(f.render(true)).not.toContain("to expand");
  f.feedback.confirmPrepared(f.ctx);
  expect(f.visible(row)).toBe("[skill@notion] reframe, sharpen · loaded (alt+o to expand)");
  expect(f.backgrounds).toContain("toolSuccessBg");
  expect(f.rows()).toHaveLength(1);
  expect(f.widgets).toEqual([]);
  expect(f.messages).toEqual([]);
  f.feedback.restore(f.ctx);
  expect(f.render()).toContain(" · loaded");
});

test("unavailable preparation remains one warning row and never claims loaded", async () => {
  const f = await fixture();
  const finish = f.feedback.begin(record, f.ctx, "use", source);
  finish?.({ error: "CURRENT_SOURCE_NOT_READY" });
  expect(f.feedback.failPending(f.ctx, "CURRENT_SOURCE_NOT_READY; continuing without this Skill.")).toBe(true);
  expect(f.rows()).toHaveLength(1);
  expect(f.render()).toBe("[skill@notion] reframe · unavailable (alt+o to expand)");
  expect(f.render(true)).toContain("CURRENT_SOURCE_NOT_READY");
  expect(f.render()).not.toContain("loaded");
  expect(f.widgets).toEqual([]);
  expect(f.messages).toEqual([]);
  f.feedback.confirmPrepared(f.ctx);
  expect(f.render()).toContain(" · unavailable");
});

test("a non-cooperative acquisition cannot leave loading or later publish success after warning", async () => {
  const f = await fixture();
  const finish = f.feedback.begin(record, f.ctx, "use", source);
  expect(f.feedback.failPending(f.ctx, "SOURCE_PREPARATION_TIMEOUT")).toBe(true);
  expect(f.widgets).toEqual([]);
  finish?.({ value: record });
  f.feedback.confirmPrepared(f.ctx);
  expect(f.rows()).toHaveLength(1);
  expect(f.messages).toEqual([]);
  expect(f.render()).toContain(" · unavailable");
  expect(f.render(true)).toContain("SOURCE_PREPARATION_TIMEOUT");
});

test("Stop leaves a cancelled transcript row and retires a late result", async () => {
  const f = await fixture();
  const cancelled = f.feedback.begin(record, f.ctx, "use", source);
  f.feedback.clearPending(f.ctx);
  const count = f.entries.length;
  cancelled?.({ value: record });
  expect(f.entries).toHaveLength(count);
  expect(f.rows()).toHaveLength(1);
  expect(f.render()).toContain(" · cancelled");
  expect(f.widgets).toEqual([]); expect(f.messages).toEqual([]);
});

test("session replacement cannot recover another branch's result or accept its late producer", async () => {
  const f = await fixture();
  f.feedback.begin(record, f.ctx, "use", source)?.({ value: record });
  f.feedback.confirmPrepared(f.ctx);
  const replaced = f.feedback.begin(record, f.ctx, "use", source);
  const count = f.entries.length;
  f.switchSession(); f.feedback.restore(f.ctx);
  replaced?.({ value: record });
  expect(f.entries).toHaveLength(count);
  expect(f.render()).not.toContain(" · loaded");
  expect(f.render(true, 1)).toContain("Interrupted before Skill preparation completed.");
  expect(f.widgets).toEqual([]); expect(f.messages).toEqual([]);
});

test("inspection reports read, and missing optional UI never rejects preparation", async () => {
  const f = await fixture();
  f.feedback.begin(record, f.ctx, "inspect", source)?.({ value: record });
  expect(f.render()).toContain(" · read");
  const api: ExtensionAPI = { pi: { Text }, on() {}, registerEntryRenderer() { throw new Error("renderer unavailable"); }, appendEntry() { throw new Error("session UI unavailable"); } };
  const feedback = await createActivationFeedback(api, () => { throw new Error("render unavailable"); }, "entry");
  const ctx: ExtensionContext = { hasUI: true, ui: { setWidget() { throw new Error("widget unavailable"); } } };
  expect(() => feedback.begin(record, ctx, "use", source)?.({ value: record })).not.toThrow();
  expect(() => feedback.failPending(ctx, "SOURCE_PREPARATION_TIMEOUT")).not.toThrow();
});

test("entry presentation never falls back to a fixed widget or a queued model message", async () => {
  const f = await fixture();
  delete f.api.registerEntryRenderer;
  expect(f.feedback.begin(record, f.ctx, "use", source)).toBeUndefined();
  expect(f.entries).toEqual([]);
  expect(f.messages).toEqual([]);
  expect(f.widgets).toEqual([]);
});

test("existing custom-message records retain their display and final state on restore", async () => {
  const f = await fixture("message");
  f.feedback.begin(record, f.ctx, "use", source)?.({ value: record });
  f.feedback.confirmPrepared(f.ctx);
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0]?.content).toEqual([]);
  expect(f.rows()).toEqual([]);
  f.feedback.restore(f.ctx);
  expect(f.render()).toContain(" · loaded");
  expect(f.widgets).toEqual([]);
});
