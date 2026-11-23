# Benchmark corpus and private grading

The synthetic corpus provides 20 logical journeys, two independent materials per journey, and 40 base cases. It supplies complete business inputs, Skill bodies, references, scripts, assets, and declarative private contracts. It does not supply model performance results.

The generator and grader are controller code. Exclude benchmark/corpus, corpus tests, private controls, prior answers, and reports from the Agent's copied command source. A subject receives the selected natural user turns and the files written by materializeLocal, or the equivalent files exposed through a real public product interface.

## Coverage and independence

| Family | Journeys | Base cases | Business work |
| --- | ---: | ---: | --- |
| no-skill | 3 | 6 | Supplied invoice arithmetic, supplied status counts, honest handling of an unavailable company policy |
| explicit | 2 | 4 | Named refund policy and release checklist |
| implicit | 3 | 6 | Shipping routes, stock replenishment, customer consolidation |
| ambiguity | 2 | 4 | Missing delivery mode and target currency |
| equivalent | 1 | 2 | Either of two equivalent per-line tax rules |
| references | 2 | 4 | Nested grant eligibility and return exceptions |
| scripts-assets | 2 | 4 | CSV normalization with a binary import marker, and a weight-band tariff calculator |
| complementary | 2 | 4 | Reconciliation followed by removal of personal fields; routing followed by a dispatch brief |
| continuation | 2 | 4 | Another batch under the same policy; a real policy revision before the next batch |
| task-switch | 1 | 2 | Inventory work followed by unrelated expense grouping |
| **Total** | **20** | **40** | |

Each case has a material ID, seed, material version, split, license, and content hashes. The two materials use separate deterministic seed namespaces and distinct inputs. Both materials of a journey retain the same cluster ID because they share a rule template. Repeats and turns do not become independent cases.

The corpus declares CC0-1.0 for its synthetic materials. Customer names, organizations, transactions, and email addresses are synthetic. No live business data or current financial rates are used.

Use distinct root seeds for development, pilot, and confirmation. Split is part of the seed derivation, so even the same root seed across two splits produces different material. Public generation is reproducible; private canaries use a fresh random identity and belong only in the retained control document.

The fixed family weights are 0.1 each. Consumers must not weight a family by its number of assertions, files, turns, or repeats.

## Files and exports

The public entry point is benchmark/corpus/index.mjs.

| Export | Purpose |
| --- | --- |
| buildCorpus | Generate separate publicCorpus and control values |
| validateCorpus | Check file integrity, case identities, and public/control consistency |
| planCaseVariant | Select a case, candidate count, and round count |
| materializeLocal | Write only public initial-version files and business inputs |
| writeCorpus | Save public and private documents to disjoint roots |
| buildFixtureRecipe | Produce a recipe for the existing real product fixture helper |
| bindPublicCaseToFixture | Resolve public invocation names after fixture creation |
| verifyMaterialization | Compare retained actual file observations against canonical material |
| sealCorpus / openCorpus | Record confirmation sealing and registered opening |
| auditVisibleMaterial | Inventory visible files and detect private paths or canaries |
| gradeEpisode | Apply a private declarative oracle to neutral evidence |

The main data structures are:

    {
      publicCorpus: {
        schema_version, id, version, split, seed, license, provenance,
        families, capabilities, distractor_skill_ids, skills, cases,
        content_sha256
      },
      control: {
        schema_version, corpus_id, public_sha256,
        cases: [{ case_id, target_skill_ids, oracles, events, clarification }],
        canaries, seal
      }
    }

Public cases contain natural turns, attachment files, the entire selected catalog, completion paths, authorization scope, identities, and opaque contract hashes. They do not contain expected business values, target Skill labels, legal candidate sets, or private clarification responses.

A Skill has a stable logical ID, public name, description, dependencies, an initial version, and complete versioned files. Every file records path, content, encoding, executable mode, byte count, and SHA-256. Binary data uses canonical base64. Empty files and CRLF inputs are retained. Version two is controller material until a declared publication event completes.

Do not copy corpus.json into the subject workspace. It is an orchestration document that includes other cases and future public versions. materializeLocal projects only one selected case and the initial versions that it may consume.

## Minimal local flow

Use explicit absolute output roots outside the repository. Replace the example roots with task-owned directories.

    import {
      buildCorpus, writeCorpus, planCaseVariant, materializeLocal, gradeEpisode
    } from './benchmark/corpus/index.mjs';

    const corpus = buildCorpus({
      seed: 'benchmark-development-20261122',
      split: 'development',
      materialVersion: '2'
    });

    await writeCorpus({
      corpus,
      publicRoot: '/absolute/task/corpus-public',
      controlRoot: '/absolute/task/control/corpus-private'
    });

    const selected = planCaseVariant({
      ...corpus,
      caseId: 'scripts-assets-01-a',
      candidateCount: 16
    });

    const local = await materializeLocal({
      publicCorpus: corpus.publicCorpus,
      targetRoot: '/absolute/task/episodes/example/subject',
      caseId: selected.publicCase.id
    });

    // Feed selected.publicCase.turns as ordinary user turns.
    // Keep selected.oracle, events, and clarification in the parent controller.
    const verdict = gradeEpisode({
      oracle: selected.oracle,
      evidence: retainedNeutralEvidence,
      capabilities: ['workspace-files', 'skill-content', 'resource-read']
    });

writeCorpus refuses overlapping public/control roots and refuses private controls inside the repository. Writers use an ownership marker and exclusive file creation. Repeating the same write verifies unchanged bytes and executable bits. They refuse to replace modified content and refuse existing file symlinks. No helper deletes files or edits global configuration.

Save a corpus instance before running it and resume from its retained control document. Rebuilding the same seed reproduces public material but creates a new private canary. This is intentionally not a way to overwrite the existing private control.

The basic four-case route gate is:

- no-skill-01-a
- explicit-01-a
- references-01-a
- scripts-assets-01-a

These cover direct calculation, explicit selection, nested reading, and script/asset consumption. A local route gate is evidence about local consumption only.

## Candidate counts and rounds

All 40 base cases have a 16-item catalog. The corpus owns one shared pool of 256 deterministic distractor Skills. Cases reuse this pool; the generator does not create sixteen new distractors per case.

The implicit-01, references-01, and scripts-assets-02 journeys are anchors, for both materials. They admit candidate counts 16, 64, and 256, and round counts 1, 2, 4, and 8. Each extra round has its own ordinary user turn, new business input, and requested output. It is not a repeated hidden assertion.

    const anchor = planCaseVariant({
      ...corpus,
      caseId: 'references-01-a',
      candidateCount: 64,
      roundCount: 4
    });

The returned variant ID and hash identify the expansion. The base case ID, family, material, and cluster remain stable. Non-anchor cases reject undeclared scales or round counts. Continuation and task-switch base cases use two actual turns.

## Real product materialization

The corpus module emits recipes; it never fabricates a Notion receipt or silently replaces a product call with an HTTP test fixture.

The existing scripts/notion-agent-fixtures.mjs owns the real public-interface lifecycle:

    import {
      prepareAgentFixtures, readAgentFixture,
      runAgentFixtureEvent, cleanupAgentFixtures
    } from './scripts/notion-agent-fixtures.mjs';
    import {
      buildFixtureRecipe, bindPublicCaseToFixture
    } from './benchmark/corpus/index.mjs';

    const fixture = buildFixtureRecipe({
      publicCorpus: corpus.publicCorpus,
      caseId: 'explicit-01-a',
      placement: 'notion',
      scopeId: 'owned-explicit-01-a'
    });

    const bindings = await prepareAgentFixtures({
      recipe: fixture.recipe,
      runId: 'owned-explicit-01-a',
      root: '/absolute/task/fixtures/explicit-01-a',
      entry: isolatedLibraryEntry,
      cli: pinnedCliEntry,
      node: maintainedNodePath
    });

    const bound = bindPublicCaseToFixture({
      publicCase: selectedPublicCase,
      skillMapping: fixture.skill_mapping,
      bindings
    });

    // The subject receives bound.publicCase.turns.
    // The observer uses bound.identity_map to map actual identities to logical IDs.

placement accepts project, notion, and mixed. Mixed placement uses both native project files and native Notion objects. Native Notion relation owners retain their public dependency relationships; local project fixtures provide the same complete dependency contents without pretending to expose a Notion relation API.

skill_mapping maps every stable Skill ID to its fixture object alias, public name, placement, and initial version. The fixture helper adds an owned scope suffix to public names. bindPublicCaseToFixture changes only the public invocation names in task text and returns observed identity mappings. It never returns private answers.

expected_inventory contains the files expected in the initial state. planned_inventory additionally contains future versions. A policy-revision case is mutable. Its control event uses the stable Skill ID; translate that ID through skill_mapping to the fixture object alias before calling runAgentFixtureEvent. Keep the event ID and successful readback in neutral state_events evidence.

Frozen read-only material may be shared across conditions and models when the complete visible catalog and initial state are identical. A library that exposes extra Skills changes the candidate count even when the intended sixteen objects exist. Use separate entries or another already-supported public visibility boundary to preserve exact catalog parity. Do not claim a filtered catalog when the subject cannot actually use that filter.

Cases with publication or other writes need episode-owned remote objects. Do not feed one condition the state modified by another. Provisioning, unknown-write reconciliation, readback, and owned cleanup remain the fixture helper's responsibility. Cleanup requires subjectExited and the established system-Trash path.

### Upstream and content identity

An upstream source must be explicitly provided:

    sourceBindings: {
      [stableSkillId]: {
        declaration: {
          version: 1,
          definition: {
            // The complete supported public source definition belongs here.
            policy: 'pinned',
            adapter: { type: 'git', url: publicRepositoryUrl, ref: fullCommitId }
          }
        },
        memberKey: repositoryMemberPath
      }
    }

The actual definition must satisfy the public product schema. The corpus boundary requires a pinned full commit identity. Omitting sourceBindings yields source_claim equal to no-upstream-claim. Native Notion creation and mixed local/native placement do not prove upstream projection.

After public provisioning, retrieve the files through the actual product interface. verifyMaterialization compares presence, content, executable mode, and authorization. It detects missing files, unexpected files, duplicate observations, changed bytes, missing authorization, and changed executable bits.

A scoped Skill name can be normalized using skillMapping. If native Notion Markdown changes its representation, compareMain may call the selected public SDK's current Markdown comparator. It must return true only for a proven match. Resource, asset, and script bytes remain exact comparisons.

A neutral resource_read may use a canonical hash only after the actual observed bytes have passed this equivalence check. Retain the actual bytes/hash, the normalization receipt, and the raw evidence reference. Never assign an expected hash just because a Skill ID matches.

Initial local material validation, real native Notion readback, real upstream projection, and paid model episodes are separate evidence categories. Report the subset actually exercised.

## Neutral evidence and grading

gradeEpisode is pure. It consumes observations and never reads, writes, or repairs product state.

    {
      artifacts: [{
        path, content, sha256, evidence_id,
        turn_id
      }],
      selections: [{ skill_id, evidence_id }],
      resource_reads: [{
        skill_id, path, sha256, evidence_id,
        turn_id
      }],
      clarifications: [{
        topic_id, turn_id, before_completion, evidence_id
      }],
      state_events: [{ id, status, evidence_id }],
      coverage: {
        artifacts: 'complete',
        selections: 'complete',
        resource_reads: 'partial',
        clarifications: 'complete',
        state_events: 'complete'
      }
    }

Optional turn_id fields limit observations when the contract names a turn. evidence_id must refer to a retained raw event or readback in the controller's evidence registry. The grader preserves supplied IDs; it does not invent proof of product activity.

Coverage is complete, partial, or unavailable. Missing coverage defaults to partial. An empty array under partial coverage cannot establish that no selection or clarification occurred. A known missing output under complete readback coverage is a confirmed failure; missing readback evidence remains unknown. Positive file bytes can prove a business contract without claiming complete trace coverage.

The supported contract kinds are:

- artifact-json: exact JSON, an expected object subset, or row comparison by a unique key. Row order is immaterial. Extra explanatory fields are allowed unless forbidden.
- selection: one of the declared legal sets, including the empty set for a no-Skill task.
- resources: any complete legal resource path, with matching content identities.
- clarification: a required topic with a bounded question count and proven timing before completion.
- state-event: the readback status of a declared controller event.

The two equivalent tax Skills each have a legal selection/resource path. Script tasks permit either execution of the supplied script or another correct implementation of the same business rules. They require the business data they consume, not a particular shell command.

The reconciliation output forbids personal-information field names recursively, so a correct arithmetic result that retains those fields fails its business contract. The grader does not require tool names, a fixed number of calls, or a prescribed order of otherwise legal reads.

Capabilities are either confirmed-supported strings or explicit records:

    capabilities: [
      { id: 'workspace-files', supported: true },
      { id: 'skill-content', supported: true },
      { id: 'resource-read', supported: false }
    ]

An explicitly unsupported capability returns not_applicable contracts and an unsupported capability status. Undeclared required capabilities remain unknown. This mechanical field is not permission to relabel a product regression as unsupported: the frozen protocol owns the common capability denominator.

The verdict contains:

    {
      schema_version, case_id,
      business_outcome,
      capability_scope, capability_status,
      unsupported_capabilities, unknown_capabilities,
      contracts: [{
        id, kind, status, critical, evidence_ids, reason
      }],
      critical_flags: [{
        contract_id, reason, evidence_ids
      }],
      readback_refs: [{
        evidence_id, kind, path, sha256
      }],
      verified_success
    }

business_outcome is pass, fail, unknown, or not_applicable. Contract status also permits those four values. critical_flags contains confirmed failures only. readback_refs contains only referenced observations. verified_success requires confirmed capability support, business pass, and every applicable contract pass. Unknown evidence never becomes verified success.

## Confirmation sealing

Build confirmation material under a distinct seed. Seal the public and private case hashes before opening:

    const sealed = sealCorpus({
      corpus: confirmationCorpus,
      sealedAt: explicitUtcTimestamp
    });

    const opened = openCorpus({
      corpus: sealed,
      openedAt: laterExplicitUtcTimestamp,
      preregistrationSha256: frozenRegistrationHash
    });

Opening verifies both hashes, the unchanged seal, the time order, and the registration identity. The functions return new values. They do not modify a stored control document or overwrite an earlier seal. Save each immutable control record in its own owned location.

A seal is provenance, not encryption or an operating-system access boundary. The execution controller must refuse to run unopened confirmation material, keep the control root outside all subject-visible copies, and retain the opening record.

auditVisibleMaterial inventories actual visible files and checks private paths and canaries. It labels the result as a visibility audit. Same-user shell access is not an OS sandbox, and a clean canary scan alone does not establish one.

## Verification and extension

Run:

    node --test benchmark/corpus.test.mjs

The tests generate all forty local cases and compare their actual files, run the executable CSV and tariff scripts, independently recompute tariff/tax boundary results, try both equivalent candidates, and exercise missing evidence, corruption, duplicate rows, clarification timing, unsupported capabilities, private canary detection, seal tampering, and recipe validation.

A separate test adds a new Skill and a forty-first material through the same file/case schema, materializes it, and grades its declared output with the existing neutral contract. The grader has no case-ID dispatch.

Tests retain their owned temporary fixtures for inspection. Remove those owned fixtures through system Trash when evidence retention is no longer needed.

These checks establish corpus and harness behavior. They do not establish production Notion parity, a successful model route gate, a paid pilot, or a confirmation result. Those need their own actual receipts.

## Material V1 and V2

New paid batches should explicitly request materialVersion: '2'. V1 remains reproducible with its original bytes and hashes.

The first real V1 native Notion preparation stopped at a pending create. The service returned a paragraph's ordinary source newlines as explicit HTML line breaks. The public SDK distinguishes a soft line wrap from a hard break, and correctly refused to publish ready under its existing structural-fidelity contract. The compared CLI revisions have identical Markdown comparator source and tests. The failed input, operation identity, page, command receipts, and read-only diagnosis are retained as preparation evidence. This is not a model failure and is not a successful Notion materialization.

V2 writes generated main-body prose as explicit paragraphs. It does not loosen the product comparator or alter references, scripts, tables, binary assets, or their format rules. The generator's fixed-seed tests show that changing only the rendering version preserves those non-main files and business outputs. Corpus-level materialVersion is also part of seed derivation, so a newly generated V2 batch has its own material identities, inputs, contract hashes, and publication scope. Both conditions of a pair must use that same version.

Do not overwrite the V1 private controls or its pending remote owner. V2 provisioning uses a separate owned library and scope. Retaining a failed preparation does not establish ready-state coverage, an upstream projection, or a completed model episode.

## Reusing one verified catalog

Before registration, several cases may share one frozen sixteen-item catalog. This avoids repeatedly creating the same remote objects while preserving the entire actual candidate set.

    const gateCaseIds = [
      'no-skill-01-a', 'no-skill-02-a', 'no-skill-03-a', 'explicit-01-a'
    ];
    const sharedSkillIds = corpus.publicCorpus.cases
      .find(item => item.id === 'explicit-01-a').catalog.skill_ids;

    const sharedCorpus = rebindCorpusCatalog({
      corpus,
      caseIds: gateCaseIds,
      skillIds: sharedSkillIds,
      reason: 'One verified read-only Notion library before registration'
    });

The function preserves natural prompts, inputs, business contracts, expected values, case IDs, material IDs, and clusters. It requires every necessary Skill and dependency to remain available, records the previous case/corpus hashes, and updates the catalog, initial-state, case, corpus, and private public-identity pointers. An identical repeat returns the same values. A sealed or opened confirmation corpus rejects rebinding.

The API currently accepts exactly sixteen distinct known Skill IDs for a base catalog. Existing 64/256 scale anchors still use their declared variant interface. Extra irrelevant Skills are genuine candidates and belong in both conditions. A library with extra unrecorded candidates is not equivalent.

The initial four-case shared route gate covers the no-skill and explicit families. It does not establish all-family coverage. Later shared catalogs may contain the necessary targets for several different families, subject to the same completeness and registration checks.


## Reusable controller fixture preparation

The controller entry point is benchmark/fixture.mjs. It runs separately from the
model runner. Its private corpus control, CLI state, raw provider receipts,
event journal and native export stay under one task-owned directory outside
the repository and subject source/workspace.

planBenchmarkFixture(options) freezes the complete plan without filesystem or
provider effects. prepareBenchmarkFixture(optionsOrPlan) runs it in a separate
worker with the selected immutable CLI build and maintained Node binary. The
worker inherits the existing environment allowlist plus NOTION_API_TOKEN and
uses private configuration, state, cache and data roots.

~~~js
import { buildCorpus } from './benchmark/corpus/index.mjs';
import {
  planBenchmarkFixture, prepareBenchmarkFixture,
  inspectBenchmarkFixture, verifyBenchmarkFixture, reconcileBenchmarkFixture,
} from './benchmark/fixture.mjs';

const corpus = buildCorpus({
  seed: 'benchmark-route-gate-v1',
  split: 'development',
  materialVersion: '2',
});
const plan = planBenchmarkFixture({
  corpus,
  caseIds: [
    'no-skill-01-a', 'no-skill-02-a', 'no-skill-03-a', 'explicit-01-a',
    'implicit-01-a', 'ambiguity-01-a', 'equivalent-01-a', 'references-01-a',
    'scripts-assets-01-a', 'complementary-01-a', 'continuation-01-a',
    'task-switch-01-a',
  ],
  scopeId: 'bm-expansion-v2-shared',
  controlRoot: '/absolute/task-control/expansion-shared-v2',
  projectPageId: '<authorized benchmark parent>',
  buildRoot: '/absolute/immutable-paired-build',
  node: '/absolute/maintained/node',
  placement: 'notion',
  access: 'shared-readonly',
});
const prepared = await prepareBenchmarkFixture(plan);
// Accept only status === 'ready' after complete independent readback.
~~~

These twelve cases need eleven target Skills and five shared distractors. The
planner takes the dependency closure, retains exactly sixteen candidates and
records the corpus catalog-rebinding lineage. Natural task turns, inputs and
private business expectations stay unchanged. Public case variants may retain
their deterministic catalog ordering; all use the same set of actual
candidates.

The API accepts all forty existing cases independently. Declared anchors accept
candidateCount 16, 64 or 256 and roundCount 1, 2, 4 or 8. Counts above sixteen
require one scale-anchor case. This describes executable preparation coverage,
not evidence that forty remote cases or all variants have been exercised.

Use placement "mixed" only for a separately registered mixed local/Notion
condition. The proof reports actual remote and local candidate counts
separately. A local filesystem readback does not establish model admission.

### Public pinned sources

sourceBindings is keyed by canonical Skill ID. Each binding contains one
complete public declaration and one reviewed member root:

~~~js
const member = 'benchmark/fixtures/upstream-skills/v2-route-gate/' +
  'bm-scripts-assets-01-a-manifest';
const sourceBindings = {
  'scripts-assets-01-a-manifest': {
    memberKey: member,
    declaration: {
      version: 1,
      definition: {
        version: 1,
        source_id: 'benchmark-public-manifest',
        name: 'bm-scripts-assets-01-a-manifest',
        description: 'Public synthetic manifest workflow',
        enabled: true,
        policy: 'pinned',
        adapter: {
          type: 'git',
          url: 'https://github.com/yoyooyooo/pi-context-broker.git',
          ref: 'c8b49c1c1dfac65257b07e8d249f187405e0e7f4',
        },
        selection: { roots: [member], include: [], exclude: [], mapping: {} },
        options: {},
      },
      contributions: [],
    },
  },
};
~~~

For source preparation, pass an existing supported Git as the absolute git
option (for this Mini, /opt/homebrew/Cellar/git/2.50.1/bin/git). The controller
probes --no-lazy-fetch support, records the binary hash, and selects it only
through the task-owned private bin. It does not install Git or edit global
configuration. Existing frozen preparation plans can use
bindBenchmarkFixtureGit({controlRoot, git}) to retain an explicit runtime
correction receipt. Source preparation fails before remote allocation when
this runtime selection is absent. The subject condition must have the same
required Git capability when its public source consumption needs it.

That commit was published before preparation. The public tree contains the
complete manifest Skill, executable script, binary marker and empty file, plus
the independent grant-reference Skill. It contains no private oracle, business
answers or case input. Another seed or material requires its own matching
published tree.

Native preparation binds invocation names to owned scopes. The current fixture
helper preserves source input bytes unchanged. Normal pinned-source recipes
retain their full file list, and verification independently compares every
actual file, size and executable mode, rejects missing or extra files, and
retains public source/projection readback. Only a cold Source interruption uses
an empty recipe file list: that helper hydrates an exact pinned provider tree
into private control storage. The complete canonical inventory remains in the
plan in both cases.

The first shared expansion plan was frozen with an empty source input list
before the existing helper's source-specific byte-preservation branch was
rechecked. That original plan is retained unchanged. Its full expected
inventory and independent final exact-byte comparison remain mandatory; the
empty input list does not waive any material proof. Subsequent ordinary source
plans retain the complete input list.

### Verification and binding

A successful preparation returns:

~~~js
{
  status: 'ready',
  effect_unknown: false,
  binding_path: '/absolute/control/verified/<id>/binding.json',
  binding: { path, sha256, bytes },
  materialization_proof: { path, sha256, bytes },
  entry: '<actual library entry>',
  native_skill_root: '/absolute/control/verified/<id>/native-equivalent/.agents/skills',
  actual_remote_candidates: 16,
  actual_local_candidates: 0,
  model_calls: 0,
  remote_repairs: 0,
}
~~~

The binding includes public corpus and private control paths, the complete
canonical-to-actual identity map, actual entry, proof reference and native
tree. Only public tasks and the native tree are copied to the subject.

Verification requires an exhaustive public catalog, no failed catalog sources,
complete actual file inventories, resource byte/mode equality and zero
semantic writes during normal consumption. Native main bodies use the selected
public SDK's compareNativeMarkdown contract; actual served bytes are copied
verbatim to the native condition. Source files and non-main resources require
exact canonical bytes. The controller does not trim or repair content.

Each equivalence record contains canonical, prepared and actual file
references, actual hashes and sealed/raw independent receipts. Evidence
normalization may map actual to canonical hashes only after verifying this
proof. verifyBenchmarkFixture({controlRoot}) repeats public readback into a new
immutable proof directory. inspectBenchmarkFixture reads retained local status.
reconcileBenchmarkFixture performs read-only reconciliation of interrupted
preparation; it accepts a completely observed ready state or returns unknown.

### Restart and unknown writes

Each root binds one plan hash. A different corpus, episode, catalog or source
declaration cannot reuse it. A worker lease prevents concurrent mutation, and
completed leases and command receipts are retained.

Repeated prepare calls cannot turn a dispatched initialization or partial
object preparation into a fresh creation attempt. Unknown writes retain the
same operation and objects. The controller does not clear pending operations,
allocate replacements, replay ambiguous writes or directly edit product
database state. Public recovery must use the retained operation identity.
There is no cleanup, remote-trash, hard-delete or arbitrary-command entry.

The explicit resumeBenchmarkFixturePreparation API (CLI: resume --root) first
reconciles every owned object. It can create only objects independently observed
absent that were never dispatched after a retained serial preparation failure,
or whose earlier source attempts were confirmed UPSTREAM_TEMP_FAILED or
UPSTREAM_GIT_RUNTIME_UNSUPPORTED prewrite rejections. It accounts for every new dispatch claim and raw terminal;
an unaccounted claim, pending owner, or any other ambiguous error stops all new
writes. Ready objects are read back and reused. The first expansion preparation
exposed a missing controller TMPDIR; that prewrite failure and its operation
not-found/zero-write receipts are retained, and private runtime roots are now
created before worker launch.

~~~sh
/absolute/maintained/node benchmark/fixture.mjs prepare --plan /private/plan.json
/absolute/maintained/node benchmark/fixture.mjs status --root /private/fixture
/absolute/maintained/node benchmark/fixture.mjs verify --root /private/fixture
/absolute/maintained/node benchmark/fixture.mjs reconcile --root /private/fixture
~~~

The plan command emits a complete private plan; retain its output in controller
storage. Other commands emit result references. A failed or unknown material
preparation is not a model business failure.

### Episode events and actual state

Mutable cases require access "episode-owned", one case and one episodeId.
The continuation-02 policy-v2 event is frozen before execution. Diagnostics
also declare their ID, stable Skill and logical operation before the run.
Supported operations are publish-version, set-enabled, readback, fault,
restore-fault, interrupt-source-write and resume-source-write. Shared read-only
libraries reject mutation.

~~~js
import {
  applyBenchmarkFixtureEvent,
  reconcileBenchmarkFixtureEvent,
} from './benchmark/fixture.mjs';

const result = await applyBenchmarkFixtureEvent({
  controlRoot: '/absolute/owned-episode-fixture',
  eventId: 'policy-v2',
  episodeId: 'registered-episode',
});
~~~

The return and hash-bound receipt share event_id, episode_id, status,
logical_operation, effect_unknown and evidence_id. Status is applied, blocked,
failed, not_applied or unknown. Applied requires effect_verified true and
retained independent evidence. Exceptions after dispatch become unknown; they
never imply no effect. Reusing a terminal outcome does not dispatch again.

Read-only event reconciliation accepts a verified target state as applied
only with an owned dispatch. Not_applied requires both an absent dispatch
ledger and a successful unchanged-initial-state readback. Unresolved dispatch
stays unknown. The turn bridge stops unless applied is verified.

Version publication returns native_version with the actual readback files,
modes and target name. For a native subject, the parent controller must install
that exact tree at the registered between-turn boundary and retain a filesystem
receipt. Changing only Notion would leave different states. The event receipt
does not claim native installation has occurred.

Store faults require the actual runtime root frozen as ownedRuntimeRoot and
attached through attachBenchmarkFixtureRuntime. Attachment checks the existing run.json and the complete runtime_start event
prefix against the frozen episode/root, retains immutable observations, then
adds only an ownership marker. It does not seed content or snapshots. The controller first
proves the chosen actual subject snapshot is readable. Quarantined files and
outage markers are retained. Restoration moves the exact owned bytes back and
verifies zero-request offline consumption through the public CLI.

A cold Source interruption can declare initiallyAbsentSkillIds with an exact
pinned source and a frozen interrupt event. Its proof is a diagnostic-extension
with absent inventory and actual initial candidate count disclosed. It is not
complete common-condition parity. The bounded product operation must actually
leave the Source applying and its child ready before exact-operation resume.

A Store outage or Source-management fault is not a common native/Broker fault
merely because both runs have a Notion directory. Unsupported surfaces remain
separate unless the native condition has a registered semantically equivalent
fault with independent evidence.

### Frozen clean/fault Store comparisons

The optional episode_fixtures.diagnostics policy supports one bounded design:
two journeys, one model, two selected Broker builds and clean/fault arms for
each build. It requires exactly eight scheduled slots with one repetition.
Native conditions are rejected before fixture allocation. This is Store
consumption and recovery coverage; it does not stand for every Source-write,
cancellation or unknown-side-effect scenario.

~~~js
corpus: {
  generator: 'owned-store-first-use-v1',
  seed: '<separately frozen diagnostic seed>',
  split: 'development',
  material_version: '2',
  selections: [
    { caseId: 'store-first-grant-a' },
    { caseId: 'store-first-tariff-a' },
  ],
},
episode_fixtures: {
  version: 1,
  project_page_id: '<owned benchmark project>',
  diagnostics: {
    version: 1,
    kind: 'owned-store-clean-fault',
    pairs: [
      { clean: 'm0-e0', fault: 'm0-e2' },
      { clean: 'm0-e1', fault: 'm0-e3' },
    ],
    scenarios: [
      {
        id: 'grant-first-use',
        case_id: 'store-first-grant-a-n16-r4',
        skill_id: 'references-01-a-grant',
        probe_skill_id: 'implicit-01-a-routing',
        mode: 'store-unavailable',
        before_turn: 'turn-2',
        restore_before_turn: 'turn-3',
      },
      {
        id: 'tariff-first-use',
        case_id: 'store-first-tariff-a-n16-r4',
        skill_id: 'scripts-assets-02-a-tariff',
        probe_skill_id: 'explicit-01-a-refund',
        mode: 'store-unavailable',
        before_turn: 'turn-2',
        restore_before_turn: 'turn-3',
      },
    ],
  },
}
~~~

The pair declarations connect clean and fault arms of the same product build.
They are separate from environment_pairs, which can compare the two product
builds within each arm. Both clean and fault slots receive independent owned
fixtures, runtime roots and zero-model startup captures. A clean arm has no
diagnostic events; it still cannot reuse a shared fixture or startup capture.

The independent generator composes two different business journeys from
existing public material and neutral contracts. The first turn uses Skill A
for shipping or refund work. Turn two starts unrelated grant or tariff work
that first needs Skill B. Turns three and four continue B with new inputs and
separate turn-bound business outputs. The corpus has new case, cluster,
material and provenance identities; the original forty cases remain unchanged.
Clean and fault arms receive the same new natural tasks and private contracts.

The private projection adds fault and restore-fault events. With a distinct
probe_skill_id, only a global store-unavailable fault is allowed. Events and
their logical_operation name probe A, whose actual subject snapshot must be
readable before the Store is quarantined and again after exact restoration.
The separate expected_subject_operation names prospective business target B;
it is not evidence that B was actually consumed. The controller does not seed
A or B. A missing probe precondition remains missing diagnostic coverage.

No call ordinal chooses the fault. Event timing is frozen between natural
turns. Without a distinct probe, missing-object, missing-manifest and
store-unavailable can target one already consumed Skill. Actual subject traces
must independently establish whether the target operation occurred during the
outage. Report applied fault, observed encounter, verified restore and final
business outcome separately. Store restoration alone does not establish model
recovery. All business failures remain in the unchanged diagnostic grading.

Filesystem tests prove scheduling, isolation, immutable event bindings and
capture selection only. Real model dispatch, actual Store faults, recovery
receipts and unchanged business grading are still required for live acceptance.

### Tentative complete-delivery acceptance budget

The following design was accepted before later batch freezes:

| Batch | Charged episodes | Evidence scope |
| --- | ---: | --- |
| Route gate | 24 | Four cases, three models, two conditions |
| Family expansion | 48 | Eight additional families, three models, two conditions |
| Own-version comparison | 8 | Four journeys, one declared model, two real versions |
| Additional Code Mode off cells | 12 | Six anchors, two conditions; matching free cells reused only as registered |
| Scale and round extensions | 10 | Five additional anchor variants, two conditions |
| Controlled fault cells | 8 | Two semantic journeys, clean/fault and two supported conditions |
| Unseen confirmation | 20 | Ten families, new independent material, one model, two conditions |
| Invalid-run and rerun reserve | 14 | All charged invalid runs and reruns retained |
| Total ceiling | 144 | Each later batch is frozen before execution |

The route gate covers two families. Confirmation supports one model and ten
journey clusters; it cannot by itself establish three-model conclusions or
narrow equivalence. Fault cells require the capability qualification above
before their budget is frozen. Confirmation material remains sealed until
candidate and budget registration; the fixture planner cannot open it
implicitly.
