# Two-model Benchmark continuation — 2026-11-22

**Status: the 16-episode route gate completed; the 32-episode expansion stopped after 21 recorded episodes when an upstream HTTP 500 left token usage unknown. The current scope has 37 recorded episodes, 36 valid results, one invalid result and 11 unstarted slots. Further model dispatch remains stopped.**

The report date uses America/Los_Angeles. Machine receipts use UTC; this continuation closed on 2026-11-23 UTC. All execution and retained private evidence remain on Mini. The provider alias containing `imile-win` names an existing gateway route; it does not name the execution host.

The [public package](../benchmark/results/2026-11-22-two-model-continuation/README.md) contains the two current reports, their redacted replay inputs, the campaign accounting and a fixed reference to the [earlier pilot](benchmark-two-model-pilot-2026-11-22.md). It does not establish a model ranking, environment acceptance or completion of the full Benchmark project.

## Execution scope and denominators

| Scope | Frozen slots | Recorded episodes | Valid | Invalid | Unstarted |
|---|---:|---:|---:|---:|---:|
| Current route gate | 16 | 16 | 16 | 0 | 0 |
| Current expansion | 32 | 21 | 20 | 1 | 11 |
| Current continuation | 48 | 37 | 36 | 1 | 11 |

The shared campaign contains **50 physical reservations: 13 historical and 37 current**, with four scope registrations. All 37 current starts have completed records. Execution has zero started-but-unresolved episodes. The expansion analysis has **12 planned slots without a valid result: one invalid execution plus 11 unstarted slots**. These are different measures; a closed execution ledger does not make the fixed statistical plan complete.

Gate and expansion remain separate pilot analyses with purpose `model_environment_interaction`. Their different task families and weights are retained. This report does not pool them into a new overall success percentage or shrink the 48-slot denominator to the observed sample.

### Models and environment identities

| Model | Frozen Pi route | API | This release |
|---|---|---|---|
| GPT-6.2 Sol | `magpie/imile-win-gpt/gpt-6.2-sol` | OpenAI Completions | Real Broker/native observations |
| Grok-4.6 | `magpie/grok/grok-4.6` | OpenAI Responses | Real Broker/native observations |
| Grok-4.7 auto | `magpie/auto/grok-4.7` | OpenAI Responses | Future intent only; no new scope or model request |
| GPT-6.1 Terra auto | `magpie/auto/gpt-6.1-terra` | OpenAI Completions | Future intent only; no new scope or model request |

The corrected Terra route group is **`auto-gpt-6-1-terra`**. Flash remains deferred. Route labels describe configured and observed aliases; they do not attest a hidden provider backend or verified currency pricing.

The real current subjects used frozen build2: Broker source `c440b62fbe317198ba6ef3e8be94ae90a8264695`, CLI source `5bab9feabc3f78008759166278f490934ffa0ab3`, Pi 1.6.0 and Node 26.13.1. Gate-001 began under the original build2 controller. The registered same-raw collection recovery and subsequent continuation used frozen build3, Broker source `d393b5570cac987999c9e57ce80a74a90b00e7c6`. Later controller and matcher changes were not substituted into these runs or their scores.

## What the recorded results support

### Completed gate

The [gate report](../benchmark/results/2026-11-22-two-model-continuation/cohort-3-gate/report.md) contains 16 valid executions. Necessary-contract grading yields three verified successes, three failures and ten unknown outcomes.

| Condition | Verified success / failure / unknown | Fixed-weight verified quality | Simultaneous 95% interval |
|---|---:|---:|---|
| GPT-6.2 Sol, Broker | 2 / 0 / 2 | 33.3% | 0%–100% |
| GPT-6.2 Sol, native Pi | 1 / 1 / 2 | 16.7% | 0%–100% |
| Grok-4.6, Broker | 0 / 1 / 3 | 0.0% | 0%–100% |
| Grok-4.6, native Pi | 0 / 1 / 3 | 0.0% | 0%–100% |

These are the preregistered family-weighted values, not the unweighted success counts divided by four. The no-Skill family carries half of the weight across three cases; the explicit-Skill family carries the other half. Unknown outcomes receive no verified-success credit. The broad intervals and the descriptive decision do not support superiority or noninferiority.

Business-output-only diagnostics found 14 passes and two failures. That diagnostic does not replace the necessary-contract score: a correct business answer can still violate Skill-selection rules or lack sufficient resource-consumption evidence. Two gate runs also reached declared budget boundaries: gate-006 reached the request limit and retained a failure; gate-012 reached the input preflight limit, passed the business check and retained an unknown necessary-contract outcome.

### Stopped expansion

The [expansion report](../benchmark/results/2026-11-22-two-model-continuation/cohort-3-expansion/report.md) retains all 21 executions and the 32-slot design. Among the 20 valid executions, necessary-contract grading gives two verified successes, two failures and 16 unknown outcomes. The remaining execution is invalid because of the upstream failure and unknown usage.

| Condition | Valid success / failure / unknown | Slots without a valid result | Fixed-plan quality |
|---|---:|---:|---|
| GPT-6.2 Sol, Broker | 0 / 0 / 4 | 4, including one invalid run | Unknown |
| GPT-6.2 Sol, native Pi | 0 / 0 / 4 | 4 | Unknown |
| Grok-4.6, Broker | 2 / 1 / 3 | 2 | Unknown |
| Grok-4.6, native Pi | 0 / 1 / 5 | 2 | Unknown |

The incomplete cells retain `null` estimates. The Grok comparison additionally retains the frozen scorer's `rejected / critical_contracts` decision for the `business-quote` failure in expansion-001. The full paired quality and resource differences remain unknown; this rejection is not evidence of a general model ranking.

Two limitations materially affect interpretation:

- In expansion-001 and -002, Grok did ask the user to specify a choice. The frozen clarification matcher did not recognize the observed Chinese requests without a question mark, so it did not supply the scripted clarification. A matcher fix and focused tests exist for future scopes. The original runs were neither resent nor rescored under the new matcher.
- Existing evidence can show an exact resource read crossing child output into the next provider payload, but it does not establish a complete census of every Code Mode execution path, host global, store access or arbitrary shell operation. Those necessary-contract unknowns remain unknown. Business-only diagnostics are labeled separately.

## Why execution stopped

Expansion-021 was GPT-6.2 Sol with Broker on the scripts/assets case. The retained client evidence contains **one SDK request and one sent HTTP attempt**, with zero client retries. The outer streaming response was HTTP 200, but the provider error reported HTTP 500 / `INTERNAL_ERROR` while validating an API key. This is an upstream validation failure, not proof that the credential itself was invalid.

The model response had no usable token-usage receipt. The runtime recorded `BENCHMARK_USAGE_UNKNOWN`, an invalid episode and `stop_batch: true`. It closed the batch before the next slot. A read-only gateway lookup matched the same request identifier and upstream failure. Its CSV listed seven internal attempts and zero-valued token columns, without an actual usage receipt or served-model identifier. Gateway attempts are distinct from caller sends; these counts are not added together. The zero-valued CSV fields do not establish zero consumption.

The original three historical usage-unknown runs remain retained. Expansion-021 is a fourth unknown and is outside the historical exception. The finite-campaign controller rejects treating a new unknown or a new core stop as exempt history. No replacement run, new model scope or acceptance scope was dispatched after this stop.

### Request and token accounting

| Population | Observed caller requests | Known input subtotal | Known output subtotal | Unknown-usage episodes |
|---|---:|---:|---:|---:|
| Historical 13 reservations | At least 39 | 171,996 | 4,139 | 3 |
| Current gate, 16 episodes | 76 | 394,855 | 11,900 | 0 |
| Current expansion, 21 episodes | 117 | 608,999 | 18,980 | 1 |
| Current continuation, 37 episodes | 193 | 1,003,854 | 30,880 | 1 |
| Entire 50-reservation campaign | At least 232 | 1,175,850 | 35,019 | 4 |

Current caller-request counts are known; current complete token totals are unknown. Campaign request and token totals remain incomplete because of retained historical unknowns. Known subtotals are lower bounds, not complete totals. Currency cost remains unknown without verified route pricing. Preparation, review and other auxiliary agent costs were not observed as subject-run usage and are not asserted to be zero.

The [accounting projection](../benchmark/results/2026-11-22-two-model-continuation/accounting.json) preserves historical failures, all current results, registrations and future coverage intent. The original route intent and the revised finite-budget proposal are separate sources. Planned Grok/Terra and acceptance work is not counted as execution.

## Recovery, replay and provenance

Gate-001 initially failed collection because a material-proof path belonged to another environment. Its original model execution was preserved. An explicit collection-repair registration allowed collecting the same raw result under the correct ownership. Recovery issued zero model requests and created zero new reservations. The old unresolved event remains in the ledger, and the single physical run is counted once.

Private gate and expansion analyses were recomputed with OS-level network access denied. Their original analysis identities are:

| Analysis | SHA-256 |
|---|---|
| Gate | `daab2d367fd8a4224bd8afda0ab933e1611ecdaa9ca3957aaf11774658c75a1c` |
| Expansion | `f47f7d9f187d6c9bed0d89b88ea3e6c143ef71ccd82266687b59de0bd74300ed` |

Source identities and redacted public identities are separate. Public replay verifies the files and projections included in the release; it does not reconstruct withheld private grading inputs, private raw hash chains or opaque backend identity. The earlier 974-file release is linked at its fixed commit and represented by its original manifest/accounting snapshots. It is not duplicated or claimed to have been replayed as part of this new release.

The released package contains **1,414 files and 91,326,804 bytes**. An independent audit checked every file hash, byte count and directory member; scanned all 1,412 text files for the configured private identifiers, usernames, paths, UUIDs and credential patterns with zero findings; and verified the two approved six-byte synthetic binary markers. Its separate replay completed with network access and filesystem writes denied, verified both subpackages and the one recovery audit, and reproduced the 50-reservation accounting. Package bytes and the checked private inputs remained unchanged. These checks do not claim irreversible anonymization or complete private-grader replay.

The release manifest identity is `f3779c3c9922b5901a34fd9f714d496c901b248e17efdf972feea3c64d2fadc0`; the SHA-256 of the manifest file is `29583d206f8b8715011d799e36c395dce97cee67d635557dfadd8c07a90f0c27`.

From a repository checkout, reproduce the public release without credentials or package installation:

```sh
node benchmark/results/2026-11-22-two-model-continuation/replay.mjs
```

### Independent Skill handoff check

An independent agent, without the implementation author's conversation history, followed the repository guidance and verification Skill to discover the frozen CLI. It independently ran gate analysis and exported replay with networking denied, reproduced the gate analysis identity and matched 11 report/CSV/SVG outputs byte for byte. Its separate verifier checked included export file hashes, source identities, raw/copy references and evidence locators.

This was a zero-subject-model analysis/replay exercise. It did not execute the requested real-model regression slice. The older frozen reanalysis ownership limitation and the later whole-scope stop check were recorded rather than bypassed. The complete cold Skill acceptance criterion remains open.

## Implementation and workspace closeout

[PR #44](https://github.com/yoyooyooo/pi-context-broker/pull/44) merged into `benchmark` as `dc3264cf68308b0e2d74c0994dc3dcc88d16ffeb`. Its reviewed head `58b9097d862dcfac03adadf1e47ffeadc82045c2` and merged commit have the same tree. [CI](https://github.com/yoyooyooo/pi-context-broker/actions/runs/45109937915) and both [Formal checks](https://github.com/yoyooyooo/pi-context-broker/actions/runs/45109937963) passed for that exact reviewed head. An earlier CI failure exposed an incomplete integration-test source fixture; that failure was retained and the fixture now copies the registered implementation closure.

The source adds finite future scopes with exact ordered slots, shared physical accounting, zero automatic resend and a stop on new unknown usage. It preserves legacy cohort behavior. It also includes the future clarification matcher fix and the source-closeout command from [PR #42](https://github.com/yoyooyooo/pi-context-broker/pull/42), which merged into `next`.

The first publication attempt failed before release because an unfinished streaming path was inferred as a one-letter username and then matched ordinary SVG coordinate attributes. [Publisher fix `d1381ff`](https://github.com/yoyooyooo/pi-context-broker/commit/d1381ff1032d0ba25619f28164ebc11f6ba4b1ce) changes automatic discovery to require a complete home-path component and preserves explicit home-root declarations. Publication version 1.0.5 retains the machine-path masking and final privacy checks. Its 17 focused publication tests and the 36 private accounting/assembly tests passed with networking denied. The failed output and original publisher source remain retained; no experiment was resent or rescored to repair publication.

Frozen build4 passed a real full-artifact check without model calls. It was built from source `83e58e9eb91257834c0391ddc738f4338122e99c`; its 53-file production implementation matches the later reviewed source. The later difference is test-only. Build4 was not substituted into the already-recorded experiments.

Project cleanup moved two clean, integrated worktrees and their Git administration records, 81 rebuildable install-cache directories and three owned synthetic-test fixture roots into the native system Trash. The cleanup passes, including the publisher regression fixtures, accounted for 10.693283081054688 GiB of directory allocation. All eight dirty checkouts, raw evidence, failure receipts and install/test logs were retained. The first pass verified 1,023 protected file hashes; the second verified 84 protected references and reran the five affected complete frozen-build checks successfully. Native acknowledgements and absence of the original paths were recorded. No permanent deletion was performed, and these reversible Trash moves are not counted as reclaimed free space. The later 25.484 GiB free-space reading is a point-in-time observation only.

The closeout command requires current clean source identity, integration evidence, all declared owned references and an explicit disposition. Referenced sources remain retained with an owner and a release condition. Moving a merged workspace without checking frozen-build references would break later artifact checks.

## Remaining Benchmark work

The first release still needs a real paired comparison between two own-product versions, independently unseen material confirmation, the finite Code Mode/scale/fault slices and the real-model cold Skill regression. Preparation for the old/new product comparison preserves full product source identities and separates common apparatus inputs, but it has not produced a new candidate execution or an acceptance result.

Grok-4.7 and GPT-6.1 Terra route drafts exist under the corrected aliases. Their finite budgets and the broader acceptance budget are design proposals only. The current new-unknown stop prevents activating them under the existing contract. Any future resumption requires an explicit prospective decision that retains all 50 reservations, all four unknowns, the invalid expansion-021 and the current incomplete denominator. Reanalysis, changing a scope name or reporting this stopped batch cannot serve as that decision.

## Proposed resumption decision — not activated

The [prospective proposal](benchmark-continuation-resumption-proposal-2026-11-22.json) is a reviewable draft with `approved: false` and no execution authority. It retains the current 50 physical reservations and requests a ceiling of 89 future reservations, for 139 total under the unchanged absolute cap of 144.

| Future purpose | Maximum new reservations |
|---|---:|
| Separate pilot follow-up for the 11 unstarted cases | 11 |
| Grok-4.7 auto route gate | 8 |
| GPT-6.1 Terra auto route gate | 8 |
| Own-product comparison and unseen confirmation | 20 |
| Code Mode controls | 24 |
| Scale coverage | 10 |
| Fault/recovery coverage | 8 |
| Total proposed future ceiling | 89 |

The real cold Skill slice must be a subset of these counts. The original stopped 48-slot scope remains incomplete; a separate follow-up cannot rewrite its result. No completed or invalid run is resent. An explicit prospective decision, a separately reviewed contract change and exact frozen future scopes are required before any call. Each later new unknown usage or core stop stops dispatch again. This finite proposal does not guarantee acceptance or closure of every remaining Benchmark criterion.
