import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const sessionModule = process.env.CONTEXT_BROKER_PI_SESSION_MODULE;
if (!sessionModule) throw new Error("Set CONTEXT_BROKER_PI_SESSION_MODULE to the installed Pi core/session-manager.js.");
const requirePi = createRequire(sessionModule);
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const { SessionManager } = await import(pathToFileURL(sessionModule).href);
const graph = await jiti.import(fileURLToPath(new URL("../src/session-graph.ts", import.meta.url)));
const receipts = await jiti.import(fileURLToPath(new URL("../src/session-source-snapshot.ts", import.meta.url)));
const hash = value => createHash("sha256").update(value).digest("hex");
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
    : "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
const scope = "b".repeat(64);
function context(manager) { return { sessionManager: manager, cwd: manager.getCwd(), mode: "rpc", hasUI: false }; }
function active(manager) { return manager.buildSessionContext().messages; }
function exported(manager) { return graph.exportSessionSelection(context(manager), receipts.projectSelectedSourceMessages(active(manager), graph.sessionSelection(context(manager)))); }
if (process.argv[2] === "restore") {
  const manager = SessionManager.open(process.argv[3]);
  process.stdout.write(JSON.stringify(exported(manager)));
  process.exit(0);
}

const evidence = resolve(process.env.CONTEXT_BROKER_SESSION_EVIDENCE ?? "/tmp/context-broker-session-evidence");
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(evidence, "selected-graph-"));
function record(name, revision) {
  const id = "shared_skill:controlled:" + name;
  const meta = { id, kind: "skill", name, alias: name, description: "Controlled " + name,
    enabled: true, default_context: name === "root", entrypoint: "SKILL.md",
    ref: "skill://" + encodeURIComponent(id) + "/SKILL.md",
    locator: { type: "shared_skill", library_id: "controlled", skill_id: name,
      page_id: "00000000-0000-4000-8000-" + hash(name).slice(0, 12),
      database_id: "00000000-0000-4000-8000-000000000010", data_source_id: "00000000-0000-4000-8000-000000000011" } };
  const body = "---\nname: " + name + "\n---\n" + name + "_VERSION_" + revision + "_FULL_INSTRUCTIONS\n";
  const version = hash(body), snapshot = "s_" + hash(JSON.stringify([scope, id, version]));
  const binding = { record: meta, scope, snapshot_id: snapshot, version_id: version, body_sha256: hash(body), ref: meta.ref + "?snapshot=" + snapshot + "&file_id=main-" + name };
  return { ...meta, source: "notion", sourceId: "controlled", sourceScope: scope,
    aliases: [], normalizedAliases: [], normalizedName: name, normalizedDescription: meta.description, autoloadEnabled: true,
    body, snapshotId: snapshot, versionId: version, path: join(directory, name, "SKILL.md"), preparationBinding: binding };
}
function prepared(records, roots = [records[0]], purpose = "use") {
  const vector = { version: 1, kind: "observed_version_vector", purpose, scope, roots: roots.map(value => value.id),
    required: records.length > roots.length ? records.filter(value => !roots.includes(value)).map(value => ({ from: roots[0].id, to: value.id, ref: value.preparationBinding.ref })) : [],
    bindings: records.map(value => value.preparationBinding) };
  return { purpose, scope, sourceId: "controlled", roots: vector.roots, records, bindings: vector.bindings,
    lock: { ...vector, sha256: hash(canonical(vector)) },
    budget: { maxNodes: 64, maxDepth: 16, maxInstructionBytes: 1048576, maxContextBytes: 262144 },
    usage: { prepared_nodes: records.length, instruction_bytes: records.reduce((sum, value) => sum + Buffer.byteLength(value.body), 0), context_bytes: 8000, max_depth: records.length > 1 ? 1 : 0 } };
}
function persist(manager, graphs, mode = "extend") {
  graph.persistSessionSelection({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, context(manager), graphs, mode);
}
function deliver(manager, records) {
  const content = records.map(value => value.body).join("\n\n");
  let offset = 0;
  const proofs = records.map(value => {
    const proof = receipts.sourceDeliveryReceipt(value, content, "raw", offset);
    offset += value.body.length + 2;
    return proof;
  });
  assert.ok(proofs.every(Boolean));
  return manager.appendCustomMessageEntry("context-broker", content, false, { records: proofs });
}
const rootA = record("root", "A"), requiredA = record("required", "A"), optionalB = record("optional", "B");
const rootB = record("root", "B"), requiredB = record("required", "B");
const selectedA = prepared([rootA, requiredA]), selectedB = prepared([rootB, requiredB]);
const manager = SessionManager.create(directory, join(directory, "sessions"));
manager.appendMessage({ role: "user", content: "Use the exact root.", timestamp: Date.now() });
persist(manager, [selectedA]);
assert.deepEqual(exported(manager).scopes[0].nodes.map(node => [node.binding.record.id, node.loaded]), [
  [rootA.id, false], [requiredA.id, false],
]);
const leafA = deliver(manager, [rootA, requiredA]);
assert.ok(exported(manager).scopes[0].nodes.every(node => node.loaded));
assert.equal(graph.selectedBinding(graph.sessionSelection(context(manager)), optionalB), undefined);
persist(manager, [prepared([optionalB])]);
deliver(manager, [optionalB]);
assert.equal(graph.selectedBinding(graph.sessionSelection(context(manager)), rootB).snapshot_id, rootA.snapshotId);
assert.equal(graph.selectedBinding(graph.sessionSelection(context(manager)), optionalB).snapshot_id, optionalB.snapshotId);
const originalFile = manager.getSessionFile();
assert.ok(originalFile);

const restart = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "restore", originalFile], { encoding: "utf8", env: process.env, timeout: 30000 });
assert.equal(restart.status, 0, restart.stderr);
const restarted = JSON.parse(restart.stdout);
assert.equal(restarted.scopes[0].nodes.length, 3);
assert.ok(restarted.scopes[0].nodes.every(node => node.loaded));
assert.equal(restarted.scopes[0].nodes.find(node => node.binding.record.id === rootA.id).binding.snapshot_id, rootA.snapshotId);

const forkManager = SessionManager.open(originalFile);
const forkFile = forkManager.createBranchedSession(leafA);
assert.ok(forkFile && forkFile !== originalFile);
const fork = SessionManager.open(forkFile);
assert.deepEqual(exported(fork).scopes[0].nodes.map(node => node.binding.record.id).sort(), [rootA.id, requiredA.id].sort());
assert.ok(exported(fork).scopes[0].nodes.every(node => node.loaded));

const rewind = SessionManager.open(originalFile);
rewind.branch(leafA);
rewind.appendMessage({ role: "user", content: "Continue the original branch.", timestamp: Date.now() });
assert.equal(graph.selectedBinding(graph.sessionSelection(context(rewind)), optionalB), undefined);
const rewoundFile = rewind.getSessionFile();
const reopenedRewind = SessionManager.open(rewoundFile);
assert.equal(exported(reopenedRewind).scopes[0].nodes.length, 2);

reopenedRewind.appendCompaction("Raw Skill bodies have been removed.", null, 500);
assert.ok(exported(reopenedRewind).scopes[0].nodes.every(node => node.loaded === false));
assert.equal(graph.selectedBinding(graph.sessionSelection(context(reopenedRewind)), rootB).snapshot_id, rootA.snapshotId);
deliver(reopenedRewind, [rootA, requiredA]);
assert.ok(exported(reopenedRewind).scopes[0].nodes.every(node => node.loaded));
const retainedA = JSON.stringify(active(reopenedRewind));
const oldLeaf = reopenedRewind.getLeafId();
persist(reopenedRewind, [selectedB], "replace");
const projection = receipts.projectSelectedSourceMessages(active(reopenedRewind), graph.sessionSelection(context(reopenedRewind)));
assert.equal(projection.some(message => receipts.sourceMessageText(message.content).includes(rootA.body)), false);
assert.equal(active(reopenedRewind).some(message => receipts.sourceMessageText(message.content).includes(rootA.body)), true);
assert.ok(exported(reopenedRewind).scopes[0].nodes.every(node => !node.loaded));
deliver(reopenedRewind, [rootB, requiredB]);
assert.ok(exported(reopenedRewind).scopes[0].nodes.every(node => node.loaded));
assert.equal(JSON.stringify(graph.exportSessionSelection(context(reopenedRewind), active(reopenedRewind))).includes(directory), false);
reopenedRewind.branch(oldLeaf);
assert.equal(JSON.stringify(active(reopenedRewind)), retainedA);
assert.equal(graph.selectedBinding(graph.sessionSelection(context(reopenedRewind)), rootA).snapshot_id, rootA.snapshotId);

const fresh = SessionManager.create(directory, join(directory, "sessions"));
fresh.appendMessage({ role: "user", content: "Use the current root.", timestamp: Date.now() });
persist(fresh, [selectedB]);
assert.equal(graph.selectedBinding(graph.sessionSelection(context(fresh)), rootB).snapshot_id, rootB.snapshotId);
assert.throws(() => graph.reduceSessionSelection([{ type: "custom", customType: graph.SESSION_GRAPH_ENTRY, data: { version: 1, schema_version: 1, compiler_version: 2, selection_id: "future", mode: "extend", graphs: [selectedA.lock] } }]), /Unsupported/);
const tampered = structuredClone(selectedA.lock); tampered.bindings[0].snapshot_id = rootB.snapshotId;
assert.throws(() => graph.reduceSessionSelection([{ type: "custom", customType: graph.SESSION_GRAPH_ENTRY, data: { version: 1, schema_version: 1, compiler_version: 1, selection_id: "tampered", mode: "extend", graphs: [tampered] } }]), /inconsistent/);
assert.ok((await readFile(originalFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))
  .some(entry => receipts.sourceMessageText(entry.content ?? entry.message?.content).includes(rootA.body)));
const evidenceResult = { evidence_type: "installed_pi_session_manager_node", session_module: sessionModule,
  original_file: originalFile, fork_file: forkFile, checks: ["selected_not_loaded", "root_required_A", "optional_first_selected_B", "independent_node_restart", "fork_ancestor_only", "rewind_and_reopen", "compaction_lock_preserved_body_removed", "reload_exact_A", "explicit_refresh_B_provider_projection", "original_history_unchanged", "new_session_B", "future_schema_rejected", "tampered_vector_rejected"],
  selected_original: exported(reopenedRewind), selected_new: exported(fresh), restarted };
await writeFile(join(directory, "session-evidence.json"), JSON.stringify(evidenceResult, null, 2));
process.stdout.write(JSON.stringify({ ok: true, evidence: join(directory, "session-evidence.json"), checks: evidenceResult.checks }, null, 2) + "\n");
