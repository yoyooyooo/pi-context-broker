# Benchmark turn bridge

`benchmark/turn-bridge.mjs` supplies a parent controller and a public subject hook.
`runSubject` now connects it to `launchSubject` and the existing runtime's
`afterTurn` boundary. This integration changes the candidate source inventory and
requires a new build and admission capture. Historical route-gate runs and their
scores do not acquire these capabilities retrospectively.

The existing runtime calls `hooks.afterTurn({turn_id, ref})` after a real user turn
has settled, while the same Pi `AgentSession` remains alive. Its supplied `turns`
array is iterated directly. The bridge uses that boundary to pause the subject,
perform a previously frozen controller event, and optionally insert an approved
public clarification response before the next natural turn. It does not create
a new Pi session or choose a prompt from an oracle result.

## Parent integration

`runSubject` enables the bridge for execution with multiple natural turns,
fixture events, or frozen clarification responses. Admission capture sends no
user turn and does not dispatch controller events. The subject source projection
always includes the exact `turn-bridge.mjs` bytes, so capture and execution use
the same source inventory. The controller-only `fixture-turn-adapter.mjs` and
`fixture.mjs` are excluded from that projection.

`verifyTurnRuntimeBuild` requires a completed shared build with consistent
environment ownership, selected CLI and source/package inventory identities.
The frozen `subject.mjs`, `turn-bridge.mjs` and `runtime/episode-runner.mjs` bytes
must match the common implementation making the call. Both configuration and
`runSubject` enforce this boundary, including zero-model capture. Configuration
does so before remote preparation. Historical single-turn cases without turn
controls retain their existing build requirements.

The controller binding uses the following fields. Only `public_case.turns` and
the bridge's small public channel configuration reach the subject:

```js
{
  public_case: { turns: [{id: 'turn-1', prompt: '...'}, {id: 'turn-2', prompt: '...'}] },
  events: [{id: 'policy-v2', before_turn: 'turn-2', kind: 'publish-version',
    skill_id: 'routing', version: 'v2'}],
  fixture_control: {path: '/owned/controller/fixture/plan.json', sha256: '...'},
  clarification: [{topic_id: 'delivery-mode', max_questions: 1, response: '...'}],
  clarification_policy: {version: 1, kind: 'literal-question-topic-v1',
    topics: [{topic_id: 'delivery-mode', match_any: ['配送', 'delivery']}]},
}
```

Every event must match its frozen episode-owned fixture plan, including its
actual episode and runtime root. Shared read-only fixtures cannot be mutated.
The default clarification policy recognizes explicit questions about the two
declared topics, delivery mode and target currency. New topics require frozen
literal matching rules. Ambiguous or unmatched text selects no response. This
is a bounded deterministic response policy; it does not infer correctness from
the oracle or implement an unrestricted semantic conversation grader.

The lower-level API remains available for a controller that already owns these
bindings:

Create one private controller directory per episode. It must be outside the
subject run and must not contain that run. Preparing the controller does not
create `runRoot`; the shared paired-environment launcher remains its owner.

```js
const controller = await createTurnBridgeController({
  runRoot,
  controllerRoot: join(privateRoot, runId),
  runId,
  episodeId: runId,
  turns: binding.public_case.turns,
  events: binding.events,
  clarifications: binding.clarification,
  evidenceRoots: [fixtureControlRoot],
  policy: { id: 'frozen-clarification-policy', version: 1 },
  limits: { wallMs: 240000, waitMs: 90000, eventMs: 30000 },
});

// Only controller.publicConfig belongs in the subject launch configuration.
const subjectPromise = runEnvironment(sharedLaunch);
const bridgePromise = controller.serve({
  subject: subjectPromise,
  executeEvent: ({ eventId, episodeId, signal }) =>
    applyBenchmarkFixtureEvent({ controlRoot: fixtureControlRoot,
      eventId, episodeId, ownedStateRoot, runtimeEnv, signal }),
  reconcileEvent: ({ eventId, episodeId }) =>
    reconcileBenchmarkFixtureEvent({ controlRoot: fixtureControlRoot,
      eventId, episodeId }),
  selectClarification: frozenClarificationSelector,
});
const [shared, bridge] = await Promise.all([subjectPromise, bridgePromise]);
```

The execution and clarification callbacks are controller code. Freeze their
implementation with the experiment; the bridge's plan descriptor does not prove
the identity of an arbitrary JavaScript closure. `signal` is an operation deadline
signal. A mutating adapter must respect it and report uncertain effects honestly.
The bridge never changes credentials, global proxies or model transport.

`events` retain the corpus shape, for example:

```json
{"id":"policy-v2","before_turn":"turn-2","kind":"publish-version","skill_id":"routing","version":"v2"}
```

Events are executed immediately before the named next natural turn. When a public
clarification is inserted first, the event remains pending until that clarification
turn has settled. Initial state is materialized before launch; an event targeting
the first turn is rejected by this between-turn interface.

The private plan keeps only `topic_id`, `max_questions` and `response` from each
clarification specification. `expected_value` is discarded. The selector receives
the actual completed turn text, its prefix-bound evidence, and still-available
frozen responses. It returns a permitted topic ID or null. The subject receives
only `{id, kind: 'clarification', prompt: response}`. The topic, grading oracle and
mutation plan stay private. Whether the model asked the right question before
delivery remains an independently graded observation.

## Subject integration

Pass the same mutable turn array to the bridge and runtime. The hook inserts only
controller-approved public responses, preserving the order of original turns.

```js
const bridge = await connectTurnBridge({
  ...launch.turn_bridge,
  turns: config.turns,
});
try {
  return await runEpisode(config, { afterTurn: bridge.afterTurn });
} finally {
  await bridge.close();
}
```

`close()` cancels a pending receipt wait and seals the subject journal. A repeated
hook call for the same turn and exact pause reference reuses its prior response;
it does not insert another clarification or issue another event. Concurrent
checkpoints are rejected.

The controller verifies the request against the actual owned runtime event file:
the cited line must be `controller_pause_start`, its completed `user_turn_end`
must report settled/idle, and the session ID must stay the same. The observed
prefix is read twice and hashed while later background events may still append.
A resumed controller revalidates previously accepted prefixes.

The launcher's initial `run.json` can exist before its first write has finished.
The bridge waits for complete parseable bytes under one fixed deadline. A parsed
wrong run identity fails immediately; a persistently invalid file stops the run
with its retained path, byte count and hash. Parser excerpts are excluded from
the journal. This publication wait neither extends the deadline nor changes an
existing manifest.

## Event outcomes and recovery

The fixture adapter returns this boundary shape:

```js
{
  status: 'applied', // or blocked, failed, not_applied, unknown
  event_id: 'policy-v2',
  episode_id: runId,
  effect_unknown: false,
  logical_operation: 'routing/SKILL.md',
  evidence_id: 'controller-effect-proof',
  receipt: { path: '/owned/private/receipt.json', sha256: '...' },
}
```

For a known outcome the bridge rereads the receipt, verifies its hash, and checks
the receipt JSON's `event_id`, `episode_id` and `status`. The fixture adapter owns
effect readback: it may report `applied` only after verifying the actual effect.
The bridge validates that evidence boundary; it does not infer an effect from a
tool ordinal or a successful command exit.

The private journal is synced before dispatching an event. A crash can therefore
leave `event_started` without a terminal result. On recovery:

| Actual persisted state | Controller action |
|---|---|
| Verified `applied` receipt | Reuse it; do not repeat the mutation. |
| `blocked` or `failed` receipt | Stop the episode. |
| Explicit `unknown`, exception, timeout, or invalid/missing receipt | Stop; do not replay the mutation. |
| Started without terminal receipt | Call only the read-only reconciler first. |
| Reconciler proves `applied` | Resume without another mutation. |
| Reconciler proves `not_applied` with a valid readback receipt | Dispatch using the same deterministic idempotency key. |
| Reconciler cannot establish the effect | Stop with unknown effect. |

A timed-out adapter may still be unwinding. The terminal unknown outcome is never
automatically retried. The controller result must stop the surrounding batch; a
later manual recovery must independently establish the actual remote state.

`runSubject` waits for both the bridge and the shared child. It returns
`turn_control` with the private controller result receipt and `dispatch_error`
when launcher acknowledgement failed. It still reads the actual shared terminal
and `episode-result.json`, so a bridge or launcher error cannot erase observed
model requests or usage. A stopped bridge or uncertain launcher outcome sets
`stop_batch: true`. A controller prepared before a failed launch is explicitly
abandoned and its owner is released with a retained terminal journal.

Recovery uses `readSubjectTurnControl({controlRoot, runRoot, runId, required})`
from `execute.mjs`. It returns `absent`, `verified` or `unavailable` with the
retained result/reference. `required` follows the frozen binding's turns,
events and clarification declarations. The reader checks owned paths, run and
episode identity, the plan hash, complete journal hash and chain, terminal
checkpoint counts, event outcomes and accepted prefixes of actual runtime
events. Missing or inconsistent required evidence stops dispatch; it does not
erase usage or rewrite the business grade.

## Fixture effects and native parity

The production adapter calls the existing fixture `apply`, `reconcile` and
runtime `attach` APIs. It does not seed a Store. Fault attachment uses the actual
shared `run.json` paths and recorded runtime ownership. A frozen fixture Git
receipt, when present, must match the shared runtime's selected Git path, hash
and version. Source-write events require that proof; the adapter never changes
the fixture plan or selects a different Git during a turn.

For native execution, `publish-version` is the supported common event. The
adapter verifies the fixture effect receipt, the complete native export,
independent readback and raw readback hashes, every file's bytes and executable
mode, and the actual run-owned native root. It then stages the complete tree,
moves the previous tree into private history, and moves the staged tree into
place. The subject remains paused throughout. Each directory rename is atomic;
the pair is not claimed to be a single operating-system exchange. A durable
intent records that interval, and any uncertain or interrupted effect stops the
episode. After the moves, both the retained old tree and current new tree are
read back before the bridge receives `applied`.

The narrow parent-only `installVerifiedNativeVersion` export exposes that same
installation step for an owned apparatus replay. It still verifies the actual
fixture receipt, episode identity, full source/readback tree and owned runtime.
It does not dispatch a remote event or relax the production adapter's frozen
fixture/runtime binding. Replaying a retained real Notion readback is recorded
as an installation proof, not as a new remote mutation or a paid sample.

Notion metadata toggles, Store faults and source-write diagnostics have no
declared native counterpart in this adapter. A native condition receives a
retained `blocked` / `unsupported_native` receipt before any fixture mutation.
These events can be assessed as extension capabilities in a suitable condition;
they are not counted as common native capabilities.

## Writable fixtures for every scheduled slot

`configure` accepts `setup.episode_fixtures` when a selected case declares events.
It uses the same pair generator and balanced schedule as the final protocol to
assign each condition/repeat its eventual run ID. Before any model execution,
each writable slot receives an independent fixture through the existing
`planBenchmarkFixture` / `prepareBenchmarkFixture` APIs. Preparation is sequential
and uses the selected immutable CLI build and the existing Notion credential.

```json
{
  "episode_fixtures": {
    "version": 1,
    "project_page_id": "owned-synthetic-parent-uuid",
    "placement": "notion",
    "source_bindings": {},
    "git": "/absolute/maintained/git"
  }
}
```

The parent must be the explicitly authorized synthetic-material parent. This
configuration path currently supports a complete remote catalog, including
explicit pinned source bindings. `project` and `mixed` placement are rejected
before preparation; the lower-level fixture APIs retain their separate scopes.
Read-only cases keep their existing shared material path.

Actual Notion entries, physical Skill names and bound prompts can differ between
owned slots. They are not substituted after freezing. Every writable slot gets
its own zero-model startup capture and expectation. The candidate's complete
expectation set includes the slot and its materialization hash; one capture is
never extrapolated to another writable slot or repeat. `captureOnly` itself
applies no turn event and sends no model request. Explicit initial material
preparation happens before these captures.

`execution.episode_fixtures.slot_bindings` freezes private binding file references
with byte hashes. Each record binds the canonical case, full slot identity,
exact run ID, build, actual public case and prompt hashes, complete initial file
inventory hash, authorization, entry, fixture plan and materialization proof.
Canonical case/pair/repeat/cluster identities and the planned denominator stay
unchanged. Physical names are a verified mapping of the same logical business
material, not new cases. The fixture plan and oracle stay outside the subject.

Dispatch, interrupted-episode recovery and raw-evidence reanalysis only read this
mapping. Missing or crossed slots, changed files and missing per-slot startup
expectations are rejected; no case-level fallback can authorize a writable slot.
Initial binding reconstruction uses `prepared_bindings`, the immutable snapshot,
so a later version event cannot rewrite the initial state through the mutable
fixture provider's `objects/bindings.json`.

A retained preparation intent is written before the first API call. If that call
returns unknown or loses its ready acknowledgement, another `configure` invocation
uses only `reconcileBenchmarkFixture` for the same scope. It never calls preparation
again, allocates a replacement scope or applies an event to make the setup pass.
An unresolved readback stops configuration and preserves the receipts. Once a
binding record exists, configuration re-entry validates it without remote work.
Already frozen batch plans never prepare fixtures again.

## Integration verification

`turn-integration.test.mjs` runs the production controller, subject wrapper,
source projection and bridge through owned child processes with a deterministic
no-model runtime. It verifies clarification ordering, complete native tree and
mode changes, old-tree retention, unknown-write stopping without replay,
unsupported native fault handling, malformed tree rejection and preservation of
actual terminal evidence after launcher acknowledgement loss.

`turn-sdk.integration.test.mjs` is opt-in. Supply a fresh shared build and a new
owned proof directory through `BENCHMARK_TURN_SDK_ENV`,
`BENCHMARK_TURN_SDK_BUILD` and `BENCHMARK_TURN_SDK_PROOF_ROOT`. It first captures
the exact candidate with zero HTTP sends, then uses the maintained Pi SDK and
production runtime against an owned loopback SSE server. It verifies one Pi
session across three turns, an inserted public clarification and actual nested
reads before and after native replacement. The retained proof labels the local
responses and fixture effect as apparatus inputs. They establish the mechanism,
not a real model route, live Notion mutation, or business Benchmark score.

The controller writes its decision before publishing a public receipt. Reopening
the same plan republishes the identical receipt, including a previously selected
clarification, without deciding again. A PID-bound owner file prevents concurrent
controllers. A dead owner's file is retained under a recovered name before a new
owner is acquired. An alive or unverifiable owner is not displaced.

## Files and evidence

Public files are under `run/benchmark/turn-bridge/`:

- `ready.json` binds the run, episode, bridge ID and original turn IDs.
- `requests/000001.json` contains a subject checkpoint and actual runtime pause ref.
- `receipts/000001.json` contains continue/stop and at most one public response.
- `subject.jsonl` records connection, requests, received receipts and close.

The private controller directory contains the frozen `plan.json`, controller owner
receipts and `controller.jsonl`. Both journals are append-only hash chains with
sequence, wall time and monotonic nanoseconds. `readTurnBridgeJournal()` verifies
the chain; a truncated line is rejected rather than silently repaired. Final
journal results bind the complete file hash. Row references identify a row hash
explicitly instead of pretending it is the final artifact hash.

Packets are written to retained staging files, synced and atomically published by
an exclusive hard link. Existing packets are never overwritten. Paths must be
owned absolute real paths; symlinked channel directories and evidence paths are
rejected. This is an audited same-user filesystem boundary, not an OS sandbox.
Staging and recovered-owner files are preserved for the experiment's usual cleanup.

File IPC was selected because the shared launcher already owns process creation
and exposes no dedicated Node IPC channel. Node `fork()` IPC would require a new
launcher path; a socket would add listener and reconnect ownership without removing
the need for durable decisions. The bridge leaves the shared launcher unchanged.

## Verification

```sh
node --test benchmark/turn-bridge.test.mjs
node --test benchmark/fixture-dispatch.test.mjs
```

The tests spawn real owned Node processes, exchange actual immutable packets, read
and mutate owned fixture files, terminate a controller at a controlled write boundary,
and resume through read-only reconciliation. They verify same-session checkpoints,
public clarification, one actual update, lost acknowledgement, explicit failure,
wrong-episode receipts, changed session, symlink rejection and cancellation.
They make no model or remote Notion calls.

Set `BENCHMARK_TURN_BRIDGE_PROOF_ROOT` to a fresh existing owned directory to retain
all apparatus runs and their `apparatus-proof.json` files at a known location.
The proof identifies the actual module hash and is apparatus evidence, not a paid
multi-turn Benchmark result.
