# Benchmark report

- Protocol: standing-pilot80-run-1-four-auto-business-pilot80 (756d5d502f3e6fd7ca4785929690eda905232c237b4677af5ce0cde9036ffefb)
- Analysis: 1.1.0 (3a6eb9289baffff20fb58d21538ef225630956bd74d7f94e5deb1d8d32219fd0)
- Planned slots: 80; valid slots: 45; unresolved: 35.
- Actual runs: 46; invalid runs retained: 1; known actual requests: 250.
- Known input subtotal including invalid runs: 1443395. This subtotal is not a complete total when usage is missing.

## Quality and evidence

| Condition | Verified quality | 95% simultaneous interval | Evidence coverage | Unassisted | Valid S / F / U | Unresolved |
|---|---:|---|---:|---:|---|---:|
| m0-e0 | unknown | unavailable | unknown | unknown | 1 / 1 / 2 | 6 |
| m0-e1 | unknown | unavailable | unknown | unknown | 1 / 0 / 3 | 6 |
| m1-e0 | unknown | unavailable | unknown | unknown | 2 / 2 / 2 | 4 |
| m1-e1 | unknown | unavailable | unknown | unknown | 0 / 1 / 4 | 5 |
| m2-e0 | unknown | unavailable | unknown | unknown | 3 / 1 / 3 | 3 |
| m2-e1 | unknown | unavailable | unknown | unknown | 2 / 2 / 3 | 3 |
| m3-e0 | unknown | unavailable | unknown | unknown | 5 / 0 / 1 | 4 |
| m3-e1 | unknown | unavailable | unknown | unknown | 5 / 0 / 1 | 4 |

## Resource use

| Condition | First input | Peak input | Total input | Capped time (ms) | Population p95 success | Cost per success |
|---|---:|---:|---:|---:|---|---|
| m0-e0 | unknown | unknown | unknown | unknown | unknown | unknown |
| m0-e1 | unknown | unknown | unknown | unknown | unknown | unknown |
| m1-e0 | unknown | unknown | unknown | unknown | unknown | unknown |
| m1-e1 | unknown | unknown | unknown | unknown | unknown | not_reached |
| m2-e0 | unknown | unknown | unknown | unknown | unknown | unknown |
| m2-e1 | unknown | unknown | unknown | unknown | unknown | unknown |
| m3-e0 | unknown | unknown | unknown | unknown | unknown | unknown |
| m3-e1 | unknown | unknown | unknown | unknown | unknown | unknown |

## Paired comparisons

- m0-e0 versus m0-e1: quality delta unknown; input ratio unknown; capped-time ratio unknown; decision rejected (critical_contracts).
- m1-e0 versus m1-e1: quality delta unknown; input ratio unknown; capped-time ratio unknown; decision rejected (critical_contracts).
- m2-e0 versus m2-e1: quality delta unknown; input ratio unknown; capped-time ratio unknown; decision rejected (critical_contracts).
- m3-e0 versus m3-e1: quality delta unknown; input ratio unknown; capped-time ratio unknown; decision descriptive (no_acceptance_claim).

## Budget, transitions and interactions

Budget curves and their paired differences retain case/repeat rows and cluster intervals. CSV files separate interval bounds, identification bounds and unresolved observations.
All nine transition cells retain observed counts and unresolved assignments separately. Missing paired runs do not become observed unknown samples.

| Interaction | Metric | Estimate | Interval | Unit |
|---|---|---:|---|---|
| model-0-1 | quality | unknown | unavailable; Incomplete matched four-cell observations | ratio_difference |
| model-0-1 | time | unknown | unavailable; Incomplete matched four-cell observations | milliseconds |
| model-0-1 | cost | unknown | unavailable; Missing or incompatible currency cost | currency |
| model-0-2 | quality | unknown | unavailable; Incomplete matched four-cell observations | ratio_difference |
| model-0-2 | time | unknown | unavailable; Incomplete matched four-cell observations | milliseconds |
| model-0-2 | cost | unknown | unavailable; Missing or incompatible currency cost | currency |
| model-0-3 | quality | unknown | unavailable; Incomplete matched four-cell observations | ratio_difference |
| model-0-3 | time | unknown | unavailable; Incomplete matched four-cell observations | milliseconds |
| model-0-3 | cost | unknown | unavailable; Missing or incompatible currency cost | currency |
| model-1-2 | quality | unknown | unavailable; Incomplete matched four-cell observations | ratio_difference |
| model-1-2 | time | unknown | unavailable; Incomplete matched four-cell observations | milliseconds |
| model-1-2 | cost | unknown | unavailable; Missing or incompatible currency cost | currency |
| model-1-3 | quality | unknown | unavailable; Incomplete matched four-cell observations | ratio_difference |
| model-1-3 | time | unknown | unavailable; Incomplete matched four-cell observations | milliseconds |
| model-1-3 | cost | unknown | unavailable; Missing or incompatible currency cost | currency |
| model-2-3 | quality | unknown | unavailable; Incomplete matched four-cell observations | ratio_difference |
| model-2-3 | time | unknown | unavailable; Incomplete matched four-cell observations | milliseconds |
| model-2-3 | cost | unknown | unavailable; Missing or incompatible currency cost | currency |

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

- m0-no-skill-01-a-n16-r1-r0/m0-e0: unresolved; No valid execution
- m0-no-skill-01-a-n16-r1-r0/m0-e1: unresolved; No valid execution
- m0-explicit-01-a-n16-r1-r0/m0-e0: unresolved; No valid execution
- m0-explicit-01-a-n16-r1-r0/m0-e1: unresolved; No valid execution
- m0-implicit-01-a-n16-r1-r0/m0-e0: unresolved; No valid execution
- m0-implicit-01-a-n16-r1-r0/m0-e1: unresolved; No valid execution
- m0-ambiguity-01-a-n16-r1-r0/m0-e0: unresolved; No valid execution
- m0-ambiguity-01-a-n16-r1-r0/m0-e1: unresolved; No valid execution
- m0-equivalent-01-a-n16-r1-r0/m0-e0: unresolved; No valid execution
- m0-equivalent-01-a-n16-r1-r0/m0-e1: unresolved; No valid execution
- m0-continuation-01-a-n16-r2-r0/m0-e0: unresolved; No valid execution
- m0-continuation-01-a-n16-r2-r0/m0-e1: unresolved; No valid execution
- m1-explicit-01-a-n16-r1-r0/m1-e0: unresolved; No valid execution
- m1-explicit-01-a-n16-r1-r0/m1-e1: unresolved; No valid execution
- m1-equivalent-01-a-n16-r1-r0/m1-e0: unresolved; No valid execution
- m1-equivalent-01-a-n16-r1-r0/m1-e1: unresolved; No valid execution
- m1-references-01-a-n16-r1-r0/m1-e0: unresolved; No valid execution
- m1-references-01-a-n16-r1-r0/m1-e1: unresolved; No valid execution
- m1-scripts-assets-01-a-n16-r1-r0/m1-e0: unresolved; No valid execution
- m1-scripts-assets-01-a-n16-r1-r0/m1-e1: unresolved; No valid execution
- m1-task-switch-01-a-n16-r2-r0/m1-e1: unresolved; No valid execution
- m2-no-skill-01-a-n16-r1-r0/m2-e0: unresolved; No valid execution
- m2-no-skill-01-a-n16-r1-r0/m2-e1: unresolved; No valid execution
- m2-equivalent-01-a-n16-r1-r0/m2-e0: unresolved; No valid execution
- m2-equivalent-01-a-n16-r1-r0/m2-e1: unresolved; No valid execution
- m2-complementary-01-a-n16-r1-r0/m2-e0: unresolved; No valid execution
- m2-complementary-01-a-n16-r1-r0/m2-e1: unresolved; No valid execution
- m3-no-skill-01-a-n16-r1-r0/m3-e0: unresolved; No valid execution
- m3-no-skill-01-a-n16-r1-r0/m3-e1: unresolved; No valid execution
- m3-explicit-01-a-n16-r1-r0/m3-e0: unresolved; No valid execution
- m3-explicit-01-a-n16-r1-r0/m3-e1: unresolved; No valid execution
- m3-scripts-assets-01-a-n16-r1-r0/m3-e0: unresolved; No valid execution
- m3-scripts-assets-01-a-n16-r1-r0/m3-e1: unresolved; No valid execution
- m3-task-switch-01-a-n16-r2-r0/m3-e0: unresolved; No valid execution
- m3-task-switch-01-a-n16-r2-r0/m3-e1: unresolved; No valid execution
