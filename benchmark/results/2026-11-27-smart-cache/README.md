# Accepted smart-cache comparison evidence: 2026-11-27

[Read the report](../../../docs/benchmark-smart-cache-2026-11-27.md). The original four observations are complete: **4 valid, 3 pass / 0 fail / 1 unknown; 13 of 14 contracts pass, all 10 critical contracts pass; 6 business files / 20 rows match the frozen oracles.** The remaining legal-selection unknown follows an opaque `bash ls -a` call and remains unchanged.

## Files

- `comparison.json` is a compact field projection of the frozen operator readback, with actual order/roles, usage, phase times, output hashes/values, condition SDK proof references, operation receipts and freshness fields. It is not a new scoring result.
- `daily-adoption.json` projects the already existing three-machine adoption/warm-check readback. Its controlled-loopback evidence and limits stay distinct from the natural-model comparison.
- `build-identity.json`, `root-model-gate.json`, `condition-bindings-verification.json`, `final-ledger.json` and `bundle-verification.json` are exact copies of small original receipts.
- `index.json` records copied-file hashes, projection provenance and the original Mini absolute paths/hashes. Large original operator and artifact indices are referenced without copying them here.

All 26 requested model attempts and 533 SDK-owned HTTP requests belong to the four original episodes. Explicit foreground HTTP is unchanged. Continuation's 152 versus 151 total is the background list's completed/cancelled boundary; it is not established cache improvement. Monetary cost is unknown. The original warm-consumption evidence is not contradicted by this isolated/actively-refreshed comparison.

## Preservation and reuse

This directory excludes raw requests, sessions, archives and source trees. It is a navigation index, not a sealed portable replay package. Exact reanalysis requires the original evidence and frozen implementation/material closure, including each condition's own SDK proof. Do not relabel the retained unknown, pool the prior guidance runs, or relax the SDK guard.

## Read-only query on Mini

Use the maintained Node runtime and the original frozen controller. The following
command verifies retained artifact references and reads the existing normalized
results. It sends no model requests and does not rerun the private business oracle.
It keeps the output small without changing the evidence reader.

```sh
python3 - <<'PYQUERY'
import json
import subprocess
from pathlib import Path

root = Path("/Users/yoyo/Documents/code/personal/notion-skills-environments/benchmark-product-cycle-20261126")
cli = root / "builds/next-smart-cache-20261127-1/source/broker/benchmark/cli.mjs"
batch = root / "control/current-smart-cache-own-20261127-1/attempt-1"
result = subprocess.run(["node", str(cli), "query", "--root", str(batch)],
                        check=True, text=True, stdout=subprocess.PIPE)
data = json.loads(result.stdout)
fields = ("run_id", "condition_id", "outcome", "known_actual_attempts")
usage = ("known_subtotal", "observed_items", "total_items")
rows = [{**{key: row[key] for key in fields},
         "input": {key: row["input_total"][key] for key in usage}}
        for row in data["rows"]]
print(json.dumps({"model_requests": data["model_requests"], "rows": rows},
                 ensure_ascii=False, indent=2))
PYQUERY
```

Expected retained result: four rows, three `pass`, one `unknown`, and
`model_requests: 0`. A missing original is a real reuse limitation; do not create
a new build or substitute another SDK merely to make this query pass.

An independent Agent started from the project links, located the Mini evidence
without receiving historical paths, checked all 89 frozen controller files and
successfully used this entry. Its four verified bundles referenced 935 artifacts
in total; shared references can repeat. See `cold-reuse.json` for the original
readback, navigation cost and scope. The reported 0.381-second query is not the
whole navigation time. This establishes retained-evidence access, not a new
natural-model pilot or portable replay without the Mini originals.

The full-build consumer ended at 2026-11-27T07:03:51.601Z. Build retirement is not asserted here; root will add later disposition receipts. Original path references alone do not imply that an old runtime remains executable after retirement.
