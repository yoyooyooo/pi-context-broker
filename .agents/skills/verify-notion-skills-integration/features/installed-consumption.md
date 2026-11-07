# 独立安装包消费

前置条件：提供实际存在的 `/absolute/package.tgz`，npm 与所选宿主工具可用；本批主宿主 Pi 1.5.0，兼容 Pi 1.4.0 分别留安装态证据，并显式传 `--host pi`，省略时仍是双宿主。允许生产依赖安装所需网络。包必须是本次待验收产物；不以 checkout 替代。Doctor 只检查工具存在与版本，不安装、不认证。

## Pro 本地主线交付

当前主线为 Notion 管理 → CLI 创建/更新主文与 reference → 正常 Pi/Broker 消费。按 [本地候选与回滚](../../../../CONTRIBUTING.md#local-pi-candidate-and-rollback)安装同一物料的 CLI/SDK 与三份 builtin；本地候选无需先发布 npm 或合入 main。下面是本地候选的验证范围，不覆盖或改写已有失败与未运行记录。

| 环节 | 复用入口与观察 |
| --- | --- |
| 包与作者入口 | 本次 CLI tgz 安装后显式绑定 `NTN_SKILLS_BUILD_ENTRY`，只 pack Broker；核对实际 CLI/SDK runtime manifest。原 `skill-guidance.test.ts` 和 installed `notion-sdk-pi.mjs --scenario scoped-command` 证明按需管理指导、真实工具发现与 source 范围，不以此宣称完成写入。 |
| 正常 Pi 自动加载 | `node scripts/verify-pi-daily-installation.mjs plan --config ABSOLUTE_NEW_CONFIG` 准备本次路径与 hash，切换后以同配置 `run`。核对单一 package slot、真实 `get_commands.sourceInfo`、默认 SDK metadata/find、显式 doctor 的独立 body probe；无目标 `-e`、无 source.command 替换。该入口只做诊断，不证明模型任务。 |
| 已授权的作者与消费任务 | 用本次 owned Skill 与 supporting reference 取得 CLI verified 写入结果。复用 `context-broker-rpc-harness.mjs` 在新 owned cwd/session 中启动正常自动加载的 Pi，执行当前授权的自然任务；保留实际 read/use、引用身份、模型终态及内容是否满足要求。按需取正文，Requires 完整、未选 Members 正文为零；不要将已有正文的续问变成重复读取。新草稿 enable 后和已有 Skill disable 后均检查下一次普通选择的目录变化；对应 `Enabled` 回执门见 [NS-BUILTIN-07](builtin-management.md)。 |
| 新旧版本与冷热复用 | 同一候选覆盖首次选择、重复/新进程暖读取、一次已授权更新后的 current 选择和旧 pin。复用原 SDK/HTTP observer，记录真实 requests/bytes、终态与缺失项；目录缓存、正文缓存和会话中已有内容分别解释。warm 可能仍有权限/身份验证，未观测到数据不能记零。 |
| 必要失败边界 | 受本次改动影响的权限、取消、不完整依赖、缓存清理/并发与固定资源身份仍用原反例。其余宿主、旧 C12 A/B/C/D 成本矩阵、Mini 和发布门禁单列状态；不无条件阻塞本机已验证的主线。 |

所有新 config、fixture、entry 和 evidence 路径来自本次允许的目录。`verify-pi-daily-installation` 的 `evidenceRoot`、`notion-sdk-pi` 的 `--package/--fixture/--out` 均可指新路径；其 scratch/cache/data 根由原隔离 helper 在系统临时目录建立。无需读取历史 Logs 或旧工作区来启动新验证。正常日用自动加载检查保留实际 HOME/source/cache，不把它报告为空缓存；冷缓存场景另用 owned 根。

普通 `verify-notion-integration --mode model` 与旧 cache matrix 使用显式 CLI command source，不能据此宣称默认 SDK 已过。C/D intent 路径的冻结目录、oracle 和完整矩阵继续按原合同验收；当前主线的小任务复用底层 RPC 与 observer，不放宽旧 validator，也不为此另建重复 runner。这里只定义路线，执行结果以本次产物、原始证据和实际语义审阅为准。

### SC23 随包调用指导

冻结候选时同时核对安装包的 `docs/reference.md`、`docs/reference.zh-CN.md`、随包 CLI help/schema 与实际 Pi 工具；不能只改 README 示例。当前 Pi 日常入口为 `notion_list`、原生 `read`、`notion_use`，CLI 为 list/read/use，辅助 files/export 与管理 ctl 按需进入。`notion_ctl` 是 deferred 管理/证明工具，默认 schema 不应混入旧 `skill_search/skill_prepare/skill_graph`；OMP 兼容说明及历史回执保留原协议和版本。

| 用户动作 | 原有实际驱动与断言 | 证据边界 |
| --- | --- | --- |
| 发现、检查、使用、固定资源 | `notion-sdk-pi.mjs` 的 default-view/prepare/resource 场景；核对实际 provider schema、完整正文和 SDK/HTTP 账本 | 文字或函数导出存在不能代替安装态消费 |
| 按需管理发现与 CLI scope | 原 `scoped-command` 场景由实际 `tool_search` 发现 deferred `notion_ctl`，下一 provider 收到 schema 后才调用 `notion_ctl({cli_source})`；再核对真实配置命令与 scope，正文/写入零 | 只证明发现与元数据交付，不执行作者操作；禁用 discovery 时须另行明确启用工具 |
| 作者与 unknown 恢复 | CLI 原独立 package smoke 的作者生命周期、原 operation 恢复及零重放断言 | 受控 Notion 服务与真实 Notion 分别记账 |

按需发现沿用 `node scripts/notion-sdk-pi.mjs run --package ABSOLUTE_INSTALLED_BROKER --fixture ABSOLUTE_FIXTURE_JSON --scenario scoped-command --out NEW_ABSOLUTE_EVIDENCE`。在 owned settings 中用公开 `defaultTools` 配置 `read`、`notion_list`、`notion_use`、`bash`、`tool_search`；不以 `--tools` 硬过滤掉尚未加载的非 MCP 管理工具，也不由 harness 调用 `setActiveTools` 提前启用 `notion_ctl`。隔离的 `--no-extensions` 进程显式加载该宿主实际安装的官方 tool-search extension，`launch.json` 保存模块与设置的 hash。

三个实际 provider 输入依次证明：初始 schema 无 `notion_ctl`；真实 search 回执和完整 `cli_source` schema 已进入模型；真实 scope 回执逐字进入下一输入。`source-command.json`、`rpc.json` 和 `provider-requests/` 的已安装 serializer HTTP 原件须一致；只有 `details.loaded`、只有工具名、预先暴露 schema、缺失 search 调用或错 source/database/command 均失败。两次工具调用不包含 bash/正文操作，所有 SDK/HTTP 及 shutdown 账本仍按原严格规则闭合。场景总数仍是 14，CI 原 all 会执行此路径。

live-fixture 可用 `--resume-evidence /absolute/FAILED_EVIDENCE` 恢复：旧 scratch ownership/input unique name、catalog exactname 唯一与 read canary 通过后不 create，最终 archive；可加 `--model provider/model --model-prompt TEXT` 对同页模型消费后 archive。创建 deadline 15 分钟，intent 的 create-started/unknown 不等于成功。这些远端选项不改变 installed 的包验收边界。
AH-255 可以在同一次真实 fixture run 指定两份已安装产物：

```bash
node scripts/verify-notion-integration.mjs doctor --mode live-fixture --database "$FIXTURE_DATABASE" --command-json "$INSTALLED_CLI_ARGV" --extension "$INSTALLED_BROKER_ENTRY"
node scripts/verify-notion-integration.mjs run --mode live-fixture --database "$FIXTURE_DATABASE" --command-json "$INSTALLED_CLI_ARGV" --extension "$INSTALLED_BROKER_ENTRY"
```

`FIXTURE_DATABASE` 必须来自当前独立 fixture receipt；`INSTALLED_CLI_ARGV` 为真实 npm 安装 bin 的 JSON argv（例如 Node 绝对路径与安装后 JS entry），`INSTALLED_BROKER_ENTRY` 来自安装包的 pi/omp extension metadata。Node 参数须为真实 Node executable，不使用 Bun 或宿主二进制；共享 `--skill-ref` 仍原样使用 CLI 返回的 `record.ref`。Doctor hash 实际入口，run 全部 mutable CLI/XDG 根在 scratch；现有 integration 没有 `--profile`，不继承机器 Profile 绑定，具体边界见[默认目录地图](default-context-prefetch.md)。该路径把安装 CLI→官方 Notion→pinned export→安装 broker 的 Pi/OMP native read/`$`/resource 连接在同一组 identities 上；仍以实际 branch assertion/产物hash为准。模型与实际输入 UI 单独验收，不能由 provider 捕获替代。

包内 CLI/SDK 与依赖隔离另运行 `node scripts/verify-artifacts.mjs --host pi`：在独立 prefix 安装 Broker，核对实际 CLI/SDK 字节与 runtime manifest，实际启动随包 CLI 和 query，并用安装后的 Pi extension 重跑缺 command、API 不可达、目录协议不兼容/格式错误、未认证、选择阻断与 refresh 恢复。`--host omp` 才另覆盖 OMP 与 Tern 归档；缺省仍为 OMP。该入口不替代下表 installed mode 的完整 snapshot/会话验收，也不证明真实 Notion 认证。

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

Use `bun scripts/pack.mjs --target broker --out-dir ABSOLUTE_OUTPUT` to build the npm artifact without touching Tern outputs or installing its runtime. `NTN_SKILLS_BUILD_ENTRY` must select the real CLI entry inside one complete frozen ntn-skills package. The builder resolves that same package's `./sdk` export, checks compatible dependency versions and refuses a missing or mismatched SDK; there is no independent SDK override. Preserve both input hashes and the generated `dist/ntn-skills-runtime.json` with its CLI/SDK bundle hashes. A package version or CLI hash alone cannot identify this pair.

Run `verify-artifacts.mjs --host pi` against the frozen archive directory, or `control.mjs doctor/run distribution-pi`, to install and verify the Pi artifact. Run `verify-notion-integration.mjs doctor/run --mode installed --host pi --package ABSOLUTE_TGZ` for its selected public integration scenarios. The existing positional mode remains compatible; use the explicit `--mode` form in new recipes. `selectedHosts` and owned-process receipts must contain only Pi; OMP/Tern remain unrun.

Default SDK acceptance uses the same installed package with `node scripts/notion-sdk-pi.mjs doctor --package ABSOLUTE_INSTALLED_BROKER --fixture ABSOLUTE_FIXTURE_JSON`, then `run` with those arguments plus `--scenario all --out NEW_ABSOLUTE_EVIDENCE`. Its source.command must be absent. This is an actual Pi, controlled-provider, offline-source route; follow the [consumption map](skill-consumption.md) for default View, tool delivery, resource and session assertions. Source fixtures do not prove real Notion or real-model acceptance.

### 已安装 SDK 的真实 HTTP 消费接线

SC06／SC08／SC20／SC26 继续使用同一个 `scripts/notion-sdk-pi.mjs`，另显式选择 `http-directory`、`http-cache-recovery` 或 `http-interruption`。原 `all` 仍为 14 景，名字与 ambiguity 场景也保持独立。输入来自原 CLI `scripts/sdk-fixture.ts --outdir ABSOLUTE_OWNED_DIRECTORY --catalog`，使用其中的空 scalar source seed；该 seed 不含 snapshot、共享 current record 或 object。CLI 的 `scripts/sdk-source-fixture.mjs` 是原 installed smoke 共用的验证 HTTP service，不属于安装包运行时。

```bash
node scripts/notion-sdk-pi.mjs doctor --package ABSOLUTE_INSTALLED_BROKER --fixture ABSOLUTE_FIXTURE_JSON --source-http-helper ABSOLUTE_FROZEN_HELPER --scenario http-directory
node scripts/notion-sdk-pi.mjs run --package ABSOLUTE_INSTALLED_BROKER --fixture ABSOLUTE_FIXTURE_JSON --source-http-helper ABSOLUTE_FROZEN_HELPER --scenario http-directory --out NEW_ABSOLUTE_EVIDENCE
node scripts/notion-sdk-pi.mjs evidence --evidence ABSOLUTE_EVIDENCE
node scripts/notion-sdk-pi.mjs cleanup --evidence ABSOLUTE_EVIDENCE
node scripts/notion-sdk-pi.mjs evidence --evidence ABSOLUTE_EVIDENCE
```

另外两景仅替换 `--scenario` 与新的 `--out`。Doctor 只读取 helper 身份，不 import 或启动服务；run 先按 SHA／bytes 保留 helper，再从证据副本启动只绑定 `127.0.0.1` 的原 HTTP fixture。实际 Pi 使用独立安装的 Broker／内置 SDK、无 `source.command`、关闭 prefetch、独立 HOME／XDG／state／cache／session 与 scheduler；consumer 不继承 oracle snapshot。Controlled provider 的真实 Pi 输入逐份通过所安装 pi-ai serializer 发往 localhost。每阶段分别记录 SDK terminal、实际 source attempts／字节、provider 输入、tool result 与宿主退出；缺失、未闭合或错误路径不记为零。

同次 full catalog／Default View 的复用继续在 `http-directory` 验证：安装包的 SDK 与 runtime manifest 同时声明 `catalog_directory_contract_version: 1`，一次 `list` 原始 envelope 包含两个独立 outcome。原 observer 只记一次 SDK 调用和一次 request metrics；纯读取断言展开两个结果，不伪造第二个事件。按完整 Skills row IDs、实际六字段 projection、分页 cursor／has_more 和响应 bytes 核对库存只读一遍，不能以 SDK 调用数下降代替 HTTP 复用。旧 SDK 的两次读取仍可通过普通兼容场景，但不能通过这条复用断言。401、取消、空／失败 View 与 full-library 无关错误独立保留。

普通 provider 可以先于首个后台 SDK list 完成。`http-directory` 必须先观察本次 host／source／database 的初始 list start 及 terminal；尚无 start 不能作为已结束证据。等待 View 发布期间的后台 HTTP 单列，发布后排空已观察的操作，再取基线并仅执行一次无参状态查询，要求目标状态准确、HTTP 与 provider 均零增量。保留两次普通提交、原预算和全部迟到／失败账本，不用固定等待猜测来源静默。

Pi 会将正文 custom message 转为实际 provider 的 user content，并把机器交付回执留在 session。`dollar` 的省略证明沿原 native observer 保留转换前的注入回执与当前有效分支的机器回执，按同一 Pi 进程及请求时序关联。首轮以原注入文本的 bytes／hash 定位实际 user 块，历史轮次以原 `nativePromptSha256` 定位合并后的 user 内容；不能拿后续合并回执证明首轮。两者都逐项校验完整 delivery span、正文 bytes／hash、scope／owner／snapshot／version 和冻结 canonical card。回执作为独立验证 sidecar，不插回 provider 或 HTTP 原件。原 `native`／`prepare` 等目录证明按 locator 的结构和值比较，不要求 JSON 对象键序相同；真正的 locator、版本或正文变化仍失败。

Broker 只向同一 menu／refresh generation 交付这次目录观察一次，消费前摘下；取消、session switch／branch／tree、选择变化不能复用旧观察。后续 View 刷新继续走原权限和 freshness 路径，raw inventory 留在 SDK operation 内，不写入 Broker 持久缓存。CLI 的 maxAge 0 不跨时间复用库存，refresh／离线／暖／局部缓存结果各用原回执解释。

| 用户入口 | 实际驱动与正反例 | 验收边界 |
| --- | --- | --- |
| 普通会话的默认目录 | `http-directory` 在实际 View HTTP response 被 hold 时先完成普通 provider 请求；放行后通过既有只读 `/context-broker view` 观察发布状态，再提交普通续问。独立空根实测 401。 | 首次 pending 不阻塞；ready 后名称、描述、View 与短引用准确；401 无伪 ready／部分目录；所有输入均无正文，0 object read。公开状态命令必须新增 HTTP／provider 都为 0，次数、耗时、全部通知保留。该屏障只用于受控第二轮，不加入真实 C/D 任务。 |
| `read`、`notion_use` 与真实 session 恢复 | `http-cache-recovery` 在同一 owned SDK cache 中依次启动真实 Pi：cold、新进程 warm、非零 TTL 实际到期、显式零 age 强制重验、权限失败／恢复及原 session-file resume。 | 按[会话地图](session-cache-recovery.md#实际-http-缓存权限与中断)逐项绑定 scope／snapshot／version／File。warm 的一次在线身份校验单列，不能要求或宣称全零 HTTP；到期与强制重验分开。 |
| 读取中的重试和取消 | `http-interruption` 为三个独立 cold 根分别注入一次 429、一次 partial stream disconnect、一次 headers 后的真实 RPC abort。 | 前两者只由原 SDK retry 恢复，失败 attempt 保留；取消不重试、不激活，迟到响应与下一次普通输入均不能交付正文。controller retry 为 0。 |

CI 在原独立安装产物之后运行 Pi 1.5 的三景；Pi 1.4 兼容 step 在同一产物上另跑 `http-directory`。`check-gates` 继续检查原 check／all14／names／ambiguity，并拒绝删景、错 helper、改用 checkout、条件跳过、吞错或丢失 HTTP evidence。CI 与 publish 的 CLI checkout pin 仍一致，publish 保持单 job。上述路由不证明真实 Notion、真实模型、Requires 闭包、默认五分钟真实时钟边界或日用安装；对应既有门禁仍单列。

| 实际 n=1 运行 | Pi 进程 | 来源 HTTP attempts | 完整服务响应 B | 不完整响应已写 B | provider 请求／安装 serializer 请求 B |
| --- | ---: | ---: | ---: | ---: | ---: |
| `directory-v3/pi15`，Pi 1.5 | 2 | 15 | 183538 | 0 | 4／30220 |
| `directory-v3/pi14`，Pi 1.4 | 2 | 15 | 183538 | 0 | 4／31288 |
| `remaining-v7/http-cache-recovery`，Pi 1.5 | 5 | 72 | 6171157 | 0 | 25／286266 |
| `remaining-v7/http-interruption`，Pi 1.5 | 3 | 69 | 3553412 | 64 | 6／48353 |

### Name and fixed URI resolution

CLI, SDK composition and Pi accept explicit `skill://<name-or-alias>/<path>` references. Current names resolve through the shared Core `resolveCatalogReference` against the complete ordinary enabled catalog, then enter the unchanged exact `consume`/read contract with its canonical target. SDK `consume` itself remains an exact machine API; do not rewrite `preparation.roots[*].target` after decoding or relax its expected-target check. Copy canonical refs or session handles from results for subsequent actions.

The Default View and host metadata projection cannot prove a name unique. Reject incomplete, failed, queried, View/profile or unclosed paginated catalogs, including partial catalogs with zero or one match. For a custom command, close all pages under the original scope, database, coverage and cursor checks before removing only the transport pagination fields for the pure resolver. Keep disabled entries outside the existing consumable-name set, while retaining stable-ID conflict and exact disabled checks. Across configured sources, preserve source and scope identities: equal logical IDs in two authorities are still ambiguous, and a failed authority cannot be hidden by another match. An explicit `notion_use` refresh also refreshes current name discovery.

An ambiguous name must return actionable discovery choices through both the actual registered native `read` and `notion_use` error boundary. The error message is JSON with `code: "SKILL_AMBIGUOUS"`, guidance, and `candidates` containing only `name`, configured `source`, `ref`, and `selectable`. Validate Core's narrow candidate/selector error against the already obtained complete catalog; do not request a second catalog or expose arbitrary error details, bodies, credentials or local materialization paths. A failed authority still blocks the result even when another source has several matching names.

In a Pi session, unfixed main-entry choices use the existing branch-bound `sr:C` handles. Copy one selectable handle into the same read/use operation and verify the selected owner and scope again through the normal source boundary. Equal logical IDs in different scopes must stay independently selectable. An error is not a loaded-body receipt or activation. Resources retain their requested path; fixed choices retain the historical canonical owner and snapshot. Manifest-only lookup does not justify minting `sr:S` or `sr:R`. If identical fixed canonical refs still name different scopes, show their sources and `selectable: false`; do not advertise a current ref as recovery or claim this case supports one-step selection. Cancellation or branch/session change before the error arrives must prevent candidate publication.

Fixed names and aliases are matched against the retained snapshot by Core `listSkill` (`files` for an explicitly configured command). Its manifest determines the historical owner and canonical fixed file ref; never rebind that owner through a current name. This metadata admission does not prepare the main body. A fixed snapshot absent from one source may be sought in another, but a complete miss preserves `SNAPSHOT_MISSING`; permission, corruption and incomplete-source failures remain failures. Check a configured UUID database directly. Only a custom command configured with a database alias needs additional ordinary metadata to prove the alias's database and the same scope; an offline fixed operation keeps this metadata lookup offline. This extra lookup is recorded as metadata cost, not body preparation.

Use the existing CLI fixture producer in its repository:

```bash
node scripts/sdk-fixture.ts --outdir /new/absolute/name-fixture --catalog --distinct-names
```

Its opt-in distinct display names and aliases leave the original fixture unchanged. In the Broker repository, run the existing driver with the same independently installed package and `--fixture /new/absolute/name-fixture/fixture.json`, selecting `--scenario name-references` and `--scenario name-reference-failed-source` separately; each `run` requires its own new `--out` directory. These two named scenarios supplement the original 14-scenario `all` gate; the old all result cannot certify name resolution. The installed driver and CI must bind the actual new SDK exports and complete package identity before these paths count as passed.

The `name-references` scenario also appends `/SKILL.md` to an actual issued `sr:R` copied from the preceding native main directory. This declared negative must reach the installed public `read` validator unchanged and return `SHORT_REF_INVALID`; a generic harness denial, successful read or another error cannot satisfy it. The original error must remain in the native session, the following provider input and the installed serializer request, with no body/delivery receipt. Its actual provider-bounded interval must have zero new SDK starts and source object reads. Prior metadata discovery remains in the full run ledger; this does not claim zero cold setup work. The existing valid reference, Requires, View-excluded and wrong-fixed-name checks remain. This adds one declared negative to this controlled scenario (now 9 tool calls / 10 provider requests), so its whole-run cost is not directly comparable to the previous 8-call version.

For actionable ambiguity, use the same producer with `--catalog --ambiguous-names` in a separate owned fixture directory; do not combine it with `--distinct-names` or replace the original all14 input. Run the same `notion-sdk-pi.mjs doctor|run` entry with `--scenario name-reference-ambiguity` and that fixture. Its controlled provider must first observe an ambiguous native read error, copy a selectable candidate verbatim to inspect the intended owner, then observe an ambiguous use error and copy the intended root candidate for complete root/Requires delivery. Match expectations by stable record ID, because the fixture intentionally repeats names and aliases. Retain exact source/ref fields, both actual tool errors and next provider inputs, before/after package identities, and cleanup evidence. This independent scenario does not change the original all14 or the two existing name scenarios; their pass alone is not ambiguity acceptance.

The persisted `sr:C` binding contains an owner URI such as `skill://<encoded-shared-skill-id>`, with no path, snapshot or File ID. The independent fixture record separately contains the main-entry URI and declared `entrypoint`. Check both exact canonical forms against the same frozen owner ID; retain exact scope, kind and locator checks. Do not compare the two URI strings directly, strip a suffix, or accept an owner by prefix. A different owner, a main/resource path disguised as an identity, a pin/query/fragment on a current candidate, or a mismatched independent entrypoint must fail. The selected tool call must still copy the actual provider-visible error ref, and its subsequent full read/use receipts must independently prove the owner, pin, bytes and Requires boundary.

The original `c8db08c` installed artifact result remains failed under `sc04-c8-artifacts-vhrrfnsn/`: its four actual calls reached both copied candidates, then the old oracle incorrectly equated the owner URI with `/SKILL.md`. Preserve that native JSONL and the matching CI failure. The owner-URI correction is a harness change; validate it with the existing regression test and a new ambiguity-only run on the same unchanged installed package. It neither upgrades the earlier report nor requires rebuilding the product or repeating an already completed local all14/two-name run.

The original artifact runner can perform all14, both existing name scenarios and the separate ambiguity scenario against one installed package:

```bash
CONTEXT_BROKER_CANDIDATE_DIR=/absolute/frozen/archives node scripts/verify-artifacts.mjs --host pi --fixture /absolute/original-fixture/fixture.json --require-sdk --name-fixture /new/absolute/name-fixture/fixture.json --ambiguity-fixture /new/absolute/ambiguity-fixture/fixture.json
```

`--name-fixture` and `--ambiguity-fixture` each require both `--host pi` and the original `--fixture`. The runner executes the unchanged all14 first, then reports the two name scenarios and the ambiguity scenario separately. An omitted optional fixture leaves its own acceptance not_run. CI and publish validation must supply all three fixtures; the Pi 1.4 compatibility gate must also run all three named scenarios on the same installed package. Keep each separate status and owned raw evidence even when another gate fails.

The positive path reads a current display-name URI, uses its distinct alias, selects a name outside the Default View, then reads a historical fixed-name resource. Compare its actual source receipts and next provider input with canonical and returned `sr:` reads. Root/Requires and selected resources must be complete; wrong historical names, source/scope mismatches and late results after cancellation must not deliver. The failed-source path keeps the independent source failure while refusing ambiguous name selection; canonical and short references retain their existing exact path. Current canonical/short references add no name lookup; fixed scalar and batch resources do not prepare or activate the main body.

Every SDK start and end carries the same call ID, configured `source_id` and `database`; absent identities remain `null`. The terminal `error_code` records only the real bounded machine code from a thrown error or a returned failed result. Unknown codes stay `null`. These passive fields never include credentials, request targets, error messages/details or source bodies, and the internal source ID is removed before calling the SDK. For an expected unavailable-source failure, verify that exact identity, error code, complete metrics and native provider interval before accepting its call ID. Do not derive the expected set from all failed list calls: an extra healthy-source failure must still fail the gate. The original `9b88d444` installed-name results retain their functional observations, but their earlier observer lacks per-call source/error attribution and cannot certify this stricter boundary. The two original SDK attribution red cases and the narrow after log are retained under `sc25-broker-name-28bt1mpr/sdk-attribution-valhv4zh/` in the private verification evidence root.

Object reads are content-addressed. If a selected file and an unselected file share identical bytes, report the shared hash and exact length instead of asserting zero physical reads for one alias. The actual tool call must still prove the selected owner, snapshot, File ID and resource path independently; extra source hashes remain failures. A binary resource decoded as text is not complete byte delivery unless its output byte length and hash also match the source.

The original local regression entry points are `native-read-session.test.ts`, `shared-notion-adapter.test.ts`, `notion-sdk.test.ts` and `resource-read-host.test.ts` under `packages/context-broker/scripts`. They cover the real registered use/read boundary, pure-versus-runtime SDK observation, database/source admission and resource delivery. Retain fail-before and after logs, then run the actual installed Pi scenarios; local fixtures alone do not prove the installed route.

### Catalog projection after explicit preflight

The existing `dollar` and `default-view` scenarios retain their two-prompt paths and use a fresh Broker cache and Pi session over cloned warm source metadata/snapshots. An observer holds the actual owned SDK configuration read callback and releases it at a real public boundary; it does not replace the SDK result, abort the operation, or simulate cold Notion latency. The original callback is always released during shutdown if the scenario fails.

For `dollar`, the first prompt selects the Skill directly. Release occurs at `context`, after `before_agent_start`; the real Default View SDK result must precede the first provider request. That first request and every continuation must contain the complete ready default directory, exactly one complete selected root and Requires, and no pending directory or unselected body. For `default-view`, release occurs only after the first provider's `payload_start`, proving ordinary startup remains nonblocking. The first request must be pending and the following ordinary turn must deliver the ready directory without any Skill body. An intermediate tool continuation may still be pending while Broker metadata publication completes.

The verifier reconstructs current system text from public system content and named section patches, then checks every request again after the installed serializer sends the actual bytes to the local HTTP endpoint. A real, unselected native local Skill must keep its name, description and exact entry path; its body remains absent. A separate instruction supplied through official `systemPromptOptions.sections`, native `read`, and all existing tool definitions must survive unchanged. Test observers must not return an appended `systemPrompt` from `before_agent_start`: Pi treats that public result as an exact forced replacement after later context hooks.

Use the same installed package and fixture arguments above with `--scenario dollar` and `--scenario default-view`, each in a new evidence directory, under both supported Pi versions. Inspect `launch.json`, `observer.jsonl`, `native-session-events.jsonl`, the provider hooks, `catalog-projection.json`, and `provider-requests/`; a source result or `before_agent_start` observation alone is not provider delivery. These two paths remain part of the original 14-scenario `all` gate.

### Explicit catalog sizes: 10 / 100 / 101 / 300

The original CLI producer accepts `node scripts/sdk-fixture.ts --outdir NEW --catalog --catalog-size N`, where `N` is exactly 10, 100, 101 or 300. Each isolated fixture contains N ordinary catalog records, N Default View records and N valid snapshots, each with an independent main file and resource. Names and descriptions include Unicode, quotes, literal entities and author-supplied trailing newlines. The size marker is accepted only by an explicit `default-view` scenario; `all`, other scenarios, live input, warm-directory comparison and relaxed baseline options reject it. The ordinary fixture and the original 14 scenarios remain unchanged.

Use the existing `notion-sdk-pi.mjs doctor|run --package ABSOLUTE_INSTALLED_BROKER --fixture ABSOLUTE_SIZE_FIXTURE --scenario default-view`, with a new `--out` directory for each run. Keep the same independently installed candidate and selected compatible Pi version, default SDK transport (`source.command` absent), `prefetch: false`, and cloned warm offline source state. Each size runs once with the original 180 s outer / 60 s RPC budgets and no retry or fallback. The first ordinary request remains pending, and the unchanged ordinary continuation must contain the complete ready N-card directory. Intermediate requests retain the original pending allowance; every ready request must preserve all N identities and exact metadata.

The controlled provider requests `notion_list` with `limit: 100` and copies each real `next_cursor` verbatim into its next call. The four sizes require respectively 1 / 1 / 2 / 3 public list pages and 3 / 3 / 4 / 5 provider inputs, including the ordinary continuation. The verifier checks each page's complete host receipt, exact source/scope/owner metadata, total/count/terminal cursor and union, then checks its model projection in every subsequent actual provider request and installed-serializer HTTP body. It independently binds each current `sr:C` to the native session's canonical unpinned owner; a count alone, fabricated cursor, duplicate/missing owner, incomplete source or foreign binding cannot pass. This exercises public Broker pagination over the offline SDK catalog; it does not certify live Notion API pagination.

The existing system-section/native Skill canary, tool schema and guidance checks remain. Every seeded main and resource hash is forbidden to the existing consumer object observer: only a complete start/end ledger with zero reads, zero pending work and zero errors proves no selected or unselected source body was read. Setup verification of fixture bytes is recorded separately and cannot supply that consumer proof. No active source or selected graph may be created. Inspect `catalog-scale.json`, `catalog-projection.json`, the original provider and RPC captures, native session entries, SDK/object ledgers and installed-serializer HTTP files; retain the normal Evidence → system Trash → Evidence sequence.

| Catalog size | Actual public page counts | Provider / serializer requests | Actual serialized HTTP bytes |
| ---: | --- | ---: | ---: |
| 10 | 10 | 3 / 3 | 37,595 |
| 100 | 100 | 3 / 3 | 123,279 |
| 101 | 100 + 1 | 4 / 4 | 182,991 |
| 300 | 100 + 100 + 100 | 5 / 5 | 561,413 |

Every run began pending and all later requests were ready with the exact N-card owner/name/description/current-ref set. Actual cursor values, page unions, native session bindings, system/native canary, unchanged tools and installed HTTP projections passed the original assertions. Together the runs made 8 SDK list calls, 0 SDK body calls, 0 source HTTP attempts, 0 CLI child calls and 0 observed object reads; all 1,022 seeded main/resource files remained unselected. The 15 HTTP requests total 905,278 B. Host transcript capture is a separate 1,461,743 B quantity, including 547,536 B of host details; do not add it to HTTP bytes or infer a cost reduction from this scale gate.

The ordinary `verify-notion-integration.mjs doctor/run --mode live --host pi` route accepts a real installed extension and explicit `--command-json` for the bundled CLI. That verifies the declared custom-command compatibility path, not default SDK transport. Its separate authorized `--mode model --host pi` run verifies actual model entry/resource use under the same explicit source choice. Preserve those identities and transport labels. Formal dependency requirements and the default multi-host route are unchanged.

### Explicit live SDK route

The same driver accepts `doctor|run --package ABSOLUTE_INSTALLED_BROKER --live-input ABSOLUTE_INPUT_JSON`; `run` also requires a new `--out` directory. This is separate from `--fixture` and `--scenario all`: the original 14 offline scenarios remain the default CI route.

The version 1 input has `kind: "live_notion_sdk"`, `host` and `artifact` identities (`path`, `sha256`), one `source` (`id`, `database`), and private `oracle.catalog`, `oracle.use`, and `oracle.resource` identities. Resource also declares `logical_path`. `sentinels` lists the unchanged daily configuration/shim identities. Use same-machine observer-only originals: the full catalog, plus either a complete public `use --json` receipt or a recorded complete SDK consume `wrapper.value` normalized to the public CLI envelope by the pinned CLI's exact `emit({ok:true,...value})` rule. Resource bytes must match the returned fixed manifest.

For a normalized SDK original, retain provenance binding the raw SDK receipt, the pinned conversion rule/source identity, and the normalized expected payload by hash. Independently verify every node, manifest and body identity before freezing it as private expected input. Record this as reuse of an existing SDK observation, with zero new CLI/source requests and no consumer prewarming; keep its original execution outcome, including a failed task, unchanged. The normalized payload itself does not prove a new CLI execution. Doctor verifies the actual supported Pi 1.4.0 or 1.5.0 identity, every archive member against the installed package, the bundled CLI/SDK runtime hashes, and each frozen original. It does not probe authentication or independently certify the normalization provenance.

Run inherits only the local Notion token into an otherwise isolated consumer. CLI state, Broker cache, agent directory and sessions start empty; oracle bodies never seed them. Owned settings auto-load the installed Broker, and actual `get_commands.sourceInfo` must name its installed entry. The target is not passed with `-e`; the controlled provider and passive observer are explicit verification extensions. `source.command` is absent and `prefetch` is false.

The sequence is ordinary greeting → ordinary continuation with the complete ready Default View → exact `notion_list` selection → `notion_use` root and Requires → native `read` using the returned resource handle → ordinary continuation. SDK catalog completion precedes Broker metadata-index publication: the verifier observes the existing no-argument `/context-broker view` status command before that continuation, retaining its local RPC notifications separately. It neither refreshes nor changes a View. A pending first directory or a status notification cannot pass as actual provider delivery. Every selected body and resource must appear completely in the next actual provider request with fixed scope/pin proof. The resource's returned short handle is checked against its canonical fixed identity; its scalar SDK interval must read only those bytes, make zero HTTP attempts and perform no further preparation. Preserve every provider capture and its installed-serializer HTTP replay separately from real-model usage.

Full SDK traces account for actual HTTP attempts, response bytes and source writes; unknowns are not zero. Provider absence is not source exclusion: retained chunk ownership and every unselected Member need the existing independent `notion-skill-source-proof` attribution. Until that separate proof exists, the live result explicitly reports partial acceptance. No additional verification platform, source mutation, new pin, copied authentication or daily configuration change is part of this route. Keep failed attempts, then run the existing `evidence`, `cleanup`, and `evidence` commands against sealed owned output.
