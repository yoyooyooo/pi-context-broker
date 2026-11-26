# Current next baseline: native and Broker references journey

This package records two real model episodes on 2026-11-26 using one frozen current product build and the retained Common16 material. Both arms completed the business task and every critical resource contract. The native arm is a formal pass. The Broker arm remains formally unknown because its extra `bash` call failed with `rg` unavailable (exit 127), leaving arbitrary shell visibility unproved. Its later `read`, `notion_use`, batch resource read and output write completed correctly.

These are observations **230–231**, in a new condition epoch. They are a native/Broker baseline for the current product, separate from the earlier read-description v1 and v2 experiments. There is no pooled effect estimate or claim of statistical superiority or general non-inferiority.

## Observed results

| Arm | Formal outcome | Business | Critical contracts | Model requests | Input tokens | Output tokens | Actual episode duration |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| Native | Pass | Pass | 2/2 pass | 5 | 17,347 | 546 | 22.910 s |
| Broker | Unknown | Pass | 2/2 pass | 6 | 26,699 | 451 | 134.936 s |

Actual accounting is **11 model requests, 44,046 input tokens and 997 output tokens**. The raw measured durations are retained in [physical-accounting.json](physical-accounting.json). The Broker report's **180,000 ms** capped-time statistic is the analysis treatment for an unknown formal outcome. It is not the observed elapsed duration of **134,936.388625 ms**. The Broker time-to-verified-success value remains unknown.

The configured route was `auto/gpt-6.2-sol` with high thinking. Both conditions used `sdk3-latest-next-adoption-1` and collector `1.3.2`; their expected mode, source, native-root and guidance differences were declared before the formal pair. This small descriptive comparison does not identify the causal effect of the earlier 219-byte read-description reduction.

## What the evidence establishes

- [Product runtime correspondence](reviews/product-runtime-correspondence.json) checks 13,114 runtime files against the separately built current product package. The retained build and source identities, rather than a moving branch name, define the measured product.
- [The two startup captures](reviews/capture-review-2.json) made zero model requests. The Broker exposed `path`, `offset`, `limit`, `paths`, `from`, `budget` and `refresh`, with the final 872-byte read description. Its three local candidate operations made zero HTTP requests; two actual list operations supplied catalog evidence. Local candidate snapshots were not treated as authoritative catalogs.
- The Broker collector verified the reviewed metadata producer. The retained resource and ownership evidence has no unmatched reads or unresolved lineage. Positive resource evidence is preserved alongside the shell-related formal unknown.
- [The prospective decision policy](reviews/product-decision-policy.json) separates positive critical-contract evidence from full formal success. Ordinary-profile compatibility and verified Pro, Mini and imile-win deliveries remain separate adoption requirements documented by the project.

The first configuration attempt completed both zero-send captures but stopped when the protocol declaration omitted four native/Broker differences. Its [declaration-repair record](reviews/attempt-1-declaration-repair.json) preserves the failed preflight and the corrected prospective declaration. It created no formal observation, standing reservation or model request. No historical experiment was rerun for that repair.

## Public evidence and replay

[package/](package/) contains the normalized public input, analysis, raw evidence projections, manifest, report, tables, charts and exact offline replay modules. The exporter verifies original hashes before projection and preserves all outcomes, unknown values, measured numbers and fixed denominators. [lineage.json](lineage.json) binds the original and public analysis identities. [review-source-map.json](review-source-map.json) binds each additional public proof projection to its retained original receipt SHA256.

Run from the repository root:

```sh
node benchmark/results/2026-11-26-latest-next-adoption/package/replay.mjs
```

The replay verifies public files and normalized evidence references, then recomputes the analysis. It does not call a model or rerun the private business grader. Redacted public files do not claim to reconstruct the original private transport hash chains. [Independent replay](reviews/independent-review.json) passed in a credential-free macOS sandbox that denied network access, private-original reads and public-copy writes. All three restrictions were tested with actual probes and returned `EPERM`. All 232 package files remained unchanged. The 11 provider bindings and reported-model labels matched the retained originals, and all 10 deliberately invalid binding variants were rejected. [Independent resource review](reviews/independent-resource-trace-review.json) checked the four delivered source resources and business output while preserving the Broker formal unknown.

## Accounting and history

The physical standing ledger now contains **231 observations and 30 registrations**. With this package, the public unique observation set is **1–219 and 221–231: 230 observations**. Observation 220 remains in its retained private ledger. Reanalysis copies do not add observations.

The [earlier SDK3 read-description cycle](../2026-11-26-sdk3-read-description-cycle) retains invalid apparatus observation 221, the original v1 analysis, its report-only reanalysis, and the separate v2 pair. Those packages remain unchanged. This package adds only the current native/Broker pair and its own proof records.
