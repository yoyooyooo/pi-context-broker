# Continuation and evidence-correction checkpoint

This release adds the retained Grok 4.7 alias failure, the seven later Grok executions, and a separate corrected analysis of the previously published two-model expansion. The three packages retain separate protocol and analysis identities and map transformed evidence copies to the retained originals. They do not constitute an additional combined benchmark population.

## What was completed

| Package | Physical executions represented | Valid observations | Complete-contract result | Business output result |
| --- | ---: | ---: | --- | --- |
| [Retained alias failure](GROK-ALIAS-INVALID.md) | 1 | 0 | Invalid admission | Not a business episode |
| [Grok seven-slot continuation](GROK7.md) | 7 | 7 | 3 pass, 3 fail, 1 unknown | 5 pass, 2 fail |
| [Corrected expansion analysis](COLLECTOR-CORRECTION.md) | The same 21 previously published executions | 20 | 6 pass, 2 fail, 12 unknown | 18 pass, 2 fail |

The corrected expansion is an analysis of existing executions. It adds no model sample or request. The historical expansion view remains [published at its original commit](https://github.com/yoyooyooo/pi-context-broker/tree/aa414f49c57eb1e170a91219d9dd429ada8a12db/benchmark/results/2026-11-22-two-model-continuation/cohort-3-expansion): 2 pass, 2 fail and 16 unknown among the same 20 valid observations, plus one invalid execution.

The retained alias failure and the seven later Grok executions account for eight physical executions. Their linked scientific design has eight slots; the failure is not an eighth valid observation. The seven-execution report keeps eight planned slots, seven valid observations and one unresolved slot. Do not add the two standalone eight-slot plans into a sixteen-slot scientific denominator.

## Why the Grok results differ

One Grok execution produced the correct business values but selected a Skill outside the permitted set. Two others reached the frozen input-budget preflight limit before producing the required decision file. Those two results describe non-delivery under the declared budget, rather than an incorrect delivered value or a failed route. The unknown result retains an opaque Bash operation despite a correct business output.

The input preflight uses the protocol's declared conservative heuristic. It is not a tokenizer measurement or a proven token upper bound. The two blocked next requests were never sent and are excluded from actual request usage. Their retained runtime state is `budget_stopped`; their completed observations have known usage and no campaign-level core stop.

The Grok Native condition's 66.7% verified quality is weighted by the frozen case weights; its raw count is two passes among four valid observations. Its simultaneous 95% interval spans 0–100%. Broker has one pass and two failures among three valid observations, with one planned slot unresolved. These samples support neither a model ranking nor product acceptance. The normal paired report rejects the comparison at `critical_contracts`.

## Evidence correction

[Collector 1.2.0](https://github.com/yoyooyooo/pi-context-broker/pull/52) recognizes a CodeMode container only when retained builtin-runtime evidence and a complete child-call census establish its boundaries. Prepared short references require matching full text, owner, scope, snapshot, version and resource identity across the retained preparation, independent material and SDK evidence.

Only expansion executions 003, 004, 013 and 017 changed from unknown to pass. The binary-resource Bash case remains unknown. Caught failed Bash calls and two failed nested reads also remain visible. The correction leaves the protocol, success criteria, normalizer, grader, subject identity, admission, attempts, usage and stop decisions unchanged. All 1,433 protected original files retained their hashes.

The implementation passed 84 focused tests and an independent rerun, followed by the full [repository CI](https://github.com/yoyooyooo/pi-context-broker/actions/runs/45161301578). PR #52 was rebased into `benchmark` as `0af8d1de7f7d9ab4efaccd58c52254f3453bda8a`; its tree matches the independently reviewed and tested head. The active paid campaign continues using its original frozen controller. This corrected analysis was not registered into that live campaign's history.

## Campaign accounting at this checkpoint

The retained campaign census at **2026-11-23 03:01:34 PST (11:01:34 UTC)** contains 58 completed physical reservations: 51 valid and seven invalid. Under the registered original analyses, their accounting totals are 12 pass, 10 fail and 29 unknown. These totals combine different scientific scopes and are not a pooled quality estimate. The four recovered expansion outcomes above remain a separate analysis view.

Known usage is 268 actual requests, 1,456,971 input tokens and 44,070 output tokens. Four historical executions still have unknown usage, so these are known subtotals, not complete totals. Monetary cost is unpriced. The retained alias failure itself has known original usage: one request, 5,789 input tokens and 349 output tokens; it has no applied analysis revision. The seven later Grok executions add 35 requests, 275,332 input tokens and 8,702 output tokens.

The approved continuation ceiling is 139 physical reservations within the original hard cap of 144. At this 58-reservation checkpoint, 81 approved reservations remain. The extra five are unallocated. Later Terra, unstarted-expansion, own-product, CodeMode, scale and fault scopes are outside the execution results in this release. Approval does not count as execution or acceptance, and no completed or invalid execution was resent.

## Offline replay

From this directory, run the existing package entry points:

```sh
node grok-alias-invalid/replay.mjs
node grok7/replay.mjs
node collector-correction/replay.mjs
```

Each package is self-contained and was replayed from a separate public-only copy. The verification denied network access and private source-file contents, retained only the path metadata needed by Node, and supplied no inherited credentials. Canary reads confirmed that private original files were unavailable. The integrated package files are byte-identical to those verified copies.

Public replay checks the published inventory, hashes and source locators, then reaggregates normalized observations. It does not rerun private business grading, reconstruct the original raw hash chains, or replay the private campaign-registration ledger. Registration hashes are audit pointers. Source hashes, redacted public hashes, analysis identities and these replay boundaries are recorded in the three provenance files.

| Package directory | Files including its manifest | Bytes including its manifest |
| --- | ---: | ---: |
| `grok-alias-invalid` | 164 | 3,366,626 |
| `grok7` | 334 | 15,315,582 |
| `collector-correction` | 794 | 56,779,565 |

The inventories above exclude this checkpoint's explanatory Markdown and provenance files. Original-to-public transformation preserves the stated statistical meaning; deterministic pseudonyms are not a claim of irreversible anonymization. Export and replay made zero subject model requests. Auxiliary agent usage remains unknown where no measurement was available.
