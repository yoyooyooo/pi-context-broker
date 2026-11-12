# Current-context candidate

This candidate keeps complete same-version Notion instructions, generated
directories and requested resources once in the effective outgoing request.
Explicit repeated operations still run and retain their own effects. Original
session entries, author text, images and tool call identities are not rewritten
to manufacture a smaller history.

## Scope

The installed gates use Pi 1.5.0, Node 24.20.0 and the pinned CLI/SDK input in
`.github/workflows/ci.yml`. Pi 1.4 compatibility remains a separate gate. A wire
receipt covers normal OpenAI-completions JSON tool schemas over Node Undici;
strict/grammar conversion, other APIs and other transports are not silently
classified as equivalent proof. Logical acceptance, completed turns and native
projection persistence remain separate facts.

`/context-broker request` displays at most 32 recent in-memory request summaries.
It retains hashes, counts, fixed pins, source reuse state and operation effects,
not private source bodies, locators, credentials or whole request payloads. It is
not a model tool. A known entity mismatch prevents new delivery confirmation,
even when the request has already been sent.

## Reproduce without production credentials

Use the CLI checkout at the exact revision declared by CI. From that checkout,
build the CLI/SDK and create the existing offline catalog fixture:

```sh
bun install --frozen-lockfile
bun run build
node scripts/sdk-fixture.ts --outdir "$FIXTURE_ROOT" --catalog
```

From this repository, build and pack with that explicit input, then install the
archive in a fresh owned npm consumer. Do not substitute a source checkout for
the installed package:

```sh
export NTN_SKILLS_BUILD_ENTRY="$CLI_ROOT/packages/cli/dist/ntn-skills.js"
bun install --frozen-lockfile
bun run build:broker
bun scripts/pack.mjs --target broker --out-dir "$ARCHIVE_ROOT"
```

Set `BROKER` to the resulting consumer's installed `pi-context-broker` directory,
`FIXTURE` to the generated `fixture.json`, and `OUT` to a new owned evidence root.

```sh
node scripts/notion-sdk-pi.mjs doctor --package "$BROKER" --fixture "$FIXTURE"
node scripts/notion-sdk-pi.mjs run --package "$BROKER" --fixture "$FIXTURE" --scenario all --out "$OUT/all14"
node scripts/notion-sdk-pi.mjs run --package "$BROKER" --fixture "$FIXTURE" --scenario context-once --provider-backend in-process --out "$OUT/fast"
node scripts/notion-sdk-pi.mjs run --package "$BROKER" --fixture "$FIXTURE" --scenario context-once --provider-backend http --out "$OUT/http"
node scripts/notion-sdk-pi.mjs run --package "$BROKER" --fixture "$FIXTURE" --scenario context-wire-negative --provider-backend http --out "$OUT/negative"
node scripts/notion-sdk-pi.mjs run --package "$BROKER" --fixture "$FIXTURE" --scenario session-compaction --out "$OUT/compaction"
```

The two context-once backends share the public list/use/read/repeat/cancel
scenario. Only the HTTP backend proves actual normal serializer traffic. The
negative gate injects duplicate, missing, schema-rewritten and restored-user-role
failures. These must fail delivery while the gate itself passes by observing the
specified rejection. A successful mock answer or process exit alone is not
acceptance.

Use the existing `evidence`, `cleanup`, then `evidence` actions for each retained
run. Cleanup requires a fully ended owned process and moves only its scratch to
the verified system Trash. It never deletes evidence. The actual service and
real-model paths require separate authorization and frozen source identities;
the offline commands do not establish either.

## Maintenance and limits

The [context-once verification map](../.agents/skills/verify-context-broker/features/context-once.md)
owns exact invariants and CI routing. The [source review](context-once-source-review.md)
separates finite models from byte/role/entity checks. The original failed
independent review and its successful F1 repair review remain distinct evidence.

This is a reviewable candidate, not an automatic npm release or global daily
installation change. Different Skills can still accumulate in a long session;
aggregate active-workset budgets and explicit release are tracked separately.
