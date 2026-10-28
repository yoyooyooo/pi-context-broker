# Contributing

## Setup

```bash
bun install
bun run build
bun run check
```

Host and artifact checks require `pi` and `omp` on PATH. CI pins OMP 18.10.3, Pi 1.2.0 and Bun 1.3.14:

```bash
bun run test:host
bun run test:global-config
bun run test:lifecycle
bun run test:release
bun run test:artifacts
```

For source dependency or packaging changes, run `bun run test:source-dependencies` and `node scripts/verify-native-ui.mjs --source-dependencies`. The first starts both real hosts with controlled missing command/`ntn`/version/capability/authentication failures, preserves local and healthy sources, blocks unavailable selections, and repairs a command through refresh. The second checks the startup warning, ordinary chat, local completion and Tern manual picker in an owned native window. Artifact verification repeats the host scenarios against the unpacked npm extension and starts both bundled CLIs without a global `ntn-skills` installation.

Host runners resolve Volta shims before isolating HOME and invoke Node host entries directly. Fake-provider runs do not inherit developer credentials or runtime configuration; timeout cleanup targets only their own process groups.

Tern development requires Tern 0.8.3+, OMP 18.10.3+ and Node.js 22.22.3+ within 22.x or 24.20.0+. Bun is build-only. For copied installations, build and run `tern plugin install ./packages/tern-context-broker --force` after edits. For live Luau linking and switching back to release copies, follow the [Tern package guide](./packages/tern-context-broker/README.md#local-development). Keep test logs/config/data outside linked source directories.

`bun run test:ui` runs a real isolated macOS Tern window from a clean release install. It exercises automatic completion, atomic deletion/undo, mixed Skill/Router submission, actual provider-body counts, Unicode manual replacement, cancellation and focus changes. Screenshots and fixtures are retained. Keep UI checks local; they require Tern 0.8.3+ and OMP 18.10.3+.

Both `verify-native-ui.mjs` and `verify-daily-notion-ui.mjs` seed the temporary Tern configuration's `omp/state.json` with `{"managed":false,"checked":0,"no_build":false,"offered":true}` before startup. This remembers **Not Now** for that test configuration, prevents the first-run **Manage omp** dialog, and keeps update ownership out of the verification run. For ad hoc native windows, write the same state under the temporary `TERN_CONFIG_DIR` before starting Tern; keep the daily configuration and its update preference intact.

For source preparation and persistent transcript records, run `node scripts/verify-native-ui.mjs --notion-loading` using the [loading procedure](./.agents/skills/verify-notion-skills-integration/features/activation-snapshot-resources.md). Keep its controlled page unchecked to prevent background preparation, and begin each cold case without a loaded Skill body; metadata refresh preserves active instructions. It covers editable drafts with blocked resubmission, native Stop and Escape, full pinned-export body in the first dispatch, and exact-session resume. Images and session-switch cancellation require separate RPC evidence; the UI runner does not cover them.

Set `BROKER_UI_EXTENSION=/absolute/installed/pi-context-broker/src/index.ts` to exercise an installed extension with the same isolated source/provider fixtures. The runner uses short `/tmp/broker-ui-*` sockets and only exits its own daemon/window through those endpoints and retained child handles. Never identify test processes by name or age, signal daily Tern windows/daemons, modify the daily Tern configuration, or touch a mounted Tern volume.

`bun run test:model` explicitly calls only `magpie/group/flash-free` through the existing login. It verifies instruction use, repeat deduplication, real default compaction and reinjection, and records safe selector/body-count evidence at the actual transport boundary. It rejects other model selectors and does not record credentials, headers or request URLs. Do not put authenticated model runs into CI.

All runtime checks retain evidence directories. Inspect them before moving them to the system trash; scripts never permanently delete them.

The project verification Skill lives at [.agents/skills/verify-context-broker/SKILL.md](.agents/skills/verify-context-broker/SKILL.md). Start from its feature map, then run `node .agents/skills/verify-context-broker/scripts/control.mjs doctor editor` and `run editor` for native UI changes. The helper records actual versions, commands, exit statuses and retained evidence paths. Choose `injection`, `lifecycle`, `model` or `distribution` for those surfaces; `/maintain-verification-skill` keeps the map current. Native UI teardown records its owned daemon/window PIDs and waits for their exits; evidence survives cleanup.

## Three UI surfaces

Use the existing surface driver for Pi terminal in Tern, OMP terminal in Tern and OMP native in Tern. Start with an owned fixture configuration containing the actual installed paths, observed candidate identities and per-surface reset/actions; freeze it and run each generated spec:

```bash
node scripts/tern-surface-spec.mjs --config /absolute/owned-config.json --out /absolute/new-specs
node scripts/verify-tern-surfaces.mjs run --surface pi-terminal --spec /absolute/new-specs/pi-terminal.json --evidence-root /absolute/evidence
node scripts/verify-tern-surfaces.mjs run --surface omp-terminal --spec /absolute/new-specs/omp-terminal.json --evidence-root /absolute/evidence
node scripts/verify-tern-surfaces.mjs run --surface omp-native --spec /absolute/new-specs/omp-native.json --evidence-root /absolute/evidence
```

The generator reads and freezes inputs; the driver performs the real interactions. Its current matrix covers packaged builtin selection, exact identity/kind/source selection, unavailable references, relative resources, Router and Prompt behavior, images, Unicode drafts, deletion/undo and cancellation. The old parent command, mirrored CLI and dedicated save cases are retired. A terminal candidate must be the sole exact result of the packaged query and then accepted through the actual editor; native selection uses the observed clickable candidate. Every case retains a screenshot and an assertion against the real draft, provider delivery or host tool result. `resource-read` uses the existing `tool-read` assertion to verify the actual read result, including its file hash when provided. `selected-unavailable` can use a previously observed exact token after removing that owned fixture.

OMP native additionally exercises the manual picker's observable pane and cwd guards. Include a full-draft edit while manual completion is open in the Unicode/cancellation interaction and assert that the old selection cannot replace it. The SDK does not expose conversation or attachment revision identities for a plain manual range edit; record that limitation explicitly. Automatic submission session changes, cancellation and a new draft accepted while the previous request runs remain covered by `bun run test:lifecycle` and the existing `accepted-selections.test.ts` / `input-guard.test.ts` cases. The optional `stale-session` surface case exercises a real host session change when the available UI supports that interaction.

A case blocked by an unavailable public API or missing fixture remains blocked in the result. `probe` and `controlled` runs diagnose transport and delivery; the real-model `run` result records product acceptance. Optional `runLimits` in the frozen spec bounds elapsed time and provider requests across startup, reset, scenarios and resume. Resume uses the same frozen spec and preserves completed cases.

## Bundling CLI and Skills

Build against the released `ntn-skills` dependency declared in the Broker package. For an intentional cross-repository development build, first build the CLI checkout, then select its built entry explicitly:

```bash
NTN_SKILLS_BUILD_ENTRY=/actual/notion-skills-cli/packages/cli/dist/ntn-skills.js bun run build
```

The override selects the CLI entry and its nearest `ntn-skills/package.json`; ordinary builds resolve the installed dependency. The chosen manifest and production runtime must use official `effect`, `@effect/platform-node`, `@effect/platform-node-shared` and `@effect/sql-sqlite-node` 4.0.5. Install locked dependencies in both checkouts before building.

The build copies the selected package's `ntn-skills`, `ntn-skills-maintain` and `ntn-skills-sync` directories, including their resources, into Broker `dist/builtin-skills` and Tern `query/builtin-skills`. These are private package assets discovered through the normal local Skill path. No install receipt, user Skill root, central distribution or prior Notion publication is involved.

Both products receive the same CLI bytes. The Broker declares its Node runtime as production dependencies; Tern builds a complete production `query/node_modules` tree with a manifest, lockfile and license notices. Building Tern needs npm registry access. The release archive includes that tree and requires no dependency installation after extraction.

`bun scripts/pack.mjs --out-dir /absolute/output` builds both artifact formats. A development override build demonstrates local compatibility; a formal release must pin the published CLI version and pass ordinary artifact checks without the override. Verify the installed packages, including offline builtin discovery, body and reference-file reads, and source-specific CLI argv.

Rebuild and reinstall both products when their selected CLI or Skill files change, then restart the host (`/restart` in OMP). A global CLI upgrade or a source `command` override does not update packaged workflow files. Builtin tests belong to ordinary discovery/loading and package-closure checks; the retired host management and save adapters have no separate acceptance harness.

## Development rules

- Keep both packages independently installable: the npm broker must declare its production runtime, and Tern distributions must include the complete built query, `query/node_modules` and LICENSE. Rebuild those files whenever their inputs change; source/GitHub checkouts without the ignored runtime tree require a build before local installation. The query retains dependency license text.
- Do not hard-code local absolute paths, API keys, tokens, or private service endpoints.
- Broker discovery/ranking owns candidate semantics; Tern owns its picker and guarded native draft edits. Do not duplicate discovery in Luau.
- Add or update smoke coverage for config resolution, discovery, injection, and privacy behavior.
- Update README and examples when config fields or user-visible behavior change.
- Keep [English](./README.md) and [Chinese](./README.zh-CN.md) entrypoints equivalent in installation, capabilities and limits. Root READMEs own the overview and quick start; detailed broker configuration belongs in [the package reference](./packages/context-broker/docs/reference.md) and its [Chinese version](./packages/context-broker/docs/reference.zh-CN.md), and Tern operations belong in its bilingual package guides.
- Edit root README/CONTRIBUTING/SECURITY/CHANGELOG files at the root. `bun run build` projects them into the npm package; do not edit those generated copies. Broker reference documents are maintained directly in `packages/context-broker/docs`. Keep both Tern README languages in the committed GitHub directory and release archive.

Keep Pi and OMP prompt, native expansion and editor verification separate. The generic `model` route covers OMP summarization; Notion integration `--mode model` runs both hosts by default and accepts `--host pi|omp` for explicit single-host evidence. Pi terminal completion is validated separately from Tern/OMP capsules. Keep one broker package with host-neutral discovery, identity, preparation and snapshot services. Select the adapter once at the extension entry from the host API. Each adapter owns catalog registration, prompt presentation, editor installation, input results, native submission and receipt selection. OMP uses command submission with a handoff receipt; Pi uses input transformation with an expanded-input digest. The shared preparation gate owns cancellation and acknowledges a cancelled handoff before allowing a replacement submission. Current session context remains authoritative for activation deduplication. `CONTEXT_BROKER_HOST` selects fallback default paths for configuration and detached completion; it cannot change the running host's protocol or override an explicit agent directory. Keep the opposite-host override regression in the existing global-config runner, and use the existing source and editor verification maps for submission, resources and cancellation.

## Release

Tern release archives are self-contained. Download and extract the archive, then run `tern plugin install <extracted-directory>`; Tern does not install the tar URL directly. Source checkouts require a build before local installation. Broker npm releases are tag-driven:

```bash
bun run release:check patch --no-push
bun run release patch
```

The release script creates a temporary local release branch, writes version files, and executes the declared `checkCommand` before any release commit, tag or push. Check failure prevents those actions. `--no-push` also runs the gate; `release:check` and `--dry-run` are planning commands and do not run checks. Publication additionally requires code, both-host, lifecycle, release-policy and artifact gates in GitHub Actions.

Planning still fetches/prunes tags and queries npm, so do not treat `--dry-run` or `release:check` as completely side-effect free. The repository permits reusing a failed version only while that version remains unpublished; published npm versions cannot be replaced. See [release configuration](https://github.com/yoyooyooo/pi-context-broker/blob/main/.github/release.config.json) for the current policy.

Publication builds both artifacts, publishes npm from `packages/context-broker`, and attaches an optional `tern-context-broker.tar.gz` to the GitHub Release. The Tern version is owned by its package and manifest and may differ from the broker's npm version. `bun scripts/pack.mjs` rehearses both artifact formats locally; Tern users install the extracted release directory; source checkouts are a development input.

Before npm Trusted Publishing is configured, a maintainer can publish manually from a real TTY:

```bash
bun run build
npm login --auth-type=web --registry https://registry.npmjs.org
npm publish ./packages/context-broker --access public --registry https://registry.npmjs.org --auth-type=web
```

Agent shells may fail with `EOTP` because they are not a TTY. Read back the registry version before declaring a publication complete; local checks and CI success do not prove npm publication.
