# pi-context-broker

[English](./README.md) | [中文](./README.zh-CN.md)

[Install](#install) · [Quick start](#quick-start) · [Tern](#tern-completion) · [Documentation](#documentation)

Load filesystem or Notion Skills and Router indexes into Pi or OMP by naming them in your prompt:

```text
$design-review review this API boundary
```

The broker resolves `design-review`, sends its context to the model, and avoids appending another copy while that context remains in the active session branch.

## Why use it

Agent setups accumulate review checklists, runbooks and team workflows. Context Broker publishes names and descriptions before loading selected bodies. A Notion source uses a session-selected View, its configured `default_view_id`, or the first View in API order. `Default Context` is an ordinary checkbox used only by saved View filters. Full `$` selection, search and explicit reads remain available outside that View. Startup may prepare metadata and snapshots; it never sends a model request or activates bodies.

Pi and OMP receive a short `<ntn-skills-guidance>` block by default, including executable argv, source/database scope, discovery/read/resource commands and help entrypoints. It is retained once in the active context; compaction or rewind that removes it restores it before the next model request. Skill bodies and remote discovery remain separate.

In Tern/OMP, loading a selected source Skill adds a persistent, collapsible transcript record, `Read ntn-skills://<alias>`, with its source, elapsed time, and `running`, `done`, or `error` state. The target omits the namespace and retains a page suffix when needed. Terminal records remain after completion and resume restores them; an unfinished record is marked interrupted. `ntn-skills://` is a display identifier. Real reads still use `skill://`. The record and its expanded details never enter provider messages, compaction, or branch summaries. Other terminals use text feedback; enabling a Notion source is sufficient for discovery and use, without a builtin installation. See the [activation contract](./packages/context-broker/docs/reference.md#built-in-sources).

| Record | Source | What the model receives |
| --- | --- | --- |
| Skill | A discovered `SKILL.md` or filesystem/Notion source record | Full selected Skill content; source resources share its selected snapshot |
| Router | Notion `ROUTER.md` or a local catalog | Own body and member index; member bodies are read when needed |
| Prompt | Notion `PROMPT.md` | Full requirements added to each explicitly selected user task |

Use `$name` or an alias to select a record. Keyword rules can load Skills or explicit `router:<name>` targets. The broker also provides interactive completion and `/context-broker` diagnostics.

## Content lifecycle

Every CLI catalog exposes `records` with required `id/kind/locator/name/alias/description/default_context/entrypoint/ref`. The broker rejects unknown kinds, malformed locators and legacy `skills/skill` responses. Read and export share `record/entrypoint/scope/snapshot_id/version_id/ref`; export is pinned to the selected read snapshot and checked against portable manifest v2 and the complete inventory. Entry files are `SKILL.md`, `ROUTER.md` and `PROMPT.md`.

Select a Prompt explicitly with `$alias@notion`. Each submission owns a new invocation, session generation and prepared snapshot set; preflight and dispatch reuse that exact snapshot. Repeating the same Prompt on the next submission appends its full requirements again at user-task level, preserving original text and images. Prompt never enters native Skills, default discovery, background preparation, keyword activation or system prompts. Stop, timeout and session changes invalidate pending dispatch. Completion acceptance changes only the draft; all hosts and detached completion share `identity/kind/source/ref` and existing UTF-16 edit ranges in protocol v1.

Old domain Bundle catalogs and stored session markers require explicit conversion with `node scripts/migrate-content-assets.mjs INPUT OUTPUT`. Runtime discovery accepts only Router records. Conversion writes a separate output and preserves immutable snapshots and resource paths.
The converter changes only catalog record fields and recognized Broker session details, including structured Router references and source receipt identities. Authored content, snapshot IDs, resource paths and unknown nested data remain unchanged, even when they contain `bundle:` or `kind="bundle"`. It rejects mixed catalog envelopes and malformed members; it never overwrites the input or an existing output.

## Maintain and sync with bundled Skills

Installation includes three ordinary Skills: `$ntn-skills@builtin`, `$ntn-skills-maintain@builtin` and `$ntn-skills-sync@builtin`. They appear in `$` discovery immediately, including their reference files, with no Notion source, global `ntn-skills` executable, publication or separate Skill installation required.

```text
$ntn-skills-maintain@builtin Save the reusable method from this conversation as a Skill in my Notion library.
$ntn-skills-sync@builtin Check my connected sources and preview the synchronization I requested.
```

The current Agent reads the selected workflow and uses the real CLI argv and database scope supplied by the Broker. With multiple Notion sources, choose the intended source or database explicitly; the Agent must not choose the first source implicitly. Use `$ntn-skills@builtin` for command and resource guidance. Notion writes and synchronization use the CLI's own preview, exact-target and operation-result contracts. A verified write observed through the configured CLI marks its source directory for refresh on the next ordinary selection, so a newly created or renamed Skill becomes discoverable without a manual refresh. Already loaded snapshots and accepted drafts retain their existing ownership.

`/context-broker` remains the host entry for View selection, metadata refresh and diagnostics. The old `/ntn-skills` command mirror, dedicated `save` shortcut and Tern management palettes are retired. Keep your natural-language request and attachments in the ordinary prompt; selecting a Skill only edits the draft.

When an accepted reference is no longer available, both the user and model receive an explicit **not loaded** result. Original text, images and other valid references still proceed once. Ordinary unknown `$name` or `$name@namespace` text, amounts and paths remain literal.

## Install

Install into the host you use:

```bash
# Pi
pi install npm:pi-context-broker

# OMP
omp install npm:pi-context-broker
```

The broker package requires Node.js 22.22.3+ within 22.x or 24.20.0+. Bun is used only for building, not as the production CLI runtime. After installing or upgrading in OMP, run `/restart` in the composer to resume the session with the new extension code. `/reload-plugins` refreshes discovery state without re-executing loaded extensions.

The npm package and GitHub `main` are separate distribution inputs. To try the current checkout before an npm release, run these commands from the repository root:

```bash
bun install --frozen-lockfile
bun run build

# Choose one host
pi -e ./packages/context-broker/src/index.ts
omp -e ./packages/context-broker/src/index.ts
```

The optional Tern companion has its own [release installation](#tern-completion).

## Quick start

### 1. Configure a Skill directory

Create `~/.pi/agent/context-broker/config.yml` for Pi or `~/.omp/agent/context-broker/config.yml` for OMP:

```yaml
skillRoots:
  - ~/context/skills
requireAutoload: false
pathMode: home-relative
logPaths: false
```

If you use a custom agent directory or OMP profile, see [configuration resolution](./packages/context-broker/docs/reference.md#configuration). Restart the host after changing configuration; in OMP, use `/restart`.

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

Run these commands in the host composer:

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

Enter starts preparation immediately and locks submission while leaving the draft editable. The native composer shows running and **Stop**; **Stop** or Escape cancels preparation. Enter during preparation does not submit the edited draft. Successful preparation sends the original prompt, images, and complete selected Skill body once in the first provider request. Blocking activation errors, timeout, or cancellation send no provider request; a session switch also prevents late dispatch.

Unknown simple `$name` and `$name@namespace`, amounts and paths such as `$bunfs/root/chunks/cli-nxfh2cp0.js` remain ordinary text without a failure notification. A previously accepted choice or full identity token that is unavailable produces explicit user/model **not loaded** feedback. Other valid Skill/Prompt/Router references, original text and images still proceed once. Ambiguity and actual selected-record permission, network, catalog or integrity errors block activation; no other source is selected silently.

The next model request includes the Skill content. Submitting the same record through `$` or OMP native `/skill:` reuses the body while it remains in the active context. A rewind or compaction that removes the body allows it to load again; deduplication does not remove existing context from subsequent requests.

OMP, including Tern-hosted OMP, treats a complete Skill body in the active context as already read. Dollar injection identifies the invocation, native source Skill name and resource directory, so the model can use the body directly and read additional resources only when needed. Directory paths retain `pathMode` redaction. See the [host consumption contract](./packages/context-broker/docs/reference.md#host-discovery-and-selected-activation).

### Add a Notion source

The plugin includes `ntn-skills`; no global `ntn-skills` installation is needed. Install the [official Notion CLI](https://developers.notion.com/cli) `ntn` with `api --notion-version` support (0.22.12+), authenticate with `ntn login` or the existing CLI token, then add a source to the same broker config:

```yaml
sources:
  - id: notion
    type: notion
    # Replace with your Skills database id or unambiguous selector.
    database: 00000000-0000-0000-0000-000000000000
    discovery: {maxAge: 5m, offline: false}
    activation: {maxAge: 5m, offline: false}
```

Keep credentials out of this config. An optional `default_view_id` on each Notion source fixes its default View; omit it to use the first View in API order. An invalid configured ID is reported, not replaced; a verified empty View list means no default Notion entries. OMP keeps its composer available while discovery runs; the first user submission waits for the selected metadata before the model request. At `before_agent_start`, the Broker replaces its own directory with current metadata, preserving local Skills and already loaded bodies. A checked page outside the View is not advertised; an unchecked page inside it is. Native reads and `$` activate only the selected record. Detached completion stays full-library and metadata-only. Code or configuration changes require a host restart; a session View switch does not.

Use `/context-broker refresh` to refresh metadata and make a later selection eligible for a new snapshot; existing conversation content is retained. Unscoped Notion discovery can be search-index limited; an explicit database can supply exhaustive coverage for that database. See [source configuration and activation](./packages/context-broker/docs/reference.md#built-in-sources) for all fields, scope isolation, ambiguity and cache policies.

Notion caches are shared across projects and Pi/OMP by credential and remote catalog identity. Full-directory metadata and View membership use separate cache selections, so filtering one session never hides another session’s `$` candidates. Session choices live in active-branch entries and survive process resume; new sessions resolve their own defaults. Shared refresh preserves loaded workflow snapshots. [Cache contract](./packages/context-broker/docs/reference.md#built-in-sources).

Run `/context-broker doctor` to check the official CLI version, capabilities, authentication and source access. Missing dependencies or failed access mark only that source unavailable; local Skills, healthy sources and ordinary chat continue working. Activating a selected known record from an unavailable source blocks dispatch with a repair hint. An unknown simple reference passes through unchanged even in that source's namespace; accepted and full-identity references report unavailability explicitly. After repairing it, run `/context-broker refresh`. An explicit `command` overrides the packaged CLI and remains your responsibility.

`/context-broker sources` reports background preparation state, snapshot/version IDs, CLI freshness and safe error codes; `ready` means prepared bytes, not instructions loaded into the session.

### Updating the packaged Skills

Bundled Skills belong to the installed Broker/companion version. Upgrade those packages to receive new workflow and reference files, then restart the host (`/restart` in OMP). A Notion copy or same-name local Skill has its own identity; the `@builtin` selector always identifies the packaged workflow.

Your Notion data and connected source directories remain under the CLI's normal management. Use the maintenance or synchronization Skill for those tasks. A source-specific `command` changes that source's executable; it does not replace the packaged workflows. See [bundled Skills](./packages/context-broker/docs/reference.md#bundled-skills) and [build inputs](./CONTRIBUTING.md#bundling-cli-and-skills).

## Tern completion

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

The archive contains the query, bundled CLI, three Skills and their resources, production dependencies and license notices. Tern installs a directory, not a tar URL. To update, download and extract the new release and add `--force` to the install command. A source checkout requires the [build procedure](./CONTRIBUTING.md#bundling-cli-and-skills) before local installation. Both completion paths edit only the draft; the Broker loads selected content on submission.

Both plugins can be installed together: Tern renders the native interface while OMP continues to run the broker extension, which owns context injection. When switching from the automatic dropdown to manual search, press **Esc** first, then **Ctrl+Alt+Shift+K**. The two menus do not explicitly close each other; simultaneous opening is outside the verified workflow. See [using both plugins](./packages/tern-context-broker/README.md#using-both-plugins).

See the [Tern package guide](./packages/tern-context-broker/README.md) for configuration, updating, removal and local development.

## Documentation

- [Documentation index](./packages/context-broker/docs/README.md): bilingual contract, examples and verification routes.
- [Broker reference](./packages/context-broker/docs/reference.md): sources, host Skill discovery/read, canonical tokens, snapshots, Skill precedence, Routers, configuration, rules, payloads and completion CLI.
- [Tern package guide](./packages/tern-context-broker/README.md): manual search, profiles, draft safety and release installation and local development.
- [Configuration examples](./packages/context-broker/examples/config.example.yml) and [catalog example](./packages/context-broker/examples/discovery-catalog.example.yaml).
- [Broker verification Skill](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-context-broker/SKILL.md) and [Notion integration verification Skill](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/SKILL.md): checkout procedures and feature maps. The [daily installation and native menu map](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/daily-installation-ui.md) separately covers actual installations, slash menus, live Notion and model consumption. CLI consumption verification lives in `.cursor/skills/verify-ntn-skills/SKILL.md` in the [CLI repository](https://github.com/yoyooyooo/notion-skills-cli). These routes do not imply completed acceptance.
- [Contributing](./CONTRIBUTING.md): development checks, verification and release workflow.
- [Changelog](./CHANGELOG.md) and [security policy](./SECURITY.md).

## Privacy and support

The broker runs with the host agent's local permissions. Selected Skill content is sent to your configured model provider and stored in session history. Routers expose member metadata and paths; their bodies are loaded separately. Use trusted roots, catalogs, source commands and Notion databases. Notion credentials stay with `ntn-skills`; metadata and selected bodies/resources are cached locally. Source errors expose safe codes instead of raw stderr or secrets. Paths are home-relative by default; `pathMode: hash` provides stronger path redaction, and decision logs omit paths unless enabled.

Local Pi/OMP checks have run on macOS; CI runs CLI and artifact checks on Linux. Windows path-list separators are supported, but Windows runtime behavior remains unverified. Native Tern UI checks require macOS; remote panes and the Tern web client are unsupported by the manual companion.

Report bugs through [GitHub Issues](https://github.com/yoyooyooo/pi-context-broker/issues); use the [private security reporting channel](https://github.com/yoyooyooo/pi-context-broker/security/advisories/new) for vulnerabilities. Licensed under [MIT](./LICENSE); bundled dependency notices are included in the distributed query.

### Select a View for this session

```text
/context-broker views
/context-broker view
/context-broker view VIEW_ID_OR_NOTION_URL
/context-broker view notion VIEW_ID_OR_NOTION_URL
/context-broker view default
```

`views` lists API-ordered choices with exact selection commands. `view` without arguments reports name, ID, source, selection origin and count. Multiple sources require the source ID. Selecting a View changes only the active session; `default` resets to configured selection or first-View fallback. These commands do not call the LLM. The next ordinary user submission receives the new names/descriptions; full Skill bodies remain on demand. A source may set `default_view_id: VIEW_UUID` beside `database` in YAML. Names are never special and API order is not promised to match UI tab order.
