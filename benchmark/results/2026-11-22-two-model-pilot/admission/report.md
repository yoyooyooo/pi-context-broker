# Benchmark report

- Protocol: benchmark-two-model-admission-3 (708308d1424cc2b0e55bb3c7120f912550f14fe788c44bc661e0c872a4ed1040)
- Analysis: 1.1.0 (7d7996a7cfee6c75ca44745cc689737403ecae353df20d8e882616d27928f3f6)
- Planned slots: 16; valid slots: 7; unresolved: 9.
- Actual runs: 8; invalid runs retained: 1; known actual requests: 33.
- Known input subtotal including invalid runs: 148375. This subtotal is not a complete total when usage is missing.

## Quality and evidence

| Condition | Verified quality | 95% simultaneous interval | Evidence coverage | Unassisted | Valid S / F / U | Unresolved |
|---|---:|---|---:|---:|---|---:|
| m0-e0 | unknown | unavailable | unknown | unknown | 2 / 0 / 1 | 1 |
| m0-e1 | unknown | unavailable | unknown | unknown | 2 / 1 / 0 | 1 |
| m1-e0 | unknown | unavailable | unknown | unknown | 0 / 0 / 0 | 4 |
| m1-e1 | unknown | unavailable | unknown | unknown | 0 / 1 / 0 | 3 |

## Resource use

| Condition | First input | Peak input | Total input | Capped time (ms) | Population p95 success | Cost per success |
|---|---:|---:|---:|---:|---|---|
| m0-e0 | unknown | unknown | unknown | unknown | unknown | unknown |
| m0-e1 | unknown | unknown | unknown | unknown | unknown | unknown |
| m1-e0 | unknown | unknown | unknown | unknown | unknown | unknown |
| m1-e1 | unknown | unknown | unknown | unknown | unknown | not_reached |

## Paired comparisons

- m0-e0 versus m0-e1: quality delta unknown; input ratio unknown; capped-time ratio unknown; decision descriptive (no_acceptance_claim).
- m1-e0 versus m1-e1: quality delta unknown; input ratio unknown; capped-time ratio unknown; decision descriptive (no_acceptance_claim).

## Budget, transitions and interactions

Budget curves and their paired differences retain case/repeat rows and cluster intervals. CSV files separate interval bounds, identification bounds and unresolved observations.
All nine transition cells retain observed counts and unresolved assignments separately. Missing paired runs do not become observed unknown samples.

| Interaction | Metric | Estimate | Interval | Unit |
|---|---|---:|---|---|
| m0-e0--m1-e0 | quality | unknown | unavailable; Incomplete matched four-cell observations | ratio_difference |
| m0-e0--m1-e0 | time | unknown | unavailable; Incomplete matched four-cell observations | milliseconds |
| m0-e0--m1-e0 | cost | unknown | unavailable; Missing or incompatible currency cost | currency |

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

- m0-explicit-01-a-n16-r1-r0/m0-e0: unresolved; No valid execution
- m0-explicit-01-a-n16-r1-r0/m0-e1: unresolved; No valid execution
- m1-no-skill-01-a-n16-r1-r0/m1-e0: unresolved; No valid execution
- m1-no-skill-02-a-n16-r1-r0/m1-e0: unresolved; No valid execution
- m1-no-skill-02-a-n16-r1-r0/m1-e1: unresolved; No valid execution
- m1-no-skill-03-a-n16-r1-r0/m1-e0: unresolved; No valid execution
- m1-no-skill-03-a-n16-r1-r0/m1-e1: unresolved; No valid execution
- m1-explicit-01-a-n16-r1-r0/m1-e0: unresolved; No valid execution
- m1-explicit-01-a-n16-r1-r0/m1-e1: unresolved; No valid execution
