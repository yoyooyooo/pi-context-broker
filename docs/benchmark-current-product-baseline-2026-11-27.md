# Current product baseline and source latency: 2026-11-27

Four actual Pi model observations establish a current, packed-installation baseline for the accepted SDK3 / Library product pair. All six business output files and twenty rows independently match their frozen oracles. All fourteen applicable contracts pass, including ten critical contracts. Broker reuses the selected policy in the second turn of the continuation case, but both Broker journeys spend substantially more time acquiring source data than their native counterparts.

The next product question is concrete: reduce unnecessary source requests and waits while keeping current-version eligibility, permissions, complete resource delivery and accepted session pins. The existing [smart-cache implementation, AH-1329](https://linear.app/yoyooyooo/issue/AH-1329), already owns the underlying validity and reuse changes. This cycle supplies a baseline and exact follow-up conditions to that work; it does not open a second cache implementation or claim that its pending candidate has been adopted.

The [thin evidence index](../benchmark/results/2026-11-27-current-product-baseline/README.md) binds the summaries to original Mini files. It deliberately does not replicate the complete environment or claim to be a portable sealed replay package.

## Product and execution identity

The CLI task commit `c605b25422def495c91069aefc54d24c50d284ae` has the same complete tree as accepted `a22aa1cd5506d393df6ef4d37a6aeb7c575453ba`. [CLI PR #39](https://github.com/yoyooyooo/notion-skills-cli/pull/39) brings those accepted changes into `benchmark`; its actual merge is `d906f7ca554e6d3a3651e62c72c95d943567b113`.

Broker product runtime corresponds to `3d57426c237def82833a86eda367e476e28cd76c`. Subsequent shared PR #102 adds verification and pairs the CLI without changing runtime source; [PR #103](https://github.com/yoyooyooo/pi-context-broker/pull/103) changes source projection for isolated builds. The original model run used Benchmark task source `283b2f73dbbcb83526d93ed8890b792ab0046562`. [Broker PR #104](https://github.com/yoyooyooo/pi-context-broker/pull/104) carries the accepted shared changes and the necessary Benchmark repairs into the ordinary `benchmark` branch.

| Input | Actual identity |
| --- | --- |
| Frozen packed build | `next-product-runtime-20261127-2` |
| Build manifest SHA256 | `e7240fad568c9254187586d30deb2102011e7411b5330291133e8bfad55f36e5` |
| Controller closure | 88 files; `f5294480c5a07c3c261ee40a0a8491239c13f9daca7c0fc5e937172163ac9ec9` |
| Plan file SHA256 | `2da57c6d26a084bf47d7548608bf476c532e901510a140034a45345499cc5eb0` |
| Plan internal SHA256 | `0e01ebc6c084f133f41863cc7f69e686153cdd17b06df64aa12b05d9f290bb14` |
| Original collector | `1.3.3` |
| Selected public SDK SHA256 | `fd4384cf70e3e9334d94106b1b0aa5e72b3c2dccfc97bb77321e9cb9e93434f1` |
| Actual runtime | Node 26.13.1; Pi 1.6.0 |
| Model condition | `magpie/auto/gpt-6.2-sol`, high; reported alias `group/auto-gpt-6-2-sol` |

The provider alias does not attest a fixed backend model. Existing Common16 material and its current read-only SDK proof were reused. The initial proof refresh took about 322.5 seconds, created no new remote Library and performed no repair or semantic remote write. Both candidate builds select the same SDK hash, so the material did not need another remote refresh when the installation identity repair required a new build.

This is guided independent-operator reuse with explicit environment and input pointers. It does not establish Project-only unfamiliar-Agent onboarding or completion of AH-1228.

## Observed business and resource outcomes

The design has two existing development cases, Native/off and Broker/off, sixteen candidates and one repetition per condition. These are four descriptive observations, not an estimate of general superiority or reliability. The finite design is not a token or cost quota.

| Case / condition | Requests | Full input | Full output | Episode duration | Contracts |
| --- | ---: | ---: | ---: | ---: | --- |
| Explicit / Native | 4 | 13,566 | 364 | 14.922 s | 3 / 3 pass |
| Explicit / Broker | 5 | 20,682 | 339 | 89.918 s | 3 / 3 pass |
| Continuation / Broker | 8 | 35,205 | 552 | 111.624 s | 4 / 4 pass |
| Continuation / Native | 8 | 29,876 | 640 | 26.974 s | 4 / 4 pass |

The four actual run IDs are `current-product-native-broker-pair-3-001` through `004`, in table order. Total usage is 25 requests, 99,329 input tokens and 1,895 output tokens. Full input includes cached input and full output includes reasoning where reported by the provider's full totals; unavailable breakdowns remain unavailable. Monetary cost is unpriced, not zero. There were no model retries or observed human/model interventions.

Both explicit journeys selected and consumed the requested Skill and its exact refund resource before producing the expected approve/review/reject/reject decisions. Both continuation journeys produced the expected express/standard/care routes for both batches.

Broker continuation read the policy during turn 1 and used only input read and output write tools in turn 2. Native read both its SKILL.md and routing resource again in turn 2. Broker's second turn used three requests and 14,226 input tokens; Native used four requests and 16,366 input tokens. That observed reuse is useful, but does not offset Broker's higher total input or source latency in this pair, and is not a general efficiency result.

Both Broker metadata producers are verified against the actual packed package. Each `notion_list` is classified as metadata only, without counting it as instruction adoption. Opaque tool and unmatched-read counts are zero in these four journeys. Other unavailable measurements retain their original status.

## Where the time went

The decomposition below uses original monotonic event timestamps. Model intervals run from `model_request_start` to `request_usage_accounted`, including adapter bookkeeping; they are not a measurement of provider compute alone. Tool time is the union of tool-call intervals, so concurrent reads are not double counted. Startup includes preparation and Benchmark admission before the first user turn; it is not a direct measurement of an ordinary UI's first-keystroke latency.

| Condition | Startup / admission | Model intervals | Tool interval union | Other observed time | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Explicit / Native | 0.736 s | 14.133 s | 0.010 s | 0.043 s | 14.922 s |
| Explicit / Broker | 25.317 s | 18.455 s | 46.019 s | 0.128 s | 89.918 s |
| Continuation / Broker | 25.489 s | 34.782 s | 51.053 s | 0.300 s | 111.624 s |
| Continuation / Native | 0.704 s | 26.020 s | 0.019 s | 0.230 s | 26.974 s |

Broker explicit has these sequential SDK source intervals:

| Operation | Observed SDK time | Notion metadata / body requests |
| --- | ---: | ---: |
| Startup list | 23.523 s | 34 / 2 |
| Agent list with `refresh: true` | 21.914 s | 34 / 2 |
| Skill consume | 13.736 s | 22 / 2 |
| Resource read | 10.223 s | 17 / 2 |

That is 115 observed SDK-owned Notion HTTP requests. Continuation has 132, including an extra list of 17 requests and 8.819 seconds under `notion_use(refresh: true)`. These totals come from sequential SDK operation receipts, with zero reported retry waits; they are not claims of exhaustive arbitrary-child transport visibility. `duplicate_requests` is an observer signal, not proof that each duplicate is semantically removable.

The first Broker requests contain a pending-discovery notice, followed by the user's request to apply a named Skill. Both agents choose explicit list refresh; one also requests refresh on use. The public existence-query guidance and the agent's refresh choices should be reviewed together, but these two observations do not establish a causal prompt defect. Keep an ordinary no-refresh path and an explicitly requested refresh path distinct in the next comparison.

The current product gap is therefore source acquisition and reuse under actual user choices. A new cache candidate must preserve complete resource and permission contracts, account for startup/background/Library traffic, and report whether it saves requests on the same path. It must not claim a speed improvement by silently removing the requested refresh or changing the task.

## Measurement repairs and retained originals

The first configure attempt made zero model sends and failed because a `$BUILD/broker/` path substring was used to recognize the Broker extension. The actual packed install was under `installed/broker/node_modules/pi-context-broker/src/index.ts`. The related collector assumption would also have degraded the correctly loaded producer to unknown.

The repair binds the selected package entry, declared launch role, actual loaded canonical path and exact hash. Directory and packed installations use the same ownership check. Metadata verification still requires the complete reviewed producer tuple, tool ownership, admission and actual source directory. A further negative guard requires the reviewed entry's original relative `src/index.ts` location, preventing identical entry bytes moved beside an unreviewed relative import from borrowing the tuple. The actual frozen entry meets that guard; no original manifest, controller, score or model call was replaced.

The first failed capture and a later unexecuted input-label correction remain separate originals. The latter corrected a mistaken historical collector label before any configure, registration or model send. The successful run uses attempt 3 and its own frozen identities.

Original collector 1.3.3 marks 24 reported-model records with `provider_error: true`, although all 25 responses have matched reported identity, complete usage and successful assistant results. The original transport retains HTTP 200 responses with SSE DONE followed by consumer cancellation. The follow-up interpretation uses the existing strict provider application-completion contract; raw errors, incomplete streams and missing identity or usage evidence cannot be excused as successful completion. Collector 1.3.4's separate sidecar verifies all 25 original responses: 24 satisfy completed-SSE-before-cancel and one has ordinary HTTP completion. The interpreted provider-error flags change from 24 to zero, while all reported model matches remain unchanged. One retained episode also passes the complete collector, normalization, grading and bundle verification path, with business validity, four requests, 13,566 input tokens, 364 output tokens and 14,921.751042 ms unchanged. All 33 checked original files retain their hashes. No model replay was needed.

The final isolated command gate runs the collector, manifest and metadata suites against hash-pinned changes in an owned writable source copy: 82 tests pass and one pre-existing optional retained-run test is not selected. The frozen build and selected runtime remain unchanged. The four newly executed real journeys and the one targeted full offline collection provide current actual-artifact coverage; the optional historical test is not a reason to rerun a historical matrix.

## Reuse and environment retirement

Use [the maintained daily iteration entry](benchmark-running.md#daily-product-iteration), the same standing authorization and the authoritative ledger. At completion the ledger contains 235 observations and 31 registrations, with this cycle at ordinals 232–235 and no outstanding lease. Do not recreate the ledger or resume a completed plan for a changed product.

The current environment root is:

`/Users/yoyo/Documents/code/personal/notion-skills-environments/benchmark-product-cycle-20261126`

Its control entry is `control/current-product-baseline-20261127-1`; the actual plan is `attempt-3/plan.json`, the runner receipt is `runner-3/receipt.json`, and the original summaries include exact file hashes. The separate `control/current-next-cycle-20261127/latency-attribution.json` binds the decomposition to event lines. This report and the thin index are sufficient navigation; inspect the original artifact needed for the next decision instead of copying the entire environment.

All four captures, including the initial failure, and all four model runs use `command_source: none` and `source_disposition: not_copied`. None creates a complete `run/source`. The eight runs occupy about 52.42 MB logically; current control and checkpoint analysis occupy about 96.10 MB, and refreshed material about 3.27 MB. These unique raw records remain useful.

Shared PR #103 excludes only Broker's root `benchmark/results` from new source snapshots, using the same selection for capacity estimation and copying. CLI source and Benchmark runtime/tests remain included. The excluded archive in this checkout contains 20,469 files and 1,130,638,235 logical bytes; this avoids repeating that history in every new build, without deleting the canonical archive or rewriting old manifests.

Completed test copies and superseded dependency/cache trees are retired separately after their consumers finish. The prior PEER environment's two source checkouts were preserved in verified Git bundles with their unique refs and ignored files, then moved to system Trash. Original failed attempts, results, raw evidence and retirement receipts remain. Same-volume Trash is reversible retirement, not proof of physically reclaimed disk space. Full automatic lifecycle handling remains AH-1262 work; a manually reviewed retirement is not relabeled as a successful automatic closeout.

No new end-user runtime was deployed by this Benchmark synchronization or engineering repair. The ordinary three-machine generation observed during closeout remains `a53f0b8281ff-3d57426c237d`; a future adopted smart-cache runtime needs its own actual three-machine delivery and readback. Historical product adoption, this baseline and future candidate observations retain separate identities.
