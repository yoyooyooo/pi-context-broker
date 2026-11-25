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

- Original analysis: 889785ea3331bbadbf6a48d290c4223e7ac8f2baa8f7bc1e3e8308341f8b1788
- Public analysis: 9bd479c96276d6ab3ba1321bb1883f22e58588f7a8419efe5914fd18a42236b5
- Unchanged analysis meaning: f93052ecaf481d542b6cf75ddb952fe9b5000e568ab2ce1f196bbde5ac7d9275
