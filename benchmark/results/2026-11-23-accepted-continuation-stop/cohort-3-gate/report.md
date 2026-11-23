# Benchmark report

- Protocol: benchmark-two-model-cohort-3-gate (ea46905cd23c4620eb31a9d194a59a2f3da6917d64a69f9bbca4a9a41b5d5539)
- Analysis: 1.1.0 (8a7a7f2353af9448dd91f3bc8c909338423fd8c76ae845cc792179e1846a96c8)
- Planned slots: 16; valid slots: 16; unresolved: 0.
- Actual runs: 16; invalid runs retained: 0; known actual requests: 76.
- Known input subtotal including invalid runs: 394855. This subtotal is not a complete total when usage is missing.

## Quality and evidence

| Condition | Verified quality | 95% simultaneous interval | Evidence coverage | Unassisted | Valid S / F / U | Unresolved |
|---|---:|---|---:|---:|---|---:|
| m0-e0 | 33.3% | 0.0% to 100.0% | 33.3% | 33.3% | 2 / 0 / 2 | 0 |
| m0-e1 | 16.7% | 0.0% to 100.0% | 33.3% | 16.7% | 1 / 1 / 2 | 0 |
| m1-e0 | 0.0% | 0.0% to 100.0% | 16.7% | 0.0% | 0 / 1 / 3 | 0 |
| m1-e1 | 0.0% | 0.0% to 100.0% | 16.7% | 0.0% | 0 / 1 / 3 | 0 |

## Resource use

| Condition | First input | Peak input | Total input | Capped time (ms) | Population p95 success | Cost per success |
|---|---:|---:|---:|---:|---|---|
| m0-e0 | 3882.33 | 4604.33 | 19957.3 | 127108 | not_reached | unknown |
| m0-e1 | 3641.5 | 4181.33 | 18621.3 | 152076 | not_reached | unknown |
| m1-e0 | 4750.83 | 7698.83 | 28501.2 | 180000 | not_reached | not_reached |
| m1-e1 | 4394.83 | 6529.17 | 27701 | 180000 | not_reached | not_reached |

## Paired comparisons

- m0-e0 versus m0-e1: quality delta 0.166667; input ratio 1.07175; capped-time ratio 0.835816; decision descriptive (no_acceptance_claim).
- m1-e0 versus m1-e1: quality delta 0; input ratio 1.02889; capped-time ratio 1; decision descriptive (no_acceptance_claim).

## Budget, transitions and interactions

Budget curves and their paired differences retain case/repeat rows and cluster intervals. CSV files separate interval bounds, identification bounds and unresolved observations.
All nine transition cells retain observed counts and unresolved assignments separately. Missing paired runs do not become observed unknown samples.

| Interaction | Metric | Estimate | Interval | Unit |
|---|---|---:|---|---|
| gpt62-grok46-environment | quality | 0.166667 | -2 to 2 | ratio_difference |
| gpt62-grok46-environment | time | -24968.4 | -360000 to 360000 | milliseconds |
| gpt62-grok46-environment | cost | unknown | unavailable; Missing or incompatible currency cost | currency |

## Tested mean-cost frontier

Frontier status: not_reached. The frontier minimizes complete fixed-weight mean cost within one environment, task scope and currency after the quality lower-bound requirement. Cost per success separately divides actual valid-run cost by the number of verified successes.
Selecting the smallest observed cost on this report does not establish independent confirmation of that selection.

Quality estimates and thresholds use Q in [0, 1]. The corresponding S_verified percentage and percentage interval are available as score_percent in analysis.json and conditions.csv.

## Interpretation

- Model quality uses verified business success and applicable contracts; unknown earns no success credit.
- Invalid runs and replacements retain their own costs. Missing planned slots prevent complete quality estimates.
- Cluster Hoeffding intervals are conservative and assume independent declared clusters. Repeats do not create new clusters.
- Input ratio inference needs an independently verified preregistered bound; missing bounds never yield noninferiority.
- No reanalysis can create a new model execution, unseen confirmation or a missing model-by-environment cell.
- Population p95 includes the full fixed denominator; fewer than 95% verified successes by the cap is not_reached.
- Identification bounds for unknown outcomes are separate from confidence intervals.
- Currency cost remains unknown without verified route pricing. A configured zero placeholder is not a free model.
- Reanalysis below reads retained evidence and does not submit model requests.

## Reproduce offline

See README.md for the public transformation boundary and original-to-public hash mapping.

Run `node replay.mjs --out /absolute/new-report-directory` with the included Node modules. No package installation or model credentials are needed.
The replay verifies included raw hashes and locators before recomputing analysis. The report manifest identifies every included file.

## Planned units without a valid result

None.
