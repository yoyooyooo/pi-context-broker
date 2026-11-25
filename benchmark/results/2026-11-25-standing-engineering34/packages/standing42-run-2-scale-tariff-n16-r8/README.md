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

- Original analysis: dc938f83b4e9f50ab9825b70f5b46f5bb0a9529412432bddc2683e5728e8d07d
- Public analysis: 98817002d5db069c6a62b4a5426e7386de2605633c14bed23a479954c5c7d0ac
- Unchanged analysis meaning: 388df82a3f0d8265e0db5a293b3262092977fc662746a8cddacab638eac84395
