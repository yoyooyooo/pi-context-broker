# Study analysis across material panels

Use a study when one preregistered comparison needs several physical material
catalogs. Each panel retains its own frozen execution plan, environment manifests,
catalog, source material and original canonical analysis. The study estimates the
registered weighted mixture of those panel environments. It does not replace them
with an invented common environment fingerprint.

The entry is offline and has no provider, credential, configuration or dispatch
API:

```sh
node benchmark/analysis/study-cli.mjs design --request /absolute/design-request.json --out /absolute/study-design.json
node benchmark/analysis/study-cli.mjs bind --request /absolute/binding-request.json --out /absolute/study-plan.json
node benchmark/analysis/study-cli.mjs analyze --request /absolute/analysis-request.json --out /absolute/new-study-report
```

Outputs are exclusive. A changed design, source implementation or panel binding
needs a new identity. The study is an analysis contract, not an execution grant,
resource budget or unseen-material certificate. Existing standing authorization
and actual material-exposure records retain those responsibilities.

## Register before material disclosure and execution

Registration has two stages because future material hashes and physical library
IDs do not exist when sampling and analysis are chosen.

1. Freeze the design before generating or opening confirmation material. Declare
   every series, case, family, cluster, repeat, pairing seed, logical condition,
   panel allocation, global family weight, analysis cutoff and interaction.
   `design` reads this declaration only. It does not read panel contents or results.
2. Prepare the committed materials and run the existing zero-model configuration
   path to obtain exact panel plans. `bind` verifies those plans against the prior
   design and requires empty or absent panel dispatch ledgers and no active panel
   lease. An earlier invalid or zero-send attempt still prevents first binding.
3. Retain the binding record before dispatch. Run every panel under its existing
   execution contract. Afterward, retain its normal analysis and analysis input.
4. Run study analysis. Supply every panel, including an explicit empty canonical
   analysis for one with no observations. Omitting a panel is an error, not a way
   to reduce the denominator.

The command records the current registration time; its request cannot backdate
the design or binding. A timestamp and hash do not prove that an author never saw
material. Keep the generator, seed, prior-exposure inventory and material seal/open
receipts in the existing scientific workflow. `commitments` records their declared
hashes without opening those materials.

### Design request

The request has exactly `id`, `confidence`, `series` and `commitments`:

```js
{
  id: "first-current-calibration",
  confidence: 0.95,
  commitments: [
    {id: "generator", sha256: "<exact 64-digit hash>"},
    {id: "seed-commitment", sha256: "<exact 64-digit hash>"},
    {id: "prior-exposure-inventory", sha256: "<exact 64-digit hash>"}
  ],
  series: [nativeSeries, ownProductSeries]
}
```

Each series has these fields:

| Field | Meaning |
|---|---|
| `id`, `phase` | Stable series ID and `pilot`, `confirmation` or `regression` |
| `conditions` | Logical condition IDs, environment roles and exact fixed profiles |
| `comparisons` | Oriented `{candidate, reference}` pairs; each condition appears once |
| `cases` | Complete `{id, family, cluster_id}` roster, before material content is opened |
| `repetitions`, `ordering_seed` | Positive repeat count and the fixed pairing seed; repeat r uses seed+r |
| `family_weights` | Positive `{family, weight}` entries summing to one and covering all registered families |
| `analysis` | Exact horizon, success cutoffs, empty resource-bound object and explicit interactions |
| `primary_metrics` | The same metric family that every panel protocol registers |
| `panels` | `{id, case_ids}` entries partitioning the complete case roster |

A case cannot appear in two panels of the same series. Keep its repeats together
inside one panel. Separate material variants may share a `cluster_id` across
panels; that original cluster identity is retained. A shared cluster cannot change
family. Different series may use overlapping case rosters, but each actual
execution plan belongs to one panel and each physical run is counted once.

The condition shape is:

```js
{
  id: "gpt62-candidate",
  role: "candidate-broker",
  profile: studyConditionProfile(developmentProtocol, developmentConditionId)
}
```

`studyConditionProfile` is exported by `benchmark/analysis/study.mjs`. It reads a
supplied protocol value, not the filesystem. A reviewed development prototype is
a convenient source for profiles. Set the actual future model route/window and
other intended conditions before freezing the design; do not open confirmation
material to choose them.

The profile freezes the complete model declaration, product build identities,
maintained runtimes, loaded extension hashes, tools, active tools, return/error
contract hashes, consumer policy, resource mode, episode resource conditions and
observer/normalizer/scoring policy. One environment role must have the same fixed
profile across models. A series cannot mix bounded and unbounded episode policies.

Material-specific config, catalog, source, native-root, guidance and injection
hashes remain in each exact bound environment manifest. Extension paths may differ
while their IDs, roles and implementation hashes remain fixed. This permits
declared panel materialization; it does not make a later unregistered prompt or
product change acceptable. The binding records every original manifest and
catalog hash, and analysis checks the full frozen plan again.

For example, a four-model series can register six model interactions explicitly:

```js
analysis: {
  capped_time_horizon_ms: 180000,
  success_budgets: {
    time_ms: [45000, 90000, 180000],
    input_tokens: [75000, 150000, 300000]
  },
  resource_bounds: {},
  interactions: [
    {
      id: "model-0-1",
      kind: "model_environment",
      condition_ids: ["m0-candidate", "m0-reference", "m1-candidate", "m1-reference"]
    }
    // Register the other five declared model pairs here.
  ]
}
```

These cutoffs are measurements, not execution limits. Study v1 deliberately
registers no total-input or currency population bound. Complete data can support
point estimates, but those population intervals stay unavailable. A sample maximum
or an execution quota is not substituted for an independent population bound.
Capped time has its declared measurement range. Unsupported assessments and added
capabilities remain in separate analyses; v1 accepts complete paired common-business
cells only.

### Binding request

A file reference is `{path, sha256}` with an absolute original path and optional
`bytes`. The binding request names the design record and every exact panel plan:

```js
{
  design: {path: "/absolute/study-design.json", sha256: "<byte hash>"},
  panels: [
    {
      series_id: "native",
      panel_id: "panel-01",
      plan: {path: "/absolute/native-panel-01/plan.json", sha256: "<byte hash>"},
      condition_map: {
        "m0-e0": "m0-candidate", "m0-e1": "m0-reference",
        "m1-e0": "m1-candidate", "m1-e1": "m1-reference"
        // Every actual condition maps bijectively to its declared logical condition.
      }
    }
    // All other native and own-product panels are required.
  ]
}
```

Binding verifies the batch-plan hash, complete protocol schema and hash, dispatch
schedule, phase, condition profiles, case/family/cluster assignments, oriented
pair/repeat/seed denominator, horizon, cutoffs, resource-bound policy and explicit
interaction topology. A four-cell interaction also needs the actual matched
material, state, authorization, window, environment and pairing scope in every
panel. The aggregate view cannot hide a mismatch between model groups.

The planned denominator comes from `createAnalysisPlan(protocol)`, not from the
number of observed or dispatched rows. A declared continuation can have fewer
dispatch slots; both counts are retained and unresolved full-plan slots remain.

### Analysis request

Every panel supplies its original report's `analysis-input.json` and `analysis.json`:

```js
{
  plan: {path: "/absolute/study-plan.json", sha256: "<byte hash>"},
  panels: [
    {
      series_id: "native",
      panel_id: "panel-01",
      analysis_input: {path: "/absolute/panel-report/analysis-input.json", sha256: "<byte hash>"},
      analysis: {path: "/absolute/panel-report/analysis.json", sha256: "<byte hash>"}
    }
  ]
}
```

The reader verifies original file bytes, the bound design and source closure,
protocol identity, normalized episode fingerprints, raw artifact bytes and every
retained raw locator. `scoreExperiment` must exactly reproduce each supplied
canonical analysis. No old analysis file is changed.

The pure `scoreStudy({plan, panels})` API assumes that its caller has performed raw
file verification. Use the CLI or `readStudyAnalysisRequest` for retained files;
those always perform it. The pure API still checks plan identity, canonical
analysis equality, admission, fixed slots and physical run uniqueness.

## One scoring implementation and one claim ledger

`prepareAnalysisRecords` in `analysis/compare.mjs` performs the existing episode
admission, replacement ancestry and fixed-slot expansion. `summarizeAnalysisRecords`
performs the existing quality, resources, transitions, success curves and matched
four-cell calculations. `scoreExperiment` uses those same functions, preserving
its output. The study combines their records without editing any normalized
episode or pretending that a projected row is a new execution.

For a series, repeat values are averaged within each case. The case receives its
registered family weight divided by the number of registered cases in that family.
Cluster sums then use the original `cluster_id` across every panel. This differs
from averaging panel means or pooling episode counts. A material cannot acquire a
second independent cluster during aggregation.

The design creates its entire claim ledger before outcomes. It includes every
condition, paired difference/ratio, nine transition cells, success cutoff,
registered interaction and existing primary-family reserve. Unavailable cost or
usage claims remain in that ledger. Every local panel result and every series
aggregate shown in the study uses the same total count for Bonferroni allocation.
Ratio intervals retain the canonical split between their two bounded means.

The original panel analysis is retained under its original hash. Its local
intervals are not relabeled as joint intervals. The study recomputes panel
intervals with the global allocation and computes aggregate intervals from the
global case rows. It reports descriptive comparisons; it does not automatically
accept a product or select a cross-panel cost frontier. Critical contract failures
are still reported and rejected by the existing scoring logic.

The conservative v1 ledger also counts both a single-panel series result and its
local panel report, even if they happen to be identical. It does not deduplicate
claims after looking at data. For the provisional 400-episode coverage example,
three native panels plus one own-product panel and two aggregates, each with 170
registered claims, give **1,020 claims**. That example is not a frozen sample
size or authorization quota. Final coverage and precision still follow the pilot.

With fixed cluster weights w, the paired quality radius is
`sqrt(2 * log(2M / alpha) * sum(w * w))`. More repeats or catalog panels do not
create independent clusters. Wide intervals, unknown estimates, negative results
and failure to establish 3pp noninferiority are valid outputs.

## Missingness and actual accounting

Valid unknown outcomes receive zero verified-success credit while remaining
unknown. They do not become known business failures. Invalid-only and unexecuted
planned slots prevent complete fixed-denominator estimates. The output retains
their original panel/slot identities and known lower-bound information.

The study's cost ledger counts each actual run once, including invalid originals,
linked replacements, failures and rescues. Input and output retain partial known
subtotals; complete totals are only reported when all corresponding observations
are complete. Request, duration and monetary completeness are reported separately.
Currency subtotals retain their currencies and missing pricing is not interpreted
as zero cost. Scientific rates never use the cost ledger's run count as their
denominator.

## Offline package and dependency boundary

This is a private analysis package containing original records and raw evidence.
It is not a sanitized public release. Any public publication must apply the
existing release sanitizer and verification process to the intended contents.

The report contains the exact original records, raw artifacts keyed by hash,
`analysis.json`, a readable report, the frozen offline source closure, a file
manifest and `replay.mjs`:

```sh
node /absolute/study-report/replay.mjs --out /absolute/new-replayed-report
```

Replay verifies package hashes before loading its retained study implementation.
It resolves original record and raw references to packaged bytes, so the original
host paths need not exist. It then repeats raw verification and canonical scoring
and checks that the study analysis hash is identical. No package installation,
model credentials, provider endpoint or Notion access is needed.

`OFFLINE_STUDY_SOURCE_FILES` in `benchmark/offline-source-files.mjs` is the explicit
portable dependency inventory. It includes the study entry, canonical scorer,
statistics, protocol/schema inputs and evidence verifier. It excludes configure,
dispatch, standing-campaign, provider execution and credential-resolution code.
The design and binding records freeze the byte identity of this entire closure.
Changing it requires a new design before new confirmation exposure.

Tests run the actual protocol, normalizer, scorer and file interfaces with labeled
synthetic observations. They cover unequal family weights, shared clusters across
panels, repeated trials, missing and invalid-only slots, valid unknowns, partial
usage, linked replacements, model-state mismatch, claim allocation, tampered plans
and analyses, retained source bytes, raw locators and a complete network-disabled,
credential-free export/replay. They are not real model or business acceptance
results.

```sh
node --test benchmark/study.test.mjs benchmark/analysis.test.mjs benchmark/analysis.correction.test.mjs
```
