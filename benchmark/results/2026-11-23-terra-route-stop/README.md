# Terra route check stopped on missing usage

All eight Terra slots were executed. Seven are valid; the eighth is invalid after an interrupted response stream left its token usage unknown. The actual public route gate rejected the scope with `FINITE_ORIGINAL_CORE_STOP`. Later paid dispatch remains paused.

This is a fixed checkpoint as of **23 November 2026, 03:47:36 PST** (`2026-11-23T11:47:36.052Z`). It follows the [earlier Grok and collector-correction checkpoint](../2026-11-23-continuation-checkpoint/README.md), whose original timestamp and contents remain unchanged.

## What the Terra observations establish

| Measure | Observation |
| --- | --- |
| Frozen purpose | Route and accounting check only |
| Scientific denominator / physical executions | 8 / 8 |
| Valid / invalid executions | 7 / 1 |
| Complete-contract outcomes among valid executions | 4 pass, 0 fail, 3 unknown |
| Business outputs among valid executions | 7 pass, 0 fail |
| Unresolved valid scientific observation | 1: Broker, explicit-01 |
| Actual route-gate result | Rejected; no passed gate written |
| Product acceptance | No acceptance claim |

The invalid eighth execution has a raw business failure observation, retained separately from the valid-result counts. The complete-contract measure requires evidence beyond a correct business output. Neither valid counts nor preparation of later materials establishes product acceptance. See the [scope report](TERRA8.md) and [generated tables and figures](terra8/report.md).

The declared route was `auto/gpt-6.1-terra`, using `openai-completions`, `thinkingLevel: medium` and `maxTokens: 4096`. The declared model window is `2026-11-23T08:16:05.930Z` through `2026-11-24T08:16:05.930Z`. Reported route-group labels are matched aliases; the hidden backend identity remains unobserved. Broker and Native used the same `benchmark-route-runtime-1` build. These conditions are retained in the [public analysis inputs](terra8/analysis-input.json).

## Why dispatch stopped

Execution 008 sent two actual requests. Its first request reports 3,876 input and 36 output tokens. The second received HTTP 200 and partial SSE data, then the SDK reported an interrupted response stream. The capture contains no completion marker or exact usage for that request. The evidence does not establish the underlying abort cause or the missing token count.

The runtime preserved unknown totals and blocked a third send. The reported model label matched the frozen allowed identity. The subsequent public gate command failed with `FINITE_ORIGINAL_CORE_STOP`, without model execution or a passed-gate file. [Terminal-event mappings and provenance](terra8-provenance.json) identify the retained evidence.

## Cost coverage and campaign accounting

Terra made **27 actual requests**. Seven episodes have complete usage totaling **100,417 input and 1,402 output tokens**. Including the known first request of invalid episode 008 gives observed-attempt subtotals of **104,293 input and 1,438 output tokens**. The scope totals remain unknown because the second request is unmeasured. No verified monetary price is available.

The campaign has **66 completed physical reservations**, with 58 valid and eight invalid records. These counts track reservations; quality comparisons retain their separate experiments, conditions and scientific denominators.

| Registered effective history field | Known subtotal | Episodes with that field known | Campaign total |
| --- | ---: | ---: | --- |
| Actual model requests | 295 | 65 of 66 | Unknown |
| Input tokens | 1,557,388 | 61 of 66 | Unknown |
| Output tokens | 45,472 | 61 of 66 | Unknown |

Each field has its own coverage. The campaign token subtotals include only episodes whose complete token totals are known; they exclude the partial first-request tokens from Terra 008. There are now five effective episodes with unknown token usage, up from four. The untouched original completion records contain six, up from five. Their token subtotals are 1,533,767 input and 44,703 output; an existing historical revision accounts for the difference from effective history. This Terra publication introduces no analysis registration or historical rewrite.

The approved ceiling stays at **139**. The **73** later allocated episodes remain unstarted; the other **five** reservations below the original 144 ceiling remain unallocated. Own-product materials are sealed but unopened, and the engineering materials are prepared. No later scope is configured or dispatched. The [checkpoint provenance](checkpoint-provenance.json) records the accounting snapshot and its verification boundary.

## Public evidence and verification

- [Detailed Terra report](TERRA8.md)
- [Generated report](terra8/report.md), [analysis](terra8/analysis.json) and [public manifest](terra8/public-manifest.json)
- [Source-to-public provenance and mapped terminal events](terra8-provenance.json)
- [Campaign checkpoint provenance](checkpoint-provenance.json)
- [Next-decision draft](NEXT-DECISION.md), which is **not an execution authorization**

The 328-file package preserves the frozen collector 1.1.0 observations. Publisher 1.0.6 produces transformed evidence copies mapped to retained originals. Collector 1.2.0 was not applied to Terra. All 867 protected source files remained unchanged.

An independent package copy was replayed with OS network access and original file contents denied and without inherited credentials. Hash verification and normalized-observation reaggregation passed. The regenerated analysis, seven CSV tables and quality chart were byte-identical; two other charts differed only in the existing renderer's title wording. The detailed report records these limits and commands.

Public replay covers this Terra package. The private campaign ledger, user decision, route-gate execution receipt and preparation checks are represented by audit references; the package does not independently reconstruct or replay them. Publication adds no subject-model requests. Auxiliary agent token usage and cost remain unknown.

The [next-decision draft](NEXT-DECISION.md) proposes retaining this new failure and unknown usage while separately reviewing an amendment for the existing 73 unsent episodes. The previous approval of ordinary work remains in force. Crossing this newly triggered stop is the specific unresolved decision.
