--------------------------- MODULE ReadRace ---------------------------
EXTENDS Naturals
CONSTANTS RespectRequestOrder, RespectGeneration
VARIABLES remoteEnabled, requestState, captured, requestEpoch, epoch, started,
          appliedId, expectedId, displayedEnabled, expectedEnabled, wrongEpoch, lastAction
Ids == 1..2
vars == <<remoteEnabled, requestState, captured, requestEpoch, epoch, started,
          appliedId, expectedId, displayedEnabled, expectedEnabled, wrongEpoch, lastAction>>
Init == /\ remoteEnabled = FALSE /\ requestState = [i \in Ids |-> "new"]
        /\ captured = [i \in Ids |-> FALSE] /\ requestEpoch = [i \in Ids |-> 0]
        /\ epoch = 0 /\ started = 0 /\ appliedId = 0 /\ expectedId = 0
        /\ displayedEnabled = FALSE /\ expectedEnabled = FALSE /\ wrongEpoch = FALSE
        /\ lastAction = "Start"
EnableInNotion == /\ ~remoteEnabled /\ remoteEnabled' = TRUE /\ lastAction' = "EnableInNotion"
                  /\ UNCHANGED <<requestState, captured, requestEpoch, epoch, started,
                                 appliedId, expectedId, displayedEnabled, expectedEnabled, wrongEpoch>>
Begin(i) == /\ i = started + 1 /\ i \in Ids
            /\ requestState' = [requestState EXCEPT ![i] = "pending"]
            /\ captured' = [captured EXCEPT ![i] = remoteEnabled]
            /\ requestEpoch' = [requestEpoch EXCEPT ![i] = epoch]
            /\ started' = i /\ lastAction' = IF i = 1 THEN "BeginOld" ELSE "BeginNew"
            /\ UNCHANGED <<remoteEnabled, epoch, appliedId, expectedId, displayedEnabled, expectedEnabled, wrongEpoch>>
Finish(i) == /\ requestState[i] = "pending"
             /\ LET sameEpoch == requestEpoch[i] = epoch
                    accept == (~RespectGeneration \/ sameEpoch) /\ (~RespectRequestOrder \/ i >= appliedId)
                    newestKnown == sameEpoch /\ i >= expectedId
                IN /\ displayedEnabled' = IF accept THEN captured[i] ELSE displayedEnabled
                   /\ appliedId' = IF accept THEN i ELSE appliedId
                   /\ expectedEnabled' = IF newestKnown THEN captured[i] ELSE expectedEnabled
                   /\ expectedId' = IF newestKnown THEN i ELSE expectedId
                   /\ wrongEpoch' = (wrongEpoch \/ (accept /\ ~sameEpoch))
             /\ requestState' = [requestState EXCEPT ![i] = "done"]
             /\ lastAction' = IF i = 1 THEN "FinishOld" ELSE "FinishNew"
             /\ UNCHANGED <<remoteEnabled, captured, requestEpoch, epoch, started>>
SwitchSession == /\ epoch = 0 /\ epoch' = 1 /\ appliedId' = 0 /\ expectedId' = 0
                 /\ displayedEnabled' = FALSE /\ expectedEnabled' = FALSE /\ lastAction' = "SwitchSession"
                 /\ UNCHANGED <<remoteEnabled, requestState, captured, requestEpoch, started, wrongEpoch>>
Done == /\ remoteEnabled /\ epoch = 1 /\ \A i \in Ids: requestState[i] = "done"
        /\ UNCHANGED vars
Next == EnableInNotion \/ (\E i \in Ids: Begin(i)) \/ (\E i \in Ids: Finish(i)) \/ SwitchSession \/ Done
TypeOK == /\ remoteEnabled \in BOOLEAN /\ requestState \in [Ids -> {"new", "pending", "done"}]
          /\ captured \in [Ids -> BOOLEAN] /\ requestEpoch \in [Ids -> 0..1] /\ epoch \in 0..1
          /\ started \in 0..2 /\ appliedId \in 0..2 /\ expectedId \in 0..2
          /\ displayedEnabled \in BOOLEAN /\ expectedEnabled \in BOOLEAN /\ wrongEpoch \in BOOLEAN
NewestObservationWins == displayedEnabled = expectedEnabled
NoCrossSessionPublication == ~wrongEpoch
=============================================================================
