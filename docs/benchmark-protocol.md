# Benchmark protocol v1

This module implements the machine-checkable comparison contract for AH-1218.
It validates declarations before an episode runner may send a task. It does not
run models, authenticate evidence, score results or implement the complete
AH-1220 runner.

The method is maintained in [Skill consumption Benchmark](https://app.notion.com/p/4205636c236e814397c1cb417d8d3db3).
[AH-1218](https://linear.app/yoyooyooo/issue/AH-1218) owns the exact protocol;
AH-1219 owns the corpus, AH-1220 the execution gate, AH-1221 observations,
AH-1222 evidence records and AH-1223 analysis.

## Files and entry points

| File | Purpose |
| --- | --- |
| `benchmark/protocol.mjs` | Pure canonicalization, fingerprints, shape and semantic validation |
| `benchmark/schemas/protocol.schema.json` | Strict experiment document shape |
| `benchmark/schemas/environment-manifest.schema.json` | Candidate-owned build and launch identity |
| `benchmark/metrics.json` | Versioned formulas, denominators, evidence requirements and analysis identifiers |
| `benchmark/templates/preregistration.draft.json` | Editable draft with unresolved budgets and policy choices |
| `benchmark/templates/preregistration.mjs` | Deterministic generator for that draft |
| `benchmark/protocol.test.mjs` | Positive comparison examples and frozen negative examples |

Use the public commands in [Benchmark running](benchmark-running.md). For direct
integration, the module exports four synchronous functions:

```js
import {
  canonicalJson,
  fingerprint,
  validateProtocol,
  validateEnvironmentManifest,
} from './benchmark/protocol.mjs';

const result = validateProtocol(plan, { stage: 'phase0' });
// { valid: boolean, errors: [{ path, code, message }], fingerprint?: string }
```

Errors use JSON Pointer paths. An ordinary invalid document returns errors; it
does not throw. `canonicalJson` and `fingerprint` reject non-JSON values with a
`TypeError`. Validation does not mutate its input or perform file, network,
credential or subprocess operations.

The JSON Schema implementation is limited to the keywords used in the two
committed schemas. It is not an API for interpreting arbitrary user schemas.
Unknown fields are rejected at every defined object boundary. Model effective
parameters and tool parameter schemas remain candidate-owned JSON objects.

## Draft checks and executable registration

`stage: 'phase0'` checks structure, references, comparison fairness and any
supplied fingerprints. A draft can leave required future policy choices `null`.
This lets an offline plan check happen before expensive model execution. A
successful draft check is not a frozen registration or permission to send a
model task.

`stage: 'execute'` additionally requires:

- A frozen protocol with a matching content fingerprint and registration time.
- Frozen environment manifests, complete declared build/runtime/launch identities
  and condition references to their exact fingerprints.
- Explicit episode and batch budgets, global concurrency, reserved replacement
  count, absolute quality and unassisted-quality gates, interval/boundary and
  multiple-comparison policies, and observer/normalizer/scoring versions.
- A verified adapter declaration with its evidence hash for every configured
  model. An opaque backend alias is allowed only as an explicit unknown identity
  with a route and time window.
- Resolved acceptance thresholds for the selected primary ratio metrics and
  quality-difference gate when the decision mode is `acceptance`.

A `phase: 'phase0'` plan can never authorize paid task execution. The template
keeps budgets, gates and measurement verification unresolved deliberately. Its
placeholder materials and tool names are examples, not accepted corpus or
baseline identities. The synthetic numeric policies in unit tests exist only
to exercise validation; they are not a registered experiment budget.

Digests in the unfilled draft describe placeholder objects. They are not hashes
of observed Mini builds, real corpus files or adapter receipts. Replace those
inputs from the actual retained artifacts before producing a registration.

The pure validator verifies declaration consistency. A caller must also resolve
and inspect the claimed build receipts, source/package bytes, corpus, adapter
verification and actual loaded environment. A hash supplied by an author is
not evidence that the referenced bytes were observed. The execution gate must
compare these actual observations before sending the first task, and enforce
budgets, collection, completion and remote-effect reconciliation during the run.

## Stable identity and sealing

Canonicalization sorts object keys, preserves array order and uses JSON number
serialization. It rejects non-finite numbers, undefined values, sparse arrays,
symbol properties, non-plain objects and cycles. Protocol counters must be safe
integers. SHA-256 digests are lowercase hexadecimal without a prefix.

Each self-referential hash field is set to `null` while computing its digest:

```js
manifest.manifest_sha256 = fingerprint({ ...manifest, manifest_sha256: null });
condition.environment_sha256 = manifest.manifest_sha256;
plan.protocol_sha256 = fingerprint({ ...plan, protocol_sha256: null });
```

Set the intended status and all other fields before sealing. An environment edit
requires a new environment digest and condition references, followed by a new
protocol digest. A protocol edit changes its identity, even when the old label
is retained. Validation returns the expected digest so the caller can explain
an exact mismatch. It never repairs or silently reseals input.

Changing only an environment ID, paired-environment ID, build ID, commit label
or receipt hash does not qualify as a meaningful environment comparison when
source/package and runtime/launch behavior identities remain the same.
Likewise, changing only a model ID, family label or adapter receipt does not
qualify as another model condition. Model identity comparison uses provider,
route, API, effective parameters, observed backend and normalized time window.

## Environment manifest

Each environment binds its own complete declaration. There is no permanent
whitelist of Broker tool names or requirement that candidates have identical
tool sets.

| Group | Required identity |
| --- | --- |
| `build` | Paired environment ID, build ID, build-receipt hash, both full Git commits, both source fingerprints, CLI/SDK/Broker package digests |
| `runtime` | Maintained Node/Pi/Bun versions, selected entry paths and endpoint hashes |
| `pi` launch | Broker/native mode, Pi entry, config hash, extension IDs/paths/roles/hashes |
| `pi` interface | Complete tool declarations and active-tool names, candidate return-contract and error-contract hashes |
| `pi` context | Catalog, source bindings, native root when applicable, built-in guidance and injection hashes |
| `policies` | Cache condition, private episode sessions, recovery mode and Code Mode policy |

`pi.tools` describes all declared tools. `pi.active_tools` is a unique subset of
those names. Each extension has a `broker`, `observer` or `common` role. Broker
mode declares one identified Broker extension and no native root. Native mode
has no Broker extension and requires its explicit native root and native source
bindings. These declaration checks do not replace actual loading observation.

Return and error contracts belong to the candidate. Hash the actual contract
bytes or a documented canonical contract object. Do not copy today's output
shape into a permanent validator whitelist. Changes in either contract must
appear in `allowed_changes` as `return_contract` or `error_contract`.

Paths can be absolute or use the explicit `${RUN_ROOT}/...` and
`${BUILD_ROOT}/...` forms. The observer/loader normalizes only the known roots;
it must not erase unrelated path differences. The template does not install a
per-task toolchain. Runs continue to use the machine's maintained tools.

The manifest includes SHA-256 declarations rather than complete package
inventories. `paired-environment` remains responsible for frozen package/source
inventory checks, original `run.json`/`result.json`, and single-run runtime
endpoint observations. The Benchmark loader binds those original receipts and
checks actual loading; the protocol cannot certify them merely by accepting
correctly formatted hashes.

## Comparison purposes

| `purpose` | Fixed conditions | Allowed experiment |
| --- | --- | --- |
| `environment_iteration` | Model/effective settings, common tasks, material, initial state, authorization, budget | Declared build/tool/prompt/config/contract/policy changes |
| `native_calibration` | Same fixed business and model conditions | One Broker and one native environment; either can be A |
| `model_evolution` | Exact environment and common business/budget | Two actual conditions in the same declared model family |
| `model_crosssection` | Exact environment and common business/budget | Two actual model conditions with overlapping observation windows |
| `model_environment_interaction` | Common tasks/initial state/authorization/budget, same two environment identities | Exactly two models by two environments, with both matched within-model pairs |

Environment differences must be named in `allowed_changes`; unused permitted
changes are harmless, but an undeclared actual difference is rejected.
Model-only purposes declare only `model`. Code Mode is fixed unless explicitly
registered as a changing factor. The two model groups in an interaction keep
the same budget policy, initial state, authorization and Code Mode. Their
candidate/reference direction, case, repeat and seed must match.

Pair orientation describes comparison roles, not execution order. Reversing a
pair's role order on later repeats is rejected. Balance or randomize actual
execution through `policies.ordering` while keeping those roles stable.

A temporal alias comparison may express model evolution using different
registered observation windows even when the backend version is unknown.
That limits the conclusion to those route windows; it does not establish a
unique causal backend-version change. Contemporary cross-model and interaction
comparisons require overlapping windows.

Only explicitly declared pairs and capability assessments are scheduled by the
contract. Unselected corpus cases do not generate a full matrix. A condition
must nevertheless account for every case it explicitly selected. Repeated
condition/case/repeat triples are rejected.

## Corpus, support and unseen materials

The canonical corpus, public prompt, private business contract, initial state
and authorization hashes are distinct identities. A case also records family,
material, cluster, split and required business capabilities. Hashes refer to the
actual business material and contract, not an environment's tool instructions.
Representation-specific files can differ while their business content remains
mechanically equivalent; AH-1219 owns that equivalence proof.

Common capabilities retain a fixed paired denominator. A promised common case
cannot be omitted from one side, moved into an unpaired assessment or labelled
unsupported. Added and withdrawn capabilities use separate assessments whose
support agrees with the declared environment capability set. Unsupported
assessments record scope and do not schedule a fake failed model task.

A material ID cannot describe conflicting content, split or cluster. Tuning
requires a declared development budget, development material and disjoint
unseen confirmation material. Renaming material while retaining the same
business-content digest, or repeating the full content/task/contract/initial
state/authorization tuple, is rejected. Genuinely independent material may
share a method or cluster; sharing a cluster is not itself leakage.

Primary confirmation plans select confirmation material. Development and pilot
plans cannot consume the declared unseen confirmation pool. Stable regression
anchors can run in a separate registered regression batch. The validator does
not assert that a hash was never observed in another historical experiment;
material provenance and actual visible-file checks remain required.

## Budgets and stopping

Every executable budget states episode limits for duration, actual model
requests, input/output tokens, HTTP attempts and retries. It also states batch
limits for scheduled episodes, requests, tokens, elapsed time and concurrency.
An episode's outer time bound cannot exceed the launcher's one-hour maximum.
A batch bound cannot be smaller than its one-episode bound.

Global ordering specifies the method, seed, concurrency and selected condition
order. Reserved replacement episodes count toward the batch cap. Invalid
attempts and replacements remain in the ledger and link to their originals;
real HTTP retries count toward the episode's actual cost. No implicit fallback,
auxiliary model or paid periodic schedule is allowed.

The first pilot has a maximum of 144 scheduled episodes, including its first
24 route/collection checks, invalid attempts and replacements. Those constants
are ceiling and inclusion rules, not a mandate to launch the whole pilot.
No 720-episode confirmation batch is generated automatically. A later
confirmation plan explicitly fixes its own selected units and budget.

Mismatch stops before the task. Core evidence failures stop expansion. Budget
exhaustion stops and is recorded. Undeclared runtime drift invalidates the
attempt and stops the batch. Product failures remain measured results. A caller
must implement these actions; accepting their declarations is not proof that
it executed them.

When trustworthy prices are unavailable, use `monetary.policy: 'unpriced'` with
null money/price fields and bounded token/request/time budgets. `priced`
requires currency, a positive cap and the actual price-version hash. A zero-price
placeholder is not evidence of free usage.

## Metrics and evidence

`metrics.json` gives each metric a formula, unit, aggregation, evidence list,
missing-data behavior and a stable `metric:.../v1` analysis contract identifier.
These are analysis interface identifiers; the dictionary explicitly marks the
AH-1223 scoring implementation pending. No scores or confidence intervals are
computed by this protocol module.

Quality first averages repeats within cases, then cases within fixed families.
Family weights cover exactly the selected common-task families and sum to one.
Case/material clusters remain the independent sampling units. Turns, tool calls
and repeats do not become additional independent questions.

The dictionary preserves actual first-attempt input, peak input, all-attempt
input, known subtotals, unknown coverage, failure-inclusive cost, capped time,
unassisted quality, version transitions, budget quality and model/policy
interactions. Ratio metrics divide weighted means rather than averaging pair
ratios. Zero denominators, zero successes, missing usage and unverified prices
cannot turn into zero cost or automatic success. Ordinary degenerate bootstrap
cannot grant non-inferiority; a declared coverage-checked boundary method or an
explicit insufficient-evidence fallback is required.

Required evidence includes runtime identity, loaded manifest, visible materials,
actual model requests/usage, tool lineage, business readback, completion boundary
and interventions. Facts locate raw SHA-256 plus line/JSON pointer; inferred
interpretation remains labelled. Private oracle content stays outside the
Agent's visible source/workspace/request. `unknown`, confirmed `fail`, invalid
experiment and unsupported capability are distinct states. Reanalysis of the
same raw evidence never becomes a new successful model execution.

## Verification and current limits

Run the pure contract suite with the maintained runtime:

```sh
/absolute/maintained/node --test benchmark/protocol.test.mjs
```

The tests include every comparison purpose, future model/API configuration,
candidate-specific interfaces, draft/execute separation, content tampering,
wrong references/build identities, return/error contracts, fixed denominators,
independent confirmation materials and unsafe budget/policy declarations.
Frozen negative fixtures are resealed after deliberate changes so semantic
checks are tested independently of hash mismatch detection.

A passing protocol test or no-model loading probe is not a real-model Benchmark
result. Full corpus generation, multiround orchestration, cancellation and remote
reconciliation, real adapter/usage verification, evidence normalization,
statistical implementation, bounded pilot and independent confirmation remain
their respective work items. The daily `next` acceptance gates and product
content/history model are unchanged.
