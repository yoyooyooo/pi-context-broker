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

至少记录两仓commit/必要脏树hash、精确CLI/SDK和Broker包hash、范围/原计划、当前资格、snapshot/version、effects、实际HTTP/完整body、Session及终局。源测试、受控服务、独立安装、真实Notion、真实Pi、自然模型、第二物理机分别用passed/failed/blocked/not_run，不可代证。

共享Requires、目录延迟加载、重复正文、取消/晚到、fork/resume/compaction、冷暖成本仍由原消费地图和guardian负责。一次库对账不能替代这些反例；旧模型/当前结果/历史失败保持原来范围。

新Skill的作者实跑与独立冷Agent评估分开。无法取得冷评估时写 `instruction_evaluation:not_run`，不将结构测试称为Agent使用成功。保持原cleanup：只处理本轮进程和自有scratch，保留未结清原操作Store、原失败与私有会话证据。
