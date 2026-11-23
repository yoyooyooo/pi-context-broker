# Continue a pilot with a finite prospective cohort

A new authorized cohort starts from a frozen checkpoint of the existing pilot
campaign. It uses the original shared reservation ledger and a new isolated
environment and control roots. Earlier plans, raw evidence, stopped observations,
registered analysis revisions and published results keep their original identity.
Earlier observations receive no admission or quality credit in the new cohort.

The retained [scope amendment formats](benchmark-pilot-scope.md) remain readable.
New cohort registration uses `kind: "benchmark-prospective-cohort", version: 1`;
the schema version is independent of the append-only registration sequence.
This does not reopen an interrupted legacy gate or satisfy its missing slots.

## Freeze the finite comparison

Choose one concrete model set, Broker and native Pi, four admission cases and
eight distinct expansion cases. Every model/environment/case combination runs
once. The two phases belong to the same twelve-case cohort.

| Selected models | Conditions | Admission episodes | Expansion episodes | Cohort limit |
| --- | --- | --- | --- | --- |
| One | 2 | 8 | 16 | 24 |
| Two | 4 | 16 | 32 | 48 |
| `N` | `2N` | `8N` | `16N` | `24N` |

The historical reservation count plus the entire new cohort limit must fit
inside the campaign's 144 reservations. Invalid observations consume their
reservations. An operator slice continues the same frozen plan; it does not add
another sample or authorize a rerun. A later model is a separate cohort after
both phases of the preceding cohort are complete.

Use resolved variant IDs in `expansion.case_ids`, including their catalog and
turn suffixes. A public base case ID is a preparation input, not the final
scheduled identity. A two-turn case still has one episode per condition when
the repetition count is one.

Add the following to the normal admission setup. Paths, hashes and names below
are placeholders and must be replaced by the observed files.

```json
{
  "phase": "pilot",
  "pilot_ledger_root": "/absolute/existing-campaign/pilot-ledger",
  "pilot_scope": {
    "kind": "benchmark-prospective-cohort",
    "id": "new-cohort",
    "role": "gate",
    "authorization": "Record the actual authorization and finite model scope.",
    "predecessor": {
      "registration": {
        "path": "/absolute/existing-campaign/pilot-ledger/scope-registration-003.json",
        "sha256": "ACTUAL_REGISTRATION_FILE_SHA256"
      },
      "amendment": {
        "path": "/absolute/previous-control/pilot-scope-amendment.json",
        "sha256": "ACTUAL_AMENDMENT_FILE_SHA256"
      }
    },
    "history_plan_files": ["/absolute/every-owning-history-plan/plan.json"],
    "acknowledged_unknown_run_ids": ["EVERY_EXACT_HISTORICALLY_UNKNOWN_RUN"],
    "expansion": {
      "experiment_id": "new-cohort-expansion",
      "control_root": "/absolute/new-control/expansion",
      "case_ids": [
        "case-01-a-n16-r1", "case-02-a-n16-r1",
        "case-03-a-n16-r1", "case-04-a-n16-r1",
        "case-05-a-n16-r1", "case-06-a-n16-r1",
        "case-07-a-n16-r2", "case-08-a-n16-r2"
      ]
    }
  }
}
```

`configure` derives model count, condition count and reservation limits from the
actual selected model set. The admission schedule comes from its four prepared
cases. It freezes the exact expansion plan ID, control root and eight case IDs;
another control directory cannot expand that allowance. Both phases bind the
same model registry bytes, parameters, backend observation window, environment
implementation, observer, collector and episode budget. Each phase has its own
batch budget and startup expectations.

## Bind the requested route and reported label

Every selected model has a `models.routing` entry keyed by its exact registry
route. The value declares `mode`, `model_variant` and the exact
`reported_model_ids` accepted from the provider response. A configured auto route
is part of the experiment condition. It is not interchangeable with an earlier
fixed route merely because both names include the same variant.

The runtime retains the requested route and every server-reported model label.
The collector, normalized evidence and gate bind those observations to the
frozen routing contract. A missing label, an unregistered label or another
variant stops the cohort. A retained gateway route alias can be an explicitly
declared label; it must remain distinguishable from a concrete reported model
label. Neither label is independent attestation of the gateway's underlying
backend. Reports must keep this assurance limit visible.

For `auto-route`, the requested route is exactly `auto/<model_variant>` and the
backend remains `opaque_alias`. Its identical response label may be placed in
the frozen allowlist before execution; another auto or group alias cannot match
by suffix alone. The evidence distinguishes `requested_route_alias` from
`concrete_reported_label` while retaining the same non-attestation assurance.

## Retain history without turning new failures into exceptions

The checkpoint reads every owning plan, its complete closed ledger and every
shared reservation. It verifies the normalized bundle against raw files under
that plan's own environment root. Registered same-raw revisions retain the
original directory and episode hash, plus the effective analyzed result. They
do not add a reservation or another observed request.

Actual sends may be unknown in retained history. Unknown values remain `null`;
known subtotals are not presented as complete usage or a proven charge bound.
Money remains unpriced without a verified pricing contract. The exact set of
unknown historical run IDs must match the acknowledgement.

The first cohort freezes `history_exemption`: its original reservation cutoff,
unknown run IDs and checkpoint hash. Later cohorts inherit it unchanged. They
cannot add a newly unknown observation to that exception. Every observation
after the cutoff must have complete core evidence, known usage, the frozen
routing contract and no retained core stop. The preceding cohort must also have
all admission and expansion slots recorded exactly once. A missing slot or a
new core failure prevents moving on to another model set.

## Run, certify and expand

Use the existing commands:

```sh
node benchmark/cli.mjs configure --setup /absolute/new-control/gate-setup.json
node benchmark/cli.mjs run --plan /absolute/new-control/gate/plan.json --limit 2
node benchmark/cli.mjs status --root /absolute/new-control/gate
node benchmark/cli.mjs gate --root /absolute/new-control/gate --out /absolute/new-control/gate/cohort-gate.json
```

Configuration observes loading and serialization without a model send. The
apparatus gate requires every current admission slot and four valid, accounted
real observations per model/environment condition. Business fail and unknown
outcomes remain eligible apparatus evidence and remain in the quality
denominator. Removing them, duplicating a successful slot or importing an old
observation cannot satisfy the gate.

The resulting receipt is `kind: "benchmark-cohort-gate", version: 1`. Expansion
uses the exact frozen expansion setup and references both this receipt and the
same amendment:

```json
{
  "pilot_scope": {
    "kind": "benchmark-prospective-cohort",
    "id": "new-cohort",
    "role": "expansion",
    "amendment": {
      "path": "/absolute/new-control/gate/pilot-scope-amendment.json",
      "sha256": "ACTUAL_AMENDMENT_FILE_SHA256"
    }
  },
  "route_gate": {
    "path": "/absolute/new-control/gate/cohort-gate.json",
    "sha256": "ACTUAL_GATE_FILE_SHA256"
  }
}
```

Gate and expansion observations both belong to the new cohort's declared
quality denominator. Keep their individual plan identities when combining
results, and count each run once. Historical quality results remain a separate
cohort. An apparatus gate passing is not a quality acceptance decision.

## Concurrency and interruption

One `campaign.lease.json` serializes all cohort controllers using the shared
ledger. Legacy per-scope leases remain blocking until explicitly reconciled.
Every reservation rechecks the active registration, immutable history prefix,
current cohort evidence and finite allowance. Registration uses an append-only
hash chain; it cannot overwrite or skip a predecessor.

A started slot can only be reconciled from retained evidence, never resent.
Use the existing `reconcile --root ... --lease ...` command for a proven dead
owner. Recovery retains the old lease as an audit artifact and releases only
that owner. It does not change unknown usage, a failed observation, a cohort's
fixed denominator or its remaining authorization.

`benchmark/prospective-cohort.test.mjs` exercises these boundaries with synthetic
provider event files and real normalization, bundle verification, ledger and
gate APIs. The legacy scope tests continue checking the retained formats. None
of those offline fixtures contributes a model result to a live campaign.
