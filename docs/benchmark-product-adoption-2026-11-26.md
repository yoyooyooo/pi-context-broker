# Product adoption from the SDK3 Benchmark cycle

The accepted product change removes two duplicated refresh tutorial sentences
from Broker's `read` description and restores its full tool contract when the
ordinary Pi profile uses compact-ui 0.1.3. The product was accepted through
[PR #94](https://github.com/yoyooyooo/pi-context-broker/pull/94). The current
pair is CLI `ba092a531a64633c31e648b4f9f806e606a78f4e` and Broker
`c3a880071996429e615bd66de74b86b462c669c3`.

## What changed and why

The original full Broker description repeated refresh instructions already
present in the tool and adoption contracts. The final change deletes exactly
219 UTF-8 bytes and preserves every other description byte, parameter and
execution path. An earlier, wider 355-byte candidate remains a separate
experiment. The final conservative comparison measured a first request with
39 fewer provider input tokens; it does not establish general token or time
savings.

Ordinary-profile checks then found that compact-ui registered a replacement
`read` with a 54-byte description and only `path`, `offset` and `limit`.
Existing single-path delegation still worked, but the model could not discover
the complete batch and reference contract. The scoped compatibility package
uses Pi's public read renderer API while leaving logical tool ownership intact.
Its other six tools, grouping and user preferences remain in place. The
[reproducible compatibility guide](compact-ui-read-compatibility.md) includes
the upstream integrity checks, minimal patch and actual Pi validation entries.

## Evidence and decision boundary

The [original SDK3 cycle](../benchmark/results/2026-11-26-sdk3-read-description-cycle/README.md)
retains the invalid zero-send observation, six v1 model episodes, their
report-only reanalysis and the separate two-episode v2 pair. The v2 pair passed
both business tasks and all four critical contracts. Its two full formal
outcomes remain unknown because arbitrary shell visibility cannot establish
exhaustive absence. No original result was overwritten.

After additional shared changes reached next, the
[current native/Broker baseline](../benchmark/results/2026-11-26-latest-next-adoption/README.md)
used the refreshed existing Common16 Library and a new frozen build. Its
product and dependency files were checked against the pure next paired build:
13,114 regular files matched; the only package differences were two readmes and
the per-build source provenance receipt. The product archives were separately
packed, privately installed and checked against their declared members.

Both latest episodes passed their business and critical resource contracts.
Native is a full pass; Broker remains unknown after an extra shell call failed
because `rg` was unavailable in the isolated environment. The Broker then
completed the legal main/resource chain and wrote the correct output. Its
metadata producer was verified, and there were no unmatched reads or lineage
errors. Actual durations were 22.910 seconds and 134.936 seconds. The report's
180,000 ms Broker capped-time value is an analysis statistic, not elapsed time.
These observations do not establish an overall speed improvement.

The prospective policy permits this narrow adoption decision from positive
critical contracts while preserving the formal unknown. Actual Pi registry and
dispatch checks covered both extension orders and a third-party read owner;
UI checks covered pending, success, error, batch, grouping and expanded states.
They complement the model evidence and the ordinary-profile delivery checks.

## Daily delivery

Generation `ba092a5-c3a8800` is installed and verified on all three hosts.
Each host used the same CLI/Broker archives, a platform-local installation and
a fresh ordinary Pi process. The ordinary CLI resolves to that generation.

| Host | Before | Adopted contract | State |
| --- | --- | --- | --- |
| Pro | Broker, 1,091 B, 7 parameters | Broker, 872 B, 7 parameters | Verified |
| Mini | compact-ui, 54 B, 3 parameters | Broker, 872 B, 7 parameters | Verified |
| imile-win | compact-ui, 54 B, 3 parameters | Broker, 872 B, 7 parameters | Verified |

The description reduction applies to the existing full Broker contract. On
Mini and imile-win the benefit is restoration of `paths`, `from`, `budget` and
`refresh` with the required guidance. Those profiles gain necessary information;
their transition is not a net 219-byte reduction.

All three ordinary processes used Node 26.13.1 and Pi 1.6.0, produced zero model
events and exited normally on EOF. Mini and imile-win replaced their existing
compact-ui slot; the other six tool owners and UI preferences were verified.
Pro had no compact-ui slot and did not acquire one. Other settings were
semantically preserved, and previous settings and CLI targets remain backed up.

The per-host `adoption-receipt.json` files are retained in each generation;
their exact identities are:

| Host | Receipt SHA256 |
| --- | --- |
| Pro | `1b424885a465a243983c5172f8dbc7bc555e7b211751f997bac143e354d14c48` |
| Mini | `2d6d3dde611ab3d41e6b55579af9bcb245618479b5acb8e62504500681291f0d` |
| imile-win | `2ab6d4b5520838e1c415819430265e3e7d81e6f572385487120733f50fdd2b7f` |

## Reuse the capability

Start from [Daily product iteration](benchmark-running.md#daily-product-iteration)
and the [standing execution contract](benchmark-standing-campaign.md). Reuse
the existing grant, ledger, applicable material and explicit build identities.
Public evidence packages replay without credentials or model requests. New
product behavior needs a new declared execution condition; interpretation-only
repairs use retained originals.

A separate agent with no inherited task history recovered the direction and
version boundaries through read-only navigation. It identified two handoff
gaps: the pending benchmark merge and missing direct current-work coordinates in
the active task. This is a navigation review, not the still-unperformed complete
unfamiliar-Agent model pilot. Stateful fixture support and universal statistical
claims are not prerequisites for this bounded product decision.
