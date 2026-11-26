#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const cases = [
  {
    "name": "library-each-input-default",
    "file": "src/library-selection.ts",
    "old": "accept: (ctx: ExtensionContext) => capture(ctx, true),",
    "replacement": "accept: (ctx: ExtensionContext) => capture(ctx, false),",
    "test": "library-selection.test.ts",
    "pattern": "every input rereads local default",
    "properties": [
      "NextTurnUsesSelectedLibrary"
    ]
  },
  {
    "name": "library-blocked-request",
    "file": "src/library-selection.ts",
    "old": "if (selection.status === \"blocked\") throw failure(selection.code);",
    "replacement": "void selection.status;",
    "test": "library-selection.test.ts",
    "pattern": "requested B is visible before verification and failure blocks defaults",
    "properties": [
      "FailedSwitchStopsRequestedFlow"
    ]
  },
  {
    "name": "library-directory-ticket",
    "file": "src/library-selection.ts",
    "old": "return captured === undefined || captured.key === libraryContext(capture({ ...ctx, [contextKey]: undefined }))!.key;",
    "replacement": "return true;",
    "test": "library-selection.test.ts",
    "pattern": "accepted A context and publication identity survive",
    "properties": [
      "DirectoryPublicationUsesTicket"
    ]
  },
  {
    "name": "library-command-session",
    "file": "src/library-selection.ts",
    "old": "const current = () => requested === generation && session === ctx.sessionManager?.getSessionId?.();",
    "replacement": "const current = () => true;",
    "test": "library-selection.test.ts",
    "pattern": "late B verification cannot append or publish into a different session",
    "properties": [
      "BranchSelectionIsRestored",
      "DirectoryPublicationUsesTicket"
    ]
  },
  {
    "name": "library-latest-branch-entry",
    "file": "src/library-selection.ts",
    "old": "filter(entry => entry.customType === LIBRARY_SELECTION_ENTRY).at(-1);",
    "replacement": "filter(entry => entry.customType === LIBRARY_SELECTION_ENTRY).at(0);",
    "test": "library-selection.test.ts",
    "pattern": "fork, rewind, resume and reset follow only active branch Library entries",
    "properties": [
      "BranchSelectionIsRestored",
      "NextTurnUsesSelectedLibrary"
    ]
  },
  {
    "name": "library-running-turn-context",
    "file": "src/host-skills.ts",
    "old": "inheritLibraryContext(ctx, runningContext ?? gate.active?.ctx ?? acceptedContext);",
    "replacement": "inheritLibraryContext(ctx, gate.active?.ctx ?? acceptedContext);",
    "test": "skill-guidance.test.ts",
    "pattern": "ordinary accepted turns freeze CLI Library scope across a later successful or failed switch",
    "properties": [
      "AdmittedTurnKeepsLibrary",
      "SelectionDoesNotCancelTurn"
    ]
  },
  {
    "name": "fixed-resource-path-binding",
    "file": "src/session-short-ref.ts",
    "old": "return JSON.stringify([\"resource\", value.owner, value.path]);",
    "replacement": "return JSON.stringify([\"resource\", value.owner, value.path, value.file_id ?? null]);",
    "test": "session-short-ref.test.ts",
    "pattern": "fixed paths never repair an old spelling through a stable File ID",
    "properties": [],
    "concrete_obligations": ["One fixed owner and path cannot acquire a different native File binding. This path-to-File mapping is outside the finite TLA variables."]
  },
  {
    "name": "fixed-resource-native-binding",
    "file": "src/session-short-ref.ts",
    "old": "&& previous.path !== value.path) fail(\"SHORT_REF_CONFLICT\");",
    "replacement": "&& false) fail(\"SHORT_REF_CONFLICT\");",
    "test": "session-short-ref.test.ts",
    "pattern": "fixed paths never repair an old spelling through a stable File ID",
    "properties": [],
    "concrete_obligations": ["One native File binding cannot move to another path within one fixed owner. This native binding uniqueness is outside the finite TLA variables."]
  },
  {
    "name": "content-qualification-publication",
    "file": "src/consumer-observation.ts",
    "old": "    revision++;\n    for (const changed of changes) changed();",
    "replacement": "    void changes;",
    "test": "host-content-search.test.ts",
    "pattern": "a later accepted REST denial retires an in-flight empty content result",
    "properties": ["NoRetiredPublication", "NewerEvidenceSurvives"]
  },
  {
    "name": "content-source-publication",
    "file": "src/content-publication.ts",
    "old": "started.source === undefined || started.source !== current.source",
    "replacement": "false",
    "test": "host-content-search.test.ts",
    "pattern": "source changes and an elapsed deadline reject late results",
    "properties": ["ScopeIsExact", "NoRetiredPublication"]
  },
  {
    "name": "content-session-publication",
    "file": "src/content-publication.ts",
    "old": "sessionId !== input.ctx.sessionManager?.getSessionId?.() || sessionFile !== input.ctx.sessionManager?.getSessionFile?.()",
    "replacement": "false",
    "test": "host-content-search.test.ts",
    "pattern": "source changes and an elapsed deadline reject late results",
    "properties": ["NoRetiredPublication"]
  },
  {
    "name": "content-branch-publication",
    "file": "src/content-publication.ts",
    "old": "ancestry.length > currentBranch.length || ancestry.some((entry, index) => entry !== currentBranch[index])",
    "replacement": "false",
    "test": "host-content-search.test.ts",
    "pattern": "source changes and an elapsed deadline reject late results",
    "properties": ["NoRetiredPublication"]
  },
  {
    "name": "content-deadline-publication",
    "file": "src/content-publication.ts",
    "old": "if (Date.now() >= input.deadline) throw timeout();",
    "replacement": "void input.deadline;",
    "test": "host-content-search.test.ts",
    "pattern": "source changes and an elapsed deadline reject late results",
    "properties": ["NoRetiredPublication"]
  },
  {
    "name": "content-cancelled-publication",
    "file": "src/content-publication.ts",
    "old": "closed || signal.aborted || started.task !== current.task",
    "replacement": "closed || started.task !== current.task",
    "test": "host-content-search.test.ts",
    "pattern": "a cancelled content waiter cannot cancel another valid waiter",
    "properties": ["NoCancelledPublication"]
  },
  {
    "name": "content-error-publication",
    "file": "src/host-skills.ts",
    "old": "      publication.assertCurrent();\n      const output = contentSearchFailure(error);",
    "replacement": "      const output = contentSearchFailure(error);",
    "test": "host-content-search.test.ts",
    "pattern": "source and branch changes retire remote failures before any error publication",
    "properties": ["NoRetiredPublication", "ScopeIsExact"]
  },
  {
    "name": "original-validation-time",
    "file": "src/consumer-observation.ts",
    "old": "validatedAt, validUntil: validatedAt + duration",
    "replacement": "validatedAt: Date.now(), validUntil: Date.now() + duration",
    "test": "consumer-state.test.ts",
    "pattern": "FV04 cached evidence",
    "properties": [
      "CacheValidationNotRenewed"
    ]
  },
  {
    "name": "expired-cache",
    "file": "src/consumer-observation.ts",
    "old": "evidence.origin === \"cache\" && evidence.validUntil <= now()",
    "replacement": "false",
    "test": "consumer-state.test.ts",
    "pattern": "FV04 cached evidence",
    "properties": [
      "ExpiredCacheCannotPublish"
    ]
  },
  {
    "name": "fixed-is-current",
    "file": "src/consumer-observation.ts",
    "old": "[\"default\", \"max_age\", \"refresh\"].includes",
    "replacement": "[\"default\", \"max_age\", \"refresh\", \"pinned\"].includes",
    "test": "consumer-observation.test.ts",
    "pattern": "current source evidence",
    "properties": [
      "FixedContentIsNotCurrent"
    ]
  },
  {
    "name": "equal-time-order",
    "file": "src/consumer-observation.ts",
    "old": "previous.live && next.live && ticket.order < previous.order",
    "replacement": "false",
    "test": "consumer-state.test.ts",
    "pattern": "FV04 request order",
    "properties": [
      "NewerEvidenceSurvives"
    ]
  },
  {
    "name": "generation",
    "file": "src/consumer-observation.ts",
    "old": "ticket.generation === generation() &&",
    "replacement": "true &&",
    "test": "consumer-observation.test.ts",
    "pattern": "late old failures",
    "properties": [
      "NoRetiredPublication"
    ]
  },
  {
    "name": "cancellation",
    "file": "src/consumer-observation.ts",
    "old": "!ticket.signal?.aborted",
    "replacement": "true",
    "test": "consumer-observation.test.ts",
    "pattern": "late old failures",
    "properties": [
      "NoCancelledPublication"
    ]
  },
  {
    "name": "scope-identity",
    "file": "src/discovery-records.ts",
    "old": "record.sourceScope ?? \"\"",
    "replacement": "\"\"",
    "test": "consumer-observation.test.ts",
    "pattern": "scope and denied-state identity",
    "properties": [
      "ScopeIsExact"
    ]
  },
  {
    "name": "dependency-target",
    "file": "src/host-skills.ts",
    "old": "for (const target of targets) if",
    "replacement": "for (const target of [...selected.slice(0, 1), ...targets]) if",
    "test": "host-prepare.test.ts",
    "pattern": "dependency denial changes only the exact child",
    "properties": [
      "DependencyFailureIsLocal"
    ]
  },
  {
    "name": "physical-denial-all-known-bindings",
    "file": "src/host-skills.ts",
    "old": "for (const target of targets) if",
    "replacement": "for (const target of targets.slice(0, 1)) if",
    "test": "host-refresh.test.ts",
    "pattern": "physical owner rebind preserves the exact physical denial boundary for old active content",
    "properties": [
      "NoDeniedBodyAtRequest"
    ]
  },
  {
    "name": "lookup-authentication-continuation",
    "file": "src/host-skills.ts",
    "old": "if (authentication) observeFailure(new SourceError(authentication.code, authentication.sourceId), ticket, [record], undefined, ctx);",
    "replacement": "void authentication;",
    "test": "host-refresh.test.ts",
    "pattern": "a fresh lookup authentication refusal withholds loaded and restored fixed content on ordinary continuation",
    "properties": [
      "NoDeniedBodyAtRequest"
    ]
  },
  {
    "name": "unknown-source",
    "file": "src/consumer-observation.ts",
    "old": "source !== \"notion\" && source !== \"local_cache\"",
    "replacement": "false",
    "test": "consumer-state.test.ts",
    "pattern": "FV04 an unrecognized source",
    "properties": [
      "UnknownIsNotPermission"
    ]
  },
  {
    "name": "commit-before-checks",
    "file": "src/host-skills.ts",
    "old": "input.refresh === true ? \"replace\" : \"extend\", false,",
    "replacement": "input.refresh === true ? \"replace\" : \"extend\", true,",
    "test": "host-prepare.test.ts",
    "pattern": "failed exact-file validation and output budget",
    "properties": [
      "SelectionRequiresChecks",
      "FailedRefreshPreservesSelection"
    ]
  },
  {
    "name": "output-budget",
    "file": "src/host-skills.ts",
    "old": "if (Buffer.byteLength(content) > Math.min(...prepared.graphs.map(graph => graph.budget.maxContextBytes)))",
    "replacement": "if (false)",
    "test": "host-prepare.test.ts",
    "pattern": "failed exact-file validation and output budget",
    "properties": [
      "SelectionRequiresChecks",
      "FailedRefreshPreservesSelection"
    ]
  },
  {
    "name": "member-own-pin",
    "file": "src/session-graph.ts",
    "old": "scope.bindings.set(binding.record.id, binding);",
    "replacement": "scope.bindings.set(binding.record.id, { ...binding, snapshot_id: graph.bindings[0]!.snapshot_id });",
    "test": "consumer-state.test.ts",
    "pattern": "FV05 root and Requires",
    "properties": [
      "EachMemberKeepsOwnPin"
    ]
  },
  {
    "name": "whole-body-proof",
    "file": "src/session-active.ts",
    "old": "&& sourceBodyLoaded(messages, record)",
    "replacement": "",
    "test": "session-active.test.ts",
    "pattern": "selected use and ready partial delivery",
    "properties": [
      "CompleteBoundGraphForActive"
    ]
  },
  {
    "name": "provider-acceptance",
    "file": "src/host-skills.ts",
    "old": "event.status < 200 || event.status >= 300",
    "replacement": "false",
    "test": "session-active.test.ts",
    "pattern": "failed, aborted, late and rewound deferred deliveries",
    "properties": [
      "ProviderAcceptanceBeforeProof"
    ]
  },
  {
    "name": "completed-turn",
    "file": "src/host-skills.ts",
    "old": "event.outcome !== \"completed\"",
    "replacement": "false",
    "test": "session-active.test.ts",
    "pattern": "failed, aborted, late and rewound deferred deliveries",
    "properties": [
      "CompletionBeforePersistence"
    ]
  },
  {
    "name": "public-projection-ack",
    "file": "src/host-skills.ts",
    "old": "run.pendingPersistence = { count: delivered.count, nativePromptSha256: projected.nativePromptSha256 };",
    "replacement": "run.persisted = delivered.count; run.pendingPersistence = { count: delivered.count, nativePromptSha256: projected.nativePromptSha256 };",
    "test": "session-active.test.ts",
    "pattern": "discarded boundary drafts",
    "properties": [
      "PublicProjectionBeforePersistence"
    ]
  },
  {
    "name": "provider-session-identity",
    "file": "src/host-skills.ts",
    "old": " || run.sessionId !== ctx.sessionManager?.getSessionId?.()",
    "replacement": "",
    "test": "consumer-state.test.ts",
    "pattern": "FV05 a late provider callback",
    "properties": [
      "NoRetiredDeliveryProof"
    ]
  },
  {
    "name": "current-branch-user",
    "file": "src/session-source-snapshot.ts",
    "old": "entry.sourceEntry.id === userEntryId && entry.sourceEntry.type === \"message\"",
    "replacement": "entry.sourceEntry.type === \"message\"",
    "test": "consumer-state.test.ts",
    "pattern": "FV05 rewinding to a different user entry",
    "properties": [
      "CurrentBranchOwnsProof"
    ]
  },
  {
    "name": "restore-failure-isolation",
    "file": "src/session-recovery.ts",
    "old": "if (error instanceof SourceError && error.code !== \"SOURCE_CANCELLED\") return { code: error.code, cause: error };",
    "replacement": "if (error instanceof SourceError && error.code !== \"SOURCE_CANCELLED\") throw error;",
    "test": "session-recovery.test.ts",
    "pattern": "missing fixed snapshots leave three consecutive ordinary requests usable",
    "properties": [
      "ConversationCanContinue"
    ]
  },
  {
    "name": "restored-mandatory-closure",
    "file": "src/session-recovery.ts",
    "old": "const withheld = new Set(incomplete.flatMap(value => [...value.root.closure]).filter(identity => !available.has(identity)));",
    "replacement": "const withheld = new Set<string>();",
    "test": "session-recovery.test.ts",
    "pattern": "a missing shared Required withholds incomplete roots",
    "properties": [
      "MandatoryClosureAtRequest"
    ]
  },
  {
    "name": "business-disabled-fixed-original",
    "file": "src/host-skills.ts",
    "old": "\n    if (denial && denial !== \"CONTENT_DISABLED\")",
    "replacement": "\n    if (denial)",
    "test": "session-recovery.test.ts",
    "pattern": "known business Disabled permits complete fixed restoration",
    "properties": [
      "DisabledOriginalsRemainUsable"
    ]
  },
  {
    "name": "restored-request-permission",
    "file": "src/host-skills.ts",
    "old": "assertContextAccess(run.contextMessages ?? [], ctx);",
    "replacement": "void run.contextMessages;",
    "test": "session-recovery.test.ts",
    "pattern": "authorization discovered after context still blocks",
    "properties": [
      "NoDeniedBodyAtRequest"
    ]
  },
  {
    "name": "restored-result-epoch",
    "file": "src/host-skills.ts",
    "old": "const result = await read(combined);\n      check();",
    "replacement": "const result = await read(combined);",
    "test": "session-recovery.test.ts",
    "pattern": "cancelled or released fixed restoration cannot publish its late result",
    "properties": [
      "NoRetiredRestoration"
    ]
  },
  {
    "name": "restored-final-closure",
    "file": "src/session-recovery.ts",
    "old": "if ((expected || present(final, root.identity)) && !complete)",
    "replacement": "if (false)",
    "test": "session-recovery.test.ts",
    "pattern": "a Required dropped before final system context is not accepted",
    "properties": [
      "MandatoryClosureAtRequest"
    ]
  }
];
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node scripts/check-consumer-state-mutations.mjs --out /absolute/new/output [--case NAME]");
  process.exit(0);
}
assert.equal(args[0], "--out");
assert.ok(args.length === 2 || args.length === 4 && args[2] === "--case");
assert.ok(path.isAbsolute(args[1]), "Output must be an absolute new directory");
const selected = args.length === 4 ? cases.filter(item => item.name === args[3]) : cases;
assert.ok(selected.length, "Unknown mutation case");
const repository = path.resolve(import.meta.dirname, ".."), pkg = path.join(repository, "packages/context-broker"), out = args[1];
fs.mkdirSync(out, { recursive: false, mode: 0o700 });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const version = spawnSync("bun", ["--version"], { encoding: "utf8" });
assert.equal(version.status, 0, "Bun is required");
const summary = { version: 1, bun: version.stdout.trim(), sourceCheckout: repository, cases: [], complete: false };
const save = () => fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
save();
try {
  for (const item of selected) {
    const directory = path.join(out, item.name);
    fs.mkdirSync(directory);
    for (const name of ["src", "scripts"]) fs.cpSync(path.join(pkg, name), path.join(directory, name), { recursive: true, errorOnExist: true, force: false });
    fs.mkdirSync(path.join(directory, "dist"));
    for (const name of ["ntn-skills-ref.cjs", "ntn-skills-runtime.json"])
      fs.copyFileSync(path.join(pkg, "dist", name), path.join(directory, "dist", name));
    fs.copyFileSync(path.join(pkg, "package.json"), path.join(directory, "package.json"));
    fs.symlinkSync(path.join(pkg, "node_modules"), path.join(directory, "node_modules"), "dir");
    const originalFile = path.join(pkg, item.file), file = path.join(directory, item.file);
    const original = fs.readFileSync(file, "utf8"), originalHash = hash(Buffer.from(original));
    assert.equal(original.split(item.old).length, 2, item.name + ": guard changed; review the mutation");
    const entry = { name: item.name, properties: item.properties, ...(item.concrete_obligations ? { concrete_obligations: item.concrete_obligations } : {}), source: path.relative(repository, originalFile),
      sourceSha256: originalHash, test: item.test, pattern: item.pattern,
      testSha256: hash(fs.readFileSync(path.join(pkg, "scripts", item.test))), phases: [], restored: false, originalWorkspaceUnchanged: false };
    summary.cases.push(entry); save();
    const run = phase => {
      const argv = ["test", path.join(directory, "scripts", item.test), "--test-name-pattern", item.pattern, "--timeout", "30000"];
      const started = Date.now(), result = spawnSync("bun", argv, { cwd: directory, encoding: "utf8", timeout: 60000 });
      fs.writeFileSync(path.join(directory, phase + ".stdout"), result.stdout ?? "");
      fs.writeFileSync(path.join(directory, phase + ".stderr"), result.stderr ?? "");
      entry.phases.push({ phase, argv, exitCode: result.status, signal: result.signal, elapsedMs: Date.now() - started,
        stdoutSha256: hash(result.stdout ?? ""), stderrSha256: hash(result.stderr ?? "") }); save();
      assert.ok(!result.error && !result.signal, item.name + ": execution error is not a guard counterexample");
      return result;
    };
    const baseline = run("baseline");
    assert.equal(baseline.status, 0, item.name + ": baseline");
    assert.match(baseline.stderr, /[1-9][0-9]* pass/, item.name + ": no matched baseline test");
    fs.writeFileSync(file, original.replace(item.old, item.replacement));
    const mutated = run("mutated");
    assert.equal(mutated.status, 1, item.name + ": mutation must fail");
    assert.match(mutated.stderr, /error: expect|Expected:|expect\(received\)/, item.name + ": must fail a behavior assertion");
    assert.doesNotMatch(mutated.stderr, /SyntaxError|Cannot find module|Module not found|error: Cannot find/);
    fs.writeFileSync(file, original);
    const restored = run("restored");
    assert.equal(restored.status, 0, item.name + ": restored replay");
    assert.equal(hash(fs.readFileSync(file)), originalHash);
    assert.equal(hash(fs.readFileSync(originalFile)), originalHash, "Active checkout changed during isolated mutation");
    entry.restored = true; entry.originalWorkspaceUnchanged = true; save();
    console.log(JSON.stringify({ name: item.name, baseline: 0, mutated: 1, restored: 0, originalWorkspaceUnchanged: true }));
  }
  summary.complete = true;
} catch (error) {
  summary.error = { name: error.name, message: error.message };
  throw error;
} finally { save(); }
console.log("Real-guard mutation evidence: " + out);
