import { isSkillPreparationModel, type SkillPreparationModelRelation } from "./skill-context-projection";
import { validateSkillPrepareProjection } from "./skill-context-projection-proof";
import { sessionSourceBindings } from "./session-source-snapshot";
import type { PreparationBinding } from "./prepare-protocol";
import type { AgentMessage } from "./types";

export type CatalogDescription = SkillPreparationModelRelation & { source: string; scope: string };
type Identify = (card: CatalogDescription, canonical?: { id: string; ref: string }) => string | undefined;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function text(message: AgentMessage): string | undefined {
  if (typeof message.content === "string") return message.content;
  return message.content?.every(part => part.type === "text") ? message.content.map(part => part.text).join("\n") : undefined;
}

function directoryCards(value: unknown, canonical: unknown, source: string, scope: string, identify: Identify): string[] {
  if (!object(value) || !object(canonical) || Object.keys(value).some(key => !["files", "required", "candidates", "references"].includes(key))) return [];
  const cards: string[] = [];
  for (const group of ["files", "required", "candidates", "references"]) {
    const actual = value[group], expected = canonical[group];
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return [];
    for (const [index, item] of actual.entries()) {
      const original: unknown = expected[index];
      const fields = group === "files" ? ["path", "ref", "bytes"] : ["ref", "kind", "name", "description", "availability"];
      if (!object(item) || !object(original) || Object.keys(item).length !== fields.length || fields.some(key => !Object.hasOwn(item, key))
        || typeof item.ref !== "string" || typeof original.ref !== "string"
        || fields.some(key => key !== "ref" && item[key] !== original[key])) return [];
      if (group === "files") {
        if (typeof item.path !== "string" || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0) return [];
        continue;
      }
      if (typeof original.id !== "string" || typeof item.kind !== "string" || typeof item.name !== "string"
        || typeof item.description !== "string" || typeof item.availability !== "string") return [];
      const key = identify({ ref: item.ref, kind: item.kind, name: item.name, description: item.description,
        availability: item.availability, source, scope }, { id: original.id, ref: original.ref });
      if (key !== undefined) cards.push(key);
    }
  }
  return cards;
}

/** Only intact, currently visible preparation output can supply an existing card.
 * Author content, old activation receipts and arbitrary directory tags are opaque. */
function preparationCards(message: AgentMessage, identify: Identify): string[] {
  if (message.role !== "toolResult" || message.toolName !== "notion_use" || message.isError === true || !object(message.details)) return [];
  const proof = message.details.contextBrokerPreparation, content = text(message);
  if (!object(proof) || proof.version !== 2 || typeof message.toolCallId !== "string" || !message.toolCallId
    || proof.toolCallId !== message.toolCallId || content === undefined) return [];
  const projection = validateSkillPrepareProjection(content, proof.projection);
  if (!projection) return [];
  try {
    const model: unknown = JSON.parse(content);
    if (!isSkillPreparationModel(model) || !Array.isArray(proof.records)) return [];
    const receipts = proof.records;
    const scopes = new Map<string, ReturnType<typeof sessionSourceBindings>>();
    return model.records.flatMap((record, index) => {
      const delivered = projection.records[index];
      if (!record.directory || delivered?.state !== "source") return [];
      const identity: unknown = JSON.parse(delivered.source.identity);
      if (!Array.isArray(identity) || identity.length !== 5 || typeof identity[0] !== "string" || typeof identity[1] !== "string"
        || typeof identity[4] !== "string") return [];
      const [source, scope] = identity;
      let bindings = scopes.get(scope);
      if (!bindings) { bindings = sessionSourceBindings([message], scope); scopes.set(scope, bindings); }
      const binding = bindings.find(value => value.record.id === identity[4]);
      if (!binding || binding.body_sha256 !== delivered.source.sha256) return [];
      const receipt: unknown = receipts[index];
      return object(receipt) ? directoryCards(record.directory, receipt.directory, source, scope, identify) : [];
    });
  } catch { return []; }
}

function nativeCards(message: AgentMessage, input: { identify: Identify; matchesRead?: (ref: string, binding: PreparationBinding, identity: string) => boolean }): string[] {
  if (message.role !== "toolResult" || message.toolName !== "read" || message.isError === true || !object(message.details)) return [];
  const proof = message.details.contextBrokerRead, content = text(message);
  if (!object(proof) || proof.version !== 3 || proof.toolCallId !== message.toolCallId || !object(proof.delivery)
    || proof.delivery.start !== 0 || proof.delivery.encoding !== "raw" || !Number.isSafeInteger(proof.delivery.end)
    || content === undefined || typeof proof.identity !== "string") return [];
  try {
    const identity: unknown = JSON.parse(proof.identity);
    if (!Array.isArray(identity) || identity.length !== 5 || typeof identity[0] !== "string" || typeof identity[1] !== "string") return [];
    const [source, scope] = identity;
    const binding = sessionSourceBindings([message], scope).find(value => value.record.id === identity[4]);
    if (!binding || binding.body_sha256 !== proof.bodySha256) return [];
    const suffix = content.slice(Number(proof.delivery.end)), prefix = (typeof message.content === "string" ? "\n\n" : "\n\n\n") + "<skill-directory>\n", end = "\n</skill-directory>";
    if (!suffix.startsWith(prefix) || !suffix.endsWith(end)) return [];
    const encoded = suffix.slice(prefix.length, -end.length), footer: unknown = JSON.parse(encoded);
    if (!object(footer) || Object.keys(footer).length !== 2 || typeof footer.ref !== "string"
      || JSON.stringify(footer) !== encoded || !input.matchesRead?.(footer.ref, binding, proof.identity)) return [];
    return directoryCards(footer.directory, proof.directory, source, scope, input.identify);
  } catch { return []; }
}

function discovery(message: AgentMessage) {
  if (message.role !== "toolResult" || message.toolName !== "notion_list" || message.isError === true || !message.toolCallId
    || !object(message.details) || message.details.ok !== true || message.details.state !== "known" || !Array.isArray(message.details.records)) return undefined;
  const content = text(message);
  if (content === undefined) return undefined;
  const cards: CatalogDescription[] = [], full: Record<string, unknown>[] = [], thin: Record<string, unknown>[] = [];
  for (const record of message.details.records) {
    if (!object(record) || typeof record.id !== "string" || typeof record.ref !== "string" || typeof record.kind !== "string"
      || typeof record.name !== "string" || typeof record.description !== "string" || typeof record.source !== "string"
      || typeof record.scope !== "string" || typeof record.availability !== "string" || typeof record.in_default_view !== "boolean") return undefined;
    cards.push({ ref: record.ref, kind: record.kind, name: record.name, description: record.description,
      source: record.source, scope: record.scope, availability: record.availability });
    full.push(record);
    const { id: _id, scope: _scope, ...publicRecord } = record;
    thin.push(publicRecord);
  }
  // Match an actual original tool rendering, including its coverage and failures.
  // A summary, truncated result or independently rewritten JSON supplies no card.
  const records = JSON.stringify({ ...message.details, records: thin }) === content ? thin
    : JSON.stringify(message.details) === content ? full : undefined;
  return records ? { model: message.details, records, cards } : undefined;
}

/** Pure request projection. No remembered "seen" state and no source I/O.
 * The intact preparation directories win; all other locations retain their
 * relationship, name and exact reference. Every omitted description has an
 * identical complete card elsewhere in these same outgoing messages. */
export function projectCatalogDescriptions(input: {
  messages: readonly AgentMessage[];
  defaults: readonly CatalogDescription[];
  identify: Identify;
  matchesRead?: (ref: string, binding: PreparationBinding, identity: string) => boolean;
}): { messages: readonly AgentMessage[]; omittedDefaults: ReadonlySet<string> } {
  const delivered = new Set(input.messages.flatMap(message => [...preparationCards(message, input.identify), ...nativeCards(message, input)]));
  const complete = new Set(delivered);
  const omittedDefaults = new Set<string>();
  for (const card of input.defaults) {
    const key = input.identify(card);
    if (key === undefined) continue;
    if (delivered.has(key)) omittedDefaults.add(key);
    complete.add(key);
  }
  const messages = input.messages.map(message => {
    const result = discovery(message);
    if (!result) return message;
    let changed = false;
    const records = result.records.map((record, index) => {
      const card = result.cards[index];
      if (!card) return record;
      const key = input.identify(card);
      if (key === undefined) return record;
      if (!complete.has(key)) { complete.add(key); return record; }
      changed = true;
      const { description: _description, ...remaining } = record;
      return remaining;
    });
    if (!changed) return message;
    const content = JSON.stringify({ ...result.model, records });
    return { ...message, content: typeof message.content === "string" ? content
      : message.content?.map(part => part.type === "text" ? { ...part, text: content } : part) };
  });
  return { messages, omittedDefaults };
}
