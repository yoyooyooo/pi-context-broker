# AH-561：33 个用户故事证据账本

本表按父 Issue 的 US01–US33 原文登记。`已观察`只覆盖列出的运行层和候选包；`待最终交付`不因旧包、受控 provider 或已关闭子票而自动通过。原 AH-560 的 15 例及当前额外 2 例独立列于 [验收索引](notion-skill-graph-acceptance.md#original-ah-560-cases)，不能由新图用例计数替代。

| 故事 | 用户目标 | 公开路径 | 已观察证据与边界 | 待最终交付 |
| --- | --- | --- | --- | --- |
| US01 | 作为用户，我希望不安装或登录官方ntn也能使用全部Notion能力，从而迁移彻底且没有隐藏依赖。 | ctl doctor；list/read/files/export；安装包默认CLI解析 | E02, E18：早包直连与官方ntn poison探针已留证 | 最终默认随包CLI、doctor/helper/cleanup及日用路径重验；旧官方CLI历史不算当前证据 |
| US02 | 作为库管理员，我希望用本机明确授权安全认证并隔离不同连接，从而凭据不泄露、缓存不会串权限。 | 自有CredentialProvider；分离CLI/XDG roots；scope身份核对 | E02, E04：实际认证scope及多根配额身份分离 | 最终包独立根认证/读取；不复制凭据，不用旧缓存授权 |
| US03 | 作为执行维护操作的用户，我希望限流后自动等待恢复但未知写入不重复，从而不用手动sleep且不丢数据。 | create/apply/write；原operation恢复；Retry-After队列 | E03, E04, E25：真实body/属性/附件及受控重试；生产unknown保持unknown | 最终owned单Skill create/A→B/归档；任何unknown保原op、不重放 |
| US04 | 作为同时运行多个CLI的用户，我希望同机不同缓存根共享必要限流预算，从而不会各自以为还有配额。 | 实际Node CLI跨内容根调度 | E04：14项Node/SQLite含多进程、共享额度、租约和前台优先 | 最终引擎回归与冻结身份汇入；不是跨机器中心协调 |
| US05 | 作为维护者，我希望用真实入口和独立证据验证每条链路，从而不把模拟或旧成功冒充新能力。 | 既有验证Skill入口；公开CLI/Pi/UI独立run | E01, E19, E20, E23：基线、元数据预检和各证据层已区分 | 原15+额外2、Gate A/B、最终包完整索引与失败台账 |
| US06 | 作为Notion作者，我希望用可读页面链接和关系选择相关Skill，从而不手写UUID或本地路径。 | Notion原生Members/Requires；普通链接、mention、Link to page | E06, E07：三链接形式、准确File ref与生产关系真实回读 | 最终owner域编译/公开读回归；不把metadata当正文 |
| US07 | 作为Notion作者，我希望上游刷新保留自己的附加关系和手工删除，从而不用每次重做配置。 | source refresh plan/dry-run/apply；portable导出/导入 | E05：受控A→B→C保人工增删、显式空集、自定义字段与旧pin | 最终包相应回归汇入；现证据不声称生产Source刷新 |
| US08 | 作为Pstack使用者，我希望先把这套现有Skill的数据关系校准，从而真实试点可直接使用。 | Pstack精确57绑定census；公开关系读回 | E07：Router56、poteto Skill Members55/Requires unslop；architect Requires arena | Gate模型读在最终包复验；数据治理不代替模型自主选择 |
| US09 | 作为Pi用户，我希望只选Pstack Router就能让Agent选对成员，从而不用提前提示poteto或叶子技能。 | Gate A root-only installed Pi native read | E19, E20：真实单根View/token与独立oracle已就绪；受控observer通过 | 最终prompt v2五样本真实模型+完整生成文件+至少一条实际规程执行 |
| US10 | 作为Pi用户，我希望只选poteto-mode类普通Skill也能继续取相关能力，从而关联消费不被限定为Router类型。 | Gate B普通Skill root-only installed Pi native read | E19, E20：真实普通Skill单根View/token；必读unslop关系已治理 | 最终prompt v2五样本真实模型；目标保持optional、不改Router |
| US11 | 作为受限Agent，我希望不依赖shell就能发现和读取准确目标，从而权限小的宿主也能工作。 | read；skill_search；skill_prepare公开工具 | E09, E12：shell关闭native目录→Member→stable FileID资源链 | 最终580部分物化包native-chain/冷pin重新安装验证 |
| US12 | 作为使用某个Skill的用户，我希望其真正必读前置在工作开始前齐备，从而不遗漏前置规则。 | prepare --purpose use；$和/skill前置完成 | E08, E09：完整Required闭包、hash/pin、失败阻断首provider | 最终包root+Required首provider各完整一次 |
| US13 | 作为审查Skill的用户，我希望查看内容时不自动采用全部工作流，从而查看与执行意图清晰。 | prepare --purpose inspect；native read默认inspect | E08, E09：inspect仅根；Required/Member目录不自动采用 | 最终580 native read只有选中文件，目录不冒充ready |
| US14 | 作为选择Router的用户，我希望先获得轻量候选而非全部正文，从而上下文和等待可控。 | Router目录；Members元数据 | E07, E08, E19：分页完整目录、root-only配置；候选正文未自动注入 | 最终A Gate自主选择前0候选正文的实际HTTP归因 |
| US15 | 作为维护者，我希望依赖环和版本冲突明确报出，从而失败不会靠截断或猜测隐藏。 | prepare确定版本、Required环、预算错误 | E08, E12：受控环/版本/深度/字节/类型失败不截断成ready | 最终核心负例汇入；缺资源/历史负例不能被模型final掩盖 |
| US16 | 作为使用多个Skill的用户，我希望共享依赖只准备并注入一次，从而重复路径不浪费请求和上下文。 | 多roots一次prepare；菱形共同依赖 | E08, E09, E14：一graph请求、共同依赖一份正文；批量受控实测 | 最终575/580安装包去重/请求统计复验 |
| US17 | 作为受限访问者，我希望重名、权限或目标缺失时不被替换为其他内容，从而得到准确失败而非错用资料。 | exact ref、scope、同名/复制/权限typed失败 | E06, E08, E12：准确身份失败及Required种类边界；更名重ID独立用例 | 最终权限/同名/复制回归链接；禁止替换其他内容 |
| US18 | 作为长会话用户，我希望Notion更新后旧会话继续使用已选版本，从而正文和资源不混版。 | 会话选择图；resume/fork/rewind/compaction | E13, E15, E23：实际SessionManager/独立Node、历史pin；原15仅历史 | 最终原15 A/B及graph session回归；不以CLI恢复代替宿主 |
| US19 | 作为另一台机器上的用户，我希望凭固定图恢复承诺保留的精确历史，从而不依赖原机本地缓存。 | ctl library graph plan/save/inspect/restore | E15：真实Pro→Mini空根恢复A，current已B，3nodes6files | 最终包恢复及artifact身份汇入；具体scope授权仍实时核对 |
| US20 | 作为等待冷加载的用户，我希望必要内容通过批量共享查询准备，从而减少可避免的网络往返。 | 同库prepare inventory；选中Files/Records有界批量 | E14：真实Node HTTPS 3进程61断言；基线fixture修正另留失败 | 最终修正矩阵/包内批量数据；不引用已否定warm64→1 |
| US21 | 作为启用预取的用户，我希望少量提前准备可取消且不抢前台，从而只在有收益时减少等待。 | 显式prefetch预算；--priority prefetch等公开执行策略 | E17：默认无预算；受控限流/取消/不抢前台 | 最终CLI/Broker owned on/off实际请求及取消回执 |
| US22 | 作为修改正文的作者，我希望只使相关引用索引失效，从而不会牵动全库读取。 | parent/body/relation/parser派生索引与缓存 | E06, E14：索引依赖身份与受控精确失效；固定pin不借current facts | 最终批量/缓存回归与失效命中实账 |
| US23 | 作为消费大资源的用户，我希望已固定完整版本按需取文件而完整导出仍拿齐，从而性能与完整性兼得。 | 固定完整manifest；files/read exact；export完整 | E15, E16：真实Mini按需chunk与full export；Broker4Node/18host边界 | 最终installed Pi部分物化和资源hash，未选文件不下载 |
| US24 | 作为安装插件的用户，我希望包内CLI和Broker采用同一新合同，从而不依赖开发机上的巧合配置。 | 独立npm安装；随包CLI默认resolver | E18, E09：多版独立安装Pi已跑；外置同版CLI不冒充默认resolver | 最终嵌入CLI包、未显式command路径和doctor/check复验 |
| US25 | 作为使用独立Agent上下文的用户，我希望传准确引用或版本锁即可继续授权读取，从而不依赖父进程隐式内存。 | 独立进程exact ref/session binding/graph lock恢复 | E15, E13：Mini空根历史恢复不靠Pro内存；实际Node会话恢复 | 最终独立Agent/宿主按锁读取及scope校验，loaded必须真投递 |
| US26 | 作为取消任务的用户，我希望等待和预取真正停止且不串其他会话，从而不会迟到派发或错误加载。 | 实际PTY Escape；new_session；EOF；prefetch cancel | E10, E11, E17：Escape与new_session真取消；RPC abort未取消明确保留 | 最终580/579包重验；不把RPC清理冒称Stop |
| US27 | 作为生产库维护者，我希望测试有独立owned对象并保留失败证据，从而验收不污染生产或删除历史。 | owned输入/操作/归档；证据不可覆盖；保护核对 | E21, E22, E25：owned原失败与unknown保留；归档可恢复；1615/Tern保护 | 新单Skill与第三View清理+生产目录权限复查；最终commit/push保护 |
| US28 | 作为评估性能的用户，我希望看到请求、字节与分阶段实测耗时，从而不被伪冷缓存或一次样本误导。 | 实际attempt/bytes/queue；五样本分阶段timing | E04, E14, E20：HTTP真实target归因与受控五样本；缺归属失败 | 最终A/B各cold1/warm2/continued2，原值+中位数，无p95 |
| US29 | 作为维护旧Skill的作者，我希望已有内容由CLI维护，仅必要关系和隐式引用被补正，从而不再手动搬运整套正文。 | CLI维护既有Pstack主文/关系/历史pin | E05, E07, E25：4主文18映射22处链接；资源/来源字段保留；unknown独立接受当前 | 最终正确回读与包身份；不全量迁移正文 |
| US30 | 作为未来新Skill套件的使用者，我希望相同合同能作用于Pstack之外的数据，从而系统不靠特例硬编码。 | renamed-identities；Required Router/Prompt异构反例 | E12, E15：全名称/ID/库/路径更换仍通过；非Pstack owned图也已恢复 | 最终同反例通过后维持不引入Matt生产图的coverage决定 |
| US31 | 作为日用Pi用户，我希望新会话加载实际通过验收的产物，从而交付和测试版本一致。 | 日用Pi安装选择与新会话实际加载 | E18, E21：候选包身份/保护已保留，尚未宣称日用切换 | 所有Gate完成后切到同一通过包，新会话验证并保旧安装 |
| US32 | 作为用户，我希望加载/预取不扩大执行和副作用授权，从而内容引用不会变成隐式操作许可。 | read-only transport；loaded/injection receipt边界 | E09, E16, E17：prefetch不可写、不创建sessionLoaded；资源loaded:false | 最终provider0/readonly/取消与真实文件投递回执 |
| US33 | 作为库管理员，我希望不同内容类型的关系有明确约束，从而不会把Prompt或嵌套路由误当必需指令。 | Members/Requires类型约束；prepare明确拒Prompt/Router Required | E08, E12：v3两独立异构拓扑首provider前PREPARE_REQUIRED_KIND | 最终包同步核心/installed Pi类型反例；保exact failure path |

## 证据文件索引

完整机器可读映射保存在 [JSON 账本](notion-skill-graph-story-ledger.json)。每个文件的存在性、大小和 SHA-256 在 checkout 外另存观察回执；存在的日志并不自动代表通过。

### E01 · 冻结验收基线

层次：**controlled / baseline**。

- `/Users/yoyo/Library/Logs/ntn-skills-verification/skill-graph-ng01-MKWuaO/result.json`

### E02 · 独立安装直连只读与认证

层次：**real Notion / earlier installed package**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-LMsyeE/manifest.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-LMsyeE/identity.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-LMsyeE/read-result.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-LMsyeE/pinned-resource-read.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-LMsyeE/official-ntn-probe.jsonl`

### E03 · 真实owned写入、附件、回读

层次：**real Notion / earlier installed package**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/manifest.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/08-native-body-write.stdout`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/09-native-field-write.stdout`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/10-native-readback.stdout`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/native-reference-api-result.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/attachment-final-result.json`

### E04 · 多进程共享调度

层次：**real Node / SQLite / controlled HTTP**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng04-root-1793681747067.json`

### E05 · 上游字段保护

层次：**controlled HTTPS / public CLI**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng07/controlled/handoff.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng07/controlled/two-refresh-protection.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng07/controlled/portable-reimport.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng07/controlled/public-cli-http.json`

### E06 · 三类原生链接、资源、旧pin

层次：**real Notion UI / installed CLI5**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng08/ui-native-forms/installed5-result.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng08/ui-native-forms/archive-native-result.json`

### E07 · 生产Pstack关系及引用治理

层次：**real Notion / exact census**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng09/final-result.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng09/final-census-WFsuRv/result.json`

### E08 · 统一prepare use/inspect

层次：**core / public Node SQLite**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng12/controlled-o9w_qn2s/handoff.json`

### E09 · 首provider闭包、native链、多根

层次：**installed Pi / controlled provider / Broker v1**。

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng13/broker-notion-evidence-eoOLkX/manifest.json`
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng13/broker-notion-evidence-6Zd0yH/manifest.json`

### E10 · new_session与RPC abort真实边界

层次：**installed Pi RPC / Broker v2**。

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/broker-notion-evidence-nvKp7N/manifest.json`
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng13/broker-notion-evidence-G8Hk1k/manifest.json`

### E11 · 终端选择和Escape Stop

层次：**actual Pi PTY / Broker v3**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng15/broker-pi-graph-pty-QFA9Nc/manifest.json`

### E12 · 更名、重ID、异构Required

层次：**installed Pi / controlled provider / Broker v3**。

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/broker-notion-evidence-Fz7HvR/manifest.json`

### E13 · 实际SessionManager和重启

层次：**actual installed SessionManager / independent Node**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng15/selected-graph-D3WrUx/session-evidence.json`

### E14 · 批量查询和精确失效

层次：**real Node HTTPS / three processes / controlled**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng16/controlled/public-cli-evidence.json`

### E15 · 固定图控制与真实Mini恢复

层次：**controlled CLI + real Pro/physical Mini**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/controlled/handoff.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/controlled/public-cli-evidence.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/producer-a-ready.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/producer-a-save.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/current-b-result.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/mini-full-verified.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/mini-partial2-verified.json`

### E16 · Broker按需物化接缝

层次：**real Node SQLite adapter + controlled host**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/partial-cli6-adapter.log`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/partial-host-boundaries-final.log`

### E17 · 预算预取与只读限制

层次：**controlled core / SQLite / Broker runtime**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/core-policy-current-contract.log`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/core-policy-deterministic-clock.log`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/sqlite-scheduler.log`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/broker-runtime.log`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/broker-foreground-regression.log`

### E18 · CLI6冻结产物

层次：**installed package identity / before final freeze**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-W7xCCt/package/ntn-skills-0.1.0.tgz`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng15/package-v3/pi-context-broker-0.0.2.tgz`

### E19 · 真实root-only目录与实际注册token

层次：**real Notion + installed Pi metadata / no model**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/gates-setup/gate-a-default-catalog.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/gates-setup/gate-b-default-catalog.json`
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/graph-selection-nHopCs/result.json`
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/graph-selection-SxmTSw/result.json`

### E20 · SDK观察器五样本与prompt v2冻结

层次：**controlled actual SDK HTTP / no real model**。

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/graph-observer-http-GGSX54/result.json`
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/prompt-v2-freeze-q7ckkC/prompt-freeze.json`

### E21 · 原改动保护

层次：**root verified repository byte/index observations**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/cli-protected.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/broker-protected.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/stage2-commit-receipts.json`

### E22 · owned归档与失败保留

层次：**real owned cleanup / no permanent delete**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/owned-cleanup/failed-owned-result.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng08/ui-native-forms/archive-native-result.json`

### E23 · 原AH560历史15例

层次：**historical real model / old package only**。

- `/Users/yoyo/.local/state/ntn-skills-verification/pi-real-model-cache-_web8gk7/pi-cache-evidence-2givfs/manifest.json`
- `/Users/yoyo/.local/state/ntn-skills-verification/pi-real-model-cache-_web8gk7/pi-cache-evidence-n2TkwW/manifest.json`

### E24 · 生成规程实际执行与反例

层次：**controlled owned project / no real model**。

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/driver-check-ekEjJ5/result.json`
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/prompt-v2-freeze-q7ckkC/related-tests.log`

### E25 · 原unknown写入的独立处理

层次：**real Notion / original outcome preserved**。

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng09/apply-01/architect-body-result.json`
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng09/apply-01/bodies-result.json`

## 待补结果

最终包冻结后追加实际安装身份、原 15+2 矩阵、Gate A/B 各五样本、生成规程执行、最终 PTY/取消、默认随包 CLI、owned 清理与日用新会话加载回执。现有失败文件保留；源 baseline 校正、模型可用性失败、工具链失败、任务失败分别报告。不得引用旧 warm64→1 指标，不将 RPC abort 的不支持结论改成 Stop 通过。

