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
| `default-view` | Default Context membership and Enabled eligibility changes remain metadata operations; no source body is fetched before use. |
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

## Maintenance

The [context verification map](../.agents/skills/verify-context-broker/features/context-once.md)
owns the invariants and routes. The [source review](context-once-source-review.md)
separates finite state models from byte, role and entity checks. The
[next worktree delivery contract](next-worktree-delivery.md) owns the paired
commits, build provenance and ordinary-process readback on Pro and Mini.

Report each result at its actual layer. A current controlled Pi pass is useful
evidence; it does not close natural-agent routing, real service timelines or
daily entry synchronization.
