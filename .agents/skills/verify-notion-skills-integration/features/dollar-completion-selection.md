# 来源候选与明确选择

当前 `$name@source` 候选来自实际可见的当前目录，使用 source namespace；不恢复 repo/upstream 隐式 namespace。名称、source、scope、logical ID、locator 与引用保持独立，接受候选后不能换成同名对象。

源码入口复用 completion、naming-contract、accepted-selections、session-short-ref、view-discovery 和 input-guard，完整执行由 `bun run check:broker` 统一。保留 Unicode/百分号、同名多源、false-enabled、permission、partial View 与旧 locator 拒绝等守卫。

普通未知字符串不自动变成接受引用。明确接受后来源失效时向用户/模型说明未加载；取消与新 epoch 隔离，迟到选择不能激活正文。菜单出现、草稿接受、完整正文投递与 turn 完成各自判断。

## Pi 独立终端

当前实际 Pi SDK/serializer 使用 `scripts/notion-sdk-pi.mjs`，日用安装沿 [日用地图](daily-installation-ui.md)。这些结果不自动覆盖终端的候选帧、Tab、光标、删除/撤销、焦点或双向命令切换。原生终端专项本轮未验收，旧 CLI fixture PTY 驱动已删除。

OMP/Tern 延期；不得使用延期的 UI 模式填补 Pi 结果。重新验证 UI 时使用当前实际产品与安装，从有限用户动作开始，不恢复旧消费协议。
