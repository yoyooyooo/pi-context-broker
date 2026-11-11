# AH-561 graph and cache acceptance index

This index preserves AH-560's original 15 real-model cases and adds graph coverage without counting one evidence layer as another. Read the actual result and its package/CLI identities before making a claim. A passing old package, controlled provider, schema check, or contract fixture does not establish final-package real-model acceptance.

The [33-story ledger](notion-skill-graph-story-ledger.md) maps every parent user story to public paths, exact evidence files and remaining final-package work; its [JSON form](notion-skill-graph-story-ledger.json) preserves the same mapping for the delivery report.

## Public entry points

```sh
node scripts/notion-skill-graph-model.mjs doctor --config ABSOLUTE_CONFIG
node scripts/notion-skill-graph-model.mjs selection --config ABSOLUTE_CONFIG
node scripts/notion-skill-graph-model.mjs run --config ABSOLUTE_CONFIG
node scripts/notion-skill-graph-model.mjs exercise --evidence ABSOLUTE_RUN --command-json '["npm","test"]'
node scripts/notion-skill-graph-model.mjs exercise --evidence ABSOLUTE_RUN --review ABSOLUTE_PRIVATE_REVIEW
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

The custom-tool cases and real-model Gates enable `read,skill_search,skill_prepare`, without shell. The controlled native-chain case keeps its separate single-`read` boundary. Metadata search may introduce exact authorized refs; explicit preparation must use those refs or links actually exposed by a selected body. The observer checks the public CLI scope, version vector, complete entry manifest and native delivery spans. A prepared main counts as model-selected only when it was an explicit root; resources still require a complete native `read`. A controlled provider's planned tool use is never presented as autonomous real-model discovery.

Graph harness version 2 records its source files and hashes in Doctor, results and cache fingerprints. Each actual provider payload must advertise the same three tools. Search and prepare outputs retain their full bytes/hash and are matched to provider messages by the actual tool call ID; root/Required bodies remain unique and on the selected version. Owned `PATH/ntn` and `NTN_SKILLS_NTN_BIN` traps retain any old CLI/login attempt, and passing requires zero calls. They affect only the owned host environment.

The original real-model A failure remains at `ng14/final-package/graph-model-A-SQ1pSW`: the first provider received the full 20,872-byte Router and 56 member refs, while the harness hid search/prepare; the model also omitted the leading slash on project paths and never read a Member. This is a task failure, not an availability fallback. The controlled v5 SDK run `ng14/harness-v2/graph-observer-http-gr7I2n` passed the three-tool/public-output chain and rejected outside reads and shell. The preceding `graph-observer-http-i3KRMi` exposed a separate product defect for unmaterialized resources addressed via the macOS `/tmp` alias; that failure remains retained and requires the same `--resource-location alias` case against the fixed product package. Neither controlled run is a real-model Gate pass.

That alias case passed on independently installed v6 at `ng14/harness-v2/graph-observer-http-M4pV6s`. Its seven actual SDK/provider requests verify the three advertised tools, full search/prepare output under the same tool call ID, root/Required uniqueness, the previously absent 70-byte resource through its `/tmp` path, outside-file blocking, unadvertised shell rejection and zero legacy fallback calls. The observer did not rewrite the tool input. Harness bundle SHA-256 is `c95c7fead6e1c133f79ae565496dbf6c71c4b07d431774abab01d968f8634c2f`.

The v6 archive is `ng18/broker-v6-ff353lls/pi-context-broker-0.0.2.tgz` under the ntn-skills evidence root, SHA-256 `1fa9127cfa9f0162d76dabea383d72cbded490234cc66f4b1a5cb8903c8db5d6`, source commit `528753acda5922ac9813f8799e7d745d251493ea`. All 62 installed files match the archive; only `src/host-skills.ts` differs from v5. Doctor compares all 48 runtime/manifest files, not only the unchanged entrypoint. `package-identity-boundary.json` also rejects the wrong v5 archive paired with the v6 entry. `consumer-smoke-corrected.json` retains the earlier verification-command typo and the subsequent successful top-level `operation list` SQLite invocation; the original failed orchestration receipt is not overwritten.

Broker7 embeds CLI9's catalog management-table fix without changing Broker source. Its archive is `ng18/broker-v7-_kp72c6m/pi-context-broker-0.0.2.tgz`, SHA-256 `2a818890602d0e408c5175ed8e43691b50dbccd0357503a5fdf8bdb9f68a0455`. All 62 installed files match the archive; only `dist/ntn-skills.mjs` differs from v6. The 48-file runtime/manifest identity is `37181275839f42f04ef9d163991b3d03a4bad4ee96b8e1d8d598c7e31f2f5d8e`, and the wrong v6 archive pairing is rejected. The first offline npm attempt lacked cached `redis` metadata and remains recorded; a separate fresh consumer installation and both public CLI smoke commands passed.

The same alias/three-tool SDK case passed on Broker7 at `ng14/harness-v2/graph-observer-http-hV3lRI`, using the exact unactivated daily candidate under `/Users/yoyo/.local/share/context-broker/installed/ah561-2a818890602d/node_modules/pi-context-broker` and its bundled CLI. It retains seven actual provider requests, complete tool-output hashes, the 70-byte alias resource, outside/shell rejection and zero fallback calls. This is controlled SDK proof; formal real-model results remain separate. The synchronized generated CLI and three builtin Skills passed nine public checks at the ntn-skills evidence root's `ng05/shared-runtime-assets-GKA60n`; the protected Tern completion bytes remain unchanged.

Graph harness version 3 replaces the generated whole-body regular expression with a literal scan. It preserves raw, HTML-escaped and JSON-escaped text matching, longest-match overlap handling, and exclusion of assistant/model quotations. An observation-hook fault now records `observer-error`; the transport refuses a payload without the matching verified observation. Actual HTTP dispatches retain a wire-body hash. Observation faults invalidate the harness result and never authorize model fallback.

The v3 freeze is `ng14/harness-v3/freeze.json`, with harness SHA-256 `565d414f70bcfb1742ba94a04efb7f4dad218fc8a3f9324f85eb7560c905d4b6`. All 17 observer regressions passed. The actual installed Broker7/bundled CLI9 SDK case `ng14/harness-v3/graph-observer-http-RJRIM3` passed with a 56,423-byte root: seven verified provider payloads match seven actual server wire hashes, with complete root/Required bodies, the same three tools, the 70-byte alias resource, outside/shell rejection and zero fallback calls. The optional parent-owned `toolSurfaceFile` preserves original legacy case 1's single-`read` contract with the same payload proof; A/B still default to all three public tools. Product packages, TASK, oracle, model, timeouts and budgets are unchanged.

The separate `ng14/harness-v3/prior-attempts.json` retains and hashes both earlier Broker7 samples. `final-v7/graph-model-B-O04HQP` is harness-invalid: eight observation hooks threw `Regular expression too large`, while eight actual transports occurred without saved provider-payload proofs. Those proofs cannot be reconstructed from logical session messages. `final-v7/graph-model-A-eXJd7p` retains its task/candidate failure: 20 verified provider requests, 20 transports, 46 tool calls and no observation-hook errors. Neither failure is an availability fallback, and the controlled v3 SDK pass does not replace a real-model Gate.

Graph harness version 4 records native paths already present in an actual provider's complete Skill wrapper only after matching the verified manifest, owner, scope, snapshot and bytes. A wrapper that omits `file_id` can identify its unique manifest entry; changed identities, raw `..` traversal and assistant-only advertisements remain invalid. Candidate discovery uses stable owner/scope/entrypoint identity, while final consumption still requires the oracle's exact pin, File ID and body hash.

Unknown body ownership is `observation-incomplete`, not an eager read or a zero count. Optional `retainedSourceProofRepo` enables the separate `notion-skill-source-proof.ts` collector only after Pi closes. It queries the existing Effect API for exact bundle IDs already observed by the consumer. The offline verifier checks both canonical hashes and manifest chunk membership; attribution additionally requires the same bundle ID and Records data source in the same actual CLI receipt. Its independent metadata/process cost is retained separately. Ownership proof cannot add native reads, provider copies or loaded state, and a ZIP's other files are not counted as consumed resources.

The shared `notion-pi-help.mjs` boundary also admits generic help that the actual provider system's Pi `<docs>` section advertises. The installed executable and its package `bin.pi` establish the canonical package root; only named regular Markdown files and links from complete successful help reads are admitted. Unadvertised files, internal symlinks, traversal and misspelled package paths remain blocked. Help has a separate `host-help` read/provider receipt and never counts as a Notion Skill or required resource. No host guidance, task text, target or model parameter is added by this policy.

H3 originals remain under `ng14/final-h3/`. The read-only diagnosis and sequence erratum are in `diagnosis-readonly-vbwed_vc`: A's first target main is result sequence 16 after call sequence 8, delivered to provider sequence 18; its required README and alternative resources are still absent. A's plan has no complete file fences. B's target directory was visible, two already-provided main paths were incorrectly blocked, and the target itself was never consumed. B's `docs/acceptance.md` contains same-length nested fences; the parser now retains an explicit ambiguity instead of truncating it into a complete file. None of these observations changes a model task failure into success or authorizes a model fallback.

The H4 freeze is `ng14/harness-v4/freeze.json` (SHA-256 `3728fe47eee9d1cdd71d5f88f88e49c8b9ffc04109248add3f222ec46e5b31f1`), binding seven harness files to aggregate `a58708b78cb9c4f4029f9c22b81478eccfd0a506828d4a24b9bbc181d4915ddd`. All 78 combined regressions passed. Actual Broker8/bundled CLI9 SDK run `graph-observer-http-ejGbJE` passed nine provider/wire pairs: full 56,423-byte root preparation, unique Required bodies, a complete 115-byte Required read through its unchanged advertised `~/...` path, separate 4,080-byte Pi help, complete search/prepare outputs, the 70-byte alias resource, outside/shell rejection and zero legacy CLI traps. This remains controlled-provider evidence.

`sdk-attempts.json` preserves both earlier controlled failures: `uGldin` exposed the observer's missing native HOME expansion; `66q5vw` correctly rejected the 56,423-byte filesystem read truncated by Pi's normal 50 KiB page limit. The final fixture independently checks large-body preparation and the complete short native-path read. It does not treat a partial native read as complete, change the product, or overwrite the failures. Real-model task/oracle/model/timeouts/budgets are unchanged.

### H5 host-index relative resource observation

The H4 legacy run `ng20/pi-cache-evidence-y6izS4` remains failed: after a complete advertised host-index main read, the shared observer incorrectly blocked its actual relative Markdown resource at sequence 29. H5 binds that successful main read to the real `.broker-host-index.json` and the verified entry manifest, including scope, owner, snapshot, main File ID, source hash and `manifest_id`. Only relative links in that fully read body may introduce an index resource alias, and only when the same manifest declares the exact resource. Repeated checks reject changed receipts, arbitrary siblings, traversal and internal symlinks; the final native result must retain the exact File ID, pin, hash and byte count. Product code and the frozen task/oracle/model/budgets are unchanged.

`ng14/harness-v5/host-index-before.json` preserves the new red regression; `host-index-after.json` passes both new tests, and `combined.json` records 80 passing checks. Actual installed Broker8/bundled CLI9 SDK run `graph-observer-http-g5KmVF` passes ten provider/wire pairs: the advertised index main returns its complete 441 bytes, its linked index resource returns the exact 77 bytes, and the existing help, metadata/prepare, Optional resource, outside/shell rejection and zero legacy traps remain verified. `graph-observer-http-CAjyRg` preserves the first controlled runner failure: it incorrectly expected a repeated main to remain full in provider tool text, despite correct original full-read evidence and deliberate provider deduplication. This is controlled evidence, with no new real-model run.

H5 freezes eight runtime/helper files at aggregate `83576bdd32d0e1c3419da8665adf035a0e3b456091dd6e21c46f268ff3532f19`; `ng14/harness-v5/freeze.json` SHA-256 is `9057024b67af5540810739218c91c6c9d686cc0b262057804f87fcb13f77e226`. The earlier H4 freeze and all original failures remain intact.

### H6 discovered resource identity fields

The original H5 cold results remain failed at `ng14/final-h5/graph-model-A-G3kOyT` and `graph-model-B-ti3uRk`. The independent `ng20/h5-gate-diagnosis/diagnosis.json` preserves the exact input, discovery, public-source and native-result chains. A's three resource inputs omitted optional `snapshot` and `file_id` fields after their current paths and complete identities had been advertised. The product resolved all three successfully, but H5's discovery comparison rejected the omitted File ID. B's mixed record-directory/snapshot path and other guessed inputs remain actual input errors. The original timeouts, missing successful finals and incomplete collector results are retained; the independently recorded clamshell sleeps overlap both samples and the collector delay. None of these records authorizes model fallback.

H6 resolves an actually discovered same-owner/current-manifest-path reference without optional query fields only when one verified scope, owner, path, snapshot, File ID, SHA and byte count exists. A supplied File ID retains the existing stable-identity contract: an old display path is valid only when that owner/path/File ID combination was actually discovered, and the verified manifest resolves it uniquely. An undiscovered path cannot borrow a valid File ID. Explicit pin or identity conflicts, ambiguous scope/pin, unseen resources and B's mixed native paths remain rejected. The observer stores the complete expected identity at the call and requires the returned materialized file to match it; matching body bytes alone cannot change the attribution. Metadata-only `skill_prepare` discovery is unchanged.

The H5 red run is retained in `ng14/harness-v6/references-before.json`: the seven new checks failed while the two existing checks passed. `stable-alias-before.json` separately preserves the initial overly strict path comparison, which was corrected to retain the existing public File ID alias contract. Final `combined.json` passes all 88 checks, comprising the original 80 and eight focused additions.

Two actual installed Broker8/bundled CLI9 SDK runs pass under the same H6 code. `graph-observer-http-NGwP8n` reads the actually discovered old display path with its stable File ID. `graph-observer-http-Hgm7jA` takes the current canonical ref from the actual preparation directory and omits both optional fields. Each verifies ten provider/wire pairs, the complete 70-byte Member resource and its provider delivery, the existing 441-byte host-index main and 77-byte relative resource, full search/prepare output, outside/shell rejection, zero legacy CLI traps, 14 source-process closes and the observed Pi exit. The two input forms use `scripts/notion-skill-graph-observer-smoke.mjs --resource-location ref` and `--resource-location unqualified-ref`, both with `--host-index-resource true` and the same installed entries. These are controlled-provider runs; real-model Gate and legacy results remain separate.

H6 freezes eight runtime/helper files at aggregate `293c5d2718f326b43143e68a9623413d31386eae7413546e4713fcabd491726d`. `ng14/harness-v6/freeze.json` SHA-256 is `b4e28f3bdc6720d87ed155dbb28ebec18663263ad14f954b9ed297f1ee85d48c`. Product CLI9/Broker8, the task, oracle, tools and budgets are unchanged. All 70 original H5 Gate/matrix evidence files retain their hashes. The freeze records the unchanged protected Tern working bytes and retains the root's separate receipt for its pre-existing staged difference.

### H7 public main references, native wrappers and authored selection

The H6 originals remain failed. `ng20/h6-gate-diagnosis/b-and-native-location.json` proves that B selected the already-provided poteto/unslop owners using legal main references without `/SKILL.md`; the observer's copied URI grammar rejected them. The same report independently binds the legacy `cold-native-command` main path to Pi's actual user `<skill location="...">` wrapper, complete body, delivery span and fixed source identity. The original legacy initial result remains ten passes and one failure. A's independent `ng20/h6-a-eager-review-JuV3Ra/diagnosis.json` identifies eleven false eager counts: the model had authored each exact read before Broker's `prepareRead`, while the observer recorded admission after that preparation. The separate derivation removes those timing errors but still fails required-resource coverage. A and B's successful final text contains eight file headings and no generated Skill entry; the original evidence is not rewritten or treated as a task pass.

H7 imports `parseNativeReference` from the actual installed extension's sibling module at every observer callsite, including the legacy driver. A bare owner resolves only through an actually discovered main and verified source metadata for one owner/scope/entrypoint; it never guesses `SKILL.md` or an owner from a basename. Explicit pins, File IDs and the H6 discovered alias boundary remain enforced. A native Pi wrapper introduces its exact main path only when the actual non-assistant provider text contains the complete body and matches the loaded delivery receipt, manifest and public read identity. Assistant quotes, partial bodies and mismatched owner/scope/pin/File ID remain rejected.

The observer records the received assistant `message_end` tool call with its call ID, original arguments and argument hash. Source attribution may use that earlier timestamp only after it agrees with a later allowed call and complete immutable read/preparation result. It preserves the admission timestamp and never substitutes the assistant message's creation timestamp. Missing authorship and a source request that genuinely precedes authored selection cannot become a successful early selection. The legacy driver's explicit `--case cold-native-command` route reuses its existing boot, turn, assertions and cleanup, reports a targeted one-case run, and is mutually exclusive with resume; the default initial eleven and updated six cases remain unchanged.

The artifact collector also recognizes explicit `文件路径` headings and absolute paths contained by the owned project, normalizing those paths to relative names while retaining file bodies byte for byte. Outside paths, ambiguous same-length nested fences, missing Skill/frontmatter and missing referenced resources still fail. This corrects the task's permitted path-label forms without changing the task or artifact requirements.

`ng14/harness-v7/` retains the observer red result (four failures/two passes), the collector red result (two failures/three passes), their green results and the final `regression-final.json` with 96/96 passing checks. Actual installed Broker8/CLI9 SDK runs `graph-observer-http-PUEbMb` and `graph-observer-http-wutwR7` each verify ten provider/wire pairs. The first proves a complete 389-byte native-command main reread, one provider copy, the bare-owner prepare, authored selection before actual `prepareRead` and a canonical resource read with omitted query fields; all fifteen source processes close. The second retains the old display-path/File ID alias and host-index relative-resource checks, with fourteen source closes. Both observe Pi exit and zero legacy fallback calls.

The final nine-file H7 aggregate is `b43eeaef8f76b5bf5c97eab4fd10de3367321d1fa5282dde423119e1958910f2`; `ng14/harness-v7/freeze.json` SHA-256 is `92c369b047339eb1388cb7081890212e539616d074dada0fdb90427849155cd4`. The installed parser is bound by its exact path and SHA `a68207cd5163e85f68c0bb0de749cca5ed146581f7b098af9cc8245beb3f9a34`. Both SDK records retain their earlier aggregate `c0165eb3923b887a1dd62fa85b11d3794363f0216532992cd79b4cf14074729d`; the sole subsequent helper change is the collector, and `sdk-project-boundary-final.json` proves the SDK's project creation/inspection functions are byte-identical. Independent observer and collector reviews report no blocking findings. Product, task, oracle, tools, budgets and protected Tern working bytes remain unchanged. These controlled runs do not replace real-model Gate or legacy acceptance.

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

The daily candidate runner has one default-off exception, `artifactOutput: true`, for a fresh owned project task. Native `write/edit` may deliver complete UTF-8 files ending in LF into its separately created owned artifact directory. `native-artifact-final.md` retains the successful model final verbatim and has its own bytes/hash in `generatedPlan.delivery.nativeFinal`. `owned-artifacts.json` and `owned-artifact-files/` retain exact output bytes, including partial failed runs. For a successful final only, `generated-acceptance-plan.md` is a clearly labeled deterministic file container with the complete native final encoded as JSON and all actual files in exact-byte fences; it is not a verbatim final. The existing collector and reviewed-helper executor consume that container. The controller must independently read and hash-check the native final and every file. File existence, a container, or a completed helper alone cannot establish task acceptance; default chat delivery and all historical failures retain their original meaning.

That file-delivery construction remains an unadopted experiment. Its sole v7 A run timed out without a final or any write/edit call. The actual Pi edit schema used `path` plus an `edits` array, while frozen driver 0f6a9cd accepts the older scalar `oldText/newText` shape; its controlled edit fixture does not validate the current native interface. Write has the matching shape, but neither tool was actually invoked. Preserve this compatibility limitation and the failed run; do not infer that it caused the no-first-write timeout or present the candidate as a verified daily feature. The terminal decision and exact evidence are recorded in the existing dogfood-closure map on this independent candidate branch.

`exercise --command-json` remains compatible with the four exact local Node/npm test forms and records `existing-project-check`, `existingProjectCheck`, and the accurately named `existing-project-check.*` files. It runs the original application's tests. A textual command match, including a negative mention, establishes neither an instruction to run it nor execution of any generated helper. The before/after inventory uses the same frozen daily profile when its sixth runtime file is present. Historical `generatedProcedure` reports remain readable as original evidence; their old labels are not upgraded into helper proof.

`exercise --review ABSOLUTE_PRIVATE_REVIEW` accepts one explicitly reviewed generated Node entry. The controller first reads the complete actual final and every extracted file, checks the helper's concrete behavior and one real feature path, and writes a private receipt outside the consumer/evidence roots. The version-1 receipt has `purpose: "generated-helper-exercise"`, a nonempty `reviewer`, `approvedForOwnedExercise: true`, and these exact bindings:

| Field | Required binding |
| --- | --- |
| `parent.evidence`, `parent.resultSha256` | Canonical original run and raw immutable `result.json` hash; its technical status must be passed with no retained error |
| `parent.planSha256`, `parent.projectSha256` | Verbatim model final by default; for explicit file delivery, the labeled container binding the complete native final and every file. Both modes bind the fixed five-file application manifest. `parent.resultSha256` also binds the separate native-final identity in `generatedPlan.delivery`. |
| `parent.files` | Every extracted file in original order as `{path, sha256, bytes}` |
| `entry` | One complete generated `.mjs`, `.cjs` or `.js` file as `{path, sha256}` |
| `command` | Current canonical Node `executable` and exact `args`, beginning with the relative entry path; no interpreter flags before the entry or shell |
| `budget` | Positive integer `timeoutMs` ≤ 20000 and `killGraceMs` ≤ 2000 |

This receipt records an independent controller decision; it is not an OS sandbox or a model self-approval mechanism. Review imports, arguments, process behavior and resource ownership before approving. Use only the owned project and loopback resources for this gate. Do not approve production configuration/credentials, detached unowned processes or unrelated endpoints. Existing authorization covers this owned validation; an unknown helper remains unreviewed until its complete bytes and exact invocation have been assessed.

The runner refuses failed prerequisites, incomplete/changed files, changed metadata, unsafe paths, symlinks, source overwrites, runtime settings and mismatched review/argv/budgets before spawning. It copies the fixed application plus all complete generated files into a new owned temporary project. It copies no Pi session, cache, auth or runtime settings, and gives the child an isolated HOME/config environment. It starts the exact Node invocation without a shell, records PID, executable/args/cwd, timeout/signals/close, entry/plan hashes, stdout/stderr and ordinary output files. It closes only that owned process group. A separate hard deadline bounds inherited-pipe waits: destroying the runner's pipes records failed, `closeObserved: false` and incomplete output, never natural EOF or unknown-child termination. Such unresolved finality blocks driver cleanup and final acceptance. Setup/copy failures retain their stage, ownership and a `not_run` receipt; with no spawn, the normal owned cleanup remains available. `status: completed` establishes one execution, while `productAcceptance.status` remains `independent-review-required`; output saying PASS does not establish any feature result. The controlled positive regression separately asserts actual loopback POST/GET behavior from its retained helper source and request/result artifacts.

The original model result is never rewritten by reviewed-helper execution. Its returned separate `graph-generated-exercise-*` evidence root contains the review, original result/plan, full generated files and final owned output hashes. Run original `evidence → cleanup → evidence` against that root; cleanup verifies ownership and process close, uses system Trash and binds the immutable execution result. Final acceptance requires that hash-bound cleanup and absent owned scratch, then revalidates retained evidence. A failed or timed-out execution keeps its failure evidence. D keeps a technically valid natural task at `waiting-for-independent-exercise` and continues its frozen cases without guessing a command. A passed natural-task semantic review must include `generatedExercise: {evidence, resultSha256}` on turn 0, pointing to a completed new helper receipt; the independent reviewer must assess the actual feature evidence as well as the answer. An old existing-project check cannot satisfy that requirement. Original failed A/B/C/D samples and frozen inputs stay unchanged.

Regression entry: `node --test scripts/notion-skill-graph-project.test.mjs scripts/notion-skill-graph-model.test.mjs scripts/notion-model-cache.test.mjs`. It covers the original-command distinction, daily sixth-file preservation, complete helper byte identity and real HTTP execution, pre-spawn negative cases, nonzero/timeout/print-only results, immutable parent evidence and Evidence→Trash→Evidence. It also exercises an actual copy fault, the pre-cleanup acceptance rejection, and a deliberately detached fixture pipe holder. That negative fixture identifies its own child by PID, start identity and token, performs only its outer owned cleanup, and preserves the driver's failed/unknown raw receipt and blocked cleanup. Controlled fixture proof, real-model task success and independent product acceptance remain separate.

The core helper, loopback HTTP, rejection, failure and finality assertions run on Linux CI as well. Only the system Trash round trip and post-cleanup acceptance positive require macOS with executable `/usr/bin/trash`; otherwise each fixture retains its evidence/scratch and emits explicit `System Trash ECE not_run`. The detached negative still terminates only its pre-identified test child. No whole core test is skipped, no `rm` substitutes for Trash, and no cleanup success is fabricated. `GRAPH_TEST_DISABLE_SYSTEM_TRASH=1` exercises this unavailable-capability branch on a capable test machine without changing production cleanup.

## Matt coverage decision

The extra installed-Pi fixture changes every relevant name and identity independently of Pstack, then verifies exact scope/owner/snapshot/File-ID behavior. Separate heterogeneous topologies reject Router and Prompt Required edges before dispatch. The baseline additionally has a diamond, multiple roots, optional Member/resource links, a renamed resource spelling, historical pins and cancellation. This provides a direct non-Pstack counterexample set without modifying a second production library.

On that evidence, no Matt production migration is currently needed. This decision remains conditional on the final package passing those same renamed/heterogeneous cases. If a final failure exposes a topology or identity assumption that those fixtures cannot cover, use one accurately registered Matt graph with retained identity provenance; do not expand to a whole-library migration merely to increase case count.

## Remaining final-package gates

Final acceptance must attach the same frozen package/CLI identities to the original 15 plus two extra real-model cases; Gate A/B five-sample matrices and generated artifacts; the controlled graph cases; actual PTY; real Notion UI and relations; CLI loopback/multiprocess relation/cache tests; and independent-machine historical restore. Each owner supplies its actual evidence. Different View/permission behavior, relation pagination above 25/100, cycles, corrupted/missing history, session fork/compaction and queue/cancellation are linked to the CLI/Broker feature maps, not inferred from the small graph fixture. Owned remote objects and the independent View require their own cleanup/readback receipts.
