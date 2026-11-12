------------------------- MODULE DeliveryBoundary -------------------------
EXTENDS Naturals
CONSTANTS RequireProviderAcceptance, RequireCompleteDelivery, RequireCompletedTurn,
          RequirePublicProjection, RespectLifecycle, RespectBranch
VARIABLES scenario, phase, generation, cancelled, branch, providerAccepted,
          turnCompleted, active, persisted, publicReceipt, attempts, violations
vars == <<scenario, phase, generation, cancelled, branch, providerAccepted,
          turnCompleted, active, persisted, publicReceipt, attempts, violations>>
Scenarios == {"valid", "partial", "foreign-scope", "wrong-pin", "wrong-hash",
              "rejected", "no-response", "failed-turn"}
Phases == {"prepared", "request", "response", "finished", "offered", "applied", "retryable", "done"}
ViolationNames == {"graph", "acceptance", "completion", "projection", "lifecycle", "branch"}
BoundGraph == scenario \notin {"partial", "foreign-scope", "wrong-pin", "wrong-hash"}
Current == generation = 0 /\ ~cancelled
CurrentBranch == branch = 0
EffectiveVersion == IF active /\ (~RespectBranch \/ CurrentBranch) THEN 2 ELSE 1
Allowed == (~RespectLifecycle \/ Current) /\ (~RespectBranch \/ CurrentBranch)
ProofFailures(accepted, persistence, projected) ==
 {v \in ViolationNames:
       (v = "graph" /\ ~BoundGraph)
    \/ (v = "acceptance" /\ ~accepted)
    \/ (v = "completion" /\ persistence /\ ~turnCompleted)
    \/ (v = "projection" /\ persistence /\ ~projected)
    \/ (v = "lifecycle" /\ ~Current)
    \/ (v = "branch" /\ ~CurrentBranch)}
Init == /\ scenario \in Scenarios /\ phase = "prepared"
        /\ generation = 0 /\ cancelled = FALSE /\ branch = 0
        /\ providerAccepted = FALSE /\ turnCompleted = FALSE
        /\ active = FALSE /\ persisted = FALSE /\ publicReceipt = FALSE
        /\ attempts = 0 /\ violations = {}
SendRequest == /\ phase = "prepared" /\ phase' = "request"
               /\ UNCHANGED <<scenario, generation, cancelled, branch, providerAccepted,
                              turnCompleted, active, persisted, publicReceipt, attempts, violations>>
ReceiveHeaders ==
 /\ phase = "request" /\ scenario # "no-response"
 /\ LET accepted == scenario # "rejected"
        confirm == (accepted \/ ~RequireProviderAcceptance)
                   /\ (BoundGraph \/ ~RequireCompleteDelivery) /\ Allowed
    IN /\ providerAccepted' = accepted
       /\ active' = (active \/ confirm)
       /\ violations' = IF confirm THEN violations \cup ProofFailures(accepted, FALSE, FALSE) ELSE violations
 /\ phase' = "response"
 /\ UNCHANGED <<scenario, generation, cancelled, branch, turnCompleted,
                persisted, publicReceipt, attempts>>
FinishTurn == /\ (phase = "response" \/ (phase = "request" /\ scenario = "no-response"))
              /\ turnCompleted' = (scenario # "failed-turn") /\ phase' = "finished"
              /\ UNCHANGED <<scenario, generation, cancelled, branch, providerAccepted,
                             active, persisted, publicReceipt, attempts, violations>>
OfferDraft ==
 /\ phase = "finished" /\ attempts < 2
 /\ LET offer == (providerAccepted \/ ~RequireProviderAcceptance)
                 /\ (BoundGraph \/ ~RequireCompleteDelivery)
                 /\ (turnCompleted \/ ~RequireCompletedTurn) /\ Allowed
        premature == offer /\ ~RequirePublicProjection /\ ~persisted
    IN /\ phase' = IF offer THEN "offered" ELSE "done"
       /\ attempts' = IF offer THEN attempts + 1 ELSE attempts
       /\ persisted' = (persisted \/ premature)
       /\ violations' = IF premature THEN violations \cup ProofFailures(providerAccepted, TRUE, FALSE) ELSE violations
 /\ UNCHANGED <<scenario, generation, cancelled, branch, providerAccepted,
                turnCompleted, active, publicReceipt>>
ApplyDraft == /\ phase = "offered" /\ CurrentBranch
              /\ publicReceipt' = TRUE /\ phase' = "applied"
              /\ UNCHANGED <<scenario, generation, cancelled, branch, providerAccepted,
                             turnCompleted, active, persisted, attempts, violations>>
DiscardDraft == /\ phase = "offered" /\ publicReceipt' = FALSE /\ phase' = "applied"
                /\ UNCHANGED <<scenario, generation, cancelled, branch, providerAccepted,
                               turnCompleted, active, persisted, attempts, violations>>
ObserveProjection ==
 /\ phase = "applied"
 /\ LET publish == (publicReceipt \/ ~RequirePublicProjection) /\ Allowed /\ ~persisted
    IN /\ persisted' = (persisted \/ publish)
       /\ violations' = IF publish THEN violations \cup ProofFailures(providerAccepted, TRUE, publicReceipt) ELSE violations
       /\ phase' = IF ~publicReceipt /\ ~persisted /\ attempts < 2 THEN "retryable" ELSE "done"
 /\ UNCHANGED <<scenario, generation, cancelled, branch, providerAccepted,
                turnCompleted, active, publicReceipt, attempts>>
RetryRequest == /\ phase = "retryable" /\ Current /\ CurrentBranch
                /\ phase' = "request" /\ providerAccepted' = FALSE /\ turnCompleted' = FALSE
                /\ UNCHANGED <<scenario, generation, cancelled, branch, active,
                               persisted, publicReceipt, attempts, violations>>
StopRetry == /\ phase = "retryable" /\ phase' = "done"
             /\ UNCHANGED <<scenario, generation, cancelled, branch, providerAccepted,
                            turnCompleted, active, persisted, publicReceipt, attempts, violations>>
BoundaryOpen == phase \in {"request", "response", "finished", "offered", "applied"} /\ Current /\ CurrentBranch
Cancel == /\ BoundaryOpen /\ cancelled' = TRUE
          /\ UNCHANGED <<scenario, phase, generation, branch, providerAccepted,
                         turnCompleted, active, persisted, publicReceipt, attempts, violations>>
SwitchGeneration == /\ BoundaryOpen /\ generation' = 1
                    /\ UNCHANGED <<scenario, phase, cancelled, branch, providerAccepted,
                                   turnCompleted, active, persisted, publicReceipt, attempts, violations>>
RewindBranch == /\ BoundaryOpen /\ branch' = 1 /\ publicReceipt' = FALSE
                /\ UNCHANGED <<scenario, phase, generation, cancelled, providerAccepted,
                               turnCompleted, active, persisted, attempts, violations>>
Done == /\ phase = "done" /\ UNCHANGED vars
Next == SendRequest \/ ReceiveHeaders \/ FinishTurn \/ OfferDraft \/ ApplyDraft \/ DiscardDraft
        \/ ObserveProjection \/ RetryRequest \/ StopRetry \/ Cancel \/ SwitchGeneration \/ RewindBranch \/ Done
TypeOK == /\ scenario \in Scenarios /\ phase \in Phases /\ generation \in 0..1
          /\ cancelled \in BOOLEAN /\ branch \in 0..1 /\ providerAccepted \in BOOLEAN
          /\ turnCompleted \in BOOLEAN /\ active \in BOOLEAN /\ persisted \in BOOLEAN
          /\ publicReceipt \in BOOLEAN /\ attempts \in 0..2 /\ violations \subseteq ViolationNames
CompleteBoundGraphForActive == "graph" \notin violations
ProviderAcceptanceBeforeProof == "acceptance" \notin violations
CompletionBeforePersistence == "completion" \notin violations
PublicProjectionBeforePersistence == "projection" \notin violations
NoRetiredDeliveryProof == "lifecycle" \notin violations
CurrentBranchOwnsProof == "branch" \notin violations /\ (branch # 0 => EffectiveVersion = 1)
=============================================================================
