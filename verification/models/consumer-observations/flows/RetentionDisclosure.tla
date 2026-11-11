------------------------ MODULE RetentionDisclosure ------------------------
EXTENDS Naturals
CONSTANTS ExposeObservedEffects, ClaimZeroWithoutEvidence
VARIABLES phase, sourceChanged, writes, effect, zeroClaim
vars == <<phase,sourceChanged,writes,effect,zeroClaim>>
Init == /\ phase = "fixed" /\ sourceChanged = FALSE /\ writes = 0
        /\ effect = "absent" /\ zeroClaim = FALSE
EditNotion == /\ phase = "fixed" /\ phase' = "changed" /\ sourceChanged' = TRUE
              /\ UNCHANGED <<writes,effect,zeroClaim>>
RequestCurrent == /\ phase = "changed" /\ phase' = "reading"
                  /\ UNCHANGED <<sourceChanged,writes,effect,zeroClaim>>
RetainObservedContent == /\ phase = "reading" /\ sourceChanged
                         /\ phase' = "retained" /\ writes' = 1
                         /\ UNCHANGED <<sourceChanged,effect,zeroClaim>>
ReturnReady == /\ phase = "retained" /\ phase' = "ready"
               /\ effect' = IF ExposeObservedEffects THEN "retained" ELSE "absent"
               /\ UNCHANGED <<sourceChanged,writes,zeroClaim>>
Report == /\ phase = "ready" /\ phase' = "reported"
          /\ zeroClaim' = ClaimZeroWithoutEvidence
          /\ UNCHANGED <<sourceChanged,writes,effect>>
Done == /\ phase = "reported" /\ UNCHANGED vars
Next == EditNotion \/ RequestCurrent \/ RetainObservedContent \/ ReturnReady \/ Report \/ Done
TypeOK == /\ phase \in {"fixed","changed","reading","retained","ready","reported"}
          /\ sourceChanged \in BOOLEAN /\ writes \in 0..1 /\ effect \in {"absent","retained"}
          /\ zeroClaim \in BOOLEAN
ReadyReportsObservedRetention == phase \notin {"ready","reported"} \/ writes = 0 \/ effect = "retained"
NoFalseZeroWriteReport == ~zeroClaim \/ writes = 0
=============================================================================
