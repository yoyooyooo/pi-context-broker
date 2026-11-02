# 独立安装包消费

前置条件：提供实际存在的 `/absolute/package.tgz`，npm 与双宿主工具可用；允许生产依赖安装所需网络。包必须是本次待验收产物；不以 checkout 替代。Doctor 只检查工具存在与版本，不安装、不认证。

安装消费与真实远端 fixture 是不同 mode。后者使用 `node scripts/verify-notion-integration.mjs doctor --mode live-fixture --database UUID` 与 `node scripts/verify-notion-integration.mjs run --mode live-fixture --database UUID`，唯一页及 `references/guide.md` 创建后消费，finally 仅 archive 自建页与 child pages 并 GET 确认；审阅 `live-fixture-create.json`、`live-fixture-cleanup.json`。只读 live 不替代它；live-fixture 通过也不证明 tgz 安装消费。

installed 与 deterministic 同样执行双宿主 filesystem source metadata/read/native RPC+print/`$`/resource、Notion native cold print、歧义 `$ui-alpha@notion` provider 计数 0 后两个 qualified native 独立 page body，以及 OMP runSourceLifecycle 的真实 fork/branch/compact-remove+refresh。分别审阅 `pi-fs-`/`omp-fs-` 系列、`*-cold-print-provider.jsonl`、`*-duplicates-rpc.json` 和 lifecycle helper 实际返回文件，不能用 checkout 路径替代安装产物。

live-fixture 可用 `--resume-evidence /absolute/FAILED_EVIDENCE` 恢复：旧 scratch ownership/input unique name、catalog exactname 唯一与 read canary 通过后不 create，最终 archive；可加 `--model provider/model --model-prompt TEXT` 对同页模型消费后 archive。创建 deadline 15 分钟，intent 的 create-started/unknown 不等于成功。这些远端选项不改变 installed 的包验收边界。
AH-255 可以在同一次真实 fixture run 指定两份已安装产物：

```bash
node scripts/verify-notion-integration.mjs doctor --mode live-fixture --database "$FIXTURE_DATABASE" --command-json "$INSTALLED_CLI_ARGV" --extension "$INSTALLED_BROKER_ENTRY"
node scripts/verify-notion-integration.mjs run --mode live-fixture --database "$FIXTURE_DATABASE" --command-json "$INSTALLED_CLI_ARGV" --extension "$INSTALLED_BROKER_ENTRY"
```

`FIXTURE_DATABASE` 必须来自当前独立 fixture receipt；`INSTALLED_CLI_ARGV` 为真实 npm 安装 bin 的 JSON argv（例如 Node 绝对路径与安装后 JS entry），`INSTALLED_BROKER_ENTRY` 来自安装包的 pi/omp extension metadata。Node 参数须为真实 Node executable，不使用 Bun 或宿主二进制；共享 `--skill-ref` 仍原样使用 CLI 返回的 `record.ref`。Doctor hash 实际入口，run 全部 mutable CLI/XDG 根在 scratch；现有 integration 没有 `--profile`，不继承机器 Profile 绑定，具体边界见[默认目录地图](default-context-prefetch.md)。该路径把安装 CLI→官方 Notion→pinned export→安装 broker 的 Pi/OMP native read/`$`/resource 连接在同一组 identities 上；仍以实际 branch assertion/产物hash为准。模型与实际输入 UI 单独验收，不能由 provider 捕获替代。


包内 CLI 与前置依赖隔离另运行 `node scripts/verify-artifacts.mjs`：在解包目录执行生产依赖安装，实际启动 npm/Tern 两份 `ntn-skills.mjs`；两份 query 在缺 `ntn` 时仍返回本地候选与 `NTN_UNAVAILABLE`，安装后的 extension 重跑双宿主缺 command/ntn/version/capability/auth、选择阻断与 refresh 恢复。该入口不替代下表 installed mode 的完整 snapshot/会话验收，也不证明真实 Notion 认证。

| ID | 用户入口与动作 | 可观察 assertion |
| --- | --- | --- |
| NS-INSTALL-01 | 用户指定 tgz，harness 在独立 scratch 实际安装 | 记录实际 `npm install --prefix scratch` 与结果，消费入口来自安装产物；不能仅解包、读取 checkout 或打印安装命令冒充安装。 |
| NS-INSTALL-02 | 用户从安装产物启动 Pi/OMP 并发现 metadata、host read、native Skill | 两宿主真实加载安装后的 extension/source，metadata 与实际正文读取一致；缺文件或依赖应失败。 |
| NS-INSTALL-03 | 用户首次 `$` 激活、重复提交并 continue，触发 fixture 重名/错误/超时及冷暖路径 | 安装产物完成与 deterministic 相同的双宿主 provider 捕获与断言；任何子路径缺失分别记 failed/未运行，checkout 的通过不能填补。 |
| NS-INSTALL-04 | 用户审阅后清理本次 scratch，再读取 evidence | cleanup 仅将拥有 ownership.json 的关联 scratch 移到系统 Trash；独立 evidence 保留，cleanup.json 与证据命令反映真实结果。 |

```bash
node scripts/verify-notion-integration.mjs doctor --mode installed --package /absolute/package.tgz
node scripts/verify-notion-integration.mjs run --mode installed --package /absolute/package.tgz
node scripts/verify-notion-integration.mjs evidence --evidence /absolute/evidenceDIR
node scripts/verify-notion-integration.mjs cleanup --evidence /absolute/evidenceDIR
node scripts/verify-notion-integration.mjs evidence --evidence /absolute/evidenceDIR
```

安装 argv 显式使用 `--workspaces=false`，避免临时目录继承 workspace 语义。若当前 npm registry 不提供所需公开包，仅对本次调用选择 registry：`npm_config_registry=https://registry.npmjs.org node scripts/verify-notion-integration.mjs run --mode installed --package /absolute/package.tgz`。不修改用户全局 npm 配置或产品默认 registry。

用 run 实际输出的绝对 evidence 目录替换示例。evidence 与 manifest.scratch 是独立 `/tmp` 目录；安装目录和 fixture 属于 scratch。不得永久删除 evidence，不清理用户目录或全局 npm 安装，不把清理成功写成消费通过。

审阅 manifest 中的实际包、命令、版本与 scratch 归属，以及 `pi-provider.jsonl`、`omp-provider.jsonl`、`pi-rpc.json`、`omp-rpc.json`、对应 decisions 和 fixture `source-cli-calls.jsonl`。npm 成功仅满足安装环节，不证明宿主激活；单宿主成功也不能代替另一宿主。各 ID 独立报告 pass/failed/未运行。本地图定义验收，没有执行安装或验证。

## AH258–260 shared content acceptance

Record actual CLI, Broker, Pi/OMP and installed consumer versions/hashes. Require strict records/record/entrypoint wire and portable v2 with kind. Capture Pi and OMP two-turn Prompt user-task delivery, mixed kinds/images, cancellation and lazy Router member reads. Installed artifacts, real Notion, UI, real magpie/group/flash-free model and controlled-provider evidence remain separate; source fixtures do not prove installed acceptance.

当前 installed runner 不提供完整 AH258–260 matrix；双宿主 two-turn Prompt、混合 kinds/images、取消、Router lazy member read 与真实模型/UI 分别保留独立证据，未实际驱动的格子逐项记 `not_run`，不能以现有 Skill fixture 通过代填。

No execution is claimed by this map update; final owner runs and retains the evidence.


## Pi-only candidate acceptance

Use `bun scripts/pack.mjs --target broker --out-dir ABSOLUTE_OUTPUT` to build the npm artifact without touching Tern outputs or installing its runtime. Select the current CLI with `NTN_SKILLS_BUILD_ENTRY` for a development candidate; formal published dependency requirements are unchanged. Install that archive in a fresh prefix and pass its real extension plus bundled CLI to `verify-notion-integration.mjs doctor/run --mode live --host pi`. Add a separate `--mode model --host pi` run for authorized real-model entry and resource use. `selectedHosts` and owned-process receipts must contain only Pi; OMP/Tern remain unrun. The default multi-host route is unchanged.

### 2026-11-02 normal-path result

A separately installed npm candidate was exercised with Pi 1.4.0 and Node 24.20.0 against a real two-file shared Notion Skill. Main and resource bodies were directly edited through the official Notion API, then observed by the CLI as a new complete fixed snapshot; the earlier pin remained unchanged. The Pi-only live run passed metadata-only advertisement, native read, cold native command, dollar selection, both invocation switch directions, repeat deduplication and persisted continuation. Its provider was controlled, so this result is separate from model acceptance.

The authorized `magpie/group/flash-free` model independently selected and read the complete entry and resource. It completed four provider requests, one verified entry read and two verified resource reads, returning a nonempty successful `stop` answer that cited both changed version markers and the required risks. An earlier run exhausted the old 120-second prompt budget without a final answer and remains failed. A new run under the separately recorded 300-second model budget completed in 124061 ms; assertions and deterministic RPC defaults were unchanged.

Two cold real Pi PTYs additionally passed prefix → Tab → Enter and dollar/native switches, with natural process exits; their source/provider were controlled fixtures. `check:broker` passed without touching Tern outputs, including package behavior checks, completion, types, 66 shared-adapter/View tests and 17 routing/pack/budget tests. This is installed-candidate normal-path evidence on one physical host, not a production-library migration, global Pi configuration replacement, published release, OMP/Tern acceptance or second-machine result. Exact inputs, artifact identities and raw per-run receipts are retained outside checkout in a durable evidence root.

### 2026-11-02 bounded result

An independently installed npm candidate bundled CLI source `62f9a72632110d45ca966202607aea190e17948c` and ran on Node 24.20.0 / Pi 1.4.0. Its separate live-Notion run passed metadata advertisement, cold native read, `/skill:` and dollar activation, both switching directions, repeat deduplication and persisted continuation. A separate two-direction Pi PTY run passed prefix/Tab/Enter interactions and natural process exits using controlled source/provider fixtures.

The selected live Skill had two authored files. Official native Notion edits changed both bodies and Description; CLI reconstructed the same new snapshot from empty local state and preserved the old pin. Native disable/enable checks preserved identity and content. These are API edits, not manual browser UI acceptance, and the empty-state readers ran on one physical host.

The first authorized `magpie/group/flash-free` run did not finish within the old 120-second prompt budget and remains failed. A separate run under the recorded 300-second model-only budget completed in 124061 ms: four provider requests, one receipt-validated entry read, two resource reads from the same snapshot, and a nonempty final with stop reason `stop`. The final named both updated version markers and three blockers. This is functional instruction/resource use, not a general latency claim. Daily global configuration, npm publication, full migration, OMP/Tern and second-machine acceptance were not performed. Full inputs and results are retained in a durable private verification directory outside checkout; the CLI's shared architecture checkpoint records the same scope.

### 2026-11-02 full production-library cutover

The approved production library now contains 300 content entries (298 enabled), 818 editable supporting rows and 1,874 complete business files; the CLI repository records full three-table/file/history reconciliation. Both original business databases were confirmed empty and recoverably retired. This result supersedes the earlier sample-only migration checkpoint, not its historical receipts.

A newly packed and independently installed Broker uses the Notion-resident bundle-capable CLI. The actual Pi live run against this production library passed metadata-only default discovery, native read, `/skill:`, dollar activation, both switching directions, repeat deduplication and persisted continuation. It explicitly selected `--prefetch false`, matching the deployed source setting; all 74 default-View entries remain advertised, while body preparation is selection-driven. This run used a controlled provider. The separate authorized `magpie/group/flash-free` attempt returned a Premium-license requirement and made no tool read; it remains failed, without changing the model or credentials.

The pro daily package path and existing Notion source now select that installed Broker and the new database. Other packages, local roots/rules, credentials and existing user sessions remain intact. A new/restarted Pi process is required to load the updated extension. Mini separately installed the CLI candidate under empty local roots with its own authentication and verified the 298-entry catalog, Resin's binary content, all 203 archify files and the Pstack member index. No credentials, SQLite or materialized content were copied. OMP/Tern remain deferred and their daily configuration/output was not changed; npm publication and broad performance acceptance are not inferred from this deployment.

The ordinary live/model runner accepts `--prefetch true|false` and preserves its old default when omitted. It rejects that option for unrelated specialized scenarios. The runtime gate, config/schema/docs and source-runtime tests cover `prefetch:false` without changing explicit load behavior; 19 host/pack/prefetch checks pass. Existing entry/resource/final-answer assertions remain unchanged, so an HTTP success containing a license notice cannot be relabeled model-task success.
