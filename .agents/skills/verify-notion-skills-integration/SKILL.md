---
name: verify-notion-skills-integration
description: "验证当前配对 CLI/SDK 与 Broker 的消费合同、完整目录、资源和独立安装包。修改 Notion source、随包运行时或消费边界时使用；真实 Notion/Pi/provider 日用另按 AH-1063 验收。"
---

# Verify Notion Skills Integration

## 范围和交接

只验证当前 `next` 单轨。复用现有检查和安装入口，不新增总验证 runner。
OMP/Tern 延期；不恢复 `source.command`、CLI 正文消费、完整 export 回退或旧 snapshot reader。
[验证交接表](../../../docs/verification-routing.md) 指定 CLI 管理、消费、来源接手与 Broker 的负责人。
本 Skill 检查跨仓消费和安装包，不复制作者操作验收，不把旧 feature 地图并入当前门槛。

## 1. 绑定同一份 CLI/SDK

先确认两个仓库的实际提交及未提交改动。选择最终 CLI 提交构建出的完整 CLI/SDK 包，
可以使用 `package:check` 已独立安装的包，或依赖齐全的 checkout 中 `bun run build` 产物。
打包目录本身未安装依赖时，不能直接作为 Broker 的构建入口；先核对已安装包与归档的字节一致。
CI 和 publish 的 CLI pin 必须指向同一完整 commit；不要用发布版或另一工作树代替候选。
以下命令从 Broker 根目录执行。CLI 路径属于选定的完整包，decoder 源码属于同一提交：

```sh
export NTN_SKILLS_BUILD_ENTRY=/absolute/current/notion-skills-cli/packages/cli/dist/ntn-skills.js
export CONTEXT_BROKER_GRAPH_CORE=/absolute/current/notion-skills-cli/packages/core/src
node scripts/skill-consumption-contract.mjs check-gates
```

`CONTEXT_BROKER_GRAPH_CORE` 让完整 manifest 负例经过真实 SDK decoder；未设时会 skip，不能算通过。
只接受 SDK v2 和完整必需 capability。构建检查 runtime manifest 与实际 CLI/SDK bundle hash。
子进程删除 `NTN_SKILLS_DEV_ROOT`，不能赋空值；不得继承开发 shim 绕过所选包。

## 2. 按变化做当前消费检查

本轮配对使用这四个现有文件和类型检查：

```sh
bun run typecheck
bun test packages/context-broker/scripts/notion-source-sdk.test.ts packages/context-broker/scripts/shared-notion-adapter.test.ts packages/context-broker/scripts/catalog-cache.test.ts packages/context-broker/scripts/notion-entry.test.ts
```

核对完整分页目录、稳定 File 绑定与精确 owner/scope；目录完整不等于正文已下载或已投递。
发现阶段只取目录，按实际选择获取完整正文/资源；不截断正文或省略文件来减少请求。
普通消费恒为零语义写入。旧 `readOnly` 参数应在 I/O 前拒绝，不能恢复隐藏写入分支。
保留缓存年龄、凭据/Store 隔离、取消和迟到结果的 guard；失败不能延长 TTL 或发布不完整目录。
只有相关语义改变才扩到现有对应测试；完整 CI 使用 `bun run check:broker`，不要重复跑相同范围。

## 3. 验证实际安装包

用同一提交的 CLI 源码生成新的 current HTTP fixture，输出目录必须属于本轮且未被旧结果占用：

```sh
node /absolute/current/notion-skills-cli/scripts/sdk-fixture.ts --outdir /absolute/new/current-fixture --catalog
node scripts/verify-artifacts.mjs --fixture /absolute/new/current-fixture/fixture.json --source-http-helper /absolute/current/notion-skills-cli/scripts/sdk-source-fixture.mjs
```

保留第 1 步的环境。入口自行执行 broker-only build/pack 和独立临时安装，无须另跑 pack。
它复用 `scripts/verify-notion-sdk-installed.mjs`，不预植 snapshot/cache，不运行旧多根 fixture。
核对分页目录、完整 Files、主文、warm cache、use、标量/批量资源、错误 owner/scope 与两处取消。
安装包同时检查 runtime 版本/hash、随包资源、消费 schema 和 `ctl library import` 必需参数。
读取本次 `manifest.json`、`commands.json`、`current-sdk/result.json` 与 HTTP 账本；不能只看退出码。
确认普通消费语义写入为零、CLI 正文读取子进程为零，且实际加载的是所选包的 CLI/SDK 字节。
该入口只在自有临时目录安装 loader 依赖，不启动真实 Pi 会话，也不更改现有日用安装。

## 4. 区分通过范围

源码检查通过，只证明所执行的当前消费回归；安装包通过，只证明独立包与受控 HTTP 服务的交互。
Source ready、目录完整、本地有文件、正文已交付、当前 turn 成功必须分别判断。
真实 Notion、Pi 会话、provider/model 和日用安装一律保留 `not_run`，直到 AH-1063 实际执行。
AH-1063 在真实表切换后选定匹配安装，核对有效配置、实际 provider/serializer 正文、资源读取与取消。
不能用旧安装、旧回执、模拟 HTTP 或一次 read 代替真实日用成功；OMP/Tern 仍记为延期。

## 5. Formal 和文档改动

沿用[形式化维护合同](../../../docs/formal-verification-maintenance.md)，先审阅当前实现、模型和受保护 guard 的对应关系。
旧 SHA gate 未通过时如实记录阻断；不得自动刷新 hash 放行，也不由旧图或旧结果宣称当前性质已验证。
只复验受影响且已建立当前映射的模型。不要为此修复或运行 legacy feature 全图。
仅修改本入口或验证路由，运行现有检查：

```sh
node --test scripts/verification-skill-routing.test.mjs scripts/skill-consumption-contract.test.mjs
```

## 6. 输入和清理边界

只用明确拥有的绝对输入/输出路径；保留原输入、失败结果和未结清的当前 operation Store。
验证不能改全局配置、用户凭据或日用安装，也不能上传未选择的本地 Skill 内容。
不要重置用户缓存来制造冷读成功；需要空客户端时使用独立临时根，并记录实际缓存状态。
清理只处理本轮进程和自有 scratch，经系统 Trash 使用绝对路径；不永久删除、不批量杀用户进程。
缺少所需输入、能力或安全清理方式时报告具体阻断，不静默缩小覆盖，不伪造成功。
