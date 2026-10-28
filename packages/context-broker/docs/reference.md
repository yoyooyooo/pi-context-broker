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

`$ntn-skills@builtin`, `$ntn-skills-maintain@builtin` and `$ntn-skills-sync@builtin` are ordinary local Skills shipped with the Broker and standalone Tern query. Their entrypoints and relative reference files are available offline immediately after installation, including with zero configured Notion sources and no global `ntn-skills` executable. Choosing them follows the same discovery, draft and loading path as any other `$` Skill.

Use maintenance for Notion content editing, synchronization for connected upstream/local workflows, and the entry Skill for CLI and resource usage. The current Agent uses the `<ntn-skills-guidance>` argv and selected source/database. Each configured Notion source retains its own executable and scope; multiple sources require an explicit target choice. With no Notion source, guidance points to the packaged Node CLI, whose own configuration supplies its defaults.

Private package content has a `builtin:<name>` identity and a fixed `@builtin` selector. A same-name filesystem or Notion entry remains independent and receives its own selector. A configured source named `builtin` cannot claim these official tokens. Physical aliases of the same bundled entry are deduplicated before local name precedence.

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

Every CLI catalog exposes `records` with required `id/kind/locator/name/alias/description/default_context/entrypoint/ref`. The broker rejects unknown kinds, malformed locators and legacy `skills/skill` responses. Read and export share `record/entrypoint/scope/snapshot_id/version_id/ref`; export is pinned to the selected read snapshot and checked against portable manifest v2 and the complete inventory. Entry files are `SKILL.md`, `ROUTER.md` and `PROMPT.md`.

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

`sources` adds typed sources to the existing configuration. `skillRoots`, `extraSkillRoots`, discovery catalogs and their environment overrides remain supported alongside sources; existing configurations require no migration. Relative filesystem roots and `cacheDir` resolve against the consumer's working directory, and `~/` expands to the home directory.

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
    # Omit command to use the packaged CLI.
    # Custom CLI: command: [node, /absolute/path/to/ntn-skills/dist/ntn-skills.js]
    # Replace this example with your Skills database id/selector.
    database: 00000000-0000-0000-0000-000000000000
    cacheDir: ~/.cache/context-broker/notion
    discovery: {maxAge: 5m, offline: false}
    activation: {maxAge: 5m, offline: false}
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
| `command` | Notion | Defaults to Node.js plus the packaged `ntn-skills` entry; no global CLI lookup. A string overrides with one executable, an array with executable plus fixed arguments. No shell or shell expansion |
| `database` | Notion | Optional CLI database id/selector; passed to `list` and selected `read` |
| `default_view_id` | Notion | Optional stable View ID; session selection overrides it, otherwise missing configuration uses the first View in API order |
| `cacheDir` | Notion | Defaults to `~/.cache/context-broker/notion`; broker-owned metadata and exported snapshots |
| `discovery` | Notion | Metadata `list` policy: `maxAge`, `offline` |
| `activation` | Notion | Selected `read` policy: `maxAge`, `offline` |
| `requestTimeoutMs` | Notion | Per-network-attempt timeout passed as `NTN_SKILLS_REQUEST_TIMEOUT_MS`; positive integer ≤ 2147483647; CLI default 30000 |

Policy `maxAge` accepts `0` or an integer followed by `s`, `m`, `h`, or `d`. Omitted policies use the CLI's defaults. `offline: true` uses existing CLI cache and takes precedence over `maxAge`; unavailable/incomplete cache fails instead of silently fetching. The [schema](../examples/config.schema.json) rejects unknown source fields and invalid type-specific values; duplicate source ids are checked by the broker.

Source CLI commands have no aggregate deadline. Each network attempt receives its own timeout; pagination and retry/cooldown waits can make a complete Skill load exceed one minute. An explicit `requestTimeoutMs` overrides the child environment; omission inherits the CLI environment/default. Custom commands must implement this environment contract themselves. Escape, Stop and session cancellation still terminate the owned source process tree. The optional local cache-identity probe retains a separate five-second limit.

The broker appends `list [--database <selector>]` to the command prefix for discovery, then `read skill://<page-id>/<entrypoint> [--database <selector>]` for selected activation and `export <snapshot-id> --projection snapshot --format directory --output <broker-stage-directory>` for the pinned resources. Discovery and activation append their respective `--max-age <duration>` or `--offline`; explicit metadata refresh uses `list --refresh` instead. Export selects the returned immutable snapshot id, so it does not run a fresh unpinned read.

Authenticate using the existing `ntn-skills` authentication, such as `ntn-skills ctl config set-token --stdin` with a trusted secret-input pipeline or `ntn login`. The CLI prioritizes its saved token, then nonempty `NOTION_API_TOKEN`, then the `ntn` login. Broker and Tern configuration have no token field. A custom `command` must implement the same CLI JSON contract.

The build packages a standalone `ntn-skills` CLI, its three workflow Skills, runtime dependencies and license notices in both products. [Build input selection](../CONTRIBUTING.md#bundling-cli-and-skills) determines the shipped version. Online Notion sources additionally require official `ntn` 0.22.12+ with `api --notion-version`; `NTN_SKILLS_NTN_BIN` selects its executable. Metadata validation exercises existing authentication. `/context-broker doctor` checks the selected source and can populate caches. Offline discovery requires complete existing Notion caches; packaged Skills require neither Notion access nor those caches. A custom source `command` must preserve the list/read/export JSON contract and owns its dependency checks.

Source failures remain visible with safe source/code/message metadata. Authentication, transport and malformed-response failures revoke that source. A valid partial directory instead retains precise records with a nonblocking `CATALOG_INCOMPLETE` warning and page-qualified tokens; it does not prove absence or unique names. A failed default View yields empty default metadata and a repair hint, while exact explicit choices from the full directory remain available. Selected record authorization and snapshot integrity still gate body delivery. Local Skills and ordinary chat continue. Never replace a failed explicit View with another View or the entire library.

OMP starts metadata discovery without blocking its composer. The first ordinary submission awaits the current View directory before calling the provider. Pi prepares metadata during startup. `before_agent_start` rebuilds one `<ntn-skills-view-catalog>` in the system prompt, removes only Broker-owned stale native entries by exact path, and preserves unrelated local entries and conversation bodies. Starting a session, listing Views and changing a View do not themselves call a model. Selected-View snapshots may be prefetched separately without activation. Full-catalog coverage and View-query coverage remain distinct; neither freshness nor an available individual page repairs missing coverage.

Notion metadata indexes persist across processes under `cacheDir`, shared by the opaque credential/remote-catalog identity returned by `ctl cache identity [--database SELECTOR]`. Pi/OMP, projects, executable spellings, source IDs/namespaces, activation policies and request timeouts share that identity when they select the same remote catalog. Database aliases/IDs/URLs resolve locally in the CLI; different credentials or remote selections remain isolated. `cacheDir` explicitly chooses storage; its default is global, while an explicitly relative directory still resolves against cwd. An unsupported identity command falls back to normal discovery. Process startup recomputes age from the original `validated_at` under the current discovery policy; it does not renew TTL or inherit another consumer's stale flag. Fresh lists use the CLI catalog TTL, 60 seconds by default. Expired metadata appears immediately while one discovery-policy refresh runs. Partial-capable menus retain item positions by identity, append new candidates and disable removed ones; status rows cannot replace draft text. OMP forced-file completion keeps its current choices until the next editor request, when refreshed metadata becomes visible. Cancellation settles the superseded lookup immediately. A transient refresh failure keeps the prior list with its reason and a 5-second retry gap; authentication, permission or scope failures withdraw old source candidates. `discovery.offline` does not use the network. Catalog refresh reads no bodies; selected activation still validates scope and its fixed snapshot. `/context-broker refresh` replaces the shared catalog observation; already loaded conversations retain their selected snapshots.

Catalog format 4 stores immutable observations under `catalogs-v4`, ordered by exclusive request reservations made before `list`. A delayed earlier request cannot replace a later published observation, even when validation times match or move backward. Freshness still uses the unchanged source `validated_at` and the current consumer's policy. A corrupt maximum receipt triggers authoritative repair instead of selecting an older observation. Reads scan publication names and parse one receipt; claims, observations and active metadata indexes remain retained. Old catalog formats stay on disk but are not read. Immutable exports still share credential scope, record and snapshot paths. After verifying an identical competing export, the loser renames its own stage to `.retained-stage-*` for inspection; different bytes remain an output conflict. Retained bytes are not automatically collected. After upgrading extension code, run `/restart` in an existing OMP session and start a new Pi process. `/context-broker refresh` only refreshes data. The reusable [shared-cache and concurrency acceptance routes](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/session-cache-recovery.md#共享-notion-缓存) cover both hosts.

When a new session has no Notion `$` candidates, check the active host's own source configuration and installed Broker path before changing data. Pi and OMP use separate configs; installing the Tern companion does not load the OMP extension. A custom source command's cold `list --database ID --refresh` has no whole-command deadline; its network attempts follow `requestTimeoutMs`. Keep list discovery metadata-only and remove per-member request fan-out. Historical Bundle catalogs must be explicitly converted and their config references updated before loading the Router-only runtime. Preserve originals and migrate the owning catalog generator separately; an ordinary refresh does not convert schemas or re-execute updated extension code. Selected-View membership controls native default discovery, while complete `$alias@namespace` discovery stays independent of that View.

`SOURCE_RESPONSE_INVALID` can also mean the configured source CLI and the active host's installed Broker use different wire schemas. For example, a CLI catalog containing valid `upstream: {repo}` metadata is rejected by an older Broker whose strict record schema does not declare that field. Compare the actual CLI response with the installed `src/notion-source.ts`; checkout verification does not upgrade an installed package. Install a matching Broker build and update that host's package reference, then restart Pi or run `/restart` in OMP. A catalog refresh only reloads data. Verify the installed build with the daily source configuration through a real terminal candidate, Tab acceptance and complete-body delivery.



Catalog provenance distinguishes `role: content` from `role: upstream` (an omitted role means content). Every record must belong to the declared database/data-source pair and a successful `coverage.queried_data_sources` query. Page locators require a content source; subscription Router locators require an upstream source. An explicit database selector constrains a subscription's content target, while its locator remains in the upstream database. Source ID, namespace and credential scope stay bound through metadata registration and exact-ref activation. A direct read alone does not prove discovery, and a partial CLI catalog remains a structured source failure.

Record identity is `JSON.stringify([sourceId, sourceScope, kind, locator.type, id])`; source is independently local/notion. Filesystem identities use the real file path. Automatic Notion completion normally inserts `$alias@namespace`, adding a page ID for collisions; accepted identities are captured synchronously by the current preparation gate before any asynchronous work. A new draft accepted while that submission runs cannot replace its identity or be cleared when the earlier turn ends.

Detached/manual completion always inserts the existing full identity syntax: `$alias@<normalized-page-id>@namespace` for Notion and `$name@<encoded-local-id>@namespace` for filesystem content, with `local` for legacy roots. A renamed alias still resolves the same exact identity. Official bundled Skills retain `$name@builtin`. Candidate labels remain short and readable. `skillRoots` retain first-name precedence within local roots; independent source and content-kind identities remain separate. Shared selectors still reject ambiguity.

Skills whose CLI catalog record includes `upstream: {repo}` display `repo/skill name [skill]` in autocomplete and manual search, for example `pstack/correct [skill]`. `repo` is the callable alias of the validated Notion subscription's `Name`, not its repository URL or registry slug; the Skill uses its original `name`. Type `$pstack/` to browse that subscription's Skills or `$pstack/cor` to narrow the list. An explicit known subscription prefix excludes records from other subscriptions, even when their descriptions mention it. Automatic acceptance uses its source-qualified selector; detached/manual acceptance includes the exact page ID. Both retain the source/page identity. This catalog field affects display and search, not body, snapshot or identity validation.

Exact returned selection tokens take precedence over source-alias shorthand. A local `$name@local` reference also selects the retained local record when completion displays its unqualified name. Thus a source namespace named `local` cannot make an accepted local token ambiguous with a source record whose returned token includes its page ID; genuinely shared local tokens remain ambiguous.

Dots inside source ids and namespaces remain part of the selector, for example `$ui-alpha@team.prod`. A trailing sentence period is excluded from the invocation.

When names conflict, automatic completion displays source-qualified choices. An accepted selection whose exact read reports target not-found produces both a user warning and model-visible `context-broker-unavailable` detail with `state: not-loaded`. A full identity token absent from the current catalog reports `catalog-unavailable`; it does not invent a Notion lookup result or metadata. The unavailable entry is never a loaded receipt. Repeated context assembly in the same submission neither repeats its read nor appends the same missing explanation; a later user submission may retry.

Unknown bare `$name`, simple `$name@namespace`, amounts, paths such as `$bunfs/root/chunks/cli-nxfh2cp0.js`, escaped text and Markdown examples remain ordinary text. Other valid references, original material and images still proceed once beside an unavailable selection. Ambiguity and actual selected-record permission, network, source, catalog or integrity failures continue to block dispatch. No alternative source is chosen silently.

### Host discovery and selected activation

Pi and OMP add a lightweight `<ntn-skills-guidance>` custom message by default, without requiring a `$` invocation or builtin installation. It lists executable argv from the same CLI resolver as host commands, retaining each enabled Notion source's id and optional database; multiple sources are listed separately rather than implicitly choosing one. Each source includes concrete `list-args`, `read-args`, `files-args` and `resource-read-args` arrays with its database scope. Append one array to the executable argv and replace its task placeholders. Discovery starts from supplied metadata or short keywords and selects a suitable record before reading its body. `files SNAPSHOT` lists resources; `read SNAPSHOT --path RELATIVE` reads a named resource while avoiding shell tools interpreting `skill://` arguments as filesystem paths. Retain JSON output to check CLI `ok`/`error` and snapshot identity; use subcommand help for syntax failures. The guidance itself neither discovers content nor activates a Skill.

The host observes complete successful JSON receipts from its configured CLI argv. Verified content create/update, changed upstream members and local sync pushes mark only matching content databases and source commands for a fresh directory on the next selection. Source offline policy is retained. Read/status/plan/check, dry runs, reuse, unchanged results and failures do not trigger this update. OMP truncated stdout keeps its originating CLI call through the advertised `artifact://` read; only the complete receipt counts. Compound shell commands, writes outside host tools and output that remains incomplete use normal catalog freshness or `/context-broker refresh`. Automatic write-driven refresh does not cancel accepted drafts or replace snapshots already loaded in the conversation.

Successful CLI reads return top-level `content` (body), pinned `ref` (the relative `read --from` base) and `snapshot_id` (a `files` target); `record` contains metadata. Use file refs/paths returned by the inventory. An inspection or summary describes the workflow without running its setup, repository checks or execution steps.

Deduplication checks the complete owned guidance message in the effective session context, using the same active-context lookup as Skill deduplication. Repeat, fork and persisted continuation retain one copy. Compaction or rewind that removes it restores it on the next turn, even without selecting a Skill. A context hook also supplies it when absent immediately before a provider request, including after in-turn compaction. User/assistant/tool examples and marker-only summaries are not owned guidance and cannot suppress restoration. The XML appears once per model request; historical pre-compaction copies can remain in the session file.

A complete Skill body supplied by the host/Broker or returned by a successful read can be used directly. Introductions and summaries do not require another entry read, a cache-directory listing, package-manifest inspection or agent interface metadata. Read a supporting resource when the current task needs its contents. Resolve a requested relative file directly from the Skill entry's containing directory rather than listing directories or searching the cwd first; retain the selected snapshot for CLI reads. This applies to both Pi and OMP; it does not remove their available tools or treat a catalog description as a body.

Pi and OMP selected Skill payloads include an escaped `skill-directory` and task-scoped resource guidance beside the complete body. Notion records also include the selected pinned `skill-ref` and `snapshot-id`. In `hash` and `basename` path modes the directory stays hidden: use the supplied CLI/database scope with `files SNAPSHOT` or `read SNAPSHOT --path RELATIVE`. These identities permit resource consumption without exposing the local snapshot directory. Inspection describes the Skill's workflow, style and prerequisites; it does not adopt them as the current task.

Filesystem sources publish metadata-only Skill entries in the host catalog. Notion sources advertise the selected View's Skills and Routers; `default_context` remains ordinary metadata and Prompt remains explicit-only. The full catalog remains available for `$` selection and explicit reads. Native `read`, `/skill:` and `$` activate only the chosen record. Host names derive from the source token by replacing characters outside lowercase `a-z`, `0-9` and `-`; this does not rename the source alias. OMP `skill://notion-ui-alpha` and advertised metadata paths resolve through the same source activation and preserve the requested read selector.

After catalog registration, the shared source runtime prepares the selected View's Notion Skill/Router entries with bounded concurrency, without reading members or Prompts. It exports complete snapshots without placing bodies, activation indicators or loaded receipts in a session. Foreground and background consumers of the same scoped page share active work; cancelling one consumer leaves other owners active. Activation validates CLI cache eligibility, with a five-minute content default and no silent stale fallback. Refresh cancels obsolete preparation and applies View membership; shutdown cancels owned work. Removing an entry from a View preserves instructions already loaded in the current session.

With the default activation policy, a Skill already present in the active conversation keeps its selected snapshot after a Notion edit or cache expiry. A new conversation, including one started in another process, checks CLI cache eligibility: within five minutes it reuses the same snapshot and complete export without advancing `validated_at`; after expiry it fetches Notion and exports a new snapshot if the content changed. Relative resources remain bound to the selected snapshot. Real terminal and composer acceptance is defined in [NS-SESSION-09–12](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/session-cache-recovery.md).

A current read of a complete, stable Notion page accepts human edits after cache validation (`read CURRENT_REF_OR_PAGE --refresh` for an explicit refresh), without an inspect/accept-edit prerequisite. Existing pinned snapshots remain immutable. Reading does not advance an upstream source version or change ownership. Tracked content can be read, but editing its body/resources/Name/Description through the CLI requires changing its source or an explicit fork; organization fields such as Default Context remain separately editable. Incomplete publication, a graph that changes while being read, resource-access failures and integrity errors still fail explicitly. Synchronization continues to report local edits as conflicts.

The extension selects its adapter from the running host API. The adapter owns native catalog registration, prompt presentation, editor installation, input results and submission protocol. OMP submits through a command and a handoff receipt; Pi transforms input and associates native activation with the expanded-input digest. The shared preparation gate retains cancellation ownership until the pending consumer acknowledges it. `CONTEXT_BROKER_HOST` only selects fallback default paths for configuration and detached completion. It does not select another host's prompts, editor or submission protocol, and an explicit agent directory takes precedence.

In OMP print/json mode, a native source `/skill:` command waits for the triggered agent turn to finish before returning, so the process does not exit before the provider request starts. The host manages turns in interactive and RPC modes.

Interactive activation appends a persistent, collapsible transcript record, `Read ntn-skills://<alias>`, with source, elapsed time, and `running`, `done`, or `error` state. The target omits the namespace prefix and retains a page suffix when needed. Expanded details include the selected version and snapshot when available. Terminal records stay without a removal timer. Resume restores terminal records and marks old `running` records interrupted. The custom message has empty `content`; display metadata lives in `details`. Both the record and its expanded details are display-only and excluded from provider messages, context, compaction, and branch summaries. `ntn-skills://` is a display identifier, not a resolvable URI or a model tool call. Real reads still use `skill://`; a model-issued native `read` is a real tool call. The catalog always contains metadata only; background preparation never puts a body into the catalog or session before selection. Other terminals use text rendering. Already selected snapshots are reused without a new activation record.

Enter starts preparation synchronously and locks submission while the draft remains editable. The native composer shows running and **Stop**. Enter during preparation does not submit a second prompt; **Stop** and Escape cancel preparation. Successful preflight sends the original prompt, image attachments, and full selected Skill body once in the first provider request. Blocking activation errors, timeout, or cancellation send no provider request; an explicitly reported unavailable target can proceed with the remaining user material. Cancellation and session changes invalidate pending preparation so late source completion cannot dispatch.

OMP adds a per-turn system rule that a complete Skill body supplied by the host or broker in the active context satisfies the read-before-use requirement. Broker Skill payloads include the invocation, qualified native name for source Skills, an explicit full-entry-loaded statement and the entry's resource directory. The model should use that body directly instead of rereading the entry, listing its cache directory or inspecting package metadata merely to load or identify it again. Referenced resources remain readable when the task needs them; relative paths resolve from that directory, expanding `~` to the home directory. `pathMode: hash|basename` keeps the directory redacted; source resources can still use the qualified `skill://` URI. Catalog descriptions and Router indexes do not satisfy member-body loading, and a body removed by compaction or rewind must be read again. Tern automatic chips and manual search use the same OMP submission contract. This prompt rule is OMP-specific. Pi retains its native prompt; verify real Notion discovery, entry and resource consumption independently with the integration Skill's `--mode model --host pi` route and terminal selection with its [Pi terminal procedure](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/dollar-completion-selection.md#pi-独立终端).

OMP routes interactive `/skill:` and invocation prompts through an extension command, avoiding the host's 30-second input-hook budget. Broker does not impose a whole-load deadline; the source CLI applies `requestTimeoutMs` independently to each network attempt (default 30000). Native model `read` uses a nonvisible overlay wait gate that keeps the current transcript and composer mounted. Request failure blocks dispatch; Escape and Stop cancel the complete preparation.

OMP headless activation retains a 25-second guard before the host's 30-second event limit; expiration reports `SOURCE_ACTIVATION_TIMEOUT` and aborts the source process tree. This host-event guard is independent of per-request `requestTimeoutMs`. `context-broker-submit` is the broker's internal interactive resumption command and requires a pending submission id.

OMP native Skill messages resolve their exact metadata entry path through broker-owned index mappings to the source identity, so a later `$` selection does not inject the same body again, even when discovery generated a newer metadata entry. A same-name Skill at another source path does not count as loaded.

When a source body remains in the active context, OMP native `/skill:` reuses it and sends the invocation arguments and images without another body. Reuse does not create a new loaded receipt. Rewind or compaction that removes the original body permits full activation again.

Pi expands the first native `/skill:` invocation into a user message. The broker adds a body-free identity receipt only after observing the actual command input and matching its expanded body. Later `$` deduplication also requires the matching user-message digest in the active context. When `$` or a native command already loaded the selected body, a Pi input transform preserves invocation arguments and images while reusing that body without another expansion or loaded receipt. A receipt left behind after compaction removes the body does not suppress activation, and user-authored XML alone is not a receipt.

Native invocation arguments can include the selected `$` reference without adding a second body in the same turn. The matching native receipt supplies that turn's selected identity before session persistence completes. Pi preserves the full arguments after a space, tab or newline separator, on both first activation and reuse.

Notion preparation reads the canonical record ref and exports that exact snapshot with the explicit `snapshot` projection, including generated Router indexes and every resource. Selected-View records can be prepared before selection; other records prepare when selected. The exported entry must equal the pinned CLI `read` bytes; each file's SHA-256, byte length and role must match the export receipt, and the portable manifest must be version 2. CLI default `source` exports preserve authored portable bytes and are a separate view. Selected entry/resource reads resolve into the pinned directory, retaining relative paths and stable cross-member refs. Cache receipt version 3 records the snapshot projection; version 2 directories are retained under `.invalidated-*` and rebuilt through a pinned export once, while unknown versions fail explicitly. The cache separates credential scope, record and snapshot; host/source labels remain consumer metadata, and catalog indexes use separate generations. Scope, identity, snapshot, export-inventory and source errors block activation without marking the record loaded. Diagnostics expose safe error codes and exit status, never raw subprocess stderr or secrets.

Filesystem sources scan local files to extract frontmatter and publish only metadata in process-private temporary indexes; metadata-only catalog publication does not mean the scanner avoids reading original file bytes. First selected activation copies the complete Skill directory into a process snapshot, preserving its resources; native read, native commands and `$` then share that selected copy. This filesystem snapshot does not require a Notion export receipt and does not persist selection across processes.

For native host discovery after activation, the broker publishes a separate alias view containing the complete selected snapshot tree, including resources outside a nested entry's directory. That view's entry frontmatter `name` changes to the qualified host name; if the portable main has no frontmatter, the view adds a qualified name/description header while preserving its body. The canonical snapshot name and content stay unchanged. The advertised metadata directory points to the view's entry directory so host rediscovery keeps the qualified name and relative resources. Broker read interception returns canonical snapshot paths/content. Publishing an alias view does not refresh the selected snapshot.

Changing configuration or extension code requires a host restart (OMP: `/restart`). While a selected body remains in the active context, native read, native `/skill:` and `$` reuse that pinned snapshot. After branch or compaction removes the body, the next activation rechecks the CLI read policy before reusing prepared bytes; process-local mappings never extend freshness or imply loaded context. `/context-broker refresh` refreshes metadata, cancels obsolete preparation, publishes a new host discovery generation and clears selected activation mappings. It does not re-execute extension code or replace already injected conversation content. A new broker instance or process follows the current activation policy. Discovery freshness, preparation freshness, pinned resources and loaded session context are separate states.

Verification entrypoints in this checkout: [broker verification](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-context-broker/SKILL.md), [Notion integration verification](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/SKILL.md), and the CLI repository's `.cursor/skills/verify-ntn-skills/SKILL.md` ([repository](https://github.com/yoyooyooo/notion-skills-cli)). These are procedures, not proof that a given build or environment passed. Run `node scripts/verify-notion-integration.mjs doctor` from the broker checkout to inspect prerequisites; follow the Skill for deterministic, live, authorized create/archive, model and installed-package modes. Native UI routing uses `node scripts/verify-native-ui.mjs --notion`.


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
    id: notion_page:11111111-1111-4111-8111-111111111111
    locator:
      type: notion_page
      page_id: 11111111-1111-4111-8111-111111111111
      database_id: 22222222-2222-4222-8222-222222222222
      data_source_id: 33333333-3333-4333-8333-333333333333
    ref: skill://11111111-1111-4111-8111-111111111111/SKILL.md
```

`source.namespace` selects the enabled configured source's `namespace` (or its `id` when no namespace is configured). It never selects by label or credential scope. Resolution uses the current credential-scoped source directory and verifies the full locator, kind and canonical ref; optional `?snapshot=s_<sha256>` pins the member read. Catalog scope and cached path fields are rejected. Missing, offline or ambiguous members remain in the index with an explicit unavailable code and doctor diagnostic; local members remain usable. Index generation reads metadata only, and agents read the selected member's ref on demand.

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
/context-broker roots
/context-broker catalogs
/context-broker find <query>
/context-broker explain <record>
```

Use subcommands, not colon-style command names. Pi uses colon suffixes for command conflict disambiguation.

`/context-broker find <query>` lists every matching record with its selector, kind, source and full path, including records that share one selector. It does not inject a record.

`/context-broker sources` reports local preparation jobs: queued/running/ready/error/cancelled state, generation, snapshot/version IDs, CLI freshness and safe error codes. It makes no model request; ready means prepared bytes, not instructions loaded into the conversation.

## Security and privacy

This package runs inside the host agent process and has the same local permissions. Install it only from sources you trust.

Context Broker sends selected context to the model by design:

- A matched `skill` sends the full `SKILL.md` body to the model and stores it in local session history.
- A matched `router` sends member names, descriptions, policies, and member paths, but not member bodies.
- Session JSONL files store injected content.
- `CONTEXT_BROKER_LOG_FILE` records matched queries and record names. It omits paths unless `logPaths: true` is set.
- `pathMode: home-relative` avoids full home-directory paths when possible.
- `pathMode: hash` gives stronger path redaction.

Use trusted roots, catalogs, source commands and Notion databases. A Skill is prompt content and can instruct the model. Notion authentication stays in the CLI's existing credential store/environment; metadata and selected bodies/resources are cached locally, and selected content is sent to the configured provider.

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

The CLI must support `views`, `list --view` and `list --default-view`. A custom old CLI reports a default-View capability failure instead of silently reverting to checkbox-based discovery. Explicit list/read remain usable when supported.
