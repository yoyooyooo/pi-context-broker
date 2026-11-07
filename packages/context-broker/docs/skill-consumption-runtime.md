# Pi Skill consumption runtime

Pi uses the `ntn-skills` CLI and SDK bundled with Broker. A global CLI installation or a sibling source checkout is not required. Install the standalone CLI for terminal use or other Agents; record its identity separately when verifying interoperability.

The [Broker reference](reference.md#built-in-sources) owns configuration, the [CLI consumer contract](https://github.com/yoyooyooo/notion-skills-cli/blob/main/docs/consumer-contract.md) owns source consumption, and [fixed resource batches](fixed-resource-batches.md) defines resource reading. This page describes the host contract rather than the results of a particular candidate or private deployment.

## Public tools and intent

| Intent | Pi entry | Result |
| --- | --- | --- |
| Find a Skill | `notion_list({query?, source?, limit?, cursor?})` | Bounded candidate metadata and copyable references |
| Inspect a Skill or file | Native `read({path, offset?, limit?})` | Selected content; no workflow activation |
| Apply a Skill's guidance | `notion_use({ref, refresh?})` | Selected roots and the complete Requires closure |
| Read several fixed resources | `read({paths})`, or `notion_read_resources({paths})` when another extension owns `read` | One fixed-resource batch; no main-body preparation or activation |
| Find the CLI for content management | Deferred `notion_ctl({cli_source})` | Host-local command prefix and source/database scope; does not execute it |

Applying a Skill includes using its instructions to produce a plan, review, document or code. Use `notion_use` before doing that work even when the requested output is only text. This prepares the instructions; it does not authorize executing commands from them, writing files or changing remote content. A request to describe or inspect the Skill itself remains `read` intent.

`notion_list` does not choose the first result, read bodies or activate a Skill. `count` and `has_more` describe the current page; `coverage` separately records source completeness. Failed or unknown coverage is not an empty complete directory. Known exact references can be read or used directly without a mandatory search round trip.

`use` supports one root or an explicitly selected root set. Shared Requires are prepared once; Members remain candidates until selected. Cycles, missing required content, version conflicts and budgets retain their typed failures. Ordinary local Skills continue through Pi's native path.

`notion_use` is registered as a top-level model-only tool. Arbitrary nested Code mode use is outside the supported delivery path. An internal success, `print`, summary, truncated body or saved file cannot create activation. Support for another invocation surface requires proof that its complete outer provider content carries the correct delivery receipt.

## Default directory and SDK transport

The default Notion directory contains metadata from the selected View, not all Skill bodies. Additional discovery can reach authorized records outside that View. Ordinary chat need not wait for remote catalog completion; pending, failed and complete-empty states remain distinguishable.

The directory is a transient owned context message, so another extension's forced system prompt cannot silently remove it. Each provider request has at most one current owned directory. Descriptions may be omitted only when the same request already contains the matching complete instructions; titles or historical loaded flags are insufficient. Do not persist catalog snapshots as extra session messages.

Default Pi discovery and consumption call the bundled SDK and its shared core. Full catalog and Default View can share one operation while retaining independent outcomes, scope/descriptor validation and complete coverage. Preparation does not spawn a public CLI read per graph node. SDK operations, any runtime bridge processes, explicit CLI commands and HTTP attempts are separate cost categories; SDK transport is not a promise of zero processes or network requests.

An explicit `source.command` selects the documented compatibility transport. OMP and other compatibility callers keep their own supported paths. An unavailable or incompatible SDK fails explicitly rather than silently changing transport. Build metadata binds the bundled CLI and SDK to the selected package; a global CLI upgrade does not replace those embedded assets.

Each source operation retains its runtime scope, environment/cwd capture, cancellation signal, credentials, freshness and budgets. Reuse does not create a second cache authority, extend TTL by access, or bypass current authorization. Current read/consume can retain newly observed author edits through the core Records retention/adoption path; its write permissions, original-operation recovery and source costs remain part of that contract.

## Session references

| Reference | Binding |
| --- | --- |
| `sr:C…` | Candidate source, scope and owner; no selected version or activation |
| `sr:S…` | Exact selected main, snapshot/version, File identity, path and content hash |
| `sr:R…` | A fixed resource of that owner and snapshot, with its precise File identity and bytes |

Copy returned references unchanged. Compatible bindings reuse their handles; a refreshed selection gets distinct bindings and old handles do not drift. References belong to the actual session branch and are published only after their binding has been persisted and read back. Resume, fork, rewind and compaction follow that branch's history; a sibling branch cannot borrow private handles.

Short references are not authorization. Resolution still checks the current source, scope, owner and fixed version. Unknown or forged handles fail without guessing names or treating them as local paths. Exporting a canonical fixed reference preserves identity, while an independent process or machine still needs its own authorization and materialized content.

A resource read proves only that resource's bytes. It cannot restore a main-body pin, apply a Requires graph or activate the workflow. Binary materialization does not claim complete text or image delivery.

## Preparation, delivery and activation

Pi captures accepted user selections, arguments and images without blocking the input phase on remote preparation. Preparation runs under the actual agent cancellation signal. Failure aborts the turn instead of dispatching partial instructions; late callbacks cannot revive a cancelled invocation or obsolete session generation.

| State | Meaning |
| --- | --- |
| Selected | The branch has chosen exact roots and their required graph |
| Ready / cached / materialized | Content or files are available and verified |
| Visible | The actual provider input contains a complete verified body span |
| Active | The session has accepted the use instructions through the delivery contract |

These states are not interchangeable. Inspect does not activate. A provider-request event records pending delivery; a matching uncancelled response boundary may confirm the prepared active set. Response headers or HTTP 200 do not establish stream completion or successful model behavior.

Ordinary follow-up messages reuse valid active instructions. If compaction removes needed content, restoration uses the exact selected versions, combining compatible roots into one fixed inspect. It does not silently switch to current or recompute a new use graph. Explicit version selection and a new requested operation retain their own semantics; deduplication must not swallow an action merely because its instructions were previously loaded.

## Model content and machine proofs

Keep complete authored source text, including frontmatter, code and relationships. The model needs selected roots, names/kinds, usable references, complete necessary instructions and resource/relationship directories. Full graph locks, hashes, storage paths, scheduler state and other machine proof fields stay in structured details unless explicitly requested.

The preparation compiler is distinct from the source-identity compiler. Versioned details bind the compiler, full rendered text hash and length, original source hashes, canonical graph, purpose, roots, scope, owner, pin and actual tool call. Source spans use JavaScript UTF-16 offsets; hashes and byte lengths use UTF-8. Build spans during serialization rather than searching for tags that authored text could imitate.

Validate the actual tool/provider content against the proof. Unknown compilers, bad hashes, displaced spans, wrong identities, truncation and details without content cannot establish complete delivery. Historical receipts keep their original version semantics; do not synthesize a new proof for them.

Repeated verified main text can project to `Already loaded.`; repeated verified resources can project to `Already available.`. Reuse is valid only when an equal scope/owner/pin/file/hash body is complete in the current provider message set. Keep the name, reference and directory needed for further work. Empty resources stay empty.

A shortened provider copy explicitly stops proving complete delivery and gets a derived receipt linked to its validated parent. Original session results remain intact. If compaction removes the earlier full copy, the retained original can supply the full text again. Never overwrite the saved transcript with the short confirmation.

Budget the actual serialized model result, including wrappers and escapes. Refuse overflow before committing a selection; do not truncate source content to fit.

## Native reader and resource compatibility

Preserve the public scalar reader's paging, images, structured results, call identity and rendering. A third-party reader remains in place. When it prevents safely extending `read` with `paths`, expose the same existing resource batch handler through `notion_read_resources`.

The adapter rechecks availability at session start and before requests. Disabling `read` suspends the fallback; an explicit fallback disable remains respected. The ordinary Broker-owned reader supports `paths` without an extra synonym. Both entries use the same scope/owner/snapshot checks, cancellation, byte/context budgets and version-2 resource proof. See the [resource contract](fixed-resource-batches.md) for scalar capability fallback and batch limits.

## Cache and observation boundaries

CLI and embedded SDK share compatible core state and content-addressed objects. Broker can reuse verified immutable body/manifest projections across processes; mutable aliases remain instance-owned so changing one session does not rewrite another's selected content. Historical pins, aliases, unactivated metadata stubs and retained versions have different lifetimes. Do not delete them merely because one process has exited.

Durable local operation and recovery receipts, local bindings and synchronization common bases are not disposable content caches. Preserve them when clearing or retiring derived data; an unknown operation may not be reconstructible from currently visible remote facts.

Use source request metrics and isolated cache inventories to diagnose repeated work. A model provider's prompt cache is a different layer. A warm sample with no extra HTTP or objects does not establish a lifetime cache bound.

The passive `context-broker.notion-sdk` stream records operation and safe request metrics. Verification may explicitly subscribe to `context-broker.notion-sdk-result` for the corresponding result; ordinary runtime does not expose source bodies through metrics. Credentials and signed URLs must not enter public logs.

Compare source SDK operations, actual provider requests and observed host transport within their recorded scopes. Missing observer terminals, dropped trace entries or unknown response sizes stay unknown. Preserve HTTP cancellation separately from an application result; neither can be inferred from the other.

## Verification entry points

Run checks from the Broker checkout, with a fresh owned evidence directory and the exact installed artifacts under test:

```bash
bun run --cwd packages/context-broker test:consumption
bun run test:verification
node scripts/notion-sdk-pi.mjs --help
node scripts/notion-startup-flow.mjs --help
node packages/context-broker/scripts/session-short-ref-session.mjs --help
```

The [consumption map](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/skill-consumption.md) connects installed tools, resource reads, default directory, session restoration, cancellation and negative proof cases to the existing drivers. Local candidate installation and rollback are described in [Contributing](../CONTRIBUTING.md#local-pi-candidate-and-rollback).

Bind each report to package/CLI/SDK identities, actual source scope, input, cache/session state and evidence coverage. Unit or controlled-provider success does not establish real Notion latency, model selection, another physical machine or final task quality. Keep original failures and unrun cases outside the checkout rather than converting the documentation into a chronological run ledger.
