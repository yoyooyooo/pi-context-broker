# Engineering continuation across one new model window

This contract transfers the never-started engineering suffix after the original
window expired. It does not turn an old scope into a resumable plan. The retained
CodeMode plan, ledger, registration, authority and model window remain immutable.

## Exact admitted boundary

The parent is the verified version 6 observer-repair authority. Its registered
suffix must contain the completed Own Product allocation of eight, followed by
the original CodeMode allocation of 24 with exactly its first seven slots closed.
The latter closes with `batch_budget_exhausted`, observed elapsed wall-clock time
at least its invocation limit, known resource usage, no core stop and no unresolved
start. The complete campaign boundary is 104 physical and closed reservations and
13 registrations. The history retains all prior unknown usage and invalid results.

The new first allocation uses role `engineering_window_continuation`. Its source
is the byte-bound original CodeMode plan and ledger; its selection is exactly
`source.slots.slice(7)`. The next allocations are the unchanged five scale pairs
and eight fault observations. The allowance is 17 + 10 + 8 = 35, reaching the same
139 total, inside the unchanged hard limit of 144. Five reservations stay
unallocated. No other partial terminal scope can use this transition.

## Draft and approval contracts

`draft-engineering-window --request ABS_JSON --out ABS_NEW_JSON` writes an
exclusive, non-executable proposal. The request contains the proposed authority
ID, parent authority reference, exact predecessor registration/amendment,
checkpoint reference, new allocation/experiment IDs, and the verified private
controller-composition reference. The draft derives the
source plan, source ledger, selection and budget from the registered prefix.
Its kind is `engineering-window-continuation-proposal-not-executable`, with
`approved: false`, `execution_authority: null`, and null new-window timestamps.
It records all source references, exact counts, old window, scientific separation
and the single proposed 24-hour window. Producing a draft does not create an
authority, capture startup, configure a scope or reserve an episode.

`prepare-engineering-window --draft ABS_DRAFT --decision ABS_DECISION
--out ABS_NEW_AUTHORITY` requires a separate explicit decision. Its kind is
`user-approved-engineering-window-continuation`; `approved` must be true and
`source` must be `current-user-message`. It binds the exact unchanged draft,
checkpoint, parent authority, controller composition, source plan/ledger,
predecessor and 104/13 boundary.
It supplies one actual 24-hour window beginning no earlier than the old end and
the decision timestamp. Automatic renewal is false. False, missing or mismatched
approval fails before setup writes, captures or reservations.

The resulting authority has version 7 and revision kind
`accepted-engineering-window-continuation`. It retains the original approval,
proposal and accepted history, and binds the fresh decision, consumed Own
allocation, exact partial CodeMode transition, next allocation ID, source
engineering designs and model-window science policy. Its first allowance is 17;
the remaining six allocations preserve their original IDs, order and limits.
The reader recursively verifies the v6 parent and all old guards, then verifies
the complete 104 history against the new boundary. Ordinary successor rules stay
unchanged. Historical reads do not require the ledger still to have 104 rows;
preparation checks that exact current boundary, without active leases, both
before and after the proof.

## Resource accounting

The original CodeMode episode caps remain unchanged. The original batch caps and
the seven retained observations give this exact carryover:

| Resource | Original cap | Retained consumption | New cap |
| --- | ---: | ---: | ---: |
| Episodes | 24 | 7 | 17 |
| Requests | 240 | 31 | 209 |
| Input tokens | 7,200,000 | 120,222 | 7,079,778 |
| Output tokens | 384,000 | 2,868 | 381,132 |
| Subject duration, ms | 5,100,000 | 177,348.906042 | 4,922,651 |

The schema requires integer duration limits. The new duration limit is the floor
of the exact residual 4,922,651.093958 ms; the discarded 0.093958 ms is retained in
the transition accounting. These displayed decimals are rounded for reading;
the implementation retains the actual ledger's ordered floating-point sum and
derives the floor from that value. This never adds allowance. The old consumption
remains in campaign cost accounting.

The existing `batch.max_duration_ms` also limits each new invocation's elapsed
wall-clock time. The new 4,922,651 ms limit therefore bounds both cumulative new
subject duration and each new invocation, more strictly than the old 85-minute
invocation limit. The old invocation's elapsed wall time remains recorded; it is
not refunded or recategorized as subject duration.

## Scientific identity and analysis

The new CodeMode protocol has a new experiment ID and the explicitly approved
model window. Sol 6.2, medium thinking, 4096 output tokens, routing contract,
business cases, pairs, order, scoring and statistical policies remain fixed.
The full declared design still has 24 slots; the new dispatch schedule has 17.
Startup capture retains the complete 24-cell case/condition mapping. Stateful
fixture reuse is not accepted for this CodeMode suffix.

The model condition includes its backend window. Old seven and new seventeen
remain separate experiment/window observations. The old analysis remains
24 planned / 7 valid / 17 missing. If all seventeen new observations are valid,
the new analysis reports 24 planned / 17 valid / 7 missing. A closed but invalid
observation still consumes its reservation and costs, and can reduce the valid
count. The old prefix has three complete pairs and
one single side; the new suffix has eight complete pairs and the other single
side. Those two sides cannot form a cross-window pair. All missing cells retain
their original denominator contribution. The analyzer rejects an old episode
when passed to the new experiment without rewriting its identity; rewriting
retained evidence is prohibited.

The science policy in the draft and authority is:

```json
{
  "reporting": "separate-model-window-protocols",
  "paired_denominator": "original_declared_schedule",
  "missing_cells": "retained_unknown",
  "cross_window_pairing": false
}
```

## New bounded runner

`run-engineering-window --plan ABS_V7_PLAN --out ABS_NEW_RUNNER --limit 8`
creates an exclusive new claim inside the campaign's canonical control root.
The plan and owner paths must be canonical and the same fresh authority verifies
the frozen plan before a claim is created. The command exits zero only when its
selected plan is completed; a stopped or exceptional outcome exits nonzero and
retains its receipt and any observed prefix.

The new runner classifies the actual ledger prefix, never a requested count.
Every started slot must have exactly one completed result in serial order,
inside a closed invocation, with every frozen slot field unchanged, and
all costs must be known. A completed plan finishes. A positive operator slice
may continue inside its current authority and window. A shorter positive slice
closed by `batch_budget_exhausted` may continue only when recorded elapsed time
reached the invocation limit and cumulative resource headroom still permits the
next episode at its full episode caps. The closure label alone is insufficient.
Zero progress, a core stop, new unknown usage, unresolved execution, an expired
window, insufficient cumulative allowance or an unexpected closure stops the
runner. Every outcome preserves a checkpoint of the observed prefix. Analysis
is produced only for a newly completed prefix; a zero-start tail still gets a
checkpoint without attempting an empty analysis. Each command receives a fresh
preflight, including after analysis. The checkpoint binds the exact ledger bytes
used for classification; the runner verifies that snapshot before and after
analysis. A ledger change during review stops the series. A known local request
limit failure that the controller proves has `stop_batch: false` remains an
ordinary closed episode; runtime status alone does not create a core stop.

The old runner and claim are not reused. A future publication must use a new
engineering-only binding to the published 104 history. The previous PREP3 adapter
is specific to v6/history89/Own-first and cannot represent this continuation.

## Private controller provenance

The public product retains its existing collector version. This continuation
requires the original private source3 collector and its scientific behavior.
Its base manifest is pinned to SHA-256
`62055507c7aa4d6a298841bd74cc7db2dc5d03e302f33c46846a653904cf719c`.
A new isolated source copies that retained base and overlays only the reviewed
dispatch, authority, selection, protocol/schema, configure, CLI and runner files.
Every overlay byte must equal its file in the reviewed Git commit. Unrelated
collector, scoring, model or observer changes are rejected.

`compose-engineering-controller --request ABS_JSON --out ABS_NEW_COMPOSITION`
verifies an already prepared source tree; it does not copy or change it. Its
request contains `baseController`, `sourceRoot`, `reviewedRepository` and
`reviewedCommit`. The resulting eight fields are `version`, `kind`,
`base_controller`, `source_root`, `reviewed_repository`, `reviewed_commit`,
`implementation` and `overlay_files`. Draft and decision references bind this
composition file. The outer frozen-controller manifest additionally records
the complete source inventory and the composition reference.

Prospective preparation checks Git provenance before importing any new producer
dependency. The composition reader verifies every retained and changed runtime
file, then derives the complete static execution closure so an omitted new
module cannot pass with a self-consistent shortened manifest. Actual startup
expectation projections are recomputed with that verified private producer.

Historical v6 authority and old Own/CodeMode plans are read with their byte-bound
original source3 modules. Delegation is restricted to the exact old authority
chain, the two retained plans, and predecessor13. It uses historical readers,
which remain valid after registration14 and reservation105; it never substitutes
an old current-state dispatch check. New v7 plans use the new composition and
retain their own full protocol and runtime checks.

## Implementation ownership and verification

- `campaign-engineering-window-continuation.mjs`: source derivation, decision,
  current-boundary checks, exact history proof, residual budget, setup/protocol
  guards and draft data.
- `approved-campaign.mjs`: typed v7 reader/preparer and approval binding.
- `campaign-selection.mjs`, protocol schema/validation, finite dispatch and
  configure: explicit role, 24-design/17-dispatch split and pre-side-effect gate.
- `engineering-progress.mjs`: pure actual-prefix classifier for the new runner.
- `engineering-runner.mjs`: concrete bounded execution, immutable checkpoints,
  snapshot-checked analysis and stopped-result receipts.
- `engineering-source.mjs`: prospective Git-blob provenance and composition
  preparation without model work.
- `cli.mjs` and implementation closure: explicit offline preparation commands and
  all required source modules.

Offline tests cover changed parent/version, approval/draft/reference mutations,
advanced or leased 104/13 boundary, non-prefix or replayed slots, a partial Own
allocation, fresh core/unknown/unresolved results, insufficient residual budget,
integer rounding, changed model/window/business policy, all runner closure
classes and the exact 24/17 analysis denominator. Fixtures are engineering tests,
not model observations. No real authority, model window or paid dispatch is
created by implementing this contract. Portable source fixtures exercise the
internal byte/provenance checks with synthetic producer graphs; the public
reader separately rejects their self-signed bases. They do not claim to replay
the actual104 campaign or authorize a synthetic decision outside the fixture.
