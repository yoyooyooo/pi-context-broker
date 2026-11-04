import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

process.umask(0o077);
const script = fileURLToPath(import.meta.url), repo = resolve(dirname(script), "../../..");
const hash = value => createHash("sha256").update(value).digest("hex");
const uuid = id => "00000000-0000-4000-8000-" + String(id).padStart(12, "0");
const scope = hash("controlled short-reference source, no credentials");
const inside = (root, target) => { const value = relative(root, target); return value === "" || !value.startsWith("..") && !isAbsolute(value); };
const exists = path => access(path).then(() => true, () => false);
async function json(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
if (process.argv.includes("--help")) {
  process.stdout.write("Validate short refs with an installed Pi SessionManager; no provider or Notion calls.\n"
    + "CONTEXT_BROKER_PI_SESSION_MODULE=/absolute/pi/dist/core/session-manager.js\n"
    + "CONTEXT_BROKER_SHORT_REF_EVIDENCE=/absolute/directory/outside/checkout\n"
    + "node packages/context-broker/scripts/session-short-ref-session.mjs [--doctor]\n");
  process.exit(0);
}
const sessionModule = process.env.CONTEXT_BROKER_PI_SESSION_MODULE;
if (!sessionModule || !isAbsolute(sessionModule)) throw new Error("Set an absolute CONTEXT_BROKER_PI_SESSION_MODULE.");
const packagePath = resolve(dirname(sessionModule), "../../package.json"), piPackage = JSON.parse(await readFile(packagePath, "utf8"));
const requirePi = createRequire(sessionModule), jitiPath = requirePi.resolve("jiti");
const provenance = { node: process.version, node_path: process.execPath, pi_version: piPackage.version,
  session_module: sessionModule, session_module_sha256: hash(await readFile(sessionModule)),
  pi_package_json: packagePath, pi_package_json_sha256: hash(await readFile(packagePath)),
  jiti_entry: jitiPath, jiti_entry_sha256: hash(await readFile(jitiPath)),
  scope: "actual installed SessionManager with controlled records; no Pi agent, provider, source CLI or Notion request" };
if (process.argv.includes("--doctor")) { process.stdout.write(JSON.stringify(provenance, null, 2) + "\n"); process.exit(0); }
assert.equal(piPackage.version, "1.4.0", "This evidence plan is frozen for installed Pi 1.4.0");
const { createJiti } = requirePi("jiti"), jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const { SessionManager } = await import(pathToFileURL(sessionModule).href);
const core = await jiti.import(fileURLToPath(new URL("../src/session-short-ref.ts", import.meta.url)));
const bridge = await jiti.import(fileURLToPath(new URL("../src/session-short-ref-host.ts", import.meta.url)));
function context(manager) { return { sessionManager: manager, cwd: manager.getCwd(), mode: "rpc", hasUI: false }; }
function host(manager, writable = true) {
  return bridge.createSessionShortRefHost({ on() { throw new Error("No host event loop is used in this state-layer verification"); },
    ...(writable ? { appendEntry: (type, data) => manager.appendCustomEntry(type, data) } : {}) });
}
function summarize(manager, wanted, absent = []) {
  const refs = host(manager, false), ctx = context(manager), state = core.reduceSessionShortRefs(manager.getBranch());
  const mappings = wanted.map(ref => {
    const value = refs.resolve(ctx, ref);
    return { ref, value, ...(value.kind === "candidate" ? {} : { exported: refs.export(ctx, ref) }) };
  });
  for (const ref of absent) assert.throws(() => refs.resolve(ctx, ref), { code: "SHORT_REF_UNKNOWN" });
  return { mappings, rejected: absent, binding_count: state.bindings.size, session_id: manager.getSessionId(), leaf_id: manager.getLeafId() };
}
if (process.argv[2] === "restore") {
  const requestPath = resolve(process.argv[3] ?? ""), request = JSON.parse(await readFile(requestPath, "utf8"));
  assert.equal(request.kind, "owned_short_ref_restore");
  assert.ok(inside(resolve(request.evidence_root), requestPath) && inside(resolve(request.evidence_root), resolve(request.session_file)));
  const before = hash(await readFile(request.session_file));
  const manager = SessionManager.open(request.session_file, dirname(request.session_file));
  const result = summarize(manager, request.wanted, request.absent);
  assert.equal(hash(await readFile(request.session_file)), before, "read-only resume changed the JSONL");
  process.stdout.write(JSON.stringify({ ok: true, provenance, session_file_sha256: before, ...result }));
  process.exit(0);
}

const evidenceRoot = process.env.CONTEXT_BROKER_SHORT_REF_EVIDENCE;
if (!evidenceRoot || !isAbsolute(evidenceRoot)) throw new Error("Set an absolute external CONTEXT_BROKER_SHORT_REF_EVIDENCE.");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const parent = await realpath(evidenceRoot);
assert.ok(!inside(await realpath(repo), parent), "Evidence must be outside the checkout");
const directory = await mkdtemp(join(parent, "session-short-ref-"));
const sessions = join(directory, "sessions"), verificationSource = join(directory, "verification-source");
await mkdir(sessions, { mode: 0o700 }); await mkdir(verificationSource, { mode: 0o700 });
const sourceFiles = [script, fileURLToPath(new URL("../src/session-short-ref.ts", import.meta.url)),
  fileURLToPath(new URL("../src/session-short-ref-host.ts", import.meta.url)),
  fileURLToPath(new URL("session-short-ref.test.ts", import.meta.url)), fileURLToPath(new URL("session-short-ref-host.test.ts", import.meta.url))];
const sourceHashes = [];
for (const source of sourceFiles) {
  const bytes = await readFile(source), name = source.slice(source.lastIndexOf("/") + 1);
  await writeFile(join(verificationSource, name), bytes, { mode: 0o600, flag: "wx" });
  sourceHashes.push({ source, copy: join(verificationSource, name), bytes: bytes.length, sha256: hash(bytes) });
}
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
assert.equal(head.status, 0, head.stderr);
const plan = { kind: "installed_pi_short_ref_session_manager", version: 1, source_tree_head: head.stdout.trim(), provenance,
  evidence_root: directory, source_files: sourceHashes, permissions: { directories: "0700", files: "0600" },
  coverage: ["preconversation_memory_then_user_flush", "new_and_duplicate", "shared_ancestor_fork", "sibling_only_rejection", "rewind_and_reopen",
    "independent_node_resume", "explicit_refresh_new_binding", "old_binding_immutable", "compaction_preserves_reference_map", "canonical_fixed_export", "new_session_isolation"],
  limitations: ["Controlled source metadata and snapshot receipts; no source authorization or Notion bytes were fetched",
    "SessionManager and ExtensionAPI bridge only; this is not native read/search/prepare or provider-token acceptance",
    "Hashes freeze listed source files and installed entry files, not the entire installed dependency closure"] };
await json(join(directory, "plan.json"), plan);
const checks = [], children = [], files = new Set();
function check(name, detail = {}) { checks.push({ name, status: "passed", monotonic_ns: String(process.hrtime.bigint()), ...detail }); }
function fixture(name = "owner", revision = "one", resourcePath = "resources/guide.md") {
  const id = "shared_skill:state-fixture:" + name, ref = "skill://" + encodeURIComponent(id) + "/";
  const record = { id, kind: "skill", name, alias: name, description: "Controlled state-only fixture", enabled: true, default_context: false,
    entrypoint: "SKILL.md", ref: ref + "SKILL.md", locator: { type: "shared_skill", library_id: "state-fixture", skill_id: name,
      page_id: "00000000-0000-4000-8000-" + hash(name).slice(0, 12), database_id: uuid(10), data_source_id: uuid(11) } };
  const body = "Controlled instructions " + name + " " + revision + ".\n", snapshotId = "s_" + hash(name + " snapshot " + revision), versionId = hash(name + " version " + revision);
  const files = [{ path: "SKILL.md", bytes: Buffer.byteLength(body), sha256: hash(body), ref: ref + "SKILL.md?snapshot=" + snapshotId + "&file_id=main" },
    { path: resourcePath, bytes: 8, sha256: hash("resource"), ref: ref + resourcePath + "?snapshot=" + snapshotId + "&file_id=guide" }];
  const metadata = { ...record, source: "notion", sourceId: "controlled", sourceScope: scope, path: join(directory, "not-materialized", "SKILL.md"),
    aliases: [], normalizedAliases: [], normalizedName: name, normalizedDescription: record.description, autoloadEnabled: false };
  const selected = { ...metadata, body, snapshotId, versionId,
    preparationBinding: { record, scope, snapshot_id: snapshotId, version_id: versionId, body_sha256: hash(body), ref: files[0].ref },
    fileBindings: [{ file_id: "main", path: "SKILL.md", page_id: record.locator.page_id }, { file_id: "guide", path: resourcePath, page_id: uuid(2) }],
    entryManifest: { version: 1, root: join(directory, "not-materialized"), receipt: join(directory, "not-materialized-receipt"), manifest_id: hash("controlled fixture manifest"),
      files, manifest_complete: true, local_files_ready: false, materialized_paths: ["SKILL.md"] } };
  return { metadata, selected, files };
}
async function restart(name, manager, wanted, absent = []) {
  const sessionFile = manager.getSessionFile(), expected = summarize(manager, wanted, absent);
  assert.ok(sessionFile); files.add(sessionFile);
  const request = join(directory, name + "-request.json");
  await json(request, { kind: "owned_short_ref_restore", evidence_root: directory, session_file: sessionFile, wanted, absent });
  const started = process.hrtime.bigint();
  const child = spawnSync(process.execPath, [script, "restore", request], { cwd: directory, encoding: "utf8", timeout: 30000,
    env: { CONTEXT_BROKER_PI_SESSION_MODULE: sessionModule } });
  const finished = process.hrtime.bigint();
  await writeFile(join(directory, name + "-stdout.json"), child.stdout ?? "", { mode: 0o600, flag: "wx" });
  await writeFile(join(directory, name + "-stderr.txt"), child.stderr ?? "", { mode: 0o600, flag: "wx" });
  children.push({ name, pid: child.pid ?? null, started_monotonic_ns: String(started), finished_monotonic_ns: String(finished),
    exit_code: child.status, signal: child.signal, error: child.error ? String(child.error) : null });
  assert.equal(child.status, 0, child.stderr || String(child.error ?? "resume process failed"));
  const actual = JSON.parse(child.stdout);
  assert.equal(actual.ok, true);
  for (const key of Object.keys(expected)) assert.deepEqual(actual[key], expected[key], name + " " + key);
  check(name, { session_file: sessionFile, session_file_sha256: actual.session_file_sha256, child_pid: child.pid });
  return actual;
}
let outcome;
try {
  const f = fixture(), manager = SessionManager.create(directory, sessions), refs = host(manager), ctx = context(manager);
  const candidate = refs.candidate(ctx, f.metadata), sessionFile = manager.getSessionFile();
  assert.ok(sessionFile); files.add(sessionFile);
  assert.equal(await exists(sessionFile), false, "Pi's setup-only session unexpectedly flushed before conversation");
  manager.appendMessage({ role: "user", content: "Controlled state verification; do not run a model.", timestamp: Date.now() });
  assert.equal(await exists(sessionFile), true);
  assert.ok((await readFile(sessionFile, "utf8")).includes(candidate));
  check("preconversation_memory_then_user_flush", { session_file: sessionFile });
  const entriesBefore = manager.getEntries().length;
  assert.equal(refs.candidate(ctx, f.metadata), candidate);
  assert.equal(manager.getEntries().length, entriesBefore);
  const mainA = refs.selected(ctx, f.selected), resourceA = refs.resource(ctx, f.selected, f.files[1].ref);
  assert.equal(refs.resource(ctx, f.selected, f.files[1].ref), resourceA);
  const shared = [candidate, mainA, resourceA], ancestorLeaf = manager.getLeafId();
  assert.ok(ancestorLeaf);
  check("new_and_duplicate", { handles: shared, ancestor_leaf: ancestorLeaf });

  const leftOnly = refs.selected(ctx, fixture("left-only").selected);
  const originalBeforeRewind = await readFile(sessionFile);
  const forkCreator = SessionManager.open(sessionFile, sessions), forkFile = forkCreator.createBranchedSession(ancestorLeaf);
  assert.ok(forkFile && forkFile !== sessionFile); files.add(forkFile);
  const fork = SessionManager.open(forkFile, sessions), forkRefs = host(fork), forkContext = context(fork);
  for (const ref of shared) assert.deepEqual(forkRefs.resolve(forkContext, ref), refs.resolve(ctx, ref));
  const rightOnly = forkRefs.selected(forkContext, fixture("right-only").selected);
  assert.throws(() => forkRefs.resolve(forkContext, leftOnly), { code: "SHORT_REF_UNKNOWN" });
  assert.throws(() => refs.resolve(ctx, rightOnly), { code: "SHORT_REF_UNKNOWN" });
  check("shared_ancestor_fork_and_sibling_only_rejection", { original_file: sessionFile, fork_file: forkFile, left_only: leftOnly, right_only: rightOnly });
  await restart("independent_resume_original", manager, [...shared, leftOnly], [rightOnly]);
  await restart("independent_resume_fork", fork, [...shared, rightOnly], [leftOnly]);

  manager.branch(ancestorLeaf);
  assert.throws(() => refs.resolve(ctx, leftOnly), { code: "SHORT_REF_UNKNOWN" });
  assert.ok(manager.getEntries().some(entry => entry.type === "custom" && entry.data?.ref === leftOnly), "Abandoned sibling must remain in the actual JSONL tree");
  manager.appendMessage({ role: "user", content: "Persist the rewound branch without provider work.", timestamp: Date.now() });
  const afterRewind = await readFile(sessionFile);
  assert.ok(afterRewind.subarray(0, originalBeforeRewind.length).equals(originalBeforeRewind), "Rewind mutated original history bytes");
  check("rewind_preserves_abandoned_history", { prefix_bytes: originalBeforeRewind.length, prefix_sha256: hash(originalBeforeRewind) });
  await restart("independent_resume_rewound", manager, shared, [leftOnly, rightOnly]);

  const freshVersion = fixture("owner", "two", "moved/guide.md");
  const mainB = refs.selected(ctx, freshVersion.selected), resourceB = refs.resource(ctx, freshVersion.selected, freshVersion.files[1].ref);
  assert.notEqual(mainA, mainB); assert.notEqual(resourceA, resourceB);
  assert.equal(refs.resolve(ctx, mainA).canonicalRef, f.files[0].ref);
  assert.equal(refs.resolve(ctx, resourceA).canonicalRef, f.files[1].ref);
  assert.equal(refs.resolve(ctx, mainB).canonicalRef, freshVersion.files[0].ref);
  assert.equal(refs.resolve(ctx, resourceB).canonicalRef, freshVersion.files[1].ref);
  assert.equal(refs.resolve(ctx, candidate).kind, "candidate");
  check("refresh_creates_new_binding_and_old_binding_does_not_drift", { old: [mainA, resourceA], current: [mainB, resourceB] });
  const beforeCompaction = summarize(manager, [...shared, mainB, resourceB], [leftOnly, rightOnly]);
  manager.appendCompaction("Controlled summary; no source body was delivered.", null, 0);
  assert.deepEqual(summarize(manager, [...shared, mainB, resourceB], [leftOnly, rightOnly]).mappings, beforeCompaction.mappings);
  check("compaction_preserves_reference_map");
  const finalResume = await restart("independent_resume_refreshed_and_compacted", manager, [...shared, mainB, resourceB], [leftOnly, rightOnly]);
  const portable = finalResume.mappings.filter(item => item.exported).map(item => item.exported);
  assert.ok(portable.every(item => item.ref.includes("?snapshot=s_") && item.owner.version_id && item.owner.identity.locator));
  assert.equal(JSON.stringify(portable).includes("sr:"), false);
  assert.equal(JSON.stringify(portable).includes(directory), false);
  await json(join(directory, "canonical-exports.json"), portable);
  check("canonical_fixed_export", { exports: portable.length, contains_session_handles: false });

  const fresh = SessionManager.create(directory, sessions), freshRefs = host(fresh), freshContext = context(fresh);
  fresh.appendMessage({ role: "user", content: "Independent new state-only session.", timestamp: Date.now() });
  const freshMain = freshRefs.selected(freshContext, freshVersion.selected);
  assert.notEqual(freshMain, mainB);
  for (const old of [...shared, mainB, resourceB]) assert.throws(() => freshRefs.resolve(freshContext, old), { code: "SHORT_REF_UNKNOWN" });
  check("new_session_isolation", { fresh_handle: freshMain, prior_handles_rejected: shared.length + 2 });
  await restart("independent_resume_new_session", fresh, [freshMain], [...shared, mainB, resourceB]);
  outcome = { ok: true, status: "passed_state_layer_only", evidence_root: directory, session_files: [...files], checks, children, provenance,
    source_files: sourceHashes, limits: plan.limitations, original_history_prefix: { bytes: originalBeforeRewind.length, sha256: hash(originalBeforeRewind) } };
} catch (error) {
  outcome = { ok: false, status: "failed", evidence_root: directory, session_files: [...files], checks, children, provenance,
    source_files: sourceHashes, error: { name: error?.name, message: String(error?.message ?? error), code: error?.code, stack: error?.stack }, limits: plan.limitations };
}
await json(join(directory, "result.json"), outcome);
const artifacts = [];
async function inventory(root) {
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    assert.equal(item.isSymbolicLink(), false, "Owned evidence must not contain symlinks");
    if (item.isDirectory()) await inventory(path);
    else {
      assert.ok(item.isFile()); const bytes = await readFile(path), metadata = await stat(path);
      artifacts.push({ path, relative_path: relative(directory, path), bytes: bytes.length, sha256: hash(bytes), mode: (metadata.mode & 0o777).toString(8) });
    }
  }
}
await inventory(directory);
assert.ok(artifacts.every(item => item.mode === "600"), "Evidence files must have mode 0600");
await json(join(directory, "artifact-manifest.json"), { version: 1, owned_root: directory, artifacts,
  manifest_excludes_itself: true, raw_session_files_retained: true, completed_owned_child_pids: children.map(item => item.pid),
  cleanup: "No scratch or host processes created outside this evidence directory; original JSONL retained for resume verification" });
process.stdout.write(JSON.stringify({ ok: outcome.ok, evidence: join(directory, "result.json"), manifest: join(directory, "artifact-manifest.json"),
  status: outcome.status, checks: checks.map(item => item.name), children: children.length }, null, 2) + "\n");
if (!outcome.ok) process.exitCode = 1;
