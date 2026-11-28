export const title = "固定技能恢复失败后，连续三轮仍能继续";
export const state = v => {
  const roots = [...v.roots], bodies = [...v.bodies], missing = [...v.missing], denied = [...v.denied];
  if (v.phase === "stuck") return "三轮恢复失败，仍未到达模型";
  if (v.phase === "done") return "三轮已交付或明确取消";
  if (v.phase === "aborted") return "恢复故障中止本轮";
  if (v.phase === "cancelled") return "旧恢复已取消，等待下一轮";
  if (v.phase === "sent") {
    const issues = [];
    if (roots.some(r => r !== "d") && !bodies.includes("b")) issues.push("缺失必需正文");
    if (v.bodyVersion !== 1 && bodies.length) issues.push("原版本被替换");
    if (bodies.some(b => denied.includes(b))) issues.push("含已拒绝正文");
    if (v.ticket !== v.generation) issues.push("过期恢复进入请求");
    if (v.disabled && !missing.length && !denied.length && v.ticket === v.generation && roots.length !== 3) issues.push("已有原字节却被业务禁用阻断");
    return issues.length ? "请求违例：" + issues.join("、") : roots.length === 3 ? "原完整技能进入模型" : "隔离不完整技能，其余对话继续";
  }
  return ({waiting: "收到下一轮问题", restoring: "恢复原固定正文", ready: "准备校验完整闭包"})[v.phase];
};
export const step = action => ({Start: "开始原版本恢复", Resolve: "处理原字节或恢复故障", Project: "检查闭包与当前权限", Advance: "继续下一轮", NotionChanges: "Notion 改版或业务禁用", ObserveDenial: "观察权限撤销", RetireOperation: "取消或会话换代", Done: "本轮验收结束"})[action] ?? action;
