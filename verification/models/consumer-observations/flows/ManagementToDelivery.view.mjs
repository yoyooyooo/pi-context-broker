export const title = '管理、发现、固定选择与后续上下文';
export function state(v) {
 const labels={draft:'作者输入，尚未确认',published:'管理操作已完整确认',directory:'目录候选，无正文',preparing:'准备根与必需规则',selected:'完整选择已提交', 'first-answer':'已读取固定参考并回答',edited:'Notion已更新，旧选择保留','old-answer':'普通续问仍使用旧版',refreshing:'明确准备新版本','new-selection':'新选择已提交，等待新参考','new-answer':'新主文和新参考已回答',done:'后续复用，流程结束'};
 const broken=[];
 if(v.selectedVersion>0&&!v.contextRequired)broken.push('缺少必需规则');
 if(v.ordinaryMoved)broken.push('普通续问换版');
 if(v.contextReference>0&&v.contextReference!==v.selectedVersion)broken.push('旧参考混入新选择');
 if(v.warmBodyFetches>0)broken.push('暖续问重复取正文');
 return labels[v.phase]+(v.phase==='preparing'?`（根${v.mainReady?'已取':'未取'}，必需${v.requiredReady?'已取':'未取'}）`:'')+(broken.length?'：'+broken.join('、'):'');
}
export const step = action=>({PublishVerified:'公开作者操作完整读回',BootAndDiscover:'启动Pi，只取目录',ChooseTask:'用户明确使用',GetRoot:'取得根正文',GetRequired:'取得必需正文',CommitUse:'提交固定选择',ReadReference:'按该选择读取参考',EditInNotion:'用户完成Notion修改',OrdinaryFollowup:'普通续问复用',RequestRefresh:'明确更新当前版本',CommitRefresh:'完整提交新选择',ReadNewReference:'只读新固定参考',Finish:'再次续问',Done:null}[action]??action);
