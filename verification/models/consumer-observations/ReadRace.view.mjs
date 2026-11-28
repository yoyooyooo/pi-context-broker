export const title = "A delayed denial must not replace a newer successful read";
export const state = v => {
 const rules=[...(v.displayedEnabled!==v.expectedEnabled?["newest observation lost"]:[]),...(v.wrongEpoch?["old-session publication"]:[])];
 return (rules.length?"BROKEN: "+rules.join(" + "):"Consistent")+"\n"+v.lastAction+"; shown "+(v.displayedEnabled?"enabled":"disabled")+"; session "+v.epoch;
};
export const step = action => action.includes("Begin")?"start exact current read":action.includes("Finish")?"receive captured read result":({EnableInNotion:"user enables Skill",SwitchSession:"switch session",Done:"terminal hold"})[action]??action;
