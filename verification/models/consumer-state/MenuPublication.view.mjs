export const title = "Keep the current menu and the user's highlighted Skill"
const members = shown => Object.values(shown)
const faults = v => [
  v.scenario === "known-denial" && [...members(v.candidates), ...members(v.shown)].includes("A") && "Known refusal replaced by cache",
  v.refreshed && v.version !== 2 && "Fresh directory replaced by cache",
  v.closed !== "none" && v.open && "Dismissed menu reopened",
  (v.open && v.highlight !== "B" || !["none", "B"].includes(v.accepted)) && "Highlighted Skill changed",
].filter(Boolean)
export const state = v => {
  const bad = faults(v)
  return [bad.length ? "Violation: " + bad.join("; ") : v.open ? "Menu open" : v.closed === "accepted" ? "Skill accepted" : "Menu dismissed",
    (v.menuVersion === 2 ? "Latest" : v.menuVersion === 1 ? "Cached" : "Initial") + " candidates " + members(v.shown).join(", "),
    (v.accepted === "none" ? "Highlight " + v.highlight : "Accepted " + v.accepted)
      + (v.version !== v.menuVersion ? "; newer snapshot awaits screen update" : "")]
}
export const step = action => ({ ReturnCache: "Stored candidates return", ReturnFresh: "Latest directory returns", UpdateMenu: "Update the open dropdown",
  Escape: "You press Escape", Accept: "You accept the highlighted Skill", Done: "Keep the completed intent" })[action] ?? action
export const group = v => faults(v).length ? "violation" : v.closed === "none" ? "open" : "closed"
export const colors = { violation: "pink", open: "blue", closed: "teal" }
