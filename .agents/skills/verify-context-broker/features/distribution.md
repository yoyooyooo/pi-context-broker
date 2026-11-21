# Distribution

## 默认 SDK 的 CI 安装门禁

当前只验证 Broker 与配对的 ntn-skills SDK v2。CI 和 publish 钉住相同的 CLI commit，从该输入构建 Broker，再用独立空 HOME 做生产依赖安装。SDK v1、CLI 消费回退、旧 snapshot/cache fixture、Pi 1.4 兼容和 OMP/Tern 门禁已退出当前路径。

从本轮配对 CLI 创建一个 current HTTP fixture：

```sh
node /absolute/notion-skills-cli/scripts/sdk-fixture.ts --outdir /absolute/new-current-fixture --catalog
NTN_SKILLS_BUILD_ENTRY=/absolute/installed/ntn-skills/dist/ntn-skills.js node scripts/verify-artifacts.mjs --fixture /absolute/new-current-fixture/fixture.json --source-http-helper /absolute/notion-skills-cli/scripts/sdk-source-fixture.mjs
```

`verify-artifacts.mjs` 只接受这两个参数。它打包 Broker，独立安装，核对同包 CLI/SDK 的 runtime manifest、SDK v2、必需能力和实际 hash，读取随包 Skill 与参考文件，并复用 `verify-notion-sdk-installed.mjs`。

安装消费从空缓存访问受控 current Notion HTTP，覆盖超过 100 条目录/Files 的分页、准确主文、完整 manifest/File 绑定、暖缓存、use、标量与批量文本/二进制资源、错误 scope/物理 owner 和两处取消。HTTP 只允许 GET 与查询 POST；任何未声明请求或语义写入失败。SDK 消费不启动 CLI 子进程，校验不改写安装文件。

此流程的 Pi 1.5.2 私有依赖只提供 TypeScript loader，不启动 Pi 会话。报告必须明确 `Pi session`、`provider/model`、`live Notion`、`OMP`、`Tern` 为 `not_run`。实际 Pi 日用沿 AH-1197/AH-637/AH-1198 取得当前配对证据，不能从直接 SDK 成功推断。

两份 workflow 都运行 `bun run check:broker`、发布规则回归和以上安装检查，并在成功或失败时保存实际安装目录、请求账本和 fixture。只保存本次结果，不维护新的版本、证据矩阵或总验证平台。发布仍受原 tag/version 校验、`npm-publish` environment 与 provenance 规则约束；本检查不发布。

## Pi 正常日用身份与 SDK 来源归因

日用验收核对Pi有效配置真正加载的安装目录、同包SDK身份、完整正文和资源交付、取消及实际provider/serializer。使用保留的 `scripts/notion-sdk-pi.mjs` 与 `scripts/verify-pi-daily-installation.mjs` 公开动作；真实Notion、实际Pi会话和自然模型分别报告。CI安装路径不启动Pi，当前沿 AH-1197/AH-637/AH-1198 取得每机结果。原生终端专项未验收，OMP/Tern延期。

## Gotchas

- `verify-artifacts.mjs` 不接受 `--host`、`--require-sdk`、名称/歧义 fixture 或预植历史缓存。旧 control 的 distribution 两个别名已移除，直接使用上面的现有入口。
- `NTN_SKILLS_BUILD_ENTRY` 必须指向同一完整 CLI/SDK 包；不要同时修改输入或混用源码与已安装旧包。
- 安装检查通过不等于远端 CI、npm 发布或日用切换成功；分别回读实际结果。
- 保留必要失败诊断。只处理本轮自有 scratch，按本机 Trash 规则清理，不执行永久删除或 git clean/reset。
