# Consumer state

Owner: [.agents/skills/verify-notion-consumer-state](../../../.agents/skills/verify-notion-consumer-state/SKILL.md).

These five bounded contracts complement Availability/ReadRace. The complete case inventory and independent expected rules live in `coverage.json`. Candidates must satisfy every declared rule and NoDeadlock. Each negative must break exactly its declared set. Parse errors, timeouts, incomplete spaces and unknown outcomes fail.

| Model | Contract | Independent implementation checks |
| --- | --- | --- |
| FreshnessPublication | Original validation/expiry, remote/cache/fixed/unknown evidence, request/lifecycle/identity publication and exact failure target | Controlled clock, equal-time order, F1–F7 and source/target guards |
| SelectionGraph | Validate identity, budget and complete root/Requires before final selection; independent member pins | Failed refresh, budget, mixed vectors, early commit and pin mutations |
| DeliveryBoundary | Provider acceptance, complete source proof, turn completion, host draft decision and actual projection ACK | Registered hooks, discarded drafts, session/rewind identities and receipt guards |
| RecoveryClosure | Original fixed bodies, mandatory closure, local failure isolation and three subsequent prompts | Missing/disabled/denied originals, late restores and continued conversation |
| LibrarySession | Branch Library choice, admitted-turn binding, exact call target, directory publication ticket and original pin owner | Switch/failure/branch restoration, A-to-B late producers, canonical root routing and old A selections |

Read the Skill's contracts reference for atomic boundaries and finite assumptions. Hashes bind reviewed implementation bytes; they do not establish full implementation refinement. Fixed pins describe verified local selections, not remote version management or guaranteed historical recovery.

Run the Skill's doctor and full run from the repository root with the pinned statechart/TLC installation. Keep outputs outside the repository. The existing runner supports `--suite consumer-state` and `--model FreshnessPublication`, `SelectionGraph`, `DeliveryBoundary`, `RecoveryClosure` or `LibrarySession` for a targeted investigation.

`DeliveryBoundary.providerAccepted` denotes logical headers, not a wire receipt. Actual source roles, directory counts, JSON schemas, body completeness and HTTP entity digests remain concrete regression obligations. `final-request-undici.test.ts` checks real Node HTTP entities; installed Pi serializer and live provider behavior belong to the separate integration scope and must be executed before claiming them.

## Library selection

LibrarySession adds eleven configurations, giving this suite forty-two in total.
Its independent oracle preserves the admitted A turn, A directory payload, parent
branch selection and original A pin while the current child branch selects B.
The selection ticket and lifecycle epoch are separate. A valid switch affects
later turns, keeps the current turn bound, and does not cancel or disable A.
An unsuccessful switch blocks the requested B flow while preserving the prior
selection; that flow cannot silently continue in A.

An explicit B reference can be used from an A turn without changing the branch
default. An independently supplied conflicting explicit call scope is rejected.
Directory publication checks the producer's original scope, selection ticket and
lifecycle epoch. A response admitted under A cannot become B directory evidence.
Rewinding or returning to a parent branch restores that branch's stored selection,
even when a later child selected B.

The finite domain has two roots, two branches, an admitted turn and a later turn,
one directory producer, one selection change and one independent cancellation.
Validation, selection commit, branch restoration, return and turn admission are
separate transitions. `SessionFlowEventuallyExplained` assumes started actions
and external observations terminate under weak fairness. A rejection is an
explained outcome; this is not eventual service availability or provider success.

The concrete owner is `library-selection.ts`: active-branch reduction, fresh
input admission, local default capture, remote root verification, failed-switch
blocking and publication identity. `host-skills.ts` retains the admitted context
for the running turn independently of content preparation and queued input.
Six `library-*` mutations in `check-consumer-state-mutations.mjs` remove these
actual guards. Each requires an unmodified passing baseline, an assertion-level
behavior failure, and a passing replay after exact restoration. Coverage hashes
record reviewed correspondence; the retained run reports establish execution.

The model covers the primary branch default and one explicit cross-Library call.
It does not enumerate multiple explicit `$name@source` invocations in one turn.
Those names select configured Sources and keep each actual root/full reference;
unqualified names use only the selected default. Concrete UUID/URL parsing,
enabled Source routing, mixed Prompt/Skill injection, actual Pi branch
serialization and installed CLI arguments remain separate implementation checks.
