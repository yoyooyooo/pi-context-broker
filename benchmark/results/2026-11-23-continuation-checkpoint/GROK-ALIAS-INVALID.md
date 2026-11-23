# Retained Grok alias-invalid execution

This package preserves execution 51 in the 58-execution census. It is the original retained failure preceding the seven later Grok executions. One execution was started from this original eight-slot plan; its admission is invalid and its batch stopped. The seven other slots were not started in this plan.

## Accounting and validity

| Field | Retained value |
|---|---|
| Actual provider requests | 1 |
| Input tokens | 5,789 |
| Output tokens | 349 |
| Duration | 12,427.293291 ms |
| Monetary cost | Unknown; route pricing is unverified |
| Admission | Invalid |
| Valid scientific executions in this package | 0 |
| Original planned slots | 8 |
| Unresolved scientific slots | 8 |

The reported model label was group/auto-grok-4-7. The frozen plan rejected it under its original reported-model rules. The admission reasons remain reported_model_mismatch and runtime_not_a_business_episode:invalid. The retained stop reason remains subject_requested_stop. No newer alias allowlist was applied retroactively.

This execution already had known token usage in its original completion and raw evidence. Its original episode is also its effective episode, and it has no applied analysis revision. Corrections to other historical executions must not be attributed to this run. The recorded monetary cost remains unknown.

## Relation to Grok7

The later seven-execution scope continues the linked scheduling history. Keep this invalid execution for physical request and usage accounting. Do not count it as an eighth valid result, and do not add the original and later plans as sixteen independent scientific slots. Each standalone report preserves its own frozen plan.

## Provenance and replay

grok-alias-invalid-provenance.json binds the census row, original plan, batch ledger, actual scope-registration-005, scope amendment, original episode, and source/public analysis identities. The raw evidence mapping in grok-alias-invalid/public-manifest.json links the retained original hashes to their redacted public copies. No revision record was invented.

The source analysis is 3d73deaafc769a16c354089fc2351a36793c6ae3fc0258d1fb187c303915baa2. The public analysis is e97f7c824fdd4dbbe725138b5c54feabb2bdf0be82e5ac52632da04198bbf41a.

Run the existing standalone replay from the directory containing the package:

    node grok-alias-invalid/replay.mjs

The independent replay passed with network access denied, no inherited credentials, and source file contents denied in both the current environment and historical ledger environment. Read probes against the original plan and scope registration were denied. Path metadata remained available for Node module resolution.

Public replay verifies public file hashes, source locators, and statistical reaggregation from normalized observations. It does not rerun the private grader, reconstruct original raw hash chains, or replay the private finite-campaign registration ledger. Registration and ledger hashes in the provenance file are audit pointers.

All 198 protected source files remained byte-identical during preparation. This preparation made zero model requests, ledger writes, Notion writes, source changes, or uploads.
