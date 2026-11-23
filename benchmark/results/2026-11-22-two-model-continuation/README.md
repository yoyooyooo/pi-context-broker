# Benchmark campaign evidence

Each included package has its own frozen plan, observations and independent statistical replay. Quality and efficiency are never pooled across plans.

## Historical evidence

History status: `linked_not_replayed`. Only the original release manifest and accounting JSON are embedded as byte-identical snapshots.
[Original 974-file release at the fixed commit](/yoyooyooo/pi-context-broker/tree/c2526547e41937fd9dd21c10db06e02c08f497cf/benchmark/results/2026-11-22-two-model-pilot)
[Independent historical replay](/yoyooyooo/pi-context-broker/blob/c2526547e41937fd9dd21c10db06e02c08f497cf/benchmark/results/2026-11-22-two-model-pilot/replay.mjs)
[Historical accounting](/yoyooyooo/pi-context-broker/blob/c2526547e41937fd9dd21c10db06e02c08f497cf/benchmark/results/2026-11-22-two-model-pilot/accounting.json)

The new replay checks both snapshot hashes and the original accounting inventory binding. It does not execute the linked historical replay.

## Actual plan coverage

| Plan | Phase | Purpose | Role | Planned | Recorded | Valid | Invalid | Unresolved reservations | Unreserved |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [benchmark-two-model-cohort-3-gate](cohort-3-gate/report.md) | pilot | model_environment_interaction | gate | 16 | 16 | 16 | 0 | 0 | 0 |
| [benchmark-two-model-cohort-3-expansion](cohort-3-expansion/report.md) | pilot | model_environment_interaction | expansion | 32 | 21 | 20 | 1 | 0 | 11 |

## Accounting and intent

See [accounting](accounting.json) for every physical reservation, including failed, invalid and unresolved executions. Historical unknown totals stay unknown. See [coverage](coverage.json) for all pending denominators and models that remain intent only.

Route-only finite scopes declare eight slots and no expansion. Acceptance scopes retain their actual pilot or confirmation phase and purpose, without an invented gate. The route intent and prospective budget decision remain separately hashed source declarations; allocation is not execution.

Completed normalized evidence and raw artifacts were available and verified at assembly. Missing completion does not establish whether an unresolved run has raw files; no normalized result or zero cost is invented. Missing required completed evidence stops assembly.

Retained execution boundary: `blocked_by_retained_new_stop_or_unknown`. New usage-unknown runs: 1. This publication does not authorize another dispatch or expand any exemption.

## Collection recovery provenance

Plans with a registered same-raw collection recovery link an additional recovery audit in their release descriptor. It retains redacted failed-ledger prefixes, before/after repair source archives, raw-inventory mappings and original-to-owned material proof projections. One physical run still has one reservation and one accounting row. Private source hashes and public file hashes have separate meanings; public replay does not recompute private redacted hash chains.

## Replay boundary

Run `node replay.mjs`. It verifies the exact inventory, independently replays every new subpackage, and recomputes per-plan coverage and shared reservation accounting.
The private assembly verified scope amendments, applicable gates, owning-environment raw bundles, closed ledgers and registered analysis revisions. The public replay validates their safe projections and hashes; it does not rerun private grading, scope validation, Notion, or any model.
