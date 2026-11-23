# Finite campaign contract

An explicit `campaign_scope` binds one complete Benchmark plan to the existing
144-reservation campaign. It supports a route gate for one model and bounded
acceptance comparisons, including independent confirmation. The scope never
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
| `role` | `route_gate_only` or `acceptance`. |
| `authorization` | The actual authorization for this finite work. |
| `predecessor.registration` | Absolute path and SHA-256 of the current registration file. |
| `predecessor.amendment` | Absolute path and SHA-256 of that registration's amendment file. |
| `history_plan_files` | Every owning plan for the closed historical reservations. |

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
A new scope cannot add an unknown observation to that exemption, acknowledge it
away, or turn an unknown historical total into a measured total.

A predecessor must be fully complete. A closed operator slice is insufficient.
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
