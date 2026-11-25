# Benchmark report

- Protocol: standing42-run-2-codemode-24 (6333106ba44f400bb314368f3bfc68fb42a80bd0eb14f98d701e8bfc029f61f2)
- Analysis: 1.1.0 (6c4c44ad88169016fa3544fba73c9343d73f3926f46f9734ce35249fb4ddaa20)
- Planned slots: 24; valid slots: 24; unresolved: 0.
- Actual runs: 24; invalid runs retained: 0; known actual requests: 116.
- Known input subtotal including invalid runs: 482420. This subtotal is not a complete total when usage is missing.

## Quality and evidence

| Condition | Verified quality | 95% simultaneous interval | Evidence coverage | Unassisted | Valid S / F / U | Unresolved |
|---|---:|---|---:|---:|---|---:|
| m0-e0 | 0.0% | 0.0% to 81.9% | 16.7% | 0.0% | 0 / 1 / 5 | 0 |
| m0-e1 | 66.7% | 0.0% to 100.0% | 66.7% | 66.7% | 4 / 0 / 2 | 0 |
| m0-e2 | 100.0% | 18.1% to 100.0% | 100.0% | 100.0% | 6 / 0 / 0 | 0 |
| m0-e3 | 100.0% | 18.1% to 100.0% | 100.0% | 100.0% | 6 / 0 / 0 | 0 |

## Resource use

| Condition | First input | Peak input | Total input | Capped time (ms) | Population p95 success | Cost per success |
|---|---:|---:|---:|---:|---|---|
| m0-e0 | 4028 | 5023.17 | 21613 | 180000 | not_reached | not_reached |
| m0-e1 | 3605.67 | 4563.5 | 20974.7 | 72379.8 | not_reached | unknown |
| m0-e2 | 3572 | 4495.33 | 20074 | 36949.6 | 43208.9 ms | unknown |
| m0-e3 | 3149.67 | 4001.83 | 17741.7 | 23598.8 | 28551.8 ms | unknown |

## Paired comparisons

- m0-e0 versus m0-e1: quality delta -0.666667; input ratio 1.03043; capped-time ratio 2.48688; decision rejected (critical_contracts).
- m0-e2 versus m0-e3: quality delta 0; input ratio 1.13146; capped-time ratio 1.56574; decision descriptive (no_acceptance_claim).

## Budget, transitions and interactions

Budget curves and their paired differences retain case/repeat rows and cluster intervals. CSV files separate interval bounds, identification bounds and unresolved observations.
All nine transition cells retain observed counts and unresolved assignments separately. Missing paired runs do not become observed unknown samples.

| Interaction | Metric | Estimate | Interval | Unit |
|---|---|---:|---|---|
| gpt62-candidate-native-free-off | quality | -0.666667 | -2 to 2 | ratio_difference |
| gpt62-candidate-native-free-off | time | 94269.4 | -360000 to 360000 | milliseconds |
| gpt62-candidate-native-free-off | cost | unknown | unavailable; Missing or incompatible currency cost | currency |

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
