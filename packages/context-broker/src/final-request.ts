import { createHash, type Hash } from "node:crypto";
import diagnostics from "node:diagnostics_channel";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "./types";

/** Logical provider acceptance, turn completion, and persistence stay separate.
 * This ledger only records whether the normal openai-completions HTTP entity
 * that Undici actually sent matches the digest bound for the current run. */
export const FINAL_REQUEST_LIMIT = 32;
const ERROR_LIMIT = 8;
const SOURCE_LIMIT = 8;
const LISTENER_LIMIT = 32;
const CHANNELS = ["create", "bodyChunkSent", "bodySent", "headers", "error", "trailers"] as const;
type ChannelName = typeof CHANNELS[number];

export type FinalRequestCoverage =
  | "openai-completions-undici"
  | "unsupported-api"
  | "unsupported-payload"
  | "unsupported-transport"
  | "unobserved"
  | "unknown";

export type FinalRequestDisposition =
  | "checked"
  | "dispatched"
  | "wire-confirmed"
  | "mismatch"
  | "logical-only"
  | "unsupported";

export type FinalRequestView = {
  id: number;
  generation: number;
  owner: number;
  sessionSha256: string | null;
  coverage: FinalRequestCoverage;
  disposition: FinalRequestDisposition;
  dispatched: boolean;
  endpointOriginSha256: string | null;
  endpointPathSha256: string | null;
  expectedEntitySha256: string | null;
  sentEntitySha256: string | null;
  sentEntityBytes: number | null;
  chunkCount: number | null;
  attempts: number;
  httpStatus: number | null;
  logicalProviderStatus: number | null;
  provider2xx: boolean | null;
  wireConfirmed: boolean;
  errors: string[];
  sources: FinalRequestSource[];
};

export type FinalRequestSource = {
  identitySha256: string;
  snapshot: string | null;
  bodySha256: string | null;
  state: "copied" | "reused" | "retired";
  remoteWrites: "none" | "retained" | "unknown" | null;
  authorContent: "unchanged" | "unknown" | null;
};

export type FinalRequestInput = {
  messages: readonly AgentMessage[];
  payload: unknown;
  api: string | undefined;
  baseUrl: string | undefined;
  sessionId: string | undefined;
  generation: number;
  signal: AbortSignal;
};

export type FinalRequestDecision = { block: boolean; code?: string };

type Pin = {
  id: number;
  generation: number;
  owner: number;
  signal: AbortSignal;
  sessionSha256: string | null;
  coverage: FinalRequestCoverage;
  disposition: FinalRequestDisposition;
  dispatched: boolean;
  rejected: boolean;
  origin: string | null;
  path: string | null;
  endpointOriginSha256: string | null;
  endpointPathSha256: string | null;
  expectedEntitySha256: string | null;
  sentEntitySha256: string | null;
  sentEntityBytes: number | null;
  chunkCount: number | null;
  attempts: number;
  httpStatus: number | null;
  logicalProviderStatus: number | null;
  provider2xx: boolean | null;
  wireConfirmed: boolean;
  errors: string[];
  sources: FinalRequestSource[];
  closed: boolean;
};

type Flight = {
  origin: string;
  path: string;
  relevant: boolean;
  hash: Hash;
  bytes: number;
  chunks: number;
  corrupt: boolean;
  sent: boolean;
  status: number | null;
  pinId: number | null;
};

const listeners = new Set<(name: ChannelName, event: unknown) => void>();
let channelsReady = false;

function ensureChannels(): void {
  if (channelsReady) return;
  channelsReady = true;
  for (const name of CHANNELS) {
    diagnostics.subscribe("undici:request:" + name, (event: unknown) => {
      for (const listener of listeners) {
        try { listener(name, event); }
        catch { /* The listener records its own observer fault. Unrelated traffic must not throw. */ }
      }
    });
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const messageText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(part => isObject(part) && part.type === "text").map(part => String(part.text ?? "")).join("\n");
};

function serializedToolContent(message: AgentMessage): string {
  const text = messageText(message.content);
  const hasImages = Array.isArray(message.content) && message.content.some(part => isObject(part) && part.type === "image");
  if (text.trim().length > 0) return text;
  return hasImages ? "(see attached image)" : "(no tool output)";
}

function receiptOnly(message: AgentMessage): boolean {
  return message.role === "custom" && message.customType === "context-broker" && messageText(message.content).length === 0
    && isObject(message.details) && "nativePromptSha256" in message.details;
}

function sourceTool(message: AgentMessage): boolean {
  if (message.role !== "toolResult") return false;
  if (isObject(message.details) && ("contextBrokerRead" in message.details || "contextBrokerPreparation" in message.details
    || "contextBrokerResource" in message.details || "effects" in message.details)) return true;
  return message.toolName === "notion_use" || message.toolName === "skill_prepare" || message.toolName === "notion_list"
    || message.toolName === "skill_search" || message.toolName === "notion_ctl" || message.toolName === "skill_graph";
}

const SNAPSHOT_PIN = /^(?:s_|local_)[a-f0-9]{64}$/;
const HEX_HASH = /^[a-f0-9]{64}$/;
const snapshotPin = (value: unknown): string | null => typeof value === "string" && SNAPSHOT_PIN.test(value) ? value : null;
const hexHash = (value: unknown): string | null => typeof value === "string" && HEX_HASH.test(value) ? value : null;
const effectFields = (details: Record<string, unknown> | undefined): Pick<FinalRequestSource, "remoteWrites" | "authorContent"> => {
  const effects = details && isObject(details.effects) ? details.effects : undefined;
  const remoteWrites = effects && (effects.remote_writes === "none" || effects.remote_writes === "retained" || effects.remote_writes === "unknown") ? effects.remote_writes : null;
  const authorContent = effects && (effects.author_content === "unchanged" || effects.author_content === "unknown") ? effects.author_content : null;
  return { remoteWrites, authorContent };
};

function deliveryState(text: string, bodySha: string | null, bytes: unknown, deliveredComplete: unknown): FinalRequestSource["state"] {
  if (deliveredComplete === false || text === "Already available." || text === "Already loaded.") return "reused";
  if (bodySha && sha256(text) === bodySha) return "copied";
  if (bodySha && Number.isSafeInteger(bytes) && Number(bytes) >= 0) {
    const encoded = Buffer.from(text);
    if (Number(bytes) <= encoded.length && sha256(encoded.subarray(0, Number(bytes))) === bodySha) return "copied";
  }
  return "retired";
}

function effectsMarker(message: AgentMessage): string | undefined {
  if (!isObject(message.details) || !isObject(message.details.effects)) return undefined;
  const writes = message.details.effects.remote_writes;
  return writes === "none" || writes === "retained" || writes === "unknown" ? `"remote_writes":"${writes}"` : undefined;
}

/** Hashed identity, fixed snapshot pin, and sanitized effect flags. No body, path, ref, or page id. */
export function finalRequestSources(messages: readonly AgentMessage[]): { sources: FinalRequestSource[]; truncated: boolean } {
  const sources: FinalRequestSource[] = [];
  let truncated = false;
  const push = (source: FinalRequestSource): void => {
    if (sources.length >= SOURCE_LIMIT) { truncated = true; return; }
    sources.push(source);
  };
  for (const message of messages) {
    if (!sourceTool(message) || !isObject(message.details)) continue;
    const details = message.details;
    const text = messageText(message.content);
    const effects = effectFields(details);
    const resource = isObject(details.contextBrokerResource) ? details.contextBrokerResource : undefined;
    const read = isObject(details.contextBrokerRead) ? details.contextBrokerRead : undefined;
    const preparation = isObject(details.contextBrokerPreparation) ? details.contextBrokerPreparation : undefined;
    if (resource && Array.isArray(resource.files)) {
      const snapshot = snapshotPin(isObject(resource.selection) ? resource.selection.snapshot_id : undefined);
      for (const file of resource.files) {
        if (!isObject(file)) continue;
        const bodySha256 = hexHash(file.sha256);
        push({ identitySha256: sha256(bodySha256 ?? String(file.index ?? sources.length)), snapshot, bodySha256,
          state: file.delivered_complete_text === false || file.state === "replaced" ? "reused" : bodySha256 ? "copied" : "retired",
          ...effects });
      }
      continue;
    }
    if (resource) {
      const bodySha256 = hexHash(resource.sha256);
      push({ identitySha256: sha256(JSON.stringify([resource.scope ?? "", resource.id ?? "", resource.file_id ?? ""])),
        snapshot: snapshotPin(resource.snapshot_id), bodySha256, state: deliveryState(text, bodySha256, resource.bytes, resource.delivered_complete_text), ...effects });
      continue;
    }
    if (read) {
      const bodySha256 = hexHash(read.bodySha256);
      push({ identitySha256: sha256(String(read.identity ?? message.toolCallId ?? "")), snapshot: snapshotPin(read.snapshotId), bodySha256,
        state: deliveryState(text, bodySha256, read.bytes, undefined), ...effects });
      continue;
    }
    if (preparation && Array.isArray(preparation.records)) {
      const projection = isObject(preparation.projection) ? preparation.projection : undefined;
      const mappings = projection && Array.isArray(projection.records) ? projection.records : [];
      for (const [index, receipt] of preparation.records.entries()) {
        if (!isObject(receipt)) continue;
        const binding = isObject(receipt.binding) ? receipt.binding : undefined;
        const mapping = isObject(mappings[index]) ? mappings[index] : undefined;
        push({ identitySha256: sha256(String(receipt.identity ?? message.toolCallId ?? "")),
          snapshot: snapshotPin(binding?.snapshot_id ?? receipt.snapshotId), bodySha256: hexHash(receipt.bodySha256),
          state: mapping?.state === "replaced" ? "reused" : mapping?.state === "source" ? "copied" : "retired", ...effects });
      }
      continue;
    }
    if (preparation || effects.remoteWrites) {
      push({ identitySha256: sha256(String(message.toolCallId ?? message.toolName ?? "tool")), snapshot: null, bodySha256: null,
        state: text === "Already loaded." || text === "Already available." ? "reused" : text.length > 0 ? "copied" : "retired", ...effects });
    }
  }
  return { sources, truncated };
}

const BROKER_CUSTOM = new Set(["context-broker", "skill-prompt-message", "context-broker-task", "context-broker-unavailable"]);

function brokerTexts(messages: readonly AgentMessage[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.role === "user" && isObject(message.details) && Array.isArray(message.details.records)
      && message.details.records.some(item => isObject(item) && isObject(item.delivery))) {
      const text = messageText(message.content);
      if (text.length > 0) texts.push(text);
      continue;
    }
    if (message.role !== "custom" || receiptOnly(message) || message.customType === "context-broker-consumption-effects") continue;
    const type = message.customType ?? "";
    if (!BROKER_CUSTOM.has(type) && !type.startsWith("context-broker-")) continue;
    const text = messageText(message.content);
    if (text.length > 0) texts.push(text);
  }
  return texts;
}

function effectTexts(messages: readonly AgentMessage[]): string[] {
  return messages.filter(message => message.role === "custom" && message.customType === "context-broker-consumption-effects")
    .map(message => messageText(message.content)).filter(text => text.length > 0);
}

function countTexts(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

type ToolPair = { id: string; content: string; source: boolean; effectsMarker?: string };

/** Compare serialized provider tool messages with the context the broker already
 * captured. Identity is toolCallId, not text similarity. */
export function assessFinalRequestPayload(messages: readonly AgentMessage[], payload: unknown): string | undefined {
  if (!isObject(payload) || !Array.isArray(payload.messages) || payload.messages.some(item => !isObject(item))) return "UNSUPPORTED_PAYLOAD";
  const payloadMessages = payload.messages;
  const payloadTexts = payloadMessages.filter(message => message.role === "user").map(message => messageText(message.content));
  const actualCounts = countTexts(payloadTexts);
  const protectedTexts = new Set([...effectTexts(messages), ...brokerTexts(messages)]);
  // Ordinary user quotations remain separate occurrences, even when their text
  // happens to equal an owned generated object.
  const originalCounts = countTexts(messages.filter(message => message.role === "user" || message.role === "custom")
    .map(message => messageText(message.content)));
  const effectsTexts = new Set(effectTexts(messages));
  for (const text of protectedTexts) {
    const expected = originalCounts.get(text) ?? 0;
    const actual = actualCounts.get(text) ?? 0;
    if (actual < expected) return effectsTexts.has(text) ? "DROPPED_EFFECTS" : "LOST_SOURCE_RESULT";
    if (actual > expected) return "DUPLICATE_SOURCE_RESULT";
  }
  const tools = new Map<string, Record<string, unknown>>();
  let declared = false;
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const field of ["toolsRemoved", "toolsAdded"] as const) {
      const entries: unknown = Reflect.get(message, field);
      if (!Array.isArray(entries)) continue;
      declared = true;
      for (const tool of entries) {
        if (!isObject(tool) || typeof tool.name !== "string") return "UNSUPPORTED_PAYLOAD";
        if (field === "toolsRemoved") tools.delete(tool.name); else tools.set(tool.name, tool);
      }
    }
  }
  if (declared) {
    const actual: unknown = payload.tools ?? [];
    if (!Array.isArray(actual) || actual.length !== tools.size) return "MODIFIED_TOOL_SCHEMA";
    for (const [index, tool] of [...tools.values()].entries()) {
      const converted = actual[index];
      if (!isObject(converted) || converted.type !== "function" || !isObject(converted.function)
        || converted.function.name !== tool.name || converted.function.description !== tool.description) return "MODIFIED_TOOL_SCHEMA";
      // Strict or grammar conversion has a different provider contract; do not
      // mislabel it as this normal JSON-schema route's complete proof.
      if (isObject(tool.constrainedSampling) && tool.constrainedSampling.type !== "json_schema"
        || converted.function.strict === true) return "UNSUPPORTED_PAYLOAD";
      if (!isDeepStrictEqual(converted.function.parameters, JSON.parse(JSON.stringify(tool.parameters)))) return "MODIFIED_TOOL_SCHEMA";
    }
  }
  const expectedTools: ToolPair[] = messages.filter(message => message.role === "toolResult").map(message => ({
    id: typeof message.toolCallId === "string" ? message.toolCallId : "",
    content: serializedToolContent(message),
    source: sourceTool(message),
    effectsMarker: effectsMarker(message),
  }));
  const actualTools: ToolPair[] = payloadMessages.filter(message => message.role === "tool" && typeof message.tool_call_id === "string").map(message => ({
    id: String(message.tool_call_id),
    content: messageText(message.content),
    source: false,
  }));
  const used = new Set<number>();
  for (const item of expectedTools) {
    const exact = actualTools.findIndex((candidate, index) => !used.has(index) && candidate.id === item.id && candidate.content === item.content);
    if (exact >= 0) { used.add(exact); continue; }
    const sameId = actualTools.findIndex((candidate, index) => !used.has(index) && candidate.id === item.id);
    if (sameId >= 0) {
      if (item.effectsMarker && !actualTools[sameId]!.content.includes(item.effectsMarker)) return "DROPPED_EFFECTS";
      return item.source ? "MODIFIED_SOURCE_RESULT" : "MODIFIED_TOOL_RESULT";
    }
    return item.source ? "LOST_SOURCE_RESULT" : "LOST_TOOL_RESULT";
  }
  for (const [index, candidate] of actualTools.entries()) {
    if (used.has(index)) continue;
    const source = expectedTools.some(item => item.source && item.id === candidate.id);
    return source ? "DUPLICATE_SOURCE_RESULT" : "DUPLICATE_TOOL_RESULT";
  }
  return undefined;
}

export function openAICompletionsEndpoint(baseUrl: string | undefined): { origin: string; path: string } | undefined {
  if (!baseUrl) return undefined;
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { return undefined; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const pathname = url.pathname.replace(/\/+$/, "");
  const path = pathname.endsWith("/chat/completions") ? pathname : `${pathname}/chat/completions`;
  return { origin: url.origin, path: path.startsWith("/") ? path : `/${path}` };
}

function entityDigest(payload: unknown): { sha256: string; bytes: number } | undefined {
  let encoded: string;
  try { encoded = JSON.stringify(payload); }
  catch { return undefined; }
  if (typeof encoded !== "string") return undefined;
  return { sha256: sha256(encoded), bytes: Buffer.byteLength(encoded) };
}

function pushError(pin: Pin, code: string): void {
  if (!pin.errors.includes(code) && pin.errors.length < ERROR_LIMIT) pin.errors.push(code);
}

function viewOf(pin: Pin): FinalRequestView {
  return {
    id: pin.id,
    generation: pin.generation,
    owner: pin.owner,
    sessionSha256: pin.sessionSha256,
    coverage: pin.coverage,
    disposition: pin.disposition,
    dispatched: pin.dispatched,
    endpointOriginSha256: pin.endpointOriginSha256,
    endpointPathSha256: pin.endpointPathSha256,
    expectedEntitySha256: pin.expectedEntitySha256,
    sentEntitySha256: pin.sentEntitySha256,
    sentEntityBytes: pin.sentEntityBytes,
    chunkCount: pin.chunkCount,
    attempts: pin.attempts,
    httpStatus: pin.httpStatus,
    logicalProviderStatus: pin.logicalProviderStatus,
    provider2xx: pin.provider2xx,
    wireConfirmed: pin.wireConfirmed,
    errors: [...pin.errors],
    sources: pin.sources.map(source => ({ ...source })),
  };
}

function requestTarget(event: unknown): { request: object; origin: string; path: string } | undefined {
  if (!isObject(event) || !isObject(event.request)) return undefined;
  const origin = typeof event.request.origin === "string" ? event.request.origin : "";
  const rawPath = typeof event.request.path === "string" ? event.request.path : "";
  const path = rawPath.split(/[?#]/, 1)[0] ?? "";
  if (!origin || !path.startsWith("/")) return undefined;
  return { request: event.request, origin, path };
}

function chunkSize(hash: Hash, chunk: unknown): number | undefined {
  if (typeof chunk === "string") { hash.update(chunk); return Buffer.byteLength(chunk); }
  if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) { hash.update(chunk); return chunk.byteLength; }
  return undefined;
}

export type FinalRequestLedger = {
  inspect(input: FinalRequestInput): FinalRequestDecision;
  observeProvider(signal: AbortSignal, status: number, generation: number): { blocked: boolean };
  blocksConfirmation(signal: AbortSignal, generation: number): boolean;
  recent(): readonly FinalRequestView[];
  retire(): void;
  close(): void;
};

export function formatFinalRequestDiagnostic(ledger: Pick<FinalRequestLedger, "recent">): string {
  const rows = ledger.recent();
  const lines = [`context-broker request: ${rows.length} recent; wire proof is openai-completions over Node Undici only`];
  if (rows.length === 0) lines.push("no final-request records");
  for (const row of rows) {
    lines.push([
      `#${row.id}`,
      `gen=${row.generation}`,
      `owner=${row.owner}`,
      `session=${row.sessionSha256 ?? "-"}`,
      `coverage=${row.coverage}`,
      `disposition=${row.disposition}`,
      `dispatched=${row.dispatched}`,
      `provider2xx=${row.provider2xx === null ? "unknown" : row.provider2xx}`,
      `wire=${row.wireConfirmed}`,
      `http=${row.httpStatus ?? "-"}`,
      `logical=${row.logicalProviderStatus ?? "-"}`,
      `bytes=${row.sentEntityBytes ?? "-"}`,
      `chunks=${row.chunkCount ?? "-"}`,
      `attempts=${row.attempts}`,
      `origin=${row.endpointOriginSha256 ?? "-"}`,
      `path=${row.endpointPathSha256 ?? "-"}`,
      `expected=${row.expectedEntitySha256 ?? "-"}`,
      `sent=${row.sentEntitySha256 ?? "-"}`,
      `errors=${row.errors.join(",") || "-"}`,
      `sources=${row.sources.map(source => [source.identitySha256, source.state, source.snapshot ?? "-", source.bodySha256 ?? "-", source.remoteWrites ?? "-", source.authorContent ?? "-"].join(":")).join(";") || "-"}`,
    ].join(" "));
  }
  return lines.join("\n");
}

export function createFinalRequestLedger(): FinalRequestLedger {
  const recent: Pin[] = [];
  const open = new Set<Pin>();
  const flights = new WeakMap<object, Flight>();
  const owners = new WeakMap<AbortSignal, number>();
  let nextId = 1;
  let nextOwner = 1;
  let closed = false;
  let listening = false;

  const remember = (pin: Pin): void => {
    recent.push(pin);
    if (!pin.closed) open.add(pin);
    while (recent.length > FINAL_REQUEST_LIMIT) recent.shift();
    while (open.size > FINAL_REQUEST_LIMIT) {
      const oldest = open.values().next().value;
      if (!oldest) break;
      pushError(oldest, "RECORD_LIMIT");
      oldest.coverage = "unknown";
      oldest.closed = true;
      open.delete(oldest);
    }
  };

  const ownerOf = (signal: AbortSignal): number => {
    const existing = owners.get(signal);
    if (existing) return existing;
    const owner = nextOwner++;
    owners.set(signal, owner);
    return owner;
  };

  const finish = (pin: Pin): void => {
    pin.closed = true;
    open.delete(pin);
  };

  const supersede = (input: FinalRequestInput): void => {
    for (const pin of [...open]) {
      if (pin.dispatched || pin.signal !== input.signal || pin.generation !== input.generation) continue;
      pushError(pin, "SUPERSEDED");
      pin.coverage = "unknown";
      finish(pin);
    }
  };

  const arm = (input: FinalRequestInput, fields: Partial<Pin> & Pick<Pin, "coverage" | "disposition">): Pin => {
    const endpoint = fields.origin && fields.path ? { origin: fields.origin, path: fields.path } : undefined;
    supersede(input);
    const collected = finalRequestSources(input.messages);
    const pin: Pin = {
      id: nextId++,
      generation: input.generation,
      owner: ownerOf(input.signal),
      signal: input.signal,
      sessionSha256: input.sessionId ? sha256(input.sessionId) : null,
      coverage: fields.coverage,
      disposition: fields.disposition,
      dispatched: false,
      rejected: fields.rejected === true,
      origin: endpoint?.origin ?? null,
      path: endpoint?.path ?? null,
      endpointOriginSha256: endpoint ? sha256(endpoint.origin) : null,
      endpointPathSha256: endpoint ? sha256(endpoint.path) : null,
      expectedEntitySha256: fields.expectedEntitySha256 ?? null,
      sentEntitySha256: null,
      sentEntityBytes: null,
      chunkCount: null,
      attempts: 0,
      httpStatus: null,
      logicalProviderStatus: null,
      provider2xx: null,
      wireConfirmed: false,
      errors: [],
      sources: collected.sources,
      closed: fields.closed === true,
    };
    if (fields.errors) for (const code of fields.errors) pushError(pin, code);
    if (collected.truncated) pushError(pin, "SOURCE_PIN_LIMIT");
    if (pin.origin && !listening) {
      if (listeners.size >= LISTENER_LIMIT) { pushError(pin, "LISTENER_LIMIT"); pin.coverage = "unknown"; }
      else { listeners.add(onDiagnostic); listening = true; ensureChannels(); }
    }
    remember(pin);
    return pin;
  };

  const live = (origin: string, path: string): Pin[] => {
    const pins = [...open].filter(pin => pin.origin === origin && pin.path === path);
    const active = pins.filter(pin => !pin.signal.aborted);
    // An aborted check can still observe its own late send, but must not steal a newer live run.
    return active.length > 0 ? active : pins.filter(pin => pin.rejected);
  };

  const bindSent = (flight: Flight, sentSha: string): void => {
    const awaiting = live(flight.origin, flight.path).filter(pin => !pin.dispatched);
    const inflight = live(flight.origin, flight.path).filter(pin => pin.dispatched && !pin.wireConfirmed);
    if (awaiting.length > 1 || (awaiting.length > 0 && inflight.length > 0)) {
      for (const pin of [...awaiting, ...inflight]) { pin.coverage = "unknown"; pushError(pin, "CONCURRENT_UNBOUND"); }
      return;
    }
    const matched = awaiting.filter(pin => pin.expectedEntitySha256 === sentSha);
    const take = (pin: Pin, code?: string): void => {
      pin.dispatched = true;
      pin.sentEntitySha256 = sentSha;
      pin.sentEntityBytes = flight.bytes;
      pin.chunkCount = flight.chunks;
      pin.attempts = 1;
      pin.httpStatus = flight.status;
      flight.pinId = pin.id;
      if (code) pushError(pin, code);
      if (pin.rejected || code) pin.disposition = "mismatch";
      else pin.disposition = "dispatched";
    };
    if (matched.length === 1) { take(matched[0]); return; }
    if (matched.length > 1) {
      for (const pin of matched) { pin.coverage = "unknown"; pushError(pin, "CONCURRENT_UNBOUND"); }
      return;
    }
    const retries = live(flight.origin, flight.path).filter(pin => pin.dispatched && pin.disposition === "dispatched"
      && pin.expectedEntitySha256 === sentSha && pin.sentEntitySha256 === sentSha && !pin.rejected);
    if (retries.length === 1) { retries[0]!.attempts += 1; flight.pinId = retries[0]!.id; return; }
    if (awaiting.length === 0 && inflight.length === 1 && sentSha !== inflight[0]!.expectedEntitySha256) {
      const pin = inflight[0]!;
      pin.sentEntitySha256 = sentSha;
      pin.sentEntityBytes = flight.bytes;
      pin.chunkCount = flight.chunks;
      pin.attempts += 1;
      pin.disposition = "mismatch";
      pin.rejected = true;
      pushError(pin, "PAYLOAD_REWRITTEN");
      flight.pinId = pin.id;
      return;
    }
    if (awaiting.length === 1) { take(awaiting[0]!, "PAYLOAD_REWRITTEN"); return; }
    if (awaiting.length > 1) {
      for (const pin of awaiting) { pin.coverage = "unknown"; pushError(pin, "CONCURRENT_UNBOUND"); }
    }
  };

  const onDiagnostic = (name: ChannelName, event: unknown): void => {
    if (closed) return;
    try {
      if (name === "create") {
        const target = requestTarget(event);
        if (!target) return;
        const relevant = live(target.origin, target.path).length > 0;
        flights.set(target.request, {
          origin: target.origin, path: target.path, relevant, hash: createHash("sha256"),
          bytes: 0, chunks: 0, corrupt: false, sent: false, status: null, pinId: null,
        });
        return;
      }
      const target = requestTarget(event);
      const flight = target ? flights.get(target.request) : undefined;
      if (!flight?.relevant) return;
      if (name === "bodyChunkSent") {
        if (!isObject(event)) return;
        const size = chunkSize(flight.hash, event.chunk);
        if (size === undefined || !Number.isSafeInteger(flight.bytes + size)) { flight.corrupt = true; return; }
        flight.bytes += size;
        flight.chunks += 1;
        return;
      }
      if (name === "bodySent") {
        if (flight.sent) return;
        flight.sent = true;
        if (flight.corrupt || flight.chunks === 0) {
          const awaiting = live(flight.origin, flight.path).filter(pin => !pin.dispatched);
          if (awaiting.length === 1) {
            pushError(awaiting[0]!, flight.corrupt ? "CHUNK_UNREADABLE" : "EMPTY_ENTITY");
            awaiting[0]!.coverage = "unknown";
          }
          return;
        }
        bindSent(flight, flight.hash.digest("hex"));
        return;
      }
      if (name === "headers") {
        const response = isObject(event) ? event.response : undefined;
        const status = isObject(response) && Number.isInteger(response.statusCode) ? Number(response.statusCode) : null;
        flight.status = status;
        if (flight.pinId === null || status === null) return;
        const pin = [...open].find(item => item.id === flight.pinId);
        if (pin) pin.httpStatus = status;
        return;
      }
      if (name === "error" && flight.pinId !== null) {
        const pin = [...open].find(item => item.id === flight.pinId);
        if (pin) pushError(pin, "TRANSPORT_ERROR");
      }
    } catch {
      for (const pin of open) { pushError(pin, "OBSERVER_FAULT"); pin.coverage = "unknown"; }
    }
  };

  const openPin = (signal: AbortSignal, generation: number): Pin | undefined => {
    let found: Pin | undefined;
    for (const pin of open) if (pin.signal === signal && pin.generation === generation) found = pin;
    return found;
  };

  return {
    inspect(input) {
      if (closed) return { block: false };
      if (input.api !== "openai-completions") {
        if (input.api) arm(input, { coverage: "unsupported-api", disposition: "unsupported", errors: ["UNSUPPORTED_API"] });
        return { block: false };
      }
      const problem = isObject(input.payload) && Array.isArray(input.payload.messages) ? assessFinalRequestPayload(input.messages, input.payload) : "UNSUPPORTED_PAYLOAD";
      if (problem === "UNSUPPORTED_PAYLOAD") {
        arm(input, { coverage: "unsupported-payload", disposition: "unsupported", errors: ["UNSUPPORTED_PAYLOAD"] });
        return { block: false };
      }
      const entity = entityDigest(input.payload);
      const endpoint = openAICompletionsEndpoint(input.baseUrl);
      if (!entity) {
        arm(input, { coverage: "unsupported-payload", disposition: "unsupported", errors: ["UNSUPPORTED_PAYLOAD"] });
        return { block: false };
      }
      if (problem) {
        arm(input, {
          coverage: endpoint ? "openai-completions-undici" : "unsupported-transport",
          disposition: "mismatch",
          rejected: true,
          origin: endpoint?.origin,
          path: endpoint?.path,
          expectedEntitySha256: entity.sha256,
          errors: [problem],
        });
        return { block: true, code: problem };
      }
      if (!endpoint) {
        arm(input, { coverage: "unsupported-transport", disposition: "unsupported", expectedEntitySha256: entity.sha256, errors: ["UNSUPPORTED_TRANSPORT"] });
        return { block: false };
      }
      arm(input, {
        coverage: "openai-completions-undici",
        disposition: "checked",
        origin: endpoint.origin,
        path: endpoint.path,
        expectedEntitySha256: entity.sha256,
      });
      return { block: false };
    },
    observeProvider(signal, status, generation) {
      const pin = openPin(signal, generation);
      if (!pin) return { blocked: false };
      pin.logicalProviderStatus = Number.isInteger(status) ? status : null;
      pin.provider2xx = status >= 200 && status < 300;
      if (pin.rejected || pin.disposition === "mismatch" || pin.coverage === "unknown") {
        finish(pin);
        return { blocked: true };
      }
      const tied = pin.dispatched && pin.disposition === "dispatched" && pin.sentEntitySha256 === pin.expectedEntitySha256
        && pin.httpStatus === status && pin.provider2xx === true && !pin.signal.aborted;
      if (tied) {
        pin.disposition = "wire-confirmed";
        pin.wireConfirmed = true;
        finish(pin);
        return { blocked: false };
      }
      if (pin.dispatched && pin.sentEntitySha256 === pin.expectedEntitySha256 && pin.httpStatus === null && !pin.signal.aborted) {
        pushError(pin, "HEADER_UNOBSERVED");
        finish(pin);
        return { blocked: false };
      }
      if (pin.dispatched) {
        pushError(pin, pin.signal.aborted ? "SIGNAL_ABORTED" : "STATUS_UNBOUND");
        pin.coverage = "unknown";
        finish(pin);
        return { blocked: true };
      }
      if (pin.disposition === "checked") {
        pin.coverage = "unobserved";
        pin.disposition = "logical-only";
      }
      finish(pin);
      return { blocked: false };
    },
    blocksConfirmation(signal, generation) {
      const pin = openPin(signal, generation);
      return pin !== undefined && (pin.rejected || pin.disposition === "mismatch" || pin.coverage === "unknown");
    },
    recent: () => recent.map(viewOf),
    retire() {
      for (const pin of [...open]) {
        if (!pin.dispatched && pin.disposition === "checked") {
          pushError(pin, "RETIRED");
          pin.coverage = "unknown";
        }
        finish(pin);
      }
    },
    close() {
      closed = true;
      listeners.delete(onDiagnostic);
      this.retire();
    },
  };
}
