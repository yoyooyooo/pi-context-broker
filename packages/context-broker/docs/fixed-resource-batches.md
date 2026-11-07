# Fixed resource batches in Pi

SC07 / [AH-626](https://linear.app/yoyooyooo/issue/AH-626) adds a resource-only
batch to Pi's existing `read` tool. The owner and snapshot are fixed before
reading. A batch does not prepare a Skill graph, reread its main instructions,
or activate its workflow.

```ts
read({ paths: ["sr:R…", "sr:R…"] })
```

Use actual resource handles returned by the selected Skill directory. Canonical
fixed `skill://` file refs are also accepted. Every item belongs to one enabled
source, owner and snapshot. The main entrypoint, unfixed refs, local paths, mixed
owners/pins, duplicate files, and batch `offset`/`limit` are rejected. Stable File
IDs retain their frozen binding: an old path hint can resolve to the real path in
that pin. Both the requested and canonical references remain in machine evidence.

## Native read compatibility

`path` and `paths` are mutually exclusive. The scalar path branch delegates to
Pi's public `createReadToolDefinition` executor, preserving native text paging,
image handling/settings, structured output and renderers. The adapter forwards
the real `toolCallId`; existing single-file/main receipts remain linked to their
actual tool results. A third-party extension that already owns `read` is not
replaced. OMP receives the call-ID plumbing but this batch slice is Pi-specific.

When another extension owns `read`, Pi exposes the same resource batch through
`notion_read_resources({ paths: [...] })`. The existing reader keeps its scalar
schema, executor and rendering. This fallback accepts only fixed resources;
main entries and individual native reads continue through `read`. The ordinary
Broker-owned `read` already supports `paths`, so it does not add the fallback.

The adapter checks availability at session start and again before requests, so a
later read override can receive the fallback. Disabling `read` also suspends the
fallback, without re-enabling `read` or changing other active tools. An explicit
fallback disable while `read` remains available is preserved. Both batch entries
share the source operation, budgets, cancellation and version-2 delivery proof.
Their actual tool names remain distinct in the session and verification evidence.

### Fixed scalar resources

A fixed resource `read({ path: "sr:R…", offset?, limit? })` or canonical fixed
resource path uses one SDK `readSkill(ref, { output })` when the bundled package
advertises `READ_OUTPUT_PROOF_VERSION = 1`. The SDK returns the selected-file
`sha256` and independent manifest `entrypoint_sha256` in its machine result.
Broker verifies the current source, owner, scope, pin, stable File binding and
output bytes before handing its immutable resource path to the native tool.
This path does not prepare, read or materialize the owner's main instructions.
It retains scalar size support instead of applying the batch budgets below.

The short reference still has to match the independently obtained owner main
commitment and resource proof. Source completion, native completion and receipt
attachment each check cancellation, the current session and branch binding.
Native content, pagination, images and structured results remain native; the
v1 resource receipt compares the actual returned text with the whole file and
always has `loaded: false`. A direct resource has no prepared entry manifest.

SDKs that do not advertise this additive capability retain the previous route,
without a speculative SDK read. Custom commands and non-Pi hosts also retain
their routes. Canonical paths naming the main entrypoint use the existing main
route, including when they carry a File ID; this avoids an extra main read.
A stale main-path hint whose File ID identifies a resource still resolves on
that existing route. A resource-path hint whose File ID identifies the main
is recognized by the source and continues through normal main preparation.

One batch enters one source-runtime operation and one SDK `readResources` call.
It does not loop over `readSkill`, launch a CLI for every file, or invoke
`skill_prepare`. The default bundled SDK advertises independent
`RESOURCE_READ_CONTRACT_VERSION = 1`; old SDK/consumer v1 functions retain their
contracts. A package lacking the new capability rejects a batch explicitly.

## Budgets and failure

SDK defaults are 16 files, 1 MiB of selected source bytes, and a 30-second whole
operation deadline. Hard maxima are 64 files, 16 MiB, and 120 seconds. The file
budget is checked before runtime acquisition; selected bytes are checked after
manifest/identity admission and before object acquisition. Metadata requests can
therefore precede a byte-budget failure. Valid immutable cached chunks can remain
after an error, but the result is never partially ready.

The Broker separately checks the complete serialized model result against its
context-byte budget. JSON escapes and wrapper bytes count. No source text is
truncated to fit. A cancelled/expired operation, failed selected file, invalid
proof, or obsolete session generation cannot emit a successful batch delivery.

## Model content and machine evidence

The model receives canonical JSON with `status: "ready"` and ordered `files`:

| Kind | Model fields | Delivery claim |
| --- | --- | --- |
| Text | `kind`, `ref`, `path`, `content` | Exact whole UTF-8 source, including BOM, CRLF, Unicode and empty text |
| Binary | `kind`, `ref`, `path`, `bytes`, `sha256`, `output` | Original bytes materialized at a verified local path; no claim of complete text/image delivery |

The structured result has the same public shape. Binary base64 is confined to
machine data and never injected as model text. Complete source manifest,
selection, source hashes and SDK observations stay in details.

`details.contextBrokerResource` version 2 binds the actual tool call, fixed
selection, each source identity and the complete rendered text digest. Each text
file has a JSON-string span; offsets are JavaScript UTF-16 positions, while byte
counts/digests use UTF-8. Empty spans (`start === end`) are valid. Every resource
proof has `loaded: false`; none restores a main-body pin or active graph.

Provider projection replaces a repeated, independently verified text span with
`Already available.` only when the same scope/owner/pin/file/hash is already
present in the active context. New files in a mixed batch remain complete.
Binary metadata is retained, and empty files stay empty because a confirmation
would add text. The derived receipt gets a new rendered digest and records its
validated parent. Original session tool results and call IDs remain intact;
after compaction removes an earlier copy, the surviving original full result
can be projected again. Legacy single-resource v1 receipts participate in the
same identity-based deduplication.

## Verification boundaries

The existing CLI package fixture adds a separate `resources` Skill containing
ordinary UTF-8, BOM/CRLF, empty and binary files plus an unselected resource.
It stays warm and does not prove cold download behavior. Core controlled-source
tests check selected object IDs, shared-chunk deduplication and unselected/main
zero reads. Independent npm SDK smoke checks real exports, decoder rejection and
request cleanup. Installed Pi uses the existing `scripts/notion-sdk-pi.mjs`
`resource-batch` scenario with actual native tool schema/results, provider
payloads, local binary bytes, source observations, and repeat projection. The
separate `resource-batch-short-refs` variant explicitly inspects the owner first,
then batches the four actual `sr:R` handles from that directory. Its one inspect
consume is counted separately from the two resource reads.

The scalar variants and their baseline/candidate source and provider costs are
recorded separately in [fixed scalar verification](scalar-resource-consumption-verification-2026-11-05.md).

Launch, Doctor, Drive, Evidence and Cleanup remain in the existing
[consumption map](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/skill-consumption.md).
Controlled provider success, live source behavior, real model choice, pro/mini
recovery and daily installation remain distinct evidence. The original SC07
introduction/execution journeys and SC21 gates are not closed by a batch fixture.
