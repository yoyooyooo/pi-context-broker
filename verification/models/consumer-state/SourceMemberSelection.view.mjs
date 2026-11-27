export const title = "Select a registered Source member only from a complete directory"
export const state = v => [
  v.stage + ": " + v.result,
  (v.localSelected ? "Local Skill already selected" : "No local selection")
    + "; " + (v.namespaceMatched ? "Source namespace selected" : "Different namespace"),
  v.coverage + " directory; " + (v.matchCount === 2 ? "multiple" : v.matchCount)
    + " matches; management " + (v.managementAdmitted ? "admitted" : "not admitted"),
]
export const step = action => ({
  Route: "Keep the ordinary selection and Source namespace",
  Observe: "Observe the decoded Source member directory",
  Classify: "Require complete coverage before classifying matches",
  AdmitManagement: "Admit the unique Source member to management",
  Done: "Keep the terminal selection outcome",
})[action] ?? action
export const group = v => v.result === "blocked" ? "blocked" : v.stage === "done" ? "done" : "pending"
export const colors = { blocked: "pink", done: "teal", pending: "blue" }
