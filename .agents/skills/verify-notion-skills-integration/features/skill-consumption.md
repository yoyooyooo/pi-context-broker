# 当前消费链验证

当前消费是 `next` 单轨：Notion最新内容经同包SDK v3，固定本次选择的字节供会话使用，不在Notion中维护版本历史。先读 [integration Skill](../SKILL.md) 与 [验证交接](../../../../docs/verification-routing.md)。

## 状态与必要守卫

| 阶段 | 必须证明 | 不能据此推断 |
| --- | --- | --- |
| Source ready | 当前配置、SDK capability、scope与来源有效 | 全目录或正文完整 |
| 目录 | 分页完整或明确partial；stable ID、locator、enabled、View正确 | 正文已读取 |
| acquisition | 选择所需文件完整、owner/File/hash正确、权限有效 | 已投递或active |
| 当前请求 | 正文/资源和effect进入实际provider/serializer | 模型自然使用成功 |
| turn与会话 | 真实完成与当前分支合法绑定 | 另一个宿主、模型或未来权限仍有效 |

取消、缺失、权限、预算不足和迟到结果都保持实际失败。未选择Members不读正文；Requires按明确当前闭包获取。相同名称或相同字节不能合并不同来源身份。普通消费零语义写入，cache命中不制造新验证时间。

## 现有入口

- 代码范围：对应当前SDK、adapter、View、host-prepare、session、resource测试；完整检查 `bun run check:broker`。
- 接线：`node scripts/skill-consumption-contract.mjs check-gates`，只验证现有入口确实被check/CI调用。
- 独立包：`scripts/verify-artifacts.mjs` 及其既有安装后SDK verifier；见 [installed-consumption](installed-consumption.md)。
- 状态与反例：[consumer-state Skill](../../verify-notion-consumer-state/SKILL.md)，保留 observations与consumer-state现有映射。
- 实际Pi：保留的 `scripts/notion-sdk-pi.mjs`，按选定场景检查实际工具与serializer。
- 真实日用：[安装/候选助手](daily-installation-ui.md)，AH-1197/AH-637/AH-1198在真实表切换后执行。

当前 [Source发现](source-configuration-discovery.md)、[View准备](default-context-prefetch.md)、[激活/资源](activation-snapshot-resources.md)、[会话缓存](session-cache-recovery.md)、[候选选择](dollar-completion-selection.md) 分别维护自己的有限断言。旧总矩阵、CLI fixture、默认双宿主和历史证据合同不再是当前可执行地图。

## 成本与边界

按实际请求/字节计量：metadata、正文、资源、最终HTTP与模型usage分开。保持100条分页和现有limit/取消控制；不为省请求截断正文，不为验证而重复全文下载。冷、warm、拒绝、恢复使用真实缓存状态；不能用重复snapshot ID证明零网络。

当前实际请求内容唯一性沿 [context-once](../../verify-context-broker/features/context-once.md)。源码oracle只证明其断言，受控HTTP只证明请求边界；真实服务、实际Pi、模型和UI各有结果。OMP/Tern延期，原生终端专项本轮未验收。

修改Skill时运行既有routing/contract测试并核对链接。结构检查通过不是独立agent已能冷启动使用；未做独立评估时明确 `instruction_evaluation:not_run`。不新增总runner或证据平台。
