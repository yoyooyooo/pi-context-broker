# Consumer observations

Mutable eligibility is separate from a session's fixed content selection and proof of delivery. These finite models check the corresponding observation rules; they do not model HTTP consistency or authorize production writes.

## Reproduce

Use the statechart commit and runtime hashes in `tool-lock.json`, with the declared TLC jar. Keep tools and outputs outside the repository. `PSTACK_STATECHART_ROOT` names the directory containing `scripts/run.ts`; `TLA2TOOLS` names the verified jar.

```sh
node scripts/verify-consumer-observations.mjs --suite observations --out /new/absolute/model-output
bun test packages/context-broker/scripts/consumer-observation.test.ts packages/context-broker/scripts/host-prepare.test.ts --timeout 30000
node scripts/check-consumer-observation-mutations.mjs --out /new/absolute/mutation-output
```

Use new output directories. The existing runner checks complete exploration and every rule's terminal outcome, retaining raw TLC output, reports and generated Mermaid. Missing tools, parse errors, timeouts, cut state spaces and unknown results fail. The full consumer-state Skill also runs the adjoining models and actual guards.

## Domain correspondence

| Model/property | Product owner | Real replay |
| --- | --- | --- |
| Availability / KnownObservationAgrees | `consumer-observation.ts` interprets current proof; `host-skills.ts` routes read, use and metadata | F1–F4 in `host-prepare.test.ts` |
| Availability / CursorCannotMixAvailability | `notion_list` fingerprints effective availability, View, scope, query and coverage | F5; effective-state hash mutation |
| ReadRace / NewestObservationWins | Generation, operation order and original validation evidence; final graph eligibility check | F7; older success after newer denial |
| ReadRace / NoCrossSessionPublication | Lifecycle cancellation/generation and coordinator ticket admission | Cancellation and replacement regressions; generation-negative model |

`coverage.json` owns the complete cases and independent `expected_rules`. Configurations named `current` deliberately retain audit defects as negative controls; their expected failures do not describe current product behavior. Candidate configurations must satisfy every rule. Each negative must fail exactly its declared set.

The mutation script removes two actual code guards in isolated copies. Baseline must pass, guard removal must fail a behavioral assertion, and exact restoration must pass. It does not alter the active checkout or installed product.

## Limits and adjacent checks

Availability has one record and one saved cursor. ReadRace has two reads and two session epochs. These models do not prove server linearizability, cross-machine wall-clock order or arbitrary future races. Original validation time, source kind, exact failure targets, fixed graphs and delivery have adjoining consumer-state models and concrete tests.

F6 exercises the actual metadata consumer with a controlled clock at TTL-1, TTL and later accesses, concurrent readers and no body loads. Transport, current SDK capability, import invalidation and actual installed package checks belong to the existing integration Skill. Source hashes bind only reviewed state owners and guards; package pins, build inputs and guidance are not premises of these models.

Current SDK v2 consumption performs no semantic writes. Receipt aggregation, source failure and cancellation remain defensive implementation checks in `host-prepare.test.ts`; they are not a formal claim about implicit retention. Selected local bytes do not promise historical content can be recovered from Notion.
