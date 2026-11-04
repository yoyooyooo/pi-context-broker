import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { compileSkillPreparation, isSkillPreparationModel, renderSkillPreparationModel, SKILL_PREPARATION_COMPILER,
  type SkillPreparationCompilationInput } from "../src/skill-context-projection";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture(): SkillPreparationCompilationInput {
  const body = '\ufeff---\r\nname: 指南 🧭\r\n---\r\n## Members\r\n```json\r\n{"records":[{"content":"quote"}],"body_sha256":"author example"}\r\n```\r\n<body>keep &amp; <body> literally</body>\r\nNUL:\0 é 𠮷\r\n';
  const ref = "sr:S" + "a".repeat(22), resource = "sr:R" + "b".repeat(22);
  return { purpose: "use", roots: [ref], records: [{ name: "完整指南", kind: "skill", ref, content: body,
    source: { identity: "canonical source a", sha256: hash(body), bytes: Buffer.byteLength(body) },
    directory: {
      files: [{ path: "SKILL.md", ref, bytes: Buffer.byteLength(body), sha256: hash(body) },
        { path: "references/guide.md", ref: resource, bytes: 4096, sha256: "c".repeat(64) }],
      required: [], candidates: [{ id: "machine-member-id", ref: "sr:C" + "d".repeat(22), kind: "skill", name: "成员", description: "仅元数据", availability: "available" }],
      references: [{ id: "old-version", ref: "skill://old/reference.md?snapshot=s_" + "e".repeat(64), kind: "skill", name: "旧固定资源", description: "保持原引用", availability: "unavailable" }],
    } }] };
}

test("compilation keeps all author bytes and separates source from JSON-rendered hashes", () => {
  const input = fixture(), before = JSON.stringify(input), compiled = compileSkillPreparation(input);
  const model: unknown = JSON.parse(compiled.content);
  expect(isSkillPreparationModel(model)).toBe(true);
  if (!isSkillPreparationModel(model)) throw new Error("Expected model preparation");
  expect(model.records[0]!.content).toBe(input.records[0]!.content);
  expect(Buffer.from(model.records[0]!.content)).toEqual(Buffer.from(input.records[0]!.content));
  expect(model.roots).toEqual(input.roots);
  expect(compiled.content).toBe(JSON.stringify(model));
  expect(renderSkillPreparationModel(model)).toEqual({ content: compiled.content, bodySpans: compiled.bodySpans });
  expect(compiled.projection).toMatchObject({ version: 1, compiler: SKILL_PREPARATION_COMPILER, sourceProjection: "source-identity/v1",
    rendered: { sha256: hash(compiled.content), bytes: Buffer.byteLength(compiled.content) } });
  const mapping = compiled.projection.records[0]!, span = compiled.content.slice(mapping.delivery.start, mapping.delivery.end);
  expect(JSON.parse('"' + span + '"')).toBe(input.records[0]!.content);
  expect(mapping.source).toEqual(input.records[0]!.source);
  expect(mapping.rendered).toEqual({ sha256: hash(span), bytes: Buffer.byteLength(span) });
  expect(mapping.rendered.sha256).not.toBe(mapping.source.sha256);
  expect(mapping.delivery).toEqual(compiled.bodySpans[0]!);
  expect(mapping.state).toBe("source");
  expect(Buffer.byteLength(compiled.content.slice(0, mapping.delivery.start))).not.toBe(mapping.delivery.start);
  expect(JSON.stringify(input)).toBe(before);
});

test("only generated machine fields leave the model envelope; every directory entry remains", () => {
  const input = fixture(), compiled = compileSkillPreparation(input), model: unknown = JSON.parse(compiled.content);
  if (!isSkillPreparationModel(model)) throw new Error("Expected model preparation");
  expect(Object.keys(model)).toEqual(["ok", "status", "purpose", "roots", "records"]);
  expect(Object.keys(model.records[0]!)).toEqual(["name", "kind", "ref", "content", "directory"]);
  const directory = model.records[0]!.directory!;
  expect(Object.keys(directory)).toEqual(["files", "required", "candidates", "references"]);
  expect(directory.files).toEqual(input.records[0]!.directory!.files.map(({ path, ref, bytes }) => ({ path, ref, bytes })));
  expect(directory.candidates).toEqual(input.records[0]!.directory!.candidates.map(({ ref, kind, name, description, availability }) => ({ ref, kind, name, description, availability })));
  expect(directory.references[0]!.ref).toBe(input.records[0]!.directory!.references[0]!.ref);
  expect(directory.references[0]!.availability).toBe("unavailable");
  expect(directory.required).toEqual([]);
  expect(model.records[0]!.content).toContain('"body_sha256":"author example"');
  expect(model.records[0]!.content).toContain("## Members");
  expect(model.records[0]!.content).toContain("<body>keep");
});

test("offsets address content fields even when names and multiple records repeat the exact body", () => {
  const initial = fixture(), original = initial.records[0]!;
  const secondRef = "sr:S" + "f".repeat(22);
  const input = { ...initial, roots: [original.ref, secondRef], records: [
    { ...original, name: original.content },
    { ...original, name: original.content, ref: secondRef, source: { ...original.source, identity: "canonical source b" } },
  ] };
  const compiled = compileSkillPreparation(input), encoded = JSON.stringify(original.content).slice(1, -1);
  expect(compiled.content.indexOf(encoded)).toBeLessThan(compiled.bodySpans[0]!.start);
  expect(compiled.bodySpans[1]!.start).toBeGreaterThan(compiled.bodySpans[0]!.end);
  expect(compiled.projection.records.map(record => record.source.identity)).toEqual(["canonical source a", "canonical source b"]);
  for (const [index, span] of compiled.bodySpans.entries()) {
    expect(compiled.content.slice(span.start, span.end)).toBe(encoded);
    expect(compiled.content.slice(span.start - 11, span.start)).toBe('"content":"');
    expect(compiled.projection.records[index]!.index).toBe(index);
  }
});

test("deterministic compilation changes only when model-visible inputs or source mappings change", () => {
  const input = fixture(), compiled = compileSkillPreparation(input), original = input.records[0]!;
  expect(compileSkillPreparation(structuredClone(input))).toEqual(compiled);
  const relationChanged = compileSkillPreparation({ ...input, records: [{ ...original, directory: { ...original.directory!,
    candidates: original.directory!.candidates.map(member => ({ ...member, description: "更新描述" })) } }] });
  expect(relationChanged.projection.rendered.sha256).not.toBe(compiled.projection.rendered.sha256);
  expect(relationChanged.projection.records[0]!.source).toEqual(compiled.projection.records[0]!.source);
  const scopeChanged = compileSkillPreparation({ ...input, records: [{ ...original, source: { ...original.source, identity: "different source scope" } }] });
  expect(scopeChanged.content).toBe(compiled.content);
  expect(scopeChanged.projection.records[0]!.source.identity).not.toBe(compiled.projection.records[0]!.source.identity);
  const ref = "sr:S" + "g".repeat(22);
  expect(compileSkillPreparation({ ...input, roots: [ref], records: [{ ...original, ref }] }).projection.rendered.sha256).not.toBe(compiled.projection.rendered.sha256);
});

test("compilation rejects wrong source hash, byte length and roots without truncating content", () => {
  const input = fixture(), record = input.records[0]!;
  for (const source of [{ ...record.source, sha256: "0".repeat(64) }, { ...record.source, bytes: record.source.bytes - 1 }])
    expect(() => compileSkillPreparation({ ...input, records: [{ ...record, source }] })).toThrow("projection is inconsistent");
  expect(() => compileSkillPreparation({ ...input, roots: ["sr:S" + "z".repeat(22)] })).toThrow("projection is inconsistent");
  expect(() => compileSkillPreparation({ ...input, roots: [record.ref, record.ref] })).toThrow("projection is inconsistent");
  const noDirectory = compileSkillPreparation({ ...input, records: [{ ...record, directory: undefined }] });
  const model: unknown = JSON.parse(noDirectory.content);
  if (!isSkillPreparationModel(model)) throw new Error("Expected model preparation");
  expect(Object.hasOwn(model.records[0]!, "directory")).toBe(false);
  expect(model.records[0]!.content).toBe(record.content);
});

test("generated schema rejects unrecognized envelope fields while source strings remain opaque", () => {
  const compiled = compileSkillPreparation(fixture()), model = JSON.parse(compiled.content);
  expect(isSkillPreparationModel({ ...model, graphs: [] })).toBe(false);
  expect(isSkillPreparationModel({ ...model, records: [{ ...model.records[0], scope: "machine-scope" }] })).toBe(false);
  expect(isSkillPreparationModel({ ...model, records: [{ ...model.records[0], directory: { ...model.records[0].directory,
    files: [{ ...model.records[0].directory.files[0], sha256: "0".repeat(64) }] } }] })).toBe(false);
  expect(isSkillPreparationModel({ ...model, purpose: "execute" })).toBe(false);
  expect(isSkillPreparationModel({ ...model, records: [{ ...model.records[0], content: { text: "source" } }] })).toBe(false);
});
