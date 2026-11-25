# One preflight repair inside the existing engineering window

Version 8 admits one specific recovery from the first version 7 configure
failure. The first CodeMode scope never registered an allocation or started a
paid episode. Its broker captures stopped at the missing `NOTION_API_TOKEN`
assertion before child creation. Its native capture retained a completed
zero-attempt transport. The old claim, failed configure, invalid capture labels,
native result, and occupied capture directories remain at their original paths.

This repair needs a new explicit user decision. The original version 7 decision
does not authorize another attempt. The repair inherits the exact existing
window start and end. It does not begin a new 24-hour period or extend the end.

## Fixed scope

The parent must be version 7 with revision
`accepted-engineering-window-continuation`, history104 and the accepted
35 remaining reservations. A version 8 parent cannot create another repair.
The only identity change is:

| Identity | Retained, unactivated owner | New owner |
| --- | --- | --- |
| Allocation | `engineering-codemode-window-17-1` | `engineering-codemode-window-17-2` |
| Experiment | `benchmark-codemode-window-17-1` | `benchmark-codemode-window-17-2` |

The new owner selects the same 17 original unstarted slots in their original
order. Its scientific design remains 24 slots. All seven prior CodeMode costs
remain consumed. The five scale pairs and eight fault observations retain their
IDs, ordering and budgets. The total remains139, the hard cap144, and five slots
remain unallocated. Model routing, parameters, subject builds, collector,
material, analysis and cross-window restrictions retain the v7 contract.

Changing only `control_root` cannot repair the collision. Capture IDs derive
from the experiment ID, and the launcher owns `runs/<id>` with an exclusive
directory. Version 8 provides the new approved owner; it does not weaken either
directory exclusion or the old scientific identity checks.

## Draft and independent evidence

`draft-engineering-preflight-repair --request ABS_REQUEST --out ABS_NEW_DRAFT`
accepts exactly these request fields:

| Field | Meaning |
| --- | --- |
| `id` | New authority ID |
| `parent_authorization` | Byte-bound v7 authority |
| `controller_source` | New reviewed controller composition |
| `zero_send_proof` | Independent stopped-invocation review |
| `zero_send_review_record` | Successful recorded invocation of that review |

References use `{ "path": "/absolute/path", "sha256": "..." }`. The draft is
`engineering-preflight-repair-proposal-not-executable`, with `approved: false`
and `execution_authority: null`. It derives the stopped claim, receipt, binding,
original window, original resources and exact replacement owner. It performs no
configure, capture, remote preparation or model work.

The proof must have kind `independent-stopped-engineering-invocation-review`.
Its recorded reviewer must be separate from the failed coordinator's directory.
The reader verifies the review receipt and all referenced bytes, then rechecks
the actual claim, binding, stopped receipt, one configure command, journal,
three retained captures, and lack of a plan or ledger in that failed scope.
It verifies the pinned launcher's environment assertion before child creation
and the empty broker run directories. It also rechecks the native child result,
runtime terminal, captured admission, budget, blocked-send event, complete
transport reconciliation, zero transport attempts and settled cleanup.

The broker captures remain `invalid` with their original generic request/cost
label `unknown`. Separate pre-spawn evidence establishes zero sends for this
repair admission. It does not rewrite those captures or relax the ordinary
unknown-usage stop rule. A zero reservation delta or a report containing only
`model_requests: 0` is insufficient.

## Explicit decision and authority

`prepare-engineering-preflight-repair --draft ABS_DRAFT --decision ABS_DECISION
--out ABS_NEW_AUTHORITY` requires a separately recorded current user decision
of kind `user-approved-engineering-preflight-repair`. It binds the exact draft,
parent, controller, both independent proof references, retained claim and
receipt, new owner, 104/13 boundary and 35/139/144 limits. Its
`model_window` contains the unchanged `start`, unchanged `end`, and
`automatic_renewal: false`. Its future stop policy remains:

```json
{ "core": "stop", "usage_unknown": "stop", "retry": false, "renew_window": false }
```

The approval timestamp must follow the stopped receipt and independent review,
be no later than the current time, and be inside the inherited window. The
reader does not apply the v7 new-window rule that the window starts after this
new decision. Reusing a v7 decision, backdating, a future approval timestamp,
changing either endpoint, or resetting the window to 24 hours after recovery
fails.

Draft and authority preparation check the current104/13 boundary without active
leases both before and after evidence verification. The new experiment's run
namespace must be unused. Historical authority reads verify the immutable
104 prefix and failed attempt without requiring the campaign still to be104/13
after legitimate new work. This prevents the repair from rejecting its own
reservation105 and registration14.

The authority has version8 and revision `accepted-engineering-preflight-repair`.
The registered predecessor still belongs to v6. The v7 configure never created a
registration. Dispatch therefore verifies this exact authority link:
registered v6 predecessor13, verified unactivated v7 parent, then v8. It checks
the v7 parent reference and the common predecessor13; it does not permit an
arbitrary skipped ancestor. Exact allocation sizes, ordering and predecessor
authority checks apply to every later v8 allocation.

## Execution and integration

`configure` retains its name and verifies v8 before creating its output or
captures. Use a new control root. The separately named
`run-engineering-preflight-repair --plan ABS_V8_PLAN --out ABS_NEW_RUNNER --limit 8`
accepts only v8. `run-engineering-window` continues to accept only v7. Each runner
output is exclusive. The repair runner uses kinds
`engineering-preflight-repair-runner-claim`,
`engineering-preflight-repair-prefix-checkpoint` and
`engineering-preflight-repair-runner-receipt`. Existing actual-prefix, model
window, known-resource, core-stop and checkpoint rules remain in force.

`readApprovedCampaign(v8)` returns the original `engineeringContinuation`
science/history context with the new CodeMode owner and controller. It also
returns `engineeringPreflightRepair`, containing the verified v7 `parent`, its
`parentReference`, `draft`, `decision`, `zeroSendProof`, `zeroSendReviewRecord`,
`retainedAttempt`, `supersededOwner` and `replacementOwner`. The continuation's
own `parent` remains the historical v6 context. Publication consumers must bind
the explicit v8 repair lineage instead of treating it as another new window.

The new controller retains the pinned source3 base and collector. Its reviewed
overlay allowlist adds only `campaign-engineering-preflight-repair.mjs` to the
existing engineering files. The complete execution dependency closure includes
that module. Old source4 and all old controller manifests remain immutable.

Offline tests cover the specific decision, owner, lineage, setup, zero-send and
runner boundaries. Their synthetic records do not count as model observations,
actual approval or an executed repair.
