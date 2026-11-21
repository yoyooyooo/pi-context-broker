# Current-context acceptance

The consumer keeps complete same-version instructions, generated directories and
requested resources once in each outgoing request. Explicit repeated operations
still run and retain their own results. Current-version inspection can coexist
with an older active selection; it is content for comparison and does not
activate a new instruction graph.

## Evidence levels

The installed package, actual Pi, controlled service, natural model and ordinary
daily entry each require their own evidence. The current Pi driver uses an
installed SDK v2, current Notion service facts and the installed Pi
OpenAI-completions serializer over loopback HTTP. It records exact versions and
hashes rather than inferring them from a checkout or a prior successful run.

A wire receipt covers the actual Node Undici entity, tool schema and required
message roles. Logical acceptance, completed turns and persisted native
projection remain separate facts. Other APIs and transports need their own
proof. The driver does not certify live Notion, natural model choices or the
user's ordinary `pi -ns` launch.

`/context-broker request` retains up to 32 in-memory summaries containing hashes,
counts, fixed pins, reuse state and operation effects. It does not retain source
bodies, locators, credentials or full payloads. A known entity mismatch prevents
new delivery confirmation even if the request has already been sent.

## Build and install the paired candidate

Use the exact CLI revision declared for this candidate. Build with a supported
Node and the repository's Bun version, then generate current service facts:

```sh
bun install --frozen-lockfile
bun run build
node scripts/sdk-fixture.ts --outdir "$FIXTURE_ROOT" --catalog
```

From the Broker checkout, build with that explicit raw CLI input, pack and
install the archive in a fresh owned npm consumer:

```sh
export NTN_SKILLS_BUILD_ENTRY="$CLI_ROOT/packages/cli/dist/ntn-skills.js"
bun install --frozen-lockfile
bun run build:broker
bun scripts/pack.mjs --target broker --out-dir "$ARCHIVE_ROOT"
```

Set `BROKER` to the installed package directory, `FIXTURE` to its current
`fixture.json`, `PI` to one supported installed Pi entry and `OUT` to a new
absolute evidence directory. The HTTP helper must come from the same CLI
checkout that produced the bundled SDK:

```sh
node scripts/notion-sdk-pi.mjs doctor --package "$BROKER" --fixture "$FIXTURE" --source-http-helper "$CLI_ROOT/scripts/sdk-source-fixture.mjs" --pi "$PI"
node scripts/notion-sdk-pi.mjs run --package "$BROKER" --fixture "$FIXTURE" --source-http-helper "$CLI_ROOT/scripts/sdk-source-fixture.mjs" --pi "$PI" --scenario all --out "$OUT"
node scripts/notion-sdk-pi.mjs evidence --evidence "$OUT"
```

The only current scenarios are:

| Scenario | Main obligations |
| --- | --- |
| `default-view` | Default Context off/on fetches no body before use; an active root/Requires keeps its fixed bytes across Default Context and Enabled changes, rejected refresh, ordinary continuation and compaction. |
| `http-cache-recovery` | Ordinary continuation keeps the selected root/Requires after source edits and expired metadata TTL; read-refresh compares without adoption; use-refresh adopts a complete current closure; cache clear and missing fixed bytes after compaction do not prevent later prompts. |
| `http-interruption` | Abort an actual held Notion body request, continue the same Pi session and explicitly retry without accepting cancelled delivery. |
| `working-set` | Two roots share one Required node; release retains the surviving closure; compaction restores it; an over-budget addition fails without eviction. |

The service fixture adds mutable source facts, never preseeded consumer
snapshots, bindings or cache. Public refs come from the actual visible catalog
and tool results. The provider controls decisions; original source text, RPC
frames, SDK operation terminal events and HTTP request entities remain
independent observations.

`all` means these four scenarios. Removed SDK v1 fixtures, old scenarios and
provider-backend flags are rejected. Evidence and failed runs are retained;
there is no cleanup action in this driver. Negative entity/role/schema cases
remain in the explicit source and Node transport tests, not an implied removed
Pi scenario.

## Configure the project candidate

The public `verify-pi-daily-installation.mjs candidate-plan` and
`candidate-run --live` actions use the JSON below. Ordinary daily `plan/run`
uses the separate [daily configuration](../.agents/skills/verify-notion-skills-integration/features/daily-installation-ui.md#准备普通日用配置).
The controlled `notion-sdk-pi.mjs` driver above does not produce a natural-model
or daily-installation receipt.

### Obtain the original artifact receipt

Select the complete CLI package and its matching archive from the current CLI
`package:check` result. Use that installed package as `CLI_PACKAGE`, and retain
the exact CLI checkout as `CLI_CHECKOUT` for the HTTP fixture and helper. Run the
existing artifact entry from the Broker checkout:

```sh
	export NTN_SKILLS_BUILD_ENTRY="$CLI_PACKAGE/dist/ntn-skills.js"
	export CONTEXT_BROKER_GRAPH_CORE="$CLI_CHECKOUT/packages/core/src"
	unset NTN_SKILLS_DEV_ROOT
	node "$CLI_CHECKOUT/scripts/sdk-fixture.ts" --outdir "$FIXTURE_ROOT" --catalog
	node scripts/verify-artifacts.mjs --fixture "$FIXTURE_ROOT/fixture.json" --source-http-helper "$CLI_CHECKOUT/scripts/sdk-source-fixture.mjs"
```

Use a new owned absolute `FIXTURE_ROOT`. The verifier prints
`Artifact workspace retained: PATH` and preserves `PATH/manifest.json`,
`PATH/commands.json` and `PATH/current-sdk/result.json`, including on failure.
Read those original outputs. Only the completed current `version:2` manifest
can supply `artifactReceipt`; do not write a success object, add retired fields
or convert an older result. This entry builds, packs and independently installs
the Broker, but does not start Pi or a model.

Fill the candidate inputs from the same manifest and package check:

| Candidate field | Actual source |
| --- | --- |
| `artifactReceipt` | `{path,sha256}` for the unmodified `PATH/manifest.json` |
| `brokerRoot` | `manifest.package.installed`, the exact independently installed directory |
| `brokerArchive`, `brokerArchiveSha256` | `manifest.package.archive.path` and `.sha256` |
| `cliRoot` | Directory containing `manifest.buildInput.manifest.path` |
| `cliArchive`, `cliArchiveSha256` | Matching original CLI archive from the selected `package:check` result; every published file must match `cliRoot` |
| `cliEntrySha256` | `manifest.buildInput.cli.sha256` |
| `embeddedCliSha256`, `embeddedSdkSha256` | `manifest.runtime.cli_sha256` and `.sdk_sha256` |

`validateCandidateArtifactReceipt` compares the actual raw CLI, SDK and package
manifest paths, sizes and hashes; the installed Broker and archive; the current
runtime capabilities and bundled hashes; and the completed installed SDK HTTP
proof. The v2 producer has no `host:pi` or `buildInput.mode`. Its runtime uses
`cli_sha256`, `sdk_sha256` and `hashes:{cli,sdk}`. Pi, model and live-Notion
entries in `notRun` remain unexecuted until their own runs occur.

### Freeze the authorized library and source bodies

`ownershipReceipt` is a `{path,sha256}` reference to an original JSON record for
the exact already-authorized Skills database. There is no dedicated ownership
receipt generator and the file does not grant permission. Preserve the existing
task authorization or library-creation record. An authorized read-only library
inspection can supply the current descriptor:

```sh
	node "$CLI_PACKAGE/dist/ntn-skills.js" ctl library inspect "$DATABASE" > "$OWNED_INPUTS/library-inspect.json"
```

Check the real exit status and JSON result before using it. Match the exact
database in that original record to the authorized scope and `config.database`.
Keep the authorization reference alongside the readback. The candidate checks
the file hash, parses the JSON and requires the database string to appear; this
binding alone does not establish ownership. Missing authorization, failed
inspection or an absent database identity remains `blocked`. Do not edit an
error result into an ownership record.

Freeze each expected complete body in a separate owned file from an independent
source readback. Record its exact bytes and SHA-256. Do not warm the candidate's
Store to construct the oracle. The example below describes one root with no
Requires. Add every required body and its expected occurrence count when the
actual task has dependencies. Preserve full files; do not truncate to match a
budget.

### Fill the candidate JSON

Replace every `REPLACE_` value, path and illustrative number with actual inputs.
The placeholders deliberately cannot pass validation. `packageIndex` is the
zero-based slot of the reviewed existing local Broker registration. Its source
must be an absolute path matching `oldBrokerRoot`; the independently installed
`brokerRoot` is a different directory. `localSkill` identifies the real existing
same-name local Skill whose bytes the run must preserve.

```json
{
	"version": 1,
	"scope": "project-scoped-candidate-precheck",
	"brokerRoot": "/absolute/artifact-run/strict-closure/consumer/node_modules/pi-context-broker",
	"brokerArchive": "/absolute/artifact-run/archives/pi-context-broker.tgz",
	"brokerArchiveSha256": "REPLACE_WITH_64_HEX_BROKER_ARCHIVE_SHA256",
	"embeddedCliSha256": "REPLACE_WITH_64_HEX_EMBEDDED_CLI_SHA256",
	"embeddedSdkSha256": "REPLACE_WITH_64_HEX_EMBEDDED_SDK_SHA256",
	"cliRoot": "/absolute/cli-package-check/node_modules/ntn-skills",
	"cliArchive": "/absolute/cli-package-check/ntn-skills.tgz",
	"cliArchiveSha256": "REPLACE_WITH_64_HEX_CLI_ARCHIVE_SHA256",
	"cliEntrySha256": "REPLACE_WITH_64_HEX_RAW_CLI_SHA256",
	"oldBrokerRoot": "/absolute/currently-registered-broker",
	"packageIndex": 1,
	"sourceId": "REPLACE_WITH_EXISTING_NOTION_SOURCE_ID",
	"database": "REPLACE_WITH_AUTHORIZED_SKILLS_DATABASE_UUID",
	"model": "magpie/group/flash",
	"thinkingLevel": "high",
	"localSkill": {
		"name": "release-checklist",
		"path": "/absolute/existing-local-skills/release-checklist/SKILL.md",
		"sha256": "REPLACE_WITH_64_HEX_LOCAL_SKILL_SHA256"
	},
	"ownershipReceipt": {
		"path": "/absolute/owned/inputs/library-inspect.json",
		"sha256": "REPLACE_WITH_64_HEX_ORIGINAL_OWNERSHIP_RECORD_SHA256"
	},
	"artifactReceipt": {
		"path": "/absolute/artifact-run/manifest.json",
		"sha256": "REPLACE_WITH_64_HEX_ORIGINAL_ARTIFACT_MANIFEST_SHA256"
	},
	"expectedBodies": [
		{ "path": "/absolute/owned/inputs/remote-main.md", "bytes": 1234, "sha256": "REPLACE_WITH_64_HEX_MAIN_BODY_SHA256" }
	],
	"turns": [
		{
			"id": "remote-checklist",
			"prompt": "请使用团队在 Notion 中维护的发布检查清单，说明这次发布前需要核对的项目。",
			"requireUse": true,
			"bodies": [{ "sha256": "REPLACE_WITH_64_HEX_MAIN_BODY_SHA256", "occurrences": 1 }],
			"proofs": [{ "contextBrokerPreparation": { "purpose": "use" } }]
		}
	],
	"evidenceRoot": "/absolute/owned/current-candidate"
}
```

`expectedBodies[].path` must be absolute, `bytes` a positive integer and
`sha256` a lowercase 64-digit digest. Freeze each distinct body hash once.
Every turn needs a unique identifier and nonempty natural prompt. Each body
assertion references a frozen hash and uses a nonnegative integer occurrence
count. `proofs` contains the nonempty partial objects that must occur in actual
tool receipts. `requireUse:true` requires a successful use call and its matching
preparation receipt. It does not replace an independent review of task success.
`requireUse:false` does not assert zero unnecessary calls.

The live action requires the already-authorized `NOTION_API_TOKEN` in the
inherited environment and the normal provider configuration. Do not put secrets
in this JSON or copy credential files. `evidenceRoot` is an owned absolute
directory outside this repository. `candidate-plan` only validates the turn
plan; `candidate-run --live` checks the actual installation and inputs before
starting its project session. Neither action changes the ordinary daily package
registration. Follow the [daily map](../.agents/skills/verify-notion-skills-integration/features/daily-installation-ui.md)
for the public commands and the T16/T17 manual timeline and T22 trace review.

### Freeze file identities

This read-only command prints the real path, byte count and hash of one explicit
file. Use it for original receipts, archives, local Skills and expected bodies.
It produces file facts, not a verification result:

```sh
	node --input-type=module -e 'import {readFile,realpath} from "node:fs/promises"; import {createHash} from "node:crypto"; const path=await realpath(process.argv[1]); const bytes=await readFile(path); console.log(JSON.stringify({path,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")},null,2));' /absolute/owned/original-file
```

The field definitions above come from `plan`, `configurationSnapshot`,
`verifyDailyCliShim`, `validateDailyFind` and `validateDailyDoctor` in
`scripts/verify-pi-daily-installation.mjs`, and `candidatePlan`,
`normalSnapshot`, `runCandidate` and `validateCandidateArtifactReceipt` in
`scripts/verify-pi-daily-candidate.mjs`. The producer remains
`scripts/verify-artifacts.mjs`; there is no compatibility receipt converter.

## Maintenance

The [context verification map](../.agents/skills/verify-context-broker/features/context-once.md)
owns the invariants and routes. The [source review](context-once-source-review.md)
separates finite state models from byte, role and entity checks. The
[next worktree delivery contract](next-worktree-delivery.md) owns the paired
commits, build provenance and ordinary-process readback on Pro and Mini.

Report each result at its actual layer. A current controlled Pi pass is useful
evidence; it does not close natural-agent routing, real service timelines or
daily entry synchronization.
