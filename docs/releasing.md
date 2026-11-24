# Broker release and recovery

This is the maintainer contract for `pi-context-broker`. Publication requires a
separate release decision. Development and acceptance use isolated paired builds;
they do not publish, create release tags, or update daily installations.

## Prepare a release

Integrate and verify the intended CLI and Broker sources before preparing a
release from clean, current `origin/main`. CI and Publish must pin the **same
40-character CLI commit**. That checkout supplies the bundled CLI, SDK v3,
decoder and builtin Skills. Do not select a moving branch or substitute an
installed global CLI.

```sh
bun run release:check patch --no-push
# After release authorization:
bun run release patch
```

The first command reads current remote tags and npm versions and prints a plan.
It does not run the configured checks, create a release commit or create a tag.
The second writes the package version on a temporary branch, updates the lock,
runs the configured check, creates an annotated tag and pushes only that tag.
The release commit must have current main as its single parent and may change
only declared version files and locks. Version files may change only their
version field. Main does not receive a version-only commit.

Only stable `x.y.z` versions on npm `latest` are supported. The next version must
exceed every source, registry and tag version, including unpublished failed
tags. Repository placeholder versions are not instructions to overwrite or
roll back a newer registry release. Tags are immutable; no release command
replaces or deletes them.

CI covers Node `24.22.3` and `26.13.1`. Publish uses Node
`26.13.1`, Bun `1.4.3` and npm `12.2.3`. Workflows pin actions by full commit
with the corresponding upstream release in a comment. Update these inputs
together and retain the checks for the supported Node range
`^24.22.3 || ^26.13.1`.

This is a product requirement, not only a verification-tool minimum. Broker's
normal `openai-completions` request check hashes the bytes reported by
`undici:request:bodyChunkSent`. [Node 22's built-in Undici](https://github.com/nodejs/node/blob/v22.23.5/deps/undici/src/lib/core/request.js)
does not emit this event; a real request therefore cannot satisfy the current
wire contract. [Node 24](https://github.com/nodejs/node/blob/v24.22.3/deps/undici/src/lib/core/request.js)
and [Node 26](https://github.com/nodejs/node/blob/v26.13.1/deps/undici/src/lib/core/request.js)
provide it. Keep the original wire assertions in both CI jobs;
do not substitute an expected payload digest or skip the transport test.
The standalone Notion CLI has its own independently verified Node range.

## What the workflow proves

The `npm-publish` environment retains its approval boundary. Before a real
release, verify the npm package's Trusted Publisher configuration names this
repository, `publish.yml` and the intended environment, with direct `npm publish`
allowed. Inspect it with `npm trust list pi-context-broker --json` using an
authorized existing account; do not infer that permission from OIDC YAML or
`npm whoami`. A passing local test
does not prove that account setting. The publish job uses GitHub OIDC and has
no repository-write permission. A separate job can create a GitHub Release only
after registry verification succeeds.

Publication is serialized for the package with
`cancel-in-progress: false`. The workflow:

1. Checks the selected annotated tag, its allowed source changes and the exact
   paired CLI checkout.
2. Builds from frozen locks and runs Broker and release policy checks.
3. Packs once through the existing `scripts/pack.mjs --target broker` path
   (which invokes npm pack). It inspects the manifest inside that actual tgz
   and rejects unresolved `catalog:`, `workspace:` and local dependencies.
4. Passes that same archive to the independent installed SDK verifier using
   `--archive` and `--report`. The candidate record binds source commits,
   CLI/SDK hashes, verification report, SHA-256 and npm SHA-512 integrity.
5. Reads registry presence explicitly. Only HTTP 404 means absent. Network,
   authorization, rate-limit, server or malformed-response failures mean
   unknown and stop the attempt.
6. Publishes only the checked tgz with scripts disabled, provenance and
   explicit `latest`. If that exact name/version/integrity already exists,
   it skips publication and continues readback.
7. Confirms registry identity, integrity, channel and provenance; performs an
   independent install with a private npm cache; compares all installed
   package bytes; loads the bundled CLI/SDK; and runs npm's cryptographic
   signature/attestation verification. Verified provenance must bind the
   archive, repository, workflow, immutable tag and Broker commit.
8. Creates or repairs GitHub Release metadata and its matching archive only
   after those checks. An existing asset with different bytes is an error;
   it is never overwritten. Readback confirms the final asset digest.

Archive verification also exercises current controlled Notion HTTP through the
installed SDK. These checks do not claim real Notion, Pi session or model
acceptance. Those remain under the existing verification owners.

## Recover without replacing history

Preserve the first failing run, its raw output, tag, source inputs and archive
identity. The workflow retains the installed SDK workspace, current fixture,
candidate, registry observations and command output for seven days; keep the
necessary incident evidence before that retention expires.
The verified handoff archive has a distinct name for each workflow run and
attempt. The release job consumes the producing job's artifact name; retrying
the workflow does not overwrite an earlier attempt's inputs.

| Observed state | Next action |
| --- | --- |
| Registry query is unknown | Resolve the read failure, then read again. Do not assume absence or publish speculatively. |
| Tag exists; registry confirms the version is absent | Keep the failed tag. Fix and verify the cause on main, then prepare a higher version. A retry or repair run cannot publish an absent version. |
| Registry has exactly the candidate integrity; acknowledgement or later verification failed | Re-run the original workflow, or dispatch Publish on the original tag ref with the same tag input. It rebuilds and checks the exact sources, requires matching bytes, skips npm publication and resumes verification. |
| Registry integrity differs, provenance does not match, or the rebuilt archive differs | Stop. Preserve both identities and investigate. Do not move the tag, replace registry bytes or relabel the attempt as success. |
| Registry verification passed; GitHub Release is missing or incomplete | Use the same original-tag repair. It repeats registry/cold-install verification, then creates or updates metadata and uploads a missing matching asset. |
| A newer version is already on latest | Repair may verify the older published version while leaving latest untouched. New publication may never move latest backward. |

For a manual repair, select the immutable tag as the workflow ref as well as
the `tag` input. A branch dispatch with a tag-shaped input is rejected.
Repair never unpublishes a package, moves a tag, resets a channel or overwrites
a release asset. If policy or source code needs changing, deliver that change
through main and use a new version.

## Security fixes, deprecation and channel rollback

Published version bytes and Git tags remain immutable. Prefer a reviewed higher
patch release and an actionable upgrade notice. Report and coordinate security
issues through [SECURITY.md](../SECURITY.md); the maintainer chooses the affected
version range and replacement from actual evidence.

Registry metadata changes need explicit incident authorization. Before changing
anything, retain the current dist-tags, the affected version's metadata and the
known-good version's integrity/provenance. Verify a fresh independent install of
that exact known-good version. Replace every uppercase version placeholder below
with the reviewed exact version.

```sh
npm view pi-context-broker dist-tags --json --registry https://registry.npmjs.org
npm view pi-context-broker@BAD_VERSION version deprecated dist --json --registry https://registry.npmjs.org
npm view pi-context-broker@KNOWN_GOOD_VERSION version dist --json --registry https://registry.npmjs.org
```

If an incident requires temporarily steering new default installs to an older
verified release before a fix is ready, an authorized maintainer may run
`npm dist-tag add pi-context-broker@KNOWN_GOOD_VERSION latest --registry https://registry.npmjs.org`,
then read `npm view pi-context-broker dist-tags --json --registry https://registry.npmjs.org`
and confirm the exact expected latest value. This is an explicit incident
operation outside the forward-only publication/repair workflow. It leaves
existing installations in place, so give those users a concrete upgrade or pin
instruction.

To mark a specific bad version, use
`npm deprecate pi-context-broker@BAD_VERSION "Affected by ISSUE; upgrade to FIXED_VERSION." --registry https://registry.npmjs.org`.
Read that exact version's `deprecated` field back and preserve the result. A
deprecation notice does not replace the archive or select a new channel.

Unpublish is reserved for an independently authorized incident, such as an
exposed secret or compromised archive, under npm's current unpublish policy.
It is not routine rollback. Rotate exposed credentials separately. Neither
withdrawal nor deprecation makes a published version number or tag reusable.
These instructions define an available response path; preparing or testing this
repository does not execute these registry mutations.

## Verify the release mechanism without publishing

```sh
node --test scripts/release.test.mjs scripts/skill-consumption-contract.test.mjs
```

The existing release tests use owned temporary repositories and controlled
registry/GitHub responses. They cover failed checks, unknown registry state,
immutable failed tags, source/pin constraints, archive manifests, duplicate
attempts, integrity/provenance mismatches and metadata repair. They preserve
their fixtures and do not call real publication APIs. The wiring test ensures
CI/Publish reach the required checks and that GitHub Release depends on
registry verification.

Use the [integration verification Skill](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-skills-integration/SKILL.md)
for current installed SDK consumption. CLI publication has its own
[release contract](https://github.com/yoyooyooo/notion-skills-cli/blob/next/docs/releasing.md).
Tern remains outside this Broker publication path.
