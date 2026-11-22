# Benchmark pilot status — 2026-11-22

**Status: blocked pilot; Benchmark completion and release acceptance remain open.** The first-24 route gate did not pass. Two current-plan episodes reached the real model route, and the second stopped on an external Cline OAuth error with missing usage. The evidence below supports accounting and apparatus conclusions; it does not support a model-quality or environment-efficiency ranking.

## Recorded results

The current frozen plan compares three declared route aliases across Broker/Notion and native-equivalent environments, with four cases from the `no-skill` and `explicit` families and a common 16-Skill catalog. Backend identities remain opaque aliases. Both actual-send episodes used the same `no-skill-02` case in the native environment. [Current protocol and normalized evidence](../benchmark/results/2026-11-22-pilot-blocked/current-plan/analysis-input.json).

| Shared reservation | Plan / condition | Recorded status | Actual model HTTP requests | Inclusive input tokens | Output tokens | Episode duration |
|---|---|---|---:|---:|---:|---:|
| 001 | Earlier plan / Grok route, Broker | Admission invalid; zero sends | 0 | 0 | 0 | 7,509.257333 ms |
| 002 | Current plan / Grok route, native | Valid; verified outcome unknown | 4 | 23,621 | 769 | 18,183.183125 ms |
| 003 | Current plan / Flash route, native | Invalid; authorization error and missing usage | 1 | unknown | unknown | 6,082.845083 ms |
| Shared accounting | Three retained reservations | Gate blocked | **5** | **23,621 known subtotal** | **769 known subtotal** | **31,775.285541 ms summed** |

The complete token totals and monetary cost are unknown. The input subtotal includes cached input; it is not the uncached Pi input counter. The duration column sums measured episode durations and is not project elapsed time. [Recomputable accounting](../benchmark/results/2026-11-22-pilot-blocked/accounting.json).

The valid Grok episode passed the independent output-artifact contract. Its selection contract remained unknown because the evidence did not fully establish that no Skill was selected. It therefore receives no verified success credit. The Flash episode lacks provider usage after an actual send and is excluded from the valid quality denominator. Its absent business output does not become a model-quality failure after apparatus invalidation. [Current statistical report](../benchmark/results/2026-11-22-pilot-blocked/current-plan/report.md).

## Keep the denominators separate

| Scope | Planned / reserved | Recorded | Valid | Invalid | Missing records | Units without a valid result |
|---|---:|---:|---:|---:|---:|---:|
| Current frozen plan | 24 planned | 2 | 1 | 1 | 22 | 23 |
| Shared pilot ledger across plans | 3 reserved | 3 | 1 | 2 | Not a pooled quality denominator | Not a pooled quality denominator |

The earlier zero-send invalid episode remains under its original plan and shared reservation. The corresponding current-plan slot was explicitly not dispatched and remains missing. There is no replacement or additional success credit. The global pilot cap remains 144 scheduled episodes; invalid records and replacements count, and the route gate remains the shared first 24. [Exact reservation receipts and package inventory](../benchmark/results/2026-11-22-pilot-blocked/release-manifest.json).

Collector 1.0.1 reanalyzed reservation 002 from the retained original four requests. The narrow correction recovered a public provider identity from a unique observed configuration only when an exact recorder-redaction marker and all route/payload/transport proofs agreed. It did not rerun the episode, change its business outcome, or add a reservation. Original and reanalyzed identities remain distinct and linked in the evidence.

## What is implemented and evidenced

Actual runtime capture, per-attempt transport and inclusive usage accounting, independent output readback, evidence normalization, fixed-denominator scoring, public redaction and offline report replay are implemented. The current package preserves unknowns and invalid costs. Paired comparisons remain descriptive with no acceptance claim because the planned paired cells are incomplete. [Analysis](../benchmark/results/2026-11-22-pilot-blocked/current-plan/analysis.json) and [publication boundary](benchmark-publication.md).

A separate expanded material library is ready: 16 real remote candidates, comprising 14 native Skills and 2 pinned source Skills; 31 of 31 files passed parity checks with no differences. Its 12 cases cover all ten families. Fourteen main files use verified public-SDK structural equivalence; the other 17 files use exact bytes. Scripts, assets, empty files and executable modes remain part of the material evidence. This preparation made **zero model calls** and did not replace the frozen four-case pilot corpus. [Sanitized material summary](../benchmark/results/2026-11-22-pilot-blocked/material-parity-summary.json).

The source fixture tag is `benchmark-fixtures-20261122-d1c699be`, at commit `c8b49c1c1dfac65257b07e8d249f187405e0e7f4`. The retained expanded material proof is identified by `7b326451db563a8768f58c84600c9db1ac12b13076466791e474346bc383d328`; the expanded public corpus is `15f804ee3e6d9a74398eb0bc60b1845c5d0e2e2a7ad2859909baed43e898df19`. These are material identities, not model-result identities.

## Work still open

| Workstream | Current state | Evidence required before completion |
|---|---|---|
| First-24 route gate | Blocked; this frozen gate remains unpassed | Complete accounting and the requirements of a newly frozen continuation policy; retain the earlier invalid records and costs |
| Three routes × two environments | One cell has a valid real observation | Current-build real observations for every required cell; no route or environment inferred from another cell |
| Ten-family model campaign | Materials ready; real sends cover one no-Skill case only | Actual outcomes for `no-skill`, `explicit`, `implicit`, `ambiguity`, `equivalent`, `references`, `scripts-assets`, `complementary`, `continuation`, and `task-switch` |
| Held-out confirmation | Not run | Unseen confirmation material under a frozen protocol |
| Self-version comparison | Not run | Frozen version identities, budgets, material separation and actual paired runs |
| Catalog scaling | Not run | Declared catalog sizes and actual comparable episodes beyond the prepared 16-candidate setting |
| Real controlled CodeMode comparison | Not run | Natural model episodes under the declared control and treatment; loopback nested-tool apparatus proofs are insufficient |
| Cross-turn event behavior | No natural model result in this pilot | Actual within-session event and business evidence; controller tests do not fill missing model cells |
| Final quality, efficiency or release decision | Unsupported | Complete required data and the preregistered quality gates before efficiency claims |

Historical summaries without their original raw evidence are not imported as new model observations.

## External blocker and human recovery

The observed error is `token refresh: http 400` with `invalid_grant`. Time-, route- and error-correlated proxy metadata identifies the Cline OAuth plugin behind the selected Flash route. The public diagnostic omits the account-file identity and private control paths, and explicitly records the absence of an end-to-end response request identifier. [Authorization diagnostic](../benchmark/results/2026-11-22-pilot-blocked/auth-blocker.json).

On Mini, the operator can open the local CLIProxyAPI management console at `http://127.0.0.1:8317/management.html` and restore the **Cline plugin OAuth** authorization. The management page and plugin OAuth entry are established by the deployed configuration and corresponding local server documentation; the login action was not invoked during diagnosis. No account or credential values are needed in this report.

Restoring OAuth does not turn the existing invalid episode into a valid one, establish the missing historical token usage, or pass this frozen gate. The proxy's failure-record zero counters do not prove zero backend consumption. Any later execution requires a **new frozen continuation policy** that preserves the prior invalid records and costs. Do not directly resume the old plan, silently skip Flash, or replay an existing paid request to replace unknown accounting.

## Publication and replay

An earlier staged export was withdrawn after independent review found account names in terminal owner fields. Publication version 1.0.1 regenerated both complete public subpackages from the private originals with explicit terminal-user and whole-token identifier rules. Eight tests include normalized-result/raw propagation, manifest identities, preserved longer public identifiers and actual offline replay. The source analyses and all measured results are unchanged.

The complete public deliverable is [benchmark/results/2026-11-22-pilot-blocked](../benchmark/results/2026-11-22-pilot-blocked/README.md): **311 files, 6,111,827 bytes**, including both complete subpackages, their required transformed raw evidence, exact reservation receipts, accounting, the material summary and the replay code.

Run from the repository root:

```sh
node benchmark/results/2026-11-22-pilot-blocked/replay.mjs
```

Replay verifies every released file, both public subpackage manifests and source locators, reaggregates the normalized statistical results, and recomputes shared accounting. It was executed successfully with Node 26.13.1 and made zero model requests. The private current-plan report also reproduced its source analysis identity independently. An additional publication check scanned all 311 files for 136 known private identifiers, standalone terminal usernames and recognized credential patterns; it found none. Twelve occurrences of the longer public repository identifier remained intact. This check supplements the explicit redaction policy and is not a general anonymity guarantee.

| Identity | SHA256 |
|---|---|
| Release manifest identity | `7daf82a67d93948da25c89e09e5deeffd0e8ec90c44e327b9cc17db5df574e2e` |
| Release manifest file bytes | `5420b4568e536f4783646cc9d5cfc26f5f782c5542242f23be45efbc74ff84c7` |
| Current source analysis | `ec6f6d6b1412837a4cdbf3d2c632f874d86712de744d020e7f56fbc0fb539388` |
| Current public analysis | `a9324ca11b2ffe8eca4c870deb8dea21dde9d3b595301c18af80fcf10599b253` |
| Retained invalid public analysis | `0e06e34ca9ecf989ce42d24314ac49971490ff529c3d68ec269293746279c048` |

Public hashes identify transformed bytes and are linked to original hashes. Public replay does not reconstruct original hash chains, rerun private business grading, or repeat remote materialization. The expanded material summary is an explicitly derived projection of retained private parity proof. Private accounts, credential paths, oracle contents and Notion identities are not part of this publication.
