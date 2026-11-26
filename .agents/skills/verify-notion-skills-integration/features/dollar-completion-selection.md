# 来源候选与明确选择

当前 `$name@source` 候选来自实际可见的当前目录，使用 source namespace；不恢复 repo/upstream 隐式 namespace。名称、source、scope、logical ID、locator 与引用保持独立，接受候选后不能换成同名对象。

源码入口复用 completion、naming-contract、accepted-selections、session-short-ref、view-discovery 和 input-guard，完整执行由 `bun run check:broker` 统一。保留 Unicode/百分号、同名多源、false-enabled、permission、partial View 与旧 locator 拒绝等守卫。

普通未知字符串不自动变成接受引用。明确接受后来源失效时向用户/模型说明未加载；取消与新 epoch 隔离，迟到选择不能激活正文。菜单出现、草稿接受、完整正文投递与 turn 完成各自判断。

## Pi 独立终端

当前实际 Pi SDK/serializer 使用 `scripts/notion-sdk-pi.mjs`，日用安装沿 [日用地图](daily-installation-ui.md)。终端专项使用 `scripts/pi-dollar-pty.mjs`：启动明确指定的 Pi 1.6 CLI，经操作系统 PTY 发送真实按键，用终端解析器读取当前候选帧，并复用当前 SDK HTTP fixture 与实际 Pi serializer。旧 CLI fixture PTY 驱动已删除。

```sh
PI_DOLLAR_EDITOR_PACKAGE=/absolute/installed/@earendil-works/pi-coding-agent bun run test:pi-editor
node scripts/pi-dollar-pty.mjs --package /absolute/standalone/pi-context-broker --pi /absolute/pi/dist/bundle/cli.js --fixture /absolute/current/fixture.json --source-http-helper /absolute/paired-cli/scripts/sdk-source-fixture.mjs --out /absolute/new/pty-output --samples 20
```

`test:pi-editor` 使用已安装 Pi 的真实 Editor、CustomEditor 与 SelectList，回放异步更新、waiting/open Esc、高亮身份、撤下选择、拒绝与不响应的旧任务、光标/删除/撤销、接受显示项和原生 `@` 补全；需要对比旧实现时显式设置 `PI_DOLLAR_EDITOR_ADAPTER` 为待测文件。它验证真实 Editor 行为，不代替终端时延。

PTY 入口验证新进程首次 `$`、冷启动本地与 bundled 候选、缓存候选、后台同屏更新、waiting/open Esc、503 源故障后普通输入继续、Tab 和实际排队输入的完整正文及 Requires 交付。保留原始 ANSI、当前终端帧、按键时间与每进程回执；warm 至少 20 个新进程，分别报告首次菜单、远端缓存就绪和筛选的 p50/p95。按键写入到产生目标帧的终端输出包含 Pi 调度与 debounce；源码调用耗时不能代填。宿主的 `--offline` 只关闭版本/工具下载等无关启动网络，SDK 与 provider 仍经实际 loopback HTTP；故障入口仅返回503，重试与失败由实际 SDK 处理。受控 HTTP 与 provider 只证明该链路，不证明 live Notion 或自然模型理解。未被这些动作覆盖的焦点、双向命令切换和宿主场景仍须单独实测。

OMP/Tern 延期；不得使用延期的 UI 模式填补 Pi 结果。重新验证 UI 时使用当前实际产品与安装，从有限用户动作开始，不恢复旧消费协议。

性能回执同时保留三个口径：实际 PTY 按键到目标帧、SDK cache read/ready，以及后台 catalog HTTP 完成到同屏更新的 parent Node 观测间隔。后者包含 Pi 调度、bridge IPC 和终端解析开销，不能与 Python 时钟相减。`provider-microbenchmark.json` 单独对实际 packed provider 与同一缓存候选集计时，包含首次调用和 300 次多前缀内存筛选；模块加载、缓存读取与候选构造在计时外，不用这一微基准替代真实 Editor/TUI 结论。
