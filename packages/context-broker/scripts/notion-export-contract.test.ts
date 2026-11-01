import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { loadNotionSkill } from "../src/notion-source";
import type { SkillRecord, SourceConfig } from "../src/types";

// Run against a newly installed CLI and independent configured CLI state. The
// fault adapter executes that CLI first, retaining its real receipt and files.
const cli = resolve(process.env.BROKER_CONTRACT_CLI!);
const evidence = resolve(process.env.BROKER_CONTRACT_EVIDENCE!);
const refs: string[] = JSON.parse(process.env.BROKER_CONTRACT_REFS!);
const node = process.env.BROKER_CONTRACT_NODE ?? process.execPath;
const database = process.env.BROKER_CONTRACT_DATABASE;
if (database !== undefined) assert.match(database, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
const exec = promisify(execFile);
await mkdir(evidence, { recursive: true });
let operation = 0;
async function command(args: string[]) {
  if (database !== undefined) args = [...args, "--database", database];
  const result = await exec(node, [cli, ...args], { maxBuffer: 16 * 1024 * 1024 });
  const value = JSON.parse(result.stdout);
  await writeFile(join(evidence, `cli-${++operation}.json`), JSON.stringify({ argv: [node, cli, ...args], stdout: value, stderr: result.stderr }, null, 2));
  assert.equal(value.ok, true);
  return value;
}
const faultPath = join(evidence, "fault.json");
const adapter = join(evidence, "actual-cli-fault-adapter.mjs");
await writeFile(faultPath, JSON.stringify("none"));
await writeFile(adapter, `
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const [node,cli,faultPath,evidence,...args]=process.argv.slice(2);
const result=spawnSync(node,[cli,...args],{encoding:'utf8',maxBuffer:16*1024*1024});
writeFileSync(join(evidence,'adapter-'+randomUUID()+'.json'),JSON.stringify({argv:[node,cli,...args],exit:result.status,stdout:result.stdout,stderr:result.stderr}));
if(result.status!==0){process.stdout.write(result.stdout??'');process.exit(result.status??1);}
const receipt=JSON.parse(result.stdout),fault=JSON.parse(readFileSync(faultPath,'utf8'));
if(args[0]==='export'){
 if(fault==='version')receipt.version_id='different-version';
 if(fault==='hash')receipt.files[0].hash='0'.repeat(64);
 if(fault==='missing'){
  const resource=receipt.files.find(file=>file.role==='resource');
  if(!resource)throw new Error('Real fixture requires a supporting resource');
  const original=join(receipt.output,resource.path),retained=join(evidence,'missing-resource-'+randomUUID());
  const bytes=readFileSync(original);
  renameSync(original,retained);
  writeFileSync(retained+'.json',JSON.stringify({original,retained,snapshot_id:receipt.snapshot_id,path:resource.path,bytes:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')}));
 }
 if(fault==='format'){
  const path=join(receipt.output,'.ntn-skills.json');
  const manifest=JSON.parse(readFileSync(path,'utf8'));manifest.version=1;
  const bytes=Buffer.from(JSON.stringify(manifest));writeFileSync(path,bytes);
  const file=receipt.files.find(file=>file.role==='manifest');file.bytes=bytes.length;file.hash=createHash('sha256').update(bytes).digest('hex');
 }
}
process.stdout.write(JSON.stringify(receipt));
`);
const summaries = [];
const kinds = new Set<string>();
for (const ref of refs) {
  const read = await command(["read", ref, "--refresh"]);
  if (database !== undefined) assert.equal(read.record.locator.database_id, database);
  const files = await command(["files", read.snapshot_id]);
  assert.equal(files.snapshot_id, read.snapshot_id);
  assert.equal(files.version_id, read.version_id);
  assert.equal(files.scope, read.scope);
  assert.deepEqual(files.record, read.record);
  assert.ok(Array.isArray(files.files) && files.files.length > 0);
  const expected = new Map<string, { bytes: number; hash: string; ref: string }>();
  const pinnedRoot = resolve(evidence, `pinned-${read.record.kind}`);
  for (const pinned of files.files) {
    assert.ok(typeof pinned.path === "string" && !expected.has(pinned.path), "The public file tree has each path once");
    assert.ok(typeof pinned.ref === "string" && pinned.ref.includes(`?snapshot=${read.snapshot_id}`));
    const output = resolve(pinnedRoot, pinned.path);
    assert.ok(output.startsWith(pinnedRoot + sep), "Pinned read output stays inside this owned fixture directory");
    await mkdir(dirname(output), { recursive: true });
    // Obtain the independent expected bytes through the installed CLI's fixed
    // public reference, including binary resources. No private state layout is read.
    const observed = await command(["read", pinned.ref, "--output", output]);
    assert.equal(observed.snapshot_id, read.snapshot_id);
    assert.equal(observed.version_id, read.version_id);
    assert.equal(observed.scope, read.scope);
    assert.deepEqual(observed.record, read.record);
    assert.equal(observed.path, pinned.path);
    assert.equal(observed.ref, pinned.ref);
    assert.equal(observed.output, output);
    assert.equal(observed.bytes, pinned.bytes);
    const bytes = await readFile(output);
    assert.equal(bytes.length, pinned.bytes);
    expected.set(pinned.path, { bytes: bytes.length, hash: createHash("sha256").update(bytes).digest("hex"), ref: pinned.ref });
  }
  const exported = await command(["export", read.snapshot_id, "--projection", "snapshot", "--output", join(evidence, `direct-${read.record.kind}`), "--format", "directory"]);
  assert.deepEqual(exported.record, read.record);
  assert.equal(exported.snapshot_id, read.snapshot_id);
  assert.equal(exported.version_id, read.version_id);
  assert.equal(exported.scope, read.scope);
  assert.equal(exported.projection, "snapshot");
  assert.equal(await readFile(join(exported.output, read.entrypoint), "utf8"), read.content);
  assert.equal(exported.files.length, expected.size + 1);
  assert.deepEqual(exported.files.filter((file: { role: string }) => file.role !== "manifest").map((file: { path: string }) => file.path).sort(), [...expected.keys()].sort());
  const manifests = exported.files.filter((file: { role: string }) => file.role === "manifest");
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].path, ".ntn-skills.json");
  const manifest = JSON.parse(await readFile(join(exported.output, ".ntn-skills.json"), "utf8"));
  assert.equal(manifest.format, "ntn-skills");
  assert.equal(manifest.version, 2);
  assert.equal(manifest.kind, read.record.kind);
  assert.equal(manifest.name, read.record.name);
  assert.equal(manifest.description, read.record.description);
  assert.equal(manifest.main, read.entrypoint);
  if (read.record.kind === "router") {
    assert.match(read.content, /skill:\/\//, "Router representative retains generated stable member refs");
  }
  for (const file of exported.files) {
    const bytes = await readFile(join(exported.output, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.hash);
    if (file.role !== "manifest") {
      const pinned = expected.get(file.path);
      assert.ok(pinned, `Snapshot files includes ${file.path}`);
      assert.equal(pinned.bytes, file.bytes);
      assert.equal(pinned.hash, file.hash, "Directory export equals the complete bytes from its exact public pinned read");
      assert.ok(pinned.ref.includes(`snapshot=${read.snapshot_id}`));
    }
  }
  const record: SkillRecord = { ...read.record, name: read.record.alias, aliases: [read.record.name], source: "notion", sourceId: "contract", sourceScope: read.scope, path: "/metadata/" + read.entrypoint, normalizedName: read.record.alias, normalizedAliases: [], normalizedDescription: read.record.description, autoloadEnabled: read.record.kind !== "prompt" };
  const source: Extract<SourceConfig, { type: "notion" }> = { type: "notion", id: "contract", ...(database === undefined ? {} : { database }), command: [node, adapter, node, cli, faultPath, evidence], cacheDir: join(evidence, `cache-${read.record.kind}`), activation: { offline: true }, requestTimeoutMs: 30000 };
  const loaded = await loadNotionSkill(record, source, evidence);
  assert.equal(loaded.body, read.content);
  for (const file of exported.files) {
    const bytes = await readFile(join(dirname(loaded.path), file.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.hash, "Broker retains each snapshot resource beside its canonical entry");
  }
  assert.equal(loaded.snapshotId, read.snapshot_id);
  assert.equal(loaded.versionId, read.version_id);
  const receiptPath = join(dirname(loaded.path), ".broker-snapshot.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.version, 3);
  assert.equal(receipt.projection, "snapshot");
  assert.equal((await loadNotionSkill(record, source, evidence)).body, read.content);
  receipt.version = 2;
  delete receipt.projection;
  await writeFile(receiptPath, JSON.stringify(receipt));
  assert.equal((await loadNotionSkill(record, source, evidence)).body, read.content);
  assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).version, 3);
  assert.ok((await readdir(dirname(dirname(loaded.path)))).some(name => name.startsWith(".invalidated-")));
  if (read.record.kind === "skill") {
    for (const [fault, code] of [["version", "SOURCE_RESPONSE_INVALID"], ["hash", "SOURCE_EXPORT_INCOMPLETE"], ["missing", "SOURCE_EXPORT_INCOMPLETE"], ["format", "SOURCE_PORTABLE_FORMAT_UNSUPPORTED"]]) {
      await writeFile(faultPath, JSON.stringify(fault));
      await assert.rejects(loadNotionSkill(record, { ...source, cacheDir: join(evidence, `cache-fault-${fault}`) }, evidence), { code });
    }
    await writeFile(faultPath, JSON.stringify("none"));
  }
  kinds.add(read.record.kind);
  summaries.push({ kind: read.record.kind, ref, snapshot: loaded.snapshotId, version: loaded.versionId, entry: loaded.path, files: exported.files });
}
assert.deepEqual([...kinds].sort(), ["prompt", "router", "skill"]);
await writeFile(join(evidence, "result.json"), JSON.stringify({ ok: true, cli, representatives: summaries, rejected: ["version drift", "bad hash", "missing resource", "portable v1"], cacheMigration: "v2 retained and rebuilt as v3" }, null, 2));
console.log(JSON.stringify({ ok: true, evidence, kinds: [...kinds] }));
