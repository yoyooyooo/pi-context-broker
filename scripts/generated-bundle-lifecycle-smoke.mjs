import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  GENERATED_BUNDLE_MANIFEST,
  GENERATED_BUNDLE_OWNER,
  GENERATED_BUNDLE_QUARANTINE,
  generatedBundleRecordIdentity,
  generatedBundleSkillPath,
  materializeGeneratedBundleSkills,
} from "../src/generated-bundle-skills.ts";

const temp = await mkdtemp(join(tmpdir(), "context-broker-generated-"));
const root = join(temp, "agent", "context-broker", "generated-skills");
const catalogA = join(temp, "catalog-a.yaml");
const catalogB = join(temp, "catalog-b.yaml");
await writeFile(catalogA, "version: 1\n");
await writeFile(catalogB, "version: 1\n");

const bundleA = { name: "suite-a", normalizedName: "suite-a", path: catalogA };
const bundleB = { name: "suite-b", normalizedName: "suite-b", path: catalogB };
const sameNameOtherCatalog = { name: "suite-a", normalizedName: "suite-a", path: catalogB };
const render = (revision) => (bundle, recordIdentity) => [
  "---",
  `name: ${JSON.stringify(bundle.name)}`,
  "metadata:",
  "  context-broker-kind: bundle",
  `  context-broker-owner: ${GENERATED_BUNDLE_OWNER}`,
  `  context-broker-record-id: ${recordIdentity}`,
  "---",
  `<context-broker-record kind=\"bundle\" name=\"${bundle.name}\">${revision}</context-broker-record>`,
  "",
].join("\n");

try {
  const expectedIdentity = generatedBundleRecordIdentity(root, bundleA);
  assert.equal(expectedIdentity.length, 64);
  assert.equal(
    generatedBundleSkillPath(root, bundleA),
    generatedBundleSkillPath(root, bundleA),
    "record path must not depend on caller cwd",
  );
  assert.notEqual(
    generatedBundleSkillPath(root, bundleA),
    generatedBundleSkillPath(root, sameNameOtherCatalog),
    "catalog identity must prevent same-name records from overwriting one another",
  );

  const initial = materializeGeneratedBundleSkills({ root, bundles: [bundleA, bundleB], render: render("v1") });
  assert.equal(initial.length, 2);
  const workerPath = join(import.meta.dirname, "generated-bundle-lifecycle-worker.mjs");
  const workers = Array.from({ length: 8 }, () => Bun.spawn(
    [process.execPath, workerPath, root, catalogA, catalogB],
    { stdout: "pipe", stderr: "pipe" },
  ));
  const workerResults = await Promise.all(workers.map(async (worker) => ({
    code: await worker.exited,
    stdout: await new Response(worker.stdout).text(),
    stderr: await new Response(worker.stderr).text(),
  })));
  assert.ok(workerResults.every((result) => result.code === 0), workerResults.map((result) => result.stderr).join("\n"));
  assert.ok(
    workerResults.every((result) => JSON.stringify(JSON.parse(result.stdout)) === JSON.stringify(initial)),
    "concurrent startup must converge on one stable active set",
  );

  const firstContent = await readFile(initial[0], "utf8");
  const updated = materializeGeneratedBundleSkills({ root, bundles: [bundleA, bundleB], render: render("v2") });
  assert.deepEqual(updated, initial, "content updates must keep stable generated paths");
  assert.notEqual(await readFile(updated[0], "utf8"), firstContent);

  const legacyOwned = join(root, "bundle-aaaaaaaaaaaaaaaaaaaaaaaa.md");
  const unowned = join(root, "bundle-bbbbbbbbbbbbbbbbbbbbbbbb.md");
  const truncated = join(root, "bundle-cccccccccccccccccccccccc.md");
  await writeFile(legacyOwned, [
    "---",
    "metadata:",
    "  context-broker-kind: bundle",
    "---",
    '<context-broker-record kind="bundle" name="legacy"></context-broker-record>',
  ].join("\n"));
  await writeFile(unowned, "user-owned file\n");
  await writeFile(truncated, `context-broker-owner: ${GENERATED_BUNDLE_OWNER}\n`);
  await writeFile(join(root, GENERATED_BUNDLE_MANIFEST), "{truncated manifest");

  const narrowed = materializeGeneratedBundleSkills({
    root,
    bundles: [bundleA],
    render: render("v2"),
    now: new Date("2026-08-25T00:00:00.000Z"),
  });
  assert.deepEqual(narrowed, [generatedBundleSkillPath(root, bundleA)]);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.endsWith(".md")).sort(),
    ["bundle-bbbbbbbbbbbbbbbbbbbbbbbb.md", "bundle-cccccccccccccccccccccccc.md", dirname(narrowed[0]) === root ? basename(narrowed[0]) : ""].sort(),
    "reconcile must quarantine owned stale indexes while preserving unknown and truncated files",
  );

  const quarantineRoot = join(dirname(root), GENERATED_BUNDLE_QUARANTINE);
  const quarantines = await readdir(quarantineRoot, { recursive: true });
  assert.ok(quarantines.some((name) => String(name).endsWith("bundle-aaaaaaaaaaaaaaaaaaaaaaaa.md")), "legacy owned index must be quarantined");
  assert.ok(quarantines.some((name) => String(name).endsWith(GENERATED_BUNDLE_MANIFEST)), "invalid manifest must be quarantined");
  assert.ok(quarantines.some((name) => String(name).endsWith(basename(initial[1]))), "previously active stale index must be quarantined");

  const manifest = JSON.parse(await readFile(join(root, GENERATED_BUNDLE_MANIFEST), "utf8"));
  assert.equal(manifest.owner, GENERATED_BUNDLE_OWNER);
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].recordIdentity, expectedIdentity);
  assert.equal(manifest.entries[0].path, basename(narrowed[0]));
  assert.match(manifest.entries[0].contentDigest, /^[a-f0-9]{64}$/);

  const entityRoot = join(temp, "repo", "skills", "bundles");
  const entityPaths = materializeGeneratedBundleSkills({
    root: entityRoot,
    bundles: [bundleA, bundleB],
    layout: "skill-dir",
    skillName: (bundle) => `${bundle.name}-bundle`,
    render: render("entity-v1"),
  });
  assert.deepEqual(entityPaths, [
    join(entityRoot, "suite-a-bundle", "SKILL.md"),
    join(entityRoot, "suite-b-bundle", "SKILL.md"),
  ]);
  assert.equal(
    generatedBundleSkillPath(entityRoot, bundleA, "skill-dir", "suite-a-bundle"),
    entityPaths[0],
    "skill-dir layout must use a stable public directory name",
  );
  const entityManifest = JSON.parse(await readFile(join(entityRoot, GENERATED_BUNDLE_MANIFEST), "utf8"));
  assert.equal(entityManifest.entries[0].path, join("suite-a-bundle", "SKILL.md"));
  await assert.rejects(
    async () => materializeGeneratedBundleSkills({
      root: entityRoot,
      bundles: [bundleA],
      layout: "skill-dir",
      skillName: () => "../escape",
      render: render("invalid"),
    }),
    /not a safe directory name/,
  );

  console.log("context-broker generated bundle lifecycle: ok");
} finally {
  await rm(temp, { recursive: true, force: true });
}
