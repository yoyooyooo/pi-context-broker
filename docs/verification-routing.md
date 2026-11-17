# 管理与消费验证交接

本仓保留既有三项验证 Skill。CLI 的长期管理、消费与来源接手有独立执行入口；职责拆分不复制测试服务、runner、模型或状态事实。

| 用户变化 | 主要负责人 | 接到本仓的条件 |
| --- | --- | --- |
| 正文、完整树、移动/删除/恢复、原页修复 | CLI verify-notion-management | 管理结果改变当前目录、固定图或effects |
| list/read/use、缓存资格、固定资源、请求账本 | CLI verify-notion-consumption | SDK字段、实际context/provider/session受到影响 |
| Source配置、成员发现、新建/原页绑定 | CLI verify-notion-source-onboarding | 新成员是否曝光、默认disabled、依赖和正确pin |
| 当前资格、固定选择、provider/turn/持久化状态 | [consumer state](../.agents/skills/verify-notion-consumer-state/SKILL.md) | 原observations/consumer-state模型和真实guard |
| CLI→SDK→Pi、管理回执→effects、真实正文 | [integration](../.agents/skills/verify-notion-skills-integration/SKILL.md) | 原flows与现有实际Pi/HTTP/模型驱动 |
| 其他宿主注入、生命周期和分发 | [context broker](../.agents/skills/verify-context-broker/SKILL.md) | 仅运行所选宿主，不把OMP/Tern推为默认前置 |

CLI路径分别为 `.cursor/skills/verify-notion-management/SKILL.md`、`.cursor/skills/verify-notion-consumption/SKILL.md`、`.cursor/skills/verify-notion-source-onboarding/SKILL.md`。其唯一feature归属在 `verification/skill-domains.json`，共用隔离设施保留在原 `verify-ntn-skills`。导航可从 [CLI维护PR](https://github.com/yoyooyooo/notion-skills-cli/pull/10) 的精确候选进入；不要把导航链接或本仓已发布旧SDK当作当前候选证明。

## 选择最小完整范围

只改文档路由，运行本仓 `node --test scripts/verification-skill-routing.test.mjs` 和已有合同检查。只改CLI内部语义且SDK/宿主合同不变，跑对应CLI领域及安装代表。影响交接时，先取得CLI实际身份、完整输入和原操作结果，再用同一候选构建Broker，选原Pi驱动。实际模型次数与预算沿原任务冻结合同，不因验证Skill拆分增加一轮自然模型重试。

Source接纳默认disabled：主表存在和authoring只读成功不代表普通目录曝光，目录展示不代表正文已给模型。原管理任务partial/unknown要逐项保留；当前读取相同不能制造原ACK。须分别保存原正文、Notion投影、固定消费内容及实际serializer发送内容。

## 证据交接

Git 来源的接管粒度是单份文档：改过的主文或 reference 整份从 Notion 消费，未改文件仍取已选 Git commit。CLI 的 mixed acquisition v3 和原文件归属/恢复协议拥有这个决定，Broker 不再判定哪份归 Git 或 Notion，也不把整个 Skill 重新导入 Files/Records。验收同一候选包的 SDK `consume`、资源 `read` 和真实 Pi 的完整正文/固定引用；主文未改与主文接管分开覆盖，旧会话 pin 保持原字节。

SRC19 的实库新任务与旧 NXT 自然失败分开留证。安装命令及子进程显式删除 `NTN_SKILLS_DEV_ROOT`，同时记录真正加载的 CLI/SDK/Broker 路径与 hash；只传新包路径仍可能被继承的开发 shim 重定向。不能把受控源测试、源码工作树或旧 SDK 的成功当成本次安装验收。

SRC19 使用原 NXT runner 的显式 v2 输入：必须绑定正式启用回执的 hash、原 Skill/page/library/name/ref，且只允许一个新的只读混合文档任务。v1 的原目标、任务和失败不变；同样保留每任务一次、最多十个实际模型请求和每请求 4096 输出 token，重试关闭。输入与最终 package/hash 在执行前冻结，旧失败不覆盖。

2026-11-17 独立 owned 的 v3 自然维护确实完成了一次原 CLI `apply` 写入并返回 complete+verified，但其最后一轮之后没有额度再产生合格 final：原第 11 次模型 dispatch 被 10 次预算拒绝，这不是操作未提交。此例同时量得一次 114 请求、111 KB 的 CLI 完整 stdout，其中约 109 KB 是逐请求 trace。产品新增可选 `apply --compact`，仅从 Agent 可见回执中省略 trace，保留验证结果、操作 ID 和 aggregated metrics；旧用户默认输出不变。**严格 NXT HTTP 来源审计仍要求原始逐请求 trace，所以现有 NXT guard 明确拒绝 --compact。** 已通过源观察器证明 compact 缺 trace 时是未观察、绝非零请求；若要同时获得精简 Agent 输出与完整 NXT 溯源，需经过另一个明确授权的真实独立请求证据通路，不从摘要推断。安全 guard 不放宽。**不利用这个工具提示修补历史 Session，也不为追绿增加旧任务模型轮次**。原提交及独立读回、Notion正文表示差异、N09空机器历史pin失败的完整证据仍需独立持有。

实际 Git 消费会通过既有 SDK 调用本机 `gh auth token --hostname github.com`。该原生命令不会加载 Node 观察器。SRC19 doctor 先固定所选 gh 可执行文件的真实路径和 SHA；观察器仅对相同二进制、精确参数、活动 SDK 范围内的 spawn 记录独立类型，并要求原 PID、close、外层 SDK end 全部存在。它不保存凭据 stdout 或摘要，不把该进程算作 CLI 正文读取，也不推断其内部 HTTP。未声明探测、不同命令/二进制、缺关闭或未终结 SDK 仍保持不完整。原默认子进程规则不放宽，只有显式 v2 场景传入这一受限合同；代码反例与实际受控 Session 分别留证。此观察器修正不改变产品归属、派发、权限或状态模型的有限性质。

至少记录两仓commit/必要脏树hash、精确CLI/SDK和Broker包hash、范围/原计划、当前资格、snapshot/version、effects、实际HTTP/完整body、Session及终局。源测试、受控服务、独立安装、真实Notion、真实Pi、自然模型、第二物理机分别用passed/failed/blocked/not_run，不可代证。

共享Requires、目录延迟加载、重复正文、取消/晚到、fork/resume/compaction、冷暖成本仍由原消费地图和guardian负责。一次库对账不能替代这些反例；旧模型/当前结果/历史失败保持原来范围。

新Skill的作者实跑与独立冷Agent评估分开。无法取得冷评估时写 `instruction_evaluation:not_run`，不将结构测试称为Agent使用成功。保持原cleanup：只处理本轮进程和自有scratch，保留未结清原操作Store、原失败与私有会话证据。
