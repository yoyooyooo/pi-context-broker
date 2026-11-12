export const title = "两次获取的副作用交接";
export function state(v) {
  const s = v.s;
  const phase = {
    capability: "检查 SDK 能力", "first-call": "来源一待获取", "first-effect": "来源一已写等待回执",
    "second-call": "来源一完成", "second-effect": "来源二已写等待回执",
    merge: "合并来源结果", ready: "完整图已准备", failed: "失败或取消不提交新选择",
    selected: "完整新选择交接", accepted: "provider 接受回执输入", completed: "回合完成回执输入",
    persisted: "持久化回执输入", reported: "受控报告完成",
  }[s.phase];
  const terminal = ["ready","failed","selected","accepted","completed","persisted","reported"].includes(s.phase);
  // Exact retention identities remain in the model and report. The overview
  // shows effects at refusal/report boundaries; downstream ports preserve them.
  const detail = ["failed", "reported"].includes(s.phase) ? "；effects=" + s.effect : "";
  const bad = [];
  if (terminal && s.confirmed.some(fact => !s.visible.includes(fact))) bad.push("已知留存事实丢失");
  if (s.selected && !(s.firstReady && s.secondReady)) bad.push("半套选择");
  if (terminal && s.unknown && s.effect !== "unknown") bad.push("未知被降级");
  if (s.zeroClaim && s.writes > 0) bad.push("错误零写声明");
  return phase + detail + (bad.length ? "；" + bad.join("；") : "");
}
export const step = action => ({
  RejectLegacySdk: "能力不匹配先拒绝", DispatchFirst: "开始获取", RejectFirstWrite: "首个语义写前拒绝",
  FirstNoWrite: "来源一确认无写", FirstWrite: "来源一留存写", FirstReceipt: "观察来源一回执",
  SecondNoWrite: "来源二无写完成或失败取消", RejectSecondWrite: "来源二语义写前拒绝",
  SecondWrite: "来源二留存写", SecondReceipt: "观察来源二回执", SecondAckUnknown: "来源二 ACK 未知",
  MergeEffects: "保留累计事实", CommitSelection: "完整图提交", ProviderAccepted: "下游提供接受回执",
  TurnCompleted: "下游提供完成回执", PersistReceipt: "下游提供持久化回执", Report: "按受控规则报告", Done: null,
}[action] ?? action);

