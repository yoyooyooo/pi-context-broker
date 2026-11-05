import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { recordIdentity } from "../src/discovery-records";
import { compileSkillPreparation, renderSkillPreparationModel } from "../src/skill-context-projection";
import { deriveSkillPrepareProjection, validateSkillPrepareProjection } from "../src/skill-context-projection-proof";
import { deduplicateSourceReads, projectSelectedSourceMessages, sessionSourceBindings, sourceBodyLoaded, sourceDeliveryReceipt, sourceMessageText } from "../src/session-source-snapshot";
import type { PreparationBinding } from "../src/prepare-protocol";
import type { AgentMessage, ContentRecord, SkillRecord } from "../src/types";

const hash = (text: string) => createHash("sha256").update(text).digest("hex"), scope = "a".repeat(64);
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
}
function record(name: string, body: string): SkillRecord & { preparationBinding: PreparationBinding; body: string } {
  const id = "shared_skill:projection:" + name, ref = "skill://" + encodeURIComponent(id) + "/SKILL.md";
  const metadata: ContentRecord = { id, kind: "skill", name, alias: name, description: name, default_context: false,
    entrypoint: "SKILL.md", ref, locator: { type: "shared_skill", library_id: "projection", skill_id: name,
      database_id: "db", data_source_id: "data", page_id: name } };
  const snapshotId = "s_" + hash(name + body);
  return { ...metadata, source: "notion", sourceId: "controlled", sourceScope: scope, body, snapshotId, versionId: hash(body),
    path: "/immutable/" + name + "/SKILL.md", aliases: [], normalizedAliases: [], normalizedName: name,
    normalizedDescription: name, autoloadEnabled: false,
    preparationBinding: { record: metadata, scope, snapshot_id: snapshotId, version_id: hash(body), body_sha256: hash(body), ref: ref + "?snapshot=" + snapshotId } };
}
const alpha = record("alpha", '\ufeff---\r\nname: alpha\r\n---\r\n## Members\r\n作者 <body> 标记和 "content":\\ 引号。🧭\r\n```json\r\n{"graphs":"author-owned"}\r\n```\r\n');
const beta = record("beta", "不同的完整正文。\n" + alpha.body);
function preparation(records = [alpha, beta], toolCallId = "prepare") {
  const refs = records.map(value => value.preparationBinding.ref);
  const compiled = compileSkillPreparation({ purpose: "use", roots: refs, records: records.map(value => ({
    name: value.name, kind: value.kind!, ref: value.preparationBinding.ref, content: value.body,
    source: { identity: recordIdentity(value), sha256: hash(value.body), bytes: Buffer.byteLength(value.body) },
  })) });
  const vector = { version: 1 as const, kind: "observed_version_vector" as const, purpose: "use" as const, scope,
    roots: records.map(value => value.id!).sort(), required: [], bindings: records.map(value => value.preparationBinding) };
  const receipts = records.map((value, index) => sourceDeliveryReceipt(value, compiled.content, "json", compiled.bodySpans[index]!.start)!);
  const details = { contextBrokerPreparation: { version: 2, toolCallId, purpose: "use", records: receipts,
    graphs: [{ scope, roots: vector.roots, graph_lock: { ...vector, sha256: hash(canonical(vector)) },
      budget: { maxNodes: 64, maxDepth: 16, maxInstructionBytes: 1048576, maxContextBytes: 262144 },
      usage: { prepared_nodes: records.length, instruction_bytes: records.reduce((n, value) => n + Buffer.byteLength(value.body), 0),
        context_bytes: Buffer.byteLength(compiled.content), max_depth: 0 } }], projection: compiled.projection } };
  return { role: "toolResult", toolName: "skill_prepare", toolCallId, isError: false,
    content: [{ type: "text" as const, text: compiled.content }], details };
}

test("compiled preparation proves each complete source against its actual tool text and canonical graph", () => {
  const message = preparation(), text = sourceMessageText(message.content), projection = message.details.contextBrokerPreparation.projection;
  expect(validateSkillPrepareProjection(text, projection)).toBe(projection);
  for (const value of [alpha, beta]) expect(sourceBodyLoaded([message], value)).toBe(true);
  expect(sessionSourceBindings([message], scope).map(binding => binding.record.id)).toEqual([alpha.id!, beta.id!]);
  const first = projection.records[0]!;
  expect(first.source.sha256).toBe(hash(alpha.body));
  expect(first.rendered.sha256).toBe(hash(text.slice(first.delivery.start, first.delivery.end)));
  expect(first.rendered.bytes).not.toBe(first.source.bytes);
  expect(JSON.parse(text).records[0].content).toBe(alpha.body);
});

test("unknown compiler, bad hashes, mismatched mappings and partial tool output cannot become loaded", () => {
  const original = preparation();
  const changed = (mutate: (value: ReturnType<typeof preparation>) => void) => { const value = structuredClone(original); mutate(value); return value; };
  const invalid: AgentMessage[] = [
    { ...original, content: "compacted" }, { ...original, role: "user" }, { ...original, toolCallId: "other" },
    { ...original, isError: true }, { ...original, details: undefined },
    { ...original, content: [...original.content, { type: "image", data: "AA==" }] },
    changed(value => { value.details.contextBrokerPreparation.version = 3; }),
    changed(value => { value.details.contextBrokerPreparation.version = 1; }),
    changed(value => { Reflect.deleteProperty(value, "toolCallId"); Reflect.deleteProperty(value.details.contextBrokerPreparation, "toolCallId"); }),
    changed(value => { value.toolCallId = ""; value.details.contextBrokerPreparation.toolCallId = ""; }),
    changed(value => { Reflect.deleteProperty(value.details.contextBrokerPreparation, "projection"); }),
    changed(value => { Reflect.set(value.details.contextBrokerPreparation.projection, "compiler", "unknown/v1"); }),
    changed(value => { value.details.contextBrokerPreparation.projection.rendered.sha256 = "0".repeat(64); }),
    changed(value => { value.details.contextBrokerPreparation.projection.rendered.bytes++; }),
    changed(value => { value.details.contextBrokerPreparation.projection.records[0]!.delivery.start++; }),
    changed(value => { value.details.contextBrokerPreparation.projection.records[0]!.source.identity = recordIdentity(beta); }),
    changed(value => { value.details.contextBrokerPreparation.records[0]!.bodySha256 = "0".repeat(64); }),
    changed(value => { value.details.contextBrokerPreparation.records[0]!.snapshotId = beta.snapshotId!; }),
    changed(value => { value.details.contextBrokerPreparation.records[0]!.binding!.scope = "b".repeat(64); }),
    changed(value => { value.details.contextBrokerPreparation.graphs[0]!.graph_lock.sha256 = "0".repeat(64); }),
    changed(value => { value.details.contextBrokerPreparation.purpose = "inspect"; }),
  ];
  for (const message of invalid) {
    expect(sourceBodyLoaded([message], alpha)).toBe(false);
    expect(sourceBodyLoaded([message], beta)).toBe(false);
    expect(sessionSourceBindings([message], scope)).toEqual([]);
  }
  expect(sourceBodyLoaded([original], { ...alpha, sourceScope: "other-scope" })).toBe(false);
  expect(sourceBodyLoaded([original], { ...alpha, body: alpha.body + "changed" })).toBe(false);
});

test("the public root order may differ from the canonical lock order without changing the selected set", () => {
  const message = preparation();
  message.details.contextBrokerPreparation.graphs[0]!.roots.reverse();
  // graph.roots and graph_lock.roots are separately serialized in real receipts.
  const lock = message.details.contextBrokerPreparation.graphs[0]!.graph_lock;
  lock.roots = [...lock.roots].sort();
  const { sha256: _sha256, ...vector } = lock;
  lock.sha256 = hash(canonical(vector));
  expect(sourceBodyLoaded([message], alpha)).toBe(true);
  expect(sourceBodyLoaded([message], beta)).toBe(true);
});

test("deduplication derives fresh whole-projection evidence while preserving later bodies and history", () => {
  const first = preparation([alpha], "first"), second = preparation([alpha, beta], "second");
  const messages = [first, second], original = JSON.stringify(messages), projected = deduplicateSourceReads(messages);
  const text = sourceMessageText(projected[1]!.content), proof = (projected[1]!.details as typeof second.details).contextBrokerPreparation;
  expect(validateSkillPrepareProjection(text, proof.projection)).toBe(proof.projection);
  expect(proof.projection.derived).toEqual({ reason: "deduplicate", parentSha256: second.details.contextBrokerPreparation.projection.rendered.sha256 });
  expect(proof.records.map(value => value.loaded)).toEqual([false, true]);
  expect(JSON.parse(text).records[0].content).not.toBe(alpha.body);
  expect(JSON.parse(text).records[1].content).toBe(beta.body);
  expect(sourceBodyLoaded(projected, alpha)).toBe(true);
  expect(sourceBodyLoaded(projected, beta)).toBe(true);
  expect(sourceBodyLoaded([projected[1]!], alpha)).toBe(false);
  expect(sourceBodyLoaded([projected[1]!], beta)).toBe(true);
  expect(deduplicateSourceReads(projected)).toBe(projected);
  expect(deduplicateSourceReads([second])[0]).toBe(second);
  expect(JSON.stringify(messages)).toBe(original);
});

test("compiled repeated entries use a compact confirmation even for small complete bodies", () => {
  const tiny = record("tiny", "Use the existing context.\n");
  const first = preparation([tiny], "first"), second = preparation([tiny, beta], "second");
  const messages = [first, second], original = JSON.stringify(messages), projected = deduplicateSourceReads(messages);
  const text = sourceMessageText(projected[1]!.content), model = JSON.parse(text);
  const proof = (projected[1]!.details as typeof second.details).contextBrokerPreparation;
  expect(model.records[0].content).toBe("Already loaded.");
  expect(Buffer.byteLength(text)).toBeLessThan(Buffer.byteLength(sourceMessageText(second.content)));
  expect(model.records[0].ref).toBe(tiny.preparationBinding.ref);
  expect(model.records[1].content).toBe(beta.body);
  expect(validateSkillPrepareProjection(text, proof.projection)).toBe(proof.projection);
  expect(proof.records.map(value => value.loaded)).toEqual([false, true]);
  expect(sourceBodyLoaded(projected, tiny)).toBe(true);
  expect(sourceBodyLoaded(projected, beta)).toBe(true);
  expect(sourceBodyLoaded([projected[1]!], tiny)).toBe(false);
  expect(deduplicateSourceReads([second])[0]).toBe(second);
  expect(JSON.stringify(messages)).toBe(original);
});

test("compiled tiny and confirmation-shaped source bodies remain replaced with valid provider proof", () => {
  for (const body of ["x", "Already loaded."]) {
    const tiny = record("tiny-confirmation", body), first = preparation([tiny], "first"), second = preparation([tiny, beta], "second");
    const messages = [first, second], stored = JSON.stringify(messages), projected = deduplicateSourceReads(messages);
    const text = sourceMessageText(projected[1]!.content), proof = (projected[1]!.details as typeof second.details).contextBrokerPreparation;
    expect(JSON.parse(text).records[0].content).toBe("Already loaded.");
    expect(JSON.parse(text).records[1].content).toBe(beta.body);
    expect(validateSkillPrepareProjection(text, proof.projection)).toBe(proof.projection);
    expect(proof.records.map(value => value.loaded)).toEqual([false, true]);
    expect(sourceBodyLoaded([projected[0]!], tiny)).toBe(true);
    expect(sourceBodyLoaded([projected[1]!], tiny)).toBe(false);
    expect(deduplicateSourceReads(projected)).toBe(projected);
    expect(deduplicateSourceReads([second])[0]).toBe(second);
    expect(JSON.stringify(messages)).toBe(stored);
  }
});

test("superseding one record derives a valid projection for the remaining fixed selection", () => {
  const message = preparation(), before = JSON.stringify(message);
  const projected = projectSelectedSourceMessages([message], { scopes: new Map([[scope, {
    scope, selectionId: "replacement", bindings: new Map([[beta.id!, beta.preparationBinding]]),
    retired: new Map([[alpha.id!, alpha.preparationBinding]]), graphs: [],
  }]]) });
  const proof = (projected[0]!.details as typeof message.details).contextBrokerPreparation;
  expect(validateSkillPrepareProjection(sourceMessageText(projected[0]!.content), proof.projection)).toBe(proof.projection);
  expect(proof.projection.derived?.reason).toBe("supersede");
  expect(sourceBodyLoaded(projected, alpha)).toBe(false);
  expect(sourceBodyLoaded(projected, beta)).toBe(true);
  expect(sessionSourceBindings(projected, scope).map(binding => binding.record.id)).toEqual([beta.id!]);
  expect(JSON.stringify(message)).toBe(before);
});

test("derivation cannot bless a corrupt parent, changed metadata, unlisted bodies or unknown transforms", () => {
  const message = preparation(), before = sourceMessageText(message.content), proof = message.details.contextBrokerPreparation.projection;
  const model = JSON.parse(before); model.records[0].content = "Already available.";
  const after = renderSkillPreparationModel(model).content;
  expect(deriveSkillPrepareProjection(before, after, proof, [0], "deduplicate")).toBeDefined();
  expect(deriveSkillPrepareProjection(before, after, { ...proof, rendered: { ...proof.rendered, sha256: "0".repeat(64) } }, [0], "deduplicate")).toBeUndefined();
  expect(deriveSkillPrepareProjection(before, after, proof, [], "deduplicate")).toBeUndefined();
  expect(deriveSkillPrepareProjection(before, after, proof, [1], "deduplicate")).toBeUndefined();
  expect(deriveSkillPrepareProjection(before, after, proof, [0, 0], "deduplicate")).toBeUndefined();
  model.records[1].name = "wrong owner";
  expect(deriveSkillPrepareProjection(before, renderSkillPreparationModel(model).content, proof, [0], "deduplicate")).toBeUndefined();
  const damaged = structuredClone(message); damaged.details.contextBrokerPreparation.projection.rendered.sha256 = "0".repeat(64);
  expect(deduplicateSourceReads([damaged])[0]).toBe(damaged);
});

test("version-one historical tool receipts remain readable without manufacturing compiler evidence", () => {
  const text = JSON.stringify({ records: [{ content: alpha.body }] });
  const receipt = sourceDeliveryReceipt(alpha, text, "json", text.indexOf(JSON.stringify(alpha.body)) + 1);
  const message: AgentMessage = { role: "toolResult", toolName: "skill_prepare", toolCallId: "legacy", content: text,
    details: { contextBrokerPreparation: { version: 1, toolCallId: "legacy", records: [receipt] } } };
  expect(sourceBodyLoaded([message], alpha)).toBe(true);
  expect(sourceBodyLoaded([{ ...message, content: "hash only" }], alpha)).toBe(false);
});
