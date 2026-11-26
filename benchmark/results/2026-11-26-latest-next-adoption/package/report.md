# Benchmark report

- Protocol: latest-next-native-broker-pair-2 (d85e72c77562afc719bf95ae7bee67b879f0f6de74d66466c4f441d6215b5f28)
- Analysis: 1.1.0 (f3297ce44714fe6af3ccb3335e58289dc0bdadec2b052677d18f7cb29b5c9ba3)
- Planned slots: 2; valid slots: 2; unresolved: 0.
- Actual runs: 2; invalid runs retained: 0; known actual requests: 11.
- Known input subtotal including invalid runs: 44046. This subtotal is not a complete total when usage is missing.

## Quality and evidence

| Condition | Verified quality | 95% simultaneous interval | Evidence coverage | Unassisted | Valid S / F / U | Unresolved |
|---|---:|---|---:|---:|---|---:|
| m0-e0 | 100.0% | 0.0% to 100.0% | 100.0% | 100.0% | 1 / 0 / 0 | 0 |
| m0-e1 | 0.0% | 0.0% to 100.0% | 0.0% | 0.0% | 0 / 0 / 1 | 0 |

## Resource use

| Condition | First input | Peak input | Total input | Capped time (ms) | Population p95 success | Cost per success |
|---|---:|---:|---:|---:|---|---|
| m0-e0 | 2988 | 3838 | 17347 | 22897.3 | 22897.3 ms | unknown |
| m0-e1 | 2853 | 5138 | 26699 | 180000 | not_reached | not_reached |

## Paired comparisons

- m0-e0 versus m0-e1: quality delta 1; input ratio 0.649725; capped-time ratio 0.127207; decision descriptive (no_acceptance_claim).

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
