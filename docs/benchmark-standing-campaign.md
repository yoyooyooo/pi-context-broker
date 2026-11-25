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

Analysis success thresholds are measurement criteria. They must be explicitly
declared for an unbounded condition, rather than inferred from a null execution
duration. They never stop execution.

## Historical baseline and the new ledger

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

The standing ledger is a new directory. `ledger-baseline.json` binds its grant
and baseline. Reservations use global ordinals after the historical prefix:
for a 104-observation baseline, the next filename is `105.json`. Registration
filenames use local sequence numbers such as `scope-registration-001.json`;
each row separately records `global_sequence` after the historical registrations.
Both sequences accept three or more digits and sort numerically.

`inspectStandingLedger({ ledgerRoot, baseline })` reports the history counts,
local and global counts, exact reservation and registration references, and
any active lease. It does not infer a remaining allowance.

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

This action requires the named dead batch owner, no campaign lease, exact
registration and reservation bindings, and complete ordered pairs of started
and completed runs. Every completed evidence bundle is verified. An unresolved
send or orphan reservation must be resolved first. The command makes zero
model requests and does not execute the old plan with a different controller.
It retains the old lease, writes an immutable retirement intent, and appends
one `batch_closed` footer with reason `interrupted_controller_failure`.
Its recorded implementation identifies the controller that performed closure.
Repeating the same retirement preserves the original prefix and footer;
partial footer writes can complete from that exact intent.

Retirement does not complete missing scientific slots. Keep the old partial
analysis, all outcomes and usage. A source repair requires a new controller
identity and work plan; a fresh full design remains separate from the old
partial design. The existing `reconcile` command without `--retire-reason`
still only releases a dead lease and does not close an invocation.

The runner receipt is `standing-campaign-runner-receipt`. It binds the plan,
grant, work plan, item and attempt, and records the actual ledger and checkpoints.
The receipt does not label a failed invocation as zero sends merely because
the runner threw an exception.
