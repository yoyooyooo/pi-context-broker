# Turn-control evidence collection

Collector `1.0.2` consumes retained controller and subject observations after execution. The controller first calls `readSubjectTurnControl` and passes its result as `raw.turn_control_verification`. The collector does not import the subject dispatcher, fixture generator, or private corpus generator.

## Validity boundary

A bridge is required when the public case contains multiple turns, a state event, or a clarification policy, or when a bridge was actually present. A child episode marked completed is insufficient on its own.

The collector independently checks the terminal receipt's file ownership, canonical path, byte count, hash, run and episode identities. It rechecks the private plan hash without adding the plan's contents to the evidence registry. Controller and subject journals, checkpoint requests and receipts, actual runtime event prefixes, session identity, turn order and completed checkpoint counts must agree. Registered raw files keep their original artifact IDs.

A missing or untrusted required receipt, a stopped controller, or a parent dispatch error invalidates the sample and stops further dispatch. Independent business readback and actual request/usage measurements remain in the bundle. Invalidation suppresses verified success credit; it does not replace known usage with zero or rewrite the raw business grade.

## Clarifications

A clarification observation requires an actual controller response, a matching public receipt read by the subject, and the next runtime turn with the same identifier, prompt, clarification kind and session. A controller decision alone is insufficient. Timing before completion is asserted only from retained workspace snapshots.

These observations enumerate delivered task clarification turns. They do not establish that every question the model asked has been classified. Clarification coverage therefore remains partial, and a finite maximum-question contract cannot pass from these observations alone. Observed violations remain available to the grader.

## State changes and versioned resources

The implemented state path is a declared `publish-version` event at a settled checkpoint. It requires retained adapter and fixture receipts, actual sealed and raw readback descriptors, verified source-file bytes and modes, and, for the native condition, the owned installation's before/after trees and matching target identity.

Ordinary v2 resources use their observed bytes and hashes. A native main file reuses an earlier canonical transformation only when its actual bytes are unchanged and the initial material parity was already independently verified. A changed main without such proof is left unmapped.

Version mappings become eligible only at the observed next turn. They do not produce resource-consumption evidence themselves. The existing collector still requires an actual tool delivery, full returned bytes, and an observed path or source-owner binding. Missing or truncated tool deliveries remain unknown.

## References and publication

Journal references use the complete journal file hash plus a line number. Source files are retained by hash, with fact references pointing to their actual JSON receipt descriptors; plain source text is not treated as JSON. The private controller plan and oracle contents are excluded from the registry.

Historical single-turn bundles and the published blocked-pilot results are unchanged. Using collector 1.0.2 on retained evidence produces a new analysis implementation identity; it does not create another model execution.

## Validation

The collector suite passes 16 tests, including preservation of business evidence and usage under bridge or parent failure. The separate turn suite passes 10 tests using a real owned child process, three-turn IPC, the production native installation adapter, and full collection through normalization and bundle verification.

The turn suite checks complete, missing and truncated v2 tool deliveries. Only a complete actual read produces v2 resource-consumption evidence. It also resolves all source references and checks reuse of an already registered run artifact.

A separate retained deterministic apparatus readback verified an applied v2 state change and 105 source references. That older apparatus lacks the actual runtime clarification-kind field, so the collector correctly produced no clarification observation from it. Its proof identity is `3232e2e7e8ffa77a38f4fc2b6bec43b71d7aefe938222b38cd0520178d24e473`.

The complete turn-test apparatus index is `396bd90803f4ee606b13bc689e02fef6494be79cb5b44c099ff058129f890bbd`. These are controlled apparatus results with no natural model-quality claim. They do not fill missing pilot cells or pass the route gate.
