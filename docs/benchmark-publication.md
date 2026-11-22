# Public Benchmark evidence

The public exporter creates derived copies of retained evidence. It preserves the measured results, fixed denominators, unknown values and statistical decisions. It never changes the original evidence or turns a reanalysis into a new execution.

## Export

Import the API from `benchmark/publish.mjs`:

```js
const result = await writePublicEvidencePackage({
  directory: absoluteNewOutputDirectory,
  input: { protocol, episodes, plan }, // plan is the optional fixed analysis plan
  analysis,                           // optional; must match scoreExperiment(input)
  rawRoot: absoluteOwnedEnvironment,
  redactions: {
    secrets: [],                      // explicit values; kept only in memory
    identifiers: [],                  // private identities replaced as exact substrings
    identifier_words: [],             // private standalone identifiers; keep longer public names
    terminal_usernames: [],           // additional terminal account names
    path_prefixes: [],                // additional machine or private roots
  },
});
```

The exporter verifies each original episode fingerprint, raw file SHA256 and source locator before creating public copies. It identifies explicit binding names, UUIDs, machine paths, private endpoints and recognized credential fields and opaque encrypted provider state. It also applies the caller's explicit redaction lists. Private grading material is rejected by structure even if its artifact kind is merely JSON. Opaque binary content requires a separate reviewed publication policy.

Publication version 1.0.1 also replaces POSIX long-listing owner fields and discovers usernames from observed home paths and terminal listings. Whole-token replacement propagates those usernames through plain text, structured tool outputs and raw records. Tokens are bounded by Unicode letters, digits, underscore and hyphen, so a longer public repository name is not changed merely because it starts with a private username. The manifest records this policy and counts, never the private word list.

Callers should supply any additional private strings that are specific to their environment. Pattern matching is not a general personal-data classifier. Deterministic pseudonyms preserve identity relationships; they are not a guarantee of irreversible anonymization.

The function returns the directory, public manifest path and fingerprint, projected analysis and input, verification result, and `model_requests: 0`. Writes are immutable and repeatable: an identical export can be checked again; a different result cannot overwrite an existing member.

## Files

The package contains:

- `public-manifest.json`: original-to-public raw hashes, byte counts, transformation policy, implementation identity, file inventory, and original/public analysis identities.
- `raw/`: public, content-addressed copies.
- `analysis-input.json` and `analysis.json`: derived normalized evidence and the recomputed statistical result.
- `report.md`, CSV tables, and standalone SVG charts.
- `replay.mjs` and exact local analysis modules under `offline/`.
- `sanitizer-source.mjs`: the exporter implementation for inspection.
- `README.md`: the transformation and replay limits.

No credential or private identifier lookup table is written. Raw originals remain in the controlled evidence store.

## Identity and evidence limits

A public file's `public_sha256` identifies its transformed bytes. Its `source_sha256` identifies the original file whose bytes were checked immediately before transformation. They are equal only when the output bytes are unchanged.

JSONL retains one output line per original line. JSON pointers remain valid, including pointers through deterministically renamed private keys. The public normalized episode refers to the transformed file hashes and receives a new episode identity. It includes the original episode hash as provenance.

Hashes inside an original receipt, HTTP body record or hash chain remain historical original claims. Redaction changes the material to which those claims referred. The public package therefore does **not** claim that an original body hash or event chain can be recomputed from the transformed copy.

Before writing, the exporter recomputes the public analysis and checks all statistical results against the original analysis after identity projection. Only reference and protocol/plan/analysis identity metadata may differ. A changed metric, outcome, unknown, fixed denominator, interval or decision aborts the export.

## Offline verification

```sh
node replay.mjs
node replay.mjs --out /absolute/new-report-directory
```

A Node version supporting JSON import attributes is required. Replay needs neither package installation nor credentials. It verifies the manifest, public file hashes and normalized source locators, then reaggregates statistics and checks the public analysis identity.

This scope is deliberately explicit: public replay does not rerun the private business grader, restore removed secrets, reconstruct original hash chains or make a model request.

For verification from another Node program:

```js
await verifyPublicEvidencePackage({ directory: absolutePackageDirectory });
```

The exporter creates local files. Uploading or publishing those files is a separate action.

## Validation

The regression suite exercises actual offline subprocess replay, preserved unknown outcomes and denominators, JSONL line references, UUID-key pointers, original/raw tamper rejection, private oracle detection and binary refusal. A real zero-send invalid episode has also been exported and replayed as an apparatus diagnostic. That diagnostic is not a model-quality result.
