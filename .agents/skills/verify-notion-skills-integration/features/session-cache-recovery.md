# 当前会话缓存与恢复

当前回归沿 [integration Skill](../SKILL.md)、[consumer-state Skill](../../verify-notion-consumer-state/SKILL.md) 与 session-active、session-short-ref、host-prepare、native-read-session。实际 Pi 用保留的 SDK/日用助手，不走旧跨宿主 CLI fixture 缓存流程。

## 共享 Notion 缓存

SDK/core 拥有远端 metadata、当前资格与固定文件；Broker 的目录 stub 是可丢弃阅读投影。命中时保留原 validated_at，不按投影写入时间续 TTL。Source、credential、store、View 与 scope 隔离，失败、取消和迟到结果都不能延长新鲜度或覆盖更新观测。

刷新遇 ACCESS_DENIED、NOT_FOUND 或 AUTH_REQUIRED 后，后续当前读取必须重新证明正文资格；不能从旧 native body cache 绕过持续拒绝。暂时网络故障不制造权限撤销。已选离线字节仍可按原固定绑定读取，与当前远端访问资格分开。

## 会话恢复

fork/branch/resume 只恢复当前分支合法绑定；压缩后若只剩标记/摘要，不能视为全文仍在。新选择要在完整 acquisition 后替换。标量/批量资源固定同一 scope、owner 和 snapshot；精确路径和字节 hash 每次消费保持验证。

`STATE_CUTOVER_REQUIRED` 透传原错误码，并提示新的 `NTN_SKILLS_HOME`；旧 sync/upstream config另用新的 `NTN_SKILLS_CONFIG_HOME`。state.sqlite 不在 cacheDir，换 cache目录不能完成断代。不删除用户旧状态来制造成功。

## 实际层级

独立包 current HTTP 验缓存、身份和取消；实际 Pi 生命周期必须观察真实公开动作与最终正文；真实 Notion 编辑和模型结果在 AH-1063 单列。没有跨宿主、原生终端或真实模型结果时记 `not_run`，OMP/Tern 延期。
