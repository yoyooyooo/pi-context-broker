# Two-model Benchmark pilot — 2026-11-22

**Status: real GPT-6.2 Sol and Grok-4.6 observations recorded; the 16-episode admission plan stopped after eight records because Mini could not load the Notion catalog. The admission gate and the proposed 32-episode expansion are not complete.**

Flash is deferred under the current user instruction. All Benchmark execution, builds and private evidence remain in the task-owned Mini environment. The earlier temporary workspace on the fallback machine was already moved to the verified system Trash; using an existing model gateway does not move the Benchmark workspace there.

The [public evidence package](../benchmark/results/2026-11-22-two-model-pilot/README.md) retains the new results, the earlier stopped trials, the original blocked release and the shared campaign accounting. It supports reproducing the recorded results and their limitations. It does not support a model ranking, an environment-efficiency claim or release acceptance.

## What actually ran

The selected variants are **GPT-6.2 Sol** and **Grok-4.6**, through explicitly frozen route aliases. The GPT variant was not silently changed to Astra. Backend identities remain opaque aliases. Both conditions use the same prepared 16-Skill material library and the selected benchmark-full-candidate-6 build; Broker uses the Notion source and Native uses its verified equivalent materials.

The active admission plan contains four cases and four model/environment conditions: 16 scheduled slots, one repetition, with the original ordering seed and a maximum of ten model requests per episode. Eight slots produced terminal records. Seven were valid model observations; one was invalid before task admission. Eight slots remain missing. The planned four-slot denominator for each condition is retained.

| Condition | Planned | Recorded | Valid | Verified pass | Verified fail | Valid outcome unknown | Invalid |
|---|---:|---:|---:|---:|---:|---:|---:|
| GPT-6.2 Sol / Broker | 4 | 3 | 3 | 2 | 0 | 1 | 0 |
| GPT-6.2 Sol / Native | 4 | 3 | 3 | 2 | 1 | 0 | 0 |
| Grok-4.6 / Broker | 4 | 1 | 0 | 0 | 0 | 0 | 1 |
| Grok-4.6 / Native | 4 | 1 | 1 | 0 | 1 | 0 | 0 |
| Active admission plan | **16** | **8** | **7** | **4** | **2** | **1** | **1** |

These are observed counts, not estimates of success on the complete intended scope. All seven valid observations concern three no-skill cases. The explicit case and the other eight task families have no new model observation in this plan. See the package's active admission report for the frozen protocol, family weights, missing units and statistical limitations.

## What the observations establish

GPT completed the status-counting and invoice-total cases in both conditions. Each of those four observations passed both the business and selection contracts. The independent output readbacks matched the expected artifacts.

On the missing-policy case, GPT / Broker produced the required needs_information business result, but the selection evidence was incomplete. Its verified outcome remains **unknown**, with no success credit. GPT / Native exhausted the frozen ten-request limit without writing the required decision artifact. Its business outcome remains **fail**, and its selection outcome remains **unknown**.

Grok / Native produced the correct invoice total, but explicitly read two Skills where the no-Skill contract allowed none. The business contract passed and the selection contract failed, so the overall verified outcome is **fail**. Some other tool activity had incomplete selection coverage; that does not erase the positively observed prohibited selection.

The subsequent Grok / Broker slot failed during Notion preparation. It is **invalid / not applicable**, not a Grok business-quality failure.

## Requests and cost accounting

Request counts come from actual transport and provider observations. Token inputs include cached input where reported; SDK placeholder zeros are not treated as provider metering or economic cost.

| Scope | Shared reservations / recorded slots | Known model-request subtotal | Known inclusive input subtotal | Known output subtotal | Complete request/token totals |
|---|---:|---:|---:|---:|---|
| Historical trials before the active admission plan | 5 | 6 | 23,621 | 769 | Token totals unknown |
| Active two-model admission plan | 8 | 33 | 148,375 | 3,370 | Unknown |
| Shared campaign | **13** | **39** | **171,996** | **4,139** | **Unknown** |

The shared campaign retains three records with unknown usage: the earlier Flash authorization failure, the expired GPT-route authorization failure, and the latest Notion-startup failure. In the latest record, no model start or payload was observed, but transport completeness is insufficient to prove a zero total. Its request, input and output totals remain null; the known subtotal of zero must not be presented as a verified zero cost.

Monetary pricing is unverified, so monetary cost remains unknown. The temporary administrative allocation held for the expired route is not an observed charge or a proven upper bound. It is not added to observed request counts, tokens or reservations. The cumulative scheduling cap remains **144**, including invalid observations and any explicitly authorized replacements.

## Why the active plan stopped

The eighth slot reached Broker preparation and attempted to read the Notion catalog. Two source-list operations made sixteen metadata GET attempts. The first returned NOTION_UNAVAILABLE with a network reason; the second was cancelled when the 180-second wall limit expired. No user turn, model request start or model payload was recorded.

Fifteen GET attempts had recorded failure endings, including connection resets and connection timeouts. The final GET lacked a transport end record. The runtime therefore retained incomplete attempt coverage and did not pass task admission. The launcher exited under control, and the selected runtime and frozen artifacts were unchanged; those facts do not replace the missing admission and transport evidence.

Separate, read-only checks after the stop also failed to obtain a Notion HTTP response: maintained Node reported ECONNRESET, and system curl reported TLS timeouts both directly and through the already configured system proxy. These checks made no model requests and changed no credentials or proxy settings. They establish the observed Mini connectivity problem, not a claim of a global Notion outage.

The controller correctly retained this new core stop. There is no passed admission gate, no expansion plan frozen from a passed gate, and no expansion result. The original twelve-case, ten-family coverage proposal remains a proposal.

## Repairs and retained history

Three stopped trial identities remain distinct:

1. The first two-model trial rejected its first task before a model send because session-random catalog handles were compared literally. The comparison now binds those handles to independently observed candidate identities. It changes only the comparison copy, not the raw or transmitted model payload.
2. The next trial sent one GPT request and received an expired-key error from its selected route without usable provider usage. That observation stays invalid with unknown usage. An explicit, prospective, same-Sol-variant route registration selected an existing fixed route, froze four fresh no-model captures and retained all earlier costs. Automatic fallback and repeated manual route succession remain forbidden.
3. The active trial produced the eight records described above. Its final Notion-startup stop remains authoritative.

The original three-model first-24 gate remains incomplete. The user-authorized two-model scope is a separately frozen admission requirement of sixteen new observations, four per condition. It does not relabel the old gate as passed or import old observations as new success credit.

### The sixth record was not rerun

For the active plan's sixth record, the SDK wrapped a local request-limit exception as a provider error. The collector had already retained a valid, fully metered business failure, but the controller escalated the wrapped error into a batch stop.

A registered, same-raw analysis revision corrected only that controller interpretation. It verified all ten paid responses, complete provider usage, the local guard's rejection before another send, the unchanged frozen budget and the settled cleanup. The original runtime status remains failed; the original completion still records its stop; the append-only revision supplies the effective scheduling view. The failed business outcome, unknown selection outcome, ten requests, 39,784 input tokens and 292 output tokens are unchanged.

| Sixth-record private source identity | SHA-256 |
|---|---|
| Original normalized episode | ed6b986baf2c65335479569d3839ce7b7e6933c3a61644fd7f3485d14428e962 |
| Same-raw revised episode | 29c472536594eac2ef6361f09204dbb3a7db852cd25119694778ee4a87126378 |

These identify the retained private originals. The public package records the corresponding transformed artifacts and their separate public hashes; the original and effective records still account for one physical run.

The revision was first registered with --limit 0, which added no episode or model request. Execution then continued at the original seventh slot. The revision cannot clear the eighth record's different admission and completeness failure.

## Implementation and verification

The implementation includes prospective scope registration, shared-budget accounting, source and material identity checks, verified same-raw revision consumption, independent business readback and offline publication. The local request-limit error is also preserved correctly by the updated runtime source for future builds. The observations in this report still used the frozen build6 runtime; they are not presented as executions of a later runtime source.

Before the final real-model slice, the complete offline Benchmark suite passed **380 of 382 tests**, with zero failures and two explicit SDK opt-in skips. The later public-only route-configuration refactor passed its sixteen scope tests and an independent comparison against the actual retained amendment, revision and effective records. Both the executed and public implementations continued to reject the eighth record's core stop.

Public configuration reads the explicitly frozen route pair instead of embedding private gateway labels in source. Tests and documentation use synthetic route names. The published source is a later reviewed version, not a replacement for the archived source identity of an earlier run.

Analysis remains version **1.1.0**. Publication **1.0.2** adds a narrowly reviewed allowance for the exact six-byte synthetic binary fixture; unapproved binary artifacts remain rejected. Public artifacts retain source-to-public hash mappings, transformed raw evidence and the explicit limits of replay.

## Reproduce the recorded results

From the repository root:

    node benchmark/results/2026-11-22-two-model-pilot/replay.mjs

Replay verifies the published package and retained release, reaggregates its normalized observations and recomputes shared accounting without model requests. Public aliases and hashes identify transformed artifacts. Replay does not recreate private credentials, private original hash chains, remote materialization or a new business run.

The earlier [blocked-pilot report](benchmark-pilot-2026-11-22.md) and its 311-file release remain historical evidence. The [running guide](benchmark-running.md), [scope policy](benchmark-pilot-scope.md) and [analysis specification](benchmark-analysis.md) describe the implementation contracts.

## Remaining work

Mini-to-Notion connectivity must be restored and checked before another Broker run. Any later execution needs a newly frozen continuation decision that retains the invalid eighth record and the shared ledger; directly resuming this stopped plan or changing its old outcome is not permitted.

The immediate empirical scope remains the unfinished sixteen-slot admission plan and the unexecuted thirty-two-slot expansion. The wider Benchmark acceptance also still needs meaningful product-version comparisons, held-out confirmation, controlled Code Mode conditions, larger catalogs and longer journeys. Material preparation, no-model captures and offline tests do not fill those model-result cells. Flash remains deferred under the current instruction.
