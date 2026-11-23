# Collector evidence correction

This package reanalyzes the retained stopped cohort with collector 1.2.0. It contains the same 21 physical executions as the historical release: 20 valid executions and one invalid execution, within the original 32 planned slots. The 12 unresolved slots include the invalid execution and 11 unstarted slots.

The historical release remains at commit aa414f49c57eb1e170a91219d9dd429ada8a12db under benchmark/results/2026-11-22-two-model-continuation/cohort-3-expansion. Its manifest and score identity are recorded in collector-correction-provenance.json. This corrected package replays independently. The locally regenerated baseline is verification material and is not required for publication or replay.

## Result changes

| Measure | Historical analysis | Corrected analysis |
|---|---:|---:|
| Complete contract pass among valid executions | 2 | 6 |
| Complete contract fail among valid executions | 2 | 2 |
| Contract result unknown among valid executions | 16 | 12 |
| Business output pass among valid executions | 18 | 18 |
| Business output fail among valid executions | 2 | 2 |
| Invalid executions | 1 | 1 |
| Planned slots | 32 | 32 |

Only executions 003, 004, 013, and 017 change from unknown to pass. The collector can now recognize complete native child-call evidence and verified short-reference resource delivery when retained bytes and identities match. It does not infer resource consumption from shell source or correct business output.

Execution 007 remains unknown because the binary read receipt is missing. Executions 012 and 014 retain failed bash descendants. Execution 018 retains two failed reads caught by its parent. These parent calls do not establish complete source effects.

All 1,433 protected original files remain byte-identical. Execution identity, admission, attempts, usage, stop decisions, business results, protocol, normalizer, and grader are preserved. Derived evidence references and score identities change with the new analysis.

## Analysis identities

| View | Source analysis SHA-256 | Public analysis SHA-256 |
|---|---|---|
| Historical published | f47f7d9f187d6c9bed0d89b88ea3e6c143ef71ccd82266687b59de0bd74300ed | 0abbb0ae7d6498745a1f4d1cb64481b317d2e0fe9345ffc4eadd43efa2b38fad |
| Corrected | 41204d09b6f5229ccd60fed39c6ba29aafd209ef9274497073e1d2e1cebdf437 | 2cd000e056067cf7a42819ebbcf7f725458f4c26494813b82917444effe26d8c |

The old and corrected views describe the same executions. Do not add their sample counts. The corrected package does not require a second baseline package.

## Offline verification

Run node collector-correction/replay.mjs from the directory containing the corrected package, or node replay.mjs from inside it. The prepared independent replay passed with network access denied, private source file contents denied, and no inherited credentials. Node was allowed to inspect path metadata. The private plan read probe returned an access error.

The replay verifies public file hashes and source locators, then recomputes statistics from normalized observations. It does not rerun the private grader or reconstruct the raw evidence chain. The runtime evidence binds reviewed CodeMode wrapper modules, not the complete SDK or operating system. Short-reference evidence proves matching bytes and identity; SDK causal association remains unproven.

The original release and this corrected view remain separate. Export and replay made no new subject model request and did not register a live campaign revision.
