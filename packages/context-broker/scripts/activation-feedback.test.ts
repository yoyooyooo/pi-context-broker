import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { ACTIVATION_MESSAGE, createActivationFeedback } from "../src/activation-feedback";
import type { AgentMessage, ExtensionAPI, ExtensionContext, ExtensionWidgetComponent, ExtensionWidgetFactory, SessionEntry, SkillRecord } from "../src/types";

class Text {
  constructor(readonly text: string) {}
  render() { return this.text.split("\n"); }
  invalidate() {}
}
const theme = { fg: (_color: string, value: string) => value };
const record: SkillRecord = { name: "reframe", description: "Reframe the task", path: "/selected/SKILL.md", source: "notion", sourceId: "notion", token: "reframe", body: "Selected instructions", versionId: "v1", snapshotId: "snapshot-1" };
const source = { type: "notion" as const, id: "notion", preparation: { maxNodes: 8, maxDepth: 4, maxInstructionBytes: 8192, maxContextBytes: 131072 } };
type Message = Parameters<NonNullable<ExtensionAPI["sendMessage"]>>[0];
type Renderer = Parameters<NonNullable<ExtensionAPI["registerMessageRenderer"]>>[1];
async function fixture() {
  const messages: Message[] = [], entries: SessionEntry[] = [];
  const widgets = new Map<string, string[] | ExtensionWidgetFactory>();
  let renderer: Renderer | undefined, session = "session-one";
  const api: ExtensionAPI & { pi: { Text: typeof Text } } = {
    pi: { Text }, on() {},
    registerMessageRenderer(type, value) { expect(type).toBe(ACTIVATION_MESSAGE); renderer = value; },
    sendMessage(message, options) { expect(options).toEqual({ triggerTurn: false }); messages.push(message); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  };
  const ctx: ExtensionContext = {
    hasUI: true, mode: "tui", ui: { setWidget(key, content) { if (content === undefined) widgets.delete(key); else widgets.set(key, content); } },
    sessionManager: { getSessionId: () => session, getBranch: () => entries },
  };
  const feedback = await createActivationFeedback(api, () => {}, "widget");
  const visible = (component: ExtensionWidgetComponent | undefined) => stripVTControlCharacters(component?.render(160).join("\n") ?? "");
  return { api, ctx, feedback, widgets, entries, messages, switchSession() { session = "session-two"; },
    widget() { return [...widgets.values()].map(content => typeof content === "function"
      ? visible(content({ requestRender() {} }, theme)) : stripVTControlCharacters(content.join("\n"))).join("\n"); },
    render(expanded = false, index = 0) {
      const message = messages[index]; if (!message || !renderer) throw new Error("Expected a rendered preparation message");
      return visible(renderer({ ...message, role: "custom", timestamp: 0 } satisfies AgentMessage, {
        expanded, keyText(action) { expect(action).toBe("app.tools.expand"); return "alt+o"; },
      }, theme));
    },
  };
}

test("Pi preparation stays compact while loading, then exposes details through the host expand key", async () => {
  const f = await fixture();
  const finish = f.feedback.begin([record, { ...record, name: "sharpen", token: "sharpen" }], f.ctx, "use", source);
  expect(f.widget()).toBe("[skill@notion] reframe, sharpen · loading…");
  expect(f.widget()).not.toContain("bytes");
  expect(f.messages).toEqual([]);
  finish?.({ value: record });
  expect(f.widgets.size).toBe(0);
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0]?.content).toEqual([]);
  expect(f.render()).toBe("[skill@notion] reframe, sharpen · ready (alt+o to expand)");
  expect(f.render(true)).toContain("Limits: up to 8 nodes, depth 4, 8192 instruction bytes, 131072 context bytes.");
  expect(f.render(true)).toContain("Snapshot: snapshot-1");
  expect(f.render(true)).not.toContain("to expand");
  f.feedback.confirmPrepared(f.ctx);
  expect(f.render()).toBe("[skill@notion] reframe, sharpen · loaded (alt+o to expand)");
  expect(f.messages).toHaveLength(1);
  f.feedback.restore(f.ctx);
  expect(f.render()).toContain(" · loaded");
});

test("unavailable preparation remains one warning row and never claims loaded", async () => {
  const f = await fixture();
  const finish = f.feedback.begin(record, f.ctx, "use", source);
  finish?.({ error: "CURRENT_SOURCE_NOT_READY" });
  expect(f.feedback.failPending(f.ctx, "CURRENT_SOURCE_NOT_READY; continuing without this Skill.")).toBe(true);
  expect(f.messages).toHaveLength(1);
  expect(f.render()).toBe("[skill@notion] reframe · unavailable (alt+o to expand)");
  expect(f.render(true)).toContain("CURRENT_SOURCE_NOT_READY");
  expect(f.render()).not.toContain("loaded");
  expect(f.widgets.size).toBe(0);
  f.feedback.confirmPrepared(f.ctx);
  expect(f.render()).toContain(" · unavailable");
});

test("a non-cooperative acquisition cannot keep its widget or later publish success after warning", async () => {
  const f = await fixture();
  const finish = f.feedback.begin(record, f.ctx, "use", source);
  expect(f.feedback.failPending(f.ctx, "SOURCE_PREPARATION_TIMEOUT")).toBe(true);
  expect(f.widgets.size).toBe(0);
  finish?.({ value: record });
  f.feedback.confirmPrepared(f.ctx);
  expect(f.messages).toHaveLength(1);
  expect(f.render()).toContain(" · unavailable");
  expect(f.render(true)).toContain("SOURCE_PREPARATION_TIMEOUT");
});

test("cancel and session replacement clear loading without an extra warning or a late result", async () => {
  const f = await fixture();
  const cancelled = f.feedback.begin(record, f.ctx, "use", source);
  f.feedback.clearPending(f.ctx);
  cancelled?.({ value: record });
  expect(f.widgets.size).toBe(0); expect(f.messages).toEqual([]);
  const replaced = f.feedback.begin(record, f.ctx, "use", source);
  f.switchSession(); f.feedback.restore(f.ctx);
  replaced?.({ value: record });
  expect(f.widgets.size).toBe(0); expect(f.messages).toEqual([]);
});

test("inspection reports read, and missing optional UI never rejects preparation", async () => {
  const f = await fixture();
  f.feedback.begin(record, f.ctx, "inspect", source)?.({ value: record });
  expect(f.render()).toContain(" · read");
  const api: ExtensionAPI = { on() {}, appendEntry() { throw new Error("session UI unavailable"); } };
  const feedback = await createActivationFeedback(api, () => { throw new Error("render unavailable"); }, "widget");
  const ctx: ExtensionContext = { hasUI: true, ui: { setWidget() { throw new Error("widget unavailable"); } } };
  expect(() => feedback.begin(record, ctx, "use", source)?.({ value: record })).not.toThrow();
  expect(() => feedback.failPending(ctx, "SOURCE_PREPARATION_TIMEOUT")).not.toThrow();
});
