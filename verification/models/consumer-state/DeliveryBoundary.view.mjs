export const title = "交付回执的接受 完成与实际持久化";
const names = { graph: "图或正文证明不完整", acceptance: "没有 provider 接受", completion: "turn 尚未完成",
 projection: "未观察到公开投影", lifecycle: "操作失效后发布", branch: "借用已离开的分支" };
export const state = v => {
 const bad = [...v.violations].map(String).sort();
 if (bad.length) return "违例：" + bad.map(value => names[value] ?? value).join("、");
 const done = v.phase === "done";
 if ((v.branch || v.generation || v.cancelled) && !v.active)
   return done ? "结束：操作失效，未新增证明" : "操作失效，等待拒绝新证明";
 // Keep accepted-and-rewound states distinct: the branch-negative rule can
 // break through EffectiveVersion even before an explicit violation is logged.
 if (v.branch) return ["原分支已离开", (done ? "结束：" : "等待收口：") + (v.active ? "接受事实保留在历史" : "尚无完整图接受事实")];
 if (v.generation || v.cancelled) return ["操作已取消或换代", (done ? "结束：" : "等待收口：") + (v.active ? "保留已发生的接受事实" : "不新增交付证明")];
 if (done) return v.persisted ? "已观察到实际持久化回执" : "结束：未新增持久化回执";
 if (v.phase === "prepared") return "已准备并选择\n尚无交付证明";
 if (v.phase === "retryable") return "draft 未落地\n可沿同一固定图重试";
 const phase = ({
  request: "等待本次 provider 响应",
  response: v.providerAccepted ? (v.active ? "2xx 已接受完整固定图" : "provider 已接受，图证明不完整") : "provider 未接受，不新增回执",
  finished: !v.providerAccepted ? "provider 未接受，不新增回执" : !v.active ? "provider 已接受，图证明不完整" :
    v.turnCompleted ? "turn 已完成，尚未持久化" : "turn 未完成，保留接受事实",
  offered: "draft 已返回，等待宿主决定",
  applied: v.publicReceipt ? "公开投影已有回执，等待 ACK" : "宿主丢弃 draft，仍未持久化",
 })[v.phase];
 return [v.active ? "已有完整图接受事实" : "尚无完整图接受事实", phase];
};
export const step = (action, from) => {
 if (["Cancel", "SwitchGeneration", "RewindBranch"].includes(action) && !from.active) return "取消 换代或回退";
 return ({
 SendRequest: "发送选定的 root 与 Requires",
 ReceiveHeaders: "观察响应头与完整图证明",
 FinishTurn: "观察 turn 结束状态",
 OfferDraft: "尝试生成边界 draft，或拒绝",
 ApplyDraft: "宿主应用到当前分支",
 DiscardDraft: "宿主舍弃 draft",
 ObserveProjection: "核对实际公开投影",
 RetryRequest: "沿原固定组合再次请求",
 StopRetry: "停止，不声称已持久化",
 Cancel: "取消或会话换代",
 SwitchGeneration: "取消或会话换代",
 RewindBranch: "回退分支",
 Done: "终态保持",
 })[action] ?? action;
};
