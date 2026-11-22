# Benchmark report

- Protocol: benchmark-route-gate-1 (8b90f0718042abffa82b1dce69d53dbc5b0b59998c1bd2061cf13d3db651a3d8)
- Analysis: 1.0.0 (0e06e34ca9ecf989ce42d24314ac49971490ff529c3d68ec269293746279c048)
- Planned slots: 24; valid slots: 0; unresolved: 24.
- Actual runs: 1; invalid runs retained: 1; known actual requests: 0.
- Known input subtotal including invalid runs: 0. This subtotal is not a complete total when usage is missing.

## Quality and evidence

| Condition | Verified quality | 95% simultaneous interval | Evidence coverage | Unassisted | Valid S / F / U | Unresolved |
|---|---:|---|---:|---:|---|---:|
| m0-e0 | unknown | unavailable | unknown | unknown | 0 / 0 / 0 | 4 |
| m0-e1 | unknown | unavailable | unknown | unknown | 0 / 0 / 0 | 4 |
| m1-e0 | unknown | unavailable | unknown | unknown | 0 / 0 / 0 | 4 |
| m1-e1 | unknown | unavailable | unknown | unknown | 0 / 0 / 0 | 4 |
| m2-e0 | unknown | unavailable | unknown | unknown | 0 / 0 / 0 | 4 |
| m2-e1 | unknown | unavailable | unknown | unknown | 0 / 0 / 0 | 4 |

## Resource use

| Condition | First input | Peak input | Total input | Capped time (ms) | Population p95 success | Cost per success |
|---|---:|---:|---:|---:|---|---|
| m0-e0 | unknown | unknown | unknown | unknown | unknown | unknown |
| m0-e1 | unknown | unknown | unknown | unknown | unknown | unknown |
| m1-e0 | unknown | unknown | unknown | unknown | unknown | unknown |
| m1-e1 | unknown | unknown | unknown | unknown | unknown | unknown |
| m2-e0 | unknown | unknown | unknown | unknown | unknown | unknown |
| m2-e1 | unknown | unknown | unknown | unknown | unknown | unknown |

## Paired comparisons

- m0-e0 versus m0-e1: quality delta unknown; input ratio unknown; capped-time ratio unknown; decision descriptive (no_acceptance_claim).
- m1-e0 versus m1-e1: quality delta unknown; input ratio unknown; capped-time ratio unknown; decision descriptive (no_acceptance_claim).
- m2-e0 versus m2-e1: quality delta unknown; input ratio unknown; capped-time ratio unknown; decision descriptive (no_acceptance_claim).

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
- m0-no-skill-02-a-n16-r1-r0/m0-e0: unresolved; No valid execution
- m0-no-skill-02-a-n16-r1-r0/m0-e1: unresolved; No valid execution
- m0-no-skill-03-a-n16-r1-r0/m0-e0: unresolved; No valid execution
- m0-no-skill-03-a-n16-r1-r0/m0-e1: unresolved; No valid execution
- m0-explicit-01-a-n16-r1-r0/m0-e0: unresolved; No valid execution
- m0-explicit-01-a-n16-r1-r0/m0-e1: unresolved; No valid execution
- m1-no-skill-01-a-n16-r1-r0/m1-e0: unresolved; No valid execution
- m1-no-skill-01-a-n16-r1-r0/m1-e1: unresolved; No valid execution
- m1-no-skill-02-a-n16-r1-r0/m1-e0: unresolved; No valid execution
- m1-no-skill-02-a-n16-r1-r0/m1-e1: unresolved; No valid execution
- m1-no-skill-03-a-n16-r1-r0/m1-e0: unresolved; No valid execution
- m1-no-skill-03-a-n16-r1-r0/m1-e1: unresolved; No valid execution
- m1-explicit-01-a-n16-r1-r0/m1-e0: unresolved; No valid execution
- m1-explicit-01-a-n16-r1-r0/m1-e1: unresolved; No valid execution
- m2-no-skill-01-a-n16-r1-r0/m2-e0: unresolved; No valid execution
- m2-no-skill-01-a-n16-r1-r0/m2-e1: unresolved; No valid execution
- m2-no-skill-02-a-n16-r1-r0/m2-e0: unresolved; No valid execution
- m2-no-skill-02-a-n16-r1-r0/m2-e1: unresolved; No valid execution
- m2-no-skill-03-a-n16-r1-r0/m2-e0: unresolved; No valid execution
- m2-no-skill-03-a-n16-r1-r0/m2-e1: unresolved; No valid execution
- m2-explicit-01-a-n16-r1-r0/m2-e0: unresolved; No valid execution
- m2-explicit-01-a-n16-r1-r0/m2-e1: unresolved; No valid execution
