------------------------- MODULE Availability -------------------------
EXTENDS Naturals
CONSTANTS ReconcileAllObservations, CursorUsesAvailability
VARIABLES remoteEnabled, candidateEnabled, liveDenied, lastKnownEnabled,
          hasCursor, cursorCandidate, cursorAvailability, cursorBroken, lastAction
vars == <<remoteEnabled, candidateEnabled, liveDenied, lastKnownEnabled,
          hasCursor, cursorCandidate, cursorAvailability, cursorBroken, lastAction>>
Available == candidateEnabled /\ ~liveDenied
Init == /\ remoteEnabled = TRUE /\ candidateEnabled = TRUE /\ liveDenied = FALSE
        /\ lastKnownEnabled = TRUE /\ hasCursor = FALSE /\ cursorCandidate = TRUE
        /\ cursorAvailability = TRUE /\ cursorBroken = FALSE /\ lastAction = "Start"
EditNotion == /\ remoteEnabled' = ~remoteEnabled /\ lastAction' = "EditNotion"
              /\ UNCHANGED <<candidateEnabled, liveDenied, lastKnownEnabled,
                             hasCursor, cursorCandidate, cursorAvailability, cursorBroken>>
ReadCurrent == /\ candidateEnabled
               /\ liveDenied' = ~remoteEnabled /\ lastKnownEnabled' = remoteEnabled
               /\ lastAction' = "ReadCurrent"
               /\ UNCHANGED <<remoteEnabled, candidateEnabled, hasCursor,
                              cursorCandidate, cursorAvailability, cursorBroken>>
UseCurrent == /\ candidateEnabled
              /\ liveDenied' = IF ReconcileAllObservations THEN ~remoteEnabled ELSE liveDenied
              /\ lastKnownEnabled' = remoteEnabled /\ lastAction' = "UseCurrent"
              /\ UNCHANGED <<remoteEnabled, candidateEnabled, hasCursor,
                             cursorCandidate, cursorAvailability, cursorBroken>>
RefreshMetadata == /\ candidateEnabled' = remoteEnabled /\ lastKnownEnabled' = remoteEnabled
                   /\ liveDenied' = IF ReconcileAllObservations THEN FALSE ELSE liveDenied
                   /\ lastAction' = "RefreshMetadata"
                   /\ UNCHANGED <<remoteEnabled, hasCursor, cursorCandidate, cursorAvailability, cursorBroken>>
SwitchSession == /\ candidateEnabled' = remoteEnabled /\ lastKnownEnabled' = remoteEnabled
                 /\ liveDenied' = IF ReconcileAllObservations THEN FALSE ELSE liveDenied
                 /\ lastAction' = "SwitchSession"
                 /\ UNCHANGED <<remoteEnabled, hasCursor, cursorCandidate, cursorAvailability, cursorBroken>>
FirstPage == /\ hasCursor' = TRUE /\ cursorCandidate' = candidateEnabled
             /\ cursorAvailability' = Available /\ lastAction' = "FirstPage"
             /\ UNCHANGED <<remoteEnabled, candidateEnabled, liveDenied, lastKnownEnabled, cursorBroken>>
NextPage == /\ hasCursor
            /\ LET accepted == cursorCandidate = candidateEnabled /\
                                  (~CursorUsesAvailability \/ cursorAvailability = Available)
               IN cursorBroken' = (cursorBroken \/ (accepted /\ cursorAvailability # Available))
            /\ hasCursor' = FALSE /\ lastAction' = "NextPage"
            /\ UNCHANGED <<remoteEnabled, candidateEnabled, liveDenied, lastKnownEnabled,
                           cursorCandidate, cursorAvailability>>
Next == EditNotion \/ ReadCurrent \/ UseCurrent \/ RefreshMetadata \/ SwitchSession \/ FirstPage \/ NextPage
TypeOK == /\ remoteEnabled \in BOOLEAN /\ candidateEnabled \in BOOLEAN /\ liveDenied \in BOOLEAN
          /\ lastKnownEnabled \in BOOLEAN /\ hasCursor \in BOOLEAN /\ cursorCandidate \in BOOLEAN
          /\ cursorAvailability \in BOOLEAN /\ cursorBroken \in BOOLEAN
          /\ lastAction \in {"Start", "EditNotion", "ReadCurrent", "UseCurrent", "RefreshMetadata", "SwitchSession", "FirstPage", "NextPage"}
KnownObservationAgrees == Available = lastKnownEnabled
CursorCannotMixAvailability == ~cursorBroken
=============================================================================
