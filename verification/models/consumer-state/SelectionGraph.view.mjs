export const title = "固定选择与完整成员 pin 检查";
const names = { unchecked: "未检查就提交", identity: "身份不匹配", budget: "预算超限", closure: "依赖不完整", late: "失效操作提交" };
export const state = v => {
 const bad = [...v.violations].map(String).sort();
 // /statechart represents a TLA+ sequence as an object with 1-based keys.
 const wrongPin = v.committed && v.scenario !== "missing-required" && (v.selected?.[1] !== 2 || v.selected?.[2] !== 1);
 if (bad.length || wrongPin) return "违例：" + [...bad.map(value => names[value] ?? value), ...(wrongPin ? ["根 pin 覆盖了依赖 pin"] : [])].join("、");
 if (v.done) return v.committed ? "已提交新固定组合\nroot v2 / Requires v1" : "拒绝替换，旧组合保留\nroot v1 / Requires v2";
 if (v.generation || v.cancelled) return "操作失效，等待拒绝提交";
 const phase = !v.prepared ? "保留旧选择，等待准备" : v.identityChecked && v.budgetChecked ? "身份与预算均已检查" :
   v.identityChecked ? "身份已检查，预算待检查" : v.budgetChecked ? "预算已检查，身份待检查" : "图已准备，检查尚未完成";
 return ["当前操作", phase];
};
export const step = action => ({
 Prepare: "收到准备图",
 InspectIdentity: "检查 scope、snapshot、hash 与闭包",
 InspectBudget: "检查输出预算",
 Cancel: "取消或会话换代",
 SwitchGeneration: "取消或会话换代",
 Commit: "尝试最终提交",
 Done: "终态保持",
})[action] ?? action;
