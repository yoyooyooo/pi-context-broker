import { createHash } from "node:crypto";
import type { AgentMessage, MessageContent, ProjectedSessionEntry } from "./types";
import { projectSelectedSourceMessages, sourceMessageText, withSessionSourceReceipts } from "./session-source-snapshot";
import { isConsumptionEffects } from "./consumption-effects";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const withheld = "Context Broker could not verify these Skill instructions. They were not loaded for this request. Continue the user's request without relying on them.";
const sourceTool = (message: AgentMessage) => {
  const details = message.details;
  return message.role === "toolResult" && (message.toolName === "notion_use" || message.toolName === "skill_prepare"
    || object(details) && ["contextBrokerRead", "contextBrokerPreparation", "contextBrokerResource"].some(key => key in details));
};
const sourceCustom = (message: AgentMessage) => message.role === "custom"
  && (message.customType?.startsWith("context-broker") || message.customType === "skill-prompt-message");

/** Retire Broker instructions without changing the user's conversation. Native
 * user entries undo our append; inline receipts remain until their owned spans
 * have been removed, including when session projection is unavailable. */
export function withoutBrokerInstructions(messages: AgentMessage[], entries: readonly ProjectedSessionEntry[] = []): AgentMessage[] {
  const originalUsers = new Map<string, AgentMessage>();
  const userKey = (message: AgentMessage) => hash(JSON.stringify([message.timestamp ?? null, message.content]));
  const receipts = new Set(entries.flatMap(({ sourceEntry }) => sourceEntry.type === "custom" && sourceEntry.customType === "context-broker"
    && object(sourceEntry.data) && typeof sourceEntry.data.nativePromptSha256 === "string" ? [sourceEntry.data.nativePromptSha256] : []));
  for (const { sourceEntry, messages: projected } of entries) {
    if (sourceEntry.type !== "message" || sourceEntry.message?.role !== "user") continue;
    for (const message of projected) if (message.role === "user") {
      const digest = hash(sourceMessageText(message.content));
      // A resumed host may expose the already edited message as sourceEntry.
      // That is not an original input and must not restore the retired body.
      if (receipts.has(digest) && hash(sourceMessageText(sourceEntry.message.content)) !== digest)
        originalUsers.set(userKey(message), sourceEntry.message);
    }
  }
  const stripped = messages.map((message): AgentMessage => {
    if (!sourceTool(message)) return message;
    const effects = object(message.details) && isConsumptionEffects(message.details.effects) ? message.details.effects : undefined;
    return { ...message, isError: true, content: withheld + (effects ? "\n\n<notion-effects>" + JSON.stringify(effects) + "</notion-effects>" : ""),
      details: effects ? { effects } : undefined };
  });
  // Receipt validation never treats arbitrary user quotations as owned bytes.
  return projectSelectedSourceMessages(withSessionSourceReceipts(stripped, entries), { scopes: new Map() }, () => "unavailable")
    .map((message, index) => message.role === "user" && messages[index]
      ? originalUsers.get(userKey(messages[index]!)) ?? message : message)
    .filter(message => !sourceCustom(message));
}

type WireKind = "chat" | "anthropic" | "responses" | "google" | "bedrock" | "pi";
type NativeMessage = Record<string, unknown>;
const records = (value: unknown): value is NativeMessage[] => Array.isArray(value) && value.every(object);
const nativeText = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value)
  ? value.filter(object).filter(part => typeof part.text === "string").map(part => part.text).join("\n") : "";
const contentOf = (message: NativeMessage, kind: WireKind) => kind === "google" ? message.parts : message.content;
const visibleUser = (message: AgentMessage) => (message.role === "user" || message.role === "custom")
  && (typeof message.content === "string" ? message.content.length > 0 : (message.content?.length ?? 0) > 0);
function imageKey(part: unknown): string | undefined {
  if (!object(part)) return undefined;
  if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") return `data:${part.mimeType};base64,${part.data}`;
  if (part.type === "image_url" && object(part.image_url) && typeof part.image_url.url === "string") return part.image_url.url;
  if (part.type === "input_image" && typeof part.image_url === "string") return part.image_url;
  if (part.type === "image" && object(part.source) && typeof part.source.data === "string" && typeof part.source.media_type === "string") return `data:${part.source.media_type};base64,${part.source.data}`;
  if (object(part.inlineData) && typeof part.inlineData.data === "string" && typeof part.inlineData.mimeType === "string") return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
  if (object(part.image) && typeof part.image.format === "string" && object(part.image.source) && part.image.source.bytes instanceof Uint8Array)
    return `data:image/${part.image.format};base64,${Buffer.from(part.image.source.bytes).toString("base64")}`;
  return undefined;
}
const imageKeys = (content: unknown): string[] => Array.isArray(content) ? content.map(imageKey).filter((key): key is string => key !== undefined) : [];

function textPart(kind: WireKind, text: string): NativeMessage {
  return kind === "google" || kind === "bedrock" ? { text } : { type: kind === "responses" ? "input_text" : "text", text };
}
function userMessage(kind: WireKind, content: MessageContent | undefined): NativeMessage {
  const parts = typeof content === "string" ? [textPart(kind, content)] : (content ?? []).flatMap((part): NativeMessage[] => {
    if (part.type === "text") return [textPart(kind, part.text)];
    if (typeof part.data !== "string" || typeof part.mimeType !== "string") return [];
    if (kind === "chat") return [{ type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } }];
    if (kind === "responses") return [{ type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` }];
    if (kind === "anthropic") return [{ type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } }];
    if (kind === "google") return [{ inlineData: { mimeType: part.mimeType, data: part.data } }];
    if (kind === "bedrock" && /^image\/(?:png|jpeg|gif|webp)$/.test(part.mimeType))
      return [{ image: { format: part.mimeType.slice(6), source: { bytes: Buffer.from(part.data, "base64") } } }];
    if (kind === "pi") return [part];
    return [];
  });
  return kind === "google" ? { role: "user", parts } : { role: "user", content: parts };
}

function replaceUserText(message: NativeMessage, after: AgentMessage, kind: WireKind): NativeMessage {
  const original = contentOf(message, kind), text = sourceMessageText(after.content);
  if (typeof original === "string") return { ...message, content: text };
  if (!Array.isArray(original)) return userMessage(kind, after.content);
  // Preserve each native image and its settings. Only text is Broker-owned;
  // ordinary user messages never enter this branch.
  let replaced = false;
  const content = original.flatMap((part): unknown[] => {
    if (!object(part) || typeof part.text !== "string") return [part];
    if (replaced) return [];
    replaced = true;
    return text ? [{ ...part, text }] : [];
  });
  if (!replaced && text) content.unshift(textPart(kind, text));
  return { ...message, [kind === "google" ? "parts" : "content"]: content };
}
function userSlot(message: NativeMessage, previous: NativeMessage | undefined, kind: WireKind): boolean {
  if (message.role !== "user") return false;
  const content = contentOf(message, kind);
  if (Array.isArray(content) && content.some(part => object(part) && (part.type === "tool_result" || object(part.toolResult) || object(part.functionResponse)))) return false;
  const text = nativeText(content);
  // These image turns are emitted by Pi's serializers for tool output, not by
  // the user. Keep their native image schema and position intact.
  if (kind === "chat" && text === "Attached image(s) from tool result:"
    && (previous?.role === "tool" || previous?.role === "assistant")) return false;
  if (kind === "google" && text === "Tool result image:") return false;
  return true;
}

/** Patch the host's actual message slots. Do not rebuild assistant/tool history
 * or search and replace across the payload: both would alter user quotations,
 * tool schemas, image blocks or provider signatures. */
function repairMessages(actual: NativeMessage[], original: readonly AgentMessage[], safe: readonly AgentMessage[], kind: WireKind): NativeMessage[] {
  const toolChanges = new Map<string, string>();
  const withheldImages = new Set(original.filter(sourceTool).flatMap(message => Array.isArray(message.content)
    ? message.content.map(imageKey).filter((key): key is string => key !== undefined) : []));
  for (const message of original) if (sourceTool(message) && message.toolCallId) {
    const after = safe.find(item => item.role === "toolResult" && item.toolCallId === message.toolCallId);
    const text = sourceMessageText(after?.content) || withheld;
    toolChanges.set(kind === "responses" ? message.toolCallId.split("|")[0]! : message.toolCallId, text);
  }
  const logicalUsers = original.filter(visibleUser), safeUsers = safe.filter(message => message.role === "user");
  let userIndex = 0;
  const changes = logicalUsers.map(message => {
    if (message.role === "user") return { before: message, after: safeUsers[userIndex++] ?? message };
    if (message.customType === "context-broker-preparation-warning") return { before: message,
      after: safe.find(item => item.customType === message.customType && sourceMessageText(item.content) === sourceMessageText(message.content)) };
    return { before: message, after: sourceCustom(message) ? undefined : message };
  });
  const changedText = new Set(changes.filter(({ before, after }) => !after || sourceMessageText(before.content) !== sourceMessageText(after.content))
    .map(({ before }) => sourceMessageText(before.content)).filter(Boolean));
  const assistantTexts = new Set(original.filter(message => message.role === "assistant").map(message => sourceMessageText(message.content)));
  const unexpectedAssistant = new Set(actual.flatMap((message, index) => {
    if (message.role !== "assistant" && message.role !== "model") return [];
    const text = nativeText(contentOf(message, kind));
    // A mutable hook can change a protected user/source message's role. That
    // does not turn it into an assistant message produced by the model.
    return text && changedText.has(text) && !assistantTexts.has(text) ? [index] : [];
  }));
  const slots = actual.flatMap((message, index) => userSlot(message, actual[index - 1], kind) ? [index] : []);
  const replacements = new Map<number, AgentMessage | undefined>();
  const retained = new Set<number>(), matched = new Set<AgentMessage>();
  // A later hook may reorder or change the role of a source message. Equal
  // message counts do not prove ownership; anchor user text and images instead.
  for (const { before, after } of changes) {
    if (!after) continue;
    const expectedImages = JSON.stringify(imageKeys(before.content));
    const slot = slots.find(index => !retained.has(index) && nativeText(contentOf(actual[index]!, kind)) === sourceMessageText(before.content)
      && JSON.stringify(imageKeys(contentOf(actual[index]!, kind))) === expectedImages);
    if (slot === undefined) continue;
    retained.add(slot); matched.add(before);
    if (sourceMessageText(before.content) !== sourceMessageText(after.content)) replacements.set(slot, after);
  }
  for (const slot of slots) if (!retained.has(slot)) replacements.set(slot, undefined);
  const mixedContents = new Map<number, unknown[]>();
  // Pi itself keeps ordinary users separate from tool-result groups. If a later
  // hook combines them, preserve native tool/image blocks and only the text
  // anchored to a real user/custom message. Unbound Skill text is withheld.
  for (const [index, message] of actual.entries()) {
    const content = contentOf(message, kind);
    if (message.role !== "user" || !Array.isArray(content) || !content.some(part => object(part)
      && (part.type === "tool_result" || object(part.toolResult) || object(part.functionResponse)))) continue;
    const textIndices = new Map<number, string>();
    const images = imageKeys(content);
    for (const { before, after } of changes) {
      if (!after || matched.has(before) || !imageKeys(before.content).every(key => images.includes(key))) continue;
      const full = sourceMessageText(before.content);
      if (!full && imageKeys(before.content).length) { matched.add(before); continue; }
      const exact = content.findIndex(part => object(part) && part.text === full);
      if (exact >= 0) { textIndices.set(exact, sourceMessageText(after.content)); matched.add(before); continue; }
      if (sourceMessageText(after.content) !== full) continue;
      const parts = typeof before.content === "string" ? [before.content] : (before.content ?? []).filter(part => part.type === "text").map(part => part.text);
      const indices = parts.map(text => content.findIndex(part => object(part) && part.text === text));
      if (indices.length && indices.every(value => value >= 0)) {
        indices.forEach((value, partIndex) => textIndices.set(value, parts[partIndex]!)); matched.add(before);
      }
    }
    if (changedText.size) mixedContents.set(index, content.flatMap((part, partIndex): unknown[] => {
      if (!object(part) || typeof part.text !== "string") return [part];
      const text = textIndices.get(partIndex);
      return text === undefined ? [] : [{ ...part, text }];
    }));
  }
  let googleToolIndex = 0;
  const originalTools = original.filter(message => message.role === "toolResult");
  const replaceToolBlocks = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    let changed = false;
    const next = value.map(part => {
      if (!object(part)) return part;
      if (kind === "anthropic" && part.type === "tool_result" && typeof part.tool_use_id === "string") {
        const text = toolChanges.get(part.tool_use_id);
        if (text !== undefined) { changed = true; return { ...part, content: text, is_error: true }; }
      }
      if (kind === "bedrock" && object(part.toolResult) && typeof part.toolResult.toolUseId === "string") {
        const text = toolChanges.get(part.toolResult.toolUseId);
        if (text !== undefined) { changed = true; return { ...part, toolResult: { ...part.toolResult, content: [{ text }], status: "error" } }; }
      }
      if (kind === "google" && object(part.functionResponse)) {
        const expected = originalTools[googleToolIndex++], response = part.functionResponse;
        const id = typeof response.id === "string" ? response.id : response.name === expected?.toolName ? expected.toolCallId : undefined;
        const text = id ? toolChanges.get(id) : undefined;
        if (text !== undefined) {
          changed = true;
          const { parts: _images, ...metadata } = response;
          return { ...part, functionResponse: { ...metadata, response: { error: text } } };
        }
      }
      return part;
    });
    return changed ? next : value;
  };
  const result = actual.flatMap((message, index): NativeMessage[] => {
    if (unexpectedAssistant.has(index)) return [];
    if (replacements.has(index)) {
      const after = replacements.get(index);
      return after ? [replaceUserText(message, after, kind)] : [];
    }
    const toolId = kind === "responses" ? message.call_id : kind === "pi" ? message.toolCallId : message.tool_call_id;
    const tool = kind === "responses" ? message.type === "function_call_output" || message.type === "custom_tool_call_output"
      : kind === "pi" ? message.role === "toolResult" : message.role === "tool";
    if (tool && typeof toolId === "string" && toolChanges.has(toolId)) return [{ ...message,
      [kind === "responses" ? "output" : "content"]: kind === "pi" ? [{ type: "text", text: toolChanges.get(toolId) }] : toolChanges.get(toolId),
      ...(kind === "pi" ? { isError: true } : {}) }];
    const key = kind === "google" ? "parts" : "content";
    let content = replaceToolBlocks(mixedContents.get(index) ?? message[key]);
    if (message.role === "user" && !userSlot(message, actual[index - 1], kind) && Array.isArray(content) && withheldImages.size) {
      const kept = content.filter(part => { const key = imageKey(part); return key === undefined || !withheldImages.has(key); });
      if (kept.length !== content.length) {
        if (!kept.some(part => imageKey(part) !== undefined) && kept.every(part => object(part) && typeof part.text === "string")) return [];
        content = kept;
      }
    }
    return [content === message[key] ? message : { ...message, [key]: content }];
  });
  for (const { before, after } of changes) if (before.role === "user" && after && !matched.has(before)) result.push(userMessage(kind, after.content));
  const originalCustom = new Set(original.filter(message => message.role === "custom").map(message => sourceMessageText(message.content)));
  for (const message of safe) if (message.role === "custom" && sourceMessageText(message.content) && !originalCustom.has(sourceMessageText(message.content))) {
    result.push(userMessage(kind, message.content));
  }
  return result;
}

/** Recognized public Pi serializers keep native transport fields intact. An
 * unknown provider shape is not guessed or rewritten recursively; it must use
 * the safe logical context established before serialization. Only the existing
 * OpenAI-completions wire ledger can confirm exact request-byte delivery. */
export function continueWithoutBrokerPayload(payload: unknown, original: readonly AgentMessage[], safe: readonly AgentMessage[], api?: string): unknown {
  if (!object(payload)) return payload;
  if (api === "pi-messages" && object(payload.context) && records(payload.context.messages))
    return { ...payload, context: { ...payload.context, messages: repairMessages(payload.context.messages, original, safe, "pi") } };
  if ((api === "google-generative-ai" || api === "google-vertex") && records(payload.contents))
    return { ...payload, contents: repairMessages(payload.contents, original, safe, "google") };
  if (["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(api ?? "") && records(payload.input))
    return { ...payload, input: repairMessages(payload.input, original, safe, "responses") };
  if (records(payload.messages)) {
    const kind = api === "openai-completions" ? "chat" : api === "anthropic-messages" ? "anthropic" : api === "bedrock-converse-stream" ? "bedrock" : undefined;
    if (kind) return { ...payload, messages: repairMessages(payload.messages, original, safe, kind) };
  }
  return payload;
}
