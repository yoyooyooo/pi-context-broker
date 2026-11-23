# Recovering a collection failure without another model request

A subject can finish and retain complete raw observations while the controller fails to collect them. One example is a frozen case that references a verified material library in another paired environment. The collector requires every registered evidence file to be owned by the current environment. A direct cross-environment reference therefore fails even when its content hash is correct.

A failed collection remains an unresolved execution until its retained observations are collected and verified. It is not a free run, a missing unreserved slot, or permission to resend the task.

## Material ownership

`material-ownership.mjs` prepares a local projection of the frozen material binding. It retains the original parity proof and every referenced leaf file, verifies their original hashes, and writes a separate derived proof whose declared path fields point to owned copies. The derived proof has its own hash. Its original-to-projected mapping records every path change.

Only the materialization proof, native skill root and skill inventory paths are projected. Public prompts, private oracles, public inputs, material contents, matching facts, model selection and budgets retain their original identity. Native files preserve their relative position below the skill root so the collector can still map observed reads to the actual subject copy.

The collector's ordinary owned-path check stays in force. Its code, static imports, normalizer and scorer do not change for this repair. New configurations prepare and verify material ownership before startup capture, retain the original bindings and record the projection references in the configuration proof. Cases sharing the same material use one immutable projection.

## Explicit recovery registration

A recovery registration records one original frozen plan, the closed failure-ledger prefix, its unresolved physical run, complete retained raw evidence, the original controller sources, the exact repaired controller sources and the owned material projections. Registration performs no model or Notion operation.

The repaired controller must preserve the subject execution and collection instrumentation. Source changes are restricted to the recovery mechanism and its controller/CLI wiring. A registration cannot change the protocol, case order, route window, model parameters, workload, request limits, campaign cap or historical unknown-usage checkpoint. It cannot be combined with an analysis revision or a historical zero-send resumption.

This recovery is for the bounded single-turn collection failure it proves. It does not turn arbitrary interrupted, usage-unknown, mutated or incomplete runs into accepted evidence.

```sh
node benchmark/cli.mjs register-collection-recovery \
  --plan /absolute/control/plan.json \
  --frozen-controller /absolute/original-build/source/broker/benchmark/cli.mjs \
  --reason 'Explain the verified material-ownership failure and unchanged execution boundary'
```

The command writes the exclusive `collection-repair-registration.json` inside the plan's control directory. Keep that reference and its file hash with the operator receipt. The original plan, bindings, failure ledger records and raw observations remain unchanged.

## Recover the retained run first

Use the reviewed repaired controller and the explicit registered reference:

```sh
node benchmark/cli.mjs run \
  --plan /absolute/control/plan.json \
  --collection-recovery /absolute/control/collection-repair-registration.json \
  --limit 0
```

The existing batch loop reconciles an already started run before considering any new slot. A zero new-slot limit therefore collects the original physical execution without a new reservation or task submission. Recovery uses a new collection output directory and retains the failed partial output. The completed ledger record names the recovery reference.

Before continuing, independently verify that the original raw hashes and campaign reservation count are unchanged, the unresolved run has one completion, `new_episodes` is zero, and core evidence and all budget-usage dimensions are complete. A failed check stops the continuation. Business failures remain observations; they are not replaced by successful reruns.

## Continue the original bounded plan

Later run commands must explicitly name the same recovery registration. The controller rechecks it before each dispatch and collection. Only collection receives the owned binding projection. `runSubject` continues to receive the original frozen execution binding and startup expectation.

All existing campaign leases, per-reservation scope checks, route windows, counters and stop conditions still apply. A newly incomplete or unknown run stops the campaign under the original rules. The repair grants no additional slots, retries or budget.

Reports and publication must retain the recovery reference and describe the storage correction. The original failed collection and subsequent zero-send recovery are two controller events for one physical run, not two samples.
