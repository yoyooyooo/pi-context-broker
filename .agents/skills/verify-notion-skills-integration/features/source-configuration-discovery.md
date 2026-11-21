# 当前来源配置与发现

[当前 integration 入口](../SKILL.md) 负责配对 SDK 与安装；本页只列来源边界。

远端 `type: notion` 配置使用当前库入口与明确 Source/namespace，消费通过同包 SDK v2。旧 custom command、cache identity fallback、notion_page/subscription locator 不可用。UUID/URL 可作为用户输入，经当前目录和精确物理归属检查后才成为 current identity。

核对 source-connection、notion-entry、notion-source-sdk、remote-catalog、shared-notion-adapter 与 catalog-cache 的现有回归：多 Source 隔离；同名消歧；未认证/拒绝/缺失页保留错误；false-enabled 不曝光；完整分页后才声称目录完整；一处失败不能掩盖其他来源或恢复错误来源的旧正文。

只读发现不读取正文或资源，不写 Notion。View 选择沿 [默认目录](default-context-prefetch.md)。目录投影的本地 stub 由 SDK metadata 派生，保留原 validated_at；写 stub 的时间不能延长远端 TTL。

`STATE_CUTOVER_REQUIRED` 要求新的 `NTN_SKILLS_HOME`；存在旧 sync/upstream 配置时还需新的 `NTN_SKILLS_CONFIG_HOME`。cacheDir 或 `NTN_SKILLS_CACHE_HOME` 不能替代 state.sqlite 断代。不要擦用户状态来制造通过；保留旧输入并使用独立空客户端。

实际安装用 integration 的 current HTTP 路径，真实 Pi/Notion 由 [日用地图](daily-installation-ui.md) 执行。OMP/Tern 延期。
