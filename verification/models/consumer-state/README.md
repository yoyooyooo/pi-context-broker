# Consumer state

Owner: [.agents/skills/verify-notion-consumer-state](../../../.agents/skills/verify-notion-consumer-state/SKILL.md).

These three bounded contracts complement Availability/ReadRace. The complete case inventory and independent expected rules live in `coverage.json`. Candidates must satisfy every declared rule and NoDeadlock. Each negative must break exactly its declared set. Parse errors, timeouts, incomplete spaces and unknown outcomes fail.

| Model | Contract | Independent implementation checks |
| --- | --- | --- |
| FreshnessPublication | Original validation/expiry, remote/cache/fixed/unknown evidence, request/lifecycle/identity publication and exact failure target | Controlled clock, equal-time order, F1–F7 and source/target guards |
| SelectionGraph | Validate identity, budget and complete root/Requires before final selection; independent member pins | Failed refresh, budget, mixed vectors, early commit and pin mutations |
| DeliveryBoundary | Provider acceptance, complete source proof, turn completion, host draft decision and actual projection ACK | Registered hooks, discarded drafts, session/rewind identities and receipt guards |

Read the Skill's contracts reference for atomic boundaries and finite assumptions. Hashes bind reviewed implementation bytes; they do not establish full implementation refinement. Fixed pins describe verified local selections, not remote version management or guaranteed historical recovery.

Run the Skill's doctor and full run from the repository root with the pinned statechart/TLC installation. Keep outputs outside the repository. The existing runner supports `--suite consumer-state` and `--model FreshnessPublication`, `SelectionGraph` or `DeliveryBoundary` for a targeted investigation.

`DeliveryBoundary.providerAccepted` denotes logical headers, not a wire receipt. Actual source roles, directory counts, JSON schemas, body completeness and HTTP entity digests remain concrete regression obligations. `final-request-undici.test.ts` checks real Node HTTP entities; installed Pi serializer and live provider behavior belong to the separate integration scope and must be executed before claiming them.
