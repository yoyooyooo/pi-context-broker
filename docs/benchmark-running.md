# Run the Benchmark bootstrap

Benchmark work lives on the lowercase `benchmark` integration branch. Shared
product and isolation changes still go to `next`. Develop in a task-owned
CLI/Broker pair, with the same ownership rules as
[isolated development](isolated-development.md). The source environment is not
the daily installation.

This first delivery provides the versioned protocol validator and a real-Pi,
no-model loading probe. It does not yet run business episodes, collect actual
model usage, score a comparison, or satisfy the full AH-1220 acceptance scope.
Use [the protocol contract](benchmark-protocol.md) for experiment identities,
registration and missing-data rules.

## Prepare the machine and pair

Use maintained Node, Pi and Bun. On a machine whose `pi` command is a shell
wrapper, read its selected JavaScript entry and pass that entry explicitly to
the existing launcher. An unrelated npm global installation can differ from
the ordinary `pi --version` command. Do not install a private old runtime to
make a check pass.

```sh
node scripts/paired-environment.mjs create --root /absolute/owned/benchmark-pair \
  --cli-ref benchmark --broker-ref benchmark \
  --pi-entry /absolute/maintained/pi/dist/bundle/cli.js
```

Edit only that pair. Build after adding the bootstrap files, then select the
returned build ID explicitly. The build includes the shared launcher, observer
and RPC child in its source inventory. The child runs from its run-owned source
copy; the observer comes from the frozen build.

```sh
node scripts/paired-environment.mjs build --root /absolute/owned/benchmark-pair \
  --id protocol-bootstrap-1
node benchmark/cli.mjs --help
node benchmark/cli.mjs validate --protocol /absolute/owned/registration.json \
  --stage phase0
node benchmark/cli.mjs validate --protocol /absolute/owned/registration.json \
  --stage execute
```

The execute-stage validator rejects a draft or incomplete policy. Validation
alone does not launch a model and does not authenticate external evidence.
The first three selected routes are examples in a configuration, not an enum
inside the runner. An unverified adapter cannot enter execution merely because
its route name is known.

## Observe an isolated real Pi

Select an owned public synthetic Skill tree, with no private oracle or answers.
One probe is one fresh `paired-environment` command run. The probe supplies only
its non-networking sentinel provider and common observer. It passes no model or
Notion credential variables and supplies no remote library.

```sh
node benchmark/cli.mjs phase0 \
  --root /absolute/owned/benchmark-pair --build protocol-bootstrap-1 \
  --mode broker --skills /absolute/owned/synthetic-skills \
  --condition candidate-broker --id broker-discovery-1
```

Repeat with `--mode native` to load the same complete tree through native Pi.
The caller always supplies `--skills`; the thin probe maps it to the existing
launcher's `--skills` or `--native-skills` according to the selected mode.

The probe waits for RPC initialization, verifies the actual source of its
registered `benchmark-inspect` command, and submits that local control command
with a fresh nonce. Pi handles it before the Agent/model path. A successful
receipt requires the matching snapshot, no extension error, no Agent start or
provider invocation, an empty business-message history, and graceful EOF with
exit zero. A `handled` acknowledgement by itself is insufficient.

The initial snapshot contains registered tools and schemas, active names,
commands, loaded Skill metadata, initial context, system prompt, selected model,
selected thinking level and relevant settings. The snapshot is taken after
resource discovery. The full copied corpus is also checked against its input
file inventory. Run, build and runtime observations retain their independent
identities.

## Freeze and compare the observed loading

The first probe returns `captured` and writes a **draft** `load-proposal.json`.
Review it against the intended candidate and selected build. It does not grant
a pass merely by observing itself. Freeze that reviewed proposal into a new
file, then supply it to an independent fresh run:

```sh
node benchmark/cli.mjs freeze-load \
  --file /absolute/owned/benchmark-pair/proofs/broker-discovery-1/load-proposal.json \
  --out /absolute/owned/benchmark-pair/control/broker-load.json
node benchmark/cli.mjs phase0 \
  --root /absolute/owned/benchmark-pair --build protocol-bootstrap-1 \
  --mode broker --skills /absolute/owned/synthetic-skills \
  --condition candidate-broker --id broker-verify-1 \
  --expected /absolute/owned/benchmark-pair/control/broker-load.json
```

Each candidate owns its own expectation. Different tool sets and prompts are
allowed between candidates. A changed build, tool schema, model selection,
catalog, context or selected corpus is rejected against the old expectation.
Known run and build path prefixes are replaced by explicit placeholders for
comparison; process IDs and the control nonce are not candidate identity.
Original unnormalized bytes remain available.

A matching result is limited to `phase0-registered-resources` and always has
`task_execution_enabled: false`. The CLI deliberately exposes no business-task
submission action. These loading expectations are distinct from the complete
environment manifest and do not replace the future paid-run admission gate.

## Evidence and remaining boundaries

The existing launcher owns `runs/RUN_ID/run.json` and `result.json`. The probe
does not edit them. Its child writes `runs/RUN_ID/benchmark/` with the raw RPC
frames, lifecycle, observer events, nonce-bound snapshot and probe receipt. The
outer check writes a new `proofs/` directory containing inputs, proposal,
comparison or failure, and hashes of native receipts and retained observations.
Existing IDs and outputs are never overwritten. Failed runs remain available.

The public extension/RPC API does not expose a complete census of extensions
that only register event handlers. Registered-resource provenance is observed;
the launcher's list is a declaration, not a complete observed census. Registered
tool definitions are not the final provider wire declaration, and current model
selection is not proof of the eventually routed backend or effective usage.
These limitations are recorded in the result. AH-1220 and AH-1221 must close
their required observation gaps before business episodes can be admitted.

This probe uses existing private state and process handling. It does not relax
the strict `next` daily gate, prove business success, validate real Notion
management effects, or count as a pilot episode. The first 24 real episodes
belong inside the bounded 144-episode pilot after corpus, collection and scoring
are ready. No scheduled paid runs are created.
