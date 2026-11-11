# 日用管理到消费的连贯审阅

本轮目标是检查同一 Skill 从管理到实际模型输入的交界，不将各模块 Done 相加当作端到端验证。审阅基线：Broker `d472dbd0cf708890a3a3e58951485ad87f14d28c`、CLI `ca8cc946a662c486fee2817007d13763c3a57c0f`。正常 Pro 包和源码入口未改；实际模型固定 `magpie/group/worker`、thinking high。

结论：代表性内容路径已经贯通；整体最小上下文和低成本仍未证明。发现一个明确的消费副作用披露缺口，两个可量化优化候选，以及仍需独立验证的长期、UI和统计范围。没有在审阅中修补产品来使结果通过。

## 一条真实轨迹

在既有自有验证库，新建一个根、复用一个精确Requires、建立一份reference。公开CLI create成功后启用，未人工修数据。使用独立空消费Store启动正常Pi，保留其他20个日用包与MCP、5分钟discovery/activation、prefetch=false。私有oracle只供旁路检查，不注入提示、回答或消费缓存。

同一个原生会话自主执行list→use→read，暖续问零工具。会话保持开启时，通过公开CLI分别write主文和参考；普通续问保留旧版本，明确refresh再选择完整新版本。随后在新的Pi进程使用这个自有session的精确副本，直接通过Notion API修改两个原生页面，继续验证旧pin、当前刷新和自然续问。原session及用户原有会话保持不变；API作者操作不冒充人工UI验证。

| 阶段 | 实际调用/返回 | 本次测量 |
| --- | --- | --- |
| create根、reference和Requires关系 | 完整成功、自动启用 | 65 HTTP；32.21秒；11写 |
| CLI改单文件主文 | 原pin前提核对、完整新快照 | 52 HTTP；23.47秒；5写 |
| CLI改reference | 接续上次返回的新pin | 53 HTTP；21.52秒；5写 |
| 冷Pi任务 | list→use→read；根/Requires/reference完整 | 4次模型请求；119.29秒；初始发现8 HTTP、consume12 HTTP、固定参考0 HTTP |
| 暖续问 | 无工具，复用原版 | 1次模型请求；30.23秒；0来源HTTP |
| 作者改完仍问旧版 | 无工具，旧主文/参考不混新版 | 1次模型请求；26.27秒；0来源HTTP |
| 明确刷新 | use(refresh=true)→read | 3次模型请求；78.91秒；13来源HTTP |
| 新版续问 | 无工具、正文不重取 | 1次模型请求；21.28秒；6次到期目录metadata |

最后一行不是“暖命中却重复下载”：原View验证时间为07:09:53.123Z，重验开始07:14:55.414Z，已超过300秒。没有工具调用不代表没有后台metadata成本。模型HTTP和源HTTP可能重叠，分段耗时不直接相加；一次运行不能给出整个任务p50/p95。

第一段5轮总计：作者170 HTTP、77.21秒；消费39 HTTP；10次模型请求、累计1,013,244请求实体字节。规范化Pi usage记录input67,457/output4,144/cacheRead206,080，属于该宿主报告口径，不直接当作账单费用。冷任务模型HTTP累计约113.90秒，consume/read合计约5.13秒；此样本的等待主要在模型往返，不能仅靠Notion缓存优化解释全部延迟。

## 已核对的正确性

原生JSONL保留准确model、toolCallId、固定scope/snapshot/File ID。每次实际发送HTTP哈希与被动payload观察一致，必要正文/参考各一份，默认目录没有注入它们。本样本最终需要根、Requires和reference三个文本，不能据此证明大树里未选资源都没有被提前下载；consume已取得三份current body，随后固定reference读取为零HTTP。完整刷新后旧主文和旧reference同时退出后续请求；原会话历史不改写。暖续问逻辑表行数稳定，物理SQLite/WAL增长不被误称业务对象泄漏；本次几轮也不证明长期有界。

最初冷路径的第一份模型请求尚未包含默认目录，因此其显式list不是已证明的重复调用。异步默认发现与零等待首答存在取舍，要比较整个任务，不能为了省一次工具强迫所有聊天先等远端。

## FLOW-EFFECT-01：当前消费的后台写入未披露

直接Notion作者修改完成后，current use成功取得PINE-FLOW-3/MAPLE-FLOW-3/COPPER，并为保留变化内容发出6次成功POST。模型可见工具结果只有`ok/status/purpose/roots/records`，没有语义副作用信息；模型最终答复“未写入”。这是实际接口信息缺口和一次不准确的回答，不是推测。

原生副本第44行use、48行结果、52行回答与6个Notion request ID逐一关联。根和参考版本正确，Required完整；问题在效果与授权语义未贯穿SDK、Broker投影和Agent报告。既有合同允许retention/adoption，不据此宣称后台覆盖了用户正文或新增安全攻击。

建议由原消费结果提供最小语义证据：区分未执行作者命令、未替换用户正文、发生历史留存以及真正零远端写入。具体字段与严格只读失败/固定历史读取的策略需在实施票确定；未观测不填0，不将整份HTTP账本或新的常驻教程塞进上下文，也不删除必要留存来制造零写。模型仍需按证据报告，新增字段本身不保证任意模型正确。

## 默认上下文与请求成本

正常生产源配置下，只要求“收到”的独立`pi -p`，没有工具调用和正文加载，但实际请求实体为123,812 B：Notion默认目录74项/30,611 B、全部工具schema36,120 B、Broker指引811 B。原生本地Skill区有68个名称/34,904 B。四个同名项不足以证明相同身份或重复正文，不可擅自合并。

这次目录刷新12 metadata请求、1,196,396解码响应字节，0正文/0写。正常MCP的ambient transport未全部结束，来源SDK和实际模型请求分别有完整证据；不能将全宿主未知网络填0。Pi报告input31,536和cacheRead1,280，provider价格未知。

811 B说明已经很小，不是当前最大的上下文来源。先比较经过用户同意的默认View范围、内容描述密度和实际任务选路，再考虑局部说明。保持完整授权库存可发现；同曝光基线与不同默认策略必须分开，不通过裁掉正文、隐藏工具或停用安全规则制造改善。

作者操作的重复identity请求分别25/30/31次；这不是可直接删除的81次请求。前提核对、写后读回、索引可见性及Records留存可能需要重复。create还记录8次未细分body类别，已有trace缺少某些内部阶段/因果标签，尚不能可靠给出可删比例。应先比较现有公开apply的多文件路径和必要前后检查，只有证据证明相同scope/freshness/阶段可共用时才合并。

## 局部调优地图

| 边界 | 可观测输入/输出 | 下一步可改变的单因素 | 硬约束 |
| --- | --- | --- | --- |
| 作者输入→管理operation | 冻结文件、原op/ACK、返回snapshot、分类请求 | 现有apply对比两次write、阶段内事实复用 | 完整回读、unknown不重放、保留用户内容 |
| 默认发现→候选曝光 | source/View、原验证时间、候选集合、请求和catalog bytes | 经过同意的常用View、字段密度 | 全库存仍可发现，失败不当空，授权不变 |
| 意图→工具选择 | prompt、可见目录/schema、实际toolCallId与结果 | 明确当前刷新/历史复用的工具叙事或模型策略 | 不执行未授权工作流，不偷偷改变目标版本 |
| 源准备→缓存 | 原scope、age、完整manifest、取得字节、缓存行数 | 必要同次合批/对象复用 | 命中不续期、不跨凭据、取消/哈希完整 |
| 选定图→模型输入 | 根/Requires/reference及完整hash、实际发送次数 | 去掉已被同请求证明重复的机器包装 | 完整正文、失败无半提交、旧参考不残留 |
| 消费→最终报告 | 当前效果证据、完整结果、模型答复 | FLOW-EFFECT-01语义副作用字段与报告要求 | 未知不等于无副作用，不能隐去合法写入 |

每次实验冻结源码/包、模型selector和实际路由、thinking、任务、内容版本、权限、默认可见集合、原cache age和工具schema。用现有SDK/Undici/session观察器保存`管理op→record/snapshot→SDK requestId→toolCallId→provider hash→任务结果`的侧录关系。只改变一个因素，保留失败和成本未知，并用留出的任务防止对固定答案调参。当前未做模型训练、降低thinking或多样本胜率比较。

## 形式化与仍未验证的范围

[flows有限组合模型](../../../verification/models/consumer-observations/flows/README.md)复用现有statechart/TLC运行器。ManagementToDelivery的实现规则15状态通过；4个保护移除配置按指定性质失败。RetentionDisclosure当前6状态的两条性质失败，提案和报告负例单独保留。后者尚未修复，runner匹配预期不等于现产品全绿。模型不证明任意LLM诚实或Notion跨页原子性。

仍缺：长期缓存增长与大库多分位；统一trace阶段归因；作者与消费之间真正只读/允许留存的公开选择；同条件本地全局Skill对照；人工UI与物理Mini；脚本/大binary/多来源的代表性组合。这些不阻塞当前已实测的文本管理与消费日用路径，但不能被此小样本声称完成。

原始证据在Pro `verification-evidence/ah681-20261108/dogfood-flow-audit-5ZQLVa/`。`spine-review.json`、`native-review.json`、`daily-review.json`分别是三种场景的独立审计；`formal-repo-flows/summary.json`保存8配置和源码绑定。初版review把到期metadata误当暖零请求的失败、私有oracle误用未归档历史pin的失败均保留为验证方法边界，不包装成新产品Bug。普通`s_`是本地固定版本；跨机历史需要原archive/restore合同，不静默回退current。
