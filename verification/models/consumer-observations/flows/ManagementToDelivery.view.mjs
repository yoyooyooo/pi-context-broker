export const title = '固定选择与抽象上下文';
export function state(v) {
 const labels={draft:'作者输入尚未确认',blocked:'管理回执未完成，停在交接边界',published:'已通过管理回执入口',directory:'目录候选，尚无正文',preparing:'准备主文与必需依赖',selected:'固定选择已提交', 'first-answer':'固定参考已进入抽象上下文',edited:'Notion已更新，原选择保留','old-answer':'普通续问完成，检查固定版本',refreshing:'明确准备新版本','new-selection':'新选择已提交，待取新参考','new-answer':'新主文与新参考已进入抽象上下文',done:'后续复用完成'};
 const broken=[];
 if(v.selectedVersion>0&&!v.contextRequired)broken.push('缺少必需规则');
 if(v.ordinaryMoved)broken.push('普通续问换版');
 if(v.contextReference>0&&v.contextReference!==v.selectedVersion)broken.push('旧参考混入新选择');
 if(v.warmBodyFetches>0)broken.push('暖续问重复取正文');
 return labels[v.phase]+(v.phase==='preparing'?`（根${v.mainReady?'已取':'未取'}，必需${v.requiredReady?'已取':'未取'}）`:'')+(broken.length?'：'+broken.join('、'):'');
}
export const step = action=>({PublishVerified:'交接完整管理读回证据',RejectUnverifiedManagement:'管理回执不足，停止该交接',BootAndDiscover:'启动并发现目录',ChooseTask:'明确使用该技能',GetRoot:'取得主文',GetRequired:'取得必需依赖',CommitUse:'提交固定选择',ReadReference:'读取该选择的固定参考',EditInNotion:'完成Notion内容修改',OrdinaryFollowup:'普通续问',RequestRefresh:'明确请求刷新',CommitRefresh:'提交新选择并处理旧参考',ReadNewReference:'取得新选择的参考',Finish:'再次普通续问',Done:null}[action]??action);
