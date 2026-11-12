export const title = '读取结果与副作用回执';
export function state(v) {
 const labels={fixed:'已有固定版本',changed:'Notion正文已经修改',reading:'请求当前完整内容',retained:'内部留存已发生远端写入',ready:'工具返回完整正文',failed:v.effect==='none'?'严格只读在写前拒绝':'原写入ACK丢失，操作返回失败',reported:'受控报告规则已输出'};
 const effects={absent:'未披露效果',none:'回执确认零写入',retained:'回执披露已留存',unknown:'回执明确结果未知'};
 const broken=[];if(v.outcome==='ready'&&['ready','reported'].includes(v.phase)&&v.writes>0&&v.effect!=='retained')broken.push('留存副作用未披露');if(v.zeroClaim&&v.writes>0)broken.push('错误声称零写入');
 // Keep absence distinct from explicit uncertainty in the state projection.
 const evidence=['ready','failed','reported'].includes(v.phase)?'；'+effects[v.effect]:'';
 const report=v.phase==='reported'?(v.zeroClaim?'；报告零写入':'；未报告零写入'):'';
 return labels[v.phase]+evidence+report+(broken.length?'：'+broken.join('、'):'');
}
export const step = action=>({EditNotion:'人修改Notion正文',RequestFixed:'读取已验证固定版本',RequestCurrent:'明确取得当前版',RejectBeforeWrite:'严格只读在首个写入前拒绝',RetainObservedContent:'留存已观察版本',ReturnReady:'返回正文及本次效果',LoseAck:'原写入ACK丢失',Report:'按模型规定的报告规则输出',Done:null}[action]??action);
