<h1 align="center">pi-context-broker</h1>
<p align="center">Bring selected Skills, Routers, and Prompts into your agent's current task.</p>
<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a>
</p>
<p align="center">
  <a href="#install">Install</a> · <a href="#quick-start">Local quick start</a> ·
  <a href="#connect-a-notion-library">Connect Notion</a> · <a href="#documentation">Docs</a>
</p>

Name a workflow in your prompt:

```text
$design-review review this API boundary
```

The broker finds `design-review`, sends its instructions to the model, and reuses them while they remain in the active session branch. Local Skills work without a Notion connection.

For [Notion Skills](https://github.com/yoyooyooo/notion-skills-cli/blob/next/README.md), Broker is the optional Pi adapter. The CLI owns library setup, credentials, authoring, and source synchronization. Broker adds discovery, selection, resource reads, and session context controls inside Pi. Start with the [CLI quick start](https://github.com/yoyooyooo/notion-skills-cli/blob/next/README.md#quick-start) to create or connect a Notion library.

Current `next` development targets Pi and the paired Notion SDK. OMP and the optional Tern companion remain available in this repository, with their current acceptance work deferred. See [OMP and Tern](#omp-and-tern) for that separate installation path.

## Install

Install the published package into Pi:

```sh
pi install npm:pi-context-broker
```

The package requires Node.js `^24.22.3 || ^26.13.1`. It includes the matching Notion CLI, SDK, and packaged Skills, so Pi use does not require a separate global `ntn-skills` installation. Bun is a build dependency.

Broker's request verification needs Undici's sent-body chunk diagnostics, which Node 22's built-in transport does not provide. This is a Broker runtime requirement; the standalone Notion CLI maintains its own supported Node range.

Current real Pi verification uses Pi 1.6.0. The optional `*` peer ranges allow a
host-managed installation; they do not certify every Pi or OMP version. Check a
new host version with the [existing verification routes](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/verification-routing.md)
before relying on it. The Node range covers the listed maintained LTS lines.

Published npm packages and the current `next` source can differ. To develop or try unreleased changes, use the [isolated development guide](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/isolated-development.md). It owns source pairing, builds, and separate application state.

Choose the [local quick start](#quick-start) below, or [connect an existing Notion library](#connect-a-notion-library).

## Quick start

### 1. Configure a Skill directory

Create `~/.pi/agent/context-broker/config.yml`:

```yaml
skillRoots:
  - ~/context/skills
requireAutoload: false
pathMode: home-relative
logPaths: false
```

If you use a custom Pi agent directory, see [configuration resolution](./packages/context-broker/docs/reference.md#configuration). Restart Pi after changing configuration.

### 2. Add a Skill

Create `~/context/skills/design-review/SKILL.md`:

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

### 3. Check discovery, then submit

Run these commands in Pi's composer:

```text
/context-broker doctor
/context-broker find design
/context-broker explain design-review
```

`doctor` should report `Config diagnostics: ok` and no namespace collisions. `explain` should show `kind: skill` and `inject: full-file` for `design-review`.

Then submit:

```text
$design-review review this API boundary
```

Pi prepares the selected Skill and includes its complete instructions in the next model request. Use **Stop** or Escape to cancel preparation. See [selection and session behavior](#selection-and-session-behavior) for reuse, recovery, and failure handling.

## Connect a Notion library

Complete the [CLI quick start](https://github.com/yoyooyooo/notion-skills-cli/blob/next/README.md#quick-start) first. The CLI creates a library with `ctl library init --parent PARENT`; `ctl library init --entry ENTRY` validates an existing current library. Keep `library.skills.database_id` as the entry: it is the Skills database ID. An existing current library needs neither new tables nor a local Skill directory.

In Pi, preview the connection using that entry and your chosen configuration file:

```text
/context-broker connect personal ENTRY --config /absolute/project/config.json
```

Replace `ENTRY` with the returned library entry and choose a real absolute configuration path. The preview changes no configuration. Review it and execute the exact returned `--apply` command to save the source. Then start Pi with the same file:

```sh
CONTEXT_BROKER_CONFIG=/absolute/project/config.json pi
```

Run `/context-broker doctor` and `/context-broker sources`. Ask Pi to find a Skill in the connected library and read its returned reference. Successful setup includes an available source, a returned catalog, and the requested body. A saved connection alone does not prove Notion access or instruction delivery.

The CLI quick start also covers authentication, the first Skill, and management. Broker uses the paired bundled CLI/SDK and its configured credentials. Keep credentials out of the Broker config.

### Source configuration

The connection command adds the source to the selected file. Its options can also be reviewed or edited there:

```yaml
sources:
  - id: notion
    type: notion
    # Use the library entry returned by the CLI.
    database: 00000000-0000-0000-0000-000000000000
    discovery: {maxAge: 5m, offline: false}
    activation: {maxAge: 5m, offline: false}
    prefetch: false
```

The `next` Notion consumer uses the bundled in-process SDK for metadata, Skill/Router/Prompt bodies, supporting files and bounded prefetch. One `consume` call owns preparation and the complete file directory; only selected main files are initially materialized, and resources use their verified fixed File references. Each explicit Prompt submission loads its current material again. Diagnostics and explicit management retain the paired CLI. `source.command`, CLI prepare/read chains and full-export fallback are retired; a missing or incompatible package fails with an upgrade instruction. OMP/Tern work is deferred.

Pi exposes session references through `notion_list`, `notion_use` and native `read`: `sr:C` identifies a catalog candidate, `sr:S` a fixed selected main, and `sr:R` a resource belonging to that selection. Copy the returned reference unchanged. `notion_use` is a top-level model tool and cannot be called inside Code mode; preparation and actual complete delivery are checked separately. References belong to the current session branch and still require source authorization and identity checks. See the [Skill consumption runtime](./packages/context-broker/docs/skill-consumption-runtime.md) for preparation, delivery and restoration boundaries.

An optional `default_view_id` on each Notion source fixes its default View; omit it to use the first View in API order. An invalid configured ID is reported, not replaced; a verified empty View list means no default Notion entries. Pi submits ordinary messages without waiting for the remote directory, so its first request may report metadata as pending. At each model request, Pi presents the current directory from memory, preserving local Skills and already loaded bodies; explicit `$` preparation finishes before its first request. A checked page outside the View is not advertised; an unchecked page inside it is. Pi native `read` inspects the selected record or resource; `notion_use` and an explicit `$` selection prepare the selected root with Requires. Detached completion stays full-library and metadata-only. Code or configuration changes require a host restart; a session View switch does not.

Use `/context-broker refresh` to refresh metadata and make a later selection eligible for a new snapshot; existing conversation content is retained. Unscoped Notion discovery can be search-index limited; an explicit database can supply exhaustive coverage for that database. See [source configuration and activation](./packages/context-broker/docs/reference.md#built-in-sources) for all fields, scope isolation, ambiguity and cache policies.

Notion caches are shared across projects and Pi/OMP by credential and remote catalog identity. Full-directory metadata and View membership use separate cache selections, so filtering one session never hides another session’s `$` candidates. Session choices live in active-branch entries and survive process resume; new sessions resolve their own defaults. Shared refresh preserves loaded workflow snapshots. [Cache contract](./packages/context-broker/docs/reference.md#built-in-sources).

Run `/context-broker doctor` to check the official CLI version, capabilities, authentication and source access. Missing dependencies or failed access mark only that source unavailable; local Skills, healthy sources and ordinary chat continue working. Activating a selected known record from an unavailable source blocks dispatch with a repair hint. An unknown simple reference passes through unchanged even in that source's namespace; accepted and full-identity references report unavailability explicitly. After repairing it, run `/context-broker refresh`. The management CLI comes from the same installed package; source-level executable overrides are rejected.

`/context-broker sources` reports background preparation state, snapshot/version IDs, CLI freshness and safe error codes; `ready` means prepared bytes, not instructions loaded into the session.

### Select a View for this session

```text
/context-broker views
/context-broker view
/context-broker view VIEW_ID_OR_NOTION_URL
/context-broker view notion VIEW_ID_OR_NOTION_URL
/context-broker view default
```

`views` lists API-ordered choices with exact selection commands. `view` without arguments reports name, ID, source, selection origin and count. Multiple sources require the source ID. Selecting a View changes only the active session; `default` resets to configured selection or first-View fallback. These commands do not call the LLM. The next ordinary user submission receives the new names/descriptions; full Skill bodies remain on demand. A source may set `default_view_id: VIEW_UUID` beside `database` in YAML. Names are never special and API order is not promised to match UI tab order.

Notion prefetch defaults to a zero budget, so startup and View discovery read metadata only. Explicit Skill selection prepares the complete pinned main instructions and, for use, the Required closure. Resources stay in a verified complete manifest and are fetched individually when read. `prefetch: false` keeps this behavior explicit; optional warming requires a node, byte, time and rate budget. [Source options](./packages/context-broker/docs/reference.md#built-in-sources).

## Why use it

Agent setups accumulate review checklists, runbooks and team workflows. Context Broker publishes names and descriptions before loading selected bodies. A Notion source uses a session-selected View, its configured `default_view_id`, or the first View in API order. `Default Context` is an ordinary checkbox used only by saved View filters. Full `$` selection, search and explicit reads remain available outside that View. Startup may prepare metadata and snapshots; it never sends a model request or activates bodies.

Pi consumes Notion Skills through `notion_list`, native `read`, and `notion_use`. List discovers metadata; read inspects an entry or resource; use obtains the root and complete Requires once, leaving Members as candidates. Local Skills retain Pi's native discovery and reading. All Notion discovery and consumption use the paired bundled SDK; old `source.command` configurations are rejected. Each provider context contains one short `<ntn-skills-guidance>` block matching the active tools. Management is available through the deferred `notion_ctl` tool; OMP/Tern evolution is deferred on `next`.

Pi can read up to 16 selected resources in one `read({ paths: [...] })` call using fixed `sr:R` handles or pinned `skill://` file refs from the same Skill snapshot. Text arrives in full; binary resources provide verified file metadata and a local path. Ordinary `read({ path, offset?, limit? })` keeps Pi's native behavior. See [fixed resource batches](./packages/context-broker/docs/fixed-resource-batches.md) for selection, budgets and delivery semantics.

For a relative link in a Notion Skill, use `read({ path: "../review/SKILL.md", from: FIXED_CONTAINING_FILE_REF })`. The base is the actual file containing the link: a returned `sr:S`, `sr:R` or fixed canonical File ref. Crossing Skills requires a reliable current Source contribution map; cache directories do not recreate repository siblings. Resolution preserves an already selected target's own session snapshot and remains inspection, without activating Requires or changing Members. `from` cannot be combined with a resource batch or `refresh: true`. See [relative file reads](./packages/context-broker/docs/fixed-resource-batches.md#relative-paths-from-a-selected-file).

Pi's deferred `notion_ctl` also manages the current Notion working set. `working_set: "show"` reports active roots, shared Requires and UTF-8 instruction bytes; `"budget"` with `max_bytes` sets an explicit Session limit; `"release"` with exact `roots` stops applying those roots. Shared dependencies remain while another active root needs them. Release preserves the original Session history, fixed snapshots and Notion data. The default has no automatic eviction. See [working-set controls](./packages/context-broker/docs/skill-consumption-runtime.md#当前工作集预算与显式释放).

Existing conversations retain their selected root and Requires versions across Notion edits and metadata expiry. Explicit `read` with `refresh: true` compares the current main without changing task pins; `notion_use` with `refresh: true` adopts complete current versions for the requested roots. Missing fixed bytes produce a bounded capability warning and withhold the affected instruction closure while independent conversation continues. See [refresh and recovery](./packages/context-broker/docs/skill-consumption-runtime.md#内容变更明确刷新与管理开关) and the [paired next-worktree delivery contract](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/next-worktree-delivery.md).

When a user asks whether a named Notion Skill exists or is available, the Agent must call `notion_list` with that name as `query` and `refresh:true`, including in an existing conversation and after an earlier hit or miss. The default View and conversation history do not replace this check. Explicit source choices still apply. The lookup reads metadata only and keeps selected root/Requires versions fixed. Answer existence and stated-purpose questions from the returned metadata; inspect or apply the instructions only when that is the user's request. A fresh, complete lookup can establish that no available match was found in the searched scope; offline, stale, failed or partial results cannot establish current absence.

| Record | Source | What the model receives |
| --- | --- | --- |
| Skill | A discovered `SKILL.md` or filesystem/Notion source record | Full selected Skill content; source resources share its selected snapshot |
| Router | Notion `ROUTER.md` or a local catalog | Own body and member index; member bodies are read when needed |
| Prompt | Notion `PROMPT.md` | Full requirements added to each explicitly selected user task |

Use `$name` or an alias to select a record. Keyword rules can load Skills or explicit `router:<name>` targets. The broker also provides interactive completion and `/context-broker` diagnostics.

## Selection and session behavior

Enter reserves the submission while leaving the draft editable. The native composer shows running and **Stop**; **Stop** or Escape cancels preparation. Enter during preparation does not submit the edited draft. In Pi, selected content is prepared in the cancellable `context` stage, after the host creates the agent operation. RPC `abort` also cancels that work. Successful preparation includes the original prompt, images, and complete selected Skill bodies in the first provider request. Preparation failure or cancellation prevents that request; a session switch also prevents late dispatch.

Pi confirms a selected Skill as active when `after_provider_response` receives 2xx response headers and the complete body matches the request's fixed selection. This confirms logical request acceptance, not completion of the model's response and not final wire delivery. Ordinary `openai-completions` wire proof is a separate Node Undici entity-hash check; other transports are not reported as wire-confirmed. Cached bytes and a ready preparation result do not establish active state.

Unknown simple `$name` and `$name@namespace`, amounts and paths such as `$bunfs/root/chunks/cli-nxfh2cp0.js` remain ordinary text without a failure notification. A previously accepted choice or full identity token that is unavailable produces explicit user/model **not loaded** feedback. Other valid Skill/Prompt/Router references, original text and images still proceed once. Ambiguity and actual selected-record permission, network, catalog or integrity errors block activation; no other source is selected silently.

The next model request includes the Skill content. Submitting the same record through `$` or OMP native `/skill:` reuses the body while it remains in the active context. Pi restores missing confirmed-active bodies from the branch's exact snapshots before the next request, including ordinary follow-ups after compaction or resume. A branch without that confirmation does not inherit activation. Deduplication does not remove existing context from subsequent requests.

## Content lifecycle

Every CLI catalog exposes `records` with required `id/kind/locator/name/alias/description/default_context/entrypoint/ref`. The broker rejects unknown kinds, malformed locators and legacy `skills/skill` responses. Selected consumption binds the complete main body and file manifest to one source, scope, record and immutable snapshot. Entry files are `SKILL.md`, `ROUTER.md` and `PROMPT.md`.

Select a Prompt explicitly with `$alias@notion`. Each submission owns a new invocation, session generation and prepared snapshot set; preflight and dispatch reuse that exact snapshot. Repeating the same Prompt on the next submission appends its full requirements again at user-task level, preserving original text and images. Prompt never enters native Skills, default discovery, background preparation, keyword activation or system prompts. Stop, timeout and session changes invalidate pending dispatch. Completion acceptance changes only the draft; all hosts and detached completion share `identity/kind/source/ref` and existing UTF-16 edit ranges in protocol v1.

Old domain Bundle catalogs and stored session markers require explicit conversion with `node scripts/migrate-content-assets.mjs INPUT OUTPUT`. Runtime discovery accepts only Router records. Conversion writes a separate output and preserves immutable snapshots and resource paths.
The converter changes only catalog record fields and recognized Broker session details, including structured Router references and source receipt identities. Authored content, snapshot IDs, resource paths and unknown nested data remain unchanged, even when they contain `bundle:` or `kind="bundle"`. It rejects mixed catalog envelopes and malformed members; it never overwrites the input or an existing output.

## Maintain and sync

For connected-library maintenance, read `ntn-skills-maintain` from that Notion source using its exact advertised ref and the ordinary `read` tool. Reuse an already loaded complete workflow. If the default directory is pending or does not contain it, use `notion_list` with its name and the task's source, then read the returned ref. A failed or partial discovery result does not establish absence and must not silently select a packaged copy. Keep discovery, instruction reads and authorized writes in the intended source/library; same-name entries in other sources remain separate.

Reading only inspects the workflow. To apply it, use that source's exact ref through `notion_use(ref)` to load its complete Requires, unless already prepared for this task. The edited target remains inspection-only. With shell access but no native use tool, the same source's CLI `use EXACT_REF --database ENTRY --json` supplies the closure. Advertise only available routes; if neither exists, report unavailable adoption. Local and packaged Skills keep their native route.

Ordinary CLI `list --database ENTRY --query ntn-skills-maintain` and `read EXACT_REF --database ENTRY` provide the same route when native tools are unavailable. CLI reads require canonical `skill://` refs, not session `sr:` handles. Existing sessions retain their selected instruction versions; inspect or adopt newer content only on request.

Installation also includes `$ntn-skills@builtin`, `$ntn-skills-maintain@builtin` and `$ntn-skills-sync@builtin` for explicit bootstrap or offline use. They appear in `$` discovery only when at least one `sources` entry has `type: notion` and is not `enabled: false`. A configured Notion source exposes these packaged copies even when the connection/authentication is unavailable; their availability does not replace the connected-library route. With no enabled Notion source, they stay packaged but do not appear in `$` completion; follow the [CLI quick start](https://github.com/yoyooyooo/notion-skills-cli/blob/next/README.md#quick-start) for setup or use the supplied CLI to read `ctl builtin read notion/ntn-skills-maintain --path references/setup.md`.

```text
Save the reusable method from this conversation as a Skill in my connected Notion library.
Check the chosen library's sources and preview the synchronization I requested.
```

The current Agent reads the selected workflow and obtains the real CLI argv and database scope for the intended source. With `bash` enabled, Pi can discover and call `notion_ctl({cli_source:"SOURCE_ID"})` for this host-local invocation metadata; it does not execute a command or authorize a workflow. With multiple Notion sources, choose the intended source explicitly. Notion writes and synchronization use the CLI's own preview, exact-target and operation-result contracts. Verified literal calls to the paired CLI's native Skill `create/update/register/remove`, import and Source routes mark only their matching configured sources for fresh discovery. Compound shell commands and external writes are not inferred. To verify a newly written item or request current metadata, call `notion_list({query:"NAME",source:"SOURCE_ID",refresh:true})`; omitting source refreshes all configured Notion sources. Read the returned freshness and coverage independently. Configured offline sources remain offline, and selected Skill versions, accepted drafts and fixed refs remain unchanged.

`/context-broker` remains the host entry for View selection, metadata refresh and diagnostics. The old `/ntn-skills` command mirror, dedicated `save` shortcut and Tern management palettes are retired. Keep your natural-language request and attachments in the ordinary prompt; selecting a Skill only edits the draft.

When an accepted reference is no longer available, both the user and model receive an explicit **not loaded** result. Original text, images and other valid references still proceed once. Ordinary unknown `$name` or `$name@namespace` text, amounts and paths remain literal.

## Updating packaged Skills

Bundled Skills belong to the installed Broker/companion version. Upgrade those packages to receive new workflow and reference files, then restart the host (`/restart` in OMP). A Notion copy or same-name local Skill has its own identity; the `@builtin` selector always identifies the packaged workflow.

Your Notion data and connected source directories remain under the CLI's normal management. Use the maintenance or synchronization Skill for those tasks. Upgrade Broker to update its paired CLI/SDK and workflows. A separate global CLI upgrade does not replace the runtime already bundled in Broker. See [bundled Skills](./packages/context-broker/docs/reference.md#bundled-skills) and [build inputs](./CONTRIBUTING.md#bundling-cli-and-skills).

## OMP and Tern

OMP and Tern have a separate host integration. Their product code remains in the repository, but current acceptance work is deferred while `next` targets Pi.

```sh
omp install npm:pi-context-broker
```

After installing or upgrading in OMP, run `/restart` in the composer to resume the session with the new extension code. `/reload-plugins` refreshes discovery state without re-executing loaded extensions.

OMP, including Tern-hosted OMP, treats a complete Skill body in the active context as already read. Dollar injection identifies the invocation, native source Skill name and resource directory, so the model can use the body directly and read additional resources only when needed. Directory paths retain `pathMode` redaction. See the [host consumption contract](./packages/context-broker/docs/reference.md#host-discovery-and-selected-activation).

In Tern/OMP, loading a selected source Skill adds a persistent, collapsible transcript record, `Read ntn-skills://<alias>`, with its source, elapsed time, and `running`, `done`, or `error` state. The target omits the namespace and retains a page suffix when needed. Terminal records remain after completion and resume restores them; an unfinished record is marked interrupted. `ntn-skills://` is a display identifier. Real reads still use `skill://`. The record and its expanded details never enter provider messages, compaction, or branch summaries. Other terminals use text feedback; enabling a Notion source is sufficient for discovery and use, without a builtin installation. See the [activation contract](./packages/context-broker/docs/reference.md#built-in-sources).

### Tern completion

With OMP 18.10.3+, typing `$` or `$prefix` shows the broker's automatic dropdown. Use arrows to select, Tab or Enter to accept, and Esc to dismiss. Accepted entries become native chips; submission expands them to `$name` for injection. This works directly after prose and with multiple references in a draft.

Clicking inside an accepted chip moves the caret without reopening the dropdown, matching native `/skill:` chips. Typing a new `$` prefix still opens completion.

With the Tern companion installed, `$` menus use a wider 720 px layout with more room for names; the menu shrinks to fit narrow panes. Native `/` menus keep the host layout. After updating the companion, run `/restart` in OMP to load the matching broker extension.

The optional Tern companion adds manual search on **Ctrl+Alt+Shift+K** for a local OMP native pane. Download the complete `tern-context-broker.tar.gz` from a [formal GitHub Release](https://github.com/yoyooyooo/pi-context-broker/releases), extract it and install the extracted directory:

```bash
broker_release_dir="$(mktemp -d)"
curl -fL https://github.com/yoyooyooo/pi-context-broker/releases/latest/download/tern-context-broker.tar.gz -o "$broker_release_dir/tern-context-broker.tar.gz"
mkdir "$broker_release_dir/plugin"
tar -xzf "$broker_release_dir/tern-context-broker.tar.gz" -C "$broker_release_dir/plugin"
tern plugin install "$broker_release_dir/plugin"
tern plugin list --json
```

The archive contains the query, bundled CLI, three Skills and their resources, production dependencies and license notices. Tern installs a directory, not a tar URL. To update, download and extract the new release and add `--force` to the install command. For source development, start with [isolated development](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/isolated-development.md) and select Tern explicitly as described in [build inputs](./CONTRIBUTING.md#bundling-cli-and-skills). Both completion paths edit only the draft; the Broker loads selected content on submission.

Both plugins can be installed together: Tern renders the native interface while OMP continues to run the broker extension, which owns context injection. When switching from the automatic dropdown to manual search, press **Esc** first, then **Ctrl+Alt+Shift+K**. The two menus do not explicitly close each other; simultaneous opening is outside the verified workflow. See [using both plugins](./packages/tern-context-broker/README.md#using-both-plugins).

See the [Tern package guide](./packages/tern-context-broker/README.md) for configuration, updating, and removal. Source changes use the [isolated development guide](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/isolated-development.md).

## Development

Use the [isolated development guide](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/isolated-development.md) for task-owned CLI/Broker clones, private builds, and explicit run inputs. It is the source development entry for both repositories.

Choose checks through [verification routing](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/verification-routing.md), then follow [Contributing](./CONTRIBUTING.md) for review and delivery. Package, live Notion, Pi, and model checks report their own observed scope.

## Documentation

- [Documentation index](./packages/context-broker/docs/README.md): bilingual contract, examples and verification routes.
- [Broker reference](./packages/context-broker/docs/reference.md): sources, host Skill discovery/read, canonical tokens, snapshots, Skill precedence, Routers, configuration, rules, payloads and completion CLI.
- [Skill consumption runtime](./packages/context-broker/docs/skill-consumption-runtime.md): Pi SDK transport, session references, cancellable preparation, confirmed active instructions and fixed-snapshot restoration.
- [Tern package guide](./packages/tern-context-broker/README.md): manual search, profiles, draft safety, and release installation.
- [Configuration examples](./packages/context-broker/examples/config.example.yml) and [catalog example](./packages/context-broker/examples/discovery-catalog.example.yaml).
- [Broker verification Skill](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-context-broker/SKILL.md) and [Notion integration verification Skill](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-skills-integration/SKILL.md): checkout procedures and feature maps. The [daily installation and native menu map](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-skills-integration/features/daily-installation-ui.md) separately covers actual installations, slash menus, live Notion and model consumption. CLI consumption verification lives in `.cursor/skills/verify-notion-consumption/SKILL.md` in the [CLI repository](https://github.com/yoyooyooo/notion-skills-cli/tree/next). These routes do not imply completed acceptance.
- [Contributing](./CONTRIBUTING.md): development checks, verification and release workflow.
- [Changelog](./CHANGELOG.md) and [security policy](./SECURITY.md).

## Privacy and support

The broker runs with the host agent's local permissions. Selected Skill content is sent to your configured model provider and stored in session history. Router selection includes its own body and member metadata; member bodies are read separately when needed. Use trusted roots, catalogs and Notion databases. Notion credentials stay with `ntn-skills`; metadata and selected bodies/resources are cached locally. Source errors expose safe codes instead of raw stderr or secrets. Paths are home-relative by default; `pathMode: hash` provides stronger path redaction, and decision logs omit paths unless enabled.

Local Pi/OMP checks have run on macOS; CI runs CLI and artifact checks on Linux. Windows path-list separators are supported, but Windows runtime behavior remains unverified. Native Tern UI checks require macOS; remote panes and the Tern web client are unsupported by the manual companion.

Report bugs through [GitHub Issues](https://github.com/yoyooyooo/pi-context-broker/issues); use the [private security reporting channel](https://github.com/yoyooyooo/pi-context-broker/security/advisories/new) for vulnerabilities. Licensed under [MIT](./LICENSE); bundled dependency notices are included in the distributed query.
