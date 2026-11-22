# Prospective pilot scope under the retained campaign

A scope amendment narrows a previously interrupted pilot without changing its
original plan or deleting its costs. The current supported amendment selects
two explicitly configured models in Broker and native Pi. Its new apparatus
gate has sixteen episodes, four per model/environment condition. A later
bounded expansion uses the same amendment and the same shared pilot ledger.

The original first24 remains incomplete. `policies.pilot.route_gate_episodes`
stays 24 as the legacy contract. The prospective policy and v3 gate have their
own identity; passing them does not claim the original first24 passed.

## Register the new gate

Keep `phase: "pilot"` and the original absolute `pilot_ledger_root` in the normal
configuration input. Supply the two concrete model routes, API adapters,
parameters and observation window through the existing model configuration.
No model name is inferred from a family label and no automatic fallback is
allowed. Add:

```json
{
  "pilot_scope": {
    "id": "two-models-20261122",
    "role": "gate",
    "authorization": "Record the actual user authorization and disclosed route choices here.",
    "history_plan_files": [
      "/absolute/original-route-gate-1/plan.json",
      "/absolute/original-route-gate-3/plan.json"
    ],
    "acknowledged_unknown_run_ids": ["benchmark-route-gate-3-003"],
    "gate_episodes": 16,
    "minimum_valid_real_per_condition": 4
  }
}
```

These paths and the authorization text are examples. `configure` uses the
actual supplied files. It performs zero model sends, captures current loading,
and writes `pilot-scope-amendment.json` inside the new control directory before
freezing the plan. The amendment binds all three original reservations, their
plans and complete ledgers, the registered analysis revision, and underlying
episode evidence. It derives historical usage from those bundles and rejects
an omitted or extra acknowledged unknown run. An exception cannot apply to a
future reservation.

At the first November 22 scope registration, history contains three reservations and five actual
HTTP sends. The initial rejected episode has zero sends. The corrected Grok
observation has four, and Flash has one whose token totals remain unknown.
Those reservations continue to consume the 144 episode campaign cap. A model
retry is an additional HTTP attempt within its episode; it is also retained in
request and token accounting. Reanalysis of the same raw bytes is not another
episode or HTTP attempt.

## Execute and certify

Use the existing `run --plan`, `status --root`, and `gate --root --out` commands.
The scope gate can schedule only its frozen sixteen slots. A new control root
cannot turn an unfinished gate into authorization for expansion, even before
campaign reservation 025. Exclusive reservation files preserve the campaign
cap across names and restarts. A scope lease also prevents two controllers from
dispatching concurrently through different control roots.

Before every new dispatch the controller checks later reservations throughout
the scope. An orphan reservation, an unresolved run in another plan, a retained
core stop, unknown new usage, or changed evidence blocks further dispatch. It
reopens completed evidence bundles and compares their identity and usage with
the ledger summary. Editing a summary to claim known usage does not clear an
unknown observation. Omitting the scope policy after campaign activation is
also rejected.

The v3 gate verifies all sixteen underlying observations and their shared
reservations, model/environment identities, exact observer and collector
implementation, complete core observations, actual sends, and known reported
usage. Its four conditions must each have four distinct scheduled episodes.
Business failure and unknown business or tool-selection outcomes remain in the
fixed quality denominator; the apparatus gate does not demand business success
or use successful cases to select its sample. Unknown usage or invalid core
evidence still blocks certification and further dispatch.

## Expand within the same scope

Prepare another bounded pilot plan with the same model identities, backend
window, build, runtime, tool contracts, policies, observer and collector. Per-case
catalogs, prompts and material bindings are independently frozen and checked by
that plan's startup expectations. Add:

```json
{
  "pilot_scope": {
    "id": "two-models-20261122",
    "role": "expansion",
    "amendment": {
      "path": "/absolute/new-gate/pilot-scope-amendment.json",
      "sha256": "USE_THE_ACTUAL_FILE_SHA256"
    }
  },
  "route_gate": {
    "path": "/absolute/new-gate/gate-v3.json",
    "sha256": "USE_THE_ACTUAL_FILE_SHA256"
  }
}
```

The placeholders above are deliberately not valid executable hashes. The
controller requires the actual v3 receipt and rechecks its raw evidence. It
continues numbering in the original ledger. Three historical reservations,
sixteen new gate episodes and a proposed 32 episode expansion would occupy 51
of 144 slots if all are scheduled. That arithmetic is a budget plan, not a
claim that any episode ran or passed.

Analysis of the new plan uses its own declared cohort. Historical observations
receive no new quality or gate credit. The amendment and gate retain a separate
history accounting object with a known subtotal and `total_usage_status:
"incomplete"` when any historical usage is unknown. Money stays unpriced when
there is no verified pricing contract. A report must not present either the
subtotal as the complete campaign cost or an unknown amount as zero.

## Resume and recover

Same-plan resume reconciles a started run from retained evidence before moving
on. It never resends an unresolved slot. A later interrupted expansion does not
invalidate the historical gate receipt, but it blocks other scope dispatches.

Normal returns and errors retain the scope lease through `finally`. After a
process crash, use the existing `reconcile --root ... --lease ...` command with
the observed dead batch lease ID. It checks the process and also releases the
matching scope lease by retaining it under a new audit filename. If the process
stopped before the batch lease was created, name the observed scope lease ID
instead. Recovery releases a dead owner only; it does not erase an orphan,
resolve an unknown run, or authorize another model send.

`benchmark/pilot-scope.test.mjs` uses synthetic raw files and real normalization,
bundle verification, reservation and gate APIs. It covers historical changes,
foreign ledgers, early expansion, cross-root unknown/core stops, orphan
reservations, same-plan reconciliation, and the cumulative 144 cap. These are
offline controller tests and contribute no model results to the campaign.

## Repair the first prospective rejection with verified zero model sends

A second, narrower path handles the first prospective gate slot when startup
admission passed but the final request contract rejected the observed catalog
handles before any model HTTP attempt. It creates a version 2 amendment and a
new complete sixteen-episode gate. The rejected observation remains invalid,
retains its stop, consumes its original reservation, and provides no gate or
quality credit.

Use a fresh control directory, a fresh scope ID and a new paired build. Keep
the same two models, parameters, route windows, cases, task contracts,
authorization, budgets, seeds and slot order. Replace `history_plan_files` in
the gate setup with:

```json
{
  "predecessor": {
    "amendment": {
      "path": "/absolute/previous-scope/pilot-scope-amendment.json",
      "sha256": "ACTUAL_PREDECESSOR_AMENDMENT_FILE_SHA256"
    },
    "plan": {
      "path": "/absolute/previous-scope/plan.json",
      "sha256": "ACTUAL_PREDECESSOR_PLAN_FILE_SHA256"
    }
  },
  "zero_send_repair": {
    "run_id": "THE_EXACT_REJECTED_RUN",
    "reason": "Describe the reviewed apparatus repair."
  }
}
```

`configure` derives the fourth historical reservation from that named run and
requires the predecessor to have exactly one started and completed slot and a
closed batch. It verifies the retained runtime, shared launcher result,
normalized evidence and complete transport trace. Only the explicit
`BENCHMARK_FINAL_REQUEST_CONTRACT_DRIFT` rejection at `/messages` is supported.
The original startup and canonical catalog comparisons must have no
differences. Model sends, attempts, tools and token usage must be exactly zero,
with complete observations. A prepared request record is not an HTTP attempt.
The rejected runtime has one prepared request and one settled turn; a fresh
capture has one serialized request, zero request budget usage, zero attempts
and zero turns. Notion reads may appear in both complete transport traces.

Four new captures must cover both models in both environments. The task and
model policy remains identical. Product inventories compare CLI and Broker
source, dependencies, package metadata, compiled code and bundled Skills,
including symlink descriptors. Only the generated `dist/next-build.json` and
`dist/ntn-skills-runtime.json` bindings are excluded from that product comparison;
the new build and complete capture still bind their actual identities. The
apparatus source and build identities can change for the declared repair.

The original `scope-registration.json`, plans, ledgers, raw artifacts and
amendment are preserved. Activation exclusively adds
`scope-registration-002.json`, which binds its predecessor registration by hash.
The successor retains all four historical reservations and the exact inherited
Flash unknown-cost exception. It then needs sixteen new real observations, so
the gate would finish at twenty campaign reservations. The 144 cap continues
unchanged. Another scope cannot absorb an additional send, unknown usage,
another reservation or a task-policy change through this repair path.

The original startup-admission repair remains strict and separate. Its default
validator still requires the original admission mismatch and no prepared
request or turn. The explicit final-request branch does not broaden that
existing contract. Tests exercise the complete successor path, immutable
registration succession, refusal of a model transport attempt, unchanged
budgets and product bytes, and preservation of the default contract.

## Register the one permitted authentication route replacement

An authenticated request failure with unknown usage is not a zero-send repair.
The retained second scope stays stopped. A separately authorized, prospective
version 3 amendment declares the exact failed and replacement model IDs in
`manual_route_replacement.from_model_id` and `to_model_id`. Each ID must select
one model in its frozen protocol and equal that model's `provider + "/" + route`.
Both models must use the same provider, `family` must equal `route`, and the last
route component must be `gpt-6.2-sol`. The implementation reads these registered
identities without selecting another route. Reserved `auto/` and `group/`
route prefixes are rejected even if the declaration and registry agree.
The advertised variant remains
GPT-6.2 Sol; this does not prove an opaque backend snapshot is equal.
The registered observation window and backend uncertainty remain unchanged.
Grok stays on its existing route. All Benchmark execution remains in the same
paired environment. The provider and route labels in the example below are
synthetic and must be replaced by the explicitly authorized registry identities.

This path requires a version 2 predecessor whose first and only scheduled
episode has the named retained failure. Startup, canonical catalog and final
request comparisons must all have passed. The normalized bundle must be
invalid, with complete core observations, exactly one model HTTP attempt,
unknown input and output usage, no tools and no successful business result.
The runtime and complete transport trace must agree. The observed response is
HTTP 200 with `text/event-stream`; its hash-bound SDK error event reports an
expired Command Code Plan key and HTTP 401. The amendment records those two
statuses separately. It does not claim that the outer HTTP response was 401 or
that an unretained response body was directly inspected.

Use a fresh control directory and scope ID, the same paired build, and the same
case materials, contracts, authorization, seed, complete slot order, budgets,
API and `thinkingLevel: "medium"` / `maxTokens: 4096` parameters. Supply:

```json
{
  "pilot_scope": {
    "id": "synthetic-route-scope",
    "role": "gate",
    "authorization": "Record the actual authorization and disclosed same-Sol route choice.",
    "predecessor": {
      "amendment": {
        "path": "/absolute/stopped-version-2/pilot-scope-amendment.json",
        "sha256": "ACTUAL_PREDECESSOR_AMENDMENT_FILE_SHA256"
      },
      "plan": {
        "path": "/absolute/stopped-version-2/plan.json",
        "sha256": "ACTUAL_PREDECESSOR_PLAN_FILE_SHA256"
      }
    },
    "manual_route_replacement": {
      "run_id": "synthetic-stopped-v2-001",
      "from_model_id": "fixture-provider/synthetic-expired/gpt-6.2-sol",
      "to_model_id": "fixture-provider/synthetic-replacement/gpt-6.2-sol",
      "variant": "gpt-6.2-sol",
      "reason": "Retained expired-key rejection; explicitly selected same-variant route.",
      "administrative_hold": "full_prior_episode_allocation_not_actual_upper_bound"
    },
    "acknowledged_unknown_run_ids": [
      "synthetic-original-003",
      "synthetic-stopped-v2-001"
    ],
    "gate_episodes": 16,
    "minimum_valid_real_per_condition": 4
  }
}
```

The placeholder references are not executable. `configure` binds the actual
predecessor model registry, all five reservation hashes, all prior plans and
closed ledgers, and the original normalized/runtime/shared/transport/event
evidence. The new registry and four fresh zero-model captures bind the selected
route. The authentication event must name the frozen predecessor route. An
undeclared replacement, a mismatched provider or family, or the failed route
remaining selected is rejected. This narrow policy retains the recorded
context-window change from 1,050,000 to 922,000; only the
registry ID, display name and this observed context-window metadata may differ.
Other selected model metadata, API parameters, build, product and runtime bytes,
observer and collector must remain unchanged. Registry cost fields are
configuration defaults and are not observations of a zero price. Per-capture
catalog/injection hashes and physical extension paths may change with the new
capture; frozen startup and request contracts check their actual values.

Activation exclusively appends `scope-registration-003.json`, hash-linked to
the unchanged second registration. Existing plans, registrations, ledgers and
raw artifacts remain intact. No version 3 successor or another manual route
replacement is supported. There is no automatic fallback, credential change,
new empty ledger or exemption for a future unknown. A new unknown usage result
still stops the new scope. A new control directory cannot clear that stop.

The historical count becomes five reservations and six observed model HTTP
attempts. Both Flash and the authentication failure retain unknown token usage;
the historical cost total remains incomplete and money remains unpriced. The
new `history.administrative_holds` entry preserves the failed episode's full
frozen allocation with `actual_usage: "unknown"` and
`proven_actual_upper_bound: false`. This is an administrative allocation hold,
not observed usage, another reservation, or a proven bound on provider charges.
It is never added to the known usage subtotal. Historical observations receive
no new quality or gate credit.

The new gate requires sixteen fresh observations, four per condition. It uses
the same apparatus criteria as the other prospective gates and retains unknown
business or selection outcomes in its fixed quality denominator. Five retained
reservations plus sixteen new gate episodes would occupy 21 of the same 144
campaign slots; a later 32 episode expansion would bring that to 53. These are
planned counts, not claims that those new observations occurred or passed.
Scope amendment version 3 and gate receipt version 3 are separate file formats.

Offline tests exercise the complete three-registration sequence, preservation
of all five reservation files and the stopped predecessor ledger, the actual
metadata change, fresh sixteen-observation coverage, no repeated successor,
rejection of undeclared IDs or another variant, false auth evidence, extra
unknown history, changed budgets/builds and registry metadata, and blocking a
new unknown usage result. These synthetic observations never enter the live
campaign ledger.

## Apply a verified analysis correction to a scope

A registered same-raw analysis revision can correct a derived stop
classification. It does not alter the frozen protocol, route, build, budget,
slot order, original completion, or campaign reservation. The revised result
must retain its original run and raw artifacts and pass the independent
revision validator. In particular, a known episode request limit is different
from unknown model usage or a failed core observation: the former can remain a
failed business observation with fully accounted requests, while the latter
continues to stop the scope. A revision cannot make another request for the
already completed slot or turn its business failure into a verified business
success. An admissible accounted failure can satisfy apparatus coverage while
remaining a failure in the fixed quality denominator.

The current plan may supply its verified revision reference and object before
registration. Scope validation reopens that reference, verifies it against the
exact owning plan, and requires unchanged observer/collector instrumentation.
For another control root it reads only the revision already registered in that
root's append-only ledger. A bare replacement object, another plan's revision,
a changed reference or source, and a second revision chain are rejected. New
and unreplaced unknown usage and core stops remain blocking across all control
roots.

The controller appends `analysis_revision_applied` through the existing
`run --analysis-revision ...` path; `--limit 0` can register and check the
correction without any new model execution. The original `episode_completed`
entry stays byte-for-byte in the ledger. Only the verified effective view
points to the new normalized bundle. Scope validation reopens that bundle and
checks run/slot/model/environment/build identity, complete core observations,
actual sends and known usage. No extra episode or replacement sample is added.

The scope gate records the revision reference both for the gate and each
affected observation, along with `original_episode_sha256` and
`original_directory`. Offline verification checks those against the original
completed event and the verified replacement, then checks the new bundle and
its original raw evidence. Unchanged observations keep their original
references. A report can therefore show both the retained controller stop and
the corrected analysis without silently rewriting either history or costs.
