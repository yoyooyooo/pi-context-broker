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

- Original analysis: b0d860ce54584498746625df87620e32b2a824d21a07340768b9f7fb5a689691
- Public analysis: 87dac07ed23a3c36d8e233a34ab21ca2b8f6f6fdf9e01f7c2329dfbb17450238
- Unchanged analysis meaning: ab148452a40aafdbade7a536ae099e5e9616ea8ddb8aa1760157640767abaa66
