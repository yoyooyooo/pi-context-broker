export const title = '当前内容读取的副作用是否对调用者可见';
export function state(v) {
 const labels={fixed:'会话已固定旧版',changed:'Notion作者修改完成',reading:'请求当前完整内容',retained:'内部留存产生远端写入',ready:'工具返回完整正文',reported:'模型向用户报告'};
 const broken=[];if(['ready','reported'].includes(v.phase)&&v.writes>0&&v.effect!=='retained')broken.push('留存副作用未披露');if(v.zeroClaim&&v.writes>0)broken.push('错误声称零写入');
 return labels[v.phase]+(broken.length?'：'+broken.join('、'):'');
}
export const step = action=>({EditNotion:'人修改原生正文',RequestCurrent:'明确取得当前版',RetainObservedContent:'保留已观察版本',ReturnReady:'输出给Agent的结果',Report:'生成最终答复',Done:null}[action]??action);
