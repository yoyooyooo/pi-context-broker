# 当前激活与固定资源

沿 [integration Skill](../SKILL.md) 运行受影响的 SDK、host-prepare、fixed-resource-source、resource-read-host 和 session-active 回归。

激活顺序是发现 metadata、明确选择、获取完整所需文件、生成本次固定绑定、实际投递。source ready、文件在本地和工具成功 receipt 都不自动等于正文已进入 provider。Requires 只取当前选择要求的闭包，未选 Members 不预读正文。

每次正文/资源都绑定 Source、scope、logical ID、物理 owner、snapshot 和精确 File ID/路径。标量与批量读取保留完整字节、二进制和 effects；错误 owner、跨路径、缺失文件、篡改 hash、错 scope 和取消必须显式失败。短引用只复制真实发出的 handle，不能拼接 sr: 路径。

固定会话读取保留已选本地字节。远端最新内容必须显式重新选择并通过当前权限/完整性检查；本地 pin 不提供 Notion 历史恢复，也不恢复旧 locator。正文部分成功不能发布完整 manifest 或激活结果。

实际独立安装使用 current HTTP verifier，实际 Pi 另用保留的 SDK/日用助手。模型必须实际读取所需资源且收到完整结果才算模型消费；源码或 mock 的成功不能代替。原生终端和 OMP/Tern 本轮未验收。
