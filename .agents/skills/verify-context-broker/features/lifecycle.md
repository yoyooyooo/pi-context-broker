# 当前会话与取消

复用现有 session-active、session-short-ref、native-read-session、host-prepare、skill-context-session 和 consumer-state 回归。状态语义变化先读 [consumer-state Skill](../../verify-notion-consumer-state/SKILL.md)，核对实现、模型和受保护断言的对应；不以更新 hash 代替验证。

| 动作 | 必须观察 |
| --- | --- |
| 普通续问 | 已选择的固定字节保持一致，完整正文按当前有效上下文复用 |
| fork / branch / resume | 只恢复当前分支合法绑定，不使用另一分支的确认 |
| compact | 正文仍在可复用；只剩摘要或 loaded 标记时不能声称完整正文仍在 |
| refresh / 重新选择 | 完整新 acquisition 成功后替换当前选择，失败不扩大资格 |
| cancel / stop | 中断该任务；迟到结果不能激活、延长 TTL 或污染后续 epoch |
| 远端权限收回 | 当前读取拒绝；已选离线文件的本地读取与远端资格分开 |

实际 Pi 生命周期沿 `scripts/notion-sdk-pi.mjs` 当前场景执行，使用实际安装与公开宿主动作；其中覆盖取消后同会话继续、compaction 后完整闭包恢复和缓存丢失降级。fork、切分支和 resume 必须另有实际公开宿主动作与 provider 内容证据；会话文件或手造状态不能替代，也不能由当前四场景推断通过。最终发送与回执沿 [context-once](context-once.md)。

日用接受条件由 [Pi 安装/候选助手](../../verify-notion-skills-integration/features/daily-installation-ui.md) 执行并分层报告；OMP/Tern 延期。旧默认双宿主生命周期入口不属于当前验收地图。
