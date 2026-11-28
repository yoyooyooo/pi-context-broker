# Source 首次引用的实际 Pi 验证

沿 [integration Skill](../SKILL.md) 选择本轮配对的私有 packed build；CLI 的 verify-notion-source-onboarding 拥有业务管理与原件合同。本页只负责真实 Pi 的输入授权、管理交接、普通消费、provider 字节及新客户端复用。

## 输入

使用同一 CLI 提交的 `/absolute/selected/cli/scripts/sdk-fixture.ts --catalog --materialization` 生成新目录。输入只含独立远端事实、真实 Git 原件和固定 commit/blob/hash/bytes/mode，不含消费者 snapshot、SQLite 或 cache。包必须是独立安装目录，CLI、SDK、management 三个模块和 runtime manifest 的 hash 相符。选定实际 Pi 的绝对 entry；不要把源码单测当作这个入口的执行。

上游 fixture 的 HEAD 必须已经前移，且 root 的正文与已接受 commit 不同。runner 先实际读取 Git HEAD 和对应正文，再要求 Source plan 与最终 provider 完整正文仍绑定旧 accepted commit；只改无关文件不能证明没有误跟 HEAD。

runner 启动实际 Git smart HTTP backend、受控 Notion HTTP、同一安装包的固定 manager 和真实 Pi RPC/provider serializer。manager 拥有私有 canonical Store 和与消费者不同的受控凭据；client binding 只能选定固定命令，不能覆盖 generation、Source 集合、凭据、origin 或 Store。回执 scope 必须来自 SDK 对消费者的实际鉴权，manager_scope 保留管理端的实际鉴权；runner 从两边 SQLite identities 独立读取后比较，不能只比较请求回显。正常成功路径的 manager scope 与 consumer scope 可以相同或不同；两者分别来自各自的实际鉴权，不能互相替代。本受控场景特意使用能产生不同 scope 的凭据，独立证明这次分离。命令使用本轮明确选定的受支持 Node 绝对路径；示例 `node` 表示该路径。

## 来源选择前件

先读取有效配置和普通 `$` 的完整本地目录，包含 `requireAutoload: false` 时可显式引用的 Skill。Notion 中 owner/Main 缺失，只证明该成员未导入；不能据此断定裸 `$name` 会选择 Notion。普通 registry 已选中本地 Skill 时，不应调用 Source-member 发现或 manager。

保留同名本地 Skill、原裸名称和原候选事实。使用配置中真实的 namespace 提交普通 `$name@namespace`，并记录实际 prompt 与有效配置身份；namespace 不是上游 repo 或注册 Source ID。不要删本地文件、改优先级、注入 source_id，或先调用远端 list/source-members/consume 来制造冷启动前件。裸名本地正文成功、0 management 与 qualified Notion 首引用成功是两项独立证据；正文命中同名本地对象不能算作 Notion 物化通过。

`source-materialize-first` 的两个客户端都保留同名、不同完整正文的本地 canary，且没有 autoload 标记。首引用和独立客户端使用 `$lazy-root@current-sdk`，完整 provider 必须包含已接受 Git 原件并排除本地 canary；暖读继续使用首次未物化候选的原精确 token。host 回归另验证裸名只交付本地正文且 source-members/management 为 0、qualified 输入完成管理和正文闭包、未知 namespace 不回退同名本地对象。

命中所选 namespace 后，partial 目录即使 candidates 为空也不能证明「未找到」。核可见 `CATALOG_INCOMPLETE` warning、0 management、没有替代 Skill 正文；保留普通任务继续运行的非阻塞语义，不把其普通 provider 回答计作 Skill 交付。complete 空目录仍可报告无匹配，完整目录中的歧义保持明确拒绝。

日用验证还须记录普通启动 shell/argv、继承的 PATH，以及实际解析的 Git 绝对路径、版本和文件 hash。用该实际二进制执行只读 capability 检查 `git --no-lazy-fetch --version` 并保留原退出状态；不能仅凭版本字符串假定选项可用。同一 Node/Pi/HOME 不证明同一 Git；远端非交互 SSH 与用户 login shell 也不能互相代证。复现日用启动方式后再提交首引用。受控 runner 的显式工具 PATH 只证明受控环境；不要临时 prepend Git 后称为日用通过，也不要把执行环境 PATH 遗漏解释成用户日用安装损坏。

## 执行

~~~sh
node scripts/notion-sdk-pi.mjs run --package /absolute/selected/broker \
  --fixture /absolute/owned/materialization-fixture/fixture.json \
  --source-http-helper /absolute/selected/cli/scripts/sdk-source-fixture.mjs \
  --pi /absolute/installed/pi/dist/bundle/cli.js \
  --scenario source-materialize-legacy --out /absolute/owned/materialize-legacy
node scripts/notion-sdk-pi.mjs evidence --evidence /absolute/owned/materialize-legacy

node scripts/notion-sdk-pi.mjs run --package /absolute/selected/broker \
  --fixture /absolute/owned/materialization-fixture/fixture.json \
  --source-http-helper /absolute/selected/cli/scripts/sdk-source-fixture.mjs \
  --pi /absolute/installed/pi/dist/bundle/cli.js \
  --scenario source-materialize-first --out /absolute/owned/materialize-first
node scripts/notion-sdk-pi.mjs evidence --evidence /absolute/owned/materialize-first

node scripts/notion-sdk-pi.mjs run --package /absolute/selected/broker \
  --fixture /absolute/owned/materialization-fixture/fixture.json \
  --source-http-helper /absolute/selected/cli/scripts/sdk-source-fixture.mjs \
  --pi /absolute/installed/pi/dist/bundle/cli.js \
  --scenario source-materialize-legacy-source --out /absolute/owned/materialize-legacy-source
node scripts/notion-sdk-pi.mjs evidence --evidence /absolute/owned/materialize-legacy-source

node scripts/notion-sdk-pi.mjs run --package /absolute/selected/broker \
  --fixture /absolute/owned/materialization-fixture/fixture.json \
  --source-http-helper /absolute/selected/cli/scripts/sdk-source-fixture.mjs \
  --pi /absolute/installed/pi/dist/bundle/cli.js \
  --scenario source-materialize-growth --out /absolute/owned/materialize-growth
node scripts/notion-sdk-pi.mjs evidence --evidence /absolute/owned/materialize-growth

node scripts/notion-sdk-pi.mjs run --package /absolute/selected/broker \
  --fixture /absolute/owned/materialization-fixture/fixture.json \
  --source-http-helper /absolute/selected/cli/scripts/sdk-source-fixture.mjs \
  --pi /absolute/installed/pi/dist/bundle/cli.js \
  --scenario source-materialize-native-root --out /absolute/owned/materialize-native-root
node scripts/notion-sdk-pi.mjs evidence --evidence /absolute/owned/materialize-native-root

node scripts/notion-sdk-pi.mjs run --package /absolute/selected/broker \
  --fixture /absolute/owned/materialization-fixture/fixture.json \
  --source-http-helper /absolute/selected/cli/scripts/sdk-source-fixture.mjs \
  --pi /absolute/installed/pi/dist/bundle/cli.js \
  --scenario source-materialize-cancel-late --out /absolute/owned/materialize-cancel-late
node scripts/notion-sdk-pi.mjs evidence --evidence /absolute/owned/materialize-cancel-late

node scripts/notion-sdk-pi.mjs run --package /absolute/selected/broker \
  --fixture /absolute/owned/materialization-fixture/fixture.json \
  --source-http-helper /absolute/selected/cli/scripts/sdk-source-fixture.mjs \
  --pi /absolute/installed/pi/dist/bundle/cli.js \
  --scenario source-materialize-cold-budget --out /absolute/owned/materialize-cold-budget
node scripts/notion-sdk-pi.mjs evidence --evidence /absolute/owned/materialize-cold-budget

node scripts/notion-sdk-pi.mjs run --package /absolute/selected/broker \
  --fixture /absolute/owned/materialization-fixture/fixture.json \
  --source-http-helper /absolute/selected/cli/scripts/sdk-source-fixture.mjs \
  --pi /absolute/installed/pi/dist/bundle/cli.js \
  --scenario source-materialize-cache-upgrade --out /absolute/owned/materialize-cache-upgrade
node scripts/notion-sdk-pi.mjs evidence --evidence /absolute/owned/materialize-cache-upgrade

node scripts/notion-sdk-pi.mjs run --package /absolute/selected/broker \
  --fixture /absolute/owned/materialization-fixture/fixture.json \
  --source-http-helper /absolute/selected/cli/scripts/sdk-source-fixture.mjs \
  --pi /absolute/installed/pi/dist/bundle/cli.js \
  --scenario source-materialize-blocked-member --out /absolute/owned/materialize-blocked-member
node scripts/notion-sdk-pi.mjs evidence --evidence /absolute/owned/materialize-blocked-member
~~~

上述五个成功场景先运行实际模型工具的 readonly list，再提交用户字面 `$lazy-root`、growth 的 `$lazy-required`，或同名混合来源 first 场景的 `$lazy-root@current-sdk`。覆盖旧行 Content/Current State 属性存在且值为空、仅 Source 无 Skill、Source 的 Content/Contributions 全空、已 ready 集合扩展四种初态。legacy-source 保留真实旧注册形状：Status=applied、Operation 为空、Last Revision 是原 Git commit；旧 commit 仅冻结所选 Git 输入，不能充当 current plan authority。旧行保留 page、Main File ID、stable Skill ID 和人工字段；Members 中的 sibling 不展开，Source 声明集合不能被局部选择替换。legacy 两例用真实 Requires 关系证明完整闭包；source-only 不凭 frontmatter 发明不存在的依赖关系。native-root 另以真实 native 主文为明确根，沿实际 Requires 修复旧 Source 依赖，保留 native 权威和三篇完整正文；authorization_root 的 physical page、scope 和 requires_digest 必须保持，Members 不展开。

物化 ready 回执只覆盖这次 root/Requires，仍是 partial 元数据。沿现役 SDK 完整目录读取核实当前 Library/scope，完成持久化后才回到普通只读 consume；记录这两步的实际顺序。不能用回执行拼成 complete 目录，也不能只看正文 local_cache 就报告整条缓存复用成功。目录失败、partial、错 scope，或等待期间取消/切换 session 都须阻止本次交付；单独的 metadata refresh 应重读原 Source，不应取消或改绑已接纳任务。

这五个成功场景随后启动相同 Store 的另一个空 Pi session/PID，确实在五分钟内复用第一次消费取得的缓存；Notion HTTP、Git HTTP、管理新调用均为 0。source-only 使用首次未物化候选的原精确 `alias@skill%3A<stable-id>@namespace` token，物化后的真实目录必须直接复用它，不能偷偷改成另一次宽松别名匹配。最后启动全新独立 client-2，配置、Store、cache、session 不与 client-1 共用，未复制消费者文件；它从同一 Notion 事实与 Git 取得自身原件，语义写为 0。

## 成员能力阻断与零派发

source-materialize-blocked-member 保留真实 Source-only 注册、固定 commit 的 Git 原件和有效 fixed-manager 配置，只给缺失成员声明 legacy Options.settings.member_patches 中一处有效 SKILL.md description 引号补丁。未改 Git 字节，不注入 SDK 返回值，也不删 manager binding。新的空 Pi 直接提交普通 qualified `$lazy-root@current-sdk`；初态不预热 list/source-members/consume。

SDK 必须从真实 Git metadata 发现唯一候选，完整目录返回 blocked / CURRENT_SOURCE_WRITE_UNSUPPORTED，并保持精确 Source、member、stable Skill、commit/revision 与 scope。进程级 observer 从 Pi 加载到实际 exit0 全程闭合，SDK start/end 配对且无在途请求；管理 diagnostic、固定 manager spawn、替代管理子进程和 consume 都为0。有效 launcher 的 PID 文件保持缺失或空，原 manager Store 的 operations 集合不变；受控 Notion 全部请求为只读，Source/Skill/File/关系/投影事实逐值不变。

远端不变的基线必须在真实 HTTP 服务启动完成后、任何 manager/SDK/Pi 客户端启动前保存为 before-blocked-member.json。先将这份完整服务状态与原输入逐值核对，只允许本场景已声明的缺失 blocks 属性初始化为空映射；其它启动变动必须失败。blocked-clients-start.json 绑定基线原字节 SHA 与单调时间，要求基线早于客户端边界，客户端边界早于原 Pi spawn。结束后与这份实际 before 全值比较，包含 blocks；基线缺失、伪造或采集过晚都不能通过，不能删除字段消除差异。

provider wire 要排除原主文和补丁后的整篇主文，原 Pi session 不得有 selected graph 或 materialization receipt，并保留明确的阻断提示。一次普通回复完成不等于 Skill 交付；本负例不产生暖读成功证明。先在前代独立包保留 materializable 假阳性失败，再在本轮配对新包通过同一 run/evidence 入口。Source 声明级 supported 不能替代成员能力；完整 immutable 文件证明仍由 writer 的实际 manifest/blob 校验负责。

## 冷目录与真实慢请求

`source-materialize-cold-budget` 使用独立的 legacy-source 远端事实与空客户端，第一次用户消息就是 `$lazy-root`。提交前不得执行 `notion_list`、consume 或来源发现，也不得产生 Notion HTTP。保留原五例的只读工具权限检查；这些先查目录的用例不能代替本例。

使用现有 HTTP fixture 的精确 hold，依次将目录的三个请求各延迟 12 秒、首次 consume 的 owner GET 延迟 12 秒、source-members 的 root GET 延迟 14 秒。单个请求保持低于 transport 期限，产品时钟、60/180/240 秒上限与 SDK 实现不改。核实际 SDK operation ID、HTTP 开始/释放/结束时间和初始 native session，要求 manager 开始之前累计已经超过 60 秒；再证明管理回执之后确实完成完整 catalog 和正常 consume，完整根与 Requires 正文进入 provider。不能只用一段总耗时或假时钟证明这条接线。

保存 `cold-budget.json` 与全部原始账本，沿同一 evidence 入口重算；之后仍执行不同 PID 的 0 Notion / 0 Git / 0 management 暖读和独立空客户端。旧包应在同一场景中保留读取超时失败，新包另起输出目录，不能覆盖旧结果。现役 host 单测另覆盖管理后慢目录和慢 consume、多个 root/queued input 累计额度、找不到候选、Stop/session switch 及定时器未调度的到期边界。

## 升级后的混合目录 Store

source-materialize-cache-upgrade 使用新的 legacy-source 远端事实、空客户端和真实只读发现。随后只在本场景私有 Store 中加入两个旧 v1 shared_library 目录；键排在实际发现所得 v2 目录前。输入 fixture 不携带消费状态，seed 不写正文、snapshot 或会话。另保留同 scope 的完整无关 v2 目录、另一 scope 的旧目录及各自 fence，作为字节不变的对照。

先用旧独立安装包执行并保留首个失败，再用修复后的包在全新目录复验。不能改旧 Store、冻结包或失败标签。被动 observer 在真实 manager close、管理模块结果和实际 SDK 完整 list 返回处同步保存目录 payload、generation 与退休 fence。成功必须依次证明：manager 原始回执和实际 exit 0；旧目录及目标目录退休；无关与跨 scope 对照保持原字节；完整当前目录按新 generation 重建；正常 consume 与完整 root＋Requires provider 正文。随后照常执行小于五分钟的新 PID 0 Notion／0 Git／0 management 暖读，以及独立空 client 的 0 语义写／0 投影写。

cache-upgrade/seed.json、逐时点原件及索引、cache-upgrade-result.json 由同一公开 evidence 入口独立复算。缺退休、fence 未推进、错 scope、无关字节变化、目录未完整重建、消费越过目录屏障、缺原始 stderr 或实际 close 都失败。Node 负例同时破坏这些观测，不能只测试作者摘要。

## 管理结果与消费者失败

CLI 只有在原 transport envelope、request、execution binding、library、receipt、target 和 authorization_root 全部通过后，才可在消费者 scope/load/invalidate 失败的 SkillsError.details 中提供 phase:consumer_finalization、同 outer code 的 local_error_code 和 verified_management。后者保留原 request_id、已验证 execution_id、library 和原 manager receipt；scope 仍是 manager scope。验证之前失败或 transport 未知不带这个证明。已知未派发的 SourceManagementUnavailable 保持 remote_writes:none；没有可信回执或结果不确定时保持 unknown。

Broker 再核当前 request/library/target/authorization_root、phase/code 及严格 receipt codec。execution_id 仅作为配对 SDK 已验证的 transport 事实保存，不能宣称 Broker 有第二份独立配置绑定。失败或 receipt 后取消保留原管理 status/operation/effects/scope，但不调用 onReceipt、不构造 consumer scope、不发布 ready、目录或正文。实际准备预算到期仍拒绝本轮交付，不能重新计时或丢掉已经验证的管理事实。这些是具体协议与存储升级义务；消费者有限模型没有管理 transport 或 SQLite schema 变量，TLC 结果不能替代这些实际回放。

## 前台预算与超时

每次 Pi context 共用累计 60 秒普通读取额度。真实字面 `$` 经当前输入、精确来源和目标守卫进入按需物化时，从定向 source-members 开始，到受原授权约束的管理请求、回执、完整目录持久化和正常 consume 完成，共用累计 180 秒 Source 准备额度。初次完整目录与首次普通 consume、准备结束后的 task prompt 和 active restoration 使用剩余普通读取额度。预算能力不授予远端写权限；没有合格修复路径的普通 read/use/model tool 保持原期限。同一 context 的多个 root 和 queued inputs 共用两份额度，不能按 root、SDK 调用或阶段重新计满，绝对上限仍为 240 秒。固定 manager 的服务端时限和未知派发恢复由它自己的配置与 Store 决定。

按原 SDK/management 事件 ID 与单调时间分别记录普通准备、管理等待、目录重建和 consume 的开始、结束、取消或超时。慢 manager 完成后必须仍通过完整目录和 provider 正文断言，不能把 manager ready 当作交付成功。每次阶段切换及最终返回都须检查已耗时间，即使过期 timer 尚未执行。现役物化 runner 的 RPC 等待为 360 秒，大于产品 240 秒上限；外层测试驱动不能先于产品终止并误报其行为。

超时和 Stop 只结束前台等待及旧 session 的发布资格，不终止已接纳 writer、不创建新 request、不删除 pending。迟到回执可以失效共享事实，不能追加到已取消 session、激活选择或进入 provider。未捕获 manager exit 时如实记录未捕获；PID 消失不能推断 exit 0。预算回放和真实 Pi 原始时序分别报告，有限模型不宣称穷尽墙钟或 Promise 调度。

## 真实取消与迟到结果

source-materialize-cancel-late 使用自己的 Source-only HTTP facts、canonical SQLite、request 与真实 Pi，不重用五个成功初态的运行目录。先让精确 Source Content PATCH 到达服务端并阻塞；原 Store 必须已保存同一 request 和 Source operation intent。随后通过 Pi 原生 RPC abort 取消当前等待，再用原生 new_session 在同一 PID 切到新 session。管理子进程和原 HTTP 保留，取消回执按结果未知记录，不能因等待取消而认定远端零写或已结清。

在新 session 普通输入无 Skill 正文后，释放原 HTTP。被动 observer 保留固定管理子进程的原始 stdout/stderr、PID 和真实 close/exit；该原 request 的成功 receipt、实际 HTTP 完成以及同一 SQLite 原意图退休共同证明结清。取消 session 的原始 JSONL 不能变化，新 session 不能出现旧 materialization receipt、selected graph 或正文；迟到前后两次实际 provider 请求也必须排除完整原件。最后在新 session 明确提交一次 `$lazy-root`，重新走普通 consume 并核完整 serializer 字节；不能重放原业务 mutation。

该场景沿同一 evidence 入口独立复算因果时间、原 request/operation、SQLite 原件和 provider/session 原件。Node 负例必须拒绝错 request、替换 Store、提前释放、把 unknown 写成 none、signal 退出冒充成功、残留 pending 以及隐藏在序列化内容中的正文。它与 CLI 固定 manager 的 late-dispatch 四例分开报告：前者证明真实 Pi 取消和 session 发布边界，后者证明未知业务/控制派发和 successor 的处理。任何失败或未知原 Store 都保留，禁止通过重置远端/删除 intent 制造成功。

## 证据

每个 manager 必须由原请求、固定 binding、子进程 PID、完整 stdout envelope/receipt 与真实 child close 绑定；stderr 包括空文件也保存字节/hash。远程 wrapper 的 close 不等于远端 manager close，PID 消失不等于 exit 0，缺失时如实标未捕获。

保留 source-facts、after-materialization、after-independent-client、Notion/Git 原始账本、manager immutable inventory/绑定、真实 manager PID/exit、完整 stdout/stderr 字节与 hash、Pi PID/session/lifecycle、SDK 诊断、完整 wire 及每个原文 hash。现役 `notion-sdk-pi.mjs evidence` 独立复核 provider 文件与这些阶段事实，不能只看汇总 status。

`context-broker.notion-materialization` 和 session 的 `context-broker-materialization` 是管理证据；普通 `context-broker.notion-sdk` consume 及原始 provider 序列化是另一层证据。管理成功后才允许普通 consume 形成新选择。consume.remote_writes 恒为 none，投影写尝试恒为 0；body 来自完整 Git 原件，旧 Notion 生成正文不能充当 oracle。

其余 authority/receipt 负例沿以下现有单测核对：真实 input receipt、精确 roots/scope/session/branch、引用/代码围栏美元名、取消与撤销；请求/返回 Library、注册、commit/revision 和 physical identity；pending/blocked、迟到 receipt、旧 pin 和最终 provider fence。它们不能替代上述实际 Pi 成功和取消路径。

~~~sh
bun test packages/context-broker/scripts/preparation-authority.test.ts packages/context-broker/scripts/source-materialization-contract.test.ts packages/context-broker/scripts/source-member-candidates.test.ts packages/context-broker/scripts/notion-management.test.ts packages/context-broker/scripts/source-materialization.test.ts packages/context-broker/scripts/source-materialization-catalog.test.ts packages/context-broker/scripts/notion-sdk.test.ts
bun test packages/context-broker/scripts/host-prepare.test.ts packages/context-broker/scripts/resource-read-host.test.ts packages/context-broker/scripts/host-content-search.test.ts packages/context-broker/scripts/nonblocking-context.test.ts
PI_QUEUED_INPUT_PACKAGE=/absolute/installed/pi bun test packages/context-broker/scripts/pi-queued-input.test.ts
node --test scripts/notion-sdk-pi.test.mjs scripts/notion-sdk-pi-cache-upgrade.test.mjs scripts/skill-consumption-source-observer.test.mjs scripts/notion-skill-graph-model-evidence.test.mjs
~~~

未知写另由 CLI operation/source-writer 的真实 HTTP/Store 回放和 current-lifecycle 的 SourceWriterSettlement 负责。业务/控制 PATCH 结果未知时，即使 desired 相等也不能派发第二次；唯一原写终结前拒绝 successor，任一子意图未结清就不能先替换父 Source。客户端取消仅撤销等待和发布资格，不删除 manager pending 或因超时自动接管。

消费者另有 `SourceMemberSelection` 有限切片，区分已有本地选择、所选 namespace、complete/partial 及 0/1/多个匹配；三个删守卫负例分别检查来源边界和 partial 管理准入。它以真实解析后的选择和目录作为输入，不证明普通 registry 构造、完整名称解析或启动 shell 的 Git 选择，也不证明 manager 完成。保留上述 mixed-source host/实际 Pi 和日用环境前件，不能用模型通过替代它们；具体动作/源码对应见 consumer-state Skill 的 `SourceMemberSelection` 合同。

如果目录、TTL、readiness 或事实失效发生变化，还必须运行 [新进程缓存四例](session-cache-recovery.md#新进程复用) 的 http-warm-restart、http-warm-directory-expired、http-smart-revalidate、http-smart-current。它们拥有原先缓存全链路回归，新增物化案例不替代它们。

现役 CI 使用同一冻结 CLI 生成器、独立安装 Broker 与 Pi 1.6.0 执行原五例、独立取消迟到例和冷目录慢请求例与混合旧目录升级例，以及成员能力阻断负例，随后逐例运行同一 `evidence` 入口。失败也保留原始证据。`verification-skill-routing.test.mjs` 要求生成器、九次实际执行、九次独立回放及各自上传目录齐全；文档有命令不能替代该自动执行链。

## 结果范围

实际 Pi 加真实 Git backend、受控 Notion/provider 记 controlled-Pi。live Notion、自然模型及普通日用安装各自保留 not_run，直到同一候选实际执行。管理 ready、完整 consume、provider bytes、provider 接受和 turn 结束分别报告；Source materialization 不承诺人类阅读投影。

原始失败保留，新结果给 retest_of。未做独立冷启动 Skill 使用评估则 instruction_evaluation:not_run。清理只限本轮已退出的进程和自有绝对目录；任何仍有未知派发的 manager Store/原件都必须保留，不以删除或强制 ready 获得通过。
