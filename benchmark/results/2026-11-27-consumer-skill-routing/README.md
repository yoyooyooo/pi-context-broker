# Consumer Skill routing, 2026-11-27

The decision is **no adoption / inconclusive**. The 24 planned logical slots contain two started B0 observations, both invalid, and 22 never-started slots. No candidate reached a model. No valid paired effect was estimated, and independent confirmation remains unopened.

Read the [report](../../../docs/benchmark-consumer-skill-routing-2026-11-27.md) for the causal question, stopped execution and interpretation. This package is an anonymous arithmetic projection of retained private evidence. It is not a portable replay of the model sessions.

## Files

| File | Purpose |
| --- | --- |
| `method.json` | Frozen design, thresholds, baseline identities and final disposition. |
| `recipes/` | Exact unadopted G, T and S candidate source patches. |
| `observations.json` | All 24 logical slots and 12 planned pairs, including invalid and never-started slots. |
| `cost-ledger.json` | Known usage, incomplete totals, retired attempts and excluded fixtures/probes. |
| `evidence-commitments.json` | Hash commitments to retained private evidence, without private paths or content. |
| `replay.mjs` | Checks the public projection and computes descriptive arithmetic. |
| `arithmetic.json` | Per-factor and per-arm counts, known usage and unresolved comparisons. |
| `slots.csv` | Compact per-slot export of the same projection. |
| `integrity.json` | SHA-256 hashes of the published files. |

## Reproduce the public arithmetic

From a checkout of this repository, using Node:

```sh
node benchmark/results/2026-11-27-consumer-skill-routing/replay.mjs
```

The command validates the fixed slot matrix and checks that `arithmetic.json` exactly matches recomputation. It makes no model or source requests. To regenerate the two derived outputs:

```sh
node benchmark/results/2026-11-27-consumer-skill-routing/replay.mjs --write
```

`--write` only rewrites `arithmetic.json` and `slots.csv`. It does not alter the method, observations, recipes, private evidence or the original execution ledgers. Published file hashes are recorded separately in `integrity.json`.

## Read the numbers

- Each factor has its own B0 and candidate, two cases and two repeats, for four pairs. The three factors are not pooled. Both cases share one material cluster.
- `not_started` is a scheduling disposition, not a measured business failure. The S collector-only plan transfer preserves its eight original logical slots and adds no samples.
- The two started observations are invalid. Their semantic review stays `unknown`; neither has a uniquely settled final answer. Missing answers have no invented hash.
- The T known subtotals are 176,289 input tokens, 1,611 output tokens and five client attempts. Complete T journey totals remain `null`, because original attempt coverage is partial.
- S is known zero for model calls and usage. Its 35,042.007333 ms of preparation and admission are still recorded. Known zero model usage is not zero elapsed time or proof of zero source HTTP activity.
- `scorer_capped_ms` is `null` for invalid and never-started slots. `observed_elapsed_capped_ms` is a separate diagnostic; it is not substituted for the scorer penalty.
- Candidate/B0 ratios and paired effects are unknown. Missing data do not become zero. A zero measured baseline would make a ratio undefined, which is a different status.
- Failed screening checks mean the candidate did not meet the evidence requirement. They do not establish a negative effect. All critical pairs are unresolved; a zero count of known new regressions does not establish safety.
- Earlier bare-profile usage has a separate denominator. Synthetic loopback values and earlier connectivity probes are excluded as explicitly stated in the cost ledger. No monetary total is claimed.

## Reproduction boundary

The script can verify arithmetic over the supplied anonymous numbers. It cannot establish that the numbers faithfully represent private observations, regrade answers, verify author bodies and source delivery, inspect the raw transport, prove gateway backend identity or repeat the condition-blind semantic reviews. Those materials are retained privately, with commitments listed here. Hashes identify evidence; they do not make private evidence publicly inspectable.

Real prompts, Skill bodies, answers, oracles, source identifiers, machine paths and raw SDK/HTTP/session logs are not included. The recipes are experimental patches and were not adopted into `next` or daily installations by this task.
