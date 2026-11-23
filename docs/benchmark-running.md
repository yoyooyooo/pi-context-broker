# Run a frozen Benchmark comparison

Benchmark uses the existing paired-environment controller for isolated builds and
run state. It adds public business cases, private grading, actual Pi SDK episodes,
and evidence analysis. Use the maintained runtime and an explicitly named frozen
build. The ordinary daily `next` verification gate remains separate.

The [2026-11-22 two-model pilot report](benchmark-two-model-pilot-2026-11-22.md)
records the actual GPT-6.2 Sol and Grok-4.6 results, the retained local-budget
classification repair, and the later Notion-startup stop. Its frozen plan is
stopped; it is evidence for review, not a ready-to-resume setup.

For newly authorized work after a closed scope, use
[finite prospective cohorts](benchmark-prospective-cohorts.md). They retain the
original campaign ledger, freeze all historical costs and failures, and require
fresh apparatus evidence for each concrete model set.

## Start from an existing setup

Read the task's setup JSON, its purpose and total budget before running anything.
Use absolute paths. The setup names two environments, selected model routes,
public material, private controller storage, adapter evidence, and episode and
batch limits. It never contains credentials. A prepared Notion binding names a
task-owned library and verified native-equivalent bytes.

```sh
node benchmark/cli.mjs configure --setup /absolute/task/setup.json
node benchmark/cli.mjs run --plan /absolute/task/batch/plan.json --limit 2
node benchmark/cli.mjs status --root /absolute/task/batch
```

`configure` writes the frozen protocol inside `plan.json`; the standalone
`validate` command is optional when a separate protocol file is available.
Configuration captures the real maintained Pi SDK startup and final provider
serialization without sending a model request. Cases with identical startup
inputs may share this expectation. Each actual episode independently verifies
its public input bytes, loaded resources and first serialized request before
transport. An expectation mismatch stops before submitting the business task.

Cases with multiple turns, fixture events or frozen clarification responses also
require a completed build containing the current common turn runtime. Configuration
checks this before preparing any remote fixture; capture and execution check it
again before reading model credentials or dispatching. If it reports
`BENCHMARK_TURN_RUNTIME_BUILD_MISMATCH`, create a fresh build from the intended
source and use a new setup identity. Keep the failed setup and old build as
evidence. Editing a frozen manifest or reusing an older startup capture cannot
make the runtime compatible.

The example limit of two is a slice of the frozen batch, not an extra batch.
Run the same plan again to continue its remaining slots. Completed slots are
never silently repeated. Model retries are disabled in the initial policy.
This continuation applies to an operator slice, not a retained core-evidence
stop. A core stop remains in force on later invocations until an eligible,
verified analysis revision resolves it or a new protocol declares the repair.

## Review the result

```sh
node benchmark/cli.mjs query --root /absolute/task/batch --outcome unknown
node benchmark/cli.mjs journey --root /absolute/task/batch --run retained-run-id
node benchmark/cli.mjs analyze --root /absolute/task/batch --out /absolute/environment/reports/first
node benchmark/cli.mjs reanalysis --root /absolute/task/batch --out /absolute/environment/reports/reanalysis-1
```

`analyze` verifies retained evidence and aggregates normalized observations.
`reanalysis` reads the original transport, tool and output artifacts, applies the
private oracle again, and saves a new analysis identity. Both make zero model
requests. A new product, prompt, runtime or model behavior needs a new frozen
comparison and real execution; rescoring old behavior does not test that change.

When an analysis defect hid usage that is present in the raw evidence, correct
the collector and reanalyze the existing run. Register that new bundle before
resuming a stopped batch. Registration checks unchanged task/runtime identities,
raw request artifacts, actual send count and private oracle identity; it cannot
replace the subject build, model, inputs, slots or budgets. The original plan,
ledger entries and normalized bundle remain intact.

```sh
node benchmark/cli.mjs register-reanalysis --plan /absolute/task/batch/plan.json --replacements /absolute/task/replacements.json --out /absolute/task/analysis-revision.json --reason 'Explain the collector correction'
node benchmark/cli.mjs run --plan /absolute/task/batch/plan.json --analysis-revision /absolute/task/analysis-revision.json --limit 0
node benchmark/cli.mjs status --root /absolute/task/batch
```

The replacement list contains `{ "run_id": "existing-run", "directory":
"/absolute/new/normalized" }` entries. Applying the revision with limit zero
makes no model calls. It records the source revision and adopts verified usage
for those same runs, each counted once. Later runs use the registered analysis
revision and continue the original remaining slots.

Every episode keeps its raw result, model attempts, usage, tool lineage,
independent output readback, grading result and deterministic journey. A known
business error remains a valid failure. Missing evidence remains unknown.
Unsupported capabilities are reported separately. Unknown usage stops batch
expansion because its actual cost cannot be reserved safely.

## Initial route gate and recovery

The initial pilot has a shared maximum of 144 scheduled episodes, including
invalid runs and replacements. Its first 24 are a separately frozen comparison
covering the three selected routes and both API families in native and Broker
conditions. Successful business answers are not required to pass the apparatus
gate; complete route, loading, transport and usage evidence is required.
The shared ledger path is part of the frozen execution plan. An alternate path
or symlink is rejected before dispatch; changing a CLI invocation cannot reset
the first-24 gate or the campaign's scheduled-episode count.

```sh
node benchmark/cli.mjs gate --root /absolute/task/first24 --out /absolute/task/route-gate.json
```

Later pilot setups bind the resulting gate path and hash. The controller verifies
all referenced episodes and their raw artifacts before reserving slot 25 onward.
Core failures stop expansion. Repairing apparatus creates a new identity and
retains the failed evidence; do not edit a frozen plan or fabricate a gate.

For an explicitly authorized two-model scope, use the
[prospective scope amendment](benchmark-pilot-scope.md). Its sixteen-episode
apparatus gate retains the original first24 as incomplete and keeps every old
reservation in the shared 144 cap. A verified zero-send apparatus repair and a
single explicitly registered same-variant route replacement have separate
evidence requirements. They create new plans; stopped plans and unknown usage
remain in the history. A route error never enables automatic fallback.

A rejected zero-send startup still occupies its pilot reservation. A narrowly
documented repair may preserve that invalid slot externally while a new frozen
continuation executes the original remaining order. Its cumulative gate verifies
reservations 001 through 024 across both plans, the named repair's raw evidence,
and current actual route coverage. The rejected slot never becomes a valid
business result. This exception is not available for unknown sends or unknown
usage, and does not establish a quality or reliability claim.

A running or interrupted lease blocks another controller. Inspect the retained
lease and process first. When that specific owner is dead, release only that
lease; the next run reconciles an already-started episode from terminal receipts
before considering another slot:

```sh
node benchmark/cli.mjs reconcile --root /absolute/task/batch --lease observed-dead-lease-id
```

An unresolved execution is not automatically rerun. Its send and cost status
must be established or retained as unknown. Never delete a run or its receipts.

## Setup fields and limits

### Reusing a complete private corpus

For material prepared before `configure`, supply a frozen full corpus snapshot:

```json
{
  "corpus": {
    "seed": "declared-material-seed",
    "split": "development",
    "material_version": "2",
    "snapshot": {
      "path": "/absolute/task/private-material/full-corpus.json",
      "sha256": "SHA256_OF_THE_EXACT_FILE_BYTES"
    },
    "selections": [{ "caseId": "implicit-01-a", "candidateCount": 16 }]
  }
}
```

The file contains exactly `{ "publicCorpus": ..., "control": ... }`, including
the original private canaries, oracles and seal. Its path must identify a regular
file outside repository, configuration and subject build/run roots. The reader
checks the byte hash, complete corpus identities, and the declared `seed`,
`split` and `material_version` before writing the setup. An explicitly selected
diagnostic `generator` must match its provenance and existing split/version
limits. Loading does not open a confirmation seal.

`corpus.snapshot` and `materialization_binding_file` are mutually exclusive.
The latter still selects an actual verified shared physical materialization;
it is not a corpus-only input. Without a snapshot, existing generation or shared
material loading remains available. Regenerating a corpus with the same seed
preserves public material but creates a new private canary, so it cannot replace
the full corpus used for earlier slot preparation.

Early preparation and recovery call `readCorpusSnapshot(setup)`, then the existing
`prepareCases` and `prepareEpisodeFixtures` APIs with that same returned object
and final slot schedule. They do not run `configure` or register a campaign.
Final `configure` uses the same snapshot and verifies already prepared slots
against the complete public and private corpus. It freezes the reference in
`execution.corpus_snapshot`; changed bytes or a different full slot corpus fail
before reuse. Missing slot records retain the existing read-only reconciliation
boundary. No uncertain write is replayed.

### Owned episode material

Cases with declared turn events require `episode_fixtures` in the setup. This
explicit policy names the authorized synthetic Notion parent and any pinned
sources. `configure` prepares one owned initial fixture for every scheduled
condition/repeat, verifies material parity, and captures each slot with zero model
sends before freezing the plan. Read-only cases may share their proven material.
The physical entry, prompt, inventory and exact startup expectation are frozen
per writable slot; dispatch and reanalysis cannot materialize a replacement or
fall back to another case's expectation. The canonical sample identities and
denominators remain unchanged.

This automatic path supports `placement: "notion"`, including pinned source
members; it rejects local/mixed placements before remote work. An ambiguous
initial preparation is retained and re-entry only performs read-only reconciliation
against the same owned scope. See [turn bridge and fixture ownership](benchmark-turn-bridge.md#writable-fixtures-for-every-scheduled-slot)
for the setup shape, evidence binding and recovery boundary.

`episode_fixtures.authoring: "native-main-exact-resources"` opts native Notion
owners into complete public import with only `SKILL.md` as Native Markdown.
Auxiliary Markdown remains an exact resource. The policy is frozen in each
fixture plan and recipe; it accepts only one present immutable version without
relation or metadata overrides. Pinned Source bindings retain their existing
path. See [fixture file authority](fixture-authoring.md) for command, preflight
and recovery constraints. Omitting this field retains the original authoring
policy and never changes an existing fixture's authority.

For a catalog that also contains relation-bearing objects, select individual
eligible owners by their canonical Skill IDs:

```json
{
  "episode_fixtures": {
    "version": 1,
    "project_page_id": "owned-synthetic-parent-uuid",
    "authoring_by_skill": {
      "references-01-a-grant": "native-main-exact-resources"
    }
  }
}
```

The global `authoring` field and `authoring_by_skill` map are mutually exclusive.
The map must be nonempty and name Skills in the selected owned catalogs. Unknown
IDs, unknown policies and ineligible selected objects fail validation. Selection
is explicit; the controller does not inspect extensions and silently choose a
policy. Unselected objects retain their complete original recipe, including
relations and metadata. Each slot freezes only its matching map entries.
For direct shared-material planning, `planBenchmarkFixture` and
`buildFixtureRecipe` accept the same map as `authoringBySkill`; the immutable
fixture plan records it as `authoring_by_skill`.

### Models and budgets

The controller accepts model configuration, not a fixed model enumeration.
`models.source_file`, `provider`, `ids`, and `api_key_env` select declared routes
from an existing registry. The generated registry references an environment
variable; the secret is passed only to the task process. No global model file or
daily tool installation is changed.

Each model needs `adapter_evidence_file` from the actual maintained SDK's
controlled transport test, an explicit observation window and effective
parameters. Unobservable alias backends remain opaque. No fallback or auxiliary
model is allowed. Unverified prices are reported as unknown currency cost while
token and network counts remain available.

`budget.episode` sets elapsed time, actual requests, input/output tokens, HTTP
attempts and retries. `budget.batch` sets their aggregate limits and concurrency.
The initial controller dispatches one subject at a time. Output request limits
and cumulative guards are enforced; prospective input estimation is a heuristic,
not a proof of exact provider tokenization. All actual usage is retained.

`decision` freezes the absolute quality policy and any noninferiority or
efficiency thresholds before model results. Small samples can yield an
inconclusive decision. Zero observed failures or all ties do not establish a
narrow noninferiority margin.

`allowed_changes` declares differences between environments. Code Mode `free`,
`off` and `required` are separate policy conditions. The runtime records the
actual declarations and calls; use policy interactions rather than grouping
episodes afterward according to whether a model happened to call Code Mode.

## Visibility and public distribution

The subject receives business inputs and declared Skill material. Full controller
source, private oracle and prior experiment results stay outside its run tree;
the runtime projection contains only the allowlisted observer modules. Exact
input inventories, trace evidence and private canaries check this boundary.
This is a same-user filesystem arrangement, not an operating-system sandbox.

Private raw bundles may contain machine paths and task-owned remote identities.
Distribute a separately sanitized package and its transformation manifest.
Retain the originals for internal traceability. Public synthetic materials and
offline statistics do not imply that every corpus case was executed remotely.

## Maintenance

Benchmark implementation belongs on `benchmark`. Fixes to shared product or
isolation behavior go through `next` first and are then synchronized. Preparation,
real execution, analysis and source integration have separate receipts. No paid
cron or automatic all-model matrix is installed.
