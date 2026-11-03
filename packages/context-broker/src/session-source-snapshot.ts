import { createHash } from "node:crypto";
import { recordIdentity } from "./discovery-records";
import type { AgentMessage, MessageContent, SkillRecord } from "./types";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const snapshot = (value: unknown): value is string => typeof value === "string" && /^s_[a-f0-9]{64}$/.test(value);
export function sourceMessageText(content: MessageContent | undefined): string {
  return typeof content === "string" ? content : (content ?? []).filter(part => part.type === "text").map(part => String(part.text ?? "")).join("\n");
}

/** Produced only for a successfully completed, whole-entry native tool read.
 * Stored in the actual tool result, not a second model-visible body message. */
export function nativeReadReceipt(record: SkillRecord, toolCallId: string, content: MessageContent | undefined) {
  const text = sourceMessageText(content);
  if (!record.sourceId || !snapshot(record.snapshotId) || !toolCallId || !record.body || text !== record.body || (Array.isArray(content) && content.some(part => part.type !== "text"))) return undefined;
  return { version: 1, identity: recordIdentity(record), toolCallId, snapshotId: record.snapshotId, bodySha256: hash(text), bytes: Buffer.byteLength(text) };
}

function verifiedReadProof(message: AgentMessage) {
  if (message.role !== "toolResult" || message.toolName !== "read" || message.isError === true || !object(message.details)) return undefined;
  const proof = message.details.contextBrokerRead;
  if (!object(proof) || proof.version !== 1 || typeof proof.identity !== "string" || proof.toolCallId !== message.toolCallId || !snapshot(proof.snapshotId)) return undefined;
  const text = sourceMessageText(message.content);
  return text && hash(text) === proof.bodySha256 && Buffer.byteLength(text) === proof.bytes ? proof : undefined;
}

function injectedSnapshots(messages: AgentMessage[]): Array<{ identity: string; snapshotId: string }> {
  const result: Array<{ identity: string; snapshotId: string }> = [];
  for (const message of messages) {
    if (message.role !== "custom" || !["context-broker", "skill-prompt-message"].includes(message.customType ?? "") || !object(message.details)) continue;
    const details = message.details;
    if (typeof details.nativePromptSha256 === "string") {
      if (!messages.some(candidate => candidate.role === "user" && hash(sourceMessageText(candidate.content)) === details.nativePromptSha256)) continue;
    } else if (!sourceMessageText(message.content).trim()) continue;
    for (const item of Array.isArray(details.records) ? details.records : [details]) {
      if (object(item) && typeof item.identity === "string" && item.loaded === true && snapshot(item.snapshotId)) result.push({ identity: item.identity, snapshotId: item.snapshotId });
    }
  }
  return result;
}

/** Preserve every actual tool result and tool-call ID in session history. Only
 * the provider projection replaces an already available exact entry copy with
 * a receipt-sized confirmation. Different snapshots/scopes and partial or
 * failed reads are never coalesced. */
export function deduplicateSourceReads(messages: AgentMessage[]): AgentMessage[] {
  const seen = new Set(injectedSnapshots(messages).map(item => JSON.stringify([item.identity, item.snapshotId])));
  return messages.map(message => {
    const proof = verifiedReadProof(message);
    if (!proof) return message;
    const key = JSON.stringify([proof.identity, proof.snapshotId]);
    if (!seen.has(key)) { seen.add(key); return message; }
    return { ...message, content: [{ type: "text", text: `The complete Skill entry for snapshot ${proof.snapshotId} is already present in this active context. This successful repeated read verified the same entry bytes; use the existing instructions and their fixed resource directory.` }] };
  });
}

export function nativeReadSnapshot(messages: AgentMessage[], record: SkillRecord): string | undefined {
  const ids = new Set<string>();
  for (const message of messages) {
    const proof = verifiedReadProof(message);
    if (proof?.identity === recordIdentity(record) && snapshot(proof.snapshotId)) ids.add(proof.snapshotId);
  }
  if (ids.size > 1) throw Object.assign(new Error("Conflicting active native Skill snapshots"), { code: "SOURCE_SESSION_CONFLICT" });
  return ids.values().next().value;
}

/** Only active trusted messages can restore a pin. User XML, detached receipts,
 * compacted bodies and same-name records from another credential scope cannot. */
export function sessionSourceSnapshot(messages: AgentMessage[], record: SkillRecord): string | undefined {
  if (!record.sourceId || record.kind === "prompt") return undefined;
  const native = nativeReadSnapshot(messages, record);
  const ids = new Set(native ? [native] : []);
  for (const item of injectedSnapshots(messages)) if (item.identity === recordIdentity(record)) ids.add(item.snapshotId);
  if (ids.size > 1) throw Object.assign(new Error("Conflicting active Skill snapshots"), { code: "SOURCE_SESSION_CONFLICT" });
  return ids.values().next().value;
}
