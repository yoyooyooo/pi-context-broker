# Decision draft: retain the Terra interruption and continue unsent work

Status: **awaiting a new decision; not an execution authorization**.

Evidence and accounting are documented in the [Terra stop report](README.md). The earlier Grok and collector-correction evidence is preserved in the [preceding checkpoint](../2026-11-23-continuation-checkpoint/README.md).

## The specific decision

Accept the newly observed Terra stream interruption as an additional retained historical failure, then prepare, independently review, verify and freeze a prospective amendment for the **73 previously allocated, never-started episodes** below. No episode may start under this draft.

The earlier approval of proposal 2 remains valid for its ordinary implementation, review, verification, integration and bounded execution work. Its constraints also require any later new core stop or unknown usage to stop dispatch again. That condition was met by Terra episode 008. The current controller correctly rejects continuation; a new decision about this additional unknown is needed before a separate prospective amendment can permit more dispatch.

## Evidence that must remain fixed

- The campaign has 66 completed physical reservations. Its existing approved ceiling is 139, within the original hard limit of 144. The other five reservations are unallocated.
- Terra attempted all eight planned slots. Seven are valid; episode 008 is invalid with a retained core stop. The scientific denominator remains eight, with one unresolved valid observation.
- Episode 008 sent two real requests. The first has 3,876 input and 36 output tokens. The second received HTTP 200 and a partial event stream, then the SDK reported an interrupted response. The retained stream has no usage or completion marker from which exact token totals could be recovered.
- The attempted automatic retry was blocked before another request was sent. The episode's total input and output tokens remain unknown. The request count stays two.
- Registered effective history now contains five episodes with unknown token usage; the original completion records contain six. A previously registered historical correction explains that difference. Neither history is rewritten by this proposal.
- The actual public route-gate command failed with `FINITE_ORIGINAL_CORE_STOP`. Terra has no passed route gate. A future amendment must not turn this failed gate into a passed attestation.

## Unsent work retained from the existing allocation

| Order | Work | Episodes | Current preparation |
| --- | --- | ---: | --- |
| 1 | Original expansion's never-started follow-up | 11 | Source slots and setup draft retained; not activated or configured |
| 2 | Unseen reference/candidate product confirmation | 20 | Both actual builds verified; material sealed but unopened; no configured comparison |
| 3 | Code Mode acceptance | 24 | Verified material and configuration draft ready |
| 4 | Candidate scale and multiround checks | 10 | Five two-episode scopes; 16/64/256-candidate material verified |
| 5 | Store-fault acceptance | 8 | Configuration draft ready; configure-time fixtures not created |
| | **Total** | **73** | **No subsequent scope is registered or dispatched** |

The independent cold Skill operator's eight slots remain a subset of the 20 product-confirmation episodes. They are not eight extra reservations. This is one cold start followed by three continuation windows. Auxiliary operator tokens and cost remain separate from subject-model accounting and unknown unless actually measured.

## Conditions of a prospective continuation

1. Retain all 66 reservations, original evidence, stopped scopes, failure costs, unknown values, scientific denominators and existing analysis identities. Do not rerun or replace Terra 008, the earlier Grok alias failure, or any other completed or invalid episode.
2. Keep the approved ceiling at 139. Allocate no extra episodes, use none of the five unallocated reservations, and keep Flash deferred. No further Terra episode is proposed.
3. Use an explicit new prospective amendment bound to the actual stopped history and the existing allocation. Review and verify that amendment independently before freezing or executing it. The current frozen controller, old authorization, registrations and guard results remain unchanged.
4. Bind the actual controller, product builds, next slots, budget and model window at activation. If the retained model window has expired, declare a new window for future observations and preserve the resulting comparability boundary. Do not relabel old observations as current.
5. Continue in the fixed order above. Existing public operator windows may bound each invocation; they do not reset cumulative episode, request, token or subject-duration caps.
6. Stop again on any later new core stop or unknown usage. This draft is not a blanket exception for future interruptions, retries or evidence gaps.
7. Keep route validity, business output, complete-contract quality and product acceptance separate. The seven valid Terra observations and prepared later materials do not establish product acceptance.

## Why this continuation is proposed

The captured partial stream and interruption evidence are retained, and the missing token total cannot be repaired from the available evidence. Rerunning Terra 008 as a new episode would create a different observation and spend an extra reservation. The remaining allocation addresses separate, already specified work and does not include another Terra slot. A prospective amendment can retain the failed gate and incomplete accounting while making the requested remaining work explicit and reviewable.

Until that new decision and amendment exist, the correct campaign state is **stopped after Terra 008**, with all 73 later episodes unsent.
