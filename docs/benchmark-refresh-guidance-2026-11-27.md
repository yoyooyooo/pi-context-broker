# Refresh intent comparison: 2026-11-27

The refresh-guidance candidate is **not adopted in this cycle**. All four planned real-model observations pass their business and consumption checks, but both product conditions make the same refresh choices. The fuller instruction adds 198 bytes to the canonical request without a corresponding observed benefit. [Product PR #105](https://github.com/yoyooyooo/pi-context-broker/pull/105) is closed without merging or deployment. Its branch, failed revisions and frozen observations remain available.

This decision is limited to the small comparison below. It does not prove equivalence or the absence of a population effect, and no additional samples were requested to obtain a win. The [thin evidence index](../benchmark/results/2026-11-27-refresh-guidance/README.md) binds the report to the original Mini artifacts.

## Question and fixed inputs

The preceding [current-product baseline](benchmark-current-product-baseline-2026-11-27.md) found substantial source acquisition waits. Its two Broker agents explicitly refreshed metadata, but ordinary named Skill application does not itself require a forced refresh. This candidate clarified that default and the exceptions for existence/availability questions, writes and current/latest requests. It changed two public strings, without changing execution, caches, selection or fixed-version logic.

The comparison uses the existing `explicit-01-a` and `continuation-01-a` Common16 cases, sixteen candidates, Broker/off in both conditions, and one repetition. The original prompts, input inventories, oracles and material binding are unchanged. The continuation prompt says current rules; explicit refresh is permitted there. Its second turn must retain the selected policy. These four observations define this decision, not a resource or authorization quota.

| Input | Identity |
| --- | --- |
| Reference build | `next-product-runtime-20261127-2` |
| Reference build manifest SHA256 | `e7240fad568c9254187586d30deb2102011e7411b5330291133e8bfad55f36e5` |
| Candidate build | `next-refresh-guidance-20261127-1` |
| Candidate build manifest SHA256 | `edbe808dcfb3f2af3aa55defe779f6f342132ca90ceea4b96ed45b0a76925d22` |
| Candidate frozen Benchmark source | `6e0656f5c4a0126fefe3f26628521f999b64323e` |
| Product runtime revision | `b9de8bf0b41d8f38d248dac29f52d05f70728217`; production files unchanged at final PR head `b90e122de6ed2b465d93b2df35cb70769ae96147` |
| CLI source | `c605b25422def495c91069aefc54d24c50d284ae`, complete tree equal to accepted `a22aa1cd5506d393df6ef4d37a6aeb7c575453ba` |
| Shared controller SHA256 | `5e7e0a20d2f1eeda84a02375e112060ed2e79377577ef2d66ea3c8e532771e37` |
| Collector | `1.3.5` |
| Plan internal SHA256 | `019467268a5cb6855335c1d68f4dfc27dc2beae9fb08cb2e75da7617d583aefc` |
| Plan file SHA256 | `49d78a518ef67e548ce6ff93befb96ba687957679d7678a5901290c8090d8f3a` |
| Selected public and installed SDK SHA256 | `fd4384cf70e3e9334d94106b1b0aa5e72b3c2dccfc97bb77321e9cb9e93434f1` |
| Runtime / model condition | Node 26.13.1, Pi 1.6.0; `magpie/auto/gpt-6.2-sol`, high |

The provider route label is not backend attestation. Both arms use the same new frozen controller; the reference's public subject and turn-runtime files were verified unchanged. The existing read-only material proof applies to both identical SDKs, so it was not refreshed again.

## What the model actually received

Both zero-model captures pass. They load the selected packed `src/index.ts` entry, expose the same tools, and observe the same complete sixteen-item catalog and directory. Both have zero provider attempts and zero model usage. The public subject projection, including the paired reference artifacts, is identical.

Canonical requests differ in exactly the two intended strings:

| Field | Reference | Candidate | Difference |
| --- | ---: | ---: | ---: |
| Refresh parameter description | 239 B | 444 B | +205 B |
| `notion_list` guidance line | 212 B | 205 B | -7 B |
| Appended guidance message | 1,503 B | 1,496 B | -7 B |
| Canonical request contract | 14,480 B | 14,678 B | +198 B |

The system-prompt field itself stays at 2,355 bytes. Actual captured serialized input is 15,047 versus 15,247 bytes; those inputs also contain each capture's independent runtime references. The earlier static claim that the guidance line was equal in length was incorrect. The actual capture corrected that expectation before model execution, without rewriting the frozen plan.

## Actual outcomes and costs

All six output files were independently reread and compared with their original oracles. All twenty rows match, as do the output hashes recorded by collection. All fourteen applicable contracts pass, including ten critical contracts. Metadata producers are verified, and reported provider-error counts are zero.

| Case / condition | Run suffix | Model requests | Full input tokens | Full output tokens | SDK-owned HTTP | Episode duration |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Explicit / reference | `001` | 5 | 20,898 | 310 | 79 | 71.041 s |
| Explicit / candidate | `002` | 5 | 20,905 | 313 | 79 | 70.442 s |
| Continuation / candidate | `003` | 8 | 35,600 | 520 | 145 | 125.723 s |
| Continuation / reference | `004` | 8 | 35,297 | 579 | 152 | 117.294 s |

The run prefix is `current-refresh-guidance-own-pair-1-`. Total usage is 26 model requests, 112,700 input tokens and 1,722 output tokens, with 24 tool calls and no model retries. Monetary cost remains unknown/unpriced. Unavailable cache and reasoning breakdowns remain unknown; full input and output totals are known. The ledger ends at 239 observations and 32 registrations, with this comparison at ordinals 236–239 and no outstanding lease.

Both explicit agents omit `refresh` on `notion_list` and `notion_use`. Each performs 36 startup HTTP requests, zero requests for the cached metadata list, 24 for consume and 19 for the resource read. The previous baseline's forced-refresh observation is not substituted into this new pair. The candidate's 0.599-second shorter duration does not establish a speed improvement.

Both continuation agents set `refresh: true` on list and use for the original current-rules request. Both then use only input read and output write tools in turn 2, with no new policy resource read or adoption. Candidate turn 2 uses three requests and 14,431 input tokens; reference uses three and 14,376. The selected-policy reuse contract is preserved in both.

## Why seven fewer HTTP requests are not a win

Before turn 2, both continuation runs perform the same 132 SDK-owned HTTP requests: 36 at startup, 36 for the agent's metadata refresh, 17 for the list preceding refreshed use, 24 for consume, and 19 for the resource read.

Each then starts a non-tool directory list during turn 2. The candidate's operation is cancelled after thirteen HTTP requests and has no result value; the reference's operation completes after twenty. This accounts for 145 versus 152 total requests. Neither model requested that extra list. Its completion/cancellation boundary does not show that the candidate improved refresh choice or useful work.

The candidate's earlier explicit directory result was fetched at 05:13:02.655 UTC with a 60,000 ms maximum age. Its non-tool list starts at 05:14:17.791 UTC, 75,136 ms later. The intervening list associated with use returns a catalog result, while consume reports a one-hour content freshness interval and the resource read is pinned/local-snapshot. These observations locate the extra work and distinguish it from a consume/resource TTL refresh. They do not independently prove the triggering call path or that all such requests can be removed. The operation/freshness readback retains exact JSON pointers and hashes.

Startup and admission are included in episode duration. SDK operations can overlap model work, so their intervals are not added as independent wall-clock costs. The candidate continuation takes 8.429 seconds longer in this pair. No general speed, reliability or lower-refresh-probability claim follows from either duration difference.

## Validation and retained failures

The first product revision exceeded the unchanged 1,500-byte guidance budget in an existing tool combination. The next revision passed that budget but exposed an old View-scope assertion still attached to the compact guidance. The final test-only revision checks the unchanged View scope on the actual complete registered tool description. All four required checks pass at final PR head `b90e122d`; these passes do not themselves justify adopting the product change.

The first local focused invocation omitted the existing `prepare:ref` prerequisite and failed because the selected CLI reference artifact was absent. That failed run remains unchanged. A separate invocation prepares the real selected reference first, then passes 36 collector tests and 82 product tests. One optional historical collector test is not selected. The selected runtime and frozen build remain unchanged.

Collector 1.3.5 adds the reviewed complete candidate producer tuple so both original conditions can be interpreted without weakening entry, ownership, directory or mixed-hash guards. The ordinary Benchmark product source returns to the accepted runtime after the decision; preserving a reviewed historical tuple does not adopt that product candidate.

## Reuse and retirement

The original control scope is `control/current-refresh-guidance-own-20261127-1` under `/Users/yoyo/Documents/code/personal/notion-skills-environments/benchmark-product-cycle-20261126`. Use its `operator-results.json`, `operation-freshness-readback.json`, `operator-closeout.json` and frozen `attempt-1/plan.json` to navigate a specific question. The two captures and four real runs all use `command_source: none`; none has a complete `run/source` copy. Their original evidence remains separate from earlier baselines.

The operator releases the complete candidate-runtime consumer at 2026-11-27 05:26:15.665 UTC. Current resource dispositions are recorded separately from immutable build/run identities. Both ended focused runs have already retired their four source/tmp directories, totaling 802,224 KiB, through system Trash while preserving 619 run files and the exact modified inputs. Same-volume Trash is reversible retirement, not physical space reclamation. Later replay of an evidence-only environment requires a newly identified build; the presence of an original manifest is not a promise that its old path remains runnable.

The rejected candidate is now evidence-only. Its two source dependency trees and build-state cache, totaling 590,696 KiB, have moved to Trash after retaining eleven unique cache logs; 32,196 retained entries are unchanged. The separate GUIDE source pair has also retired, totaling 96,080 KiB, after preserving and verifying all Git refs/reflogs and the self-contained control records. These closures preserve original identities and explicitly do not claim a complete runtime replay or physical-space recovery. The original build2 remains complete only for the named next accepted-cache comparison.

The current product question returns to actual source acquisition and reuse. CLI [PR #40](https://github.com/yoyooyooo/notion-skills-cli/pull/40) merged after this comparison was frozen; its Broker integration is [PR #107](https://github.com/yoyooyooo/pi-context-broker/pull/107). Those changes and their existing three-machine delivery have separate ownership and identities. A subsequent Benchmark comparison must bind the actually accepted pair and its SDK proof. This report does not relabel the guidance observations as cache evidence or claim that a newer product has already passed.
