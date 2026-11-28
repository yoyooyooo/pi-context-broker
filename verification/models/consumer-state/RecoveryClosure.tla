------------------------- MODULE RecoveryClosure -------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS IsolateFailures, RequireClosure, PreservePins, PreserveDisabledOriginals,
          RespectDenial, RespectEpoch
VARIABLES missing, disabled, latest, phase, turn, bodies, roots, denied,
          generation, ticket, bodyVersion, sent, cancelled
vars == <<missing, disabled, latest, phase, turn, bodies, roots, denied,
          generation, ticket, bodyVersion, sent, cancelled>>
Nodes == {"a", "b", "c", "d"}
Roots == {"a", "c", "d"}
Closure(r) == IF r = "d" THEN {"d"} ELSE {r, "b"}
Union(rs) == UNION {Closure(r): r \in rs}
Phases == {"waiting", "restoring", "ready", "sent", "aborted", "cancelled", "done", "stuck"}
Available == (Nodes \ missing) \ (IF RespectDenial THEN denied ELSE {})
Restorable == Available \ (IF disabled /\ ~PreserveDisabledOriginals THEN {"b"} ELSE {})
Current == ticket = generation
Init == /\ missing \in {{}, {"b"}}
        /\ disabled \in BOOLEAN /\ latest \in 1..2
        /\ phase = "waiting" /\ turn = 1 /\ bodies = {} /\ roots = {}
        /\ denied = {} /\ generation = 0 /\ ticket = 0
        /\ bodyVersion = 1 /\ sent = {} /\ cancelled = {}
Start == /\ phase = "waiting" /\ phase' = "restoring" /\ ticket' = generation
         /\ UNCHANGED <<missing, disabled, latest, turn, bodies, roots, denied,
                        generation, bodyVersion, sent, cancelled>>
Resolve ==
 /\ phase = "restoring"
 /\ IF ~Current /\ RespectEpoch
       THEN /\ phase' = "cancelled" /\ bodies' = {} /\ bodyVersion' = bodyVersion
            /\ cancelled' = cancelled \cup {turn}
       ELSE /\ phase' = IF missing # {} /\ ~IsolateFailures THEN "aborted" ELSE "ready"
            /\ bodies' = Restorable
            /\ bodyVersion' = IF PreservePins THEN 1 ELSE latest
            /\ cancelled' = cancelled
 /\ UNCHANGED <<missing, disabled, latest, turn, roots, denied, generation, ticket, sent>>
Project ==
 /\ phase = "ready"
 /\ IF ~Current /\ RespectEpoch
       THEN /\ phase' = "cancelled" /\ bodies' = {} /\ roots' = {}
            /\ sent' = sent /\ cancelled' = cancelled \cup {turn}
       ELSE LET allowed == bodies \ (IF RespectDenial THEN denied ELSE {})
                complete == {r \in Roots: Closure(r) \subseteq allowed}
                selected == IF RequireClosure THEN complete ELSE Roots \cap allowed
            IN /\ phase' = "sent" /\ roots' = selected
               /\ bodies' = allowed \cap Union(selected)
               /\ sent' = sent \cup {turn} /\ cancelled' = cancelled
 /\ UNCHANGED <<missing, disabled, latest, turn, denied, generation, ticket, bodyVersion>>
Advance ==
 /\ phase \in {"sent", "aborted", "cancelled"}
 /\ IF turn < 3
       THEN /\ turn' = turn + 1 /\ phase' = "waiting"
       ELSE /\ turn' = turn /\ phase' = IF phase = "aborted" THEN "stuck" ELSE "done"
 /\ bodies' = {} /\ roots' = {}
 /\ UNCHANGED <<missing, disabled, latest, denied, generation, ticket, bodyVersion, sent, cancelled>>
NotionChanges ==
 /\ phase \in {"waiting", "restoring", "ready"} /\ latest = 1
 /\ latest' = 2 /\ disabled' = TRUE
 /\ UNCHANGED <<missing, phase, turn, bodies, roots, denied, generation, ticket, bodyVersion, sent, cancelled>>
ObserveDenial ==
 /\ phase \in {"restoring", "ready"} /\ denied = {}
 /\ denied' = {"b"}
 /\ UNCHANGED <<missing, disabled, latest, phase, turn, bodies, roots, generation, ticket, bodyVersion, sent, cancelled>>
RetireOperation ==
 /\ phase \in {"restoring", "ready"} /\ generation = 0
 /\ generation' = 1
 /\ UNCHANGED <<missing, disabled, latest, phase, turn, bodies, roots, denied, ticket, bodyVersion, sent, cancelled>>
Done == /\ phase \in {"done", "stuck"} /\ UNCHANGED vars
Next == Start \/ Resolve \/ Project \/ Advance \/ NotionChanges \/ ObserveDenial \/ RetireOperation \/ Done
Spec == Init /\ [][Next]_vars /\ WF_vars(Start) /\ WF_vars(Resolve)
        /\ WF_vars(Project) /\ WF_vars(Advance)
TypeOK == /\ missing \subseteq {"b"} /\ disabled \in BOOLEAN /\ latest \in 1..2
          /\ phase \in Phases /\ turn \in 1..3 /\ bodies \subseteq Nodes /\ roots \subseteq Roots
          /\ denied \subseteq {"b"} /\ generation \in 0..1 /\ ticket \in 0..1
          /\ bodyVersion \in 1..2 /\ sent \subseteq 1..3 /\ cancelled \subseteq 1..3
MandatoryClosureAtRequest == phase = "sent" => Union(roots) \subseteq bodies
NoSilentVersionChange == phase = "sent" /\ bodies # {} => bodyVersion = 1
NoDeniedBodyAtRequest == phase = "sent" => bodies \cap denied = {}
NoRetiredRestoration == phase = "sent" => Current
DisabledOriginalsRemainUsable ==
 (phase = "sent" /\ missing = {} /\ denied = {} /\ disabled /\ Current) => roots = Roots
IndependentRootSurvives == phase = "sent" /\ Current => "d" \in roots
ConversationCanContinue == <> (phase = "done" /\ sent \cup cancelled = 1..3)
=============================================================================
