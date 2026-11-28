---------------------- MODULE FreshnessPublication ----------------------
EXTENDS Naturals
CONSTANTS KeepValidationTime, CheckCacheExpiry, ExcludeFixed, RespectOrder,
          RespectGeneration, RespectCancellation, RespectScope,
          ExactFailureTarget, RejectUnknown
VARIABLES scenario, clock, generation, cancelled, returns, rootState,
          childState, validatedAt, validUntil, appliedOrder, appliedLive,
          violations
vars == <<scenario, clock, generation, cancelled, returns, rootState,
          childState, validatedAt, validUntil, appliedOrder, appliedLive,
          violations>>
Scenarios == {"cache-expiry", "old-cache", "fixed", "new-remote",
              "old-request", "foreign-scope", "child-denial", "unknown"}
ViolationNames == {"renewed", "expired", "fixed", "older", "generation",
                   "cancel", "scope", "attribution", "unknown"}
Origin == IF scenario \in {"cache-expiry", "old-cache"} THEN "cache"
          ELSE IF scenario = "fixed" THEN "fixed"
          ELSE IF scenario = "unknown" THEN "unknown" ELSE "remote"
OriginalTime == IF Origin \in {"cache", "fixed"} THEN 1
                ELSE IF scenario = "new-remote" THEN 3 ELSE 2
EvidenceTime == IF Origin = "cache" /\ ~KeepValidationTime THEN clock ELSE OriginalTime
IncomingOrder == IF scenario = "old-request" THEN 1 ELSE 3
IncomingLive == Origin = "remote" \/ (Origin = "unknown" /\ ~RejectUnknown)
IncomingState == IF scenario \in {"old-request", "child-denial"} THEN "denied" ELSE "available"
Limit == IF Origin = "cache" THEN 2 ELSE 1
Init == /\ scenario \in Scenarios /\ clock = 2 /\ generation = 0
        /\ cancelled = FALSE /\ returns = 0 /\ childState = "unknown"
        /\ rootState = IF scenario \in {"old-cache", "new-remote", "unknown"} THEN "denied"
                       ELSE IF scenario \in {"old-request", "child-denial"} THEN "available" ELSE "unknown"
        /\ validatedAt = IF rootState = "unknown" THEN 0 ELSE 2
        /\ validUntil = IF rootState = "unknown" THEN 0 ELSE 2
        /\ appliedOrder = IF rootState = "unknown" THEN 0 ELSE 2
        /\ appliedLive = (rootState # "unknown") /\ violations = {}
AdvanceTime == /\ returns < Limit /\ clock = 2 /\ clock' = 3
               /\ UNCHANGED <<scenario, generation, cancelled, returns, rootState,
                              childState, validatedAt, validUntil, appliedOrder, appliedLive, violations>>
RetireGeneration == /\ returns < Limit /\ generation = 0 /\ generation' = 1
                    /\ UNCHANGED <<scenario, clock, cancelled, returns, rootState,
                                   childState, validatedAt, validUntil, appliedOrder, appliedLive, violations>>
Cancel == /\ returns < Limit /\ ~cancelled /\ cancelled' = TRUE
          /\ UNCHANGED <<scenario, clock, generation, returns, rootState,
                         childState, validatedAt, validUntil, appliedOrder, appliedLive, violations>>
Receive ==
 /\ returns < Limit
 /\ LET current == (~RespectGeneration \/ generation = 0) /\ (~RespectCancellation \/ ~cancelled)
        qualified == (~ExcludeFixed \/ Origin # "fixed") /\ (~RejectUnknown \/ Origin # "unknown")
                     /\ EvidenceTime <= clock
                     /\ (Origin # "cache" \/ ~CheckCacheExpiry \/ EvidenceTime + 2 > clock)
        ordered == ~RespectOrder
                   \/ (~(appliedLive /\ IncomingLive /\ IncomingOrder < appliedOrder)
                       /\ EvidenceTime >= validatedAt /\ (IncomingLive \/ EvidenceTime > validatedAt))
        accepted == current /\ qualified /\ ordered /\ (~RespectScope \/ scenario # "foreign-scope")
        childTarget == scenario = "child-denial" /\ ExactFailureTarget
        rootWrite == accepted /\ ~childTarget
        stale == (appliedLive /\ IncomingLive /\ IncomingOrder < appliedOrder)
                 \/ OriginalTime < validatedAt \/ (~IncomingLive /\ OriginalTime <= validatedAt)
    IN /\ rootState' = IF rootWrite THEN IncomingState ELSE rootState
       /\ childState' = IF accepted /\ childTarget THEN "denied" ELSE childState
       /\ validatedAt' = IF rootWrite THEN EvidenceTime ELSE validatedAt
       /\ validUntil' = IF rootWrite THEN (IF IncomingState = "denied" THEN EvidenceTime ELSE EvidenceTime + 2) ELSE validUntil
       /\ appliedOrder' = IF rootWrite THEN IncomingOrder ELSE appliedOrder
       /\ appliedLive' = IF rootWrite THEN IncomingLive ELSE appliedLive
       /\ violations' = violations \cup {v \in ViolationNames:
             (v = "renewed" /\ accepted /\ Origin = "cache" /\ EvidenceTime # OriginalTime)
          \/ (v = "expired" /\ accepted /\ Origin = "cache" /\ OriginalTime + 2 <= clock)
          \/ (v = "fixed" /\ accepted /\ Origin = "fixed")
          \/ (v = "older" /\ rootWrite /\ stale)
          \/ (v = "generation" /\ accepted /\ generation # 0)
          \/ (v = "cancel" /\ accepted /\ cancelled)
          \/ (v = "scope" /\ accepted /\ scenario = "foreign-scope")
          \/ (v = "attribution" /\ rootWrite /\ scenario = "child-denial")
          \/ (v = "unknown" /\ accepted /\ Origin = "unknown")}
 /\ returns' = returns + 1
 /\ UNCHANGED <<scenario, clock, generation, cancelled>>
Done == /\ returns = Limit /\ UNCHANGED vars
Next == AdvanceTime \/ RetireGeneration \/ Cancel \/ Receive \/ Done
TypeOK == /\ scenario \in Scenarios /\ clock \in 2..3 /\ generation \in 0..1
          /\ cancelled \in BOOLEAN /\ returns \in 0..2
          /\ rootState \in {"unknown", "available", "denied"} /\ childState \in {"unknown", "denied"}
          /\ validatedAt \in 0..3 /\ validUntil \in 0..5 /\ appliedOrder \in 0..3
          /\ appliedLive \in BOOLEAN /\ violations \subseteq ViolationNames
CacheValidationNotRenewed == "renewed" \notin violations
ExpiredCacheCannotPublish == "expired" \notin violations
FixedContentIsNotCurrent == "fixed" \notin violations
NewerEvidenceSurvives == "older" \notin violations
NoRetiredPublication == "generation" \notin violations
NoCancelledPublication == "cancel" \notin violations
ScopeIsExact == "scope" \notin violations
DependencyFailureIsLocal == "attribution" \notin violations
UnknownIsNotPermission == "unknown" \notin violations
=============================================================================
