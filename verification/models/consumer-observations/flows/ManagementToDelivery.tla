---------------------- MODULE ManagementToDelivery ----------------------
EXTENDS Naturals
CONSTANTS CompleteBeforeSelect, KeepOrdinaryPin, RetirePriorResource, ReuseFreshBody,
          CompleteManagementReceipt, RequireManagementReceipt
VARIABLES phase, remoteVersion, selectedVersion, mainReady, requiredReady,
          contextMain, contextRequired, contextReference, ordinaryMoved,
          warmBodyFetches, totalBodyFetches
vars == <<phase,remoteVersion,selectedVersion,mainReady,requiredReady,
          contextMain,contextRequired,contextReference,ordinaryMoved,
          warmBodyFetches,totalBodyFetches>>
Init == /\ phase = "draft" /\ remoteVersion = 0 /\ selectedVersion = 0
        /\ mainReady = FALSE /\ requiredReady = FALSE
        /\ contextMain = 0 /\ contextRequired = FALSE /\ contextReference = 0
        /\ ordinaryMoved = FALSE /\ warmBodyFetches = 0 /\ totalBodyFetches = 0
\* Input contract: original management completion, or a separately completed
\* independent acceptance. An original unknown operation is never rewritten.
PublishVerified == /\ phase = "draft" /\ (~RequireManagementReceipt \/ CompleteManagementReceipt)
                   /\ phase' = "published" /\ remoteVersion' = 1
                   /\ UNCHANGED <<selectedVersion,mainReady,requiredReady,contextMain,contextRequired,
                                   contextReference,ordinaryMoved,warmBodyFetches,totalBodyFetches>>
RejectUnverifiedManagement == /\ phase = "draft" /\ RequireManagementReceipt /\ ~CompleteManagementReceipt
                              /\ phase' = "blocked"
                              /\ UNCHANGED <<remoteVersion,selectedVersion,mainReady,requiredReady,contextMain,
                                              contextRequired,contextReference,ordinaryMoved,warmBodyFetches,totalBodyFetches>>
BootAndDiscover == /\ phase = "published" /\ phase' = "directory"
                   /\ UNCHANGED <<remoteVersion,selectedVersion,mainReady,requiredReady,contextMain,
                                   contextRequired,contextReference,ordinaryMoved,warmBodyFetches,totalBodyFetches>>
ChooseTask == /\ phase = "directory" /\ phase' = "preparing"
              /\ UNCHANGED <<remoteVersion,selectedVersion,mainReady,requiredReady,contextMain,
                              contextRequired,contextReference,ordinaryMoved,warmBodyFetches,totalBodyFetches>>
GetRoot == /\ phase = "preparing" /\ ~mainReady /\ mainReady' = TRUE
           /\ totalBodyFetches' = totalBodyFetches + 1
           /\ UNCHANGED <<phase,remoteVersion,selectedVersion,requiredReady,contextMain,contextRequired,
                           contextReference,ordinaryMoved,warmBodyFetches>>
GetRequired == /\ phase = "preparing" /\ ~requiredReady /\ requiredReady' = TRUE
               /\ totalBodyFetches' = totalBodyFetches + 1
               /\ UNCHANGED <<phase,remoteVersion,selectedVersion,mainReady,contextMain,contextRequired,
                               contextReference,ordinaryMoved,warmBodyFetches>>
CommitUse == /\ phase = "preparing" /\ mainReady /\ (~CompleteBeforeSelect \/ requiredReady)
             /\ phase' = "selected" /\ selectedVersion' = remoteVersion
             /\ contextMain' = remoteVersion /\ contextRequired' = requiredReady
             /\ UNCHANGED <<remoteVersion,mainReady,requiredReady,contextReference,ordinaryMoved,
                             warmBodyFetches,totalBodyFetches>>
ReadReference == /\ phase = "selected" /\ phase' = "first-answer"
                 /\ contextReference' = selectedVersion /\ totalBodyFetches' = totalBodyFetches + 1
                 /\ UNCHANGED <<remoteVersion,selectedVersion,mainReady,requiredReady,contextMain,
                                 contextRequired,ordinaryMoved,warmBodyFetches>>
EditInNotion == /\ phase = "first-answer" /\ phase' = "edited" /\ remoteVersion' = 2
                /\ UNCHANGED <<selectedVersion,mainReady,requiredReady,contextMain,contextRequired,
                                contextReference,ordinaryMoved,warmBodyFetches,totalBodyFetches>>
OrdinaryFollowup == /\ phase = "edited" /\ phase' = "old-answer"
                    /\ selectedVersion' = IF KeepOrdinaryPin THEN selectedVersion ELSE remoteVersion
                    /\ contextMain' = IF KeepOrdinaryPin THEN contextMain ELSE remoteVersion
                    /\ contextReference' = IF KeepOrdinaryPin THEN contextReference ELSE remoteVersion
                    /\ ordinaryMoved' = ~KeepOrdinaryPin
                    /\ warmBodyFetches' = warmBodyFetches + (IF ReuseFreshBody THEN 0 ELSE 1)
                    /\ totalBodyFetches' = totalBodyFetches + (IF ReuseFreshBody THEN 0 ELSE 1)
                    /\ UNCHANGED <<remoteVersion,mainReady,requiredReady,contextRequired>>
RequestRefresh == /\ phase = "old-answer" /\ phase' = "refreshing"
                  /\ mainReady' = TRUE /\ requiredReady' = TRUE
                  /\ totalBodyFetches' = totalBodyFetches + 1
                  /\ UNCHANGED <<remoteVersion,selectedVersion,contextMain,contextRequired,
                                  contextReference,ordinaryMoved,warmBodyFetches>>
CommitRefresh == /\ phase = "refreshing" /\ phase' = "new-selection"
                 /\ selectedVersion' = remoteVersion /\ contextMain' = remoteVersion
                 /\ contextRequired' = TRUE
                 /\ contextReference' = IF RetirePriorResource THEN 0 ELSE contextReference
                 /\ UNCHANGED <<remoteVersion,mainReady,requiredReady,ordinaryMoved,warmBodyFetches,totalBodyFetches>>
ReadNewReference == /\ phase = "new-selection" /\ phase' = "new-answer"
                    /\ contextReference' = selectedVersion /\ totalBodyFetches' = totalBodyFetches + 1
                    /\ UNCHANGED <<remoteVersion,selectedVersion,mainReady,requiredReady,contextMain,
                                    contextRequired,ordinaryMoved,warmBodyFetches>>
Finish == /\ phase = "new-answer" /\ phase' = "done"
          /\ warmBodyFetches' = warmBodyFetches + (IF ReuseFreshBody THEN 0 ELSE 1)
          /\ totalBodyFetches' = totalBodyFetches + (IF ReuseFreshBody THEN 0 ELSE 1)
          /\ UNCHANGED <<remoteVersion,selectedVersion,mainReady,requiredReady,contextMain,
                          contextRequired,contextReference,ordinaryMoved>>
Done == /\ phase \in {"done","blocked"} /\ UNCHANGED vars
Next == PublishVerified \/ RejectUnverifiedManagement \/ BootAndDiscover \/ ChooseTask \/ GetRoot \/ GetRequired \/ CommitUse
        \/ ReadReference \/ EditInNotion \/ OrdinaryFollowup \/ RequestRefresh \/ CommitRefresh
        \/ ReadNewReference \/ Finish \/ Done
TypeOK == /\ phase \in {"draft","published","directory","preparing","selected","first-answer",
                        "edited","old-answer","refreshing","new-selection","new-answer","done","blocked"}
          /\ remoteVersion \in 0..2 /\ selectedVersion \in 0..2
          /\ contextMain \in 0..2 /\ contextReference \in 0..2
          /\ mainReady \in BOOLEAN /\ requiredReady \in BOOLEAN /\ contextRequired \in BOOLEAN
          /\ ordinaryMoved \in BOOLEAN /\ warmBodyFetches \in 0..2 /\ totalBodyFetches \in 0..7
ManagementReceiptBeforePublish == remoteVersion = 0 \/ CompleteManagementReceipt
CompleteBeforeApplication == selectedVersion = 0 \/ contextRequired
OrdinarySelectionStable == ~ordinaryMoved
ReferenceBelongsToSelection == contextReference = 0 \/ contextReference = selectedVersion
FreshFollowupReusesBody == warmBodyFetches = 0
=============================================================================
