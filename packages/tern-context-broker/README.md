# Tern Context Broker

[English](./README.md) | [中文](./README.zh-CN.md) · [Project overview](https://github.com/yoyooyooo/pi-context-broker#readme)

[Install](#install) · [Use](#use) · [Configuration](#configuration) · [Development](#local-development)

An optional Tern window plugin for selecting context in a local **OMP native GUI draft**. The Broker supplies automatic `$` menus and native capsules. This companion adds a wider menu layout and manual search on **Ctrl+Alt+Shift+K**. Select a record, keep editing your prompt, then submit when ready.

## Requirements

- Tern with `session:surface`, `session:event`, `sessions:current` and `cx:pick`; the current API check uses Tern 0.9.5.
- OMP 18.10.3+ with the Context Broker extension loaded.
- Node.js 22.22.3+ within 22.x or 24.20.0+ on Tern's PATH, or an explicit `node` setting.
- A local OMP native pane with a known working directory. Terminal panes use their host's Broker editor; remote panes and the web client are unsupported by manual search.

Install the Broker following the [project quick start](https://github.com/yoyooyooo/pi-context-broker#quick-start). The companion includes its query, CLI and workflow Skills. Online Notion sources use official `ntn` 0.22.12+ with `api --notion-version` and existing authentication. An unavailable source leaves local and healthy source candidates available.

## Install

Use the complete `tern-context-broker.tar.gz` from a [formal GitHub Release](https://github.com/yoyooyooo/pi-context-broker/releases). Download and extract it, then install the extracted directory:

```bash
broker_release_dir="$(mktemp -d)"
curl -fL https://github.com/yoyooyooo/pi-context-broker/releases/latest/download/tern-context-broker.tar.gz -o "$broker_release_dir/tern-context-broker.tar.gz"
mkdir "$broker_release_dir/plugin"
tar -xzf "$broker_release_dir/tern-context-broker.tar.gz" -C "$broker_release_dir/plugin"
tern plugin install "$broker_release_dir/plugin"
tern plugin list --json
```

The archive includes `query/completion.mjs`, `query/ntn-skills.mjs`, all three `query/builtin-skills` directories and resources, production `query/node_modules`, and license notices. Installation needs no dependency download. `tern plugin list --json` should report `context-broker` as `ready` with no problems. Installing reloads a running daemon; otherwise the next launch uses the plugin.

To update, download and extract the new archive and repeat `tern plugin install <extracted-directory> --force`. Tern accepts a directory or git source, not a tar URL. A repository checkout needs the [build procedure](https://github.com/yoyooyooo/pi-context-broker/blob/main/CONTRIBUTING.md#bundling-cli-and-skills) before installation because its generated runtime is not committed. Remove the companion with `tern plugin remove context-broker`.

After upgrading Broker code, run `/restart` in OMP. `/reload-plugins` refreshes discovery without re-executing the loaded extension; `tern plugin reload` reloads only this companion.

## Use

1. In the OMP composer, type `$` or a prefix such as `$design`.
2. For automatic completion, select with arrows and accept with Tab or Enter. Esc dismisses the menu. The Broker owns native capsule editing, deletion and undo.
3. For manual search, first dismiss the automatic menu with Esc, then press **Ctrl+Alt+Shift+K**. Pick a candidate; cancellation preserves the draft.
4. Review the prompt and submit. Selection itself never starts a model request. The Broker loads the selected content and retains original text, attachments and other references.

Manual selection performs one native range edit and inserts a plain exact token. It uses the existing `$alias@page-id@namespace` syntax for Notion, or an encoded local identity for filesystem entries. Labels remain short; identity does not come from the label. Automatic selection can keep its shorter token because the Broker captures the accepted identity at the submission boundary. Both routes preserve that exact choice when the catalog changes.

If a chosen target disappears, the user and model receive **not loaded** feedback. A full identity absent from the catalog is reported as unavailable in that catalog, without pretending a remote read occurred. Other valid references and the original message still proceed once. Unknown simple `$name`/`$name@namespace`, amounts and paths remain literal. Actual permission, network, integrity or ambiguity failures block activation.

During preparation the draft remains editable, a second submission is blocked, and native **Stop** or Escape cancels. A new draft accepted while an earlier turn runs belongs to its own later submission. The Broker's persistent `Read ntn-skills://<alias>` rows are display-only; actual model resource reads use the selected local directory or `skill://` snapshot refs.

For upstream Skills, type `$pstack/` to browse that subscription or `$pstack/cor` to narrow it. The subscription Name supplies labels such as `pstack/correct [skill]`; the selected page identity and source remain explicit.

**Cancel pending Context Broker native operation** invalidates a pending query or picker and releases this companion's UI guard. Esc closes a visible picker. The documented process API has no child cancellation handle; an already started metadata query can run until its ten-second timeout, but its stale result cannot edit the draft.

## Bundled workflows

The same ordinary `$` entries work in Pi, OMP TUI and OMP native GUI:

```text
$ntn-skills@builtin Explain the CLI commands for this task.
$ntn-skills-maintain@builtin Save the reusable method from this conversation to Notion.
$ntn-skills-sync@builtin Preview the synchronization I requested.
```

These Skill bodies and references work offline with zero Notion sources and no global `ntn-skills`. They ship privately with the package; no publication or manual installation is needed. The current Agent uses the Broker's actual CLI argv and source/database scope. Multiple sources require an explicit choice. The three `@builtin` identities stay distinct from same-name local files or Notion pages.

The companion contains no CLI command mirror, save wrapper, management reader or install/publish palette. `/context-broker` in the host retains View selection, refresh and diagnostics. Upgrade Broker/companion packages to update the bundled workflows.

## Using both plugins

| Surface | Input, selection and dispatch owner | Companion role |
| --- | --- | --- |
| Pi TUI inside Tern | Pi Broker adapter/editor | No terminal draft editing |
| OMP TUI inside Tern | OMP Broker adapter/editor | No terminal draft editing |
| OMP native GUI in Tern | OMP Broker native editor | Manual exact-token insertion and automatic-menu styling |

The automatic menu expands to 720 px and gives long names up to 60% of a row; narrow panes constrain it. Native slash menus keep their host layout. Close the automatic menu before opening manual search; the two triggers do not explicitly close each other.

Manual callbacks check pane, cwd, Tern workspace/session, surface/editor, full text, UTF-16 cursor and request ownership before editing. They change only the selected prefix range. Chinese/emoji offsets cannot split surrogate pairs. The public Tern snapshot does not expose OMP conversation/branch, attachment or undo revisions; equal visible snapshots do not prove no intervening change. The companion sends no attachment replacement or invented session event. Conversation changes and attachment/undo behavior require separate real-host verification.

## Configuration

By default the query uses `~/.omp/agent/context-broker/config.yml`. Match the Broker's active profile and configured sources, roots and catalogs. Notion command, database, namespace and cache policies belong in that Broker config; credentials stay in the CLI's existing authentication.

Optional companion settings live at `<Tern config>/plugin-data/context-broker/config.json`, outside the installed source:

```json
{
  "node": "/absolute/path/to/node",
  "config": "/absolute/path/to/context-broker/config.yml",
  "agentDir": "/absolute/path/to/profile/agent"
}
```

All three fields are optional. Replace examples with real paths. On macOS, Tern defaults to `~/Library/Application Support/Tern`; `TERN_CONFIG_DIR` overrides it. Plugin updates preserve this separate configuration. Retired `builtinAgentDirs`, `cliConfigHome` and `cliStateHome` settings are unused; query authentication comes from the existing source command/environment.

The detached query searches packaged Skills and the complete configured catalog, regardless of the session's selected View. It reads metadata only and does not inherit dynamically discovered system-prompt Skills. The Broker prepares selected-View content separately and loads the chosen complete body and resources on submission.

## Local development

From the repository root:

```bash
bun install --frozen-lockfile
bun run build
tern plugin install ./packages/tern-context-broker --force
omp -e ./packages/context-broker/src/index.ts
```

Rebuild after TypeScript, CLI or Skill resource changes, then reinstall copied packages. Luau-only changes need another install. For live Luau development, `tern plugin link ./packages/tern-context-broker` uses the source and `tern plugin reload` reloads it. A copy must be backed up or moved to system Trash before linking; `--force` does not replace links. Use `tern plugin unlink context-broker` before returning to copied release installs. Keep logs and runtime configuration outside linked source.

`bun run test:ui` drives an isolated real Tern window and OMP host with controlled provider/source fixtures. It checks automatic capsules, body counts, manual Unicode replacement, cancellation and focus changes, retaining screenshots and evidence. Pi TUI, OMP TUI, real Notion content and actual model instruction use have separate verification routes; one native-window check does not substitute for them.

## Troubleshooting

If manual search does not open, focus a local OMP native composer with the cursor after `$` or a prefix. If a candidate is absent, run `/context-broker doctor` and `/context-broker find <query>` in OMP, then check that the companion uses the same profile. Node startup failures require a supported Node executable on Tern's PATH or the explicit `node` setting. A missing `query/node_modules` or builtin directory indicates an incomplete source installation; use the complete release archive or rebuild.

The companion reads configured metadata and launches Node with the user's permissions. Notion sources use their configured CLI and discovery cache policy; candidate text is never executed as shell code. See the [security policy](https://github.com/yoyooyooo/pi-context-broker/blob/main/SECURITY.md) and [MIT license](./LICENSE).
