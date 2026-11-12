------------------------ MODULE AcquisitionEffects ------------------------
EXTENDS Naturals
CONSTANTS StrictReadOnly, SdkCompatible, KeepPriorEffects, KeepUnknown,
          RequireCompleteSelection, EnforceReadOnly, RequireSdkCapability, HonestReporter
VARIABLE s
vars == <<s>>
SecondKinds == {"ready_none","ready_retained","failed_none","failed_unknown","cancelled"}
Init == \E a \in {"none","retained"}, b \in SecondKinds :
  s = [phase |-> "capability", firstKind |-> a, secondKind |-> b,
       writes |-> 0, confirmed |-> {}, visible |-> {}, effect |-> "none",
       unknown |-> FALSE, firstReady |-> FALSE, secondReady |-> FALSE,
       selected |-> FALSE, dispatched |-> FALSE, zeroClaim |-> FALSE]

\* This is the SDK/manifest capability boundary, before any producer call.
RejectLegacySdk == /\ s.phase = "capability" /\ StrictReadOnly /\ ~SdkCompatible /\ RequireSdkCapability
                   /\ s' = [s EXCEPT !.phase = "failed"]
DispatchFirst == /\ s.phase = "capability"
                 /\ (~StrictReadOnly \/ SdkCompatible \/ ~RequireSdkCapability)
                 /\ s' = [s EXCEPT !.phase = "first-call", !.dispatched = TRUE]
RejectFirstWrite == /\ s.phase = "first-call" /\ s.firstKind = "retained"
                    /\ StrictReadOnly /\ EnforceReadOnly
                    /\ s' = [s EXCEPT !.phase = "failed"]
FirstNoWrite == /\ s.phase = "first-call" /\ s.firstKind = "none"
                /\ s' = [s EXCEPT !.phase = "second-call", !.firstReady = TRUE]
FirstWrite == /\ s.phase = "first-call" /\ s.firstKind = "retained"
              /\ (~StrictReadOnly \/ ~EnforceReadOnly)
              /\ s' = [s EXCEPT !.phase = "first-effect", !.writes = @ + 1]
FirstReceipt == /\ s.phase = "first-effect"
                /\ s' = [s EXCEPT !.phase = "second-call", !.firstReady = TRUE,
                           !.confirmed = {1}, !.visible = {1}, !.effect = "retained"]
SecondNoWrite == /\ s.phase = "second-call"
                 /\ s.secondKind \in {"ready_none","failed_none","cancelled"}
                 /\ s' = [s EXCEPT !.phase = "merge", !.secondReady = (s.secondKind = "ready_none")]
RejectSecondWrite == /\ s.phase = "second-call"
                     /\ s.secondKind \in {"ready_retained","failed_unknown"}
                     /\ StrictReadOnly /\ EnforceReadOnly
                     /\ s' = [s EXCEPT !.phase = "merge"]
SecondWrite == /\ s.phase = "second-call"
               /\ s.secondKind \in {"ready_retained","failed_unknown"}
               /\ (~StrictReadOnly \/ ~EnforceReadOnly)
               /\ s' = [s EXCEPT !.phase = "second-effect", !.writes = @ + 1]
\* External write and durable observation are separate transitions.
SecondReceipt == /\ s.phase = "second-effect" /\ s.secondKind = "ready_retained"
                 /\ s' = [s EXCEPT !.phase = "merge", !.secondReady = TRUE,
                            !.confirmed = @ \cup {2}]
SecondAckUnknown == /\ s.phase = "second-effect" /\ s.secondKind = "failed_unknown"
                    /\ s' = [s EXCEPT !.phase = "merge", !.unknown = TRUE]
\* Cancellation/failure is not rollback. Unknown has precedence over retained.
MergeEffects ==
  LET facts == IF KeepPriorEffects \/ s.secondReady THEN s.confirmed ELSE s.confirmed \ {1}
      disclosed == IF s.unknown /\ KeepUnknown THEN "unknown"
                   ELSE IF facts # {} THEN "retained" ELSE "none"
  IN /\ s.phase = "merge"
     /\ s' = [s EXCEPT !.phase = IF s.firstReady /\ s.secondReady THEN "ready" ELSE "failed",
                        !.visible = facts, !.effect = disclosed]
CommitSelection == /\ s.phase = "ready" \/ (s.phase = "failed" /\ ~RequireCompleteSelection)
                   /\ s' = [s EXCEPT !.phase = "selected", !.selected = TRUE]
\* These are distinct consumer contract ports, not assertions of real wire evidence.
ProviderAccepted == /\ s.phase = "selected" /\ s' = [s EXCEPT !.phase = "accepted"]
TurnCompleted == /\ s.phase = "accepted" /\ s' = [s EXCEPT !.phase = "completed"]
PersistReceipt == /\ s.phase = "completed" /\ s' = [s EXCEPT !.phase = "persisted"]
\* Only this controlled reporter is constrained; arbitrary LLM prose is excluded.
Report == /\ s.phase \in {"failed","persisted"}
          /\ s' = [s EXCEPT !.phase = "reported", !.zeroClaim = (~HonestReporter \/ s.effect = "none")]
Done == /\ s.phase = "reported" /\ UNCHANGED vars
Next == RejectLegacySdk \/ DispatchFirst \/ RejectFirstWrite \/ FirstNoWrite \/ FirstWrite
        \/ FirstReceipt \/ SecondNoWrite \/ RejectSecondWrite \/ SecondWrite \/ SecondReceipt
        \/ SecondAckUnknown \/ MergeEffects \/ CommitSelection \/ ProviderAccepted
        \/ TurnCompleted \/ PersistReceipt \/ Report \/ Done
Public == s.phase \in {"ready","failed","selected","accepted","completed","persisted","reported"}
TypeOK == /\ s.phase \in {"capability","first-call","first-effect","second-call","second-effect",
                          "merge","ready","failed","selected","accepted","completed","persisted","reported"}
          /\ s.firstKind \in {"none","retained"} /\ s.secondKind \in SecondKinds
          /\ s.writes \in 0..2 /\ s.confirmed \subseteq {1,2} /\ s.visible \subseteq {1,2}
          /\ s.effect \in {"none","retained","unknown"} /\ s.unknown \in BOOLEAN
          /\ s.firstReady \in BOOLEAN /\ s.secondReady \in BOOLEAN
          /\ s.selected \in BOOLEAN /\ s.dispatched \in BOOLEAN /\ s.zeroClaim \in BOOLEAN
ConfirmedFactsPreserved == Public => s.confirmed \subseteq s.visible
UnknownEffectIsSticky == (Public /\ s.unknown) => s.effect = "unknown"
CompleteSelectionOnly == s.selected => (s.firstReady /\ s.secondReady)
StrictReadOnlyHasNoWrites == StrictReadOnly => s.writes = 0
CompatibleSdkBeforeDispatch == (StrictReadOnly /\ ~SdkCompatible) => ~s.dispatched
NoFalseZeroWriteReport == s.zeroClaim => (s.writes = 0 /\ ~s.unknown)
=============================================================================

