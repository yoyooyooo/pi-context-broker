export const title = '当前内容读取的副作用是否对调用者可见';
export function state(v) {
 const labels={fixed:'会话已固定旧版',changed:'Notion作者修改完成',reading:'请求当前完整内容',retained:'内部留存产生远端写入',ready:'工具返回完整正文',failed:v.effect==='none'?'严格只读在写前拒绝':'写入结果未知且未返回正文',reported:'按效果证据向用户报告'};
 const broken=[];if(v.outcome==='ready'&&['ready','reported'].includes(v.phase)&&v.writes>0&&v.effect!=='retained')broken.push('留存副作用未披露');if(v.zeroClaim&&v.writes>0)broken.push('错误声称零写入');
 return labels[v.phase]+(broken.length?'：'+broken.join('、'):'');
}
export const step = action=>({EditNotion:'人修改原生正文',RequestFixed:'读取已验证固定版本',RequestCurrent:'明确取得当前版',RejectBeforeWrite:'禁止任何远端写入',RetainObservedContent:'保留已观察版本',ReturnReady:'输出正文及留存回执',LoseAck:'写入已派发但ACK丢失',Report:'生成最终答复',Done:null}[action]??action);
