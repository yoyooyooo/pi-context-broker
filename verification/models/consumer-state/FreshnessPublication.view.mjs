export const title = "消费者资格与原始证据发布";
const names = {
 renewed: "缓存被续期", expired: "过期缓存被发布", fixed: "固定内容冒充当前证明",
 older: "较新观察被覆盖", generation: "旧代次发布", cancel: "取消后发布",
 scope: "跨身份发布", attribution: "依赖失败误归根", unknown: "未知权限被当作允许",
};
const rejected = v => v.generation !== 0 || v.cancelled;
const cache = v => v.scenario.includes("cache");
export const state = v => {
 const bad = [...v.violations].map(String).sort();
 if (bad.length) return ["违例：" + bad.map(value => names[value] ?? value).join("、"), "root " + v.rootState + " / 依赖 " + v.childState];
 const done = v.returns === (cache(v) ? 2 : 1);
 if (rejected(v)) return done ? "结束：丢弃失效结果，保持既有观察" : "操作失效，等待丢弃后续结果";
 if (done) {
  if (v.childState === "denied") return "结束：拒绝只归到依赖";
  if (v.rootState === "denied") return "结束：保留较新的拒绝";
  if (v.rootState === "available") return "结束：保留已接受的原始观察";
  return "结束：未新增当前证明";
 }
 if (cache(v) && v.clock === 3) return "缓存已到原有效期，等待后续结果";
 if (v.returns && v.rootState === "available") return "缓存已接受，原验证时间不变";
 if (v.returns) return "较新拒绝仍适用，等待剩余缓存结果";
 return "等待原始证据与发布校验";
};
export const step = (action, from, to) => {
 if (action === "Receive") {
  if ([...to.violations].length > [...from.violations].length) return "结果到达：缺失守卫导致错误发布";
  if (rejected(from)) return "失效票据：不发布";
  if (cache(from)) return from.clock === 3 ? "过期缓存返回：保留原观察" : "缓存返回：不续期、不覆盖较新拒绝";
  if (from.scenario === "child-denial") return "依赖失败：只更新精确目标";
  if (from.scenario === "old-request") return "旧请求返回：保留较新观察";
  if (from.scenario === "new-remote") return from.clock === 3 ? "合格远端证据到达：发布" : "验证时刻尚未到达：不发布";
  return "固定、未知或身份不符：不发布";
 }
 return ({ AdvanceTime: "到达原缓存有效期", RetireGeneration: "取消或会话换代", Cancel: "取消或会话换代", Done: "终态保持" })[action] ?? action;
};
