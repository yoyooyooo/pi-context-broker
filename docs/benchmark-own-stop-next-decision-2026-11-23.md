# NEXT-DECISION：保留80条历史，申请接续原计划剩余59条

**状态：未批准；可审阅提案，不是可执行合约。** 当前所有模型执行保持停止。现有冻结 v3 不支持这次部分 Own scope 的接续；本文件、配套 JSON 和 PATH 证明都不授予执行权限。

## 请求批准的具体范围

申请保留完整80条已闭合物理历史，接受其中 Own 第003条已证实零模型请求的 Git admission invalid，并在新的窄范围接续合同完成独立审查、冻结和实际授权绑定后，只执行原计划尚未启动的59条：Own17、CodeMode24、scale10、fault8。所有已经开始的条目均留在历史；第003条没有重试或替代槽位。

预算保持原样：80已使用 + 59尚未启动 = 139，硬上限144，额外5条仍不分配。cold 剩余7条包含在 Own17内。后续出现新的核心证据问题或未知用量，仍须立即停止后续派发，并保留实际原件。

原模型窗口结束于 **2026-11-24T08:16:05.930Z**。如果接续准备完成时必须使用新窗口，本提案同时请求允许**最多一个新的24小时窗口**：由 root 在批准后、实际冻结与启动前记录真实 UTC 起止时间，并绑定新计划。现在没有创建该窗口，起止值均为 null；不会自动续期。模型、route、参数及预算保持不变，窗口变更需明确进入接续记录。

## 已确认的停止点

正式 census 为80 physical / 80 completed，execution unresolved 为0；9个 scope 已登记，原停止点已闭合。历史有效条目71、invalid9；有效条目的 overall 分类为17 pass、12 fail、42 unknown。有效用量口径仍有5条 unknown，原始 completion 口径仍有6条；总请求量和 token 总量继续保留未知，不能以已知小计代替全量。

Own 原科学设计和已选槽位都是20。当前只执行3条：前两条 admission valid、business pass，但 overall 均为 unknown；第003条为 invalid / not_applicable。其余17条从未开始。报告中的18个 analysis unresolved 包含17个未启动槽和1个已执行 invalid，与 execution unresolved=0 含义不同。

第003条在任务前 admission 阶段观察到 Apple Git2.39.5，冻结期望为 Homebrew Git2.50.1。原始完整 transport reconciliation 证明 model_http_requests=0、guarded_fetch_attempts=0，模型 token 用量为已知0。另有8次分类为 other 的 HTTP；这里不作零网络或零账单结论。原始 invalid、stop=true、用时和第80个物理预约全部保留。本次证据定位于启动环境的 Git 身份漂移。

PATH修复已完成一次实际 capture-only 证明，并通过独立审查。新捕获的完整 expectation 与原冻结值逐字相等，模型 HTTP 与 guarded fetch 均为0；仍有8次 other HTTP。修复仅约束新子进程的启动环境，原003、原 plan 与 ledger 保持，物理预约前后均为80、active leases均为0。证明范围是原003的 reference/broker 条件，尚未演练 cold 操作者的启动包装，也未验证其他条件；将来授权启动时仍须重新观察实际工具身份。准备期发生的 capture 前失败原件另行保留。它不恢复业务执行，也不会把 cold 第1条 invalid 改为 pass。

## 为什么旧 v3 不能直接执行

|现有边界|这次的实际情况|所需的未来窄范围合同|
|---|---|---|
|历史扩展只接受完整消耗的 allocation|Own 只完成3/20，原限制不能20减3后变17|保留原20 allocation 及已花3条，明确转移17个未启动 source slots 到新 identity|
|终止条要求 invalid、unknown usage、attempts>0，并将其加入 unknown 列表|Own003 是 admission_rejected、已知零用量，历史 unknown 数不增加|只识别这份精确 Git admission 停止证据，保留已知0与原 unknown 列表|
|unstarted_followup 仅允许 pilot|Own 的原 phase 为 confirmation|显式支持原 confirmation 的未启动部分接续，保留原 phase 和科学设计|
|普通 followup 要求来自原批准的 stopped pilot_scope|Own 来自有限 campaign_scope / acceptance|绑定这个精确 Own source plan、已闭合 ledger 和已开始集合|
|新 confirmation 禁止使用历史已出现的材料|原 Own 材料已封存、打开，并在这80条历史中出现|保留原 seal、opening 和已知曝光，作为同一确认设计的接续，不声称新的独立盲测|

纯 scheduler 可以表达20个声明槽位中选择17个执行，但不会授予上述权限。当前 `prepareApprovedCampaignHistoryExtension` 和 v3 reader 没有合法的80历史构造通路。所需实现尚未完成；旧 source、authority3、原计划和停止记录继续保持原样。

后续实现必须先通过独立审查与冻结，并验证完整80条前缀、已开始条目的排除和新 stop 仍阻断的负例；随后才可基于真实用户批准生成独立新 authority。当前文件不是该 authority，也不是可直接传给现有 builder 的输入。

## Own剩余17条的精确范围

拟议新 scope：`own-product-confirmation-unstarted-17-1`；拟议新 experiment：`benchmark-own-product-confirmation-unstarted-17-1`。这两个名称目前只在提案中存在，未创建计划、登记或执行。

表中原 order 来自原 plan；未来 selected order 仅表示有序子集的位置。所有 slot ID、case、condition、pair、repeat 和 seed 均由原 plan 原样保留。

|原order|拟议selected order|slot ID|操作者|
|---:|---:|---|---|
|3|0|m0-e1--explicit-01-a-n16-r1--r0|原cold操作者接续|
|4|1|m0-e1--equivalent-01-a-n16-r1--r0|root|
|5|2|m0-e0--equivalent-01-a-n16-r1--r0|root|
|6|3|m0-e0--task-switch-01-a-n16-r2--r0|原cold操作者接续|
|7|4|m0-e1--task-switch-01-a-n16-r2--r0|原cold操作者接续|
|8|5|m0-e1--complementary-01-a-n16-r1--r0|root|
|9|6|m0-e0--complementary-01-a-n16-r1--r0|root|
|10|7|m0-e0--references-01-a-n16-r1--r0|原cold操作者接续|
|11|8|m0-e1--references-01-a-n16-r1--r0|原cold操作者接续|
|12|9|m0-e1--scripts-assets-01-a-n16-r1--r0|root|
|13|10|m0-e0--scripts-assets-01-a-n16-r1--r0|root|
|14|11|m0-e0--implicit-01-a-n16-r1--r0|root|
|15|12|m0-e1--implicit-01-a-n16-r1--r0|root|
|16|13|m0-e1--no-skill-01-a-n16-r1--r0|原cold操作者接续|
|17|14|m0-e0--no-skill-01-a-n16-r1--r0|原cold操作者接续|
|18|15|m0-e0--ambiguity-01-a-n16-r1--r0|root|
|19|16|m0-e1--ambiguity-01-a-n16-r1--r0|root|

原 order0、1、2 分别属于 Own001、Own002、Own003，三条全部排除。原20个科学位置保持一个设计；旧3条与未来17条各自归属于真实 owning plan，不能再计一个独立20条 cohort。第003条保持 invalid，即使后续17条完成也不会得到20条 valid。

原 cold 预承诺位置为2–3、6–7、10–11、16–17。已经开始的位置2保留 invalid；剩余7个位置为3、6、7、10、11、16、17。继续同一个 `cold-skill-operator-1`（同一原操作者的公开逻辑标识），其第一次 `fork_turns=none` 的历史保留，后续称为同一操作者的接续。辅助 operator tokens/cost 仍单列，未知不填0。

拟议顺序交接为：cold位置3；root位置4–5；cold位置6–7；root位置8–9；cold位置10–11；root位置12–15；cold位置16–17；root位置18–19。全部与原全局顺序相容，目前没有释放任何新 window binding。

## Engineering42保持原设计

|原 allocation ID|数量|固定模型执行窗口|
|---|---:|---|
|continuation-codemode-24|24|8 + 8 + 8|
|continuation-scale-implicit-n64-r1|2|1 + 1|
|continuation-scale-implicit-n256-r1|2|1 + 1|
|continuation-scale-references-n16-r2|2|1 + 1|
|continuation-scale-references-n16-r4|2|1 + 1|
|continuation-scale-tariff-n16-r8|2|1 + 1|
|continuation-store-fault-8|8|4 + 4|

7个 scope 共42条，模型串行。CodeMode保留既有6 cases及 broker/native × free/off 条件；scale保留64/256候选、references两轮/四轮和tariff八轮设计；fault保留两项 owned-store first-use 的 clean/fault 配对、8个独立 episode fixture 方案。原 setup、schedule、材料 recipe 和产品绑定均保持；七项来源 SHA 与固定执行数量已列在 `benchmark-own-stop-next-decision-2026-11-23.json`。

Own17与Engineering42继续使用既定 `gpt-6.2-sol` 模型条件，`thinkingLevel=medium`、`maxTokens=4096`；连接与路由配置只由原始绑定约束，不在本公开投影中披露。原 reference/candidate 产品、原材料和 grading/statistics 合同保持。既有 collector/normalizer1.1 口径继续保留；任何未来 source 变化必须明确审查。

当前 runner5 和一次性 engineering-sequence-1 仍绑定旧 Own scope 完整结束与 authority3，**不能启动**。未来第一工程 scope 的 predecessor 必须显式指向新的 Own17 owning scope；授权、source、history、窗口和 continuation 的新绑定应放在新文件中，原 drafts 和已审脚本留存。

## 审批前后的边界

审批前完成的是闭合历史核对、精确未启动集合、静态可行性说明、PATH 零模型证明及其独立审查。本提案未创建新模型窗口、计划、authority、scope registration或reservation。

批准后的执行仍以真实新合同及冻结 source 为条件。原 Own plan、seal/opening、selection2、authority3、原报告和全部 stopped80 原件保留；后续新结果单独报告实际 owner、计划分母、选中数量和完成数量。已知曝光和新的模型时间窗口都应在报告中披露。后续出现新停止，再次保留现场并停止，不自动换 route、补跑、扩大预算或重新确认同一个已开始槽位。

## 证据绑定

|证据|SHA-256|
|---|---|
|正式stopped80 census|5dbe9f334ada482781b729643692f0fa187e6e658651bf5356842cf4b12a4152|
|原Own plan文件|1617dc2717295caa4a32d8a66229ca805bdf24efd0b6cf7fe5d214e1ba0d6822|
|原Own已闭合ledger|c8e51f86a4217923a1b698eb29bbd99f511e527c3170fa83e0618cfa1b72309d|
|Own stopped primary analysis|c4f47ee018e48b3402d7dac8fcabee1c41a292d350ef3d065d0c0ccc8dc15825|
|Own003独立诊断|7eb1ed8533571cbc3502cf97e5d3c767a49d4f1b159a9f40aecb0d978e859433|
|精确Own17数据|0078ca151941a0fd497e35293da70dd27e26f5bf46a35643a6afb1b498da4aa7|
|原Engineering42数据|0ee60715f266f8cf5682ef7d3c02f3ebb81d66b2c85f6818dea5f6bd29b321dc|
|冻结源码静态可行性|5f1042756daa6ebb61cba0bdbb3364d1c333840312092207e5d5ad736cc25cd2|
|PATH零模型证明|152b945cc223610c87a1e6853fd611d4efaf38acaf84c1c3b265bd81dd36313b|
|PATH证明独立审查|9ec86c078eef1312b7920772fe44dbcddd61de32684e416ba01fbb385a1d51a4|
|cold停止点收口|53be95e3b57f26992269bbe73883e70aba29be33aff7c50ddd95e1436b89ec53|
|cold辅助用量收口|2dd42bb9c6ff007d7c520a5b44e480ea9065af8e5a7d3a80c917ebd1878dd495|

配套 `benchmark-own-stop-next-decision-2026-11-23.json` 保持 `approved:false`、`user_approval:null`、`execution_authority:null`、`execution_ready:false`。本公开投影只包含逻辑 ID、已验证的源 SHA 和必要的计数；完整原件保持在各自来源中。

