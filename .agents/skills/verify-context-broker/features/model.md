# 实际模型使用

模型验收归 AH-1063 的实际 Pi 日用路径，复用 `scripts/verify-pi-daily-installation.mjs` 与 `scripts/verify-pi-daily-candidate.mjs`。先确认有效配置加载匹配安装、当前 Notion 表已切换、所选 provider/model 已获授权，再执行原助手的 candidate-plan 和 candidate-run。

保留正常公开工具与自然任务。模型必须实际选取正确来源，完整读取所需正文/资源，收到与选择绑定的内容，并完成成功回复。只记录所选 scope/owner、实际 acquisition、provider/serializer、工具结果与模型结果；不把源码、目录可见、HTTP 2xx、mock OK 或人为改正后的回答当成自然首次成功。

现有 `notion-integration-model.mjs` 与 `notion-consumer-model.mjs` 只保留被实际观察和回归复用的 observer。它们不再包含旧 source.command、默认双宿主的运行函数。provider 正文、模型自述、assistant 引用与源原件分别计数，不能以相同文字推断实际加载。

受控 Pi/provider 场景用于验证工具与序列化边界，见 [context-once](context-once.md)。真实模型结果单列，未运行记录 `not_run`。OMP/Tern 模型路径延期；不恢复旧模型总入口来补成绩。
