import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { activeNotionSession } from "./fixtures/active-notion-session";
import { deduplicateSourceReads, sourceMessageText } from "../src/session-source-snapshot";
import type { AgentMessage, SkillRecord } from "../src/types";
import { recordIdentity } from "../src/discovery-records";
import { samePreparationBinding } from "../src/session-graph";
import { projectCatalogDescriptions } from "../src/skill-catalog-projection";

type Session = Awaited<ReturnType<typeof activeNotionSession>>;
type Role = "root" | "required";
const expectedStatus = (roles: Role[] = []) => ({
  purpose: "inspect",
  activation_effect: "unchanged",
  requires_acquisition: "not_performed",
  use_selection: { status: roles.length ? "already_selected_for_use" : "inspection_only", roles },
});
const readStatus = (message: AgentMessage) => {
  const text = sourceMessageText(message.content);
  const matches = [...text.matchAll(/<notion-read-status>([^]*?)<\/notion-read-status>/g)];
  expect(matches).toHaveLength(1);
  return JSON.parse(matches[0]![1]!);
};
const originalBody = (message: AgentMessage, record: SkillRecord) => {
  const text = sourceMessageText(message.content);
  expect(text.slice(0, record.body!.length)).toBe(record.body!);
};
const asUseResult = (toolCallId: string, result: Awaited<ReturnType<ReturnType<Session["tool"]>["execute"]>>): AgentMessage =>
  ({ role: "toolResult", toolName: "notion_use", toolCallId, ...result });

test("first public main read declares inspection despite a persisted inspect selection", async () => {
  const h = await activeNotionSession();
  try {
    const root = h.record("root"), result = await h.read(root.ref!);
    originalBody(result, root);
    expect(h.active().sources.size).toBe(0);
    expect(h.selected().scopes.get(root.sourceScope!)?.graphs.map(graph => graph.purpose)).toContain("inspect");
    expect(readStatus(result)).toEqual(expectedStatus());
    expect(sourceMessageText(result.content)).not.toContain(h.record("required").body!);
  } finally { await h.close(); }
});

for (const scenario of [
  { roots: ["root"], read: "root", roles: ["root"] },
  { roots: ["root"], read: "required", roles: ["required"] },
  { roots: ["root", "required"], read: "required", roles: ["root", "required"] },
] as const) test("read reports existing use membership " + scenario.roles.join("+"), async () => {
  const h = await activeNotionSession();
  try {
    const graph = await h.seed([...scenario.roots]), record = graph.records.find(item => item.name === scenario.read)!;
    const before = [...h.active().sources], result = await h.read(h.fixedRef(record));
    originalBody(result, record);
    expect(readStatus(result)).toEqual(expectedStatus([...scenario.roles]));
    expect([...h.active().sources]).toEqual(before);
  } finally { await h.close(); }
});

test("fresh B inspection cannot inherit use status from the same owner's active A", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(), root = old.records.find(item => item.name === "root")!, ref = h.fixedRef(root);
    const before = [...h.active().sources], current = h.revise("root", "Current root B is only being inspected.\n");
    const result = await h.read(ref, true);
    originalBody(result, current);
    expect(readStatus(result)).toEqual(expectedStatus());
    expect([...h.active().sources]).toEqual(before);
    expect(h.selected().scopes.get(root.sourceScope!)!.bindings.get(root.id!)!.snapshot_id).toBe(root.snapshotId);
  } finally { await h.close(); }
});

test("a pending explicit use is already selected but the following read does not claim activation", async () => {
  const h = await activeNotionSession();
  try {
    let result: AgentMessage | undefined;
    const root = h.record("root");
    const turn = await h.turn("Apply the selected task, then inspect its main text.", [], undefined, undefined, [], {
      beforeContext: async () => {
        const toolCallId = "pending-use-before-read";
        const use = await h.tool("notion_use").execute(toolCallId, { ref: root.ref! }, undefined, undefined, h.ctx);
        expect(h.active().sources.size).toBe(0);
        result = await h.read(h.fixedRef(root));
        originalBody(result, root);
        expect(readStatus(result)).toEqual(expectedStatus(["root"]));
        expect(h.active().sources.size).toBe(0);
        return [asUseResult(toolCallId, use), result];
      }, status: 200,
    });
    expect(turn.error).toBeUndefined(); expect(turn.provider).toBe(true);
    const delivered = turn.payload!.messages.find(message => message.tool_call_id === result!.toolCallId)!;
    expect(readStatus({ role: "toolResult", content: delivered.content })).toEqual(expectedStatus(["root"]));
    expect(delivered.content).not.toContain("<skill-directory>");
    expect([...h.active().sources.values()].map(item => item.record.name).sort()).toEqual(["required", "root"]);
  } finally { await h.close(); }
});

test("directory deduplication keeps this read's public operation status and effects", async () => {
  const h = await activeNotionSession();
  try {
    const graph = await h.seed(), root = graph.records.find(item => item.name === "root")!;
    const toolCallId = "use-before-directory-dedup";
    const use = await h.tool("notion_use").execute(toolCallId, { ref: h.fixedRef(root) }, undefined, undefined, h.ctx);
    const read = await h.read(h.fixedRef(root));
    const projected = deduplicateSourceReads([asUseResult(toolCallId, use), read]);
    expect(sourceMessageText(read.content)).toContain("<skill-directory>");
    expect(sourceMessageText(projected[1]!.content)).not.toContain("<skill-directory>");
    expect(readStatus(projected[1]!)).toEqual(expectedStatus(["root"]));
    expect(sourceMessageText(projected[1]!.content)).toContain("<notion-effects>");
    expect(sourceMessageText(read.content)).toContain(root.body!);
  } finally { await h.close(); }
});

const requiredCardProjection = (h: Session, message: AgentMessage) => {
  const root = h.record("root"), required = h.record("required");
  const card = { ref: required.ref!, kind: "skill", name: required.name, description: required.description!,
    availability: "available", source: "notion", scope: required.sourceScope! };
  return projectCatalogDescriptions({ messages: [message], defaults: [card],
    identify: (candidate, canonical) => {
      if (canonical && canonical.id !== required.id) return undefined;
      return JSON.stringify([candidate.source, candidate.scope, candidate.kind, candidate.name, candidate.description, candidate.availability]);
    },
    matchesRead: (ref, binding, identity) => ref === h.fixedRef(root) && samePreparationBinding(binding, root.preparationBinding!)
      && identity === recordIdentity(root),
  });
};

test("a qualified read still supplies the exact Requires description to catalog deduplication", async () => {
  const h = await activeNotionSession();
  try {
    const read = await h.read(h.record("root").ref!), original = JSON.stringify(read);
    expect(readStatus(read)).toEqual(expectedStatus());
    const projected = requiredCardProjection(h, read);
    expect(projected.omittedDefaults.size).toBe(1);
    expect(readStatus(projected.messages[0]!)).toEqual(expectedStatus());
    expect(JSON.stringify(read)).toBe(original);
  } finally { await h.close(); }
});

test("a mismatched read status cannot establish a reusable directory or catalog description", async () => {
  const h = await activeNotionSession();
  try {
    const graph = await h.seed(), root = graph.records.find(item => item.name === "root")!;
    const toolCallId = "use-before-status-tamper";
    const use = await h.tool("notion_use").execute(toolCallId, { ref: h.fixedRef(root) }, undefined, undefined, h.ctx);
    const read = await h.read(h.fixedRef(root));
    expect(requiredCardProjection(h, read).omittedDefaults.size).toBe(1);
    const privateMismatch = structuredClone(read), publicMismatch = structuredClone(read);
    const privateProof = (privateMismatch.details as Record<string, unknown>).contextBrokerRead as Record<string, unknown>;
    privateProof.readStatus = expectedStatus();
    const replaceStatus = (text: string) => text.replace(JSON.stringify(expectedStatus(["root"])), JSON.stringify(expectedStatus()));
    publicMismatch.content = typeof publicMismatch.content === "string" ? replaceStatus(publicMismatch.content)
      : publicMismatch.content?.map(part => part.type === "text" ? { ...part, text: replaceStatus(String(part.text)) } : part);
    const publicText = sourceMessageText(publicMismatch.content);
    const publicProof = (publicMismatch.details as Record<string, unknown>).contextBrokerRead as Record<string, unknown>;
    // Keep the outer render envelope internally valid so the operation/footer
    // binding, rather than the existing whole-render hash, rejects the mismatch.
    publicProof.rendered = { sha256: createHash("sha256").update(publicText).digest("hex"), bytes: Buffer.byteLength(publicText) };
    for (const damaged of [privateMismatch, publicMismatch]) {
      originalBody(damaged, root);
      expect(requiredCardProjection(h, damaged).omittedDefaults.size).toBe(0);
      const projected = deduplicateSourceReads([asUseResult(toolCallId, use), damaged]);
      expect(sourceMessageText(projected[1]!.content)).toContain("<skill-directory>");
      expect(sourceMessageText(projected[1]!.content)).toContain("<notion-read-status>");
      expect(sourceMessageText(projected[1]!.content)).toContain("<notion-effects>");
    }
  } finally { await h.close(); }
});
