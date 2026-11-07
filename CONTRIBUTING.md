# Contributing

## Setup

```bash
bun install
bun run build
bun run check
```

Host and artifact checks require the selected `pi` and/or `omp` executable on PATH. CI freezes host versions in the [workflow matrix](https://github.com/yoyooyooo/pi-context-broker/blob/main/.github/workflows/ci.yml); use the versions declared there when reproducing a release check:

```bash
bun run test:host
bun run test:global-config
bun run test:lifecycle
bun run test:release
bun run test:artifacts
```

For source dependency or packaging changes, run `bun run test:source-dependencies` and `node scripts/verify-native-ui.mjs --source-dependencies`. The first starts both real hosts with controlled missing project command, API capability and authentication failures, preserves local and healthy sources, blocks unavailable selections, and repairs a command through refresh. The second checks the startup warning, ordinary chat, local completion and Tern manual picker in an owned native window. Artifact verification repeats the host scenarios against the unpacked npm extension and starts both bundled CLIs without a global `ntn-skills` installation.

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

### Pi-first delivery

The npm Broker can be built and packed without constructing the deferred Tern companion:

```bash
NTN_SKILLS_BUILD_ENTRY=/actual/notion-skills-cli/packages/cli/dist/ntn-skills.js bun run build:broker
NTN_SKILLS_BUILD_ENTRY=/actual/notion-skills-cli/packages/cli/dist/ntn-skills.js bun scripts/pack.mjs --target broker --out-dir /absolute/output
node --test scripts/notion-integration-hosts.test.mjs
node scripts/verify-notion-integration.mjs run --mode live --host pi --database DB --skill-ref REF --extension INSTALLED_EXTENSION --command-json '["node","INSTALLED_CLI"]'
```

`--target broker` does not install Tern dependencies or write Tern files. Ordinary builds and packs still default to both products. Integration Doctor and ordinary deterministic/live/installed/model runs honor `--host pi|omp`; unselected hosts are recorded as unrun. Explicit cross-host cache/editor scenarios reject host narrowing rather than silently dropping coverage. A separate authorized model run proves actual instruction/resource use. None of these options publishes a release or rewrites user configuration.

`bun run test:verification` checks host/pack routing; it is part of the default check. `bun run check:broker` adds the Broker-only build, package regressions, shared Notion adapter and completion tests without building Tern. The real-model runner records a separate 300-second multi-step prompt budget and elapsed time; deterministic RPC retains its 120-second default. A successful final answer and receipt-validated entry/resource reads remain required, including after an earlier timed-out run.

### Local Pi candidate and rollback

Local delivery uses the current checked changes and a local CLI tarball; it does not require an npm release or a merge to `main`. Keep the candidate installation outside the checkout in a new persistent directory. Build and test before switching the normal Pi registration.

1. Install the complete local CLI tarball into a fresh prefix. Select that installation's CLI entry when packing Broker; the builder resolves its SDK export and copies all three bundled Skills from the same package.

   ```bash
   npm install --prefix /absolute/candidate/cli --workspaces=false --omit=dev --no-audit --no-fund /absolute/ntn-skills-candidate.tgz
   NTN_SKILLS_BUILD_ENTRY=/absolute/candidate/cli/node_modules/ntn-skills/dist/ntn-skills.js bun scripts/pack.mjs --target broker --out-dir /absolute/candidate/archives
   npm install --prefix /absolute/candidate/broker --workspaces=false --omit=dev --no-audit --no-fund /absolute/candidate/archives/BROKER_TARBALL_FROM_PACK_OUTPUT.tgz
   ```

   Replace the example paths and final tarball name with the actual outputs. Record both archive hashes, installed entries, and `dist/ntn-skills-runtime.json`; its CLI/SDK hashes must match `dist/ntn-skills.mjs` and `dist/ntn-skills-sdk.mjs`. Run `--version` and `schema list/read/use` through the installed standalone CLI. A shared version number does not identify the build.
2. Record `pi list`, the exact existing Broker package entry in the normal Pi settings, and the standalone `ntn-skills` launcher target/bytes and executable mode. Retain the old installed directories. For a first installation, `pi install /absolute/candidate/broker/node_modules/pi-context-broker` registers the local package. For an upgrade, replace only the existing Broker source in that package slot, preserving any per-package filters and every other setting; do not append a second Broker. Re-read the settings before writing so concurrent edits are not overwritten.
3. Point the standalone CLI launcher to the same installed CLI used for the build. For Agent authoring, enable `tool_search` while retaining the current tool selection. Pi 1.5 accepts additive `defaultTools: ["+tool_search"]` when the setting is absent, or adding `"+tool_search"` to the existing selection; record the prior field presence/value for rollback. A one-run check can use `pi --tools +tool_search`. The Broker keeps `notion_ctl` deferred and does not enable tools itself. Keep the source configuration's default bundled SDK path: an explicit `source.command` selects the compatibility transport instead. Metadata-only discovery uses `prefetch: false`; existing source identity, authentication and cache settings stay in place. Do not clear working caches to make the installation appear fresh.
4. Start a new owned Pi process with normal HOME/settings and a new session directory. Verify that exactly one `context-broker` command came from the candidate package, without `-e` injecting the target extension. The [installed-consumption map](./.agents/skills/verify-notion-skills-integration/features/installed-consumption.md#pro-本地主线交付) separates normal autoload, selected content/resource use, request accounting and real-model behavior. Existing user sessions need no forced restart.
5. To roll back, first confirm that the package slot, launcher and any changed tool setting still match this candidate, then restore only their recorded previous values and start a new Pi process. Preserve concurrent changes, old sessions, caches and both artifact directories. A rollback changes the installed code selection; it does not rewrite a session's pinned content.

Use fresh allowed evidence directories for each run. Existing runners accept explicit package, extension, fixture and evidence paths; historical evidence locations are not prerequisites for a new local candidate. Run the checks affected by the changes and one real authorized authoring/consumption task. Pi compatibility versions, other hosts, the full historical cost matrix and release gates keep their own reported status rather than becoming unconditional prerequisites for Pro local use.


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

## Documentation and verification records

User guides describe supported behavior and durable decisions. Verification Skills retain runnable commands, negative cases and evidence requirements. Keep dated candidate reports, machine-specific paths and raw run ledgers outside the checkout. Preserve original failures and unrun cases there; removing a superseded report from Git does not change its result. Do not remove tests or weaken acceptance rules during documentation cleanup.

## Release

Tern release archives are self-contained. Download and extract the archive, then run `tern plugin install <extracted-directory>`; Tern does not install the tar URL directly. Source checkouts require a build before local installation. Broker npm releases are tag-driven:

```bash
bun run release:check patch
bun run release patch
```

`release:check` resolves the proposed release and runs the configured `checkCommand` without creating a release commit, tag or push. `--dry-run` plans without running that quality gate. The release command creates a temporary local branch, writes the version files and runs the same check before committing, tagging or pushing; failure stops those actions. `--no-push` still runs the gate. GitHub Actions additionally enforces its configured host, lifecycle, release-policy and artifact checks.

Planning still fetches/prunes tags and queries npm, so do not treat `--dry-run` or `release:check` as completely side-effect free. The repository permits reusing a failed version only while that version remains unpublished; published npm versions cannot be replaced. See [release configuration](https://github.com/yoyooyooo/pi-context-broker/blob/main/.github/release.config.json) for the current policy.

Publication builds both artifacts and publishes the exact packed Broker tarball. Registry fresh-install and upgrade checks must pass before creating the GitHub Release and attaching `tern-context-broker.tar.gz`. The Tern version is owned by its package and manifest and may differ from the broker's npm version. `bun scripts/pack.mjs` rehearses both artifact formats locally; Tern users install the extracted release directory; source checkouts are a development input.

Verify a registry release against the locally reviewed archive:

```bash
node scripts/verify-artifacts.mjs --host pi --registry pi-context-broker@X.Y.Z --expected-archive /absolute/candidate.tgz --fixture /absolute/sdk-fixture.json --require-sdk
node scripts/verify-artifacts.mjs --host pi --registry pi-context-broker@X.Y.Z --expected-archive /absolute/candidate.tgz --fixture /absolute/sdk-fixture.json --require-sdk --upgrade-from pi-context-broker@A.B.C
```

Replace the placeholders with exact stable versions; ranges and `latest` are rejected. The verifier checks registry name/version/integrity, requires downloaded bytes to equal the reviewed archive, installs into a fresh npm consumer, and runs the existing Pi/SDK artifact checks. The upgrade route first installs the specified older package, replaces it in place, and checks preserved isolated Pi/Broker configuration fixtures and removal of old package files before the same consumer checks. `--upgrade-from` also supports the existing local candidate route for rehearsal.

Read back the registry artifact and complete its installation checks before declaring publication complete; local checks and CI success do not prove npm publication.
