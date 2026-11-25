# Evidence and offline Benchmark analysis

This layer records what was observed, scores the frozen batch, and reproduces
reports without a model. It does not admit a model route, launch episodes,
repair the subject, or replace the shared daily verification gate.

For a preregistered comparison split across physical material panels, see
[study analysis](benchmark-study-analysis.md). It reuses this scorer with global
family weights, original cluster identities and a frozen joint claim ledger.
Ordinary single-panel reports and engineering or route checks do not need it.

## Public entry points

| Module | Exports |
|---|---|
| `benchmark/evidence/normalize.mjs` | `normalizeEpisode`, `known`, `unknown`, `validateFact`, `validateRef`, `renderJourney` |
| `benchmark/evidence/store.mjs` | `verifyArtifactFiles`, `verifyBundle`, `writeEvidenceBundle`, `readEvidenceBundle`, `resolveEvidenceRef`, `buildEvidenceIndex`, `queryEvidenceIndex`, `inventoryLegacyEvidence` |
| `benchmark/analysis/compare.mjs` | `createAnalysisPlan`, `scoreExperiment`, `costFrontier`, `differenceInDifferences`, `selectRegression`, `releasePolicy` |
| `benchmark/analysis/statistics.mjs` | `clusterInterval`, `differenceInterval`, `ratioInterval`, `weightedMean`, `weightedQuantile` |
| `benchmark/analysis/metrics.mjs` | `METRIC_ENTRIES`, `evaluateMetric` |
| `benchmark/analysis/report.mjs` | `reportTables`, `renderAnalysisMarkdown`, `renderMetricSvg`, `writeAnalysisReport` |

Analysis/scoring implementation 1.1.0 corrects the formulas and interval outputs below.
The metric definitions remain version 1.0.0; an analysis repair does not create
a model observation or change a frozen protocol.

All 18 logical `analysis_entry` identifiers in the metric dictionary resolve
through `METRIC_ENTRIES` and `evaluateMetric`. Condition metrics require a
`condition_id`; paired metrics require the oriented `candidate` and
`reference`; interaction and frontier metrics use the experiment scope. The
primary condition quality result keeps `estimate` and `interval` in ratio units,
with `unit: ratio`. `score_percent` contains the corresponding percentage
estimate and interval, including a scaled radius. The logical
`metric:quality.verified/v1` entry returns that percentage object and an explicit
`quality_ratio` companion. Implementation 1.1.0 thereby repairs the old entry
returning a ratio despite its declared percentage contract; it does not change
the dictionary formula or the ratio-valued acceptance thresholds. Reports use
the primary ratio once for percentage display. Callers must not multiply the
logical percentage result or `score_percent` by 100 again.

```js
const bundle = normalizeEpisode(normalizationInput);
await writeEvidenceBundle({
  directory: runRoot + '/benchmark/normalized',
  bundle,
  rawRoot: ownedEnvironmentRoot,
});

const index = buildEvidenceIndex(episodes);
const failures = queryEvidenceIndex(index, {
  condition_id: 'candidate-broker',
  outcome: ['fail', 'unknown'],
});

const plan = createAnalysisPlan(protocol);
const input = { protocol, episodes, plan };
const analysis = scoreExperiment(input);
const quality = evaluateMetric('metric:quality.verified/v1', {
  analysis,
  condition_id: 'candidate-broker',
});
await writeAnalysisReport({
  directory: reportRoot,
  analysis,
  input,
  includeRaw: true,
  rawRoot: ownedEnvironmentRoot,
});
```

The example names are placeholders. The fixtures under
`benchmark/analysis/fixtures.mjs` are explicitly synthetic unit observations.
They must never enter a model-result batch.

## Normalization input version 1

`normalizeEpisode({ identity, admission, attempts, tools, business, contracts,
interventions, timing, artifacts })` returns `{ episode, events, journey }`.
It preserves raw attempt and tool fields. The normalizer is deterministic;
timestamps come from observations rather than the normalization clock.

### Raw references and facts

Each artifact is `{ id, path, sha256, bytes?, kind? }`. The raw bytes are
retained separately. A reference has exactly one locator:

```js
{ artifact_id: 'sdk-events', sha256: actualFileHash, line: 17 }
{ artifact_id: 'readback', sha256: actualFileHash, pointer: '/artifact/rows/0' }
```

Lines are one-based. JSON pointers follow RFC 6901, including an empty pointer
for the document root. A known fact is:

```js
{
  status: 'known',
  value: actualValue,
  precision: 'observed', // or reported, derived, estimated
  refs: [rawRef],
}
```

A derived fact also requires a versioned `formula`. Unknown is
`{ status: 'unknown', reason, refs: [] }`; it is never encoded as zero.
Known facts require references whose hashes match the artifact registry.
`verifyBundle` reads the actual bytes, verifies hashes and sizes, and resolves
every retained line or pointer. Pure normalization validates the registry
relationship; it does not itself authenticate files on disk.

Estimated tokenizer quantities remain distinct from exact provider usage.
Normalization accepts them as observations but excludes them from complete
exact input/output accounting.

### Identity, admission and actual operations

Identity requires `episode_id`, `run_id`, `experiment_id`,
`condition_id`, `case_id` and a nonnegative `repeat`. Include environment,
model, corpus, material, cluster, pair, route, build, budget, seed and split
identities when available. A replacement has `retest_of` pointing to its
retained invalid predecessor.

Admission is `{ status: 'valid' | 'invalid', reasons, refs, completeness }`.
Its refs must point to raw admission/coverage observations. The three
completeness keys are `attempts`, `tools`, and `interventions`, each
`complete`, `partial` or `unavailable`. Empty lists imply zero only when
their observation coverage is complete. An optional `http_attempts` numeric
fact records all transport HTTP attempts separately from model sends.

Each attempt is:

```js
{
  id: actualAttemptId,
  request_id: logicalRequestId,
  seq: observedSequence,
  sent: true, // false: observed not sent; null: unknown
  refs: [rawTransportRef],
  adapter: {
    id: adapterId,
    version: adapterVersion,
    verified: true,
    evidence_sha256: verifiedAdapterEvidenceHash,
    input_semantics: 'includes_cache',
    output_semantics: 'includes_reasoning',
  },
  usage: {
    input: inputFact,
    output: outputFact,
    cache_read: cacheReadFact,
    cache_write: cacheWriteFact,
    reasoning: reasoningFact,
  },
}
```

For an adapter whose input excludes cache reads/writes, use
`input_semantics: 'excludes_cache_read_write'`; full input sums those three
disjoint components. `output_semantics: 'excludes_reasoning'` likewise sums
output and reasoning. A verified adapter requires an identity, version and
verification-evidence hash. Admission is responsible for establishing that
verification against the selected route; setting a boolean is not a route
verification procedure.

Every actual send gets its own attempt ID, including identical bodies and
failed sends. Several attempts can share a logical request ID. Input first
uses the actual first send and cannot substitute a later known value.
Missing sends or usage make the full sum/peak unknown. Verified known
components remain in `known_subtotal`, including partial cache components.

An optional currency cost is a fact whose value is
`{ amount, currency }`; a known cost additionally requires
`pricing_verified: true`. Unpriced routes remain unknown. Zero configured
price placeholders do not establish zero economic cost.

Tool records retain `id`, `parent_id` (null for top-level),
`name`, original `args`, `status`, and refs. Nested calls must reference
retained parents and form an acyclic graph. Optional
`logical_operation_id` supports a distinct logical-operation count.
`interface_misuse` is a separately observed boolean classification.
Unknown classification does not become a confirmed zero-misuse episode.

### Business outcome, contracts, interventions and time

Business is `{ status, capability_status, capability_scope, refs }`.
Status is pass/fail/unknown/not_applicable; capability is
supported/unsupported/unknown; scope is common/extension. Each contract has
`{ id, status, critical, refs, reason? }`. Confirmed pass/fail needs raw
readback refs. A verified success requires business pass, supported
capability and every applicable contract pass. Any confirmed applicable
failure makes the joint result fail; unresolved evidence remains unknown.
Unsupported capability stays separate from model failure.

Intervention records are `{ id, kind, refs }`, with kinds human_rescue,
evaluation_rescue, task_clarification or product_recovery. Only the first
two count as extra rescue. A verified success with incomplete observation
of interventions cannot receive verified unassisted credit.

Timing contains numeric facts `duration_ms` and
`time_to_success_ms`. The second must refer to the verified completion
boundary, not merely an early tool return or model assertion.

## Frozen plan and denominator

The default plan expands the protocol's pairs and assessments into slots.
An explicit plan must equal `createAnalysisPlan(protocol)` in full. It cannot
drop an unresolved slot, change support or seed, add a cluster override, or
promote pilot/regression observations to independent confirmation. The derived
shape is:

```js
{
  schema_version: 1,
  id: frozenBatchId,
  protocol_sha256: protocol.protocol_sha256,
  slots: [{
    id: slotId,
    condition_id: conditionId,
    case_id: caseId,
    repeat: 0,
    seed: 0,
    pair_id: pairId,
    expected_support: 'supported',
  }],
  confirmation: false,
  resource_bounds: {},
}
```

Optional inference policies belong in `protocol.policies.analysis` before
registration. They participate in the protocol fingerprint and execute-stage
validation. With the configure entry point, set the optional `setup.analysis`
object before registration; configure passes it to `preregisterComparison`,
which clones it into `protocol.policies.analysis`. For a directly constructed
protocol draft, the equivalent is:

```js
draftProtocol.policies.analysis = {
  resource_bounds: {
    input_total: {
      upper: 50000,
      verified: true,
      evidence_sha256: independentlyVerifiedBoundReceiptSha256,
    },
    currency_cost: {
      upper: 2.5,
      currency: 'USD',
      verified: true,
      evidence_sha256: independentlyVerifiedCurrencyBoundReceiptSha256,
    },
  },
  success_budgets: {
    time_ms: [0, 15000, 30000, 60000],
    input_tokens: [0, 10000, 25000, 50000],
  },
  interactions: [],
};
```

Budget cutoffs are strictly increasing nonnegative integers. Input bounds need
a positive safe integer and the SHA256 of their independent verification
evidence. Optional `currency_cost` bounds require a positive finite `upper`,
an explicit `currency`, `verified: true` and an independent evidence SHA256.
The currency must match every cost observation used for inference. No budget
or observed sample maximum substitutes for that population bound. Interaction
entries bind four distinct declared conditions, their
oriented protocol pairs and, for Code Mode, both environment pairs. Unknown
fields and unsupported shapes are rejected. `createAnalysisPlan` copies these
validated policies from the protocol; changing the returned plan is not a
registration mechanism. Protocols without this optional field retain the
existing defaults. Adding or changing a policy requires a new frozen protocol
identity, with its ordinary material and confirmation checks.

Only this batch's slots belong in the denominator. Future confirmation plans
do not belong in a completed pilot's denominator. Per slot, at most one
valid execution can be selected. All replacements must link to a retained
invalid predecessor in that same slot. Another valid retest needs a newly
declared repeat or candidate; it cannot replace an inconvenient valid result.

The output reports valid business S/F/U and N separately from planned units,
invalid runs and unsupported capability. A valid unknown result receives no
verified-success credit but is not a confirmed failure. If a planned unit
has no valid result, complete quality/interval inference is unavailable.
A separate planned-success lower bound shows progress without converting
invalid runs into business failures. Never drop a missing family or
renormalize its weight: each condition's common planned families must match
the frozen family-weight table.

Reanalysis deduplicates the same episode and rejects conflicting views.
It never adds a model execution, independent material or cost. Indexes and
reports retain raw hashes and actual-run IDs. Write a repaired analysis to a
new directory and retain a `reanalysis_of` receipt identifying the prior report,
its analysis hash and the unchanged normalized episode hashes. Historical
public packages continue replaying with their included implementation; do not
replace their source or results when publishing a repair.

## Metrics and inference

Repeat scores are averaged within case. Cases are averaged within family,
then fixed family weights are applied. Clusters collect dependent cases or
materials before outcome inspection. Repeating or copying a cluster does not
create more independent units.

The required registered methods are:

- `weighted-cluster-hoeffding-v1`
- `hoeffding-no-degenerate-bootstrap-v1`
- `bonferroni-primary-family-v1`

For fixed cluster weights \(w_k\), a bounded variable of range width \(R\)
has conservative two-sided radius
\(R\sqrt{\log(2/\alpha)\sum_k w_k^2/2}\).
Quality uses range [0, 1]; paired quality differences use [-1, 1].
The implementation records an outcome-independent claim ledger before
examining observations. It includes condition quality, unassisted quality,
capped time and currency cost; every condition budget point; paired quality
and resource ratios; all nine transition cells; shared paired budget points;
and all three dimensions of every planned or protocol-derived interaction.
The Bonferroni count is at least the registered primary-family count. Missing
or unfavorable observations do not remove claims from that count. Each ratio
divides its allocation between its two bounded means. Cluster independence
and pre-outcome fixed weights are explicit assumptions; within-cluster
dependence is unrestricted. Automatically enumerated interactions remain
exploratory even when the protocol phase is confirmation.

This is a conservative concentration bound, not a bootstrap interval.
It remains nonzero for all-success or all-tie small samples. Small cluster
sets may be unable to establish a 3pp noninferiority threshold regardless
of how often the same materials are repeated. Exact Bernoulli enumeration
at small sample sizes tests the boundary implementation.

Source: Hoeffding, W. (1963), *Probability Inequalities for Sums of Bounded
Random Variables*, Theorem 2, JASA 58(301), 13–30.
[Original paper](https://www.cs.rpi.edu/academics/courses/spring06/random/hoefding.pdf).

Cumulative input includes every actual attempt, including retries and failed
episodes. Ratios use ratios of fixed-weight means. Zero reference means
produce an undefined ratio and an absolute difference. Input-ratio interval
inference additionally needs a predeclared independently verified upper
bound in `protocol.policies.analysis.resource_bounds.input_total`, with
`upper`, `verified: true` and `evidence_sha256` recorded before freezing.
An observed maximum or a nominal budget that can be overshot does not prove
a distribution bound. Without that bound, point estimates remain useful
but input noninferiority remains inconclusive.

Capped time is successful completion time up to the frozen cap; failure and
unknown use the cap. Raw elapsed time remains separate. Population p95
success time is `not_reached` when fewer than 95% of the fixed denominator
succeed by that cap. Cost per success divides the sum of actual costs across
all observed valid episodes, including failures and retries, by the number of
verified successes. This is distinct from the ratio of family-weighted means.
Its output identifies valid, planned and unresolved episode counts; invalid
execution costs remain in the separate ledger. Zero successes yield
`not_reached`; missing cost or mixed currencies prevent a complete monetary
ratio. The separately named `currency_cost` is the fixed-weight mean used by
the tested cost frontier.

Success-by-budget curves keep case values, repeat counts, cluster intervals
and identification bounds at every cutoff. Paired curves first subtract the
two observations at the same case/repeat unit, then average repeats and apply
the fixed weights. Valid unknown outcomes receive no verified credit but
remain distinct from confirmed failure. Missing slots or a successful episode
with unknown usage prevent a complete interval; identification bounds preserve
the known contribution. These curves do not claim the subject would behave
identically under another enforced budget policy. Interface misuse uses an
episode denominator. Adding harmless tools cannot dilute a misuse event.

All nine pass/fail/unknown migration cells retain case/cluster intervals.
For compatibility, descriptive `count` and `weight` assign unresolved sides to
unknown and retain the full planned matrix. `observed_count`,
`unresolved_assigned_count` and the paired-unit list distinguish that assignment
from an actual valid unknown outcome. Missing pairs make sampling intervals
unavailable; separate identification bounds show possible transition mass.

Model-environment
interactions require four observed cells with matching environment pairs,
tasks, material/state/authorization, budgets, adoption mode and declared
windows. They are differences of within-model environment differences.
Code Mode interactions additionally require a frozen `protocol.policies.analysis.interactions`
entry with kind `code_mode`, four oriented `condition_ids` and
`environment_pairs`; one model and two matched Code Mode policies are
required. Missing or incomparable cells return unavailable. A four-cell
point estimate does not imply general model ability or causality.

Each interaction separately reports `metrics.quality`, `metrics.time` and
`metrics.cost`. The first two use verified quality and capped time. All four
cells must share supported case/repeat units and pairing seeds. The interval
applies to the within-unit four-cell contrast before case/cluster aggregation.
Cost requires complete same-currency observations for a point estimate and the
registered currency bound for an interval. Missing, mismatched or exceeded
bounds leave that interval unavailable. The top-level interaction estimate and
interval remain quality aliases for existing consumers.

Absolute quality, unassisted quality and paired quality gates precede
efficiency. Any confirmed critical-contract failure rejects the candidate.
An interval overlapping a threshold is inconclusive. Tested cost frontiers
implement the minimum complete fixed-weight mean cost among tested
model/policy configurations whose quality lower bound meets the requirement.
Groups have the same environment version, task/material/weight scope, supported
slot denominator and currency. This is a minimum-cost level, not a Pareto set
and not cost per success; exact ties remain visible. No eligible configuration
yields `not_reached`, never zero. Unknown cost is excluded with a reason.
Selecting a winner on a report marked confirmation still does not independently
confirm that selection; its state remains `requires_independent_confirmation`.

## Stored evidence and reproducible reports

The launcher owns run-root `run.json` and `result.json`. This layer writes
only caller-selected Benchmark namespaces. Writes are immutable and
idempotent: repeating the same content succeeds; differing existing content
is refused. Raw evidence is never overwritten.

A report package includes JSON analysis/input, exact CSV tables, standalone
SVG charts, the required versioned source modules and, by default, raw files
addressed by SHA256. It needs no package installation or network access:

```sh
node /absolute/report/replay.mjs --out /absolute/new-report
```

Replay verifies package members, raw hashes and locators, then recomputes
the analysis. It reports `model_requests: 0`. An omitted-raw report cannot
claim full raw replay. Keep private raw packages distinct from sanitized
public reports; raw paths, private readbacks and credentials must not be
published merely because their hashes are safe to share.

`inventoryLegacyEvidence` only inventories actual files, hashes,
parseability, truncation and required field pointers. If historical AH-1196
45/45 raw files are unavailable, record unavailable. That functional report
cannot become new comparative model samples.

`selectRegression` chooses declared anchors and impacted families or
capabilities within a case cap, preferring distinct clusters. It emits no
noninferiority proof. `releasePolicy` reports whether evidence is reviewable,
incomplete, blocked or inconclusive; the existing daily gate remains
separate and manual release review remains explicit.
