----------------------- MODULE SourceMemberSelection -----------------------
EXTENDS Naturals
CONSTANTS RespectLocal, RespectNamespace, RespectCoverage
VARIABLES localSelected, namespaceMatched, coverage, matchCount,
          stage, result, managementAdmitted
vars == <<localSelected, namespaceMatched, coverage, matchCount,
          stage, result, managementAdmitted>>

\* One admitted literal input. Registry selection, namespace parsing and the
\* decoded directory are fixed inputs; asynchronous acquisition is not atomic
\* with classification or management admission. Two matches represent many.
Init == /\ localSelected \in BOOLEAN
        /\ namespaceMatched \in BOOLEAN
        /\ coverage \in {"complete", "partial"}
        /\ matchCount \in 0..2
        /\ stage = "route" /\ result = "none"
        /\ managementAdmitted = FALSE

Route ==
 /\ stage = "route"
 /\ IF RespectLocal /\ localSelected
       THEN /\ stage' = "done" /\ result' = "local"
       ELSE IF RespectNamespace /\ ~namespaceMatched
         THEN /\ stage' = "done" /\ result' = "unselected"
         ELSE /\ stage' = "observe" /\ result' = "none"
 /\ UNCHANGED <<localSelected, namespaceMatched, coverage, matchCount,
                managementAdmitted>>

Observe ==
 /\ stage = "observe" /\ stage' = "classify"
 /\ UNCHANGED <<localSelected, namespaceMatched, coverage, matchCount,
                result, managementAdmitted>>

Classify ==
 /\ stage = "classify"
 /\ IF RespectCoverage /\ coverage = "partial"
       THEN /\ stage' = "done" /\ result' = "blocked"
       ELSE IF matchCount = 0
         THEN /\ stage' = "done" /\ result' = "missing"
         ELSE IF matchCount = 1
           THEN /\ stage' = "candidate" /\ result' = "unique"
           ELSE /\ stage' = "done" /\ result' = "ambiguous"
 /\ UNCHANGED <<localSelected, namespaceMatched, coverage, matchCount,
                managementAdmitted>>

\* This denotes permission to enter the existing management boundary. It is
\* neither a remote dispatch nor a claim that the manager has completed.
AdmitManagement ==
 /\ stage = "candidate" /\ stage' = "done"
 /\ managementAdmitted' = TRUE
 /\ UNCHANGED <<localSelected, namespaceMatched, coverage, matchCount, result>>

Done == /\ stage = "done" /\ UNCHANGED vars
Next == Route \/ Observe \/ Classify \/ AdmitManagement \/ Done

TypeOK == /\ localSelected \in BOOLEAN /\ namespaceMatched \in BOOLEAN
          /\ coverage \in {"complete", "partial"} /\ matchCount \in 0..2
          /\ stage \in {"route", "observe", "classify", "candidate", "done"}
          /\ result \in {"none", "local", "unselected", "blocked", "missing",
                         "unique", "ambiguous"}
          /\ managementAdmitted \in BOOLEAN
PartialDirectoryNeverClassified ==
 coverage = "partial" => result \notin {"missing", "unique", "ambiguous"}
PartialNoManagement == coverage = "partial" => ~managementAdmitted
LocalSelectionOwnsRoute ==
 localSelected => /\ stage \in {"route", "done"}
                  /\ result \in {"none", "local"} /\ ~managementAdmitted
UnmatchedNamespaceIsIgnored ==
 ~localSelected /\ ~namespaceMatched =>
   /\ stage \in {"route", "done"}
   /\ result \in {"none", "unselected"} /\ ~managementAdmitted
CompleteClassificationIsExact ==
 ~localSelected /\ namespaceMatched /\ coverage = "complete"
   /\ stage \in {"candidate", "done"} =>
     result = CASE matchCount = 0 -> "missing"
                [] matchCount = 1 -> "unique"
                [] OTHER -> "ambiguous"
ManagementNeedsUniqueSelectedSource ==
 managementAdmitted => /\ ~localSelected /\ namespaceMatched
                        /\ coverage = "complete" /\ matchCount = 1
                        /\ result = "unique"
=============================================================================
