import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectNotionSource, handleSourceConnection } from "../src/source-connection";
const rootId = "00000000-0000-4000-8000-000000000099", otherRootId = "00000000-0000-4000-8000-000000000098";

test("NXT06 connection previews the exact file, then saves once without claiming remote or Pi readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "broker-connect-")), configPath = join(directory, "project config.json");
  const input = { source: "personal", library: rootId, configPath };
  const preview = await connectNotionSource(input);
  expect(preview).toMatchObject({ status: "preview", changed: false, remote_library: "not_verified",
    local_registration: "not_configured", pi_connection: "reload_required", body_read: "not_observed", remote_writes: "none" });
  expect(preview.next[0]).toContain(JSON.stringify(configPath));
  await expect(stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  const applied = await connectNotionSource({ ...input, apply: preview.preview_sha256 });
  expect(applied).toMatchObject({ status: "configuration_saved", changed: true, local_registration: "configured" });
  expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ sources: [{ id: "personal", type: "notion", library: rootId, prefetch: false }] });
  const before = await stat(configPath), again = await connectNotionSource(input);
  expect(await connectNotionSource({ ...input, apply: again.preview_sha256 })).toMatchObject({ status: "already_configured", changed: false });
  expect((await stat(configPath)).mtimeMs).toBe(before.mtimeMs);
});

test("NXT06 connection preserves unrelated settings and backup, rejects stale previews and source collisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "broker-connect-existing-")), configPath = join(directory, "config.json");
  const existing = { customSetting: { keep: true }, sources: [{ id: "local", type: "filesystem", roots: ["./skills"] }] };
  const original = JSON.stringify(existing, null, 2) + "\n";
  await writeFile(configPath, original);
  const input = { source: "personal", library: rootId, configPath }, preview = await connectNotionSource(input);
  await writeFile(configPath, original + "\n");
  await expect(connectNotionSource({ ...input, apply: preview.preview_sha256 })).rejects.toMatchObject({ code: "SOURCE_CONNECTION_STALE_PREVIEW" });
  expect(await readFile(configPath, "utf8")).toBe(original + "\n");
  const fresh = await connectNotionSource(input), applied = await connectNotionSource({ ...input, apply: fresh.preview_sha256 });
  expect(applied.backup_path).toBeDefined();
  expect(await readFile(applied.backup_path!, "utf8")).toBe(original + "\n");
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  expect(saved.customSetting).toEqual(existing.customSetting);
  expect(saved.sources[0]).toEqual(existing.sources[0]);
  expect(saved.sources).toHaveLength(2);
  await expect(connectNotionSource({ ...input, library: otherRootId })).rejects.toMatchObject({ code: "SOURCE_CONNECTION_CONFLICT" });
  await expect(connectNotionSource({ ...input, source: "other" })).rejects.toMatchObject({ code: "SOURCE_CONNECTION_CONFLICT" });
  await expect(connectNotionSource({ ...input, source: "local" })).rejects.toMatchObject({ code: "SOURCE_CONNECTION_CONFLICT" });
});

test("NXT06 connection refuses links and never picks a default config; the public command supports quoted paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "broker-connect-path-")), configPath = join(directory, "selected config.yaml"), link = join(directory, "link.yaml");
  await writeFile(configPath, "sources: []\n");
  await symlink(configPath, link);
  await expect(connectNotionSource({ source: "owned", library: rootId, configPath: link })).rejects.toMatchObject({ code: "SOURCE_CONNECTION_UNSAFE_PATH" });
  await expect(connectNotionSource({ source: "owned", library: rootId, configPath: "relative.json" })).rejects.toMatchObject({ code: "SOURCE_CONNECTION_CONFIG_REQUIRED" });
  const notices: { text: string; type?: string }[] = [];
  const ctx = { ui: { notify(text: string, type?: string) { notices.push({ text, type }); } } };
  expect(await handleSourceConnection(`connect owned ${rootId} --config ${JSON.stringify(configPath)}`, ctx)).toBe(true);
  const preview = JSON.parse(notices.at(-1)!.text);
  expect(preview).toMatchObject({ status: "preview", config_path: configPath });
  expect(await handleSourceConnection(preview.next[0].replace("/context-broker ", ""), ctx)).toBe(true);
  expect(JSON.parse(notices.at(-1)!.text)).toMatchObject({ status: "configuration_saved" });
  expect(await readFile(configPath, "utf8")).toContain("library: " + rootId);
  expect(await handleSourceConnection("sources", ctx)).toBe(false);
  expect(await handleSourceConnection(`connect owned ${rootId} --config ${JSON.stringify(configPath)} --config other`, ctx)).toBe(true);
  expect(notices.at(-1)?.type).toBe("error");
});
