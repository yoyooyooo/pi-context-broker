import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadNotionSkill } from "../src/notion-source";
import type { SkillRecord, SourceConfig } from "../src/types";

// Run against a newly installed CLI and independent configured CLI state. The
// fault adapter executes that CLI first, retaining its real receipt and files.
const cli = resolve(process.env.BROKER_CONTRACT_CLI!);
const evidence = resolve(process.env.BROKER_CONTRACT_EVIDENCE!);
const refs: string[] = JSON.parse(process.env.BROKER_CONTRACT_REFS!);
const node = process.env.BROKER_CONTRACT_NODE ?? process.execPath;
const exec = promisify(execFile);
await mkdir(evidence, { recursive: true });
let operation = 0;
async function command(args: string[]) {
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
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
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
  unlinkSync(join(receipt.output,resource.path));
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
  const files = await command(["files", read.snapshot_id]);
  const stateRoot = process.env.NTN_SKILLS_HOME ?? join(process.env.XDG_STATE_HOME!, "ntn-skills");
  const snapshot = JSON.parse(await readFile(join(stateRoot, "snapshots", `${read.snapshot_id}.json`), "utf8"));
  assert.equal(snapshot.version_id, read.version_id);
  assert.deepEqual(snapshot.record, read.record);
  const exported = await command(["export", read.snapshot_id, "--projection", "snapshot", "--output", join(evidence, `direct-${read.record.kind}`), "--format", "directory"]);
  assert.deepEqual(exported.record, read.record);
  assert.equal(exported.snapshot_id, read.snapshot_id);
  assert.equal(exported.version_id, read.version_id);
  assert.equal(exported.scope, read.scope);
  assert.equal(exported.projection, "snapshot");
  assert.equal(await readFile(join(exported.output, read.entrypoint), "utf8"), read.content);
  assert.equal(exported.files.length, snapshot.files.length + 1);
  assert.equal(files.files.length, snapshot.files.length);
  if (read.record.kind === "router") {
    assert.match(read.content, /skill:\/\//, "Router representative retains generated stable member refs");
  }
  for (const file of exported.files) {
    const bytes = await readFile(join(exported.output, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.hash);
    if (file.role !== "manifest") {
      const pinned = files.files.find((item: { path: string }) => item.path === file.path);
      assert.ok(pinned, `Snapshot files includes ${file.path}`);
      assert.equal(pinned.bytes, file.bytes);
      const immutable = snapshot.files.find((item: { path: string }) => item.path === file.path);
      assert.ok(immutable, `Immutable snapshot includes ${file.path}`);
      assert.equal(immutable.sha256, file.hash);
      assert.equal(immutable.bytes, file.bytes);
      assert.ok(pinned.ref.includes(`snapshot=${read.snapshot_id}`));
      if (file.role === "resource") {
        const resource = await command(["read", pinned.ref]);
        if (typeof resource.content === "string") assert.equal(resource.content, bytes.toString("utf8"));
      }
    }
  }
  const record: SkillRecord = { ...read.record, name: read.record.alias, aliases: [read.record.name], source: "notion", sourceId: "contract", sourceScope: read.scope, path: "/metadata/" + read.entrypoint, normalizedName: read.record.alias, normalizedAliases: [], normalizedDescription: read.record.description, autoloadEnabled: read.record.kind !== "prompt" };
  const source: Extract<SourceConfig, { type: "notion" }> = { type: "notion", id: "contract", command: [node, adapter, node, cli, faultPath, evidence], cacheDir: join(evidence, `cache-${read.record.kind}`), activation: { offline: true }, requestTimeoutMs: 30000 };
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
