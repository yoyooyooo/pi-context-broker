# 当前独立安装消费

按 [integration Skill](../SKILL.md) 绑定同一 CLI commit 构建出的 CLI/SDK 与真实 decoder。执行已有 `scripts/verify-artifacts.mjs`，由它打包、独立安装并调用 `scripts/verify-notion-sdk-installed.mjs`；不要再包一层安装 runner。

输入是同提交生成的 current HTTP fixture 与 `sdk-source-fixture.mjs`。安装后的真实 CLI/SDK 字节必须与 runtime manifest一致，SDK v2 capability完整。错包、错hash、缺资源、退役命令及旧参数都应失败，不能回落开发 shim、发布版或 checkout 缓存。

消费从空客户端访问真实受控 HTTP：完整分页目录与 Files、主文、warm复用、use、标量/批量资源、二进制、wrong owner/scope 和取消。只允许metadata查询与读取，语义写入为零；正文消费不启动CLI子进程。随包 Skill 的主文与每个参考资源都要在独立安装目录可读。

读取本次 manifest、commands、current-sdk/result 与 HTTP 日志，不只看退出码。该入口不启动真实 Pi，不能证明真实服务、模型、原生终端或日用安装。AH-1063 沿 [实际 Pi 地图](daily-installation-ui.md) 单独执行；OMP/Tern 延期。
