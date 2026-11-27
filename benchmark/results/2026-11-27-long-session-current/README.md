# Reuse this long-session result

Read the [report](../../../docs/benchmark-long-session-current-2026-11-27.md)
for conclusions and [summary.json](summary.json) for machine-readable current
observations. [historical-context.json](historical-context.json) contains a
separate offline projection of older conditions. Do not pool the two files.

Expected current result: four eight-turn episodes, 97 actual model requests,
32 passing business outputs, 12 passing first-required resource-file checks,
and original overall grades **pass, pass, unknown, pass** in run order. Repeated
Skill input crosses at turn 5 and elapsed time at turn 8, but its Native
legal-selection unknown prevents a full quality-aligned win. Switching crosses
neither measure by turn 8.

## Read retained evidence on Mini

These commands only read the retained batch and write their JSON to stdout.
They do not run a model, refresh Notion material, register a campaign or build
packages. The exact frozen controller is retained even though its build's
source dependencies have retired to system Trash.

```sh
BENCHMARK_ENV=/Users/yoyo/Documents/code/personal/notion-skills-environments/benchmark-product-cycle-20261126
BENCHMARK_NODE=/Users/yoyo/.proto/tools/node/26.13.1/bin/node
BENCHMARK_CONTROLLER="$BENCHMARK_ENV/builds/benchmark-long-session-current-20261127-1/source/broker/benchmark/cli.mjs"
BENCHMARK_BATCH="$BENCHMARK_ENV/control/current-long-session-20261127-1/attempt-2"

"$BENCHMARK_NODE" "$BENCHMARK_CONTROLLER" query --root "$BENCHMARK_BATCH"
"$BENCHMARK_NODE" "$BENCHMARK_CONTROLLER" journey --root "$BENCHMARK_BATCH" --run current-long-session-own-pair-2-004
```

For a small first read, append this standard-library projection to the
`journey` command. It preserves status/value facts instead of printing the
complete evidence graph:

```sh
"$BENCHMARK_NODE" "$BENCHMARK_CONTROLLER" journey --root "$BENCHMARK_BATCH" --run current-long-session-own-pair-2-003 |
python3 -c '
import json, sys
d = json.load(sys.stdin)
t = d["turns"]
def take(m):
    return {k: m[k] for k in ("model_requests_started", "provider_attempts", "input_tokens", "output_tokens")}
print(json.dumps({
    "episode_id": t["episode_id"], "overall": d["decision"]["overall"],
    "actual_totals": take(t["rows"][-1]["cumulative"]),
    "episode_duration_ms": t["episode_duration_ms"],
    "turns": [{"turn_id": r["turn_id"], "marginal": take(r["marginal"]),
               "cumulative": take(r["cumulative"]), "timing": r["timing"]} for r in t["rows"]]
}, ensure_ascii=False))'
```

| Run suffix | Condition | Case | Original overall |
| --- | --- | --- | --- |
| `001` | Broker | switching | pass |
| `002` | Native | switching | pass |
| `003` | Native | repeated Skill | unknown |
| `004` | Broker | repeated Skill | pass |

Replace only the suffix to read another completed episode. In `journey`, use
`turns.rows` for actual turn boundaries and marginal/cumulative observations.
Original episode contracts retain their scope. The turn-bound business view is
not a new complete per-turn grade. Unknown cache, currency or selection facts
must not be converted to zero or pass.

For the underlying verification receipts, resolve paths from `summary.json`'s
`source_receipts`. The main retained control directory is:

```text
/Users/yoyo/Documents/code/personal/notion-skills-environments/benchmark-product-cycle-20261126/control/current-long-session-20261127-1
```

`turn-results-1/final-004/commands.json` records the original five read-only CLI
invocations. `audit-result.json` and `quality-and-observations.json` retain the
full internal derivation; they are not sanitized public payload exports.
`independent-review/` contains independent business, payload, resource and
original-grade checks. `retirement-preparation/final-closeout.json` binds the
exact native-Trash actions and unchanged retained inventory. The ledger's
249 / 35 and null lease are recorded in `ledger-after-models-1.json`.

The build's disposition is **evidence_only**. The original successful paired
check is retained, but its retired source dependencies must not be treated as
an executable development build. Read-only reuse does not establish portable
replay on another machine or replace the broader unfamiliar-Agent pilot.

After retirement, an independent Agent starting from this README successfully
ran the original query and all four journeys with zero Benchmark model calls.
All five stdout hashes matched the earlier audit, and all 32 cumulative input
and elapsed observations matched the published result. Its bounded check is
retained in `cold-readonly-1/receipt.json`; it did not repeat the resource audit
or claim to verify the live ledger.

## Run a later product comparison

Follow [the standing Benchmark entry](../../../docs/benchmark-running.md),
especially **Continuous reuse and task switching**. Select the actual accepted
CLI and Broker product commits, create a fresh owned frozen build, and reuse
the existing standing authorization and ledger. No new runner or ledger is
needed.

Select `long-session-consumption-v1`, the two `long-session-*-a` cases,
16 candidates and 8 rounds. Preserve Common16, Code Mode policy, current-turn
inputs, private turn bindings and ordinary turns. Reuse the verified remote
objects; refresh their readback proof through the selected SDK when that
identity changes. Preserve the 1/2/4/8 actual-session prefixes, every request and
attempt, first-resource delivery and original quality outcomes.

If a comparison needs a formal legal-selection conclusion for shell inventory,
collect its bounded execution proof prospectively. Do not relabel the retained
run `003` or force the model to repeat a preferred tool sequence. A targeted
comparison after a relevant accepted product change is sufficient; these
results do not authorize extrapolation to unrun turns or unrelated model routes.
