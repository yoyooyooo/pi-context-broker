import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Fixtures control network results, never the reference protocol. Copy the
 * real artifact prepared from this run's explicitly selected CLI package. */
export async function copyReferenceProtocol(output: string) {
  const bytes = await readFile(new URL("../../dist/ntn-skills-ref.cjs", import.meta.url));
  const manifest = JSON.parse(await readFile(new URL("../../dist/ntn-skills-runtime.json", import.meta.url), "utf8"));
  const ref_sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(manifest.skill_ref_version, 2);
  assert.equal(manifest.ref_sha256, ref_sha256);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "ntn-skills-ref.cjs"), bytes);
  return { skill_ref_version: 2, ref_sha256 };
}
