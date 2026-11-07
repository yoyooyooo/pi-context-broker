# Skill graph and cache verification

Use the existing graph and cache drivers to verify the selected candidate. Controlled providers, real source traffic, actual host delivery, model behavior and generated-artifact execution are separate evidence layers. Freeze the artifact, source identities, task, model, cache/session state, budget and expected results before running. Store run ledgers and raw failures outside the checkout.

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

## Single-Skill cache and session cases

The stable case IDs below identify the existing runner scenarios. Record each execution against its own artifact and source identities; this table contains requirements, not acceptance status.

| Case ID | Runner case | Required observation |
| --- | --- | --- |
| AH560-01 | `cold-autonomous-native` | New CLI/Broker/session roots; metadata first; model chooses native entry and resource; complete bytes and actual body HTTP |
| AH560-02 | `same-session-repeat` | Same session and fixed identity; one main body; no body download |
| AH560-03 | `same-session-native-switch` | Native read to `/skill:` keeps one complete instruction |
| AH560-04 | `warm-new-process` | New Pi process/session, same complete source caches; no body download |
| AH560-05 | `persisted-session-resume` | Actual persisted session continuation, exact previous snapshot and resource |
| AH560-06 | `cold-dollar` | Fresh roots, `$` completes main preparation before first provider request |
| AH560-07 | `cold-native-command` | Fresh roots, native `/skill:` completes preparation before first provider request |
| AH560-08 | `explicit-revalidation-unchanged` | Current state really revalidates; unchanged immutable body remains valid |
| AH560-09 | `cli-warm-broker-empty` | CLI reuse with an empty Broker cache; complete verified local materialization |
| AH560-10 | `old-session-pinned-after-edit` | Real owned source now B; previous A session still reads A main and resource |
| AH560-11 | `refreshed-new-session-b` | New session explicitly refreshes to B; fixed identities/hashes agree |
| AH560-12 | `warm-b-new-process` | B cache reused by another Pi process; no body download |
| AH560-13 | `resumed-b` | Persisted B session, exact B main/resource receipts |
| AH560-14 | `broker-warm-cli-empty-b` | Verified Broker B with an empty CLI; actual current source verification |
| AH560-15 | `elapsed-short-ttl-revalidation-b` | Real 1-second TTL expires; actual source revalidation, no clock rewriting |

The current runner also executes `broker-warm-cli-empty` and `elapsed-short-ttl-revalidation` in phase A. These are **two extra cases**, not renumberings or replacements for the original 15.

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

## Reference and observer boundaries

The graph observer binds every actual source request to the selected owner, scope, snapshot and File identity. A host-index relative path must resolve through its verified selected manifest. Optional identity fields omitted from a public reference do not authorize guessing another target; resolve them from independently observed source proof. A stale path hint may identify a renamed fixed file only when its stable File ID and pin match.

A native main wrapper must preserve complete authored source bytes and bind its actual tool call. Readiness timestamps follow actual selection and source events, not fixture expectations. Observer details, schema text, summaries and loaded labels do not prove provider delivery. Keep the shared observer's negative cases for wrong scope/owner/pin, malformed spans, unknown request ownership and missing source/process terminals.

The generated-file collector accepts explicitly labelled relative paths and absolute paths contained by the owned project, preserving complete bodies byte for byte. Outside paths, ambiguous nested fences, missing frontmatter and missing referenced resources fail. Extraction never repairs the answer to satisfy its oracle.

## Root selection and performance comparisons

The graph model driver supports independent selected-root routes. A Router may expose optional Members without preselecting a leaf; an ordinary Skill prepares its real Requires before dispatch. Freeze the natural task and private oracle before execution, and keep the oracle outside all consumer, CLI, Broker and session roots. The model must choose the leaf and read any required resources through advertised public references.

Use the configured cache/session sequence exactly. Reuse requires a complete successful cache receipt; failed predecessors leave dependent modes explicitly not run. Preserve each raw sample, report its cache state, and do not estimate p95 from a handful of runs. Do not inject a target, resource or answer into the prompt to make a failed selection pass.

Separate startup, root readiness, Requires readiness, source completion and final task completion. An observed provider boundary is an upper bound on readiness, not an invented internal timestamp. Attribute requests from their actual serialized identities; ambiguous ownership remains unknown. Earlier receipts can establish identity but cannot add old traffic to the current count or grant permission.

## Generated artifacts and execution

The owned application has actual Node HTTP source, a README, package commands and tests; no local Skill, leaf oracle or answer file is present. Only its exact source inventory and discovered Skill paths are readable. The version-2 user task stays frozen across both Gates and every cache mode.

The final model text is retained verbatim. Only explicitly named relative files with complete fenced contents are extracted. A complete `SKILL.md` with frontmatter and all local referenced files is required for generated-Skill status. A summary remains `plan-only`; missing referenced files remain incomplete. Extraction does not invent prose, filenames or test commands.

`exercise --command-json` remains compatible with the four exact local Node/npm test forms and records `existing-project-check`, `existingProjectCheck`, and the accurately named `existing-project-check.*` files. It runs the original application's tests. A textual command match, including a negative mention, establishes neither an instruction to run it nor execution of any generated helper. The before/after inventory uses the same frozen daily profile when its sixth runtime file is present. Historical `generatedProcedure` reports remain readable as original evidence; their old labels are not upgraded into helper proof.

`exercise --review ABSOLUTE_PRIVATE_REVIEW` accepts one explicitly reviewed generated Node entry. The controller first reads the complete actual final and every extracted file, checks the helper's concrete behavior and one real feature path, and writes a private receipt outside the consumer/evidence roots. The version-1 receipt has `purpose: "generated-helper-exercise"`, a nonempty `reviewer`, `approvedForOwnedExercise: true`, and these exact bindings:

| Field | Required binding |
| --- | --- |
| `parent.evidence`, `parent.resultSha256` | Canonical original run and raw immutable `result.json` hash; its technical status must be passed with no retained error |
| `parent.planSha256`, `parent.projectSha256` | Verbatim model final and fixed five-file application manifest |
| `parent.files` | Every extracted file in original order as `{path, sha256, bytes}` |
| `entry` | One complete generated `.mjs`, `.cjs` or `.js` file as `{path, sha256}` |
| `command` | Current canonical Node `executable` and exact `args`, beginning with the relative entry path; no interpreter flags before the entry or shell |
| `budget` | Positive integer `timeoutMs` ≤ 20000 and `killGraceMs` ≤ 2000 |

This receipt records an independent controller decision; it is not an OS sandbox or a model self-approval mechanism. Review imports, arguments, process behavior and resource ownership before approving. Use only the owned project and loopback resources for this gate. Do not approve production configuration/credentials, detached unowned processes or unrelated endpoints. Existing authorization covers this owned validation; an unknown helper remains unreviewed until its complete bytes and exact invocation have been assessed.

The runner refuses failed prerequisites, incomplete/changed files, changed metadata, unsafe paths, symlinks, source overwrites, runtime settings and mismatched review/argv/budgets before spawning. It copies the fixed application plus all complete generated files into a new owned temporary project. It copies no Pi session, cache, auth or runtime settings, and gives the child an isolated HOME/config environment. It starts the exact Node invocation without a shell, records PID, executable/args/cwd, timeout/signals/close, entry/plan hashes, stdout/stderr and ordinary output files. It closes only that owned process group. A separate hard deadline bounds inherited-pipe waits: destroying the runner's pipes records failed, `closeObserved: false` and incomplete output, never natural EOF or unknown-child termination. Such unresolved finality blocks driver cleanup and final acceptance. Setup/copy failures retain their stage, ownership and a `not_run` receipt; with no spawn, the normal owned cleanup remains available. `status: completed` establishes one execution, while `productAcceptance.status` remains `independent-review-required`; output saying PASS does not establish any feature result. The controlled positive regression separately asserts actual loopback POST/GET behavior from its retained helper source and request/result artifacts.

The original model result is never rewritten by reviewed-helper execution. Its returned separate `graph-generated-exercise-*` evidence root contains the review, original result/plan, full generated files and final owned output hashes. Run original `evidence → cleanup → evidence` against that root; cleanup verifies ownership and process close, uses system Trash and binds the immutable execution result. Final acceptance requires that hash-bound cleanup and absent owned scratch, then revalidates retained evidence. A failed or timed-out execution keeps its failure evidence. D keeps a technically valid natural task at `waiting-for-independent-exercise` and continues its frozen cases without guessing a command. A passed natural-task semantic review must include `generatedExercise: {evidence, resultSha256}` on turn 0, pointing to a completed new helper receipt; the independent reviewer must assess the actual feature evidence as well as the answer. An old existing-project check cannot satisfy that requirement. Original failed A/B/C/D samples and frozen inputs stay unchanged.

Regression entry: `node --test scripts/notion-skill-graph-project.test.mjs scripts/notion-skill-graph-model.test.mjs scripts/notion-model-cache.test.mjs`. It covers the original-command distinction, daily sixth-file preservation, complete helper byte identity and real HTTP execution, pre-spawn negative cases, nonzero/timeout/print-only results, immutable parent evidence and Evidence→Trash→Evidence. It also exercises an actual copy fault, the pre-cleanup acceptance rejection, and a deliberately detached fixture pipe holder. That negative fixture identifies its own child by PID, start identity and token, performs only its outer owned cleanup, and preserves the driver's failed/unknown raw receipt and blocked cleanup. Controlled fixture proof, real-model task success and independent product acceptance remain separate.

The core helper, loopback HTTP, rejection, failure and finality assertions run on Linux CI as well. Only the system Trash round trip and post-cleanup acceptance positive require macOS with executable `/usr/bin/trash`; otherwise each fixture retains its evidence/scratch and emits explicit `System Trash ECE not_run`. The detached negative still terminates only its pre-identified test child. No whole core test is skipped, no `rm` substitutes for Trash, and no cleanup success is fabricated. `GRAPH_TEST_DISABLE_SYSTEM_TRASH=1` exercises this unavailable-capability branch on a capable test machine without changing production cleanup.

## Fixture coverage and acceptance scope

Retain renamed identities, heterogeneous Requires rejection, shared diamonds, multiple roots, optional Members/resources, renamed fixed paths, historical pins and cancellation in the existing controlled graph fixtures. These cases expose identity and topology assumptions without modifying another production library solely to increase coverage.

Choose live, host, UI, physical-machine and model cases from the frozen change/release scope and the [verification maps](../.agents/skills/verify-notion-skills-integration/features/skill-consumption.md). A passing controlled fixture does not stand in for those layers. Exact history restoration, source permission failures, relation pagination, corrupted/missing objects and session recovery each keep their own assertions. Do not turn an unrun scenario into a failed product result or rewrite an original failure after a later candidate passes.
