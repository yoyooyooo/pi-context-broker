import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { skillRefProtocol } from "../src/skill-ref-protocol";
import { bindNativeReference, formatNativeReference, nativeFileRef, nativeSkillId, parseNativeReference } from "../src/native-reference";
import { copyReferenceProtocol } from "./fixtures/skill-ref-fixture";

test("Broker references use the selected pure protocol for exact identity and containing Library binding", () => {
  const protocol = skillRefProtocol(), owner = { libraryId: "8b2a35cf-ef0c-5f47-870b-ee10f0c2a88d", skillId: "architect" };
  const id = nativeSkillId(owner.libraryId, owner.skillId), snapshot = "s_" + "a".repeat(64);
  expect(id).toBe(protocol.formatSkillIdentity(owner));
  for (const path of ["", "SKILL.md", "references/设计 note.md"]) {
    const ref = nativeFileRef(id, path, snapshot), parsed = parseNativeReference(ref);
    expect(parsed).toEqual({ selector: id, path, snapshot });
    expect(formatNativeReference(parsed)).toBe(protocol.formatSkillRef({ owner, path, selection: { kind: "fixed", snapshotId: snapshot } }));
  }
  const contextual = parseNativeReference("skill://architect/references/guide.md");
  expect(bindNativeReference(contextual, owner.libraryId).selector).toBe(id);
  expect(() => protocol.bindSkillRef(protocol.parseSkillRef("skill://architect"))).toThrow();
  for (const input of ["skill://Architect", "skill://shared_skill%3Atest%3Aarchitect/SKILL.md",
    "skill://architect/SKILL.md?library=b84be979-5af9-53be-99da-3dace4091fa0&file_id=main", "skill://architect/SKILL.md?library=b84be979-5af9-53be-99da-3dace4091fa0#heading",
    "skill://architect/a%2Fb.md?library=b84be979-5af9-53be-99da-3dace4091fa0", "skill://architect?library=b84be979-5af9-53be-99da-3dace4091fa0&library=1494774d-6d2d-51e4-a6e5-be6856d1d384"]) {
    expect(() => parseNativeReference(input)).toThrow(expect.objectContaining({ code: "SOURCE_REFERENCE_INVALID" }));
  }
});

test("source loading requires the exact local artifact bytes and never falls back to another package", async () => {
  const root = await mkdtemp(join(tmpdir(), "broker-ref-protocol-")), source = join(root, "src"), dist = join(root, "dist");
  await mkdir(source); await mkdir(dist);
  await copyFile(fileURLToPath(new URL("../src/skill-ref-protocol.ts", import.meta.url)), join(source, "skill-ref-protocol.ts"));
  const identity = await copyReferenceProtocol(dist);
  const manifestFile = join(dist, "ntn-skills-runtime.json"), artifact = join(dist, "ntn-skills-ref.cjs");
  await writeFile(manifestFile, JSON.stringify({ version: 1, package: "ntn-skills", ...identity }));
  const manifest = await readFile(manifestFile, "utf8"), bytes = await readFile(artifact);
  const script = `import { skillRefProtocol } from ${JSON.stringify(pathToFileURL(join(source, "skill-ref-protocol.ts")).href)};
    try { process.stdout.write(skillRefProtocol().formatSkillIdentity({libraryId:"b84be979-5af9-53be-99da-3dace4091fa0",skillId:"architect"})); }
    catch (error) { process.stdout.write(error.code ?? "unexpected"); process.exitCode=1; }`;
  const run = () => spawnSync(process.execPath, ["--eval", script], { cwd: root, encoding: "utf8", env: process.env });
  try {
    expect(run()).toMatchObject({ status: 0, stdout: "skill://architect?library=b84be979-5af9-53be-99da-3dace4091fa0" });
    await writeFile(artifact, Buffer.concat([bytes, Buffer.from("\n// altered bytes\n")]));
    expect(run()).toMatchObject({ status: 1, stdout: "SOURCE_SDK_INCOMPATIBLE" });
    await writeFile(artifact, bytes);
    await writeFile(manifestFile, JSON.stringify({ ...JSON.parse(manifest), skill_ref_version: 1 }));
    expect(run()).toMatchObject({ status: 1, stdout: "SOURCE_SDK_INCOMPATIBLE" });
    await writeFile(manifestFile, manifest);
    await rm(artifact);
    expect(run()).toMatchObject({ status: 1, stdout: "SOURCE_SDK_INCOMPATIBLE" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
