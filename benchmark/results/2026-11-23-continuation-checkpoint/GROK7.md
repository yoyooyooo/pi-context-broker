# Grok seven-execution public evidence

This release describes the retained seven-execution Grok scope. It preserves the original collector 1.1.0 observations. Publication version 1.0.6 transforms evidence for public inspection and checks that outcomes, denominators, intervals, and decisions remain unchanged.

## Results and scope

| Measure | Result |
| --- | --- |
| Scientific plan | 8 slots |
| Valid recorded executions | 7 |
| Complete-contract outcomes | 3 pass, 3 fail, 1 unknown |
| Business output outcomes | 5 pass, 2 fail |
| Unresolved slot | Broker m0-e0, no-skill-02 |
| Known subject usage | 35 requests, 275,332 input tokens, 8,702 output tokens |
| Native weighted verified quality | 66.7%, with a 95% interval of 0% to 100% |
| General paired decision | Rejected at critical_contracts |

The Native quality percentage uses the predefined weights. Its raw count is 2 passes among 4 valid executions. Broker has 1 pass and 2 failures among 3 valid executions, with one planned slot unresolved; its complete-batch quality estimate is unavailable. The paired decision has its stated analysis scope and does not establish a route-gate result or product acceptance.

The earlier alias-invalid experiment remains a separate historical invalid result. It is not an eighth valid observation in this package. Public projection and replay refer to the same seven physical executions, so they add no samples.

## Evidence and replay

The package contains 334 files totaling 15,315,582 bytes, including its public manifest. That manifest records original-to-public hashes, transformed byte counts, the privacy policy, and the exact file inventory.

Run `node grok7/replay.mjs` from this directory to verify public hashes and source locators and reaggregate the normalized observations. Use `node grok7/replay.mjs --out /absolute/new-report-directory` to regenerate the report. Replay needs a Node version supporting JSON import attributes and no package installation or credentials.

An independent copy passed replay with OS network access denied and original-environment file contents unreadable. Directory metadata remained available for Node path resolution. Separate probes confirmed that the public manifest was readable, an original evidence file was denied, and a loopback listener was denied. The public file inventory was unchanged after replay.

The regenerated analysis, CSV tables, and quality chart match the exported bytes. The input and time charts have identical content after accounting for the existing report title wording. The public titles are "Cumulative input" and "Capped time"; the regenerated titles are "Cumulative input across actual attempts" and "Capped time across the full fixed denominator". The full reports are not claimed to be byte-identical.

Replay does not rerun private business grading, reconstruct original raw hash chains, recover redacted data, or create executions. Deterministic pseudonyms preserve relationships and do not guarantee irreversible anonymization. The only approved binary content is the existing six-byte synthetic fixture recorded in the manifest.

Publication and replay made zero subject model requests. Auxiliary agent token use and cost are unknown.

## Provenance

- Original analysis identity: `4e5a4e0cf1f1ccd8d4b2f6eb2c0022af16f37ef4ae27bede75b17315e3c9e2a6`
- Public analysis identity: `b11caa821731a440fc57b22a83eff914d4b552c8286804189bc7581e857ffa49`
- Public manifest identity: `2a7077d566443e71edb3ba4a5b8ae0977883cb70cd64201c12e07e56386b2d9c`

See `grok7-provenance.json` for the complete identities and the bounded replay receipt. The package's own `grok7/README.md` describes the transformation policy.
