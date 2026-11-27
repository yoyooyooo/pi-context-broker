# Standing Benchmark continuation

`setup.standing` selects the current continuation path. It separates a reusable
user authorization from a finite scientific work plan. A completed work plan
does not exhaust the grant. Further task-related debugging, tests, repairs and
formal work plans can reference the same grant without another batch approval.

The old pilot, finite campaign and engineering-window readers preserve their
historical contracts. Their 24-hour windows and numeric allowances do not apply
to a standing work plan. Historical observations and costs remain attributable
to their original conditions; changing to unbounded execution creates a new
condition epoch.

## Records

Every file reference is `{ "path": "ABSOLUTE_CANONICAL_PATH", "sha256": "..." }`.
Grant, work-plan, setup, amendment and registration files are byte-bound.
Actual setup creation and registration use exclusive writes.

The grant has exactly these fields:

```json
{
  "version": 1,
  "kind": "user-standing-benchmark-authorization",
  "id": "benchmark-standing-authorization-ID",
  "approved": true,
  "source": "current-user-message",
  "user_message": "The actual user instruction",
  "recorded_at_utc": "2026-11-25T00:00:00Z",
  "task": "Notion Skills Benchmark",
  "authorization_expiry": null,
  "per_batch_approval_required": false,
  "resource_policy": { "mode": "unbounded" },
  "supervised_recovery_authorized": true
}
```

A `benchmark-standing-work-plan` has `version`, `id`, `task`,
`environment_root`, `authorization`, `resource_policy`, `condition_epoch`,
`controller`, `baseline`, `entries` and `created_at`.

| Field | Meaning |
| --- | --- |
| `authorization` | Reference to the reusable grant. |
| `resource_policy` | Exactly `{ "mode": "unbounded" }`. |
| `condition_epoch` | `{ id, started_at, authorization }`; the model condition start, with no end. |
| `controller` | `{ source_root, implementation }`; the complete reviewed source closure. |
| `baseline` | Reference to a verified historical receipt. |
| `entries` | `{ id, setup, planned_episodes }` for each scientific design. |

Each setup template omits `standing`. A concrete attempt copies the template,
changes only `id` and `control_root`, and adds:

```js
standing: {
  authorization: grantReference,
  work_plan: workPlanReference,
  work_item_id: entry.id,
  attempt_id: setup.id,
  ledger_root: absoluteStandingLedgerRoot
}
```

The setup comparison removes only these three identity fields. Changing model
parameters, cases, fixture policy, build IDs or any other scientific input
requires a new template and work plan. That uses the same standing grant.
`planned_episodes` must equal the frozen schedule. It describes the sample,
not how many observations the user permits across this task.

Use the immutable paired build's `source/broker` directory as
`work_plan.controller.source_root` when that build contains the reviewed
controller. Compute its implementation identity with that directory's producer
and verify that it equals the controller executing the plan. This keeps later
working-copy edits from changing the source locator of a retained plan; it does
not permit execution with a different implementation.

## Resource policy and condition identity

Standing budgets have `mode: "unbounded"`. Episode request, input-token,
output-token, HTTP-attempt, retry and duration limits are all `null`. Batch
episode, request, token and duration limits are also `null`. Concurrency remains
one as a scheduling choice. The old pilot cap, route-gate count and rerun quota
are `null` only for this explicit standing campaign kind.

Model windows are `{ mode: "standing", start: condition_epoch.started_at,
end: null }`. No far-future expiry or large numeric substitute is used.
Per-call model parameters such as `maxTokens: 4096` remain part of the
scientific condition. They do not set a cumulative token allowance.

Usage counters and raw provider evidence remain required. Unknown usage stays
unknown. An evidence failure stops that attempt so its cause can be diagnosed;
it does not revoke the standing grant. The transport does not blindly replay
an ambiguous provider send. New repaired attempts retain the failed attempt,
its reservations, its known usage and its unknown costs.

If a selected executable can update in place, prepare one task-owned copy before
capture and bind its exact command path and bytes. Preserve its provenance and
dependency evidence without repeatedly refreshing the global hash or copying
the whole home directory.

Completed evidence uses the normalized episode's `admission.status` and
`admission.completeness` for attempts, tools and interventions. The normalized
episode has no top-level `core_evidence` field. The same public
`assertCompletedStandingEvidence(plan, event)` check verifies retained raw
references, identity, usage and completeness for dispatch and recovery readers.

Analysis success thresholds are measurement criteria. They must be explicitly
declared for an unbounded condition, rather than inferred from a null execution
duration. They never stop execution.

## Historical baseline and continued accounting

Create a baseline once with the historical controller that originally verified
the historical authority:

```sh
node benchmark/cli.mjs prepare-standing-history --request ABS_REQUEST --out ABS_NEW_BASELINE
```

The request contains `{ id, historicalAuthorization, controller,
publishedEvidence }`. The producer verifies the historical controller closure,
imports its original reader, verifies the original history and retains its
accounting and registration references. Future live checks bind the baseline
receipt and its direct provenance references. They do not recursively replay
the full historical campaign at each reservation.

The first standing ledger is a new directory. `ledger-baseline.json` binds its grant
and baseline. Reservations use global ordinals after the historical prefix:
for a 104-observation baseline, the next filename is `105.json`. Registration
filenames use local sequence numbers such as `scope-registration-001.json`;
each row separately records `global_sequence` after the historical registrations.
Both sequences accept three or more digits and sort numerically.

`inspectStandingLedger({ ledgerRoot, baseline })` reports the history counts,
local and global counts, exact reservation and registration references, and
any active lease. It does not infer a remaining allowance.

When work moves to a new task-owned CLI/Broker pair, keep the original grant,
historical baseline and existing standing ledger. The new work plan names the
new environment and controller closure; its setup and run state live under that
environment's `control` directory. The ledger stays under the historical
baseline environment. Cross-environment continuation requires an existing ledger
with at least one registration and the same grant. It cannot start another empty
ledger from the historical prefix, copy a ledger into the new environment, or
discard intervening observations. Existing lease, reservation and recovery
checks still apply. Source/build copies may be retired only when no retained
plan or evidence still references their bytes. Keep the full artifact closure
as well as the accounting needed by later work.

A standing work plan can also name an explicit `baseline_diagnostic` setup with
one environment/model and supported assessment slots. It uses this same grant,
ledger, lease, reservation and evidence path. See [single-baseline diagnosis](benchmark-running.md#diagnose-one-current-baseline)
for its descriptive-only constraints. An empty comparison list cannot support
adoption, and a one-episode scientific design does not add an execution quota.

## Execution and recovery

```sh
node benchmark/cli.mjs configure --setup ABS_STANDING_SETUP
node benchmark/cli.mjs run-standing --plan ABS_FROZEN_PLAN --out ABS_NEW_RUNNER --slice 8
```

`--slice` controls checkpoint and analysis frequency. After a positive, verified
prefix the runner continues until the design is complete. A silent invocation,
zero progress, unresolved execution, changed evidence or unknown usage retains
a checkpoint and stops the attempt. A stopped runner exits nonzero. A complete
plan can be inspected again without duplicate provider calls.

One campaign lease serializes registration and reservation. Registration is
idempotent for the same frozen attempt; an active owner cannot be reconciled.
An interrupted lease is retained when its dead owner is reconciled. An orphan
reservation cannot silently become a new model request. Recovery first resolves
the actual execution evidence, then continues with an existing safe prefix or a
new immutable attempt under the same grant.

When the controller itself failed between completed subject runs, a repaired
controller can close that old invocation explicitly:

```sh
node benchmark/cli.mjs reconcile --root ABS_OLD_BATCH --lease OBSERVED_DEAD_LEASE_ID --retire-reason 'Recorded controller defect and repair identity'
```

This action acquires the same exclusive campaign lease as dispatch before
re-reading evidence or writing a footer. It requires the named dead batch owner, exact
registration and reservation bindings, and complete ordered pairs of started
and completed runs. Every completed evidence bundle is verified. An unresolved
send or orphan reservation must be resolved first. The command makes zero
model requests and does not execute the old plan with a different controller.
It retains the old lease, writes an immutable retirement intent, and appends
one `batch_closed` footer with reason `interrupted_controller_failure`.
Its recorded implementation identifies the controller that performed closure.
Concurrent reconciliation cannot admit another runner while this lease is held.
Repeating the same retirement preserves the original prefix and footer;
partial footer writes can complete from that exact intent.
If retirement itself is interrupted, first inspect and release its separately
named dead campaign lease with `reconcile --root ABS_OLD_BATCH --lease
OBSERVED_DEAD_CAMPAIGN_LEASE_ID --scope-only true`. This preserves that scope
lease and leaves the batch lease and ledger untouched. Then repeat the original
retirement command. Scope-only recovery and retirement cannot be combined.
An already reconciled matching batch lease is also retained when retiring its
still-open invocation.

Retirement does not complete missing scientific slots. Keep the old partial
analysis, all outcomes and usage. A source repair requires a new controller
identity and work plan; a fresh full design remains separate from the old
partial design. The lease form of `reconcile` without `--retire-reason`
still only releases a dead lease and does not close an invocation.

The runner receipt is `standing-campaign-runner-receipt`. It binds the plan,
grant, work plan, item and attempt, and records the actual ledger and checkpoints.
The receipt does not label a failed invocation as zero sends merely because
the runner threw an exception.

### Close a proven profile failure before launch

A closed standing batch can retain one unresolved first slot after a declared
MCP executable's identity check fails with `RESOURCE_PROFILE_FILE_CHANGED`.
When the reviewed producer and original records prove that validation stopped
before subject launch, record a supervised terminal disposition:

```sh
node benchmark/cli.mjs reconcile --root OLD_CONFIGURATION --prelaunch-request ABS_REQUEST
```

Both paths must be absolute. `--prelaunch-request` cannot be combined with
`--lease`, `--retire-reason` or `--scope-only`.

`verifyProfilePrelaunchDispositionRequest({ controlRoot, request })` checks the
request without acquiring a lease or writing files. It verifies the exact
reviewed producer closure and byte-bound plan, profile, registration,
reservation, ledger and runner records. It requires a dead runner owner and
the absence of the batch lease, run directory, launch artifact and turn-control
directory. The read-only preflight also requires the campaign lease file to be
absent. Error text alone cannot prove this boundary.

`disposeProfilePrelaunchFailure` acquires the existing campaign lease, repeats
the checks and publishes the fixed `prelaunch-disposition.json` sidecar without
replacing an existing record. It preserves the old ledger and reservation,
does not append `episode_completed`, and keeps unobserved runtime usage as
`null`. Successor registration binds the sidecar. Every later standing ledger
read verifies the retained writer's complete closure before using that writer's
fixed verifier to recheck the original evidence, producer and absence conditions.
A later controller version does not replace the historical verifier. Retain
both frozen source closures. First publication and an unfinished pending
publication require the original owner to be dead. A verified published terminal
record keeps that exit fact; a later process reusing the numeric PID cannot
reopen it. New run, launch or batch-lease evidence still blocks historical replay.
The disposed old scope rejects activation and reservation, including before a
successor has registered.

Publication writes a request-bound pending file and atomically links its
complete bytes to the final sidecar. Repeating the same request converges to
the same record; a partial pending file can resume only from its exact expected
prefix. The campaign lease still uses the existing exclusive writer. After an
interruption with a complete dead campaign lease, first use:

```sh
node benchmark/cli.mjs reconcile --root OLD_CONFIGURATION --lease OBSERVED_DEAD_CAMPAIGN_LEASE_ID --scope-only true
```

Then repeat the original request with the same frozen writer. A live owner,
conflicting pending bytes, or a partial or empty campaign lease remains blocking.
Do not delete a lease, reset the ledger, or treat a pending file as a terminal
record. The scope-only command preserves the complete dead lease; it does not
repair malformed lease contents.

Continue with a new attempt, work plan, condition epoch, repaired resource
profile and fresh capture under the same grant and standing ledger. Keep the
failed attempt and its capture evidence. Other unresolved executions,
ambiguous sends or incomplete proof remain blocking.

### Close a retained zero-send collection failure

`configure` copies the verified adapter proof into the owned control directory
before freezing the execution input. The receipt retains both original and
owned references, and their bytes must match. This allows the collector to
reuse an existing proof without referencing evidence outside the current
environment.

For an older standing attempt that failed during collection, recovery is
limited to a retained invalid run with complete independent transport evidence
of zero model sends and known zero model usage. Register the original frozen
controller and the exact path projection, then close the existing run:

```sh
node benchmark/cli.mjs register-collection-recovery --plan ABS_OLD_PLAN --frozen-controller ABS_ORIGINAL_FROZEN_CLI --reason 'Recorded collection defect and exact evidence projection'
node benchmark/cli.mjs run --plan ABS_OLD_PLAN --collection-recovery ABS_REGISTRATION --limit 0
```

This standing recovery cannot reserve or execute another episode. It preserves
the original plan, work plan, raw evidence, partial collection, reservation and
ledger prefix. The repaired collector writes separate results and retains the
invalid outcome and actual duration. A changed implementation or an ambiguous
send cannot turn that run into a successful scientific observation.
Later standing reservations may append after the registered accounting
boundary; the original reservation prefix and baseline remain byte-bound.

If an unapplied registration itself needs a reviewed repair, create another
immutable registration with `--out ABS_NEW_REGISTRATION --supersedes
ABS_UNAPPLIED_REGISTRATION`. Keep the previous registration and failed closure
receipt. The separate historical paid-pilot recovery contract remains unchanged.
