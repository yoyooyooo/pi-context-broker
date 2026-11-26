# Fixed resource batches in Pi

Pi's existing `read` tool accepts a resource-only batch. The owner and snapshot are fixed before
reading. A batch does not prepare a Skill graph, reread its main instructions,
or activate its workflow.

```ts
read({ paths: ["sr:R…", "sr:R…"] })
read({ paths: ["sr:R…"], budget: { timeBudgetMs: 120000 } })
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
The optional `budget` belongs only to `paths`; scalar and local reads reject it.

### Relative paths from a selected File

The scalar branch can resolve a relative link from its exact containing File:

```ts
read({ path: "../review/SKILL.md", from: "sr:S…" })
read({ path: "../../reference.md", from: "sr:R…" })
```

Copy `from` from the actual selected main or supporting file. It accepts a valid
`sr:S`, `sr:R`, or fixed canonical `skill://architect/path?library=team&snapshot=s_...`
File ref. An unfixed `sr:C` candidate is not a containing-file selection. The base
is the exact selected owner, manifest and path. An old path is not a rename hint.
`path` accepts a relative file path or a `skill://` reference; the latter binds an omitted
Library from `from`. Absolute paths, `~/`, queries or fragments on relative paths are rejected. `from` cannot be combined with `paths` or `refresh: true`.

The paired SDK resolves identity before Broker reads the target. A target mapped
to the containing owner stays in its fixed selection. A cross-Skill link requires
the containing file's Source revision and original path to map to one exact current
contribution. Nested documents use their own Source path before mounts or renames;
a coincidentally matching cache path cannot override that meaning. Missing or changed
Source authority, ambiguous mappings, and mappings unavailable offline fail explicitly;
neighboring cache directories never supply a fallback.
For a file without reliable Source context, use the target's exact stable ref.

After resolution, the target retains its own owner, scope and any existing session
pin. Resolving a link does not upgrade an already selected target to newer content.
The normal read route validates the target and returns its fixed ref and existing
read receipt. It remains inspection: no `notion_use`, Requires expansion, Members
change or remote write. Cancellation and branch changes still prevent stale results
from being delivered. Ordinary local filesystem reads keep Pi's native behavior.
The paired SDK must export `resolveReference`; a missing export reports
`SOURCE_SDK_INCOMPATIBLE` without a CLI or filesystem fallback.

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

A current catalog can omit a previously confirmed task dependency. Its exact
fixed reference remains readable only when the current branch retains both its
selected binding and confirmed delivery, the configured source is enabled, and
old and newly observed scopes agree. Every batch member must match the original
complete file manifest. This read neither republishes a current candidate nor
changes task roots or pins. Released, unconfirmed, foreign-branch and altered
references cannot reuse that proof. Missing original bytes remain a failure.

Authentication and exact owner authorization refusals still apply to loaded and
restored content. A physical-page refusal reaches all known bindings for that
page in the same source and scope; a stable-identity refusal stays on that
identity. A business `Enabled` change alone does not revoke intact confirmed
bytes. A directory query failure does not establish a physical-page refusal.

The paired SDK must advertise this capability. Missing capability fails before
dispatch; there is no custom command or old SDK route. OMP/Tern are deferred.
A pathless URI selects the entrypoint declared by its selected manifest. An exact
main path uses the existing main route. Resources require their exact manifest paths;
a former path cannot be repaired by a File ID. Public `file_id` parameters are rejected.
Native File IDs are checked through internal manifest bindings, while frozen Source
files retain their own route, byte count and hash without requiring a Notion File row.

One batch enters one source-runtime operation and one SDK `readResources` call.
It does not loop over `readSkill`, launch a CLI for every file, or invoke
`notion_use`. The bundled SDK advertises independent
`RESOURCE_READ_CONTRACT_VERSION = 1`. A package lacking the capability rejects
a batch explicitly.

### Consumption without remote writes

Pi `read` and `notion_use` do not expose a write-policy switch. Supplying the
retired `readOnly` key fails with `INVALID_ARGUMENT` before source or native I/O.
Broker enforces the internal no-write policy for every Notion consumption.
The SDK request omits the retired `readOnly` option. The batch still uses one
`readResources` operation. Before dispatch, Broker
requires both the SDK export
`RESOURCE_READ_EFFECTS_VERSION = 1` and the matching runtime manifest field
`resource_read_effects_version: 1`. Scalar effects support does not imply batch
support. A missing or mismatched capability fails before entering the SDK, with
zero source operations. The capable producer uses the existing semantic Notion
write guard for every descendant request, refusing a write before transport.

Every current batch exposes the producer's version-1 `effects` in model JSON and
details. Missing observations remain `unknown` and never prove zero writes.
Failed or cancelled reads retain observed effects without delivering partial
resources. Effects sit outside file-content spans and remain unchanged when a
provider copy deduplicates repeated text. A producer path that still requires
adoption or retention is refused. If a fixed selection is no longer available,
select the current candidate again. None of these operations prepares the main
body or replaces fixed identity checks.

## Budgets and failure

SDK defaults are 16 files, 1 MiB of selected source bytes, and a 30-second whole
operation deadline. Hard maxima are 64 files, 16 MiB, and 120 seconds. The file
budget is checked before runtime acquisition; selected bytes are checked after
manifest/identity admission and before object acquisition. Metadata requests can
therefore precede a byte-budget failure. Valid immutable cached chunks can remain
after an error, but the result is never partially ready.

Pi exposes only `budget: { timeBudgetMs }` as a per-call override for `paths`.
It accepts a positive integer up to 120000 and keeps the 16-file and 1 MiB byte
limits. A user-requested bounded wait can extend a later explicit call; the
Broker does not retry automatically or change subsequent calls' 30-second
default. One host deadline covers metadata lookup and acquisition, and the same
budget reaches the SDK. A returned budget mismatch is rejected before delivery.
Caller cancellation and session changes still take precedence over the wait.

The Broker separately checks the complete serialized model result against its
context-byte budget. JSON escapes and wrapper bytes count. No source text is
truncated to fit. A cancelled/expired operation, failed selected file, invalid
proof, or obsolete session generation cannot emit a successful batch delivery.

## Model content and machine evidence

The model receives canonical JSON with `status: "ready"`, ordered `files` and the
operation's `effects`:

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

Current source regressions cover fixed owner/snapshot/File identity, complete
text, binary bytes, budgets, cancellation and rejected mixed batches. The existing
independent package gate checks the installed SDK over controlled current Notion
HTTP, including scalar/batch resources and zero semantic writes.

Actual Pi checks follow the current SDK v3 driver and its
[consumption map](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-skills-integration/features/skill-consumption.md).
Use its currently declared scenarios rather than a retired scenario name. Compare
actual tool schema/results, complete provider-visible content, original binary
bytes and per-operation observations. A fixture, installed SDK or controlled Pi
result does not establish live service behavior, natural model choice, native UI
or normal installation. Keep those results and their package identities separate.
