------------------------ MODULE RetentionDisclosure ------------------------
EXTENDS Naturals
CONSTANTS ExposeObservedEffects, ClaimZeroWithoutEvidence,
          StrictReadOnly, EnforceReadOnly, LoseAcknowledgement
VARIABLES phase, sourceChanged, writes, effect, zeroClaim, outcome
vars == <<phase,sourceChanged,writes,effect,zeroClaim,outcome>>
Init == /\ phase = "fixed" /\ sourceChanged = FALSE /\ writes = 0
        /\ effect = "absent" /\ zeroClaim = FALSE /\ outcome = "pending"
EditNotion == /\ phase = "fixed" /\ phase' = "changed" /\ sourceChanged' = TRUE
              /\ UNCHANGED <<writes,effect,zeroClaim,outcome>>
RequestFixed == /\ phase = "fixed" /\ phase' = "ready" /\ outcome' = "ready"
                /\ effect' = IF ExposeObservedEffects THEN "none" ELSE "absent"
                /\ UNCHANGED <<sourceChanged,writes,zeroClaim>>
RequestCurrent == /\ phase = "changed" /\ phase' = "reading"
                  /\ UNCHANGED <<sourceChanged,writes,effect,zeroClaim,outcome>>
RejectBeforeWrite == /\ phase = "reading" /\ StrictReadOnly /\ EnforceReadOnly
                     /\ phase' = "failed" /\ outcome' = "failed" /\ effect' = "none"
                     /\ UNCHANGED <<sourceChanged,writes,zeroClaim>>
RetainObservedContent == /\ phase = "reading" /\ sourceChanged
                         /\ (~StrictReadOnly \/ ~EnforceReadOnly)
                         /\ phase' = "retained" /\ writes' = 1
                         /\ UNCHANGED <<sourceChanged,effect,zeroClaim,outcome>>
ReturnReady == /\ phase = "retained" /\ ~LoseAcknowledgement
               /\ phase' = "ready" /\ outcome' = "ready"
               /\ effect' = IF ExposeObservedEffects THEN "retained" ELSE "absent"
               /\ UNCHANGED <<sourceChanged,writes,zeroClaim>>
LoseAck == /\ phase = "retained" /\ LoseAcknowledgement
           /\ phase' = "failed" /\ outcome' = "failed"
           /\ effect' = IF ExposeObservedEffects THEN "unknown" ELSE "absent"
           /\ UNCHANGED <<sourceChanged,writes,zeroClaim>>
Report == /\ phase \in {"ready","failed"} /\ phase' = "reported"
          /\ zeroClaim' = (ClaimZeroWithoutEvidence \/ effect = "none")
          /\ UNCHANGED <<sourceChanged,writes,effect,outcome>>
Done == /\ phase = "reported" /\ UNCHANGED vars
Next == EditNotion \/ RequestFixed \/ RequestCurrent \/ RejectBeforeWrite
        \/ RetainObservedContent \/ ReturnReady \/ LoseAck \/ Report \/ Done
TypeOK == /\ phase \in {"fixed","changed","reading","retained","ready","failed","reported"}
          /\ sourceChanged \in BOOLEAN /\ writes \in 0..1
          /\ effect \in {"absent","none","retained","unknown"} /\ zeroClaim \in BOOLEAN
          /\ outcome \in {"pending","ready","failed"}
ReadyReportsObservedRetention == outcome # "ready" \/ phase \notin {"ready","reported"} \/ writes = 0 \/ effect = "retained"
NoFalseZeroWriteReport == ~zeroClaim \/ writes = 0
ReadOnlyHasNoRemoteWrites == ~StrictReadOnly \/ writes = 0
UnknownOutcomeIsDisclosed == outcome # "failed" \/ writes = 0 \/ effect = "unknown"
=============================================================================
