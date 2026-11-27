# Complementary-Skill baseline and read-only reuse

[Read the report](../../../docs/benchmark-complementary-current-2026-11-27.md).
[The summary](summary.json) records the frozen product, both real observations,
preparation costs, accepted shared verifier and exact private evidence receipts.

This package contains a compact factual summary. It does not distribute sessions,
model payloads, credentials, private oracle data or complete installations.
The commands below use retained Mini originals. They do not promise a portable
replay without those originals or a runnable historical build after retirement.

## Read-only query on Mini

Use the reporting checkout at the accepted publication revision named in
[AH-1217](https://linear.app/yoyooyooo/issue/AH-1217). The summary's verification
receipts bind its actual reporting source files. The frozen execution controller
remains unchanged; it will not acquire this newer `decision` presentation.

```sh
export PATH="/Users/yoyo/.proto/tools/node/26.13.1/bin:/opt/homebrew/bin:/Users/yoyo/.local/bin:$PATH"
BENCH_ENV=/Users/yoyo/Documents/code/personal/notion-skills-environments/benchmark-product-cycle-20261126
BENCH_REPORTER="$BENCH_ENV/broker/benchmark/cli.mjs"
BENCH_BATCH="$BENCH_ENV/control/current-complementary-own-20261127-1/attempt-2"

node "$BENCH_REPORTER" query --root "$BENCH_BATCH" |
python3 -c 'import json,sys; x=json.load(sys.stdin); print(json.dumps({"model_requests":x["model_requests"],"rows":[{k:r[k] for k in ("run_id","validity","outcome","known_actual_attempts","decision")} for r in x["rows"]]},ensure_ascii=False,indent=2))'
```

Expected original result:

| Run suffix | Business | Critical contracts | Overall | Opaque calls |
| --- | --- | --- | --- | ---: |
| `001`, Broker | pass | pass / pass | unknown | 3 |
| `002`, Native | pass | pass / pass | pass | 0 |

The `decision` object separates `overall.outcome`, `business.status`, each
contract's critical flag and status, execution coverage, and source coverage.
`source_readback.status: available` means a registered readback was found and
verified; it does not mean its coverage is complete. Missing legacy readback is
`unavailable` with null coverage and diagnostic lists. Corrupt existing evidence
still fails verification.

To inspect the retained unknown:

```sh
node "$BENCH_REPORTER" query --root "$BENCH_BATCH" --outcome unknown
node "$BENCH_REPORTER" journey --root "$BENCH_BATCH" --run current-complementary-own-pair-2-001
```

Both commands return JSON. `--outcome` continues to filter the overall outcome,
not the business result. The `journey` command's top-level `decision` is the same
current read-only view as the corresponding query row. The returned `text` and `journey` preserve the
original stored timeline, and neither command rewrites `journey.md`, normalized
episodes or grades.

Actual verification exercised these two observations and the older four-run
smart-cache scope with zero model requests. The old scope stays at three overall
passes and one unknown. Each query checks the existing bundle and referenced
raw artifacts; this is not a new private-oracle evaluation.

## Execution and accounting

`current-complementary-own-pair-2` completed its two scheduled slots, in Broker
then Native order, using the existing standing grant and ledger. The final
standing reader reports 245 observations, 34 registrations and no lease.
There are 11 actual model requests, 49,966 input tokens and 1,204 output tokens.
Four earlier zero-model captures cost 68 owned source HTTP attempts separately.

The old `current-library-title-own-20261127-1` two-slot scope was cancelled before
configuration and registration. Do not resume its old pending-configure file.
Its frozen inputs and cancellation evidence are retained. New product behavior
requires a new execution identity; a reporting change requires only a read-only
query against the appropriate originals.

## Evidence and resource disposition

The summary links exact Mini paths and SHA-256 values for the plan, material
binding, original observations, query verification, shared-verifier acceptance,
cancellation and retirement. Raw costs, failed configuration and source-selection
unknown are preserved.

Released source dependencies and build/compile caches enter native system Trash.
Frozen source/controller, SDK, complete product packages, material proof,
actual host snapshots and original run/control/ledger evidence remain available.
The affected build is `evidence_only`; original dependency links are not repaired
or reinterpreted as a full build-check pass. Same-volume Trash has zero physical
capacity credit.
