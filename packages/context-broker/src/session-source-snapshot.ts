import { createHash } from "node:crypto";
import { recordIdentity } from "./discovery-records";
import { parseNativeReference } from "./native-reference";
import type { AgentMessage, MessageContent, SkillRecord } from "./types";
import { isPreparationBinding, type PreparationBinding } from "./prepare-protocol";
import type { SessionSelection } from "./session-graph";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const snapshot = (value: unknown): value is string => typeof value === "string" && /^s_[a-f0-9]{64}$/.test(value);
const deliverySnapshot = (value: unknown, source: unknown): boolean => snapshot(value)
  || source === "filesystem" && typeof value === "string" && /^local_[a-f0-9]{64}$/.test(value);
export function sourceContentIdentity(record: SkillRecord): string {
  return record.source === "notion" && record.sourceScope && record.id
    ? JSON.stringify([record.sourceScope, record.id]) : recordIdentity(record);
}
function escaped(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function unescaped(value: string): string { return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"); }
export function sourceMessageText(content: MessageContent | undefined): string {
  return typeof content === "string" ? content : (content ?? []).filter(part => part.type === "text").map(part => String(part.text ?? "")).join("\n");
}

/** Produced only for a successfully completed, whole-entry native tool read.
 * Stored in the actual tool result, not a second model-visible body message. */
export function nativeReadReceipt(record: SkillRecord, toolCallId: string, content: MessageContent | undefined) {
  const text = sourceMessageText(content);
  if (!record.sourceId || !snapshot(record.snapshotId) || !toolCallId || !record.body || !text.startsWith(record.body) || (Array.isArray(content) && content.some(part => part.type !== "text"))) return undefined;
  return { version: text === record.body ? 2 : 3, identity: recordIdentity(record), contentIdentity: sourceContentIdentity(record), toolCallId, snapshotId: record.snapshotId,
    bodySha256: hash(record.body), bytes: Buffer.byteLength(record.body),
    ...(text === record.body ? {} : { delivery: { start: 0, end: record.body.length, encoding: "raw" } }),
    ...(record.preparationBinding ? { binding: record.preparationBinding } : {}) };
}

/** Link the receipt to an actual complete body span in the provider-visible message. */
export function sourceDeliveryReceipt(record: SkillRecord, content: string, encoding: "raw" | "xml" | "json" = "raw", explicitStart?: number) {
  if (!record.sourceId || !record.body) return undefined;
  const snapshotId = snapshot(record.snapshotId) ? record.snapshotId : record.source !== "notion" ? "local_" + hash(record.body) : undefined;
  if (!snapshotId) return undefined;
  const body = encoding === "xml" ? escaped(record.body) : encoding === "json" ? JSON.stringify(record.body).slice(1, -1) : record.body;
  const start = explicitStart ?? content.indexOf(body);
  if (start < 0 || content.slice(start, start + body.length) !== body) return undefined;
  return {
    version: 2, identity: recordIdentity(record), contentIdentity: sourceContentIdentity(record), loaded: true,
    snapshotId, bodySha256: hash(record.body), bytes: Buffer.byteLength(record.body),
    ...(record.source === "notion" ? {} : { source: "filesystem" }),
    delivery: { start, end: start + body.length, encoding },
    ...(record.preparationBinding ? { binding: record.preparationBinding } : {}),
  };
}

function verifiedReadProof(message: AgentMessage) {
  if (message.role !== "toolResult" || message.toolName !== "read" || message.isError === true || !object(message.details)) return undefined;
  const proof = message.details.contextBrokerRead;
  if (!object(proof) || ![1, 2, 3].includes(Number(proof.version)) || typeof proof.identity !== "string" || proof.toolCallId !== message.toolCallId || !snapshot(proof.snapshotId)) return undefined;
  const text = sourceMessageText(message.content);
  if (proof.version === 3) {
    const delivery = proof.delivery;
    if (!object(delivery) || delivery.start !== 0 || delivery.encoding !== "raw" || !Number.isSafeInteger(delivery.end)
      || Number(delivery.end) <= 0 || Number(delivery.end) > text.length
      || Array.isArray(message.content) && message.content.some(part => part.type !== "text")) return undefined;
    const body = text.slice(0, Number(delivery.end));
    return hash(body) === proof.bodySha256 && Buffer.byteLength(body) === proof.bytes ? proof : undefined;
  }
  return text && hash(text) === proof.bodySha256 && Buffer.byteLength(text) === proof.bytes ? proof : undefined;
}
function readProofEnd(proof: Record<string, unknown>, message: AgentMessage): number {
  return proof.version === 3 && object(proof.delivery) ? Number(proof.delivery.end) : sourceMessageText(message.content).length;
}

function verifiedResourceReadProof(message: AgentMessage) {
  if (message.role !== "toolResult" || message.toolName !== "read" || message.isError === true || !object(message.details)
    || Array.isArray(message.content) && message.content.some(part => part.type !== "text")) return undefined;
  const proof = message.details.contextBrokerResource;
  if (!object(proof) || proof.version !== 1 || proof.delivered_complete_text !== true || proof.loaded !== false
    || typeof proof.toolCallId !== "string" || !proof.toolCallId || proof.toolCallId !== message.toolCallId
    || typeof proof.scope !== "string" || !proof.scope || typeof proof.id !== "string" || !proof.id
    || !snapshot(proof.snapshot_id) || proof.file_id !== undefined && (typeof proof.file_id !== "string" || !proof.file_id)
    || typeof proof.ref !== "string" || typeof proof.path !== "string" || !proof.path) return undefined;
  try {
    const reference = parseNativeReference(proof.ref);
    if (reference.selector !== proof.id || reference.snapshot !== proof.snapshot_id
      || reference.fileId !== proof.file_id || reference.path !== proof.path) return undefined;
  } catch { return undefined; }
  const text = sourceMessageText(message.content);
  return hash(text) === proof.sha256 && Buffer.byteLength(text) === proof.bytes ? proof : undefined;
}

function injectedSnapshots(messages: AgentMessage[], visit?: (proof: Record<string, unknown>, contentIndex: number) => void): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (!object(message.details)) continue;
    const toolProof = message.details.contextBrokerPreparation;
    const tool = message.role === "toolResult" && message.toolName === "skill_prepare" && message.isError !== true
      && object(toolProof) && toolProof.version === 1 && toolProof.toolCallId === message.toolCallId;
    if (!tool && (message.role !== "custom" || !["context-broker", "skill-prompt-message"].includes(message.customType ?? ""))) continue;
    const details = tool && object(toolProof) ? toolProof : message.details;
    let content = sourceMessageText(message.content);
    let contentIndex = messageIndex;
    if (typeof details.nativePromptSha256 === "string") {
      const userIndex = messages.findIndex(candidate => candidate.role === "user" && hash(sourceMessageText(candidate.content)) === details.nativePromptSha256);
      const user = messages[userIndex];
      if (!user) continue;
      content = sourceMessageText(user.content);
      contentIndex = userIndex;
    }
    for (const item of Array.isArray(details.records) ? details.records : [details]) {
      if (!object(item) || item.version !== 2 || typeof item.identity !== "string" || item.loaded !== true || !deliverySnapshot(item.snapshotId, item.source) || !object(item.delivery)) continue;
      const { start, end, encoding } = item.delivery;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || Number(start) < 0 || Number(end) <= Number(start) || Number(end) > content.length || !["raw", "xml", "json"].includes(String(encoding))) continue;
      const span = content.slice(Number(start), Number(end));
      let body: string;
      try { body = encoding === "xml" ? unescaped(span) : encoding === "json" ? JSON.parse('"' + span + '"') : span; }
      catch { continue; }
      if (hash(body) === item.bodySha256 && Buffer.byteLength(body) === item.bytes) { result.push(item); visit?.(item, contentIndex); }
    }
  }
  return result;
}

type Replacement = { start: number; end: number; text: string };
function projectDeliverySpans(messages: AgentMessage[], replacements: Map<number, Replacement[]>): AgentMessage[] {
  const adjusted = new Map<Record<string, unknown>, Record<string, unknown> | null>();
  injectedSnapshots(messages, (proof, index) => {
    const spans = replacements.get(index);
    if (!spans?.length || !object(proof.delivery)) return;
    const start = Number(proof.delivery.start), end = Number(proof.delivery.end);
    if (spans.some(span => span.start < end && span.end > start)) { adjusted.set(proof, null); return; }
    const shift = spans.filter(span => span.end <= start).reduce((sum, span) => sum + span.text.length - (span.end - span.start), 0);
    if (shift) adjusted.set(proof, { ...proof, delivery: { ...proof.delivery, start: start + shift, end: end + shift } });
  });
  const projected = messages.map((message, index) => {
    const spans = replacements.get(index);
    if (!spans?.length) return message;
    let content = sourceMessageText(message.content), boundary = content.length;
    for (const span of spans.sort((a, b) => b.start - a.start)) {
      if (span.end > boundary) throw Object.assign(new Error("Overlapping source delivery evidence"), { code: "SOURCE_SESSION_CONFLICT" });
      content = content.slice(0, span.start) + span.text + content.slice(span.end); boundary = span.start;
    }
    if (typeof message.content === "string" || message.content === undefined) return { ...message, content };
    let offset = 0, textParts = 0;
    return { ...message, content: message.content.map(part => {
      if (part.type !== "text") return part;
      if (textParts++) offset++;
      const start = offset, end = start + part.text.length;
      offset = end;
      let text = part.text;
      for (const span of spans) {
        if (span.end <= start || span.start > end) continue;
        const localStart = Math.max(0, span.start - start), localEnd = Math.min(part.text.length, span.end - start);
        text = text.slice(0, localStart) + (span.start >= start ? span.text : "") + text.slice(localEnd);
      }
      return { ...part, text };
    }) };
  });
  function details(value: unknown): unknown {
    if (!object(value)) return value;
    const originalRecords = Array.isArray(value.records) ? value.records : undefined;
    const records = originalRecords ? originalRecords.map(item =>
      object(item) && adjusted.has(item) ? adjusted.get(item) ?? { ...item, loaded: false } : item) : undefined;
    const own = adjusted.get(value);
    const nested = object(value.contextBrokerPreparation) ? details(value.contextBrokerPreparation) : undefined;
    const user = typeof value.nativePromptSha256 === "string"
      ? messages.findIndex(message => message.role === "user" && hash(sourceMessageText(message.content)) === value.nativePromptSha256) : -1;
    const movedPrompt = user >= 0 && projected[user] !== messages[user];
    const movedRecords = originalRecords !== undefined && records?.some((record, index) => record !== originalRecords[index]);
    if (!adjusted.has(value) && !movedRecords && (!nested || nested === value.contextBrokerPreparation) && !movedPrompt) return value;
    return { ...value, ...(adjusted.has(value) ? own ?? { loaded: false } : {}), ...(records ? { records } : {}),
      ...(nested ? { contextBrokerPreparation: nested } : {}),
      ...(movedPrompt ? { nativePromptSha256: hash(sourceMessageText(projected[user]?.content)) } : {}) };
  }
  return projected.map(message => {
    const next = details(message.details);
    return next === message.details ? message : { ...message, details: next };
  });
}

/** Preserve every actual tool result and tool-call ID in session history. Only
 * the provider projection replaces an already available exact entry or resource copy with
 * a receipt-sized confirmation. Different snapshots/scopes and partial or
 * failed reads are never coalesced. */
export function deduplicateSourceReads(messages: AgentMessage[]): AgentMessage[] {
  const seen = new Map<string, string>();
  const replacements = new Map<number, Replacement[]>();
  const confirmation = (proof: Record<string, unknown>) => `The complete Skill entry for snapshot ${proof.snapshotId} is already present in this active context. This successful repeated read verified the same entry bytes; use the existing instructions and their fixed resource directory.`;
  function replace(index: number, start: number, end: number, text: string) {
    const spans = replacements.get(index) ?? [];
    if (!spans.some(span => span.start === start && span.end === end)) spans.push({ start, end, text });
    replacements.set(index, spans);
  }
  // Prefer explicit complete instruction deliveries, then retain the first
  // native read when no delivery exists. Repeated prepare results are subject
  // to exactly the same scope/pin/hash proof as repeated native reads.
  injectedSnapshots(messages, (proof, index) => {
    if (!object(proof.delivery)) return;
    const key = JSON.stringify([proof.contentIdentity ?? proof.identity, proof.snapshotId, proof.bodySha256]);
    const location = JSON.stringify([index, proof.delivery.start, proof.delivery.end]);
    if (!seen.has(key)) { seen.set(key, location); return; }
    if (seen.get(key) === location) return;
    const text = confirmation(proof);
    replace(index, Number(proof.delivery.start), Number(proof.delivery.end), proof.delivery.encoding === "json" ? JSON.stringify(text).slice(1, -1) : text);
  });
  messages.forEach((message, index) => {
    const proof = verifiedReadProof(message);
    if (!proof) return;
    const key = JSON.stringify([proof.contentIdentity ?? proof.identity, proof.snapshotId, proof.bodySha256]);
    if (!seen.has(key)) { seen.set(key, String(index)); return; }
    replace(index, 0, readProofEnd(proof, message), confirmation(proof));
  });
  const resources = new Set<string>();
  messages.forEach((message, index) => {
    const proof = verifiedResourceReadProof(message);
    if (!proof) return;
    const fileIdentity = proof.file_id === undefined ? ["path", proof.path] : ["file_id", proof.file_id];
    const key = JSON.stringify([proof.scope, proof.id, proof.snapshot_id, fileIdentity, proof.sha256]);
    if (!resources.has(key)) { resources.add(key); return; }
    replace(index, 0, sourceMessageText(message.content).length,
      `The complete Skill resource ${proof.path} for snapshot ${proof.snapshot_id} is already present in this active context. This successful repeated read verified the same resource bytes.`);
  });
  return replacements.size ? projectDeliverySpans(messages, replacements) : messages;
}

export function nativeReadSnapshot(messages: AgentMessage[], record: SkillRecord): string | undefined {
  const ids = new Set<string>();
  for (const message of messages) {
    const proof = verifiedReadProof(message);
    if (proof && (proof.contentIdentity === sourceContentIdentity(record) || proof.identity === recordIdentity(record)) && snapshot(proof.snapshotId)) ids.add(proof.snapshotId);
  }
  if (ids.size > 1) throw Object.assign(new Error("Conflicting active native Skill snapshots"), { code: "SOURCE_SESSION_CONFLICT" });
  return ids.values().next().value;
}

/** Only active trusted messages can restore a pin. User XML, detached receipts,
 * compacted bodies and same-name records from another credential scope cannot. */
export function sessionSourceSnapshot(messages: AgentMessage[], record: SkillRecord): string | undefined {
  if (!record.sourceId || record.source !== "notion" || record.kind === "prompt") return undefined;
  const native = nativeReadSnapshot(messages, record);
  const ids = new Set(native ? [native] : []);
  for (const item of injectedSnapshots(messages)) if ((item.contentIdentity === sourceContentIdentity(record) || item.identity === recordIdentity(record)) && snapshot(item.snapshotId)) ids.add(item.snapshotId);
  if (ids.size > 1) throw Object.assign(new Error("Conflicting active Skill snapshots"), { code: "SOURCE_SESSION_CONFLICT" });
  return ids.values().next().value;
}

export function sourceBodyLoaded(messages: AgentMessage[], record: SkillRecord): boolean {
  if (record.source !== "notion") return injectedSnapshots(messages).some(proof =>
    proof.identity === recordIdentity(record) && (record.body === undefined || proof.bodySha256 === hash(record.body)));
  const pin = sessionSourceSnapshot(messages, record);
  if (!pin || record.snapshotId !== undefined && pin !== record.snapshotId) return false;
  const proofs = [...injectedSnapshots(messages), ...messages.flatMap(message => { const proof = verifiedReadProof(message); return proof ? [proof] : []; })];
  const expectedHash = record.body === undefined ? record.preparationBinding?.body_sha256 : hash(record.body);
  return proofs.some(proof => (proof.contentIdentity === sourceContentIdentity(record) || proof.identity === recordIdentity(record))
    && proof.snapshotId === pin && (expectedHash === undefined || proof.bodySha256 === expectedHash)
    && (record.body === undefined || proof.bytes === Buffer.byteLength(record.body)));
}

/** A persistent activation receipt is useful only when the effective context
 * still contains the exact complete bytes it confirmed. */
export function sourceDeliveryLoaded(messages: AgentMessage[], expected: { identity: string; contentIdentity: string; snapshotId: string; bodySha256: string; bytes: number }): boolean {
  const proofs = [...injectedSnapshots(messages), ...messages.flatMap(message => { const proof = verifiedReadProof(message); return proof ? [proof] : []; })];
  return proofs.some(proof => (proof.contentIdentity === expected.contentIdentity || proof.identity === expected.identity)
    && proof.snapshotId === expected.snapshotId && proof.bodySha256 === expected.bodySha256 && proof.bytes === expected.bytes);
}

export function sessionSourceBindings(messages: AgentMessage[], scope: string): PreparationBinding[] {
  const proofs = [...injectedSnapshots(messages), ...messages.flatMap(message => { const proof = verifiedReadProof(message); return proof ? [proof] : []; })];
  const bindings = new Map<string, PreparationBinding>();
  for (const proof of proofs) {
    const value = proof.binding;
    if (!isPreparationBinding(value) || value.scope !== scope || value.snapshot_id !== proof.snapshotId || value.body_sha256 !== proof.bodySha256) continue;
    // This is the exact CLI binding emitted with a verified body receipt. The CLI
    // revalidates the complete record and current authorization when it is reused.
    const binding = value;
    const previous = bindings.get(binding.record.id);
    if (previous && (previous.snapshot_id !== binding.snapshot_id || previous.body_sha256 !== binding.body_sha256)) {
      throw Object.assign(new Error("Conflicting active Skill bindings"), { code: "SOURCE_SESSION_CONFLICT" });
    }
    bindings.set(binding.record.id, binding);
  }
  return [...bindings.values()];
}

/** Replace only verified superseded spans in the provider projection. Stored
 * native tool results and user messages are never rewritten. */
export function projectSelectedSourceMessages(messages: AgentMessage[], selection: SessionSelection): AgentMessage[] {
  const replacements = new Map<number, Replacement[]>();
  function retired(proof: Record<string, unknown>): boolean {
    let identity: unknown;
    try { identity = JSON.parse(String(proof.contentIdentity ?? proof.identity)); } catch { return false; }
    if (!Array.isArray(identity)) return false;
    const scopeId = identity.length === 2 ? identity[0] : identity[1], id = identity.length === 2 ? identity[1] : identity[4];
    if (typeof scopeId !== "string" || typeof id !== "string") return false;
    const scope = selection.scopes.get(scopeId);
    if (!scope) return false;
    const binding = scope.bindings.get(id);
    return binding ? binding.snapshot_id !== proof.snapshotId || binding.body_sha256 !== proof.bodySha256 : scope.retired.has(id);
  }
  function add(index: number, start: number, end: number, encoding: unknown) {
    const text = "An explicit new selection superseded these Skill instructions. Use the currently selected graph and its fixed references.";
    const replacement = { start, end, text: encoding === "json" ? JSON.stringify(text).slice(1, -1) : text };
    const list = replacements.get(index) ?? [];
    if (!list.some(item => item.start === start && item.end === end)) list.push(replacement);
    replacements.set(index, list);
  }
  injectedSnapshots(messages, (proof, index) => {
    if (retired(proof) && object(proof.delivery)) add(index, Number(proof.delivery.start), Number(proof.delivery.end), proof.delivery.encoding);
  });
  for (const [index, message] of messages.entries()) {
    const proof = verifiedReadProof(message);
    if (proof && retired(proof)) add(index, 0, readProofEnd(proof, message), "raw");
  }
  return replacements.size ? projectDeliverySpans(messages, replacements) : messages;
}
