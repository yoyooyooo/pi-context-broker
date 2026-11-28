# 实际模型使用

自然用户旅程由 [工作流验证 Skill](../../verify-notion-agent-workflows/SKILL.md) 负责。沿 AH-1196/AH-1198 复用 `scripts/verify-pi-daily-installation.mjs` 的 candidate-plan 与 candidate-run --live；候选实现模块不是独立 CLI。配对身份与实际安装沿 C10/T21，项目候选不代替两机普通日用入口。

正式自然配置使用 `scope:notion-agent-workflow`、真实 `magpie/group/worker` 与 thinking high。daily 保留正常全局/项目本地 Skills、Notion、扩展/MCP；no-native-skills 只增加 -ns。按数据集选择适用环境，不把 -ns 称为纯 Notion，也不以 -ne 或预加载维护说明替代自然发现。

输入来自 `scripts/notion-agent-scenarios.json`，真实路径/页面/版本和私有判据保留在外层绑定。模型自行选择正确来源，读取完整正文与必要资源，并完成业务；冻结 prompt 不预给正确工具名、flag、内部引用或答案。既有完整正文允许复用，不强制每轮重复工具调用。

T16/T17 使用同进程有限事件：采用 A、真实发布 B 并读回、普通继续 A、只看 B、再继续 A、明确采用 B。restart/fork/compact 与原进程继续各自留真实证据。T22 的负例先证明全局目标由正常发现加载、远端目标对实际模型可见，再机械计数全部 notion_use 尝试，失败与撤回也计入。目录后台请求不算模型工具调用。

刷新时间线分别判断三个结果：功能是否完成、任务根及 Requires 角色是否保持、自然调用是否必要。把已自动载入的 Requires 再列为独立刷新根，计入多余调用；即使 `ROOT_ROLE_CONFLICT` 保住旧任务且 Agent 随后完成，也不能将自然选路判为通过。新计划保留原自然提示与旧失败，只为明确的新修复追加独立预算，累计账本不重置。工具参数没有承载用户意图证明；独立选作根必须由实际任务和完整 trace 判断。

分析器关联有效 session 分支、toolCall/result、实际 wire 请求、完成响应与独立业务读回。只记录 scope/owner、当前版本和资源，正文曾出现、prepared、HTTP 2xx、模型自述或退出零都不能替代当前完整投递。读取维护说明不代表采用该 Skill；主文 inspect 与 use 分开判定。

将业务结果、硬合同和效率分别报告。第一份失败、修复、新实例复验和留出变体独立保留；错误来源、混版、缺 Required、只读写入或外部扫尾不能被最终正确措辞掩盖。case 是声明 C/T 的实际切片，不把局部结果扩成整个合同或所有模型的保证。

受控 Pi/provider 场景继续验证工具与 serializer 边界，见 [context-once](context-once.md)。现有 notion-integration-model / notion-consumer-model 只保留被实际观察复用的 observer。受控结果不代填自然层；未运行则记 not_run。原生终端专项、OMP/Tern 本轮仍不由 RPC 或源码通过推断。
