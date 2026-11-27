# Grade a natural final answer

A natural business question may complete in the assistant's answer. It does not
need an artificial JSON output file. Declare the public completion as
{ "kind": "final-answer", "paths": [] } and keep all truth outside the subject
workspace. Existing artifact-json contracts retain their original behavior.
A case may still declare output paths when files are also required.

The private oracle uses an explicit turn and assessment:

~~~json
{
  "schema_version": 1,
  "case_id": "source-question",
  "capability_scope": "common",
  "required_capabilities": [],
  "facts": {
    "total": { "anyOf": ["total: 7", "sum: 7"] },
    "uncertainty": { "anyOf": ["ownership is unproven", "source is unknown"] },
    "unsupported-claim": { "anyOf": ["ownership confirmed"] }
  },
  "contracts": [
    {
      "id": "answer",
      "kind": "final-answer",
      "turn_id": "turn-1",
      "assessment": "semantic-review",
      "all": ["total"],
      "any": ["uncertainty"],
      "none": ["unsupported-claim"],
      "critical": true
    }
  ]
}
~~~

The all, any, and none fields reuse natural workflow output semantics: all
required facts must match, at least one alternative must match when declared,
and no forbidden fact may match. Each fact matches any of its literal anyOf
values after NFKC normalization, whitespace folding, and English-locale
lowercasing. These are necessary text conditions, not whole-answer equality.

Choose necessary-facts only when the declared text conditions themselves are
the intended bounded contract. Its pass establishes those conditions, not full
semantic correctness. Choose semantic-review for claims such as ownership,
dependency, provenance, or unresolved relations. In that mode text checks are
diagnostic: a paraphrase may miss them, and a negated or quoted statement may
contain them. Without an independent semantic review the business outcome stays
unknown, whether or not the text checks match.

## Retained answer and review evidence

The collector derives text only from the referenced original user_turn_end
event for the declared turn. The event must be unique, settled, idle, and retain
final_text. A separately supplied turn summary cannot replace the original.
Missing, conflicting, or incomplete evidence stays unknown. A proven completed
turn with no answer fails the deliverable contract. File-output checks do not
manufacture an answer.

For independent review, read the complete retained answer and the frozen private
truth. Save a new controller-only file outside the subject run root:

~~~json
{
  "schema_version": 1,
  "kind": "benchmark-final-answer-review",
  "run_id": "observed-run",
  "case_id": "source-question",
  "oracle_sha256": "EXACT_PRIVATE_ORACLE_FILE_SHA256",
  "reviews": [
    {
      "contract_id": "answer",
      "turn_id": "turn-1",
      "answer_sha256": "EXACT_RETAINED_ANSWER_SHA256",
      "status": "pass",
      "reason": "Explain the independent judgment against the complete answer and truth.",
      "reviewer": "identified-independent-reviewer",
      "method": "independent-semantic-review"
    }
  ]
}
~~~

Status is pass, fail, or unknown. A review may accept a correct paraphrase or
reject a misleading answer despite mechanical matches. Conflicting multiple
reviews leave the contract unknown.

Pass { path, sha256 } as finalAnswerReview to the existing collectEpisode
function, together with the original raw run, binding, and frozen protocol. Use a
new owned outputDirectory and identify the original collection through
reanalysisOf; retain the original unknown result. This is another collection of
the same run, not a new model sample.

Collection verifies the review file's original hash, run, case, private-oracle
hash, contract, turn, and exact answer hash. Its evidence references retain the
original event and review file. The hash establishes bytes and linkage; it does
not independently certify the reviewer's independence or correctness. The review
is controller input after the run and is never copied into the subject prompt.
