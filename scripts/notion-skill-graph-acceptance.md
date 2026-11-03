# AH-561 graph and cache acceptance index

This index preserves AH-560's original 15 real-model cases and adds graph coverage without counting one evidence layer as another. Read the actual result and its package/CLI identities before making a claim. A passing old package, controlled provider, schema check, or contract fixture does not establish final-package real-model acceptance.

The [33-story ledger](notion-skill-graph-story-ledger.md) maps every parent user story to public paths, exact evidence files and remaining final-package work; its [JSON form](notion-skill-graph-story-ledger.json) preserves the same mapping for the delivery report.

## Public entry points

```sh
node scripts/notion-skill-graph-model.mjs doctor --config ABSOLUTE_CONFIG
node scripts/notion-skill-graph-model.mjs selection --config ABSOLUTE_CONFIG
node scripts/notion-skill-graph-model.mjs run --config ABSOLUTE_CONFIG
node scripts/notion-skill-graph-model.mjs exercise --evidence ABSOLUTE_RUN --command-json '["npm","test"]'
node scripts/notion-skill-graph-model.mjs evidence --evidence ABSOLUTE_RUN

node scripts/verify-notion-integration.mjs run --mode installed --host pi --skill-graph true \
  --package ABSOLUTE_FROZEN_BROKER_TGZ \
  --command-json '["ABSOLUTE_NODE","ABSOLUTE_INSTALLED_CLI"]' \
  --graph-cli-source ABSOLUTE_CLI_CHECKOUT --evidence-root ABSOLUTE_EVIDENCE

node scripts/verify-pi-notion-model-cache.mjs --fixture ABSOLUTE_FIXTURE_A \
  --extension ABSOLUTE_INSTALLED_ENTRY --cli ABSOLUTE_INSTALLED_CLI \
  --model magpie/group/flash-free --evidence-root ABSOLUTE_EVIDENCE
```

The single-Skill update phase uses the same frozen entry/CLI and `--resume INITIAL_EVIDENCE --fixture ABSOLUTE_FIXTURE_B`. Updating the owned remote fixture is a separate authorized action. Retain the actual apply operation ID; an unresolved write is reconciled through its original operation, never replayed. `ctl api` stays read-only. A Profile currently selects a View; it cannot invent an exact Skill-ID filter. The owned single-Skill regression therefore gets its own native View, separate from Gate A/B.

The single-Skill runner also requires `--previous-failure ABSOLUTE_FLASH_FREE_MANIFEST` for worker. That retained failure must be actual model unavailability and match the current installed extension and CLI hashes; an assertion or selected-resource failure does not authorize fallback. An availability failure stops that run and is retained.

## Original AH-560 cases

The source of this table is the frozen AH-560 issue and its `acceptance-report.md`. Original numbering stays fixed. The historical initial manifest has nine cases; the historical updated manifest has six. Current runner additions are listed separately below.

| Original ID | Exact runner case | Required observation | Final-package status |
| --- | --- | --- | --- |
| AH560-01 | `cold-autonomous-native` | New CLI/Broker/session roots; metadata first; model chooses native entry and resource; complete bytes and actual body HTTP | Pending final freeze/run |
| AH560-02 | `same-session-repeat` | Same session and fixed identity; one main body; no body download | Pending final freeze/run |
| AH560-03 | `same-session-native-switch` | Native read to `/skill:` keeps one complete instruction | Pending final freeze/run |
| AH560-04 | `warm-new-process` | New Pi process/session, same complete source caches; no body download | Pending final freeze/run |
| AH560-05 | `persisted-session-resume` | Actual persisted session continuation, exact previous snapshot and resource | Pending final freeze/run |
| AH560-06 | `cold-dollar` | Fresh roots, `$` completes main preparation before first provider request | Pending final freeze/run |
| AH560-07 | `cold-native-command` | Fresh roots, native `/skill:` completes preparation before first provider request | Pending final freeze/run |
| AH560-08 | `explicit-revalidation-unchanged` | Current state really revalidates; unchanged immutable body remains valid | Pending final freeze/run |
| AH560-09 | `cli-warm-broker-empty` | CLI reuse with an empty Broker cache; complete verified local materialization | Pending final freeze/run |
| AH560-10 | `old-session-pinned-after-edit` | Real owned source now B; previous A session still reads A main and resource | Pending final freeze/run |
| AH560-11 | `refreshed-new-session-b` | New session explicitly refreshes to B; fixed identities/hashes agree | Pending final freeze/run |
| AH560-12 | `warm-b-new-process` | B cache reused by another Pi process; no body download | Pending final freeze/run |
| AH560-13 | `resumed-b` | Persisted B session, exact B main/resource receipts | Pending final freeze/run |
| AH560-14 | `broker-warm-cli-empty-b` | Verified Broker B with an empty CLI; actual current source verification | Pending final freeze/run |
| AH560-15 | `elapsed-short-ttl-revalidation-b` | Real 1-second TTL expires; actual source revalidation, no clock rewriting | Pending final freeze/run |

The current runner also executes `broker-warm-cli-empty` and `elapsed-short-ttl-revalidation` in phase A. These are **two extra cases**, not renumberings or replacements for the original 15.

Historical success is retained at:

- `/Users/yoyo/.local/state/ntn-skills-verification/pi-real-model-cache-_web8gk7/pi-cache-evidence-2givfs/manifest.json` — initial nine.
- `/Users/yoyo/.local/state/ntn-skills-verification/pi-real-model-cache-_web8gk7/pi-cache-evidence-n2TkwW/manifest.json` — updated six.

Those manifests bind the historical extension hash `a952d4c2db1e63d87595bce35c514803a7d7ffc5970c1a5244c7e947e70804f8` and CLI hash `2382d6861611e91f124c7fb618a448a26e440203fcf63cdc09b2dd5c4c91c56b`. Their official-CLI request accounting is historical only; final AH-561 runs require the project direct-HTTP attempt ledger and no official `ntn` fallback.

## Controlled installed-Pi graph cases

`scripts/notion-skill-graph.mjs` seeds immutable public Store data into a separate real Node/SQLite root. Installed CLI `prepare`, `read` and optional `export` perform the business work. Only metadata discovery is frozen by the fixture wrapper. Every wrapper, seed and CLI process is recorded; a graph request followed by fixed reads is not called a single-process execution. These fixtures are cold at the consumer preparation boundary, not empty remote-source caches.

| Cases | Contract proved |
| --- | --- |
| `metadata` | Native default catalog contains one root and no instruction body or preparation |
| `cold-dollar`, `cold-native` | Root plus full diamond Required closure before first provider; each body once; optional body absent |
| `multi-root` | Both roots enter one public preparation; shared diamond dependency stays one body |
| `tool-use`, `tool-inspect` | Explicit public `skill_prepare`; inspect loads only root, use completes Required |
| `native-chain` | Shell disabled; actual native read follows root directory to Member and its resource; stable File ID resolves an old spelling |
| `cold-pin` | Current root B does not replace an explicitly selected historical A pin |
| `renamed-identities` | Names, aliases, library, Skill/page/database/source/View/File IDs and resource paths all change; use closure still succeeds; a new session discovers native Member/resource through observed links |
| `required-router`, `required-prompt` | Mixed-kind topology returns `PREPARE_REQUIRED_KIND`, preserves the exact failing path, publishes no usable lock or loaded receipt, makes zero provider requests |
| `missing`, `budget` | An incomplete Required closure blocks provider dispatch; no partial-ready substitution |
| `rpc-abort` | Measures actual RPC behavior. If pending input does not cancel, records that result and uses a separate `new_session` cleanup boundary |
| `new-session` | Pending preparation is canceled, descendants exit, no late body/provider; a new session can retry |
| `eof` | Actual stdin EOF closes the host and its owned pending descendants; no terminal RPC reply is invented after transport closure |

The custom-tool cases explicitly enable `read,skill_search,skill_prepare`. Native-chain and real-model Gates enable only `read`. A controlled provider's planned tool use is never presented as autonomous real-model discovery.

### Evidence recorded before final freeze

All paths below are under `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/` unless stated otherwise.

| Evidence | Package/layer | Observed result |
| --- | --- | --- |
| `ng13/broker-notion-evidence-eoOLkX` | Broker v1; installed Pi + actual CLI/SQLite + controlled provider | Metadata, cold dollar/native and multi-root pass |
| `ng13/broker-notion-evidence-6Zd0yH` | Broker v1 | Use, inspect, native chain, cold pin, missing and budget pass; cancellation cleanup failure retained |
| `ng13/broker-notion-evidence-G8Hk1k` | Broker v1 | EOF pass; no false RPC terminal reply requirement |
| `ng15/broker-notion-evidence-nvKp7N` | Broker v2 + CLI6 | `new_session` cancels/retries correctly; RPC abort still does not cancel pending input, recorded separately |
| `ng20/broker-notion-evidence-Fz7HvR` | Broker v3 + CLI6 | Renamed identities, Required Router and Required Prompt pass |
| `ng14/graph-observer-http-6tBtZC` | Broker v2 + CLI6; actual SDK transport to owned HTTP provider | Full closure, native Member/resource and real owned application read pass |
| `ng14/graph-observer-http-GGSX54` | Broker v2 + CLI6; same controlled SDK layer | Three Pi processes, five fixed cache/session samples, 14 owned provider HTTP requests pass |
| `ng20/driver-check-ekEjJ5` | Observer/contract/artifact checks | Eight cases pass, including actual owned-project test execution and prose/incomplete-file rejection |
| `ng20/partial-driver-check-RTFvKc` | Updated legacy and graph observer boundaries | Controlled checks pass; final partial package still requires installed-Pi run |

Actual PTY selection/Stop is independently owned by `scripts/verify-pi-graph-pty.mjs`, with v3 evidence at `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng15/broker-pi-graph-pty-QFA9Nc`. Its Tab selection, Escape, budget display and descendant-exit claims do not come from RPC abort/EOF results.

Failures remain where they occurred, including v1 stale-context cancellation, early fixture/active-tool mistakes, the first EOF harness's incorrect reply assumption, and `ng20/driver-check-FflutK` where isolated HOME reached a Volta npm shim. The corrected artifact driver executes the current Node's bundled npm with an owned HOME and records the exact command, process, exit and hashes. No failed directory is overwritten with a later pass.

## Gate A/B and performance design

Before the first real Gate model run, prompt version 2 explicitly added complete named file contents to the natural task. Version 1 requested only a plan, so imposing a complete-file output format without requesting it would have been an unfair task failure. `TASK_V1` and all NG01 evidence remain unchanged; the evaluator can still identify historical version 1. Trace/oracle schema remains version 1 and the private oracle hash is unchanged. Both final Gates use the same version-2 task plus their exact selected root. No target name, ref or answer was added.

The freeze receipt is `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/prompt-v2-freeze-q7ckkC/prompt-freeze.json`. It records the rationale, absence of a previous real Gate run, the old/new prompt bytes and hashes, unchanged oracle, and 67 passing related checks. Task SHA-256 is `f9fc8d3fe1efafaec64dfe9a0c0bd19b92153bdc5580eee75af71f85f1211686`; Gate A prompt is `fd3e476ad16f17d74a7d9c2b6f7743af4d070c3af045361ebfe0487640ed22e5`; Gate B prompt is `ada40df3a416f48dffac041a47fcbc51253abce8c98a47f7a9bed9eaab0102ea`.

The private oracle remains outside all CLI/Broker/session roots and is read only by the parent evaluator. The observer receives no target leaf, answer tokens or oracle path. Actual metadata-only selection uses installed Pi `/context-broker find` and `explain`; it returns the runtime's precise token and proves zero provider/body requests. A selection receipt is bound to the actual package/CLI and must be refreshed for the final package.

The same frozen natural task is used for both Gates. Gate A selects only the Pstack Router; Gate B selects only poteto-mode, whose required unslop instruction is prepared before dispatch. Neither Gate preselects the target leaf. Each independently proves root/Required full bytes, optional body absence before model selection, exact native leaf/resource identity, and successful model final. Required resource coverage is README plus at least one complete feature example. Every actually read alternative is checked; an unchosen alternative cannot be preloaded. The `resourceAlternatives` contract was frozen before the first real-model run.

Each Gate uses fixed `mode: matrix`: one cold process, two warm new processes reusing the same complete caches, then two more identical submissions in the second warm live session. A successful exact cache receipt is required before reuse. Failed samples remain failures; a failed predecessor without a complete cache receipt leaves downstream modes explicitly not run. Report each raw value and its mode's median. With at most two samples per mode, p95 is null.

Timing fields separate Pi startup, first observed provider boundary containing complete root bytes, first boundary containing the full Required closure, CLI preparation completion, and successful task final. Provider-boundary readiness is an upper bound; it is not an invented internal timestamp.

Transport attribution uses actual page/block UUIDs and every exact Entity ID in a real request. Unknown or ambiguous ownership fails attribution instead of claiming zero optional body reads. Prior warm receipts can prove ownership; they never add old requests to the current request count or grant new permissions.

## Generated artifacts and execution

The owned application has actual Node HTTP source, a README, package commands and tests; no local Skill, leaf oracle or answer file is present. Only its exact source inventory and discovered Skill paths are readable. The version-2 user task stays frozen across both Gates and every cache mode.

The final model text is retained verbatim. Only explicitly named relative files with complete fenced contents are extracted. A complete `SKILL.md` with frontmatter and all local referenced files is required for generated-Skill status. A summary remains `plan-only`; missing referenced files remain incomplete. Extraction does not invent prose, filenames or test commands.

`exercise` runs one exact test command found inside a retained complete generated file against the unchanged owned application. It accepts only the declared local Node/npm test forms, uses no shell, and records file/plan/project hashes, PID, output and exit. Graph success alone does not complete AH-573's generated-artifact obligation; one executed procedure does not claim all proposed procedures were executed.

## Matt coverage decision

The extra installed-Pi fixture changes every relevant name and identity independently of Pstack, then verifies exact scope/owner/snapshot/File-ID behavior. Separate heterogeneous topologies reject Router and Prompt Required edges before dispatch. The baseline additionally has a diamond, multiple roots, optional Member/resource links, a renamed resource spelling, historical pins and cancellation. This provides a direct non-Pstack counterexample set without modifying a second production library.

On that evidence, no Matt production migration is currently needed. This decision remains conditional on the final package passing those same renamed/heterogeneous cases. If a final failure exposes a topology or identity assumption that those fixtures cannot cover, use one accurately registered Matt graph with retained identity provenance; do not expand to a whole-library migration merely to increase case count.

## Remaining final-package gates

Final acceptance must attach the same frozen package/CLI identities to the original 15 plus two extra real-model cases; Gate A/B five-sample matrices and generated artifacts; the controlled graph cases; actual PTY; real Notion UI and relations; CLI loopback/multiprocess relation/cache tests; and independent-machine historical restore. Each owner supplies its actual evidence. Different View/permission behavior, relation pagination above 25/100, cycles, corrupted/missing history, session fork/compaction and queue/cancellation are linked to the CLI/Broker feature maps, not inferred from the small graph fixture. Owned remote objects and the independent View require their own cleanup/readback receipts.
