-------------------------- MODULE MenuPublication --------------------------
EXTENDS Naturals, Sequences
CONSTANTS RespectDenial, RespectFreshness, RespectDismissal, KeepChoiceIdentity
VARIABLES scenario, cacheReturned, refreshed, closed, open, candidates, version,
          shown, highlight, accepted, menuVersion
vars == <<scenario, cacheReturned, refreshed, closed, open, candidates, version,
          shown, highlight, accepted, menuVersion>>

\* One already-open intent in one fixed scope. The user has highlighted B.
\* In the denial scenario A was refused more recently than the stored cache;
\* that refusal is an input premise, not an authorization modeled here.
Scenarios == {"known-denial", "reorder"}
KnownDenied == IF scenario = "known-denial" THEN {"A"} ELSE {}
Members(items) == {items[i] : i \in 1..Len(items)}
FreshItems == IF scenario = "known-denial" THEN <<"B">> ELSE <<"B", "A">>
CachedItems == IF RespectDenial /\ scenario = "known-denial" THEN <<"B">> ELSE <<"A", "B">>

Init == /\ scenario \in Scenarios
        /\ cacheReturned = FALSE /\ refreshed = FALSE
        /\ closed = "none" /\ open = TRUE
        /\ shown = IF scenario = "known-denial" THEN <<"B">> ELSE <<"A", "B">>
        /\ candidates = shown /\ version = 0
        /\ highlight = "B" /\ accepted = "none" /\ menuVersion = 0

\* Snapshot admission and screen update are different real boundaries. Accept
\* may interleave while the old item is still displayed after a new snapshot.
Publish(items, revision) ==
 /\ candidates' = items /\ version' = revision
 /\ UNCHANGED <<scenario, closed, open, shown, highlight, accepted, menuVersion>>

UpdateMenu ==
 /\ menuVersion # version
 /\ (~RespectDismissal \/ closed = "none")
 /\ shown' = candidates /\ menuVersion' = version
 /\ highlight' = IF KeepChoiceIdentity
                  THEN IF highlight \in Members(candidates) THEN highlight ELSE "none"
                  ELSE LET position == CHOOSE i \in 1..Len(shown) : shown[i] = highlight
                       IN candidates[IF position <= Len(candidates) THEN position ELSE Len(candidates)]
 /\ open' = (~RespectDismissal \/ closed = "none")
 /\ UNCHANGED <<scenario, cacheReturned, refreshed, closed, candidates, version, accepted>>

ReturnCache ==
 /\ ~cacheReturned /\ cacheReturned' = TRUE
 /\ IF RespectFreshness /\ refreshed
       THEN UNCHANGED <<scenario, closed, open, candidates, version, shown, highlight, accepted, menuVersion>>
       ELSE Publish(CachedItems, 1)
 /\ UNCHANGED refreshed

ReturnFresh ==
 /\ ~refreshed /\ refreshed' = TRUE
 /\ Publish(FreshItems, 2)
 /\ UNCHANGED cacheReturned

Escape ==
 /\ closed = "none" /\ closed' = "escape" /\ open' = FALSE
 /\ UNCHANGED <<scenario, cacheReturned, refreshed, candidates, version, shown, highlight, accepted, menuVersion>>

Accept ==
 /\ closed = "none" /\ open /\ highlight # "none"
 /\ accepted' = highlight /\ closed' = "accepted" /\ open' = FALSE
 /\ UNCHANGED <<scenario, cacheReturned, refreshed, candidates, version, shown, highlight, menuVersion>>

Done == /\ cacheReturned /\ refreshed /\ closed # "none" /\ UNCHANGED vars
Next == ReturnCache \/ ReturnFresh \/ UpdateMenu \/ Escape \/ Accept \/ Done

TypeOK == /\ scenario \in Scenarios
          /\ cacheReturned \in BOOLEAN /\ refreshed \in BOOLEAN /\ open \in BOOLEAN
          /\ closed \in {"none", "escape", "accepted"}
          /\ candidates \in {<<"A", "B">>, <<"B", "A">>, <<"B">>} /\ version \in 0..2
          /\ shown \in {<<"A", "B">>, <<"B", "A">>, <<"B">>}
          /\ highlight \in {"A", "B", "none"}
          /\ accepted \in {"A", "B", "none"} /\ menuVersion \in 0..2
NoDeniedResurrection == (Members(candidates) \cup Members(shown)) \cap KnownDenied = {}
FreshOutranksLateCache == refreshed => version = 2
NoDismissedReopen == closed # "none" => ~open
ChoiceIdentityPreserved == (open => highlight = "B") /\ accepted \in {"none", "B"}
=============================================================================
