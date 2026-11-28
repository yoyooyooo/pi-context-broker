---------------------------- MODULE LibrarySession ----------------------------
EXTENDS Naturals, TLC

\* Session choice, admitted-turn binding, exact call target and directory ticket
\* are distinct state. Library identities abstract canonical root UUIDs.
CONSTANT Defect
ASSUME Defect \in {"none", "turn-retarget", "ambient-call", "failed-fallback",
                  "late-directory", "retired-directory", "branch-global",
                  "pin-retarget", "selection-cancels-turn", "call-constraint",
                  "next-turn-stale"}

Scenarios == {"switch", "failed-switch", "late-directory", "cancelled-directory",
              "branch-return", "rewind", "cross-library-call", "explicit-conflict",
              "old-pin"}
Libraries == {"A", "B"}
Branches == {"parent", "child"}
VARIABLES scenario, s
vars == <<scenario, s>>
HasExplicitReference == scenario \in {"cross-library-call", "explicit-conflict"}
NeedsRestore == scenario \in {"branch-return", "rewind"}
Terminal == s.phase = "terminal"

Init ==
  /\ scenario \in Scenarios
  /\ s = [phase |-> "running", selected |-> "A", branch |-> "child",
          branchSelections |-> [parent |-> "A", child |-> "A"],
          switch |-> "pending", switchFlow |-> "pending", switchFlowTarget |-> "none",
          turnLibrary |-> "A", turnEpoch |-> 1, epoch |-> 1, selection |-> 1,
          turnCancelled |-> FALSE, cancellationRequested |-> FALSE,
          turnFinished |-> FALSE, call |-> "pending", callTarget |-> "none",
          nextTurnLibrary |-> "none", nextTurnExpected |-> "none",
          directory |-> "pending", publishedPayload |-> "none", publishedAs |-> "none",
          publishedWithValidTicket |-> TRUE,
          restored |-> ~NeedsRestore, pinOwner |-> "A", pinEnabled |-> TRUE]

ValidateSwitch ==
  /\ s.phase = "running" /\ s.switch = "pending"
  /\ s' = [s EXCEPT !.switch = IF scenario = "failed-switch" THEN "failed" ELSE "validated"]
  /\ UNCHANGED scenario

CommitSwitch ==
  /\ s.phase = "running" /\ s.switch = "validated"
  /\ s' = [s EXCEPT !.switch = "committed", !.selected = "B",
                   !.branchSelections[s.branch] = "B", !.selection = @ + 1,
                   !.turnLibrary = IF Defect = "turn-retarget" THEN "B" ELSE @,
                   !.epoch = IF Defect = "selection-cancels-turn" THEN 2 ELSE @,
                   !.turnCancelled = IF Defect = "selection-cancels-turn" THEN TRUE ELSE @,
                   !.pinOwner = IF Defect = "pin-retarget" THEN "B" ELSE @,
                   !.pinEnabled = IF Defect = "pin-retarget" THEN FALSE ELSE @]
  /\ UNCHANGED scenario

FinishSwitchFlow ==
  /\ s.switch \in {"committed", "failed"} /\ s.switchFlow = "pending"
  /\ s' = [s EXCEPT !.switchFlow =
                     IF s.switch = "failed" /\ Defect # "failed-fallback" THEN "blocked" ELSE "returned",
                   !.switchFlowTarget =
                     IF s.switch = "committed" THEN "B"
                     ELSE IF Defect = "failed-fallback" THEN "A" ELSE "none"]
  /\ UNCHANGED scenario

RestoreBranch ==
  /\ NeedsRestore /\ ~s.restored /\ s.switch = "committed"
  /\ s' = [s EXCEPT !.branch = "parent", !.restored = TRUE, !.selection = @ + 1,
                   !.selected = IF Defect = "branch-global" THEN "B" ELSE s.branchSelections.parent]
  /\ UNCHANGED scenario

CancelLifecycle ==
  /\ scenario = "cancelled-directory" /\ ~s.cancellationRequested
  /\ s' = [s EXCEPT !.epoch = 2, !.cancellationRequested = TRUE, !.turnCancelled = TRUE]
  /\ UNCHANGED scenario

InvokeTurn ==
  /\ s.phase = "running" /\ s.call = "pending" /\ s.switch \in {"committed", "failed"}
  /\ IF s.turnCancelled
     THEN /\ s' = [s EXCEPT !.call = "rejected"]
          /\ UNCHANGED scenario
     ELSE IF scenario = "explicit-conflict" /\ Defect # "call-constraint"
     THEN /\ s' = [s EXCEPT !.call = "rejected"]
          /\ UNCHANGED scenario
     ELSE
       /\ s' = [s EXCEPT !.call = "returned",
                        !.callTarget = IF HasExplicitReference THEN "B"
                                       ELSE IF Defect = "ambient-call" THEN s.selected
                                       ELSE s.turnLibrary]
       /\ UNCHANGED scenario

FinishTurn ==
  /\ s.call \in {"returned", "rejected"} /\ ~s.turnFinished
  /\ s' = [s EXCEPT !.turnFinished = TRUE]
  /\ UNCHANGED scenario

AdmitNextTurn ==
  /\ s.turnFinished /\ s.switch \in {"committed", "failed"} /\ s.restored
  /\ s.nextTurnLibrary = "none"
  /\ s' = [s EXCEPT !.nextTurnExpected = s.selected,
                   !.nextTurnLibrary = IF Defect = "next-turn-stale" THEN "A" ELSE s.selected]
  /\ UNCHANGED scenario

\* The pending directory request began under (A, selection 1, epoch 1).
\* Payload authority is A even if the receiving session now selects B.
TicketScopeCurrent == s.selected = "A" /\ s.selection = 1
TicketEpochCurrent == s.epoch = 1
TicketCurrent == TicketScopeCurrent /\ TicketEpochCurrent
ReceiveDirectory ==
  /\ s.directory = "pending"
  /\ (scenario # "late-directory" \/ s.switch = "committed")
  /\ (scenario # "cancelled-directory" \/ s.cancellationRequested)
  /\ LET scopeOK == Defect = "late-directory" \/ TicketScopeCurrent
         epochOK == Defect = "retired-directory" \/ TicketEpochCurrent
     IN IF scopeOK /\ epochOK
        THEN /\ s' = [s EXCEPT !.directory = "published",
                               !.publishedPayload = "A", !.publishedAs = s.selected,
                               !.publishedWithValidTicket = TicketCurrent]
             /\ UNCHANGED scenario
        ELSE /\ s' = [s EXCEPT !.directory = "discarded"]
             /\ UNCHANGED scenario

Finish ==
  /\ s.phase = "running"
  /\ s.switchFlow # "pending" /\ s.call # "pending" /\ s.directory # "pending"
  /\ s.turnFinished /\ s.nextTurnLibrary # "none" /\ s.restored
  /\ (scenario # "cancelled-directory" \/ s.cancellationRequested)
  /\ s' = [s EXCEPT !.phase = "terminal"]
  /\ UNCHANGED scenario

Advance == ValidateSwitch \/ CommitSwitch \/ FinishSwitchFlow \/ RestoreBranch
           \/ CancelLifecycle \/ InvokeTurn \/ FinishTurn \/ AdmitNextTurn
           \/ ReceiveDirectory \/ Finish
Done == Terminal /\ UNCHANGED vars
Next == Advance \/ Done
Spec == Init /\ [][Next]_vars /\ WF_vars(Advance)

TypeOK ==
  /\ scenario \in Scenarios /\ s.phase \in {"running", "terminal"}
  /\ s.selected \in Libraries /\ s.branch \in Branches
  /\ s.branchSelections \in [Branches -> Libraries]
  /\ s.switch \in {"pending", "validated", "committed", "failed"}
  /\ s.switchFlow \in {"pending", "returned", "blocked"}
  /\ s.switchFlowTarget \in Libraries \cup {"none"}
  /\ s.turnLibrary \in Libraries /\ s.turnEpoch \in 1..2 /\ s.epoch \in 1..2
  /\ s.selection \in 1..3 /\ s.turnCancelled \in BOOLEAN
  /\ s.cancellationRequested \in BOOLEAN /\ s.turnFinished \in BOOLEAN
  /\ s.call \in {"pending", "returned", "rejected"}
  /\ s.callTarget \in Libraries \cup {"none"}
  /\ s.nextTurnLibrary \in Libraries \cup {"none"}
  /\ s.nextTurnExpected \in Libraries \cup {"none"}
  /\ s.directory \in {"pending", "published", "discarded"}
  /\ s.publishedPayload \in Libraries \cup {"none"} /\ s.publishedAs \in Libraries \cup {"none"}
  /\ s.publishedWithValidTicket \in BOOLEAN /\ s.restored \in BOOLEAN
  /\ s.pinOwner \in Libraries /\ s.pinEnabled \in BOOLEAN
AdmittedTurnKeepsLibrary ==
  /\ s.turnLibrary = "A"
  /\ s.call = "returned" /\ ~HasExplicitReference => s.callTarget = "A"
FailedSwitchStopsRequestedFlow ==
  s.switch = "failed" => s.selected = "A" /\ s.switchFlow # "returned" /\ s.switchFlowTarget = "none"
DirectoryPublicationUsesTicket ==
  s.directory = "published" => s.publishedWithValidTicket /\ s.publishedPayload = s.publishedAs
BranchSelectionIsRestored == s.selected = s.branchSelections[s.branch]
FixedPinKeepsOwner == s.pinOwner = "A" /\ s.pinEnabled
SelectionDoesNotCancelTurn == s.turnCancelled => s.cancellationRequested
ExactReferenceKeepsTarget == HasExplicitReference /\ s.call = "returned" => s.callTarget = "B"
ExplicitCallConstraintRespected == scenario = "explicit-conflict" => s.call # "returned"
NextTurnUsesSelectedLibrary ==
  s.nextTurnLibrary # "none" => s.nextTurnLibrary = s.nextTurnExpected
SessionFlowEventuallyExplained == <>Terminal
=============================================================================

