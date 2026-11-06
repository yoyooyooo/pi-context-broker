# 独立安装包消费

前置条件：提供实际存在的 `/absolute/package.tgz`，npm 与所选宿主工具可用；本批主宿主 Pi 1.5.0，兼容 Pi 1.4.0 分别留安装态证据，并显式传 `--host pi`，省略时仍是双宿主。允许生产依赖安装所需网络。包必须是本次待验收产物；不以 checkout 替代。Doctor 只检查工具存在与版本，不安装、不认证。

安装消费与真实远端 fixture 是不同 mode。后者使用 `node scripts/verify-notion-integration.mjs doctor --mode live-fixture --database UUID` 与 `node scripts/verify-notion-integration.mjs run --mode live-fixture --database UUID`，唯一页及 `references/guide.md` 创建后消费，finally 仅 archive 自建页与 child pages 并 GET 确认；审阅 `live-fixture-create.json`、`live-fixture-cleanup.json`。只读 live 不替代它；live-fixture 通过也不证明 tgz 安装消费。

installed 与 deterministic 默认执行双宿主 filesystem source metadata/read/native RPC+print/`$`/resource、Notion native cold print、歧义 `$ui-alpha@notion` provider 计数 0 后两个 qualified native 独立 page body，以及 OMP runSourceLifecycle 的真实 fork/branch/compact-remove+refresh。`--host pi` 只驱动 Pi，不能据此宣称 OMP lifecycle 已运行。分别审阅 `pi-fs-`/`omp-fs-` 系列、`*-cold-print-provider.jsonl`、`*-duplicates-rpc.json` 和 lifecycle helper 实际返回文件，不能用 checkout 路径替代安装产物。

### SC23 随包调用指导

冻结候选时同时核对安装包的 `docs/reference.md`、`docs/reference.zh-CN.md`、随包 CLI help/schema 与实际 Pi 工具；不能只改 README 示例。当前 Pi 日常入口为 `notion_list`、原生 `read`、`notion_use`，CLI 为 list/read/use，辅助 files/export 与管理 ctl 按需进入。`notion_ctl` 是 deferred 管理/证明工具，默认 schema 不应混入旧 `skill_search/skill_prepare/skill_graph`；OMP 兼容说明及历史回执保留原协议和版本。

| 用户动作 | 原有实际驱动与断言 | 证据边界 |
| --- | --- | --- |
| 发现、检查、使用、固定资源 | `notion-sdk-pi.mjs` 的 default-view/prepare/resource 场景；核对实际 provider schema、完整正文和 SDK/HTTP 账本 | 文字或函数导出存在不能代替安装态消费 |
| 按需管理发现与 CLI scope | 原 `scoped-command` 场景由实际 `tool_search` 发现 deferred `notion_ctl`，下一 provider 收到 schema 后才调用 `notion_ctl({cli_source})`；再核对真实配置命令与 scope，正文/写入零 | 只证明发现与元数据交付，不执行作者操作；禁用 discovery 时须另行明确启用工具 |
| 作者与 unknown 恢复 | CLI 原独立 package smoke 的作者生命周期、原 operation 恢复及零重放断言 | 受控 Notion 服务与真实 Notion 分别记账 |

2026-11-05 的改前审计保留在 `~/Library/Logs/pi-context-broker/AH-617-20261105/sc23-package-guidance-pr5ux3na/fail-before.json`，SHA256 `0f0e3ffdf607340a848c276dc071326b0ac6005cfca19ec7a61b2ceff4c496c9`：两份 active reference 有16处旧默认工具指导，与当时产品注册和 SDK 目录实现不一致。修订文档不改变作者源正文，也不覆盖历史测量文档。新包须记录这些文件自身的 bytes/hash；已有85888安装结果不自动成为修订包的验收。

按需发现沿用 `node scripts/notion-sdk-pi.mjs run --package ABSOLUTE_INSTALLED_BROKER --fixture ABSOLUTE_FIXTURE_JSON --scenario scoped-command --out NEW_ABSOLUTE_EVIDENCE`。在 owned settings 中用公开 `defaultTools` 配置 `read`、`notion_list`、`notion_use`、`bash`、`tool_search`；不以 `--tools` 硬过滤掉尚未加载的非 MCP 管理工具，也不由 harness 调用 `setActiveTools` 提前启用 `notion_ctl`。隔离的 `--no-extensions` 进程显式加载该宿主实际安装的官方 tool-search extension，`launch.json` 保存模块与设置的 hash。

三个实际 provider 输入依次证明：初始 schema 无 `notion_ctl`；真实 search 回执和完整 `cli_source` schema 已进入模型；真实 scope 回执逐字进入下一输入。`source-command.json`、`rpc.json` 和 `provider-requests/` 的已安装 serializer HTTP 原件须一致；只有 `details.loaded`、只有工具名、预先暴露 schema、缺失 search 调用或错 source/database/command 均失败。两次工具调用不包含 bash/正文操作，所有 SDK/HTTP 及 shutdown 账本仍按原严格规则闭合。场景总数仍是 14，CI 原 all 会执行此路径。

2026-11-05 同 `6464469dff1b` 独立安装包在 Pro Pi 1.5.0 和 owned Pi 1.4.0 均通过该实际路径：每版 3 个 provider 输入、2 次工具调用、0 source HTTP／0 CLI 子进程／0正文读取，全部通过已安装 serializer 发至本地 HTTP。Pi 1.5 累计 33382 B，Pi 1.4 累计 34241 B；这是受控路径原账本，不是模型成本收益比较。证据在 `~/Library/Logs/pi-context-broker/AH-617-20261105/sc23-deferred-uq24ykc8/`，63 项原 driver 测试覆盖正例及拒绝条件，两 run 已完成原 Evidence → Cleanup → Evidence，58 个原件 hash 不变。`baseline.json` 指向先前已通过的显式激活版本，该历史结果仍有效，但不证明按需发现；`gate-before.log` 保留新断言对旧直接激活 oracle 的缺口反馈。未运行真实模型／作者写入，未修改包、日用设置或原失败报告。

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

### Name and fixed URI resolution

CLI, SDK composition and Pi accept explicit `skill://<name-or-alias>/<path>` references. Current names resolve through the shared Core `resolveCatalogReference` against the complete ordinary enabled catalog, then enter the unchanged exact `consume`/read contract with its canonical target. SDK `consume` itself remains an exact machine API; do not rewrite `preparation.roots[*].target` after decoding or relax its expected-target check. Copy canonical refs or session handles from results for subsequent actions.

The Default View and host metadata projection cannot prove a name unique. Reject incomplete, failed, queried, View/profile or unclosed paginated catalogs, including partial catalogs with zero or one match. For a custom command, close all pages under the original scope, database, coverage and cursor checks before removing only the transport pagination fields for the pure resolver. Keep disabled entries outside the existing consumable-name set, while retaining stable-ID conflict and exact disabled checks. Across configured sources, preserve source and scope identities: equal logical IDs in two authorities are still ambiguous, and a failed authority cannot be hidden by another match. An explicit `notion_use` refresh also refreshes current name discovery.

An ambiguous name must return actionable discovery choices through both the actual registered native `read` and `notion_use` error boundary. The error message is JSON with `code: "SKILL_AMBIGUOUS"`, guidance, and `candidates` containing only `name`, configured `source`, `ref`, and `selectable`. Validate Core's narrow candidate/selector error against the already obtained complete catalog; do not request a second catalog or expose arbitrary error details, bodies, credentials or local materialization paths. A failed authority still blocks the result even when another source has several matching names.

In a Pi session, unfixed main-entry choices use the existing branch-bound `sr:C` handles. Copy one selectable handle into the same read/use operation and verify the selected owner and scope again through the normal source boundary. Equal logical IDs in different scopes must stay independently selectable. An error is not a loaded-body receipt or activation. Resources retain their requested path; fixed choices retain the historical canonical owner and snapshot. Manifest-only lookup does not justify minting `sr:S` or `sr:R`. If identical fixed canonical refs still name different scopes, show their sources and `selectable: false`; do not advertise a current ref as recovery or claim this case supports one-step selection. Cancellation or branch/session change before the error arrives must prevent candidate publication.

Drive the existing `shared-notion-adapter.test.ts` and `native-read-session.test.ts` entries for these boundaries, including copying returned candidates into the real registered executor, a denied authority, fixed pins, resource paths, and late failures. The original four registered read/use red cases are preserved at `~/Library/Logs/pi-context-broker/AH-617-20261105/sc04-ambiguity-jt5v40p8/red.log`: they reached `SKILL_AMBIGUOUS` but returned no candidates. Their isolated source export binds the exact baseline plus the tested overlays and the frozen C7-containing Broker dist; the active checkout's old dist is not a substitute. These local regressions do not certify actual installed Pi/provider delivery. Run that separate existing driver route against the final independently installed candidate, keep the failed originals, and perform the same owned Evidence → Cleanup → Evidence procedure.

Fixed names and aliases are matched against the retained snapshot by Core `listSkill` (`files` for an explicitly configured command). Its manifest determines the historical owner and canonical fixed file ref; never rebind that owner through a current name. This metadata admission does not prepare the main body. A fixed snapshot absent from one source may be sought in another, but a complete miss preserves `SNAPSHOT_MISSING`; permission, corruption and incomplete-source failures remain failures. Check a configured UUID database directly. Only a custom command configured with a database alias needs additional ordinary metadata to prove the alias's database and the same scope; an offline fixed operation keeps this metadata lookup offline. This extra lookup is recorded as metadata cost, not body preparation.

Use the existing CLI fixture producer in its repository:

```bash
node scripts/sdk-fixture.ts --outdir /new/absolute/name-fixture --catalog --distinct-names
```

Its opt-in distinct display names and aliases leave the original fixture unchanged. In the Broker repository, run the existing driver with the same independently installed package and `--fixture /new/absolute/name-fixture/fixture.json`, selecting `--scenario name-references` and `--scenario name-reference-failed-source` separately; each `run` requires its own new `--out` directory. These two named scenarios supplement the original 14-scenario `all` gate; the old all result cannot certify name resolution. The installed driver and CI must bind the actual new SDK exports and complete package identity before these paths count as passed.

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

The original local regression entry points are `native-read-session.test.ts`, `shared-notion-adapter.test.ts`, `notion-sdk.test.ts` and `resource-read-host.test.ts` under `packages/context-broker/scripts`. They cover the real registered use/read boundary, pure-versus-runtime SDK observation, database/source admission and resource delivery. Retain fail-before and after logs, then run the actual installed Pi scenarios; local fixtures alone do not prove the installed route. The 2026-11-05 initial Broker failures remain under `~/Library/Logs/pi-context-broker/AH-617-20261105/sc25-broker-name-28bt1mpr/`, including `host-before.log`, `fixed-boundary-before.log`, `boundaries-02.log` and `use-refresh-before.log`. This recipe does not claim the new installed scenarios have already passed.

### Catalog projection after explicit preflight

The existing `dollar` and `default-view` scenarios retain their two-prompt paths and use a fresh Broker cache and Pi session over cloned warm source metadata/snapshots. An observer holds the actual owned SDK configuration read callback and releases it at a real public boundary; it does not replace the SDK result, abort the operation, or simulate cold Notion latency. The original callback is always released during shutdown if the scenario fails.

For `dollar`, the first prompt selects the Skill directly. Release occurs at `context`, after `before_agent_start`; the real Default View SDK result must precede the first provider request. That first request and every continuation must contain the complete ready default directory, exactly one complete selected root and Requires, and no pending directory or unselected body. For `default-view`, release occurs only after the first provider's `payload_start`, proving ordinary startup remains nonblocking. The first request must be pending and the following ordinary turn must deliver the ready directory without any Skill body. An intermediate tool continuation may still be pending while Broker metadata publication completes.

The verifier reconstructs current system text from public system content and named section patches, then checks every request again after the installed serializer sends the actual bytes to the local HTTP endpoint. A real, unselected native local Skill must keep its name, description and exact entry path; its body remains absent. A separate instruction supplied through official `systemPromptOptions.sections`, native `read`, and all existing tool definitions must survive unchanged. Test observers must not return an appended `systemPrompt` from `before_agent_start`: Pi treats that public result as an exact forced replacement after later context hooks.

Use the same installed package and fixture arguments above with `--scenario dollar` and `--scenario default-view`, each in a new evidence directory, under both supported Pi versions. Inspect `launch.json`, `observer.jsonl`, `native-session-events.jsonl`, the provider hooks, `catalog-projection.json`, and `provider-requests/`; a source result or `before_agent_start` observation alone is not provider delivery. These two paths remain part of the original 14-scenario `all` gate.

The 2026-11-05 fail-before originals are retained under `~/Library/Logs/pi-context-broker/AH-617-20261105/sc06-sdk-catalog-neiksl5c/`: installed candidate `6464469dff1b` fails the explicit first-provider ready assertion on Pi 1.4.0 and 1.5.0 even though the complete Default View SDK result precedes provider dispatch. Its Pi 1.5.0 ordinary counterpart passes the pending-to-ready control, native preservation and three installed-serializer requests. Failed cases use the existing teardown path; closed SDK ledgers do not imply natural process exit. These originals do not certify the later catalog-projection candidate.

### Explicit catalog sizes: 10 / 100 / 101 / 300

The original CLI producer accepts `node scripts/sdk-fixture.ts --outdir NEW --catalog --catalog-size N`, where `N` is exactly 10, 100, 101 or 300. Each isolated fixture contains N ordinary catalog records, N Default View records and N valid snapshots, each with an independent main file and resource. Names and descriptions include Unicode, quotes, literal entities and author-supplied trailing newlines. The size marker is accepted only by an explicit `default-view` scenario; `all`, other scenarios, live input, warm-directory comparison and relaxed baseline options reject it. The ordinary fixture and the original 14 scenarios remain unchanged.

Use the existing `notion-sdk-pi.mjs doctor|run --package ABSOLUTE_INSTALLED_BROKER --fixture ABSOLUTE_SIZE_FIXTURE --scenario default-view`, with a new `--out` directory for each run. Keep the same independently installed C8 package, actual Pi 1.5.0, default SDK transport (`source.command` absent), `prefetch: false`, and cloned warm offline source state. Each size runs once with the original 180 s outer / 60 s RPC budgets and no retry or fallback. The first ordinary request remains pending, and the unchanged ordinary continuation must contain the complete ready N-card directory. Intermediate requests retain the original pending allowance; every ready request must preserve all N identities and exact metadata.

The controlled provider requests `notion_list` with `limit: 100` and copies each real `next_cursor` verbatim into its next call. The four sizes require respectively 1 / 1 / 2 / 3 public list pages and 3 / 3 / 4 / 5 provider inputs, including the ordinary continuation. The verifier checks each page's complete host receipt, exact source/scope/owner metadata, total/count/terminal cursor and union, then checks its model projection in every subsequent actual provider request and installed-serializer HTTP body. It independently binds each current `sr:C` to the native session's canonical unpinned owner; a count alone, fabricated cursor, duplicate/missing owner, incomplete source or foreign binding cannot pass. This exercises public Broker pagination over the offline SDK catalog; it does not certify live Notion API pagination.

The existing system-section/native Skill canary, tool schema and guidance checks remain. Every seeded main and resource hash is forbidden to the existing consumer object observer: only a complete start/end ledger with zero reads, zero pending work and zero errors proves no selected or unselected source body was read. Setup verification of fixture bytes is recorded separately and cannot supply that consumer proof. No active source or selected graph may be created. Inspect `catalog-scale.json`, `catalog-projection.json`, the original provider and RPC captures, native session entries, SDK/object ledgers and installed-serializer HTTP files; retain the normal Evidence → system Trash → Evidence sequence.

The implementation evidence is `~/Library/Logs/pi-context-broker/AH-617-20261105/sc06-catalog-scale-t1hn_q3q/`. `coverage-fail-before.log` preserves the old limit-20 coverage failure and `cursor-fail-before.log` the old selector stopping after a nonterminal first page. These are verifier coverage gaps, not observed product failures. The final local size group passes 13/13, and the original SDK test entry passes 120/120. `producer-contract-alignment.json` checks the four retained CLI fixtures without launching a consumer. `execution-plan.json` freezes the later four installed runs; they were `not_run` at implementation handoff. The local tests do not stand in for the separately recorded actual results below.

On 2026-11-06, the eight-file harness exported from committed `96c683048e72f0da93e652c02bed30ca4b377c82` drove the same independently installed C8 `282fb35a8266fc76c49d9ae3e423fff536b5d9b8d7346b059474357cca28d889` on actual Pi 1.5.0. All four n1 runs passed without retry or fallback, under the frozen 180 s outer / 60 s RPC budgets:

| Catalog size | Actual public page counts | Provider / serializer requests | Actual serialized HTTP bytes |
| ---: | --- | ---: | ---: |
| 10 | 10 | 3 / 3 | 37,595 |
| 100 | 100 | 3 / 3 | 123,279 |
| 101 | 100 + 1 | 4 / 4 | 182,991 |
| 300 | 100 + 100 + 100 | 5 / 5 | 561,413 |

Every run began pending and all later requests were ready with the exact N-card owner/name/description/current-ref set. Actual cursor values, page unions, native session bindings, system/native canary, unchanged tools and installed HTTP projections passed the original assertions. Together the runs made 8 SDK list calls, 0 SDK body calls, 0 source HTTP attempts, 0 CLI child calls and 0 observed object reads; all 1,022 seeded main/resource files remained unselected. The 15 HTTP requests total 905,278 B. Host transcript capture is a separate 1,461,743 B quantity, including 547,536 B of host details; do not add it to HTTP bytes or infer a cost reduction from this scale gate.

`actual/summary.json` (SHA-256 `1be5a1fd93e7671a24498cac44fc8991421104e82cb12013b553ebd73f7b1f9c`) binds each `actual/catalog-N/evidence/` report and the per-page/provider/source proofs. Four native Pi processes and all driver processes exited naturally with code 0; SDK/object observers reached complete EOF with no pending work. The original cleanup commands moved four owned consumer scratch directories to system Trash, then reverified all 134 original evidence files unchanged. Each run's daily sentinels and package/harness/fixture identities remained equal; the 87 installed files, original archive and four source seeds were preserved. The source was the declared warm offline fixture throughout: no production Notion API pagination, source write or real-model success is claimed.

The ordinary `verify-notion-integration.mjs doctor/run --mode live --host pi` route accepts a real installed extension and explicit `--command-json` for the bundled CLI. That verifies the declared custom-command compatibility path, not default SDK transport. Its separate authorized `--mode model --host pi` run verifies actual model entry/resource use under the same explicit source choice. Preserve those identities and transport labels. Formal dependency requirements and the default multi-host route are unchanged.

### Explicit live SDK route

The same driver accepts `doctor|run --package ABSOLUTE_INSTALLED_BROKER --live-input ABSOLUTE_INPUT_JSON`; `run` also requires a new `--out` directory. This is separate from `--fixture` and `--scenario all`: the original 14 offline scenarios remain the default CI route.

The version 1 input has `kind: "live_notion_sdk"`, `host` and `artifact` identities (`path`, `sha256`), one `source` (`id`, `database`), and private `oracle.catalog`, `oracle.use`, and `oracle.resource` identities. Resource also declares `logical_path`. `sentinels` lists the unchanged daily configuration/shim identities. Use same-machine observer-only originals: the full catalog, plus either a complete public `use --json` receipt or a recorded complete SDK consume `wrapper.value` normalized to the public CLI envelope by the pinned CLI's exact `emit({ok:true,...value})` rule. Resource bytes must match the returned fixed manifest.

For a normalized SDK original, retain provenance binding the raw SDK receipt, the pinned conversion rule/source identity, and the normalized expected payload by hash. Independently verify every node, manifest and body identity before freezing it as private expected input. Record this as reuse of an existing SDK observation, with zero new CLI/source requests and no consumer prewarming; keep its original execution outcome, including a failed task, unchanged. The normalized payload itself does not prove a new CLI execution. Doctor verifies the actual supported Pi 1.4.0 or 1.5.0 identity, every archive member against the installed package, the bundled CLI/SDK runtime hashes, and each frozen original. It does not probe authentication or independently certify the normalization provenance.

Run inherits only the local Notion token into an otherwise isolated consumer. CLI state, Broker cache, agent directory and sessions start empty; oracle bodies never seed them. Owned settings auto-load the installed Broker, and actual `get_commands.sourceInfo` must name its installed entry. The target is not passed with `-e`; the controlled provider and passive observer are explicit verification extensions. `source.command` is absent and `prefetch` is false.

The sequence is ordinary greeting → ordinary continuation with the complete ready Default View → exact `notion_list` selection → `notion_use` root and Requires → native `read` using the returned resource handle → ordinary continuation. SDK catalog completion precedes Broker metadata-index publication: the verifier observes the existing no-argument `/context-broker view` status command before that continuation, retaining its local RPC notifications separately. It neither refreshes nor changes a View. A pending first directory or a status notification cannot pass as actual provider delivery. Every selected body and resource must appear completely in the next actual provider request with fixed scope/pin proof. The resource's returned short handle is checked against its canonical fixed identity; its scalar SDK interval must read only those bytes, make zero HTTP attempts and perform no further preparation. Preserve every provider capture and its installed-serializer HTTP replay separately from real-model usage.

Full SDK traces account for actual HTTP attempts, response bytes and source writes; unknowns are not zero. Provider absence is not source exclusion: retained chunk ownership and every unselected Member need the existing independent `notion-skill-source-proof` attribution. Until that separate proof exists, the live result explicitly reports partial acceptance. No additional verification platform, source mutation, new pin, copied authentication or daily configuration change is part of this route. Keep failed attempts, then run the existing `evidence`, `cleanup`, and `evidence` commands against sealed owned output.

### 2026-11-06：CI 构建来源与当前消费内核对齐

`ci.yml` 与 `publish.yml` 的 CLI checkout 同时固定为 `55e06bb3d6ec426b38aefdf8fed61e26ece0343d`。该提交包含 C8 产品源 `b5564ee`、现有 fixture 和 Records coverage 原件留存；继续由同一个 checkout 生成 fixture 并提供 `NTN_SKILLS_BUILD_ENTRY`。不使用分支名或另一个隐式 SDK 来源。

Fail-before 是 Broker `327fdee` 的实际 CI run `42193430631`：整条 workflow success，原模型 harness 52/52、SDK harness 120/120、consumption 203/203、Pi 1.5/1.4 各 17 场均通过，但其 CLI checkout 仍为 `1d88e02`，manifest 的 buildInput 是旧 C7 CLI `6a82d148…` / SDK `2095a85a…`。这份绿色结果只证明它自己的 `79b5eae8…` 包，不能替代本地 `282fb…` C8 候选或新 pin 的实际 CI。原 ZIP、日志和身份见证据根 `ci-scale-ready-ub313eko/broker/handoff.json`，SHA `8e2e20ef718c4c4e5c2e456a847dee2c7efc504750b32e8483d387420b677160`。

新两行接线已由原 `node scripts/skill-consumption-contract.mjs check-gates` 以及 `node --test scripts/skill-consumption-contract.test.mjs`（15/15）检查。日志位于 `sc26-resume-oracle-8yosq3tz/check-gates.log`（SHA `dadcf24305f96036134f38b6e51524020ae1da1541fccc00f0926b9a2a9f0e5f`）与 `contract-tests.log`（SHA `5ac671b12ca0eb6d19688c0e8e5417fec89ff65f08ac1312eb193f59171fe0c2`）。提交后的自然 CI 仍须分别核 checkout、实际 buildInput/嵌入 SDK/归档身份、安装 Pi 与各宿主终局；此处只记录接线，未预判新 CI 结果。

### 2026-11-06：C8 双机与完整安装身份

最终运行时为 CLI `b5564ee` / Broker `726d274`。CLI 独立归档 SHA `2c65d54aee20f0fbb30af30bd1d67b32ad00e7285f0c9a50bc9f477962aeee9f`（68 文件），Broker 归档 SHA `282fb35a8266fc76c49d9ae3e423fff536b5d9b8d7346b059474357cca28d889`（87 文件）。随后 `1e23f5e`、`8650132`、`a08bb6f` 只改验证器、测试和地图；不以相同版本号替代完整文件身份。

Pro 与 Mini 各自在 checkout 外独立安装、以自身认证执行公共 help 与六条 list/read/use/files/resource/export 命令，再用普通 package 自动加载、无 `source.command` / prefetch 的原 live SDK 入口消费。每机 SDK 为 2 list + 1 consume + 1 read、0 CLI 子进程，真实 Default View 74 项，根与 Requires 共 47,475 B、所选资源 1,135 B；公开导出另有 46 个业务文件、364,634 B。每机实际 37 HTTP / 3,473,054 decoded response B / 0 write；独立源归属覆盖 6 次正文 attempts，54 个未选 Members 与 unknown body targets 都为 0。后续 provider 仅一份完整正文。

两机各 7 份实际安装 serializer 请求为 435,010 / 436,736 B，provider 受控，不能代替真实模型质量。相对 ce50 同路线各少 37,508 B；HTTP 与响应量未下降，这是跨版本描述性比较，不能加上 CLI read 另少 6 请求的差额。两 Pi 自然 exit 0；86 份原件与 10 份归属 sidecar 经原 Evidence→系统 Trash→Evidence 后不变，日用配置、87 包文件、8 helper 均保持，没有跨机复制 credential、SQLite 或正文缓存。

历史恢复只声明已实际双机演练的 shared `snapshot-…` pin / `graph-…`：旧 a80 producer 的 A，在 current 已为 B 后冷恢复 2 节点4文件711 B；每机13 HTTP、0 current body，后续9次固定读0 HTTP。C6→C7→C8 固定 reader 闭包逐文件继承；缺失/损坏、offline、401/403 和禁止 current 回退由原安装 SDK22 / 缓存负例维护。该格式使用精确 Records object chunks，不依赖签名附件 URL；专门 expired-link 下载未执行，不把 URL 参数轮换或 Notion 权限失败冒充它。旧 retained ZIP 共用分块 reader 是源码边界，不算本轮双机 ZIP 执行。

完整旧包负例复用原 `intentDoctor`：内部自洽的 ce50/C7 与 C8 同 version `0.0.2`、同 `src/index.ts` SHA `97e7aa5f…`；分别 86/87 发布文件与自身归档一致。仅更改实际 package/extension 路径、保留全部 C8 expected 字段，Doctor 在 `candidate.packageSha256` 比较处 exit 1 拒绝，60 个归档检查子进程全部 close 0，没有 Pi/CLI 消费或来源/模型请求。已有缺 SDK、错 protocol/version、坏 bundle hash 和不支持 Pi 版本的真实 loader/CI 负例仍保留。

证据根为 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/`：

| 原件 | SHA256 |
| --- | --- |
| `sc22-final-c8-3a02z8s9/sdk-live-handoff-1e23f5e.json` | `5d9017ed67ed76d2e4cebae1a97dcf269a58e97f1cc25796d97eb7cf010dc1fd` |
| 同目录 `ce50-comparison-1e23f5e.json` | `46667f76589858f7751de0be591bee143c1f54cfce56fe9e4c88e70205509bec` |
| 同目录 `cli-physical-handoff.json` | `c04515f1ef4e156063f803d0e26fb6793de0ddb0cbaa659ced03fc2b93bc323a` |
| `sc22-old-package-negative-_6fna3uy/handoff.json` | `b63380ec6af185882a6711f051df52a7f4fbfc252b565126600ac4ba4b4a891b` |
| 同目录 `attachment-scope-review.json` | `090a9dc3174f119c0e3cc3d29d036b01fca740f4cd4e44b14cf0d96e43785ff9` |

root 直接核过双机 44 个 SDK 引用、Mini SSH 原件和旧包负例15引用。SC22 六项安装检查已记录，整票继续依赖 SC07 的真实 read/use 主路径；不据此关闭 SC20/SC21、切换日用或发布 npm。旧130 Pro、1e23 CI和模型失败保留。原子计划发布修复后的安装/CI结果见 `session-cache-recovery.md`；真实模型结果见 `skill-dependency-graph.md`。

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
