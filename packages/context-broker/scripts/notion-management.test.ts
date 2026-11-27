import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SourceMaterializationRequest } from "../src/source-materialization-contract";

async function fixture(options: { missing?: boolean; wrongHash?: boolean; version?: number; packageVersion?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "broker-management-boundary-"));
  await mkdir(join(root, "src")); await mkdir(join(root, "dist"));
  await copyFile(new URL("../src/notion-management.ts", import.meta.url), join(root, "src/notion-management.ts"));
  const marker = join(root, "imports.txt");
  const code = `import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(marker)}, 'imported');
export const SOURCE_MATERIALIZATION_VERSION=${options.version ?? 1};
export const PACKAGE_VERSION=${JSON.stringify(options.packageVersion ?? "fixture-1")};
export async function materializeSource(input, options) {
  await writeFile(${JSON.stringify(marker)}, 'called');
  return { input, cwd: options.cwd, library: options.library, signal: options.signal };
}`;
  if (!options.missing) await writeFile(join(root, "dist/ntn-skills-management.mjs"), code);
  await writeFile(join(root, "dist/ntn-skills-runtime.json"), JSON.stringify({ version: 1, package: "ntn-skills", package_version: "fixture-1",
    source_materialization_version: 1, management_sha256: options.wrongHash ? "0".repeat(64) : createHash("sha256").update(code).digest("hex") }));
  const api: typeof import("../src/notion-management") = await import(pathToFileURL(join(root, "src/notion-management.ts")).href);
  return { api, marker, root };
}
const request: SourceMaterializationRequest = { version: 1, library: "00000000-0000-4000-8000-000000000001", request_id: "input-root", purpose: "use",
  target: { source_id: "origin", member_key: "root", expected_skill_id: "root", registration_digest: "a".repeat(64) } };

test("the independent paired management entry is lazy and receives only its selected call", async () => {
  const f = await fixture();
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  const controller = new AbortController();
  const result = await f.api.materializeNotionSource(request, { cwd: f.root, library: request.library, signal: controller.signal });
  expect(result).toEqual({ input: request, cwd: f.root, library: request.library, signal: controller.signal });
  expect(await readFile(f.marker, "utf8")).toBe("called");
});

test("missing or altered management bytes never select a global fallback", async () => {
  for (const options of [{ missing: true }, { wrongHash: true }]) {
    const f = await fixture(options);
    await expect(f.api.materializeNotionSource(request, { cwd: f.root, library: request.library })).rejects.toMatchObject({ code: "SOURCE_MANAGEMENT_UNAVAILABLE" });
    await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test("mixed versions and a cancelled input cannot dispatch management", async () => {
  for (const options of [{ version: 2 }, { packageVersion: "other" }]) {
    const f = await fixture(options);
    await expect(f.api.materializeNotionSource(request, { cwd: f.root, library: request.library })).rejects.toMatchObject({ code: "SOURCE_MANAGEMENT_UNAVAILABLE" });
    expect(await readFile(f.marker, "utf8")).toBe("imported");
  }
  const f = await fixture(), controller = new AbortController(); controller.abort();
  await expect(f.api.materializeNotionSource(request, { cwd: f.root, library: request.library, signal: controller.signal })).rejects.toBeDefined();
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
});
