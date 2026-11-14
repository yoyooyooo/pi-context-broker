export const title = "Current-read evidence and cached Skill availability";
export const state = v => {
 const shown=v.candidateEnabled&&!v.liveDenied;
 const rules=[...(shown!==v.lastKnownEnabled?["known-observation mismatch"]:[]),...(v.cursorBroken?["mixed cursor availability"]:[])];
 return (rules.length?"BROKEN: "+rules.join(" + "):"Consistent: "+(shown?"available":"unavailable"))+"\nNotion "+(v.remoteEnabled?"enabled":"disabled")+"; "+v.lastAction;
};
export const step = action => ({EditNotion:"user toggles Enabled",ReadCurrent:"current read finishes",UseCurrent:"apply Skill finishes",RefreshMetadata:"refresh receives current metadata",SwitchSession:"new session receives metadata",FirstPage:"save first-page cursor",NextPage:"continue original cursor"})[action]??action;
