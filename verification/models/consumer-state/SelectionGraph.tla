-------------------------- MODULE SelectionGraph --------------------------
EXTENDS Naturals
CONSTANTS RequireChecks, CheckIdentity, CheckBudget, CheckClosure,
          RespectLifecycle, KeepMemberPins
VARIABLES scenario, prepared, identityChecked, budgetChecked, generation,
          cancelled, done, committed, selected, violations, released
vars == <<scenario, prepared, identityChecked, budgetChecked, generation,
          cancelled, done, committed, selected, violations, released>>
Scenarios == {"valid", "foreign-scope", "wrong-snapshot", "wrong-hash", "budget", "working-budget", "missing-required"}
PriorVector == <<1, 2>>
TargetVector == <<2, 1>>
IdentityMatches == scenario \notin {"foreign-scope", "wrong-snapshot", "wrong-hash"}
\* One retained independent instruction byte and a fully deduplicated new closure.
\* The union measurement is a bounded premise; exact shared-node counting is replayed in code.
ExistingBytes == 1
ClosureBytes == IF scenario = "working-budget" THEN 2 ELSE 1
WorkingBudget == 2
BudgetFits == scenario # "budget" /\ ExistingBytes + ClosureBytes <= WorkingBudget
CompleteClosure == scenario # "missing-required"
ValidInput == IdentityMatches /\ BudgetFits /\ CompleteClosure
ViolationNames == {"unchecked", "identity", "budget", "closure", "late"}
Init == /\ scenario \in Scenarios /\ prepared = FALSE
        /\ identityChecked = FALSE /\ budgetChecked = FALSE
        /\ generation = 0 /\ cancelled = FALSE /\ done = FALSE
        /\ committed = FALSE /\ selected = PriorVector /\ violations = {} /\ released = FALSE
Prepare == /\ ~prepared /\ ~done /\ prepared' = TRUE
           /\ UNCHANGED <<scenario, identityChecked, budgetChecked, generation,
                          cancelled, done, committed, selected, violations, released>>
InspectIdentity == /\ prepared /\ ~done /\ ~identityChecked /\ identityChecked' = TRUE
                   /\ UNCHANGED <<scenario, prepared, budgetChecked, generation,
                                  cancelled, done, committed, selected, violations, released>>
InspectBudget == /\ prepared /\ ~done /\ ~budgetChecked /\ budgetChecked' = TRUE
                 /\ UNCHANGED <<scenario, prepared, identityChecked, generation,
                                cancelled, done, committed, selected, violations, released>>
Cancel == /\ ~done /\ ~cancelled /\ cancelled' = TRUE
          /\ UNCHANGED <<scenario, prepared, identityChecked, budgetChecked,
                         generation, done, committed, selected, violations, released>>
SwitchGeneration == /\ ~done /\ generation = 0 /\ generation' = 1
                    /\ UNCHANGED <<scenario, prepared, identityChecked, budgetChecked,
                                   cancelled, done, committed, selected, violations, released>>
ReleaseActiveRoot == /\ ~done /\ generation = 0 /\ ~released
                     /\ generation' = 1 /\ released' = TRUE
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
 /\ UNCHANGED <<scenario, prepared, identityChecked, budgetChecked, generation, cancelled, released>>
Done == /\ done /\ UNCHANGED vars
Next == Prepare \/ InspectIdentity \/ InspectBudget \/ Cancel \/ SwitchGeneration \/ ReleaseActiveRoot \/ Commit \/ Done
TypeOK == /\ scenario \in Scenarios /\ prepared \in BOOLEAN
          /\ identityChecked \in BOOLEAN /\ budgetChecked \in BOOLEAN
          /\ generation \in 0..1 /\ cancelled \in BOOLEAN /\ done \in BOOLEAN /\ committed \in BOOLEAN
          /\ selected \in {PriorVector, TargetVector, <<2, 0>>, <<2, 2>>}
          /\ violations \subseteq ViolationNames /\ released \in BOOLEAN
SelectionRequiresChecks == violations \cap {"unchecked", "identity", "budget", "closure"} = {}
FailedRefreshPreservesSelection == (done /\ ~ValidInput) => selected = PriorVector
NoRetiredSelection == "late" \notin violations /\ (released => ~committed)
EachMemberKeepsOwnPin == (committed /\ CompleteClosure) => selected = TargetVector
=============================================================================
