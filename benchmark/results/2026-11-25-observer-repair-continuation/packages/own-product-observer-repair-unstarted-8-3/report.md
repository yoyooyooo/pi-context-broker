# Benchmark report

- Protocol: benchmark-own-product-observer-repair-unstarted-8-3 (47abc61946824a6c0725cef1c53057f2db7360e10a3a4afc79a28e044f4eee18)
- Analysis: 1.1.0 (9c3d7e61c01cb9ae940ce4e94c7caeaa32459890564bbc8307798b73214f298e)
- Planned slots: 20; valid slots: 8; unresolved: 12.
- Actual runs: 8; invalid runs retained: 0; known actual requests: 35.
- Known input subtotal including invalid runs: 157460. This subtotal is not a complete total when usage is missing.

## Quality and evidence

| Condition | Verified quality | 95% simultaneous interval | Evidence coverage | Unassisted | Valid S / F / U | Unresolved |
|---|---:|---|---:|---:|---|---:|
| m0-e0 | unknown | unavailable | unknown | unknown | 1 / 0 / 3 | 6 |
| m0-e1 | unknown | unavailable | unknown | unknown | 1 / 0 / 3 | 6 |

## Resource use

| Condition | First input | Peak input | Total input | Capped time (ms) | Population p95 success | Cost per success |
|---|---:|---:|---:|---:|---|---|
| m0-e0 | unknown | unknown | unknown | unknown | unknown | unknown |
| m0-e1 | unknown | unknown | unknown | unknown | unknown | unknown |

## Paired comparisons

- m0-e1 versus m0-e0: quality delta unknown; input ratio unknown; capped-time ratio unknown; decision inconclusive (quality).

## Budget, transitions and interactions

Budget curves and their paired differences retain case/repeat rows and cluster intervals. CSV files separate interval bounds, identification bounds and unresolved observations.
All nine transition cells retain observed counts and unresolved assignments separately. Missing paired runs do not become observed unknown samples.

| Interaction | Metric | Estimate | Interval | Unit |
|---|---|---:|---|---|

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

- m0-explicit-01-a-n16-r1-r0/m0-e1: unresolved; No valid execution
- m0-explicit-01-a-n16-r1-r0/m0-e0: unresolved; No valid execution
- m0-equivalent-01-a-n16-r1-r0/m0-e1: unresolved; No valid execution
- m0-equivalent-01-a-n16-r1-r0/m0-e0: unresolved; No valid execution
- m0-references-01-a-n16-r1-r0/m0-e1: unresolved; No valid execution
- m0-references-01-a-n16-r1-r0/m0-e0: unresolved; No valid execution
- m0-complementary-01-a-n16-r1-r0/m0-e1: unresolved; No valid execution
- m0-complementary-01-a-n16-r1-r0/m0-e0: unresolved; No valid execution
- m0-continuation-01-a-n16-r2-r0/m0-e1: unresolved; No valid execution
- m0-continuation-01-a-n16-r2-r0/m0-e0: unresolved; No valid execution
- m0-task-switch-01-a-n16-r2-r0/m0-e1: unresolved; No valid execution
- m0-task-switch-01-a-n16-r2-r0/m0-e0: unresolved; No valid execution
