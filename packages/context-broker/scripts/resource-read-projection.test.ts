import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  compileResourceRead, deriveResourceReadProjection, renderResourceReadModel, validateResourceReadProjection,
  type ResourceReadModel, type ResourceReadSelection, type ResourceReadSourceFile,
} from "../src/resource-read-projection";
import { deduplicateSourceReads, sessionSourceBindings, sourceMessageText } from "../src/session-source-snapshot";
import type { AgentMessage } from "../src/types";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const selection: ResourceReadSelection = { scope: "resource-scope", owner: "shared_skill:lib:resources", snapshot_id: "s_" + "a".repeat(64), version_id: "b".repeat(64) };
function file(path: string, content: string | Buffer, fileId = path): ResourceReadSourceFile {
  const ref = "skill://" + encodeURIComponent(selection.owner) + "/" + path + "?snapshot=" + selection.snapshot_id + "&file_id=" + encodeURIComponent(fileId);
  return { requested_ref: ref, ref, file_id: fileId, path, bytes: Buffer.byteLength(content), sha256: hash(content),
    encoding: typeof content === "string" ? "utf8" : "base64", content: typeof content === "string" ? content : content.toString("base64"),
    ...(typeof content === "string" ? {} : { output: "/owned/resources/" + path }) };
}
const files = [
  file("references/guide.md", 'Exact resource 中文 👩🏽‍💻\n"<tag>\\marker"\n'),
  file("references/bom.md", "\uFEFF第一行\r\n第二行\r\n"), file("references/empty.txt", ""),
  file("assets/data.bin", Buffer.from([0, 255, 1, 2, 128, 13, 10])),
];
function compile(toolCallId = "batch-1", selected = files, chosen = selection) {
  return compileResourceRead({ toolCallId, batch: { selection: chosen, files: selected }, modelRefs: selected.map(value => value.ref), maxContextBytes: 1_048_576 });
}
function message(toolCallId: string, selected = files): AgentMessage {
  return { role: "toolResult", toolName: "read", toolCallId, ...compile(toolCallId, selected) };
}

test("batch compiler preserves exact text, zero-length spans and binary metadata without base64 delivery", () => {
  const result = compile(), text = sourceMessageText(result.content), proof = result.details.contextBrokerResource;
  expect(validateResourceReadProjection(text, JSON.parse(JSON.stringify(proof)))).toEqual(proof);
  expect(JSON.parse(text)).toEqual(result.structuredContent);
  for (const [index, source] of files.entries()) {
    const delivered = result.structuredContent.files[index]!, receipt = proof.files[index]!;
    expect(receipt.loaded).toBe(false);
    if (source.encoding === "utf8") {
      expect(delivered.kind).toBe("text");
      if (delivered.kind !== "text") throw new Error("Expected text");
      expect(Buffer.from(delivered.content)).toEqual(Buffer.from(source.content));
      const span = receipt.delivery!;
      expect(JSON.parse('"' + text.slice(span.start, span.end) + '"')).toBe(source.content);
      expect(receipt.delivered_complete_text).toBe(true);
      if (!source.bytes) expect(span.start).toBe(span.end);
    } else {
      expect(delivered).toEqual({ kind: "binary", ref: source.ref, path: source.path, bytes: source.bytes, sha256: source.sha256, output: source.output });
      expect(receipt.delivery).toBeUndefined();
      expect(receipt.delivered_complete_text).toBe(false);
      expect(text).not.toContain(source.content);
    }
  }
});

test("model output budget measures the complete serialized result, including escaped bytes", () => {
  const text = sourceMessageText(compile().content), bytes = Buffer.byteLength(text);
  expect(bytes).toBeGreaterThan(files.reduce((sum, source) => sum + source.bytes, 0));
  const input = { toolCallId: "boundary", batch: { selection, files }, modelRefs: files.map(value => value.ref) };
  expect(sourceMessageText(compileResourceRead({ ...input, maxContextBytes: bytes }).content)).toBe(text);
  expect(() => compileResourceRead({ ...input, maxContextBytes: bytes - 1 })).toThrow("model context byte budget");
});

test("source hashes, stable File identities, output encoding and duplicates are checked before proof", () => {
  const first = files[0]!;
  expect(() => compile("bad", [{ ...first, content: first.content.slice(1) }])).toThrow("inconsistent");
  expect(() => compile("bad", [first, first])).toThrow("inconsistent");
  expect(() => compile("bad", [{ ...files[3]!, content: files[3]!.content + "\n" }])).toThrow("inconsistent");
  expect(() => compile("bad", [{ ...files[3]!, output: "relative.bin" }])).toThrow("inconsistent");
  expect(() => compile("bad", [{ ...first, ref: first.ref.replace(selection.snapshot_id, "s_" + "c".repeat(64)) }])).toThrow("inconsistent");
  const moved = { ...first, requested_ref: first.requested_ref.replace("/references/guide.md?", "/old/guide.md?") };
  expect(compile("moved", [moved]).details.contextBrokerResource.files[0]?.requested_ref).toBe(moved.requested_ref);
  const pathOnly = { ...first, requested_ref: first.requested_ref.split("&file_id=")[0]! };
  expect(compile("path-only", [pathOnly]).details.contextBrokerResource.files[0]?.file_id).toBe(first.file_id);
});

test("batch receipt rejects detached, changed, reordered and unknown-field evidence", () => {
  const result = compile(), text = sourceMessageText(result.content), proof = result.details.contextBrokerResource;
  const variants = [
    { ...proof, loaded: true }, { ...proof, toolCallId: "" }, { ...proof, unknown: true },
    { ...proof, files: [...proof.files].reverse() }, { ...proof, files: proof.files.slice(1) },
    { ...proof, selection: { ...selection, owner: "shared_skill:lib:other" } },
    { ...proof, files: proof.files.map((value, index) => index ? value : { ...value, sha256: "0".repeat(64) }) },
    { ...proof, files: proof.files.map((value, index) => index ? value : { ...value, bytes: value.bytes + 1 }) },
    { ...proof, files: proof.files.map((value, index) => index ? value : { ...value, delivery: { ...value.delivery, start: 0 } }) },
    { ...proof, files: proof.files.map((value, index) => index === 3 ? { ...value, delivered_complete_text: true } : value) },
  ];
  for (const value of variants) expect(validateResourceReadProjection(text, value)).toBeUndefined();
  expect(validateResourceReadProjection(text + "\n", proof)).toBeUndefined();
  expect(validateResourceReadProjection(text.slice(0, -1), proof)).toBeUndefined();
});

test("provider deduplication preserves original batches, binary, empty files and fresh items", () => {
  const first = message("first", [files[0]!]), second = message("second"), third = message("third");
  const original = [first, second, third], serialized = JSON.stringify(original), projected = deduplicateSourceReads(original);
  const secondModel = JSON.parse(sourceMessageText(projected[1]!.content)) as ResourceReadModel;
  expect(secondModel.files[0]).toEqual({ kind: "text", ref: files[0]!.ref, path: files[0]!.path, content: "Already available." });
  expect(secondModel.files[1]).toEqual(compile().structuredContent.files[1]);
  expect(secondModel.files[2]).toEqual(compile().structuredContent.files[2]);
  expect(secondModel.files[3]).toEqual(compile().structuredContent.files[3]);
  for (const value of projected) {
    const proof = validateResourceReadProjection(sourceMessageText(value.content), (value.details as { contextBrokerResource: unknown }).contextBrokerResource);
    expect(proof).toBeDefined();
    expect(proof?.loaded).toBe(false);
  }
  expect(projected.map(value => value.toolCallId)).toEqual(["first", "second", "third"]);
  expect(JSON.stringify(original)).toBe(serialized);
  expect(deduplicateSourceReads(projected)).toBe(projected);
  expect(deduplicateSourceReads([third])[0]).toBe(third);
  expect(sessionSourceBindings(projected, selection.scope)).toEqual([]);
});

test("legacy single reads and batch spans share exact identity but not main activation", () => {
  const source = files[0]!, batch = message("batch", [source]);
  const legacy: AgentMessage = { role: "toolResult", toolName: "read", toolCallId: "single", content: source.content,
    details: { contextBrokerResource: { version: 1, toolCallId: "single", id: selection.owner, scope: selection.scope, snapshot_id: selection.snapshot_id,
      file_id: source.file_id, path: source.path, ref: source.ref, bytes: source.bytes, sha256: source.sha256, delivered_complete_text: true, loaded: false } } };
  expect(JSON.parse(sourceMessageText(deduplicateSourceReads([legacy, batch])[1]!.content)).files[0].content).toBe("Already available.");
  expect(sourceMessageText(deduplicateSourceReads([batch, legacy])[1]!.content)).not.toBe(source.content);
  for (const invalid of [{ ...batch, toolCallId: "detached" }, { ...batch, role: "user" }, { ...batch, isError: true },
    { ...batch, content: "partial" }, { ...batch, details: undefined }, { ...batch, content: [{ type: "image", data: "AA==" }] }]) {
    const history = [legacy, invalid] as AgentMessage[];
    expect(deduplicateSourceReads(history)).toBe(history);
  }
  const foreign = { role: "toolResult", toolName: "read", toolCallId: "other", ...compile("other", [source], { ...selection, scope: "foreign" }) };
  const history = [legacy, foreign] as AgentMessage[];
  expect(deduplicateSourceReads(history)).toBe(history);
});

test("resource fallback shares only verified batch delivery with native read without activating the owner", () => {
  const first = message("native", [files[0]!]);
  const fallback = { ...message("fallback", [files[0]!]), toolName: "notion_read_resources" };
  const original = [first, fallback], stored = JSON.stringify(original);
  const projected = deduplicateSourceReads(original);
  expect(JSON.parse(sourceMessageText(projected[1]!.content)).files[0].content).toBe("Already available.");
  expect(sessionSourceBindings(projected, selection.scope)).toEqual([]);
  expect(JSON.stringify(original)).toBe(stored);
  expect(deduplicateSourceReads(projected)).toBe(projected);
  for (const invalid of [{ ...fallback, toolCallId: "detached" }, { ...fallback, isError: true }, { ...fallback, content: "partial" }, { ...fallback, toolName: "unrelated" }]) {
    const history = [first, invalid];
    expect(deduplicateSourceReads(history)).toBe(history);
  }
  const source = files[0]!, scalar: AgentMessage = { role: "toolResult", toolName: "notion_read_resources", toolCallId: "single", content: source.content,
    details: { contextBrokerResource: { version: 1, toolCallId: "single", id: selection.owner, scope: selection.scope, snapshot_id: selection.snapshot_id,
      file_id: source.file_id, path: source.path, ref: source.ref, bytes: source.bytes, sha256: source.sha256, delivered_complete_text: true, loaded: false } } };
  const history = [scalar, first];
  expect(deduplicateSourceReads(history)).toBe(history);
});

test("batch tiny and confirmation-shaped resources keep derived proof without attesting the confirmation", () => {
  for (const body of ["x", "Already available."]) {
    const source = file("references/tiny.md", body), first = message("first", [source]), second = message("second", [source]);
    const messages = [first, second], stored = JSON.stringify(messages), projected = deduplicateSourceReads(messages);
    const text = sourceMessageText(projected[1]!.content);
    const proof = validateResourceReadProjection(text, (projected[1]!.details as { contextBrokerResource: unknown }).contextBrokerResource);
    expect(JSON.parse(text).files[0].content).toBe("Already available.");
    expect(proof).toBeDefined(); expect(proof?.files[0]?.delivered_complete_text).toBe(false);
    expect(deduplicateSourceReads(projected)).toBe(projected);
    const fresh = message("fresh", [source]);
    expect(deduplicateSourceReads([projected[1]!, fresh])[1]).toBe(fresh);
    expect(deduplicateSourceReads([second])[0]).toBe(second);
    expect(JSON.stringify(messages)).toBe(stored);
  }
});

test("derived batch proof requires a valid full parent and changes only chosen text", () => {
  const result = compile(), before = sourceMessageText(result.content), proof = result.details.contextBrokerResource;
  const model = JSON.parse(before) as ResourceReadModel;
  const changed = { ...model, files: model.files.map((file, index) => index === 0 && file.kind === "text" ? { ...file, content: "Already available." } : file) };
  const after = renderResourceReadModel(changed).content;
  const derived = deriveResourceReadProjection(before, after, proof, [0]);
  expect(derived?.files[0]?.state).toBe("replaced");
  expect(derived?.files[1]?.state).toBe("source");
  expect(derived?.files[2]?.delivery?.start).toBe(derived?.files[2]?.delivery?.end);
  expect(deriveResourceReadProjection(before + " ", after, proof, [0])).toBeUndefined();
  expect(deriveResourceReadProjection(before, after, proof, [1])).toBeUndefined();
  expect(deriveResourceReadProjection(before, after, proof, [3])).toBeUndefined();
  expect(deriveResourceReadProjection(before, after, proof, [0, 0])).toBeUndefined();
  const renamed = { ...changed, files: changed.files.map((file, index) => index ? file : { ...file, path: "different.md" }) };
  expect(deriveResourceReadProjection(before, renderResourceReadModel(renamed).content, proof, [0])).toBeUndefined();
});
