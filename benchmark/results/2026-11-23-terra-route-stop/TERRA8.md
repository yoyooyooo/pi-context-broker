# Terra eight-execution public evidence

The Terra route gate stopped after its eighth execution. Seven executions are valid; the eighth is invalid because its second request ended without exact provider usage. The frozen public gate was actually run and rejected with FINITE_ORIGINAL_CORE_STOP. No passed gate was written, and all later paid dispatch is paused.

This package preserves collector 1.1.0 observations. Publication 1.0.6 creates redacted copies and verifies that outcomes, unknown values, denominators, intervals, and decisions remain unchanged. Collector 1.2.0 was not applied to this scope.

## Results and scope

| Measure | Result |
|---|---|
| Scientific plan | 8 slots |
| Recorded physical executions | 8 |
| Valid executions | 7 |
| Invalid executions | 1 |
| Complete-contract outcomes among valid executions | 4 pass, 0 fail, 3 unknown |
| Business output outcomes among valid executions | 7 pass, 0 fail |
| Unresolved scientific slot | Broker m0-e0, explicit-01-a-n16-r1 |
| Unstarted physical slots in this scope | 0 |
| General paired analysis | Descriptive, no_acceptance_claim |
| Actual route gate | Rejected, FINITE_ORIGINAL_CORE_STOP |

The invalid eighth execution has a raw business failure observation. It is separate from the seven valid business results. Complete-contract success and business output success measure different requirements. The quality figures in the generated report use complete-contract outcomes.

This is a route_gate_only scope. Its results do not establish product acceptance. The seven valid-result counts retain the original eight-slot statistical denominator, with one invalid slot unresolved. Publication and replay add no executions.

## Usage and retained stop

| Coverage | Requests | Input tokens | Output tokens |
|---|---:|---:|---:|
| Seven episodes with complete token usage | 25 | 100,417 | 1,402 |
| Eighth episode, first request | 1 | 3,876 | 36 |
| Eighth episode, second request | 1 | Unknown | Unknown |
| All eight physical executions | 27 | Unknown | Unknown |

Across observed attempts, the known token subtotal is 104,293 input and 1,438 output tokens. These are incomplete subtotals, not scope totals. Monetary cost remains unknown because route pricing is unverified.

The second request of execution 008 received HTTP 200 and 6,984 bytes of partial SSE response data. The capture has no DONE event, nonnull finish reason, or raw provider usage for that request. Transport ended with AbortError/code 20, and the SDK reported that the upstream response stream was interrupted. The retained artifacts do not establish a timeout cause or how many unreported tokens were generated.

The reported model matched the frozen allowed identity. The runtime stopped with BENCHMARK_USAGE_UNKNOWN. Retry intent was blocked before a third send. SDK zero-valued usage placeholders were not treated as exact provider usage. The original invalid result, two actual sends, unknown token totals, and stop_batch=true remain intact.

The stable campaign census now has 66 physical reservations and 66 completed executions. Effective records contain five runs with unknown usage, up from four. Untouched original completion records contain six, up from five; the existing historical revision accounts for the difference between these views. Only Terra execution 008 adds a new unknown. No earlier original failure was overwritten.

The original core stop remains active. This publication makes no claim that remaining planned work is permitted to cross it.

## Evidence and replay

The package contains 328 files totaling 13145593 bytes, including its public manifest. The manifest records source-to-public hashes, transformed byte counts, privacy policy, and the exact inventory. The only allowed binary content is the existing six-byte synthetic fixture recorded there.

Run node terra8/replay.mjs from this directory to verify public hashes and source locators and reaggregate normalized observations. To regenerate the report, use node terra8/replay.mjs --out /absolute/new-report-directory. No package installation or credentials are needed.

An independent copy passed replay with OS network access denied, original-environment file contents unreadable, and no inherited credentials. Directory metadata remained available for Node path resolution. Separate probes confirmed that the public manifest was readable, the original plan was denied, and a loopback listener was denied. The public inventory was unchanged after replay.

The regenerated analysis, seven CSV tables, and quality chart match the exported bytes. The input and time charts are identical after accounting for the existing title wording: Cumulative input becomes Cumulative input across actual attempts, and Capped time becomes Capped time across the full fixed denominator. Full generated reports are not claimed to be byte-identical.

Replay does not rerun the private grader, reconstruct original raw hash chains, recover redacted data, or replay the private campaign registration ledger. Deterministic pseudonyms preserve relationships and do not guarantee irreversible anonymization.

Publication and replay made zero subject model requests and no ledger, Notion, or source changes. Auxiliary agent token use and cost are unknown.

## Provenance

- Original analysis identity: 0577b6413ca5cd7261ebfb3a1f8c45d3ab6be1259d808d912599d8ac69575dbb
- Public analysis identity: 3434992a2344f1ed17b3076115205d3ce0a693834a0427038946c513f57e9149
- Public manifest identity: b05ce305557961e77b8ad7ea1cb8fc9f60f2e98d8006ce0f5765ce6df9d3f85f

See terra8-provenance.json for source pins, original/public episode identities, the mapped terminal event references, the actual gate rejection source, the preserved unknown-usage history, and the bounded replay receipt.
