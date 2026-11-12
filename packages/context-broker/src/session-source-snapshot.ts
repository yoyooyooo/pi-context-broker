import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { recordIdentity } from "./discovery-records";
import { parseNativeReference } from "./native-reference";
import type { AgentMessage, MessageContent, ProjectedSessionEntry, SessionBoundaryDraft, SkillRecord } from "./types";
import { decodePreparationLock, isPreparationBinding, isPreparationDirectory, type PreparationBinding } from "./prepare-protocol";
import type { SessionSelection } from "./session-graph";
import { deriveSkillPrepareProjection, validateSkillPrepareProjection } from "./skill-context-projection-proof";
import { deriveResourceReadProjection, validateResourceReadProjection } from "./resource-read-projection";
import { isConsumptionEffects } from "./consumption-effects";
import { isSkillPreparationDirectory, isSkillPreparationModel, projectSkillDirectory, type SkillPreparationModelDirectory } from "./skill-context-projection";

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

/** Machine entries have no model message. Reattach their existing delivery
 * receipts only while the exact projected user content remains in context. */
export function withSessionSourceReceipts(messages: AgentMessage[], entries: readonly ProjectedSessionEntry[]): AgentMessage[] {
  const userHashes = new Set(messages.filter(message => message.role === "user").map(message => hash(sourceMessageText(message.content))));
  const receipts = entries.flatMap(({ sourceEntry: entry }): AgentMessage[] => entry.type === "custom" && entry.customType === "context-broker"
    && object(entry.data) && typeof entry.data.nativePromptSha256 === "string" && userHashes.has(entry.data.nativePromptSha256)
    ? [{ role: "custom", customType: "context-broker", content: [], details: entry.data }] : []);
  return receipts.length ? [...messages, ...receipts] : messages;
}

/** Keep the delivered text in Pi's native context so print output, compaction
 * and branch navigation all see the same history. Only content is projected;
 * raw user/assistant/tool entries and non-text user blocks stay untouched. */
export function deferredSourceEntries(entries: readonly ProjectedSessionEntry[], userEntryId: string, delivered: readonly AgentMessage[]): {
  entries: SessionBoundaryDraft[]; nativePromptSha256: string;
} | undefined {
  const target = entries.find(entry => entry.sourceEntry.id === userEntryId && entry.sourceEntry.type === "message");
  const user = target?.messages.find(message => message.role === "user");
  if (!user || user.content === undefined) return undefined;
  let content = user.content;
  const records = deferredDeliveryRecords(withSessionSourceReceipts([user], entries));
  let appended = false;
  for (const message of delivered) {
    const text = sourceMessageText(message.content);
    if (!text) continue;
    content = typeof content === "string" ? content + "\n\n" + text : [...content, { type: "text", text }];
    const offset = sourceMessageText(content).length - text.length;
    for (const proof of deferredDeliveryRecords([message])) {
      records.push(object(proof.delivery)
        ? { ...proof, delivery: { ...proof.delivery, start: Number(proof.delivery.start) + offset, end: Number(proof.delivery.end) + offset } }
        : proof);
    }
    appended = true;
  }
  if (!appended) return undefined;
  const nativePromptSha256 = hash(sourceMessageText(content));
  return { nativePromptSha256, entries: [
    { type: "context_edit", targetId: userEntryId, replacement: { content } },
    { type: "custom", customType: "context-broker", data: { nativePromptSha256, records } },
  ] };
}

/** Produced only for a successfully completed, whole-entry native tool read.
 * Stored in the actual tool result, not a second model-visible body message. */
export function nativeReadReceipt(record: SkillRecord, toolCallId: string, content: MessageContent | undefined) {
  const text = sourceMessageText(content);
  if (!record.sourceId || !snapshot(record.snapshotId) || !toolCallId || !record.body || !text.startsWith(record.body) || (Array.isArray(content) && content.some(part => part.type !== "text"))) return undefined;
  return { version: text === record.body ? 2 : 3, identity: recordIdentity(record), contentIdentity: sourceContentIdentity(record), toolCallId, snapshotId: record.snapshotId,
    bodySha256: hash(record.body), bytes: Buffer.byteLength(record.body),
    ...(text === record.body ? {} : { delivery: { start: 0, end: record.body.length, encoding: "raw" },
      rendered: { sha256: hash(text), bytes: Buffer.byteLength(text) } }),
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
  if (!object(proof) || proof.loaded === false || ![1, 2, 3].includes(Number(proof.version)) || typeof proof.identity !== "string"
    || typeof proof.toolCallId !== "string" || !proof.toolCallId || proof.toolCallId !== message.toolCallId || !snapshot(proof.snapshotId)) return undefined;
  const text = sourceMessageText(message.content);
  if (proof.rendered !== undefined && (!object(proof.rendered) || proof.rendered.sha256 !== hash(text)
    || proof.rendered.bytes !== Buffer.byteLength(text))) return undefined;
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
  if (!object(proof) || ![1, 2].includes(Number(proof.version)) || proof.delivered_complete_text !== true || proof.loaded !== false
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
  if (proof.version === 2) {
    const delivery = proof.delivery;
    if (!object(delivery) || delivery.start !== 0 || delivery.encoding !== "raw" || !Number.isSafeInteger(delivery.end)
      || Number(delivery.end) < 0 || Number(delivery.end) > text.length) return undefined;
    const body = text.slice(0, Number(delivery.end));
    return hash(body) === proof.sha256 && Buffer.byteLength(body) === proof.bytes ? proof : undefined;
  }
  return hash(text) === proof.sha256 && Buffer.byteLength(text) === proof.bytes ? proof : undefined;
}

function verifiedResourceBatchProof(message: AgentMessage) {
  if (message.role !== "toolResult" || message.toolName !== "read" || message.isError === true || !object(message.details)
    || Array.isArray(message.content) && message.content.some(part => part.type !== "text")) return undefined;
  const proof = validateResourceReadProjection(sourceMessageText(message.content), message.details.contextBrokerResource);
  return proof && proof.toolCallId === message.toolCallId ? proof : undefined;
}

function verifiedPreparationProjection(message: AgentMessage, proof: Record<string, unknown>) {
  if (message.role !== "toolResult" || !["notion_use", "skill_prepare"].includes(message.toolName ?? "")
    || message.isError === true || proof.version !== 2 || !message.toolCallId || proof.toolCallId !== message.toolCallId) return undefined;
  if (Array.isArray(message.content) && message.content.some(part => part.type !== "text")) return undefined;
  const text = sourceMessageText(message.content), projection = validateSkillPrepareProjection(text, proof.projection);
  if (!projection || !Array.isArray(proof.records) || proof.records.length !== projection.records.length
    || !Array.isArray(proof.graphs) || !proof.graphs.length) return undefined;
  const model = JSON.parse(text);
  if (proof.purpose !== model.purpose) return undefined;
  const bindings = new Map<string, PreparationBinding>(), roots = new Set<string>();
  try {
    for (const graph of proof.graphs) {
      if (!object(graph)) return undefined;
      const lock = decodePreparationLock(graph.graph_lock);
      if (lock.purpose !== proof.purpose || graph.scope !== lock.scope || !Array.isArray(graph.roots)
        || graph.roots.some(root => typeof root !== "string")
        || !isDeepStrictEqual([...new Set(graph.roots)].sort(), [...new Set(lock.roots)].sort())) return undefined;
      for (const binding of lock.bindings) {
        const key = JSON.stringify([binding.scope, binding.record.id]), previous = bindings.get(key);
        if (previous && !isDeepStrictEqual(previous, binding)) return undefined;
        bindings.set(key, binding);
      }
      for (const id of lock.roots) roots.add(JSON.stringify([lock.scope, id]));
    }
  } catch { return undefined; }
  if (bindings.size !== proof.records.length) return undefined;
  const rootRefs = new Set<string>(), seen = new Set<string>();
  for (const [index, item] of proof.records.entries()) {
    const mapping = projection.records[index]!, record = model.records[index];
    if (!object(item) || item.version !== 2 || item.identity !== mapping.source.identity
      || item.bodySha256 !== mapping.source.sha256 || item.bytes !== mapping.source.bytes
      || item.loaded !== (mapping.state === "source") || !isDeepStrictEqual(item.delivery, mapping.delivery)
      || !isPreparationBinding(item.binding)) return undefined;
    const binding = item.binding, key = JSON.stringify([binding.scope, binding.record.id]);
    if (seen.has(key) || item.contentIdentity !== key || item.snapshotId !== binding.snapshot_id
      || item.bodySha256 !== binding.body_sha256 || !isDeepStrictEqual(bindings.get(key), binding)
      || record.name !== binding.record.name || record.kind !== binding.record.kind) return undefined;
    let identity: unknown;
    try { identity = JSON.parse(String(item.identity)); } catch { return undefined; }
    if (!Array.isArray(identity) || identity.length !== 5 || typeof identity[0] !== "string" || !identity[0]
      || identity[1] !== binding.scope || identity[2] !== binding.record.kind || identity[3] !== binding.record.locator.type
      || identity[4] !== binding.record.id) return undefined;
    if (record.ref.startsWith("sr:")) {
      if (!/^sr:S[A-Za-z0-9_-]{22}$/.test(record.ref)) return undefined;
    } else if (record.ref !== binding.ref) return undefined;
    seen.add(key);
    if (roots.has(key)) rootRefs.add(record.ref);
  }
  if (model.roots.length !== rootRefs.size || model.roots.some((ref: string) => !rootRefs.has(ref))) return undefined;
  return projection;
}

function injectedSnapshots(messages: readonly AgentMessage[], visit?: (proof: Record<string, unknown>, contentIndex: number, body: string) => void): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (!object(message.details)) continue;
    const toolProof = message.details.contextBrokerPreparation;
    const tool = message.role === "toolResult" && (message.toolName === "notion_use" || message.toolName === "skill_prepare") && message.isError !== true
      && object(toolProof) && typeof toolProof.toolCallId === "string" && toolProof.toolCallId.length > 0
      && toolProof.toolCallId === message.toolCallId && (toolProof.version === 1 && !Object.hasOwn(toolProof, "projection")
        || toolProof.version === 2 && verifiedPreparationProjection(message, toolProof) !== undefined);
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
      if (hash(body) === item.bodySha256 && Buffer.byteLength(body) === item.bytes) { result.push(item); visit?.(item, contentIndex, body); }
    }
  }
  return result;
}

/** Complete source bodies from broker injections in this outgoing context.
 * Deferred user text counts only through its matching native receipt. */
export function injectedSourceBodies(messages: readonly AgentMessage[]): Array<{ source: string; scope: string; body: string; directory: unknown }> {
  const bodies: Array<{ source: string; scope: string; body: string; directory: unknown }> = [];
  const injections = messages.filter(message => message.role === "user" || message.role === "custom" && message.customType === "context-broker");
  injectedSnapshots(injections, (proof, _index, body) => {
    const binding = proof.binding;
    if (!isPreparationBinding(binding) || binding.snapshot_id !== proof.snapshotId || binding.body_sha256 !== proof.bodySha256
      || binding.version_id !== proof.versionId || proof.contentIdentity !== JSON.stringify([binding.scope, binding.record.id])) return;
    try {
      const identity: unknown = JSON.parse(String(proof.identity));
      if (!Array.isArray(identity) || identity.length !== 5 || typeof identity[0] !== "string" || !identity[0]
        || identity[0] !== proof.sourceId || identity[1] !== binding.scope || identity[2] !== binding.record.kind
        || identity[3] !== binding.record.locator.type || identity[4] !== binding.record.id) return;
      const reference = parseNativeReference(binding.ref), canonical = parseNativeReference(binding.record.ref);
      if (reference.selector !== canonical.selector || reference.snapshot !== binding.snapshot_id || reference.path !== binding.record.entrypoint
        || canonical.path !== binding.record.entrypoint || canonical.snapshot !== undefined || canonical.fileId !== undefined) return;
      bodies.push({ source: identity[0], scope: binding.scope, body, directory: proof.directory });
    } catch { /* An unverifiable source identity cannot replace directory metadata. */ }
  });
  return bodies;
}

function deferredDeliveryRecords(messages: AgentMessage[]): Record<string, unknown>[] {
  const records = injectedSnapshots(messages);
  const userHashes = new Set(messages.filter(message => message.role === "user").map(message => hash(sourceMessageText(message.content))));
  for (const message of messages) {
    if (message.role !== "custom" || message.customType !== "context-broker" || !object(message.details)) continue;
    const details = message.details;
    if (typeof details.nativePromptSha256 === "string" && !userHashes.has(details.nativePromptSha256)) continue;
    // The original skillRoots directory predates source IDs and v2 source
    // receipts. Preserve its existing local identity metadata, now attached to
    // the exact projected user digest; it never establishes a Notion pin.
    for (const record of Array.isArray(details.records) ? details.records : []) {
      if (object(record) && record.sourceId === undefined && record.snapshotId === undefined && record.delivery === undefined
        && record.loaded === true && typeof record.identity === "string" && typeof record.path === "string"
        && (record.kind === "skill" || record.kind === "router")) records.push(record);
    }
  }
  return records;
}

type Replacement = { start: number; end: number; text: string };
function projectDeliverySpans(messages: AgentMessage[], replacements: Map<number, Replacement[]>, reason: "deduplicate" | "supersede",
  omittedDirectories: ReadonlyMap<number, readonly number[]> = new Map()): AgentMessage[] {
  const adjusted = new Map<Record<string, unknown>, Record<string, unknown> | null>();
  injectedSnapshots(messages, (proof, index) => {
    const spans = replacements.get(index);
    if (!spans?.length || !object(proof.delivery)) return;
    const start = Number(proof.delivery.start), end = Number(proof.delivery.end);
    const bodyRemoved = spans.some(span => span.start < end && span.end > start);
    const shift = spans.filter(span => span.end <= start).reduce((sum, span) => sum + span.text.length - (span.end - span.start), 0);
    const resources = object(proof.resourcesDelivery) ? proof.resourcesDelivery : undefined;
    const removed = resources && spans.some(span => span.start === resources.start && span.end === resources.end && !span.text);
    const resourcesShift = resources ? spans.filter(span => span.end <= Number(resources.start))
      .reduce((sum, span) => sum + span.text.length - (span.end - span.start), 0) : 0;
    if (shift || bodyRemoved || removed || resourcesShift) adjusted.set(proof, { ...proof,
      ...(bodyRemoved ? { loaded: false } : shift ? { delivery: { ...proof.delivery, start: start + shift, end: end + shift } } : {}),
      ...(removed ? { resourcesDelivery: undefined, resourcesOmitted: { sha256: resources.sha256, bytes: resources.bytes } }
        : resourcesShift ? { resourcesDelivery: { ...resources, start: Number(resources!.start) + resourcesShift, end: Number(resources!.end) + resourcesShift } } : {}),
    });
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
  return projected.map((message, index) => {
    const next = details(message.details);
    const original = messages[index]!;
    const preparation = object(original.details) ? original.details.contextBrokerPreparation : undefined;
    if (projected[index] !== original && object(preparation) && preparation.version === 2) {
      const verified = verifiedPreparationProjection(original, preparation);
      if (!verified || !object(next) || !object(next.contextBrokerPreparation)) return { ...message, details: next };
      const changes = replacements.get(index) ?? [];
      const changedIndices = verified.records.flatMap((record, recordIndex) => changes.some(change =>
        change.start < record.delivery.end && change.end > record.delivery.start) ? [recordIndex] : []);
      const derived = deriveSkillPrepareProjection(sourceMessageText(original.content), sourceMessageText(message.content),
        verified, changedIndices, reason, omittedDirectories.get(index));
      // A new content digest must never bless an invalid old receipt or an
      // unrelated metadata edit. Failed derivation keeps evidence invalid.
      if (!derived || !Array.isArray(preparation.records)) return { ...message, details: next };
      const records = preparation.records.map((record, recordIndex) => object(record) ? { ...record,
        delivery: derived.records[recordIndex]!.delivery, loaded: derived.records[recordIndex]!.state === "source" } : record);
      return { ...message, details: { ...next, contextBrokerPreparation: { ...next.contextBrokerPreparation, records, projection: derived } } };
    }
    if (projected[index] !== original) {
      // A confirmation can equal a very short author body. Invalidate only the
      // provider copy explicitly instead of relying on different text hashes.
      const native = verifiedReadProof(original);
      if (native && object(next)) {
        const end = readProofEnd(native, original), changedBody = (replacements.get(index) ?? []).some(span => span.start < end && span.end > 0);
        const text = sourceMessageText(message.content);
        const directory = nativeDirectory(original, native);
        const directoryRemoved = directory && (replacements.get(index) ?? []).some(span =>
          span.start === directory.start && span.end === directory.end && span.text === "");
        const directoryText = directoryRemoved ? JSON.stringify(directory.directory) : undefined;
        return { ...message, details: { ...next, contextBrokerRead: { ...native,
          ...(changedBody ? { loaded: false } : {}),
          ...(directoryText === undefined ? {} : { directoryOmitted: { sha256: hash(directoryText), bytes: Buffer.byteLength(directoryText) } }),
          ...(native.rendered === undefined ? {} : { rendered: { sha256: hash(text), bytes: Buffer.byteLength(text) } }) } } };
      }
      const resource = verifiedResourceReadProof(original);
      if (resource && object(next)) return { ...message, details: { ...next, contextBrokerResource: { ...resource, delivered_complete_text: false } } };
      const batch = verifiedResourceBatchProof(original);
      if (batch && object(next)) {
        const changes = replacements.get(index) ?? [];
        const changedIndices = batch.files.flatMap((file, fileIndex) => file.delivery && changes.some(change =>
          change.start === file.delivery!.start && change.end === file.delivery!.end) ? [fileIndex] : []);
        const derived = deriveResourceReadProjection(sourceMessageText(original.content), sourceMessageText(message.content), batch, changedIndices);
        if (derived) return { ...message, details: { ...next, contextBrokerResource: derived },
          ...(Object.hasOwn(message, "structuredContent") ? { structuredContent: JSON.parse(sourceMessageText(message.content)) } : {}) };
      }
    }
    return next === message.details ? message : { ...message, details: next };
  });
}

function generatedDirectoryMatches(value: SkillPreparationModelDirectory, canonical: unknown): boolean {
  if (!isPreparationDirectory(canonical)) return false;
  const normalized = projectSkillDirectory(canonical)!;
  for (const group of ["files", "required", "candidates", "references"] as const) {
    const expected = normalized[group], actual = value[group];
    if (!Array.isArray(expected) || expected.length !== actual.length) return false;
    if (actual.some((row, index) => {
      const original = expected[index]!;
      const fields = Object.keys(original).filter(key => key !== "ref");
      return !isDeepStrictEqual(Object.keys(row).filter(key => key !== "ref").sort(), [...fields].sort())
        || fields.some(field => Reflect.get(row, field) !== Reflect.get(original, field));
    })) return false;
  }
  return true;
}

function nativeDirectory(message: AgentMessage, proof: Record<string, unknown>) {
  if (proof.version !== 3 || !object(proof.rendered) || !isPreparationBinding(proof.binding)) return undefined;
  if (proof.snapshotId !== proof.binding.snapshot_id || proof.bodySha256 !== proof.binding.body_sha256
    || proof.contentIdentity !== JSON.stringify([proof.binding.scope, proof.binding.record.id])) return undefined;
  const text = sourceMessageText(message.content), start = readProofEnd(proof, message);
  let suffix = text.slice(start);
  if (object(message.details) && isConsumptionEffects(message.details.effects)) {
    const footer = "\n\n<notion-effects>" + JSON.stringify(message.details.effects) + "</notion-effects>";
    if (!suffix.endsWith(footer)) return undefined;
    suffix = suffix.slice(0, -footer.length);
  }
  const match = /^\n{2,3}<skill-directory>\n([\s\S]*)\n<\/skill-directory>$/.exec(suffix);
  if (!match) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]!);
    if (!object(value) || Object.keys(value).length !== 2 || typeof value.ref !== "string"
      || JSON.stringify(value) !== match[1] || !isSkillPreparationDirectory(value.directory)
      || !generatedDirectoryMatches(value.directory, proof.directory)) return undefined;
    if (value.ref !== proof.binding.ref && !/^sr:S[A-Za-z0-9_-]{22}$/.test(value.ref)) return undefined;
    return { directory: value.directory, binding: proof.binding, start, end: start + suffix.length };
  } catch { return undefined; }
}

/** Preserve every actual tool result and tool-call ID in session history. Only
 * the provider projection replaces an already available exact entry or resource copy with
 * a receipt-sized confirmation. Different snapshots/scopes and partial or
 * failed reads are never coalesced. */
export function deduplicateSourceReads(messages: AgentMessage[]): AgentMessage[] {
  const seen = new Map<string, string>();
  const replacements = new Map<number, Replacement[]>();
  const omittedDirectories = new Map<number, number[]>();
  const entryConfirmation = "Already loaded.", resourceConfirmation = "Already available.";
  function replace(index: number, start: number, end: number, text: string) {
    const spans = replacements.get(index) ?? [];
    if (!spans.some(span => span.start === start && span.end === end)) spans.push({ start, end, text });
    replacements.set(index, spans);
  }
  const directories = new Set<string>();
  const supportDirectories = new Set<string>();
  const supportKey = (binding: PreparationBinding, files: readonly { path: string; ref: string }[]) =>
    JSON.stringify([binding.scope, binding.record.id, binding.snapshot_id, binding.version_id,
      files.filter(file => file.path !== binding.record.entrypoint).map(({ path, ref }) => ({ path, ref }))]);
  const directoryKey = (binding: PreparationBinding, directory: SkillPreparationModelDirectory) =>
    JSON.stringify([binding.scope, binding.record.id, binding.snapshot_id, binding.version_id, directory]);
  // Match the body's preference for a verified preparation. Native footer text
  // is generated material only when its complete output and binding are intact.
  messages.forEach((message, index) => {
    const proof = object(message.details) ? message.details.contextBrokerPreparation : undefined;
    const projection = object(proof) ? verifiedPreparationProjection(message, proof) : undefined;
    if (!object(proof) || !projection || !Array.isArray(proof.records)) return;
    const text = sourceMessageText(message.content), model: unknown = JSON.parse(text);
    if (!isSkillPreparationModel(model)) return;
    for (const [recordIndex, record] of model.records.entries()) {
      const receipt: unknown = proof.records[recordIndex];
      if (!record.directory || !object(receipt) || !isPreparationBinding(receipt.binding)
        || !generatedDirectoryMatches(record.directory, receipt.directory)) continue;
      const key = directoryKey(receipt.binding, record.directory);
      supportDirectories.add(supportKey(receipt.binding, record.directory.files));
      if (!directories.has(key)) { directories.add(key); continue; }
      const start = projection.records[recordIndex]!.delivery.end + 1, encoded = ',"directory":' + JSON.stringify(record.directory);
      if (text.slice(start, start + encoded.length) !== encoded) continue;
      replace(index, start, start + encoded.length, "");
      omittedDirectories.set(index, [...omittedDirectories.get(index) ?? [], recordIndex]);
    }
  });
  messages.forEach((message, index) => {
    const proof = verifiedReadProof(message), value = proof && nativeDirectory(message, proof);
    if (!value) return;
    const key = directoryKey(value.binding, value.directory);
    supportDirectories.add(supportKey(value.binding, value.directory.files));
    if (!directories.has(key)) { directories.add(key); return; }
    replace(index, value.start, value.end, "");
  });
  injectedSnapshots(messages, (proof, index) => {
    const span = proof.resourcesDelivery;
    if (!object(span) || !isPreparationBinding(proof.binding) || !isPreparationDirectory(proof.directory)
      || proof.snapshotId !== proof.binding.snapshot_id || proof.bodySha256 !== proof.binding.body_sha256
      || proof.contentIdentity !== JSON.stringify([proof.binding.scope, proof.binding.record.id])
      || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
      || Number(span.start) < 0 || Number(span.end) <= Number(span.start)
      || !object(proof.delivery) || Number(span.end) > Number(proof.delivery.start)) return;
    const text = sourceMessageText(messages[index]?.content), encoded = text.slice(Number(span.start), Number(span.end));
    if (hash(encoded) !== span.sha256 || Buffer.byteLength(encoded) !== span.bytes
      || !encoded.startsWith("<resources>") || !encoded.endsWith("</resources>")) return;
    try {
      const files: unknown = JSON.parse(unescaped(encoded.slice("<resources>".length, -"</resources>".length)));
      const binding = proof.binding;
      const original = proof.directory.files.filter(file => file.path !== binding.record.entrypoint);
      if (!Array.isArray(files) || files.length !== original.length || files.some((file, n) =>
        !object(file) || Object.keys(file).length !== 2 || file.path !== original[n]!.path || typeof file.ref !== "string")) return;
      const key = supportKey(binding, files);
      if (supportDirectories.has(key)) replace(index, Number(span.start), Number(span.end), "");
      else supportDirectories.add(key);
    } catch { /* Author tags or damaged generated receipts never justify omission. */ }
  });
  // Prefer explicit complete instruction deliveries, then retain the first
  // native read when no delivery exists. Repeated prepare results are subject
  // to exactly the same scope/pin/hash proof as repeated native reads.
  injectedSnapshots(messages, (proof, index) => {
    if (!object(proof.delivery)) return;
    const key = JSON.stringify([proof.contentIdentity ?? proof.identity, proof.snapshotId, proof.bodySha256]);
    const location = JSON.stringify([index, proof.delivery.start, proof.delivery.end]);
    if (!seen.has(key)) { seen.set(key, location); return; }
    if (seen.get(key) === location) return;
    replace(index, Number(proof.delivery.start), Number(proof.delivery.end),
      proof.delivery.encoding === "json" ? JSON.stringify(entryConfirmation).slice(1, -1) : entryConfirmation);
  });
  messages.forEach((message, index) => {
    const proof = verifiedReadProof(message);
    if (!proof) return;
    const key = JSON.stringify([proof.contentIdentity ?? proof.identity, proof.snapshotId, proof.bodySha256]);
    if (!seen.has(key)) { seen.set(key, String(index)); return; }
    replace(index, 0, readProofEnd(proof, message), entryConfirmation);
  });
  const resources = new Set<string>();
  messages.forEach((message, index) => {
    const proof = verifiedResourceReadProof(message);
    if (proof) {
      const fileIdentity = proof.file_id === undefined ? ["path", proof.path] : ["file_id", proof.file_id];
      const key = JSON.stringify([proof.scope, proof.id, proof.snapshot_id, fileIdentity, proof.sha256]);
      if (!resources.has(key)) resources.add(key);
      else if (proof.bytes !== 0) replace(index, 0, proof.version === 2 && object(proof.delivery) ? Number(proof.delivery.end) : sourceMessageText(message.content).length, resourceConfirmation);
      return;
    }
    const batch = verifiedResourceBatchProof(message);
    if (!batch) return;
    for (const file of batch.files) {
      if (!file.delivered_complete_text || !file.delivery) continue;
      const fileIdentity = file.file_id === undefined ? ["path", file.path] : ["file_id", file.file_id];
      const key = JSON.stringify([batch.selection.scope, batch.selection.owner, batch.selection.snapshot_id, fileIdentity, file.sha256]);
      if (!resources.has(key)) { resources.add(key); continue; }
      // An empty source is already minimal. Its zero-length span is still fully
      // proved; adding a confirmation would only increase model context.
      if (file.bytes !== 0) replace(index, file.delivery.start, file.delivery.end, JSON.stringify(resourceConfirmation).slice(1, -1));
    }
  });
  return replacements.size ? projectDeliverySpans(messages, replacements, "deduplicate", omittedDirectories) : messages;
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
export function projectSelectedSourceMessages(messages: AgentMessage[], selection: SessionSelection,
  unavailable?: (scope: string, id: string) => boolean): AgentMessage[] {
  const replacements = new Map<number, Replacement[]>();
  function identityRetired(scopeId: string, id: string, snapshotId: unknown, bodySha256?: unknown): "unavailable" | "superseded" | undefined {
    if (unavailable?.(scopeId, id)) return "unavailable";
    const scope = selection.scopes.get(scopeId);
    if (!scope) return undefined;
    const binding = scope.bindings.get(id);
    return (binding ? binding.snapshot_id !== snapshotId || bodySha256 !== undefined && binding.body_sha256 !== bodySha256 : scope.retired.has(id)) ? "superseded" : undefined;
  }
  function retired(proof: Record<string, unknown>): "unavailable" | "superseded" | undefined {
    let identity: unknown;
    try { identity = JSON.parse(String(proof.contentIdentity ?? proof.identity)); } catch { return undefined; }
    if (!Array.isArray(identity)) return undefined;
    const scopeId = identity.length === 2 ? identity[0] : identity[1], id = identity.length === 2 ? identity[1] : identity[4];
    if (typeof scopeId !== "string" || typeof id !== "string") return undefined;
    return identityRetired(scopeId, id, proof.snapshotId, proof.bodySha256);
  }
  function add(index: number, start: number, end: number, encoding: unknown, reason: "unavailable" | "superseded") {
    const text = reason === "unavailable" ? "Source access is no longer available in the current scope. These verified source bytes are withheld from this request."
      : "An explicit new selection superseded these Skill instructions. Use the currently selected graph and its fixed references.";
    const replacement = { start, end, text: encoding === "json" ? JSON.stringify(text).slice(1, -1) : text };
    const list = replacements.get(index) ?? [];
    if (!list.some(item => item.start === start && item.end === end)) list.push(replacement);
    replacements.set(index, list);
  }
  injectedSnapshots(messages, (proof, index) => {
    const reason = retired(proof);
    if (reason && object(proof.delivery)) add(index, Number(proof.delivery.start), Number(proof.delivery.end), proof.delivery.encoding, reason);
  });
  for (const [index, message] of messages.entries()) {
    const proof = verifiedReadProof(message);
    const reason = proof && retired(proof);
    if (proof && reason) add(index, 0, readProofEnd(proof, message), "raw", reason);
    const resource = verifiedResourceReadProof(message);
    const resourceReason = resource && identityRetired(String(resource.scope), String(resource.id), resource.snapshot_id);
    if (resource && resourceReason) {
      const text = sourceMessageText(message.content);
      const end = resource.version === 2 && object(resource.delivery) ? Number(resource.delivery.end) : text.length;
      const suffix = text.slice(end);
      // Retire the source, not this acquisition's outcome. A generated footer
      // must still match its operation receipt; never bless an arbitrary suffix.
      if (suffix) {
        const effects = object(message.details) ? message.details.effects : undefined;
        const footer = isConsumptionEffects(effects) ? "\n\n<notion-effects>" + JSON.stringify(effects) + "</notion-effects>" : undefined;
        if (!footer || suffix !== footer && suffix !== "\n" + footer)
          throw Object.assign(new Error("Resource result footer is inconsistent"), { code: "SOURCE_CONTEXT_PROJECTION_INVALID" });
      }
      add(index, 0, end, "raw", resourceReason);
    }
    const batch = verifiedResourceBatchProof(message);
    const batchReason = batch && identityRetired(batch.selection.scope, batch.selection.owner, batch.selection.snapshot_id);
    if (batch && batchReason) for (const file of batch.files)
      if (file.delivered_complete_text && file.delivery) add(index, file.delivery.start, file.delivery.end, "json", batchReason);
  }
  return replacements.size ? projectDeliverySpans(messages, replacements, "supersede") : messages;
}
