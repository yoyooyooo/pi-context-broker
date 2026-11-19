# 实际 Pi 日用安装与界面边界

AH-1063 使用已保留的 `scripts/verify-pi-daily-installation.mjs` 与 `scripts/verify-pi-daily-candidate.mjs`。真实表切换后，先核对有效 Pi 配置实际加载的安装，不能把工作树或独立临时包成功称为日用成功。

```sh
node scripts/verify-pi-daily-installation.mjs candidate-plan --config /absolute/current-candidate.json
node scripts/verify-pi-daily-installation.mjs candidate-run --config /absolute/current-candidate.json --live
```

使用该助手现有配置结构与本轮自有输出路径。计划必须绑定实际安装、CLI/SDK、当前库、任务与已授权 provider/model；计划结果不等于运行成功。运行前阅读实际输出并消除配置/字节/协议不匹配，不把旧 source.command 或旧 selector 加回产品。

分别观察：当前 Source可发现；目录完整；实际选择绑定；完整正文/资源进入实际provider/serializer；取消不产生迟到激活；turn完成；后续会话按固定选择恢复。真实模型需要成功响应及实际任务证据，不由 mock、receipt 或模型自述代填。

受控实际 Pi 的 SDK 场景仍在 `scripts/notion-sdk-pi.mjs`，先读 `--help` 并使用匹配的安装/输入。包检查只证明包与HTTP，二者均不能自动证明日用有效配置。

## 界面范围

原生终端候选、Tab、光标、焦点和菜单操作必须实际驱动并观察。本轮原生终端专项未验收；旧 CLI fixture PTY 与旧 OMP/Tern daily UI 驱动已删除。OMP/Tern 产品代码保留但延期，无Tern成绩，不把一个宿主的结果替代另一个。

清理仅限本轮自有进程与绝对scratch路径，经系统Trash。不要复制用户凭据、重置用户会话或以全局重装绕过身份问题。结果分别记录源码、安装、SDK/HTTP、Pi、真实Notion、模型和UI。
