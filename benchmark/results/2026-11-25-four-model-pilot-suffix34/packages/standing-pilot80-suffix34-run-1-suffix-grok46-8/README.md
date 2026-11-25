# Public Benchmark evidence package

This package contains transformed copies of retained evidence. Whenever redaction changed a file, its original bytes are not included.
The manifest maps each verified original SHA256 to the public copy SHA256 and records both byte counts. JSONL line numbers and JSON pointer locations remain usable after deterministic key pseudonymization.
Inner original body hashes, HTTP entity hashes and hash-chain entries are historical claims. Redaction changes those bytes; this package does not claim that original chains can be recomputed from transformed copies.
Reported model labels, request/attempt references and provider configuration bindings are checked against transformed raw evidence. Explicit original-to-public mapping is required for this verification; private execution never accepts the public projection as original evidence. Original private endpoint/path hashes remain historical claims after redaction.
Offline replay verifies public file hashes and source locators, then recomputes statistics from retained normalized observations. It does not rerun private business grading, recover secrets, call a provider, or create new executions.
Counts, outcomes, unknown values, fixed denominators, intervals and decisions were compared with the original analysis before export and must be identical after identifier projection.
Private oracles are not included. Credential and private identifier mappings are never written. Deterministic pseudonyms are not a guarantee of irreversible anonymization.
Non-UTF-8 bytes are refused unless an explicit reviewed synthetic-fixture allowlist binds their SHA256, byte count, artifact kind and public purpose. Approved binary material is copied byte for byte; its approval is recorded in the manifest. Text and structured evidence still pass through redaction.

## Replay

Run node replay.mjs to verify the package and recompute its analysis.
Run node replay.mjs --out /absolute/new-report-directory to write a fresh report. Node with JSON import-attribute support is required; no package installation or credentials are needed.

## Identity

- Original analysis: de5b72046e6b8431dabf85e92aa1572a3780fbedfffc8f074862d9fe8e6fabc9
- Public analysis: e7ec6db52173990bb6e2e3439f590bb518409a5024b1a2856ba34e1133741014
- Unchanged analysis meaning: 82779540bb56c7a420ff9b61505cc56f50b3f32f8df968cfd4019180c890ff42
