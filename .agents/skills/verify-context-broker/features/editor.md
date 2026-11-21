# 当前候选与编辑器边界

目录候选使用当前来源 namespace 和明确身份。接受候选后必须绑定同一 Source、scope、logical ID、物理 locator 与精确引用；不能按相同名称替换，也不能把旧 repo/upstream namespace 隐式映射成当前来源。

源码回归复用 completion、naming-contract、accepted-selections、session-short-ref 和 view-discovery。核对 Unicode/百分号名称、来源消歧、未知字面文本透传、false-enabled 隐藏、取消后的新 epoch 和资源 handle 的精确 owner。完整 check 仍是 `bun run check:broker`。

## 实际 Pi 与原生终端

实际 Pi 的 SDK/工具/serializer 验证使用已保留的 `scripts/notion-sdk-pi.mjs`；日用安装见 [日用地图](../../verify-notion-skills-integration/features/daily-installation-ui.md)。原生终端候选、光标、Tab 接受、删除/撤销和焦点变化需要真实 UI 操作。本轮没有该专项结果；旧 source.command PTY 驱动已退役，不能据此宣称终端覆盖。

## Three surfaces

OMP/Tern 产品与独立 surface 实验代码保留，当前延期。Tern surface probe 只观察它实际运行的 renderer，不能证明当前 Notion 消费、Pi 日用或真实模型。重新启动这些方向时，从现役产品边界选择有限验证，不恢复旧 CLI fixture 或默认双宿主前置。

权限或 acquisition 失败不得变成已接受正文。界面可见、候选接受、正文发送和模型完成是不同结论，分别记录。
