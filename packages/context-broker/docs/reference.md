# Broker reference

[English](./reference.md) | [中文](./reference.zh-CN.md) · [Project overview](https://github.com/yoyooyooo/pi-context-broker#readme)

Full configuration, discovery and injection reference for the Pi/OMP broker. Start with the [quick start](../README.md#quick-start).

[Skills](#skills) · [Routers](#routers) · [Configuration](#configuration) · [Sources](#built-in-sources) · [Rules](#rule-files) · [Commands](#commands) · [Completion CLI](#completion-cli)

## Skills

Context Broker discovers `SKILL.md` files through legacy `skillRoots` and built-in filesystem sources, and Notion Skill metadata through built-in Notion sources.

For legacy `$` discovery and configured skill invocations, roots are scanned in configured order and the first normalized
skill name wins. Source records keep separate identities and canonical tokens; see [built-in sources](#built-in-sources). Put a distributed runtime root before a source catalog when the
installed copy should take precedence. Directory and `SKILL.md` symlinks are
followed, but the discovered path is preserved for relative references. Broken
links and ancestor cycles are skipped; scan depth, ignore, and size limits still
apply. This does not rewrite links inside skill bodies or explicit bundle member
paths.

```markdown
---
name: design-review
description: Review architecture and API trade-offs.
autoload:
  enabled: true
  aliases:
    - architecture-review
---

Review the design for ownership, boundaries, failure modes, and migration cost.
```

`requireAutoload` defaults to `true` and filters configured Skill invocations and keyword rules to Skills with `autoload.enabled: true`. Explicit `$name` lookup and completion discover configured Skills regardless of that gate. `CONTEXT_BROKER_REQUIRE_ENABLED` overrides the gate for configured invocations and rules.

## Bundled Skills

Connected-library maintenance first reads the Notion projection of `ntn-skills-maintain` through ordinary native `read`, using the exact candidate ref from the task's source/library. If its default directory is pending or omits the entry, discover it with scoped `notion_list` before reading. Failed or partial discovery is not absence. Keep existing selected instruction versions until an explicit refresh. The edited Skill itself is inspected without workflow activation.

Inspection of the maintenance workflow does not adopt it. When the task applies that workflow, call `notion_use` with its same-source exact ref to load Requires, unless the closure is already prepared. With shell access and no native use tool, use the selected source's CLI `use EXACT_REF --database ENTRY --json`; CLI refs must be canonical, never session `sr:` handles. If neither route is available, report unavailable adoption. Generic hosts use their available `skill_prepare` purpose `use` route. Local and packaged workflows keep their native selection path.

`$ntn-skills@builtin`, `$ntn-skills-maintain@builtin` and `$ntn-skills-sync@builtin` are ordinary local Skills shipped with the Broker and standalone Tern query. They appear in `$` discovery only when at least one configured `type: notion` source is enabled (`enabled` is not `false`); without enabled Notion sources they remain packaged but are hidden from discovery. The installed entrypoints and relative references are readable offline even before Notion authentication succeeds and without a global `ntn-skills` executable. Choosing them follows the same discovery, draft and loading path as any other `$` Skill.

Use the packaged maintenance and source workflows for explicit bootstrap or offline help. They do not silently replace a connected Notion projection after a discovery or access failure. Daily CLI consumption is `ntn-skills list [--query TEXT]`, `read REF` and `use REF`; `files` and `export` are optional helpers, and management commands live under `ctl`. In Pi, an authorized management task can discover the deferred `notion_ctl` tool and request `{cli_source:"SOURCE_ID"}` for the chosen source's bundled executable and database scope; `bash` must be active to use this route. Choose the source explicitly. OMP/Tern evolution is deferred.

Private package content has a `builtin:<name>` identity and a fixed `@builtin` selector when enabled. A same-name filesystem or Notion entry remains independent and receives its own selector. A configured source named `builtin` cannot claim these official tokens. Physical aliases of the same bundled entry are deduplicated before local name precedence.

Upgrading the Broker/companion upgrades these workflows and resources. Restart the host after changing extension code. There is no prior publish/install step and no scan of old central installation receipts. User-managed copies remain regular files and can still be selected through explicitly configured roots.

The host command surface is `/context-broker` for session/View selection, metadata refresh and diagnostics. CLI tasks use ordinary `$` workflows or the actual CLI directly; `/ntn-skills`, its save wrapper and Tern management/schema palettes are no longer registered.

## Routers

Routers live in discovery catalogs. They inject an index, not the full member files.

Notion Router records use `ROUTER.md`. The CLI owns their body and deterministic member index; the broker loads only the selected entry. Subscription Routers are usable only after the CLI publishes an active member mapping.

```yaml
version: 1
records:
  - kind: router
    name: workspace-collab
    description: Collaboration contexts for documents, chat, and tasks.
    aliases:
      - collab
    render:
      type: member-index
      rules:
        - This is a context router index, not a concrete skill.
        - Select the needed member before acting.
        - Read the selected member file before using member-specific details.
    policy:
      memberBody: read-before-use
      scope: members-only
    members:
      include:
        - docs
        - chat
```

When you type `$workspace-collab`, the model sees the bundle description, policy, and member list. It does not receive `docs` and `chat` bodies unless a later step reads them.

Rules can inject the same lightweight index without loading member bodies:

```yaml
id: collaboration-keywords
inject:
  - router:workspace-collab
match:
  - contains:
      - team workspace
```

The `router:` prefix is required for rule targets. Unprefixed rule targets keep the existing Skill-only behavior. Router rule lookup uses exact names or aliases from configured discovery catalogs and does not fuzzy-match.

## Content lifecycle

Every CLI catalog exposes `records` with required `id/kind/locator/name/alias/description/default_context/entrypoint/ref`. The broker rejects unknown kinds, malformed locators and legacy `skills/skill` responses. Selected consumption binds the complete main body and file manifest to one source, scope, record and immutable snapshot. Legacy complete exports also verify portable manifest v2 and every file. Entry files are `SKILL.md`, `ROUTER.md` and `PROMPT.md`.

Select a Prompt explicitly with `$alias@notion`. Each submission owns a new invocation, session generation and prepared snapshot set; preflight and dispatch reuse that exact snapshot. Repeating the same Prompt on the next submission appends its full requirements again at user-task level, preserving original text and images. Prompt never enters native Skills, default discovery, background preparation, keyword activation or system prompts. Stop, timeout and session changes invalidate pending dispatch. Completion acceptance changes only the draft; all hosts and detached completion share `identity/kind/source/ref` and existing UTF-16 edit ranges in protocol v1.

The submitted Prompt snapshot remains the authority for entry and resource reads after `agent_start` releases preparation. Upstream changes cannot replace it during that turn. Turn end, cancellation, reset/refresh and session boundaries discard this authority; a new submission prepares fresh requirements and resources without a session-level loaded marker.

Old domain Bundle catalogs and stored session markers require explicit conversion with `node scripts/migrate-content-assets.mjs INPUT OUTPUT`. Runtime discovery accepts only Router records. Conversion writes a separate output and preserves immutable snapshots and resource paths.
Conversion is limited to catalog records and recognized Broker session envelopes/details. It preserves authored text, immutable snapshot IDs, resource paths and unknown nested fields literally; only schema-owned kinds, Router references and source receipt identities change. Mixed catalog envelopes and malformed members fail before output publication. Run the standalone regression with `bun test scripts/migrate-content-assets.test.mjs` from the checkout root.

## Configuration

Config resolution order:

1. `CONTEXT_BROKER_CONFIG`
2. `<agentDir>/context-broker/config.yml`
3. `<agentDir>/context-broker/config.yaml`
4. `<agentDir>/context-broker/config.json`

`PI_CODING_AGENT_DIR` sets `agentDir` when present. Otherwise the plugin uses the host default:

- Pi: `~/.pi/agent`
- OMP: `~/${PI_CONFIG_DIR:-.omp}/agent`

Full config example:

```yaml
skillRoots:
  - ~/context/skills
extraSkillRoots:
  - ./.agents/skills

# If omitted, the broker uses rules next to the config file.
ruleRoots:
  - ./context-broker/rules

discoveryCatalogs:
  - ~/context/catalogs/workspace.yaml
extraDiscoveryCatalogs:
  - ./context/catalogs/project.yaml

requireAutoload: true

# absolute | home-relative | basename | hash
pathMode: home-relative
logPaths: false

scan:
  maxDepth: 8
  maxSkillBytes: 65536
  ignore:
    - .git
    - node_modules
    - dist
    - build
    - coverage
```

### Built-in sources

`sources` adds typed sources to the configuration. `skillRoots`, `extraSkillRoots`, discovery catalogs and their environment overrides remain supported alongside sources. Notion sources must use the current paired SDK configuration; remove retired `command` overrides. Relative filesystem roots and `cacheDir` resolve against the consumer's working directory, and `~/` expands to the home directory.

```yaml
sources:
  - id: local
    type: filesystem
    roots: [~/context/source-skills]
    requireAutoload: false
  - id: notion
    type: notion
    enabled: true
    namespace: notion
    # Consumption uses the paired SDK; management uses the bundled CLI.
    # Replace this example with your Skills database id/selector.
    database: 00000000-0000-0000-0000-000000000000
    cacheDir: ~/.cache/context-broker/notion
    discovery: {maxAge: 5m, offline: false}
    activation: {maxAge: 5m, offline: false}
    prefetch: false
    requestTimeoutMs: 30000
```

| Field | Applies to | Meaning / default |
| --- | --- | --- |
| `id` | Both, required | Unique source identity; letters, numbers, `.`, `_`, `-` |
| `type` | Both, required | `filesystem` or `notion` |
| `enabled` | Both | `true`; `false` skips discovery and prevents activation |
| `namespace` | Both | Defaults to `id`; same character rules as `id`; prefixes internal canonical tokens and suffixes Notion selection tokens |
| `roots` | Filesystem, required | Nonempty array of paths containing Skills |
| `scan` | Filesystem | `maxDepth`, `maxSkillBytes` (nonnegative safe integers), `ignore` (string array); defaults to top-level `scan` |
| `requireAutoload` | Filesystem | Defaults to top-level `requireAutoload`, then `true`; this source's discovery filters on `autoload.enabled` when true |
| `database` | Notion | Optional database id/selector; scopes discovery and selected SDK/CLI consumption |
| `default_view_id` | Notion | Optional stable View ID; session selection overrides it, otherwise missing configuration uses the first View in API order |
| `cacheDir` | Notion | Defaults to `~/.cache/context-broker/notion`; disposable metadata indexes, current prepared entries and on-demand resources |
| `discovery` | Notion | Metadata `list` policy: `maxAge`, `offline` |
| `activation` | Notion | Selected consumption policy: `maxAge`, `offline`; enforced by the SDK |
| `prefetch` | Notion | Defaults to zero budget; omitted, `false` and legacy `true` perform no body warming. An explicit object may set `maxNodes`, `maxBytes`, `maxDepth`, `maxTimeMs` and `rateShare`. Required nonzero limits enable bounded metadata-selected warming; depth may be zero. Explicit selection remains available. |
| `requestTimeoutMs` | Notion | Per-network-attempt timeout passed as `NTN_SKILLS_REQUEST_TIMEOUT_MS`; positive integer ≤ 2147483647; CLI default 30000 |

Policy `maxAge` accepts `0` or an integer followed by `s`, `m`, `h`, or `d`. Omitted policies use the CLI's defaults. `offline: true` uses existing CLI cache and takes precedence over `maxAge`; unavailable/incomplete cache fails instead of silently fetching. The [schema](../examples/config.schema.json) rejects unknown source fields and invalid type-specific values; duplicate source ids are checked by the broker.

Source operations have no aggregate deadline. Each network attempt receives its own timeout; pagination and rate-limit waits can make preparation longer. An explicit `requestTimeoutMs` sets the SDK operation or management CLI environment. Escape, Stop and session cancellation abort the owned SDK operation or management process tree. Discovery and activation keep their own freshness policies; Broker does not maintain another catalog cache or renew the SDK validation time.

Notion metadata uses `listCatalog`. Skill/Router preparation, direct Prompt loading and bounded prefetch all use `consume`; supporting files use `readSkill` or the current batch resource operation. The paired SDK returns the complete manifest and exact main body once. Broker initially materializes the main entry and retains every declared File binding for on-demand reads; `manifest_complete` does not mean every file is local. Each explicit Prompt submission obtains its own material. `source.command`, CLI prepare/read fallback and full-export snapshots are removed. Old or incomplete packages fail explicitly; upgrade the paired CLI/SDK and Broker together. OMP/Tern evolution is deferred.

The paired runtime accepts SDK v2 only, with matching SDK/runtime capabilities. Consumption performs no remote semantic writes and has no `readOnly` option. Catalog-directory v1 provides full-catalog and Default View projections in one operation. Each projection keeps its own result, so an unrelated catalog failure does not hide an accessible View. Missing capability fails before dispatch.

Within the effective outgoing request, a complete Skill or resource body appears once for its exact identity and selected version. Explicit repeated `read` and `notion_use` operations still run, but their model projections can reuse a complete body and generated directory already present in that same request. Each operation retains its own effects. Summaries and past loaded flags are not complete-content witnesses. Original session entries and tool results remain intact. Retiring old source text does not erase an observed or unknown operation outcome. See the [projection contract](skill-consumption-projection.md).

Authenticate using the existing `ntn-skills` project token. If explicit configuration is needed, use `ntn-skills ctl config set-token --stdin` with a trusted secret-input pipeline. The CLI prioritizes its saved token, then nonempty `NOTION_API_TOKEN`; missing credentials return `AUTH_REQUIRED`. Broker and Tern configuration have no token field.

The build packages a standalone `ntn-skills` CLI, its three workflow Skills, runtime dependencies and license notices in both products. Pi's SDK is bundled from the same selected `ntn-skills` package as the CLI. [Build input selection](../CONTRIBUTING.md#bundling-cli-and-skills) determines the shipped version. Online Notion sources use the project's direct HTTP engine. `/context-broker doctor` invokes the bundled CLI's `ctl doctor --database ID`, requires `transport: direct_http`, `notion_api_version: 2026-03-11` and authenticated access, and can populate caches. Without a database, the CLI doctor checks authentication only. Offline discovery requires complete existing Notion caches; packaged Skills require neither Notion access nor those caches.

Source failures remain visible with safe source/code/message metadata. Authentication, transport and malformed-response failures revoke that source. A valid partial directory instead retains precise records with a nonblocking `CATALOG_INCOMPLETE` warning and page-qualified tokens; it does not prove absence or unique names. A failed default View yields empty default metadata and a repair hint, while exact explicit choices from the full directory remain available. Selected record authorization and snapshot integrity still gate body delivery. Local Skills and ordinary chat continue. Never replace a failed explicit View with another View or the entire library.

Pi registers the extension and composer while metadata discovery continues in the background. Interactive and RPC ordinary input and unrelated native file reads do not wait for a cold, slow or failed directory. A one-shot `pi -p` print or JSON submission instead awaits the existing directory request in its first cancellable context stage, before the first model request. This wait loads metadata only; cancellation or session replacement stops it, and a failed directory remains unavailable rather than becoming empty.

The current directory is one temporary catalog data message in the final request projection. It contains names, descriptions, source identities and exact references, not unselected instruction bodies. This message survives a host extension's exact system-prompt override without changing its safety rules or tool declarations. Repeated projection replaces only the Broker-owned catalog; it does not append directory history or rewrite the native session. Pending or unavailable discovery offers `notion_list`, and pending never means an empty directory. Background requests still count as discovery work. Explicit `$` selections, exact `/skill:` input, `notion_list`, `notion_use` and Notion reads retain their required directory, authorization, identity and fixed-snapshot checks. Selection failures block partial instruction dispatch, and a replaced session cannot publish its old preparation. Ordinary follow-up messages retain already active instructions and their selected snapshots.

Notion UI changes are external to the CLI cache. Exact references fix identity, not freshness: current reads can reuse an eligible observation, while fixed reads preserve history. Broker retains the SDK's original validation time and remote/cache origin. Metadata, read and use update one scoped eligibility owner; older caches or historical pins cannot clear a newer denial. Exact dependency failures update that dependency, not a guessed root. Cancelled/retired operations and older in-flight results cannot replace a newer accepted verification.

Public `notion_list` and the first submission context reach the existing directory TTL without relying on editor completion. Repeated hits do not renew it, and concurrent expiry checks share the existing request owner. Interactive input can retain pending metadata; print/JSON waits at its cancellable context boundary. `notion_list({query?,source?,limit?,cursor?,refresh?})` accepts `refresh:true` to verify discovery after a write or request current metadata. A supplied source limits forced acquisition to that configured source; an omitted source selects all enabled configured Notion sources. Offline policy is preserved. This metadata-only operation refreshes the paired catalog/View observation without cancelling the current turn, adopting instructions or replacing selected graph pins and fixed refs. Concurrent forced requests coalesce or widen the same pending acquisition; waiters follow its current publication even if retired work has not settled. `/context-broker refresh` remains the explicit host-wide refresh command.

When a user asks whether a named Notion Skill exists or is available, the Agent must call `notion_list` with that name as `query` and `refresh:true`, including in an existing conversation and after an earlier hit or miss. The default View and conversation history do not replace this check. Explicit source choices still apply. The lookup reads metadata only and keeps selected root/Requires versions fixed. A fresh, complete lookup can establish that no available match was found in the searched scope; offline, stale, failed or partial results cannot establish current absence. Continue pagination with the returned cursor and without another refresh. A disabled Skill may be absent from the available directory; this does not prove its Notion page is missing.

`freshness.sources` reports each selected source's original SDK `validated_at`, elapsed `age_ms`, `max_age_ms`, `policy` and `stale` separately from `coverage.sources[].exhaustive`. Missing observations have null fields, not a new verification timestamp. Repeated list calls advance the reported age without renewing validation. Failure and partial coverage remain visible even when some metadata is available. A successful fresh lookup and a complete lookup are separate claims. Cursors bind to the metadata publication as well as effective availability and View/coverage, including a refresh that returns identical entries. Restart pagination after refresh; `cursor` with `refresh:true` is rejected before acquisition.

Current eligibility, fixed selection and delivered text are separate. Disabled content cannot be newly applied or implicitly restored; an existing delivered historical explanation is not erased. Known permission denial or a changed authenticated scope blocks further Broker-controlled delivery/restoration of its verified source, without editing native history or claiming to revoke a request already sent. A complete explicit new graph replaces the prior selection only after its fixed files, identity and response budget pass; failure keeps the prior graph.

`Default Context` is retained as an optional author-managed organization/View-filter attribute, not a second availability or body-injection switch. Existing values, stable schema and author APIs remain because real Views and integrations may use them. In an unfiltered View, changing it has no independent effect; in a View that explicitly filters it, normal View freshness determines membership. `Enabled=false` always wins for new ordinary consumption. No global field rename, deletion or forced UI hiding is performed.

Pi reserves a selected submission at the input boundary and acquires its directory, graph and bodies in the `context` hook after `agent_start` supplies the operation signal. The pending submission retains its original text, images and accepted identity. **Stop**, Escape, RPC `abort` and session replacement cancel that acquisition. Preparation errors abort the host operation, so a failed or superseded acquisition cannot proceed to the provider.

Pi records active instructions only for the current, uncancelled request after `after_provider_response` receives a 2xx status. It checks the complete bodies in that request and, for Notion records, their fixed `use` graph before appending `context-broker-active-sources`. This event reports response headers, before the response stream finishes; it confirms logical request acceptance, not model completion and not final wire delivery. `before_provider_request` is not the last payload mutation: later handlers can replace it, and the response event has no body. On the normal `openai-completions` HTTP route, the broker checks serialized tool results and broker-owned user/custom deliveries against that context, binds the entity digest, and records a wire receipt only when Node Undici observes the same digest on that run's model endpoint. A known mismatch does not confirm active, selected, or persisted state. A body already sent stays dispatched and is not rewritten as provider status 0. Other APIs, mock providers, and non-Undici transports stay explicit non-wire coverage. `/context-broker request` prints at most 32 in-memory hashes, counts, fixed snapshot pins, copied/reused/retired state, sanitized `remote_writes`/`author_content`, and errors. It stores no source body, path, ref, or secret, and it adds no model tool. Scalar and batch `contextBrokerResource` results are checked with main and preparation results. A same-endpoint concurrent dispatch that cannot be tied to one run is unknown, not a wire success. An in-process mock payload remains logical-only. Cached files, a `ready` result, a selected graph, a summary and display-only loaded logs do not establish active state. The [Skill consumption runtime](skill-consumption-runtime.md) describes these separate current states.

Pi 1.4 collects extension resource paths through `resources_discover` at startup or reload; it exposes no extension API to refresh its native Skill menu after late metadata arrives. The broker publishes late metadata in the request's `<ntn-skills-view-catalog>` and supports exact `/skill:` input through its preparation gate. Pi's Notion naming surface groups consecutive same-source cards under `<catalog-cards>`. A card keeps its author name, full description, location and optional ref. A self-closing card means the description was omitted because the same request already shows that exact card. An empty card element is an empty author description. OMP and other non-Pi surfaces keep the existing `<available_skills>` and `<available_routers>` elements. Its `$` completion is a separate surface and does not prove the native menu was refreshed. The broker does not reload the session automatically to update that menu.

OMP retains its existing behavior: discovery does not block its composer, but the first ordinary submission awaits the current View directory before calling the provider. `before_agent_start` rebuilds one `<ntn-skills-view-catalog>` in the system prompt, removes only Broker-owned stale native entries by exact path, and preserves unrelated local entries and conversation bodies. Starting a session, listing Views and changing a View do not themselves call a model. The default zero prefetch budget starts no body preparation when the directory is registered or changed. Explicit budgets can warm a bounded subset of that View without selecting or loading those records. Full-catalog coverage and View-query coverage remain distinct; neither freshness nor an available individual page repairs missing coverage.

All Notion metadata discovery uses the paired in-process SDK. Its core catalog owns credential and database isolation, freshness and HTTP request limits. `source.command` is rejected; there is no custom-command catalog or identity-command fallback. Broker uses `cacheDir` for disposable metadata stubs and selected entry/resource materialization under the SDK credential scope. This directory is not a second authoritative catalog. Its default is global; an explicitly relative path resolves against the working directory. Changing the source ID or namespace does not change the underlying credential scope, and every selection still retains its configured source identity.

Catalog age is measured from the SDK's original `validated_at` under the current discovery policy. Reading cached metadata or restarting the process does not renew its TTL. During a process, expired menu metadata can remain visible while one refresh runs. Candidate positions stay bound to identity; new choices are appended and removed choices are disabled, and status rows cannot replace draft text. Cancellation settles a superseded lookup immediately. A transient refresh failure retains prior choices with its failure reason and a five-second retry gap. Authentication, permission and scope failures withdraw those choices. `discovery.offline` uses only eligible local data. Catalog refresh reads no bodies, and selected activation retains its separate authorization, freshness and fixed-binding checks. `/context-broker refresh` reacquires current metadata; it does not reload extension code or alter already loaded conversation bodies.

When a new Pi session has no Notion `$` candidates, check its enabled source configuration and installed Broker path before changing content. The SDK has no artificial whole-operation deadline; each network attempt follows the paired core request budget. Discovery remains metadata-only without per-member body requests. Retired Bundle catalogs and old remote locator declarations require an explicit authored-data conversion. A refresh does not translate them. Selected-View membership controls native default discovery, while complete `$alias@namespace` discovery remains independent of that View.

`SOURCE_RESPONSE_INVALID` means the observed response failed the current strict protocol. Remote records require a `shared_skill` locator, canonical logical ID/ref, explicit `enabled`, and matching database/data-source coverage. `notion_page`, `notion_subscription` and attached `upstream` metadata are rejected. Compare the response with the installed paired package; checking a source checkout does not upgrade Pi. Install matching CLI/SDK and Broker packages, then start a new Pi process. A catalog refresh only reloads data. Real terminal candidate selection and complete-body delivery remain a separate daily-use check.

`STATE_CUTOVER_REQUIRED` preserves its code through catalog, body and resource operations. Start the current CLI with a fresh `NTN_SKILLS_HOME`, which owns `state.sqlite`, and retain the previous home for any needed byte recovery. Old sync/upstream configuration also requires a fresh `NTN_SKILLS_CONFIG_HOME`. Clearing Broker's `cacheDir` or changing `NTN_SKILLS_CACHE_HOME` does not migrate that state.



Catalog provenance accepts only `role: content`; an omitted role has the same meaning. Every current record belongs to its declared database/data-source pair and a successful `coverage.queried_data_sources` query. A configured database selector limits that content database. Source ID, namespace and credential scope remain bound through metadata registration and exact-ref activation. The logical `shared_skill:LIBRARY:SKILL` identity and its physical page UUID are checked separately. A direct read does not prove directory completeness; a partial catalog retains exact available records and an explicit coverage failure.

Record identity is `JSON.stringify([sourceId, sourceScope, kind, locator.type, id])`; source is independently local/notion. Filesystem identities use the real file path. Automatic Notion completion normally inserts `$alias@namespace`, adding a page ID for collisions; accepted identities are captured synchronously by the current preparation gate before any asynchronous work. A new draft accepted while that submission runs cannot replace its identity or be cleared when the earlier turn ends.

Detached/manual completion always inserts the existing full identity syntax: `$alias@<normalized-page-id>@namespace` for Notion and `$name@<encoded-local-id>@namespace` for filesystem content, with `local` for legacy roots. A renamed alias still resolves the same exact identity. Official bundled Skills retain `$name@builtin`. Candidate labels remain short and readable. `skillRoots` retain first-name precedence within local roots; independent source and content-kind identities remain separate. Shared selectors still reject ambiguity.

Autocomplete and manual search use the record's authored name and the configured source namespace. Use `$alias@namespace` to disambiguate sources; detached/manual acceptance also carries the exact page ID. A repository label or subscription name does not create an implicit namespace or establish an identity. Unicode and percent-encoded aliases remain opaque, and every accepted choice resolves back to its source, scope and full current locator.

Exact returned selection tokens take precedence over source-alias shorthand. A local `$name@local` reference also selects the retained local record when completion displays its unqualified name. Thus a source namespace named `local` cannot make an accepted local token ambiguous with a source record whose returned token includes its page ID; genuinely shared local tokens remain ambiguous.

Dots inside source ids and namespaces remain part of the selector, for example `$ui-alpha@team.prod`. A trailing sentence period is excluded from the invocation.

When names conflict, automatic completion displays source-qualified choices. An accepted selection whose exact read reports target not-found produces both a user warning and model-visible `context-broker-unavailable` detail with `state: not-loaded`. A full identity token absent from the current catalog reports `catalog-unavailable`; it does not invent a Notion lookup result or metadata. The unavailable entry is never a loaded receipt. Repeated context assembly in the same submission neither repeats its read nor appends the same missing explanation; a later user submission may retry.

Unknown bare `$name`, simple `$name@namespace`, amounts, paths such as `$bunfs/root/chunks/cli-nxfh2cp0.js`, escaped text and Markdown examples remain ordinary text. Other valid references, original material and images still proceed once beside an unavailable selection. Ambiguity and actual selected-record permission, network, source, catalog or integrity failures continue to block dispatch. No alternative source is chosen silently.

### Pi session short references

Pi publishes opaque references from the current session branch for Notion records. They are locators, not credentials or filesystem paths.

Git and mixed Skills expose one complete current file directory. The CLI/SDK owns each file's explicit native, resource or source descriptor; editing a Notion reading projection does not silently change Git/resource authority. The main document is authoritative in Notion. Broker consumes exact bytes and File bindings without adoption or a second ownership model. Notion page history and Git history remain external to this consumption protocol.

| Prefix | Binding | Available through |
| --- | --- | --- |
| `sr:C` | An authorized catalog candidate; no selected snapshot | `notion_list` and View metadata |
| `sr:S` | A selected main with exact scope, record, snapshot, version, File and body hash | `notion_use` and a complete native main read |
| `sr:R` | One resource bound to an `sr:S` owner, path, File, bytes and hash | The prepared directory or native read's `skill-directory` footer |

`notion_use({ref:REF})` accepts a returned `sr:C`, `sr:S` or canonical main-entry `skill://` reference; `ref` may also be an array of roots needed together. It loads the roots and complete Requires closure to apply their instructions. To introduce, summarize or inspect a Skill, use native `read({path:REF})`; inspection does not activate Requires. Resources use their supplied exact refs. The deferred `notion_ctl({refs:[REF]})` exports canonical proofs for fixed `sr:S`/`sr:R` bindings; an unfixed `sr:C` cannot provide that proof.

Pi's normal use result contains selected root references, complete bodies and compact resource/relation directories. Full hashes, graph locks, canonical identities and materialization proofs stay in tool details and explicit proof export. The deterministic compiler preserves author text byte for byte; its versioned receipt binds source and rendered hashes to actual content spans. Repeated reads and explicit replacement derive fresh provider-only receipts without editing session history. OMP retains its existing result shape. The [projection history](skill-consumption-projection.md) records earlier tool names and evidence; the current public consumption contract is list/read/use.

`notion_list` keeps complete candidate names, descriptions, source, availability and pagination while moving repeated `id/scope` fields to host details. Copy `next_cursor` to continue the same query; partial coverage or a failed source is not an empty directory. Current Notion selections inject one fixed reference, a usable resource directory and the full body; common instructions appear once in host guidance. Restored selections use a fixed canonical reference without claiming that a local directory is registered after restart. A complete native main read keeps its exact body prefix and shares the compact directory schema; its full directory remains in `contextBrokerRead.directory`. Source content and Notion management data remain complete. See the [cross-entry projection measurements](skill-model-surfaces-verification-2026-11-05.md).

`notion_ctl` is registered as deferred and inactive by default. Pi's optional `tool_search` can discover it when management or proof export is needed; a host with discovery disabled must explicitly enable the tool. `notion_ctl({cli_source:"SOURCE_ID"})` requests one enabled Notion source's host-local CLI invocation metadata, requires active `bash`, and cannot be combined with `refs`. Its response is `{kind:"host_cli_scope", sourceId, command, database?, executed:false}`. It resolves the paired bundled executable without assuming a global CLI installation, accessing the network or running a command. A source-level command override is rejected. Unknown and disabled sources fail. The response grants no execution permission and proves no connectivity. Graph and `refs` exports remain portable and contain no machine paths.

OMP retains `skill_search`, `skill_prepare({roots,purpose})` and `skill_graph` for its existing host protocol. These are compatibility callers, not a second default Pi tool set. Historical calls, pins and session receipts retain their original version and are not renamed in stored transcripts.

Bindings persist in branch entries before they are advertised and replay on resume. A reference absent from the current branch fails explicitly. Each use still checks the current authorized source, full owner identity and fixed snapshot. Unknown, malformed, wrong-scope or mismatched-owner references cannot fall back to filesystem reads or current content. Allocating a reference does not read or activate its body; `sr:S` and `sr:R` also do not prove delivery.

### Host discovery and selected activation

Broker owns Notion usage guidance at runtime. Do not duplicate it in global `AGENTS.md` or `CLAUDE.md`; those files should contain cross-agent preferences and policies. The normal Pi guidance is a short routing and authority contract. Tool schemas own pagination, refresh parameters and detailed arguments; selected content owns its workflow. Missing native capabilities add only the corresponding scoped CLI fallback. No enabled Notion source means no Notion guidance, catalog or tools.

Pi builds `<ntn-skills-guidance>` from its public active-tool list before provider dispatch. Daily consumption uses `notion_list`, native `read` and `notion_use`; local Skills retain native discovery and reading. Native reads accept exact advertised `sr:C`, `sr:S`, `sr:R` and canonical `skill://` references. Complete native discovery and reading do not receive redundant CLI argv or shell templates. Missing operations use the selected source's CLI fallback only when `bash` is active; guidance enables no tools. Management uses the deferred `notion_ctl` route described above. Ordinary follow-up questions reuse complete content; explicitly requested read/use operations still execute through an available, authorized route. Introduction or inspection treats instructions as source content without adopting their workflow or prerequisites. `notion_use` stays a direct model tool: an inner Code mode result cannot prove complete delivery to the model.

OMP and hosts without a public active-tool API retain the existing CLI guidance. Its argv comes from the same resolver as host commands, retaining each enabled source's ID and optional database. The scoped `list-args`, `read-args`, `files-args` and `resource-read-args` arrays provide fallback syntax. Keep JSON output to check CLI `ok`/`error` and snapshot identity, and use subcommand help for syntax failures. Neither guidance path itself discovers content, executes commands or activates a Skill.

Session `sr:` handles belong to Broker and are not accepted by the standalone CLI. CLI fallback uses a returned canonical reference or selected snapshot/path. When only a session handle is available, the source's CLI `list` can recover the canonical candidate by exact record identity; do not guess its identity from a name or append a path to an `sr:` handle. Prefer copying the canonical resource ref returned by the system.

The host observes literal `ctl library skill`, `ctl library import` and current `ctl library source` calls to the paired bundled CLI. Native Skill actions are `create`, `update`, `register` and `remove`; their accepted completion statuses are respectively `created`, `applied`, `registered` and `removed`. Each matches the command action, exact stable Skill or physical page, current library/database/data-source binding, automatic operation and input fingerprint. Register also proves its unique file paths; remove proves complete cleanup coordinates and `cleanup_verified:true`. Native commands own their operation continuation and do not accept import's `--operation`, `--resume` or `--supersede` flags. Dry runs and native `unchanged`, `not_found` or `already_trashed` outcomes do not prove a new write.

Source actions are `apply`, `refresh`, `enable`, `disable`, `remove`, `takeover` and `restore-follow`. Results must match the observed command, operation and exact library/database/data-source binding. Import matches the stable Skill and a valid physical page within the exact library. Rebuilding a deleted Skill can change that page ID; the result only schedules fresh discovery and never supplies replacement content. Source declarations require complete child results: each child is ready, or explicitly removed with zero files after upstream deletion. This includes deleting every member. File transfers still require ready children and also match the Source path, stable File and target Skill. Enable/disable results must match the requested Boolean and exact metadata target bindings. Remove requires `action: remove`, `state: removed` and `status: removed`; a ready child acknowledgement cannot prove Source retirement. The Source page is never treated as a Skill page.

A successful `applied` or `removed` result marks only the corresponding configured sources for fresh discovery. Ordinary `unchanged` does not. An explicit same-operation `--resume`, or `--supersede OLD --operation NEW`, may refresh visibility even when the new result is unchanged. Supersede requires distinct old/new identities and is incompatible with resume or a true dry run. Current database IDs, HTTP(S) Notion URLs and exact configured aliases select the same scope. Equivalent flag syntax, distinct repeated import `--native PATH` values and exact file-transfer arguments are accepted. Takeover defaults to resource; `--as native` explicitly selects an editable body. Duplicate singleton flags, repeated native paths, invalid action-specific flags, true dry runs and compound shell commands are rejected.

A failed write with a verified matching current operation can also invalidate discovery because some work may already be applied. Import requires its Skill context; Source requires the finite parent Source intent and input fingerprint, so a child operation cannot stand in for the parent. Before a supersede handoff, an error may still identify the explicitly named predecessor. That permits only a conservative reread; successful completion must identify the new operation. Errors remain errors. A recognized host truncation footer causes one conservative refresh only when the exact entry identifies the source; it does not prove success or trigger an artifact or declaration-file read. Local preflight failures without operation context, unknown output, multiple JSON results and JSON text containing a truncation marker do not become completed writes.

Automatic refresh preserves source offline policy, accepted drafts and already selected conversation content. A verified write during acquisition fences the older catalog and paired View before host publication. Writes outside the observed literal call use normal TTL or explicit `notion_list` metadata refresh when discovery must be verified. The observer never guesses shell expansions, follows arbitrary wrappers or injects returned content. Retired create/apply/sync receipt shapes, separate operation routes and OMP artifact-following remain unsupported.

Successful CLI reads return top-level `content` (body), pinned `ref` (the relative `read --from` base) and `snapshot_id` (a `files` target); `record` contains metadata. Use file refs/paths returned by the inventory. An inspection or summary describes the workflow without running its setup, repository checks or execution steps.

Pi replaces owned historical guidance only in the provider projection when the available tools change; it does not rewrite the original JSONL. Repeat, fork, persisted continuation, compaction and rewind receive one current owned guidance block. Its public `context_with_system` handler rechecks the active-tool list after conversation context handlers have run, preserving the leading system message. User/assistant/tool examples and marker-only summaries remain ordinary content and cannot suppress owned guidance. OMP retains the existing effective-context deduplication and restoration path.

A complete Skill body supplied by the host/Broker or returned by a successful read can be used directly. Introductions and summaries do not require another entry read, a cache-directory listing, package-manifest inspection or agent interface metadata. Read a supporting resource when the current task needs its contents. Resolve a requested relative file directly from the Skill entry's containing directory rather than listing directories or searching the cwd first; retain the selected snapshot for CLI reads. This applies to both Pi and OMP; it does not remove their available tools or treat a catalog description as a body.

Pi and OMP selected Skill payloads include an escaped `skill-directory` and task-scoped resource guidance beside the complete body. Notion records also include the selected pinned `skill-ref` and `snapshot-id`. In Pi, native reference reads remain usable when `hash` or `basename` hides the local directory; use the advertised fixed reference and the available preparation directory for resources. Hosts using CLI fallback keep the source/database scope with `files SNAPSHOT` or `read SNAPSHOT --path RELATIVE`. The loaded-body statement explicitly preserves the user's task boundaries: loading a Skill does not authorize its workflow, environment probes or prerequisite actions. Inspection describes those instructions as content.

Ordinary local Skills keep Pi's native discovery and read behavior. Explicitly configured filesystem sources retain their metadata catalog and selected snapshot behavior. Notion sources advertise the selected View's Skill and Router metadata; `default_context` influences membership through the View filter, and Prompt remains explicit-only. Pi shows authored names with an explicit source and accurate entry reference. Read inspects only the requested content; `notion_use`, `/skill:` and `$` prepare selected instructions and Requires. Members remain candidates until selected. Use the exact name/ref advertised by that host. OMP retains qualified names such as `notion-ui-alpha`, its `skill://notion-ui-alpha` alias and metadata-path activation; these aliases do not rename the underlying Notion record.

After catalog registration, an explicitly configured prefetch budget may issue one public `prepare --purpose inspect --priority prefetch` for at most `maxNodes` available Skill/Router roots from the initial View. It does not expand Members, prepare the Required closure, read Prompts, export host directories, append session locks or deliver bodies. `maxBytes` bounds the complete successful preparation JSON and each main instruction; it is not a network transfer quota. `maxTimeMs` bounds the owner lifetime, and `rateShare` uses a separate low-priority admission lane in the same CLI scheduler. Foreground selection or resource reading cancels warming without waiting for its late callback. Service pressure defers warming; it does not add background retries. Foreground waiters retain independent cancellation ownership. Activation validates CLI cache eligibility, with a five-minute content default and no silent stale fallback. Session changes cancel owned work; removing a View entry preserves instructions already loaded in the current session.

With the default activation policy, a selected Skill keeps its branch's exact snapshot after a Notion edit or cache expiry. A new conversation, including one started in another process, checks engine cache eligibility: an eligible snapshot is reused without advancing `validated_at`; an expired current observation is revalidated before selecting a version. Selected graph bindings survive restart and compaction independently of body delivery. Relative resources remain bound to that snapshot.

For Pi, confirmed active instructions missing from the effective context are restored before the next provider request, including ordinary follow-ups after compaction or process resume. Restoration reads the branch's confirmed snapshot vector, checks complete bytes and hashes, and preserves its graph. It does not follow newly changed Requires edges or substitute current content. Missing or invalid fixed content blocks the request. A rewind or branch change uses only confirmations on that branch; selected-only bindings and unconfirmed preparations cannot activate instructions. Real terminal and composer acceptance is defined in [NS-SESSION-09–12](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/session-cache-recovery.md) and the [graph verification map](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/skill-dependency-graph.md).

Current reads use the latest complete content after cache validation; request `read CURRENT_REF_OR_PAGE --refresh` for an explicit refresh. Notion-managed content accepts human edits without an inspect/accept-edit workflow. A source-managed reading projection remains owned by that source, so changing its rendered page is not an ownership transfer. Incomplete content, changes during acquisition, inaccessible resources and integrity failures remain explicit errors. Current Notion storage has no publication or version-history workflow. A conversation's already selected bytes remain fixed to that selection; this local consumption binding does not version Notion pages.

The extension selects its adapter from the running host API. The adapter owns native catalog registration, prompt presentation, editor installation, input results and submission protocol. OMP submits through a command and a handoff receipt. Pi retains the accepted input for cancellable context preparation and confirms delivery at the provider response boundary. The shared preparation gate retains cancellation ownership until the pending consumer acknowledges it. `CONTEXT_BROKER_HOST` only selects fallback default paths for configuration and detached completion. It does not select another host's prompts, editor or submission protocol, and an explicit agent directory takes precedence.

In OMP print/json mode, a native source `/skill:` command waits for the triggered agent turn to finish before returning, so the process does not exit before the provider request starts. The host manages turns in interactive and RPC modes.

Interactive activation appends a persistent, collapsible transcript record, `Read ntn-skills://<alias>`, with source, elapsed time, and `running`, `done`, or `error` state. The target omits the namespace prefix and retains a page suffix when needed. Expanded details include the selected version and snapshot when available. Terminal records stay without a removal timer. Resume restores terminal records and marks old `running` records interrupted. The custom message has empty `content`; display metadata lives in `details`. Both the record and its expanded details are display-only and excluded from provider messages, context, compaction, and branch summaries. `ntn-skills://` is a display identifier, not a resolvable URI or a model tool call. Real reads still use `skill://`; a model-issued native `read` is a real tool call. The catalog always contains metadata only; background preparation never puts a body into the catalog or session before selection. Other terminals use text rendering. Already selected snapshots are reused without a new activation record.

Enter synchronously reserves preparation and locks submission while the draft remains editable. The native composer shows running and **Stop**. Enter during preparation does not submit a second prompt; **Stop** and Escape cancel preparation. Pi acquires selected content in its cancellable `context` stage; OMP retains command-based preflight. Successful preparation includes the original prompt, image attachments and complete selected bodies in the first provider request. Preparation failure, timeout or cancellation prevents that request; an explicitly reported unavailable target can proceed with the remaining user material. Cancellation and session changes invalidate pending preparation so late source completion cannot dispatch.

OMP adds a per-turn system rule that a complete Skill body supplied by the host or broker in the active context satisfies the read-before-use requirement. Broker Skill payloads include the invocation, qualified native name for source Skills, an explicit full-entry-loaded statement and the entry's resource directory. The model should use that body directly instead of rereading the entry, listing its cache directory or inspecting package metadata merely to load or identify it again. Referenced resources remain readable when the task needs them; relative paths resolve from that directory, expanding `~` to the home directory. `pathMode: hash|basename` keeps the directory redacted; source resources can still use the qualified `skill://` URI. Catalog descriptions and Router indexes do not satisfy member-body loading, and a body removed by compaction or rewind must be read again. Tern automatic chips and manual search use the same OMP submission contract. This prompt rule is OMP-specific. Pi retains its native prompt; verify real Notion discovery, entry and resource consumption independently with the integration Skill's `--mode model --host pi` route and terminal selection with its [Pi terminal procedure](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/dollar-completion-selection.md#pi-独立终端).

OMP routes interactive `/skill:` and invocation prompts through an extension command, avoiding the host's 30-second input-hook budget. Broker does not impose a whole-load deadline; the source CLI applies `requestTimeoutMs` independently to each network attempt (default 30000). Native model `read` uses a nonvisible overlay wait gate that keeps the current transcript and composer mounted. Request failure blocks dispatch; Escape and Stop cancel the complete preparation.

OMP headless activation retains a 25-second guard before the host's 30-second event limit; expiration reports `SOURCE_ACTIVATION_TIMEOUT` and aborts the source process tree. This host-event guard is independent of per-request `requestTimeoutMs`. `context-broker-submit` is the broker's internal interactive resumption command and requires a pending submission id.

OMP native Skill messages resolve their exact metadata entry path through broker-owned index mappings to the source identity, so a later `$` selection does not inject the same body again, even when discovery generated a newer metadata entry. A same-name Skill at another source path does not count as loaded.

When a source body remains in the active context, OMP native `/skill:` reuses it and sends the invocation arguments and images without another body. Reuse does not create a new loaded receipt. Rewind or compaction that removes the original body permits full activation again.

Pi retains accepted native `/skill:` input and images without the host's early uncancellable body read. Context preparation resolves the chosen record and supplies its complete body with the invocation arguments. Reuse checks owned delivery evidence and the effective context; a complete native main read also carries a receipt and a directory of fixed references. A marker without its body and user-authored XML cannot establish delivery. Confirmed active content missing after compaction follows the fixed-snapshot restoration path above.

Native invocation arguments can include the selected `$` reference without adding a second body in the same turn. Pi preserves the full arguments after a space, tab or newline separator, on both first activation and reuse.

Pi's Notion Skill/Router path calls SDK v2 `consume` once per source graph. It returns the validated graph, complete main bodies and complete file manifests together. Broker checks roots, scope, physical owner and File bindings before publishing entries. Each operation owns its environment, cwd, runtime and abort signal. Missing or incompatible SDKs fail with `SOURCE_SDK_UNAVAILABLE` or `SOURCE_SDK_INCOMPATIBLE`; there is no CLI fallback. OMP/Tern work is deferred.

The complete file manifest carries exact refs, File IDs, hashes and byte lengths. The host initially stores only the main in an `entry` projection. Scalar resources use SDK `readSkill` with an exact File ref and owned output; batch resources use `readResources`. Both verify scope, owner, selected content, File ID and complete bytes/hash, and publish only requested files. Binary resources remain bytes. Unknown paths, interrupted output and mismatches cannot become ready. Missing cached bytes can be reacquired only while current authority still matches the selection; there is no remote historical-snapshot recovery.

Public preparation results report `manifest_complete`, `local_files_ready` and `materialized_paths` separately from `loaded`. A successful native resource result carries `contextBrokerResource` with the exact file identity and hash; `delivered_complete_text` is true only when the actual returned text has the complete expected bytes. This is never a main-instruction loaded receipt. Current metadata or permission checks may still make requests even when no resource chunk is downloaded.

Prompt loading also uses SDK `consume`; no full-export compatibility path remains. Cache entries are disposable local material for selected operations, separated by credential scope, owner and selected content. Diagnostics expose safe error codes, without raw stderr or credentials.

Filesystem sources scan local files to extract frontmatter and publish only metadata in process-private temporary indexes; metadata-only catalog publication does not mean the scanner avoids reading original file bytes. First selected activation copies the complete Skill directory into a process snapshot, preserving its resources; native read, native commands and `$` then share that selected copy. This filesystem snapshot does not require a Notion export receipt and does not persist selection across processes.

For native host discovery after activation, Broker publishes a separate alias main with the qualified host name. A main without frontmatter receives a name/description header while its body stays intact. Entry projections publish the main and a `host_index` identity receipt with original/published hashes and `loaded:false`. Resources resolve through the verified complete manifest. Publishing an alias does not refresh selected content or establish model delivery.

Changing configuration or extension code requires a host restart (OMP: `/restart`). While a selected body remains in the active context, native read, native `/skill:` and `$` reuse that pinned snapshot. Pi restores confirmed active content from fixed snapshots when needed; selections without active confirmation still follow the activation policy. OMP retains its read-policy check before reusing prepared bytes after a body leaves context. Process-local mappings never extend freshness or imply loaded context. `/context-broker refresh` refreshes metadata, cancels obsolete preparation, publishes a new host discovery generation and clears process-local activation mappings. It does not re-execute extension code, replace conversation content or advance a confirmed active snapshot. A new conversation follows the current activation policy. Discovery freshness, preparation freshness, pinned resources and active session context are separate states.

Verification entrypoints in this checkout: [broker verification](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-context-broker/SKILL.md), [Notion integration verification](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/SKILL.md), and the CLI repository's `.cursor/skills/verify-ntn-skills/SKILL.md` ([repository](https://github.com/yoyooyooo/notion-skills-cli)). These are procedures, not proof that a given build or environment passed. Use `bun run check:broker` for current code and the integration Skill for same-input installed SDK/HTTP verification. Actual Pi and real Notion use the retained SDK and daily installation/candidate helpers under AH-1063. Native-terminal acceptance is not claimed by those checks; OMP/Tern are deferred.


### Environment variables

| Variable | Effect |
| --- | --- |
| `CONTEXT_BROKER_CONFIG` | Use one explicit config file |
| `CONTEXT_BROKER_ROOTS` | Replace `skillRoots` with a path-list |
| `CONTEXT_BROKER_EXTRA_ROOTS` | Append skill roots |
| `CONTEXT_BROKER_DISCOVERY_CATALOGS` | Replace `discoveryCatalogs` with a path-list |
| `CONTEXT_BROKER_EXTRA_DISCOVERY_CATALOGS` | Append discovery catalogs |
| `CONTEXT_BROKER_REQUIRE_ENABLED=0` | Allow all discovered skills for rule matching |
| `CONTEXT_BROKER_REQUIRE_ENABLED=1` | Require `autoload.enabled: true` |
| `CONTEXT_BROKER_LOG_FILE` | Write JSONL decisions and injections |
| `CONTEXT_BROKER_HOST=pi\|omp` | Select fallback default paths for configuration and detached completion; keep the running host's adapter |

Path-list separators follow the platform delimiter: `:` on macOS/Linux, `;` on Windows.

## Rule files

Rule files live under `context-broker/rules/*.yml` by default. Each file describes one trigger profile.

```yaml
id: architecture-review
inject:
  - design-review
  - router:workspace-collab
match:
  - exact:
      - review this design
  - regex:
      - '^design review:'
  - contains:
      - architecture
    not:
      - contains:
          - no context
```

A generated file can declare multiple profiles through a top-level `rules` array. This is useful when one scene configuration projects keyword rules for several Router indexes:

```yaml
version: 1
rules:
  - id: scene-coding
    inject:
      - router:scene-coding
    match:
      - contains:
          - coding context
  - id: scene-research
    inject:
      - router:scene-research
    match:
      - contains:
          - deep research
```

The legacy single-profile file remains supported. When a non-empty top-level `rules` array is present, its valid entries are used.

Set `ruleRoots` if you want a different rule directory.

## Discovery catalogs

Catalogs are standalone YAML or JSON files. YAML is easier to review and is the recommended format.

A member can reference a discovered skill by name:

```yaml
members:
  include:
    - docs
    - chat
```

A member can also point to a file relative to the catalog:

```yaml
members:
  - type: local
    path: ./members/docs/SKILL.md
```

When the file is a `SKILL.md`, Context Broker can read `name` and `description` from frontmatter. Set them manually only when you want to override that metadata.

Remote members use one explicit identity shape, without a filesystem path:

```yaml
members:
  - type: remote
    source: { namespace: production }
    id: shared_skill:team:review
    locator:
      type: shared_skill
      library_id: team
      skill_id: review
      page_id: 11111111-1111-4111-8111-111111111111
      database_id: 22222222-2222-4222-8222-222222222222
      data_source_id: 33333333-3333-4333-8333-333333333333
    ref: skill://shared_skill%3Ateam%3Areview/SKILL.md
```

`source.namespace` selects the enabled configured source's `namespace` (or its `id` when no namespace is configured). It never selects by label or credential scope. Resolution uses the current credential-scoped source directory and verifies the full locator, kind and canonical ref; optional `?snapshot=s_<sha256>` pins the member read. Catalog scope and cached path fields are rejected. Missing, offline or ambiguous members remain in the index with an explicit unavailable code and doctor diagnostic; local members remain usable. Index generation reads metadata only, and agents read the selected member's ref on demand.

Remote declarations accept only the current `shared_skill` identity. `notion_page` and `notion_subscription` declarations fail explicitly, even if their page UUID matches a current record. Update the authored catalog from the current source's returned ID, locator and canonical ref. Names, physical-page coincidence and old pins cannot authorize an implicit identity conversion. Disabled records, source failures, ambiguous owners and physical-location mismatches remain explicit failures; validation reads metadata only.

Local Router declarations also remain discoverable when their entry is absent (`ENOENT`/`ENOTDIR`) or exceeds the discovery scan limit (`LOCAL_ENTRY_TOO_LARGE`). Retain their declared name, path, ref and id, an explicit unavailable reason and, for oversized entries, byte count and maximum bytes. These declarations still count as Routers; discovery does not read their unavailable entry bodies.

To reference an existing remote Router directly, use the same remote identity fields as a catalog record with `kind: router` and its `ROUTER.md` ref. No `members`, local name override or duplicate Router page is needed; normal source activation retrieves that Router's own entry. A scene already handed off to a remote Router should suppress its generated local Router and duplicate rule.

See [`discovery-catalog.example.yaml`](../examples/discovery-catalog.example.yaml) for a fuller example.

## Injected payloads

Skill injection:

```xml
<context-broker-record kind="skill" name="design-review" path="~/context/skills/design-review/SKILL.md">
<body>
Review the design for ownership, boundaries, failure modes, and migration cost.
</body>
</context-broker-record>
```

Router injection:

```xml
<context-broker-record kind="router" name="workspace-collab" path="~/context/catalogs/workspace.yaml">
  <description>Collaboration contexts for documents, chat, and tasks.</description>
  <rules>
    <rule>Read the selected member file before using member-specific details.</rule>
  </rules>
  <policy memberBody="read-before-use" scope="members-only"></policy>
  <members>
    <member name="docs" path="~/context/skills/docs/SKILL.md">Document reading and editing context.</member>
  </members>
</context-broker-record>
```

## Commands

```text
/context-broker status
/context-broker doctor
/context-broker refresh
/context-broker sources
/context-broker connect SOURCE ENTRY --config /absolute/config.json
/context-broker roots
/context-broker catalogs
/context-broker find <query>
/context-broker explain <record>
```

Use subcommands, not colon-style command names. Pi uses colon suffixes for command conflict disambiguation.

`/context-broker find <query>` lists every matching record with its selector, kind, source and full path, including records that share one selector. It does not inject a record.

`/context-broker sources` reports local preparation jobs: queued/running/ready/error/cancelled state, generation, snapshot/version IDs, CLI freshness and safe error codes. It makes no model request; ready means prepared bytes, not instructions loaded into the conversation.

`connect` previews one explicitly selected config file and returns the exact apply command. Saving a source requires that unchanged preview digest; repeat configuration is a no-op and conflicting sources fail. Restart Pi with that config to observe connection readiness. No credentials or global config are selected implicitly. The deferred `notion_ctl` tool supports `working_set:show|budget|release`; see [Session controls and first connection](skill-consumption-runtime.md#当前工作集预算与显式释放).

## Security and privacy

This package runs inside the host agent process and has the same local permissions. Install it only from sources you trust.

Context Broker sends selected context to the model by design:

- A matched `skill` sends the full `SKILL.md` body to the model and stores it in local session history.
- A matched `router` sends member names, descriptions, policies, and member paths, but not member bodies.
- Session JSONL files store injected content.
- `CONTEXT_BROKER_LOG_FILE` records matched queries and record names. It omits paths unless `logPaths: true` is set.
- `pathMode: home-relative` avoids full home-directory paths when possible.
- `pathMode: hash` gives stronger path redaction.

Use trusted roots, catalogs and Notion databases. A Skill is prompt content and can instruct the model. Notion authentication stays in the CLI's existing credential store/environment; metadata and selected bodies/resources are cached locally, and selected content is sent to the configured provider.

## Session deduplication

The broker checks the active branch's effective context before injecting a record. Submitting the same record again produces an `already loaded` notice and does not append another copy. The existing body still travels with the conversation context.

A fork retaining the body still skips it. A rewind or compaction removing the body permits reinjection. XML examples in ordinary user, assistant or tool messages are not loading evidence.

## Completion CLI

The npm package exposes `context-broker-complete`. It reads one version 1 JSON request on stdin and writes one JSON response on stdout. It reads packaged Skills, configured sources, legacy roots and catalogs using `cwd`; it does not inherit Skills from the host system prompt. Notion completion queries metadata with the configured discovery policy and the CLI's existing authentication. Skill bodies are never returned. Source failures preserve available candidates and appear in an optional `failures` array; Tern displays these warnings before opening the available candidates. Invalid requests/configuration still fail with a nonzero exit and diagnostics on stderr.

```json
{"version":1,"text":"Use$des","cursor":7,"cwd":"/workspace/example"}
```

`config` is an optional explicit broker config path. All offsets are UTF-16 code units, including the original text length carried by `edit.len`:

```json
{
  "version": 1,
  "edit": {
    "from": 3,
    "to": 7,
    "len": 7,
    "prefix": "$des"
  },
  "items": [
    {
      "identity": "[\"local\",\"\",\"skill\",\"local\",\"local:/workspace/example/skills/design-review/SKILL.md\"]",
      "kind": "skill",
      "source": "local",
      "ref": "/workspace/example/skills/design-review/SKILL.md",
      "value": "$design-review@local%3A%2Fworkspace%2Fexample%2Fskills%2Fdesign-review%2FSKILL.md@local",
      "label": "$design-review [skill]",
      "description": "Review architecture and API trade-offs."
    }
  ]
}
```

This response assumes the Skill exists at the example path in a configured root. The response carries the complete exact identity token while retaining the readable label. `edit: null` means no `$` prefix ends at the cursor. A cursor inside an emoji surrogate pair is rejected. Candidate aliases, fuzzy ordering and Router precedence are shared with the broker; consumers must check the draft is unchanged before applying an edit.

### Select a View for this session

```text
/context-broker views
/context-broker view
/context-broker view VIEW_ID_OR_NOTION_URL
/context-broker view notion VIEW_ID_OR_NOTION_URL
/context-broker view default
```

`views` lists API-ordered choices with exact selection commands. `view` without arguments reports name, ID, source, selection origin and count. Multiple sources require the source ID. Selecting a View changes only the active session; `default` resets to configured selection or first-View fallback. These commands do not call the LLM. The next ordinary user submission receives the new names/descriptions; full Skill bodies remain on demand. A source may set `default_view_id: VIEW_UUID` beside `database` in YAML. Names are never special and API order is not promised to match UI tab order.

The active-branch custom entry `ntn-skills-view-selection` records version, source ID and canonical View ID. A null View ID resets the session override. It contains no instructions and is not a model message. Resume and branch navigation replay their own entries; parallel sessions never share mutable choice state. Validate a requested View before persisting it. Stale asynchronous callbacks are fenced at session boundaries. View selection does not modify source configuration files, withdraw previously loaded bodies or re-execute the extension.

View management calls the paired bundled CLI's `ctl views`; directory discovery uses the current SDK with explicit View or default-View selection. Source-level custom CLIs and historical command aliases are not alternate routes. Missing View capability is reported explicitly instead of reverting to checkbox-based discovery. An independent available full directory still supports explicit exact choices.
