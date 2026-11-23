# Finite campaign contract

An explicit `campaign_scope` binds one complete Benchmark plan to the existing
144-reservation campaign. It supports a route gate for one model, bounded
acceptance comparisons, and an explicitly approved descriptive follow-up of
previously unstarted slots. The scope never
creates a second budget ledger or removes a retained observation.

The existing [prospective cohort contract](benchmark-prospective-cohorts.md)
remains unchanged. Its `pilot_scope` requires both the four-case gate and the
eight-case expansion. A finite campaign uses a different discriminant,
`kind: "benchmark-finite-campaign"`, and cannot shorten an existing cohort.
Both contracts share the original reservation ledger and campaign lease.

## Setup fields and frozen identity

The normal setup contains the explicit environment root, control root, model
routes, material, candidate builds, and resource limits described in
[Run a frozen Benchmark comparison](benchmark-running.md).
Its `campaign_scope` has the following fields:

| Field | Contract |
| --- | --- |
| `kind` | `benchmark-finite-campaign`. |
| `id` | A new scope identity. |
| `role` | `route_gate_only`, `acceptance`, or `unstarted_followup`. |
| `authorization` | The actual authorization for this finite work. |
| `predecessor.registration` | Absolute path and SHA-256 of the current registration file. |
| `predecessor.amendment` | Absolute path and SHA-256 of that registration's amendment file. |
| `history_plan_files` | Every owning plan for the closed historical reservations. |
| `prospective_authorization` | Optional absolute path and SHA-256 of an immutable approved campaign document. Required for an explicitly approved transition after retained stopped history. |
| `allocation_id` | The unique predeclared allocation for an approved campaign; must equal this scope's `id`. |
| `selection` | For `unstarted_followup` only: the source plan's semantic `source_plan_sha256` and its exact ordered unstarted `slot_ids`. |

Reference hashes identify the retained file bytes. They are distinct from the
semantic `amendment_sha256` inside an amendment. The scope derives its reservation
limit from the entire frozen schedule. A caller cannot replace this count with
an operator slice or an allowance that exceeds the remaining campaign budget.

The following fragment shows the input shape. Its paths and hashes are
placeholders, not a registered or executable setup:

```json
{
	"phase": "pilot",
	"pilot_ledger_root": "/absolute/existing-campaign/pilot-ledger",
	"campaign_scope": {
		"kind": "benchmark-finite-campaign",
		"id": "authorized-finite-scope",
		"role": "route_gate_only",
		"authorization": "The actual authorized scope and model selection.",
		"predecessor": {
			"registration": {
				"path": "/absolute/existing-campaign/pilot-ledger/scope-registration-NNN.json",
				"sha256": "ACTUAL_REGISTRATION_FILE_SHA256"
			},
			"amendment": {
				"path": "/absolute/predecessor-control/AMENDMENT_FILENAME.json",
				"sha256": "ACTUAL_AMENDMENT_FILE_SHA256"
			}
		},
		"history_plan_files": ["/absolute/every-owning-history-plan/plan.json"]
	}
}
```

`configure` freezes the protocol, every execution field except the scope's own
reference, and the complete ordered slot list. The amendment records those
fingerprints alongside the model, environment, instrumentation, and observer
identities. The final plan binds the amendment reference. Changed source
selection, material, runtime, budget, or slots requires a new authorized plan.
`pilot_scope`, `campaign_scope`, and legacy zero-send `resumption` cannot be mixed.

## Roles and comparison pairs

| Role | Required shape | Evidence scope |
| --- | --- | --- |
| `route_gate_only` | Phase `pilot`, purpose `native_calibration`, one model, Broker and native Pi, four common cases, one observation per case and condition: eight episodes. | Actual route, loading, observation, and accounting coverage. No expansion or business-quality acceptance is implied. |
| `acceptance` | Phase `pilot` or `confirmation`, a complete schedule, and the existing protocol's purpose and comparison rules. | The declared acceptance comparison. Claims depend on its actual baseline, material, observations, and decision policy. |
| `unstarted_followup` | Phase `pilot`, decision `descriptive`, the complete original scientific design, and only the exact unstarted suffix of the approved stopped source plan. | New observations in their own experiment. Original missing cells remain in the scientific denominator; old successes cannot fill them. |

The generic configuration entry supports two candidates, or four candidates
with two explicit comparison pairs. For four candidates, `environment_pairs`
is mandatory. For example, `[[0, 1], [2, 3]]` pairs candidate indices 0 and 1,
and indices 2 and 3. Every candidate belongs to exactly one pair. Execution
randomization preserves the declared candidate and reference orientation.
The default two-candidate pair remains `[[0, 1]]`.

Broker versus native Pi is a calibration comparison. Two own-product versions
require two actual product baselines with their declared build and tool bytes.
Renamed conditions or two copies of one product do not establish that comparison.
The engine's frozen identity checks do not certify that a baseline was previously
accepted, that a package is usable, or that the product change improves quality.
Those claims require the corresponding product and acceptance evidence.

## One budget, one registration chain

The physical `pilot_ledger_root` remains the original campaign ledger. Its
consecutive `001.json` through `144.json` reservations count every scheduled
observation, including failures and invalid or unknown results. A new finite
scope preserves every historical reservation and its owning plan and ledger.
Historical observations receive no new scope's quality credit.

The inherited checkpoint contains the original thirteen observations and their
three unknown-usage run IDs. The exact checkpoint and unknown set are preserved.
A scope cannot enlarge that exemption or turn an unknown historical total into a
measured total. The separately approved boundary described below preserves its
own exact stopped prefix without editing this original checkpoint.

A predecessor must be fully complete unless the explicit approved transition
below identifies that stopped predecessor and its exact retained history.
A closed operator slice by itself is insufficient.
A prospective predecessor requires both its gate and expansion; a finite
predecessor requires every slot in its one plan. The new history must equal the
old prefix plus exactly that predecessor's allowance. Its reservation ordinals,
plan ownership, scope identity, role, and completed evidence must agree.

Each scope uses one exact batch allowance, concurrency one, and zero model
retries or replacement episodes. The historical reservation count plus the
whole new scope must remain at most 144. Every actual new episode reserves its
ordinal before dispatch. An unresolved execution cannot earn another slot.

The first run activates an append-only registration successor after acquiring
`campaign.lease.json`. Legacy and finite controllers use this same physical
lease. Every later reservation rechecks the current registration and immutable
history. A different scope cannot dispatch through an old registration.

## An explicitly approved prospective transition

An original stop remains a stop. Continuing a separately approved program uses
an immutable `benchmark-approved-prospective-campaign` document and version 2
finite amendments. Version 1 amendments retain their existing rules.

The approved document binds the bytes of the user's decision record and the
published proposal, the original predecessor registration and amendment, the
environment and shared ledger roots, and the complete retained history. The
proposal remains an unexecuted historical proposal with `approved: false`;
the separate affirmative user decision supplies authorization. Changing either
file invalidates the approved document. The retained stop's normalized episode
and original result reference are also checked against the proposal.

`prepareApprovedCampaign` in `benchmark/approved-campaign.mjs` returns this data
for an exclusive immutable write. Its inputs are `id`, `userApproval`,
`predecessor`, `environmentRoot`, `pilotLedgerRoot`, `history`, and `allocations`.
`userApproval` is a file reference with `path` and `sha256`. Each allocation has
`id`, `work_index`, `role`, and `reservation_limit`. The ordered proposal work
items define the allowed roles and totals; they do not fix execution order.

For the approved continuation, 50 existing reservations and four retained usage
unknowns form the exact boundary. The frozen allocation maxima sum to the
approved 89, so the complete program stays within 139 reservations and the
unchanged absolute cap of 144. Five reservations remain unallocated. Scale
work is predeclared as five distinct two-slot allocations with matching material
catalogs; the other six work items each retain one allocation. Every allocation
and its maximum are frozen together before any new scope starts. A scope cannot
reuse an allocation, borrow from another work item, or append an allocation
after seeing results.

Every finite reader verifies the original plans, ledgers, reservations, and raw
evidence against that exact approved prefix. The first version 2 scope may
succeed the specifically named stopped predecessor once all of its started
observations have retained completed records. It does not complete or reopen
the original scope. Later scopes require their predecessor's entire new
schedule to be complete and must bind the same approval document. A new unknown,
core-invalid observation, or core stop after the approved boundary blocks
further dispatch. Analysis revisions do not expand the boundary.

For `unstarted_followup`, the approved source plan must belong to the stopped
predecessor. The controller derives the unstarted suffix from the retained
observations and compares every selected slot, order, case, pair, and statistic.
The original 32-slot scientific design remains intact while the new execution
schedule contains only its 11 never-started cells. Its own report therefore
retains 21 unresolved cells even after all 11 new observations complete. The
failed twenty-first source observation is excluded from this schedule and stays
retained in the original experiment.

Follow-up conditions preserve the source model variants, parameters, subject
builds, modes, cases, and business material. A newly declared route, API, or
window belongs to the new protocol and is recorded explicitly; matching a
model variant does not establish equivalence to the old route condition.

## A retained route-alias failure and its unstarted suffix

A version 2 approved campaign document can record one narrowly defined
engineering revision under its original user decision. This is distinct from
a same-raw analysis revision: the original result stays invalid, the stopped
plan stays stopped, and no old observation gains quality credit.

The source must be the first eight-slot route allocation immediately after
the original approved boundary. Exactly its first slot must have completed
with one verified model request, fully known usage, and an original
`BENCHMARK_REPORTED_MODEL_MISMATCH`. Its sole admission failure must be the
previously undeclared canonical auto-group response label. The verifier reads
the frozen plan, registration, reservation, closed ledger, normalized episode,
raw runtime result, provider observations, and pinned local group metadata.
A different failure, a new usage unknown, multiple started slots, a rewritten
result, or a source whose label was already declared cannot use this revision.

`readAliasRevisionHistory` in `benchmark/finite-campaign.mjs` reads the original
approved history plus that exact retained failure. Its inputs are
`parentAuthorization`, `predecessor`, `sourcePlan`, `metadata`, `planFiles`,
and `pilotLedgerRoot`. `prepareApprovedCampaignRevision` in
`benchmark/approved-campaign.mjs` returns a new immutable document from that
history, the same parent and source references, a new `id`, and a fresh
`followupAllocationId`. Both functions are data-only; the caller owns any
exclusive document write.

The revision references the original authorization and original user decision.
It does not create another decision or edit either existing document. It
retains the exact earlier reservations and four unknowns, adds the one known
request to the cost ledger, and subtracts that consumed reservation from the
approved maximum. Thus the boundary becomes 51, the remaining allocation total
becomes 88, and the approved total remains 139 within the unchanged hard cap
of 144. The five unallocated reservations remain unavailable.

Only the stopped route allocation is replaced. Its fresh seven-slot allocation
uses `unstarted_followup`; all other allocation IDs, roles, work indices, and
limits remain identical. The first scope using the revised authorization must
be this follow-up, with the exact stopped scope as predecessor. Later scopes
use the same revised authorization. The original allocation cannot be reused,
and this revision cannot be chained into a general stopped-scope exemption.

The new route follow-up preserves the complete original eight-slot scientific
design and schedules exactly source slots 1 through 7 in their original order.
The only model-condition change is adding the observed, exact canonical group
label to the explicitly frozen allowlist. Model route, variant, parameters,
adapter, API, backend window, material, pairs, and statistical denominator remain
unchanged. The old first slot is never scheduled again. Even if all seven new
observations complete, their descriptive report retains one unresolved cell
out of eight and does not produce a completed eight-observation route gate.

A source build may change only through an explicitly pinned
`apparatus_bridges` reference in this revision. This optional list contains at
most one bridge. Its public verifier freshly checks both complete paired
builds, requires identical CLI and Broker package inventories including build
receipts and dependencies, and permits only the exact declared
`broker/benchmark/reported-model.mjs` source change. The source and target
build identities must deep-equal the actual protocol identities. An absent
bridge retains the original same-build requirement. A shared commit name,
renamed build, or package summary cannot substitute for those byte checks.

The earlier eleven-slot follow-up still binds its original stopped expansion
through the parent authorization. Its full 32-slot denominator remains intact.
All original history checks and every subsequent core-stop or unknown-usage
guard continue to apply beyond the revised boundary.

## An accepted extension of completed history

A version 3 approved campaign document records a new, explicit user decision
to retain one additional terminal unknown-usage stop as history. The decision
uses `user-approved-campaign-history-extension-decision` and pins the exact
parent authority, accepted proposal, reviewable draft and retained stop. The
old draft keeps `approved: false` and its original bytes. The new decision
records the acceptance, remaining allocations, counts and unchanged budgets.
Provider diagnostic permission does not alter execution limits or future stop
policies.

This extension accepts only complete allocations after a valid version 2 or
version 3 parent. It derives their identities from consecutive registrations,
checks the original plans and amendments, and requires every registered slot
to have one reservation and one original completed result. Each source scope
must be closed and free of leases. Partial scopes, reused allocations, skipped
registrations and analysis or collection revisions in the new suffix are
rejected. The sole accepted invalid/unknown stop must be the final slot of the
final scope and the final reservation at the approved boundary. All other new
results retain the ordinary core, model and known-usage requirements.

`readAcceptedHistoryExtension` in `benchmark/finite-campaign.mjs` takes
`parentAuthorization`, `userApproval`, `predecessor`, `planFiles` and
`pilotLedgerRoot`. It independently reads the original history, registration
chain, evidence bundles and runtime result. Then
`prepareApprovedCampaignHistoryExtension` in `benchmark/approved-campaign.mjs`
takes `id`, `parentAuthorization`, `userApproval`, `predecessor` and that
`history`. Both return data and require the current ledger to match the accepted
boundary without an active campaign lease. They neither write an authority nor
register or dispatch a scope. Reading an already pinned authority later verifies
its exact historical boundary while allowing subsequent reservations to exist.

The revision is `accepted-history-extension`. It binds the new `user_approval`,
`parent_authorization`, evidence-derived `consumed_allocations`, exact
`retained_stop` file references and `next_allocation_id`. The top-level original
approval and proposal still define the original work and its work indices.
Remaining allocations equal the parent array with only the fully consumed
entries removed; their order, roles, indices and limits do not change. The
first new scope must use the declared next allocation and exact predecessor.

For the accepted continuation, the complete seven-slot Grok follow-up and
eight-slot Terra gate advance history from 51 to 66 and leave 73 existing
never-started slots. The total stays 139 under the hard cap of 144; the spare
five remain unallocated. Five effective token-unknown episodes and six original
token-unknown completions remain distinct, and incomplete totals remain null.
The old alias proof, original eleven-slot follow-up design and existing
apparatus bridge remain inherited. Terra's original gate still fails its
original-result check. Any new core stop or unknown usage after the accepted
boundary still blocks the next dispatch until a separate applicable decision.

## Original failures and analysis revisions

New original completed observations must have known, complete usage and no
`stop_batch`. Core-invalid evidence also blocks the finite scope. A later analysis
revision cannot make such an observation dispatchable, carry it into a new scope
as valid history, or satisfy a finite route gate.

When a revision exists, the verifier also reads the original normalized evidence
and checks its admission, core completeness, actual send, routing, and usage.
A grade-only correction remains possible when the original core and accounting
were valid. Business outcomes `fail` and `unknown` remain observations; they do
not themselves stop a scope or remove a case from its denominator.

Generic analysis and raw reanalysis remain diagnostic entry points. Their
reports do not release a finite scope's original stop or substitute for the
scope and gate checks. [Collection recovery](benchmark-collection-recovery.md)
retains its separate storage-only contract. A legitimate same-raw completion
of a previously unresolved collection does not erase an earlier completed result.

## Command forms and retained evidence

The generic Benchmark commands accept the new scope. There is no separate finite
run command or budget override. These forms run from the selected frozen
controller directory, with the actual absolute setup and control paths:

```sh
node benchmark/cli.mjs configure --setup /absolute/task/setup.json
node benchmark/cli.mjs run --plan /absolute/task/batch/plan.json --limit 1
node benchmark/cli.mjs status --root /absolute/task/batch
node benchmark/cli.mjs analyze --root /absolute/task/batch --out /absolute/task/report-new
```

`configure` performs real startup and serialization captures with zero provider
sends. It writes owned material, captures, a `finite-campaign-amendment.json`,
a frozen `plan.json`, and `configuration-proof.json`. Zero-send configuration
is not read-only and does not prove a paid episode's outcome. Cases with identical
startup inputs may share a capture; writable fixtures retain their slot ownership.

`run --limit 1` bounds newly dispatched episodes in that invocation. It does not
change the frozen slot count or create another sample. The run retains failures
and unresolved results. Status reports those observations without sending a model
request. `reconcile` remains an explicit dead-lease operation and does not resend
a subject.

For a completed `route_gate_only` plan, the existing gate command writes a
`benchmark-finite-route-gate` record:

```sh
node benchmark/cli.mjs gate --root /absolute/task/route-gate-batch --out /absolute/task/route-gate-new.json
```

The verifier rechecks eight actual observations, all four cases in both
conditions, their reservations, raw evidence, complete usage, and original
completed results. A gate for an old finite scope remains readable after later
scopes add reservations. An acceptance plan cannot use this route-gate format.

## Independent confirmation evidence

For phase `confirmation`, the scope rejects material identities already present
in its retained campaign history. The check includes canonical variants and
public cases, content, the business-input tuple, and attachment identities.
Changing a material ID or split name does not make known content independent.

This known-history check covers the supplied and verified historical campaign
plans. It does not establish that material was unseen in every development
session, author context, or external source. Independent provenance and the
actual subject-visible material remain separate evidence. A cold Skill claim
also needs its declared fresh state and an observed unaided journey. Engine
tests, zero-send captures, and a route gate do not provide those observations.
The [corpus contract](benchmark-corpus.md), [protocol](benchmark-protocol.md),
and [analysis policy](benchmark-analysis.md) define the remaining conditions.

This document describes the implemented contract. It records no real finite
scope execution, accepted product version, or completed confirmation campaign.
