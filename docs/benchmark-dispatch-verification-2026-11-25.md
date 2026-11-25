# Dispatch verification and deadline repair

The retained campaign reached 104 closed observations. The first invocation of
the 24-slot CodeMode allocation requested at most eight observations and completed
seven. It closed with `batch_budget_exhausted`; the outer driver then rejected the
valid seven-observation prefix because it expected exactly eight. The original
driver, ledger and observations remain retained.

The [published result report](benchmark-observer-repair-continuation-2026-11-25.md)
records that boundary. The [engineering continuation contract](benchmark-engineering-window-continuation.md)
describes the separate 35-observation proposal and its approval requirements.

## Verification work

The dispatch path previously repeated overlapping full-history proofs. The repair
combines the current scope check and reservation proof into one verification
entry point. It still validates registration bytes, canonical identities,
successor links, every required historical accounting prefix and the original
stop and usage predicates. The final historical proof covers the required owner
intervals; an ancestor prefix does not disappear when a later registration is
checked.

The proof remains fresh at the execution boundary. Verification before the lease
and verification after acquiring the lease remain separate. No proof is reused
across a dispatch boundary through a persistent cache.

After potentially expensive verification, the runner rechecks both the model
window and the invocation deadline before creating a reservation. The same guard
applies when an exclusive reservation attempt encounters an existing file and
advances to another ordinal. The model window includes its start and excludes its
end. A proof that started inside the window cannot authorize a reservation after
the window has expired.

## One retained-history comparison

The comparison used the same actual 104-observation history, 13 registrations
and original seven-observation CodeMode prefix. The old side called the original
scope check followed by its reservation proof. The new side called the combined
dispatch verifier.

The new comparison source copied the frozen private source and overlaid only
`batch.mjs`, `campaign-dispatch.mjs` and `finite-campaign.mjs`. The original private
collector 1.1 remained byte-identical. This comparison does not measure the public
collector 1.2 or the later version 7 continuation implementation.

| Instrumented measurement | Old path | Combined path | Reduction |
| --- | ---: | ---: | ---: |
| Elapsed time | 1,041,073.195 ms | 187,808.351 ms | 81.96% |
| Successful Node `readFile` calls | 6,367,959 | 1,257,184 | 80.26% |
| Logical bytes returned by those reads | 123,991,264,321 | 25,181,597,308 | 79.69% |
| Unique normalized read paths | 67,321 | 67,321 | 0% |

All 67,321 normalized input paths had the same byte length and SHA-256 digest.
There were no missing, additional or changed inputs. Both paths returned the
same amendment file and canonical amendment identity. The reservation,
registration and ledger boundary remained unchanged. The complete 3,491-file
source copy was checked again after the proof.

An independent reviewer recalculated the read summaries, verified the retained
boundary files, checked both execution implementation closures and compared the
three overlaid modules with their reviewed Git blobs. The reviewer inspected the
recorded proofs without running the historical proof again.

This is one successful instrumented old/new pair. Hashing and read accounting
add work, and operating-system caches and ordinary concurrent activity can affect
elapsed time. Logical bytes are not physical disk I/O. Git subprocess reads,
metadata queries and path resolution are outside the read counter. The result
does not establish a production latency distribution or faster model inference.

Two failed preparation attempts remain in the private evidence: an initial old
probe lacked sandbox access to `/dev/null`, and an initial new probe selected the
public collector instead of the retained private collector. The latter was
rejected by the instrumentation identity guard. Neither failed attempt contributes
to the successful timing comparison.

## Evidence and operational limits

The private comparison receipt has SHA-256
`85ce55dd35bc80b1e7c40a08f25244e9f7429e073d53ff67e5d7a10c5706e472`.
The independent actual-history review has SHA-256
`173cdc7b4b6cbea9a9ec307e05ebdcfef0a91458407a86fa11366280e157fd32`.
These receipts retain private source locations and are not included in the public
result bundle.

Focused mutation and deadline fixtures accompany the source change. They cover
historical identity changes and deadline expiry during verification, including
the exclusive reservation path. Passing the retained-history comparison is
combined with those fixtures; it is not a proof over every possible future input.

The comparison created no authority, scope, startup capture, reservation or model
request. It did not change any retained result. The new continuation must preserve
that history, use the exact never-started suffix and obtain its separately
approved model window before execution.
