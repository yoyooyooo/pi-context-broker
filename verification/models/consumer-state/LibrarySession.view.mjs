export const title = "Keep branch choice, admitted turn, directory ticket and fixed pin separate"

const faults = ({ scenario, s }) => {
  const bad = []
  const explicit = ["cross-library-call", "explicit-conflict"].includes(scenario)
  if (s.turnLibrary !== "A" || (s.call === "returned" && !explicit && s.callTarget !== "A")) bad.push("admitted A turn retargeted")
  if (s.switch === "failed" && (s.selected !== "A" || s.switchFlow === "returned" || s.switchFlowTarget !== "none")) bad.push("failed B flow fell back to A")
  if (s.directory === "published" && (!s.publishedWithValidTicket || s.publishedPayload !== s.publishedAs)) bad.push("directory published with another ticket")
  if (s.selected !== s.branchSelections[s.branch]) bad.push("branch selection replaced by global latest")
  if (s.pinOwner !== "A" || !s.pinEnabled) bad.push("original A pin retargeted or disabled")
  if (s.turnCancelled && !s.cancellationRequested) bad.push("selection cancelled an admitted turn")
  if (explicit && s.call === "returned" && s.callTarget !== "B") bad.push("exact reference changed target")
  if (scenario === "explicit-conflict" && s.call === "returned") bad.push("conflicting explicit call scope admitted")
  if (s.nextTurnLibrary !== "none" && s.nextTurnLibrary !== s.nextTurnExpected) bad.push("next turn used a stale default")
  return bad
}
export const state = (v) => {
  const { scenario, s } = v
  const bad = faults(v)
  return [
    bad.length ? "Violation: " + bad.join("; ") : scenario + ": " + s.phase,
    "Branch " + s.branch + " selects " + s.selected + "; admitted turn " + s.turnLibrary,
    "Switch " + s.switch + "; requested flow " + s.switchFlow + "; current call " + s.call + " " + s.callTarget,
    "Directory " + s.directory + "; selection " + s.selection + "; lifecycle " + s.epoch,
    "Original pin " + s.pinOwner + "; next turn " + s.nextTurnLibrary,
  ]
}
export const step = (action) => ({
  ValidateSwitch: "Validate requested Library B",
  CommitSwitch: "Save B for the selected branch and future turns",
  FinishSwitchFlow: "Complete B flow or explain validation failure",
  RestoreBranch: "Restore the parent branch's own Library",
  CancelLifecycle: "Cancel this lifecycle independently of Library selection",
  InvokeTurn: "Use the admitted turn binding or exact reference",
  FinishTurn: "Finish the admitted turn",
  AdmitNextTurn: "Capture the selected Library for the next turn",
  ReceiveDirectory: "Check the producer's original Library and ticket",
  Finish: "All bounded flows have an explained result",
  Done: "Retain the explained result",
})[action] ?? action
export const group = (v) => faults(v).length ? "violation" : v.s.phase === "terminal" ? "complete" : "inProgress"
export const colors = { violation: "pink", complete: "teal", inProgress: "blue" }

