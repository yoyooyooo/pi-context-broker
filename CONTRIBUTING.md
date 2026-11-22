# Contributing

## Choose an isolated development pair

Start parallel work with the [isolated development guide](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/isolated-development.md).
It uses `scripts/paired-environment.mjs` to create two task-owned clones from
`next`, build private CLI/Broker generations and run an explicit generation with
separate application state. Keep `next` for integration. Do not rebuild a
checkout registered in the user's normal CLI or Pi installation for an experiment.

The guide is the single command and isolation reference. Its environment entry
does not replace the verification owners below, alter global settings or relax
the normal-environment and current-`next` delivery checks.

## Current Broker workflow

The current delivery target is Broker with the matching ntn-skills SDK v2. OMP and Tern product code remains available, but their acceptance work is deferred. The default check does not require either host.

Install locked dependencies, select one complete CLI/SDK candidate and its matching decoder source, then run the existing check:

```sh
bun install --frozen-lockfile
export NTN_SKILLS_BUILD_ENTRY=/absolute/current/notion-skills-cli/packages/cli/dist/ntn-skills.js
export CONTEXT_BROKER_GRAPH_CORE=/absolute/current/notion-skills-cli/packages/core/src
node scripts/skill-consumption-contract.mjs check-gates
bun run check:broker
```

Build the CLI before selecting its entry. An unpacked package without its runtime dependencies is not an installed build input. Do not mix a released SDK, a checkout CLI and decoder code from different revisions. CI and publish select the same exact CLI commit. The package manifests and workflows declare the supported Node/Bun toolchain.

`check-gates` checks wiring; `check:broker` executes the Broker build, package regressions and completion checks. For a focused change, run the affected existing tests first and let the integrator run the full check once. Do not add another verification wrapper.

## Verification ownership

Start at the [Broker verification Skill](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-context-broker/SKILL.md) and [cross-repository routing](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/verification-routing.md).

- Current source, directory, selection, resource and cancellation behavior uses the existing package tests.
- SDK pairing and independent installation use the [integration Skill](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-skills-integration/SKILL.md).
- Eligibility, request order, fixed selection and delivery state use the [consumer-state Skill](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-consumer-state/SKILL.md) and its existing model/guard mapping.
- Actual Pi SDK/provider/serializer scenarios use `scripts/notion-sdk-pi.mjs` with its explicit installed-package inputs.
- Real Notion and the effective daily Pi installation use the public `scripts/verify-pi-daily-installation.mjs` actions under AH-1197/AH-637; `scripts/verify-pi-daily-candidate.mjs` is its internal implementation.
- Natural user journeys, mixed local/Notion selection and management use the [workflow verification Skill](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-agent-workflows/SKILL.md) under AH-1196/AH-1198. Daily and no-native-skills retain their normal-environment requirements. First use from an empty parent uses the separate `native-onboarding` profile through the same candidate entry, with a packed paired build and a fresh explicit-entry grader. See the [onboarding configuration](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-agent-workflows/references/running.md#空父页首次使用). All profiles run real `magpie/group/worker`; public tasks, private criteria and raw results stay separate.

The old default dual-host controller, CLI-consumption fixtures and UI/PTY/model wrappers are retired. Do not restore `source.command`, old locators, `readOnly` or export fallback to make a test run. The controlled `ctl views` stub is only a management boundary; it cannot stand in for SDK consumption.

Code tests, controlled HTTP, independent installation, actual Pi, live Notion, model behavior and native UI each need their own result. A package check does not launch Pi. Native-terminal acceptance is not established by RPC or a passing completion test. OMP/Tern remain deferred, with no current Tern acceptance claim.

## Independent package check

Generate a fresh current HTTP fixture with the same CLI source and run the existing artifact verifier:

```sh
node /absolute/current/notion-skills-cli/scripts/sdk-fixture.ts --outdir /absolute/new-current-fixture --catalog
node scripts/verify-artifacts.mjs --fixture /absolute/new-current-fixture/fixture.json --source-http-helper /absolute/current/notion-skills-cli/scripts/sdk-source-fixture.mjs
```

Keep the build-input environment above. The verifier builds and packs Broker, performs a separate production installation, checks actual bundled CLI/SDK hashes and resources, then calls the existing installed SDK verifier. It covers complete pagination, bodies, Files, warm reuse, use, scalar/batch resources, exact owner/scope and cancellation over current HTTP. Consumption must make zero semantic Notion writes and launch no CLI body-reading subprocess.

Read the actual commands, result and HTTP log as well as the exit code. These results do not prove a real Notion account, the daily installation, Pi menus or model behavior.

## Bundling CLI and Skills

`build:broker` and `bun scripts/pack.mjs --target broker --out-dir /absolute/output` build only Broker. The selected CLI package supplies its complete CLI/SDK runtime and bundled Skills/resources; users should not need a central Skill installation. Validate builtin discovery, full main text and every referenced file from the independent package.

Full `bun run build` and the default pack can still build the Tern companion when that product is explicitly in scope. Tern keeps its self-contained query runtime, dependency notices and bilingual guides. Follow the [Tern development guide](https://github.com/yoyooyooo/pi-context-broker/blob/next/packages/tern-context-broker/README.md#local-development) when that deferred work resumes. The independent surface scripts are not a prerequisite for current Broker delivery.

Build a new private generation when the selected CLI/SDK or Skill files change during development. A global CLI upgrade cannot replace the bytes already bundled in Broker. A daily installation update is a separate delivery step: preserve its configured identity and inspect the effective new process before claiming a daily switch.

## Development rules

- Keep discovery and identity in Broker; host adapters own their public protocol, editor and submission behavior. `CONTEXT_BROKER_HOST` cannot change the protocol of an already running host.
- Validate at config, SDK, filesystem and network boundaries. Preserve scope, complete metadata, enabled state, owner/File identity and cancellation across those boundaries.
- Do not hard-code local absolute paths, credentials or private endpoints.
- Keep the [English](README.md) and [Chinese](README.zh-CN.md) entrypoints consistent. Detailed Broker configuration belongs in the bilingual [package reference](./packages/context-broker/docs/reference.md).
- Edit README/CONTRIBUTING/SECURITY/CHANGELOG at the root. The build projects them into the package; do not edit generated copies. Maintain Broker reference documents directly in `packages/context-broker/docs`.
- State-machine changes require reviewing the existing models and protected regressions. Hash changes alone do not prove preservation.

Use owned temporary roots when a check needs empty state. Preserve unknown operations, failures and original input bytes. Never reset a user's cache or session to manufacture success. Stop only processes owned by that run, then move reviewed scratch to system Trash using an absolute path; do not use permanent deletion or bulk process-name cleanup.

## Release

Broker npm publication remains tag/version driven and uses the existing approval/provenance workflow. Current CI and publish run the Broker checks and current installed-package verifier. They do not inherit deferred dual-host, UI or model requirements.

```sh
bun run release:check patch --no-push
bun run release patch
```

The release script runs its declared check before creating release commits, tags or pushes. Planning commands do not prove those checks passed and can still fetch/prune tags or query npm. Use the release-policy tests in an owned temporary repository when verifying that behavior. A published npm version cannot be replaced; read back the actual registry result before claiming publication.

Tern distribution, when explicitly resumed, uses its own package version and extracted self-contained archive. Do not claim a Tern release from current Broker-only packaging.
