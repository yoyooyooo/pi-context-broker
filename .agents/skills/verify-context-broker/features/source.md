# 当前 Source、目录与消费

先读 [integration Skill](../../verify-notion-skills-integration/SKILL.md) 和 [source 配置地图](../../verify-notion-skills-integration/features/source-configuration-discovery.md)。当前 remote 只通过同包 SDK v2 消费，接受 `shared_skill` 身份；`source.command`、旧 locator 与 prepare CLI 协议在边界拒绝。

## 按行为选择已有检查

| 变化 | 既有文件/入口 | 关键守卫 |
| --- | --- | --- |
| SDK 合同与错误 | notion-source-sdk、notion-sdk、notion-entry | 必需 capability、精确身份、permission、cutover error |
| 目录与缓存 | shared-notion-adapter、catalog-cache、remote-catalog | 完整分页、原验证时间、scope/credential 隔离、失败不续 TTL |
| View | view-discovery | API 顺序、明确选择、空 View、部分覆盖与禁止 fallback |
| 激活与资源 | host-prepare、fixed-resource-source、resource-read-host | 完整 manifest、owner/File、取消和迟到结果 |
| 真实独立安装 | verify-artifacts / verify-notion-sdk-installed | 实际安装包与 current HTTP，零 CLI 正文子进程、零语义写入 |

既有 `notion-integration-fixture.mjs` 只用于管理命令 `ctl views` 的受控 stub；它明确拒绝 list/read/export/prepare 等退役消费，不能作为 SDK 或真实 Notion 证明。

缓存年龄、当前权限和已选本地字节是不同事实，见 [共享缓存](../../verify-notion-skills-integration/features/session-cache-recovery.md#共享-notion-缓存)。`STATE_CUTOVER_REQUIRED` 必须带可操作提示；state.sqlite 属于 `NTN_SKILLS_HOME`，换 cacheDir 不能完成断代。

实际 Pi 使用 `notion-sdk-pi.mjs` 和 [日用候选助手](../../verify-notion-skills-integration/features/daily-installation-ui.md)。当前包检查不会启动真实 Pi；OMP/Tern 延期。完整目录、完整正文、provider 接受和模型完成分别报告。
