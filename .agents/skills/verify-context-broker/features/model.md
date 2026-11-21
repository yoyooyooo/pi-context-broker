# 实际模型使用

模型验收归 AH-1196/AH-1198 的实际 Pi 路径，复用 `scripts/verify-pi-daily-installation.mjs` 的 candidate-plan 和 candidate-run --live。候选实现模块不是独立 CLI。先按 C10/T21 required_inputs 确认有效配置加载匹配安装、当前 Notion 表已切换、所选 provider/model 已获授权；计划结果及项目级候选不能代替两机普通日用入口。

保留正常公开工具与自然任务。模型必须实际选取正确来源，完整读取所需正文/资源，收到与选择绑定的内容，并完成成功回复。只记录所选 scope/owner、实际 acquisition、provider/serializer、工具结果与模型结果；不把源码、目录可见、HTTP 2xx、mock OK 或人为改正后的回答当成自然首次成功。

现有候选配置固定 model:magpie/group/flash 与 thinkingLevel:high，不代表其他模型已支持或已验。T16/T17 的轮间远端编辑没有现成自动暂停编排，须公开 Pi 分步驱动与前后原件；仅运行候选仍不足以关闭该时序。T22 的零不必要 notion_use 由独立人工审核完整 trace，失败调用计入，不能用全工具 toolCallCount 替代。完整配置与范围见 [日用地图](../../verify-notion-skills-integration/features/daily-installation-ui.md)。

同时检查实际模型可见的操作状态：`read` 的完整正文交付不代表采用了 Skill；
应用任务须有 use 图和实际完整交付。工具描述存在不等于模型遵守。改结果合同后，
确定性回归与新的自然复验分开，原失败、冻结 prompt/oracle 和阶段预算保留。

现有 `notion-integration-model.mjs` 与 `notion-consumer-model.mjs` 只保留被实际观察和回归复用的 observer。它们不再包含旧 source.command、默认双宿主的运行函数。provider 正文、模型自述、assistant 引用与源原件分别计数，不能以相同文字推断实际加载。

受控 Pi/provider 场景用于验证工具与序列化边界，见 [context-once](context-once.md)。真实模型结果单列，未运行记录 `not_run`。OMP/Tern 模型路径延期；不恢复旧模型总入口来补成绩。
