# Current-request projection review

Scope: AH-1015, AH-1016 and the first implementation slice of AH-1017. Product
candidate: `1ddf50cd1aab95c216e393f2718a01725653731f`. This review does not certify
the later default-catalog encoding, final HTTP binding, full Pi scenario matrix,
or a new daily installation.

## State and representation

The original scope, owner, snapshot, source hash, complete Required graph,
authorization, cancellation and activation owners remain in place. No acquisition
or remote write is added. The projector continues to modify only the outgoing
view; original user messages and tool results are unchanged.

Scalar resource retirement now replaces the verified source span rather than the
entire tool text. A remaining generated effects footer must exactly match this
operation's structured effects. An altered or unbound suffix is rejected. This
implements the existing retention-disclosure obligation at a previously unchecked
serialization boundary. `RetentionDisclosure` and `AcquisitionEffects` retain
their original transitions, positive cases and historical counterexamples.

Preparation and native-read directories are reused only when the current request
contains a complete matching generated directory for the same scope, owner,
snapshot and version. Native v3 reads additionally bind the entire generated
output. A derived preparation records exactly which directories were omitted,
with their rendered hashes and byte counts. The independent checker verifies that
each omission has an intact witness in that same request. A body summary or a
stored loaded flag is insufficient.

The original `SelectionGraph` and `DeliveryBoundary` contracts remain applicable
to fixed identities and body delivery. Directory counts, representation layout,
operation footer spans and HTTP entity bytes are **not** variables in those finite
models. Their proof comes from actual-content regressions and the installed
serializer, not from updating a source hash.

## Reviewed owners

| Owner | Change and review result |
| --- | --- |
| `session-source-snapshot.ts` | Bounded, current-request directory index; exact source-span retirement; stronger native output commitment; derived offsets preserve surviving full bodies. No persistent seen state. |
| `skill-context-projection.ts` | Same complete author content; optional exact fixed-file relation shares its file object and description. Unfixed, foreign, ambiguous and unavailable relations retain full metadata. |
| `skill-context-projection-proof.ts` | A validated parent can omit only explicitly selected directories. All other metadata and unchanged bodies must remain identical. Unknown fields and damaged parents fail. |
| `prepare-protocol.ts` | Adds a parser for canonical directory shape used at the representation boundary. Graph decoding, permission and selection commit semantics are unchanged. |
| `skill-catalog-projection.ts` | Recognizes the normalized exact file relationship; current candidate identities and qualification checks remain separate. No arbitrary author text is removed. |
| `skill-preparation-evidence.mjs` | Independently checks actual public fields and same-request directory witnesses; it does not import the product projector to construct the expected result. |

## Checks and failure controls

The two original scalar retirement cases fail on the unmodified product and pass
after repair. The corresponding repository tests were first 36 passed / 2 failed.
The new directory repetition cases initially yielded 11 passed / 3 failed.
After the implementation, five focused source files produced 124 passed tests;
the independent oracle and existing evidence/driver tests produced 187 passed
tests, and the package type check passed.

A production-projected scalar and batch result were then sent through the actual
installed Pi 1.5.0 OpenAI-completions serializer to an owned loopback HTTP server.
The 1,614-byte request retained both operation uncertainties, removed the retired
source text, and excluded machine proof fields. This is a projector-to-installed-
serializer check, **not** a live Pi conversation, production service, or real-model
result. Those gates stay with AH-1021 and AH-1022.

Commands and original logs are retained in the execution receipt. Later changes
must review their own diff and rerun the affected checks; they do not inherit these
results merely by sharing the same branch.

## Maintenance

Run the existing formal runner after reviewing the source correspondence. Keep
the original configured rules and expected negative failures. Representation-only
changes do not justify a new abstract state machine, but they do require the
current-request byte and object checks. A future change to actual provider
acceptance or persistence must separately review `DeliveryBoundary`.

## CTX final request boundary

The later implementation retains the same abstract graph/lifecycle/turn/draft
owners. `DeliveryBoundary.providerAccepted` is still logical response headers;
it is not renamed to actual wire delivery. Its concrete precondition now also
rejects a known mismatch between the checked serialized request and the entity
observed from Node Undici. A dispatched mismatch remains a dispatch. Unsupported
API/schema conversion/transport is explicitly non-wire coverage.

The final check uses the Broker's own last legal projection, including generated
catalog data, operation effects and normal tool declarations. Expectations are
captured before later mutable hooks. Immutable machine receipts for restored
user text remain in that private expectation, never in model input.

An independent review of `1884c89` found that restored source text had no inline
user details. The new ledger overlooked its separate nativePromptSha256 receipt
and could certify an entity with that source reassigned to assistant. The focused
real-deferred-drafts test was 12 pass / 1 fail before repair and 13 pass after.
The correction in `e91dc8c` preserves and checks that original user obligation,
including in-place mutation of the returned message. This is a concrete
refinement defect; the finite model does not encode serialization roles.

Actual installed Pi tests preserve duplicate/lost/schema post-hook failures and
the restored-user-role counterexample separately from the passing public tool
loop. The first three are known dispatches without a success proof; the restored
case rejects the new request before sending while retaining its legitimate first
turn. The original independent failing reproduction remains unchanged.

State-machine source maps include the final-request module and its concrete
tests as reviewed owners, without pretending that a model run checks their byte
semantics. The original TLA/config rule sets and positive/negative outcomes are
unchanged. Read the exact run manifest for current checked source identities.
