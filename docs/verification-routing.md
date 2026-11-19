# 管理与消费验证交接

复用已有领域入口，按实际变更选择最小完整范围。每个入口拥有自己的状态和测试，不复制总验证平台。

| 变化 | 所有者 | Broker 交接条件 |
| --- | --- | --- |
| 作者正文、Files/Records、完整导入与当前 operation | CLI `.cursor/skills/verify-notion-management/SKILL.md` | 当前目录或已选内容失效，需要核对消费方刷新 |
| list/read/use、当前快照、本地固定资源、请求预算 | CLI `.cursor/skills/verify-notion-consumption/SKILL.md` | SDK 字段、缓存资格或实际正文发生变化 |
| Source 配置、成员发现与接纳 | CLI `.cursor/skills/verify-notion-source-onboarding/SKILL.md` | 成员曝光、默认 disabled、依赖或当前来源绑定变化 |
| 资格、请求顺序、固定选择、provider/turn/投影 | [consumer state](../.agents/skills/verify-notion-consumer-state/SKILL.md) | 对应 observations / consumer-state 模型与真实守卫 |
| CLI/SDK 配对、当前消费、独立安装包 | [integration](../.agents/skills/verify-notion-skills-integration/SKILL.md) | 跨仓合同或实际安装字节变化 |
| 其他宿主注入、生命周期和分发 | [context broker](../.agents/skills/verify-context-broker/SKILL.md) | 仅验证本次选择的宿主和功能 |

CLI feature 归属由其 `verification/skill-domains.json` 维护。Broker 三项入口分别是 `.agents/skills/verify-notion-consumer-state/SKILL.md`、`.agents/skills/verify-notion-skills-integration/SKILL.md`、`.agents/skills/verify-context-broker/SKILL.md`。

## 当前执行边界

当前配对只接受 SDK v2，普通消费恒零语义写入，SDK 不接收 `readOnly`。独立 Broker 包使用同一 CLI 提交构建的 current HTTP fixture，验证完整分页目录、正文与资源、身份和取消；不预植历史快照，不走退役 CLI 正文消费路径。

仅改文档路由，运行 `node --test scripts/verification-skill-routing.test.mjs` 和已有合同检查。改状态守卫，沿 consumer-state 入口核模型对应和真实反例；改消费 transport 或随包运行时，沿 integration 入口检查实际安装。跨域时执行相交的必要检查，不把一次通过扩成整个系统通过。

保留的有限模型由 observations 与 consumer-state 两套 coverage 维护。SDK capability、当前 import 的目录失效、包 pin/build 和真实 HTTP/serializer 是各自的实现检查，不因被写入 source hash 就获得形式证明。

## 结果交接

Source 接纳默认 disabled。Source ready、目录完整、本地固定字节、完整正文交付、provider 接受、turn 完成和宿主公开投影必须分开判断。本地旧 pin 不承诺远端历史恢复；明确重新选择后才获取当前内容。

管理结果 partial/unknown 保持原意图和实际状态；当前读取相同不能制造原ACK。消费端失效必须绑定当前 library/entry 与 operation，不按同名 Skill 猜测。模型、回执摘要和 HTTP 2xx 都不能代替实际 serializer 中的完整正文。

报告只记录本次实际候选、所选范围、结果和具体限制。源码测试、受控 HTTP、独立安装、真实 Notion、Pi 会话、provider/model 分别判断。安装入口不启动 Pi；真实日用沿 AH-1063 在真实表切换后执行。OMP/Tern 延期，不作为当前 Pi 主线的默认前置。

Skill 作者执行与独立冷启动评估分开；未完成后者时标明 `instruction_evaluation:not_run`，不把结构测试称为 agent 使用成功。清理只处理本轮进程和自有绝对路径，经系统 Trash；不动用户会话、全局配置或未结清的当前 operation Store。
