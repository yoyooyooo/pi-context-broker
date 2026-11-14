# Consumer state

Project owner: [.agents/skills/verify-notion-consumer-state](../../../.agents/skills/verify-notion-consumer-state/SKILL.md).

This directory adds three bounded contracts while retaining the existing Availability/ReadRace suite in consumer-observations. The complete case inventory lives only in coverage.json. Every candidate must finish with all declared rules and NoDeadlock holding; each negative must break exactly its declared rule set. Syntax errors, timeouts, incomplete/cut spaces and unknown rule outcomes fail the runner.

| Model | New contract | Independent implementation evidence |
| --- | --- | --- |
| FreshnessPublication | Original validation/expiry, remote/cache/fixed/unknown evidence, request/lifecycle/identity publication and exact failure target | Controlled clock, equal-time ordering, existing F1–F7 and source/target guards |
| SelectionGraph | Validate identity, budget and complete root/Requires before final selection; independent member pins | Existing failed refresh/budget tests, mixed vectors, actual early-commit and pin mutations |
| DeliveryBoundary | Provider acceptance, complete source proof, turn completion, host draft decision and actual projection ACK | Real registered hooks, discarded drafts, session/rewind identities and guarded receipt tests |

Read the Skill's contracts reference for state owners, atomic boundaries and explicit finite assumptions. Source hashes bind reviewed implementation bytes; they do not establish complete implementation refinement. Product code is not changed by this verification slice.

Run the Skill's doctor then its full run from the repository root. Use the already frozen statechart/TLC installation and retain output outside the repository. The underlying stable model runner supports --suite consumer-state and --model FreshnessPublication, SelectionGraph or DeliveryBoundary.

The original failed syntax attempt, successful model runs and all actual guard mutation baseline/failure/restoration transcripts remain in execution evidence. A final delivered receipt must identify the actual checkout and input hashes; do not reuse counts from an earlier draft after changing model inputs.

AH-1014 adds concrete final-request guards; see [the reviewed source boundary](../../../docs/context-once-source-review.md#ctx-final-request-boundary). `DeliveryBoundary.providerAccepted` still denotes logical headers, not a wire receipt. Actual serialized source roles, directory counts, JSON schemas and entity digests remain concrete regression obligations outside this finite abstraction. The four installed HTTP counterexamples include a real persisted-user restoration; a hash of a wrongly accepted entity is not sufficient source proof.
