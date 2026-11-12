-------------------------- MODULE SelectionGraph --------------------------
EXTENDS Naturals
CONSTANTS RequireChecks, CheckIdentity, CheckBudget, CheckClosure,
          RespectLifecycle, KeepMemberPins
VARIABLES scenario, prepared, identityChecked, budgetChecked, generation,
          cancelled, done, committed, selected, violations
vars == <<scenario, prepared, identityChecked, budgetChecked, generation,
          cancelled, done, committed, selected, violations>>
Scenarios == {"valid", "foreign-scope", "wrong-snapshot", "wrong-hash", "budget", "missing-required"}
PriorVector == <<1, 2>>
TargetVector == <<2, 1>>
IdentityMatches == scenario \notin {"foreign-scope", "wrong-snapshot", "wrong-hash"}
BudgetFits == scenario # "budget"
CompleteClosure == scenario # "missing-required"
ValidInput == IdentityMatches /\ BudgetFits /\ CompleteClosure
ViolationNames == {"unchecked", "identity", "budget", "closure", "late"}
Init == /\ scenario \in Scenarios /\ prepared = FALSE
        /\ identityChecked = FALSE /\ budgetChecked = FALSE
        /\ generation = 0 /\ cancelled = FALSE /\ done = FALSE
        /\ committed = FALSE /\ selected = PriorVector /\ violations = {}
Prepare == /\ ~prepared /\ ~done /\ prepared' = TRUE
           /\ UNCHANGED <<scenario, identityChecked, budgetChecked, generation,
                          cancelled, done, committed, selected, violations>>
InspectIdentity == /\ prepared /\ ~done /\ ~identityChecked /\ identityChecked' = TRUE
                   /\ UNCHANGED <<scenario, prepared, budgetChecked, generation,
                                  cancelled, done, committed, selected, violations>>
InspectBudget == /\ prepared /\ ~done /\ ~budgetChecked /\ budgetChecked' = TRUE
                 /\ UNCHANGED <<scenario, prepared, identityChecked, generation,
                                cancelled, done, committed, selected, violations>>
Cancel == /\ ~done /\ ~cancelled /\ cancelled' = TRUE
          /\ UNCHANGED <<scenario, prepared, identityChecked, budgetChecked,
                         generation, done, committed, selected, violations>>
SwitchGeneration == /\ ~done /\ generation = 0 /\ generation' = 1
                    /\ UNCHANGED <<scenario, prepared, identityChecked, budgetChecked,
                                   cancelled, done, committed, selected, violations>>
Commit ==
 /\ prepared /\ ~done /\ (~RequireChecks \/ (identityChecked /\ budgetChecked))
 /\ LET accept == (~CheckIdentity \/ ~identityChecked \/ IdentityMatches)
                  /\ (~CheckBudget \/ ~budgetChecked \/ BudgetFits)
                  /\ (~CheckClosure \/ CompleteClosure)
                  /\ (~RespectLifecycle \/ (generation = 0 /\ ~cancelled))
        vector == IF ~CompleteClosure THEN <<2, 0>>
                  ELSE IF KeepMemberPins THEN TargetVector ELSE <<2, 2>>
    IN /\ committed' = accept
       /\ selected' = IF accept THEN vector ELSE selected
       /\ violations' = violations \cup {v \in ViolationNames:
             (v = "unchecked" /\ accept /\ ~(identityChecked /\ budgetChecked))
          \/ (v = "identity" /\ accept /\ ~IdentityMatches)
          \/ (v = "budget" /\ accept /\ ~BudgetFits)
          \/ (v = "closure" /\ accept /\ ~CompleteClosure)
          \/ (v = "late" /\ accept /\ (generation # 0 \/ cancelled))}
 /\ done' = TRUE
 /\ UNCHANGED <<scenario, prepared, identityChecked, budgetChecked, generation, cancelled>>
Done == /\ done /\ UNCHANGED vars
Next == Prepare \/ InspectIdentity \/ InspectBudget \/ Cancel \/ SwitchGeneration \/ Commit \/ Done
TypeOK == /\ scenario \in Scenarios /\ prepared \in BOOLEAN
          /\ identityChecked \in BOOLEAN /\ budgetChecked \in BOOLEAN
          /\ generation \in 0..1 /\ cancelled \in BOOLEAN /\ done \in BOOLEAN /\ committed \in BOOLEAN
          /\ selected \in {PriorVector, TargetVector, <<2, 0>>, <<2, 2>>}
          /\ violations \subseteq ViolationNames
SelectionRequiresChecks == violations \cap {"unchecked", "identity", "budget", "closure"} = {}
FailedRefreshPreservesSelection == (done /\ ~ValidInput) => selected = PriorVector
NoRetiredSelection == "late" \notin violations
EachMemberKeepsOwnPin == (committed /\ CompleteClosure) => selected = TargetVector
=============================================================================
