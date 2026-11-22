# Blocked Benchmark pilot — 2026-11-22

This release was regenerated from retained private originals with publication version 1.0.1 after an earlier staged export was withdrawn for terminal-owner identity leakage. Whole-token username redaction preserves longer public identifiers. This release records an incomplete pilot. The route gate did not pass. No model, environment, quality, efficiency or release-acceptance conclusion is supported.

## Read the results

- `accounting.json` separates the current 24-slot plan from the shared reservation ledger.
- `current-plan/` contains both recorded current-plan episodes and all raw copies required for their public replay.
- `retained-invalid/` preserves the earlier zero-send invalid episode under its own plan.
- `reservations/` preserves the three exact shared reservation receipts. These contain public run/slot identities and timestamps, not credentials.
- `material-parity-summary.json` describes the separately verified 16-candidate, 31-file, 10-family material library. It records zero model calls.
- `auth-blocker.json` records the observed authorization error and the limits of service-log correlation.
- `release-manifest.json` identifies every file and the two complete subpackages.

## Observed accounting

The current plan has 24 planned slots, 2 recorded episodes, 1 valid episode with unknown verified outcome, 1 invalid episode, and 22 missing slots. There are 23 slots without a valid result.

Across the shared ledger, 3 episodes were reserved and 2 sent model requests. There were 5 actual model HTTP requests. The known input subtotal is 23,621 tokens and the known output subtotal is 769 tokens. Complete input, complete output and monetary cost remain unknown. The measured episode durations sum to 31,775.285541 ms; this is a sum of recorded episode durations, not the elapsed time of the engineering project.

One valid episode passed the independent output-artifact contract, but its no-Skill selection contract remained unknown. It receives no verified success credit. The authorization-blocked episode is invalid because sent-request usage is missing; it is excluded from the valid quality denominator.

The earlier admission-invalid record is retained separately. It is not a replacement, a new current-plan result, or a business success. The source and reanalyzed versions of the completed episode describe the same four requests and are counted once.

## Replay

Run `node replay.mjs` from any directory with a Node runtime supporting JSON import attributes. This release was verified with Node 26.13.1. No dependencies, credentials, remote services or model requests are needed.

The top-level replay verifies all release hashes, runs both independent subpackage replays, then recomputes the shared accounting from the public normalized episodes and reservation receipts.

Public replay checks transformed hashes and source locators and reaggregates normalized observations. It does not rerun private grading, reconstruct the original pre-redaction hash chains, requery Notion, or reperform remote material parity. Each subpackage manifest records original-to-public hashes and the redaction boundary. The material summary is a derived projection of a retained private proof; its private provider identities and control paths are omitted.

## Remaining work

The first-24 route gate, six-cell route coverage, full ten-family model campaign, held-out confirmation, self-version comparisons, catalog scaling and a real controlled CodeMode comparison are incomplete. The real sends in this release used only one no-Skill case in the native environment. Local apparatus or loopback tests and material preparation are not model-quality results.

The observed external blocker is Cline OAuth token refresh returning HTTP 400 with `invalid_grant`. The operator must restore the Cline authorization in the local CLIProxyAPI management console. Restoring authorization does not establish the missing historical token use, authorize replaying an existing paid request, or pass the frozen route gate. This frozen gate remains unpassed. Any future execution requires a new frozen continuation policy that retains the invalid records and their costs; it must not directly resume the old plan or skip the Flash route.

The shared maximum remains 144 scheduled episodes, including invalid records and replacements. The first 24 remain a shared prefix across plans. This release authorizes no additional execution.
