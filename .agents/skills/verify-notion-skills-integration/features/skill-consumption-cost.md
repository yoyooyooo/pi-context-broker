# 当前消费成本观察

成本必须与同一当前候选、同一任务和完整性结果绑定。先读 [消费链](skill-consumption.md)、[请求引擎](request-engine.md) 与 [实际Pi日用](daily-installation-ui.md)。不保留旧CLI/SDK双轨基线或固定历史场景分母作为日常门槛。

## 分开计量

| 数值 | 实际来源 | 禁止推断 |
| --- | --- | --- |
| metadata/body/resource请求 | SDK实际request metrics与受控HTTP账本 | 命令次数或相同snapshot ID不等于网络次数 |
| 来源正文bytes | 已校验的完整文件 | 字符数、marker次数或截短文本不等于完整bytes |
| provider内容 | 实际序列化payload | tool receipt或session details不等于已发送正文 |
| HTTP发送bytes | 当前run可归属的实际transport | in-process mock不等于wire |
| 模型usage/耗时 | 实际已完成响应 | 未完成任务的usage不能用下界填成总量 |

冷、warm、拒绝、取消、重新选择的初态要明确。使用独立客户端造冷状态，不改用户原缓存。记录原validated_at、scope、所选View和完整目录；窄View、禁用本地Skill、换模型和不同任务各自是策略差异，不能混成一项Broker收益。

## 复用现有观察器

`skill-consumption-cost.mjs`、`skill-consumption-provider.mjs`、`skill-consumption-source-observer.mjs` 和 `notion-default-context.mjs` 的当前metrics/provider oracle供实际Pi候选助手复用。保留原始请求归属、完整body/hash、zero-write、cancel和错误检测；不复制一套runner或证据矩阵。

代码与包范围按 [integration](../SKILL.md) 的当前检查执行。实际Pi使用 `notion-sdk-pi.mjs` 的明确场景；真实日用使用已保留的安装/候选助手。`all`、某个专项和CI安装检查各自报告真实执行范围，不能把历史 all14 成绩变成当前门槛或当前通过。

## 比较与判断

比较之前固定实际包、SDK、Source/scope、任务、工具和模型、cache初态及可接受的完整性结果。保留失败和not_run，不因结果不利事后改分母。样本不足时报告原值与限制；不生成无意义p95或声称因果确定。

完整性、权限、取消或零写红线失败时，不以更少请求或更短耗时宣布改进。已选本地文件和远端最新内容分开；旧pin不提供Notion历史恢复。当前 [context-once](../../verify-context-broker/features/context-once.md) 判断同请求内必要全文与结构的复用，不能按名字或相同字节合并不同身份。
