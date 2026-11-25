# Benchmark report

- Protocol: standing-pilot80-suffix34-run-1-suffix-terra61-8 (a2acd92871bbf21207d00cac6768976717e95cdab65eeed3a49636a21c7d7d7b)
- Analysis: 1.1.0 (a7393ed85c73757af5ceb53d7d517b018df6585cc7bd21f62f8d46083a50585c)
- Planned slots: 8; valid slots: 8; unresolved: 0.
- Actual runs: 8; invalid runs retained: 0; known actual requests: 37.
- Known input subtotal including invalid runs: 163618. This subtotal is not a complete total when usage is missing.

## Quality and evidence

| Condition | Verified quality | 95% simultaneous interval | Evidence coverage | Unassisted | Valid S / F / U | Unresolved |
|---|---:|---|---:|---:|---|---:|
| m0-e0 | 75.0% | 0.0% to 100.0% | 75.0% | 75.0% | 3 / 0 / 1 | 0 |
| m0-e1 | 75.0% | 0.0% to 100.0% | 75.0% | 75.0% | 3 / 0 / 1 | 0 |

## Resource use

| Condition | First input | Peak input | Total input | Capped time (ms) | Population p95 success | Cost per success |
|---|---:|---:|---:|---:|---|---|
| m0-e0 | 4052.75 | 4969.75 | 22129.5 | 68250.8 | not_reached | unknown |
| m0-e1 | 3739.75 | 4430.5 | 18775 | 58645 | not_reached | unknown |

## Paired comparisons

- m0-e0 versus m0-e1: quality delta 0; input ratio 1.17867; capped-time ratio 1.16379; decision descriptive (no_acceptance_claim).

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

None.
