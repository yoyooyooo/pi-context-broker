# AH-561：33 个用户故事证据账本

本表逐字保留父 Issue 的 US01–US33 原文及 Issue 映射。各项结论绑定实际产品包、入口、cohort 和证据层；历史观察保留在行内，新证据追加在索引末尾。账本记录本轮能够独立交付的范围，不表示 33 个故事全部验收通过。

更新时间：2026-11-03T15:14:20.211Z；保留 E62 原六页发布截点（5 页 byte exact、05 页接受 3 项转义）；后续 05 限定措辞勘误为 WRITE_OUTCOME_UNKNOWN，独立读回仍观察到原基线，远端纠正未证实；A/B 失败、五票与父票未完成、日用未激活。

产品包仍为 CLI9（source dd801c17026d9a289c4359c7bfbbf3286cf1ae9d）和 Broker8（source 1809fd7106b2d376e1642b3a29d12c6ee1f07b0a）。后续 H7 验证器及文档提交不替代这两个产品包 source 身份。最终 H7 aggregate 为 b43eeaef8f76b5bf5c97eab4fd10de3367321d1fa5282dde423119e1958910f2，受控回归 96/96，两组实际 SDK 各 10 对请求/回执；SDK 与最终窄产物识别变更之间的函数身份桥接单独保留。

真实 Gate A 采用 H6 原场次：原 EAGER_MEMBERS=11 保留；独立因果时点派生仅消除假提前分类，仍为 READ_MISSING。模型已读对目标主文并成功 final，但没有实际消费必需资源、生成完整 Skill 或执行规程。真实 Gate B 采用 H7 原场次：9 个 provider 响应均为 HTTP 200，无 observer、availability 或 eager 错误，仍因目标/资源/项目读取缺失以及产物不完整而失败。A、B 各后续 4 个矩阵样本未运行；本轮不再追加 cohort，日用保持未激活。

原 AH-560 的 15 例和额外 2 例保留原编号，见[验收索引](notion-skill-graph-acceptance.md#original-ah-560-cases)。最终 17 项要求由 H6 初始 10 个成功项、H7 cold-native-command 必要复验 1 项、H7 updated6 的 6 项成功分别覆盖；H6 原 10 pass / 1 fail manifest 未改。updated6 真正续接 H6 旧会话并保持 B，其余 5 项消费显式写回后的 A。这是有来源的逐项覆盖，不是一次新的 17/17 cohort。

owned 收尾完成：两精确页各一次归档并独立 GET 确认，第三临时 single View 已删除；A/B Views 刻意保留。18 个已审本地目录移至 Trash，原 session、prefix、失败和 SHA 保留，不推定全机临时目录清空。生产 census 复用冻结全表后只续采缺失关系与 View/清理 metadata：Skills 300、公开 catalog 298、Files 818、Sources 59，Records 未扫描；差额是两个 Enabled=false 的 Skill。57 页保护字段与完整关系无未解释变化，root Members 56、poteto Members 55。44 次实际 HTTP 全 200，原始分类 42 metadata + 2 unclassified_body 保留；后两次仅关系 property-item IDs/pagination。独立结论通过，两个原 collector 的非通过状态未改。

原六页发布截点（E62）：已发布并由已安装 CLI9 独立读回；5 页对最终候选正文 byte exact，05 页只对独立接受的 3 项 Markdown 转义结果逐字核对；05 对原候选仍为 byteExact=false，原 strict 失败保留。AH-558/AH-560 历史 suffix 逐字保留（E62）。02 页原自动链接差异经新的明确格式编辑纠正，原严格失败保留；05 页没有再写入。共 7 个已获 Success 的更新操作，覆盖 6 页，未决页面派发 0。独立读回实际 12 HTTP（6 metadata、6 body、0 write/provider），0 request bytes / 69,128 response bytes；最后两页 publisher 实际 10 HTTP（4 metadata、4 body、2 write），52,344 / 96,193 bytes。最初 Bun runtime 拒绝与首轮 Node publisher 未完整落盘总 HTTP metrics，不重构其总 attempt。 本账本截点包含上述回执，不等待包含自身的最终 Git 提交；最终提交、保护与 push 回执在外部 Logs/Linear 单独记录。

后续限定勘误（E63）：05 页仅拟将“三份所需资源均为 0”改为“必读 README 与示例二选一组的实际读取和 provider 内容均为 0”。以已知 f5f3a297…162eb / 33,445 B 正文为基线的新 operation ah561-doc-resource-erratum-9379695c85bfee27bbdadce8708d5b23862122eb102ddaaead9b758f1445ea40 只派发一次 PATCH，明确返回 WRITE_OUTCOME_UNKNOWN（network / NOTION_UNAVAILABLE）；0 个确认成功，1 个未决。独立 CLI9 metadata/body 两次 GET 均成功，观察正文仍为原 f5 基线，而非 143e2043…7ba977 / 33,496 B 候选；parent、properties 与 AH-560 历史 suffix 均保持。该观察不把原 unknown 判为未派发或未应用，远端措辞纠正尚未证实，没有重放或 accept-current。E62 原 7 Success / 0 unresolved 保持其历史截点；最新已知页面操作另有这一笔 unknown，不能继续把当前未决数写成 0。publisher 独立 3 attempts（1 metadata、1 body、1 write；2 success、1 network unknown），67,517 request B / 34,780 已知 response B，unknown_response_bytes=1 为未知计数；reader 另有 2 HTTP 全成功，0 / 34,780 B，0 write/provider。原首轮 publisher 总 HTTP 成本仍未知。AH-566 原 no-ntn 范围已 Done；此勘误待核对并列入 AH-582，五票及父票未完成、A/B 失败、日用未激活的状态不变。

| 故事（Issue 映射） | 用户目标 | 公开路径 | 已观察证据与边界 | 待最终交付 |
| --- | --- | --- | --- | --- |
| US01 (AH-563, AH-566, AH-582) | 作为用户，我希望不安装或登录官方ntn也能使用全部Notion能力，从而迁移彻底且没有隐藏依赖。 | ctl doctor；list/read/files/export；安装包默认CLI解析 | E02, E18, E26, E29, E35, E38, E40, E42, E43, E46, E47, E48, E49, E50, E52, E53, E54, E55, E56, E58, E59, E62, E63：历史基线：CLI9原冷logical refresh同命令已修复并实测通过，29请求/1,245,827响应字节/0写；原CLI8 65请求/206,985,388字节失败保留。最终包内CLI9与Broker7运行门通过，无官方ntn路径。H5/H6 检查点：当前产品仍为CLI9/Broker8。H5与H6真实运行已实际发生，不能继续写“H5仅准备/尚未启动”；产品安装身份、受控SDK、真实模型任务分别记账。。本轮最终：最终CLI9/Broker8安装与真实单Skill17项要求已有分层证据；六文档按冻结计划发布并独立读回。产品包身份与后续harness/文档Git提交分开。A/B自然任务仍未过，日用未激活。 文档最终读回为 5 页 byte exact 与 05 页接受 3 项 Markdown 转义；05 对原候选仍不逐字相同。。E63 后续限定勘误：上述 5+1 读回结论属于 E62 原六页发布截点；05 的资源要求措辞修正另发一次新 operation，结果 WRITE_OUTCOME_UNKNOWN。独立 CLI9 两次 GET 仍观察到 f5 基线，不能据此判定原操作未派发或未应用；远端纠正尚未证实，无重放。 | 本轮产品安装与文档交付完成；AH-582所需A/B及日用终验未完成。 |
| US02 (AH-563) | 作为库管理员，我希望用本机明确授权安全认证并隔离不同连接，从而凭据不泄露、缓存不会串权限。 | 自有CredentialProvider；分离CLI/XDG roots；scope身份核对 | E02, E04, E26, E30, E31, E38, E40, E42, E43, E48, E51, E53, E54, E55, E56, E59, E61：历史基线：实际自有认证scope隔离、多进程调度及Mini8独立自身认证通过；无token/SQLite复制。H5/H6 检查点：H5补证独立oracle与原consumer根分离；scope固定5a163d388fb831806a56ba23889f425eaf974d98fae86ad3bb883d40ca956938。H6A/B与单Skill继续各自隔离根，未复制token或consumer缓存。。本轮最终：H7所有真实消费继续使用独立consumer根与同一已验证scope；补证和生产census均使用独立oracle/state根，未复制token或consumer缓存。 | 本条原认证/隔离范围无新增待项；不由scope一致推定日用激活。 |
| US03 (AH-564, AH-565) | 作为执行维护操作的用户，我希望限流后自动等待恢复但未知写入不重复，从而不用手动sleep且不丢数据。 | create/apply/write；原operation恢复；Retry-After队列 | E03, E04, E25, E30, E34, E35, E41, E43, E49, E50, E55, E59, E60：历史基线：掉响应后按原native-create journal核对、不重复创建已有12pass/154assert受控直接证明。旧A2 main独立accept-current不完成父aggregate，unknown/fence保留；旧两页已按create-op归档；新owner两次单文件write验证完整B。H5/H6 检查点：H5旧失败和unknown/fence不改写。H6单Skill初始11项实际10pass/1fail；此检查点尚未做updated6，不能用初始通过代替B→A后的分支/更新验证。。本轮最终：两精确文件B→A各经唯一公开write及独立readback；随后两owned页各一次archive并GET确认。原unknown父操作、fence和历史失败仍按原状态保留，未aggregate重放。 | 本轮唯一文件更新与owned清理完成；原unknown不被后验接受改判为父aggregate完成。 |
| US04 (AH-565) | 作为同时运行多个CLI的用户，我希望同机不同缓存根共享必要限流预算，从而不会各自以为还有配额。 | 实际Node CLI跨内容根调度 | E04, E26, E38：历史基线：14项Node/SQLite含跨根多进程额度/租约/前台优先；最终CLI9完整3208pass/26736assertions/229files，types/package通过；旧CLI7/8的3203单列保留。本轮最终：原跨内容根调度、真实CLI9运行门及保护证据保留；本轮未新增跨机器协调承诺。 | 无新增调度功能待项；不宣称跨机器中心协调。 |
| US05 (AH-562, AH-581) | 作为维护者，我希望用真实入口和独立证据验证每条链路，从而不把模拟或旧成功冒充新能力。 | 既有验证Skill入口；公开CLI/Pi/UI独立run | E01, E19, E20, E23, E26, E27, E28, E34, E35, E36, E37, E38, E39, E40, E41, E42, E43, E44, E45, E46, E47, E48, E49, E50, E51, E52, E53, E54, E55, E56, E57, E58, E59, E60, E61, E62, E63：历史基线：CLI9完整3208pass、Broker7完整门与实际Pi七阶段保留；Broker8 H4受控SDK78项及legacy20通过。真实原15 H4初始2pass1fail8skip，主文已精确读取、合法index资源被observer误拦；所有原结果保留。H5/H6 检查点：H5原A/B均timeout且顶层OBSERVATION_INCOMPLETE；独立metadata补证后归属完整但仍失败。H6A假EAGER时点已独立派生为READ_MISSING，真实资源缺口仍在；H6B裸owner prepare与legacy已广告主文的observer误拦单独诊断。。本轮最终：最终证据覆盖受控96项、两组实际SDK、H6A和H7B真实失败、legacy17项分层覆盖、清理、生产census与六文档读回。模型失败、观察器修复、离线派生与未运行样本分别保留。 | A/B Gate及完整生成Skill驱动未通过；不得将可独立交付项或legacy覆盖写成33/33验收通过。 |
| US06 (AH-567, AH-569) | 作为Notion作者，我希望用可读页面链接和关系选择相关Skill，从而不手写UUID或本地路径。 | Notion原生Members/Requires；普通链接、mention、Link to page | E06, E07, E26, E27, E28, E38, E42, E47, E48, E52, E53, E54, E55, E56, E58：历史基线：实际UI三链接、FileID与旧pin通过；最终core owner域正负例及Broker4/5资源链、Broker6别名SDK已通过。H5/H6 检查点：H6已验证省略可选snapshot/FileID与已发现稳定FileID旧显示路径；88项受控回归、两次实际安装SDK各10对wire/payload。H6单Skill自主native read已通过；余下native主文wrapper与B省略/SKILL.md为两处已证实observer合同误拦。。本轮最终：H7以实际installed parser、已发现metadata主入口及完整native wrapper delivery绑定修复观察误拦。受控96/96、两组实际SDK各10对与真实cold-native-command 1/1已通过；未放宽身份/路径边界。 | 原链接/资源合同范围无新增待项；Graph自然任务的资源消费不足另列。 |
| US07 (AH-568) | 作为Notion作者，我希望上游刷新保留自己的附加关系和手工删除，从而不用每次重做配置。 | source refresh plan/dry-run/apply；portable导出/导入 | E05, E26, E38, E61：历史基线：受控A→B→C保人工增删/显式空集/未知字段/旧pin；最终CLI9 3208完整suite覆盖相关回归。本轮最终：最终57页复核确认Origin、Selected Version和作者字段保护；仅附件下载签名/expiry轮换，稳定附件身份逐项相同。未执行新的生产Source刷新。 | 无新增上游保护功能待项；受控刷新结果不冒称本轮生产Source刷新。 |
| US08 (AH-570) | 作为Pstack使用者，我希望先把这套现有Skill的数据关系校准，从而真实试点可直接使用。 | Pstack精确57绑定census；公开关系读回 | E07, E26, E38, E45, E47, E51, E53, E57, E61：历史基线：生产57个指定记录逐一census；Router56、poteto普通Skill Members55/Requires unslop、architect Requires arena；4主文22链接已治理。H5/H6 检查点：Pstack生产关系治理与模型任务分开。H5独立补证A18/18、B6/6正文均归属且选择前成员计数0；H6A原11来自后注册observer时点，四个模型已选owner的5+2+2+2请求离线纠正后为0，原计数/文件保留。。本轮最终：最终生产census精确57页及logical IDs全部保留；root Members56、poteto Members55、全部Members/Requires完整，来源pin/Origin/Kind/Enabled/Main File ID和作者字段无未解释变化。 | Pstack生产关系治理与最终复核完成；真实A/B失败不改判为治理通过后的自然任务成功。 |
| US09 (AH-573) | 作为Pi用户，我希望只选Pstack Router就能让Agent选对成员，从而不用提前提示poteto或叶子技能。 | Gate A root-only installed Pi native read | E19, E20, E28, E35, E44, E45, E47, E50, E51, E53, E57, E63：历史基线：root-only View/oracle/TASKv2冻结；H3 A原EAGER_MEMBERS保留，H4补完整retained归属后离线仍READ_MISSING，78回归/实际SDK只证明观察器受控链。H5/H6 检查点：H6A root-only自主读对create-verification-skill主文6837B，6次后续provider上下文含匹配正文；成功stop final22070B。required feature-map README及两例资源均0native read/0provider内容，独立派生仍READ_MISSING；原EAGER11保留。。本轮最终：A最终采用H6真实结果：已读对6837B目标主文且成功final22070B；required README与示例选择组资源均未实际native read/provider消费。原EAGER11保留，独立时点派生为0后仍READ_MISSING；没有完整Skill或执行。 | Gate A未通过；后续4样本notRun，本轮不再追加A cohort或替模型补资源/文件。 |
| US10 (AH-576) | 作为Pi用户，我希望只选poteto-mode类普通Skill也能继续取相关能力，从而关联消费不被限定为Router类型。 | Gate B普通Skill root-only installed Pi native read | E19, E20, E28, E44, E45, E47, E50, E51, E54, E56, E57：历史基线：普通Skill root-only View与Requires仅unslop已实证；H3 B原CANDIDATE_IDENTITY及路径误拦保留，H4修观察器后离线仍READ_MISSING。H5/H6 检查点：H6B原READ_MISSING。已发现poteto/unslop owner的skill_prepare roots省略可选/SKILL.md被observer误拦，产品解析支持且源码/installed hash一致。成功stop final22213B，但目标/资源未读、无完整生成Skill或执行。。本轮最终：H7B实际READ_MISSING；9 provider全200、无observer/availability/eager错误。模型有成功final23643B，但native目标/资源和owned项目读取均0；5个项目路径漏前导斜线被正确拒绝。仅保留2个文件，无SKILL.md或规程执行。 | Gate B未通过；warm-new-process与continued-session共4样本notRun，不用成功final替代目标/资源/产物证明。 |
| US11 (AH-572) | 作为受限Agent，我希望不依赖shell就能发现和读取准确目标，从而权限小的宿主也能工作。 | read；skill_search；skill_prepare公开工具 | E09, E12, E27, E28, E42, E44, E46, E47, E48, E49, E52, E53, E54, E55, E56, E57, E58, E59：历史基线：Broker8 H4真实read-only case1已自主读取438B精确主文，但随后已广告index目录的manifest内relative资源被Graph误拦；两显式场景均完整主文/资源通过，错误归因有只读receipt。H5/H6 检查点：H6已验证省略可选snapshot/FileID与已发现稳定FileID旧显示路径；88项受控回归、两次实际安装SDK各10对wire/payload。H6单Skill自主native read已通过；余下native主文wrapper与B省略/SKILL.md为两处已证实observer合同误拦。。本轮最终：正常read/skill_search/skill_prepare公开工具面及窄发现边界已受控和真实legacy验证。H7B无新的observer误拦；错误模型路径仍拒绝。AH-572所需真实A/B整体目标均未通过。 | 保留无shell公开工具功能证据；AH-572的A/B自然任务验收仍未满足。 |
| US12 (AH-571, AH-574) | 作为使用某个Skill的用户，我希望其真正必读前置在工作开始前齐备，从而不遗漏前置规则。 | prepare --purpose use；$和/skill前置完成 | E08, E09, E26, E27, E28, E37, E38, E39, E42, E47, E48, E52, E54, E55, E56, E57, E58：历史基线：use根+Requires闭包、首provider完整hash各一次及失败阻断在core和独立Pi通过；Broker6SDK根+3Required各一次；最终Broker7/CLI9七阶段每个root/Required全文及pin真实provider核对通过。H5/H6 检查点：独立use/Required与去重既有功能证据保留。H6B首次provider已完整包含41537B根及5938B unslop；H6单Skill初始10项通过含cold-dollar/同session/跨进程与TTL路径，但cold-native-command误拦保留。。本轮最终：Required/use首provider完整闭包的原功能证据保留；H7真实native-command入口通过。Graph B已完成root/Required提供，但模型未继续读目标和必需资源，不能改写为任务通过。 | 原use/Required功能范围完成；AH-574按原AC与tar delta已完成，Graph自然任务缺口独立保留。 |
| US13 (AH-571, AH-574) | 作为审查Skill的用户，我希望查看内容时不自动采用全部工作流，从而查看与执行意图清晰。 | prepare --purpose inspect；native read默认inspect | E08, E09, E26, E27, E28, E37, E38, E39, E42, E47, E48, E52, E53, E54, E55, E56, E58：历史基线：inspect只根、不递归Requires/Members；Broker4真实Pi与CLI8同JS、580entry/fullmanifest独立适配通过。H5/H6 检查点：H6已验证省略可选snapshot/FileID与已发现稳定FileID旧显示路径；88项受控回归、两次实际安装SDK各10对wire/payload。H6单Skill自主native read已通过；余下native主文wrapper与B省略/SKILL.md为两处已证实observer合同误拦。。本轮最终：实际产品URI parser与已验证metadata入口用于inspect读取；native wrapper仅凭真实provider完整主文、receipt与immutable身份发现。无需执行许可即可查看，原use/inspect区分保留。 | 原inspect语义无新增待项；任何观察器纠正均不为模型补造资源读取。 |
| US14 (AH-567, AH-572) | 作为选择Router的用户，我希望先获得轻量候选而非全部正文，从而上下文和等待可控。 | Router目录；Members元数据 | E07, E08, E19, E27, E28, E45, E47, E51, E53, E56, E57, E61：历史基线：root-only目录与完整分页通过；H4受控SDK首provider根+Required各一、Member0；H3 A未归属retained请求已有完整来源证明，离线仍因目标资源未读不达标。H5/H6 检查点：Pstack生产关系治理与模型任务分开。H5独立补证A18/18、B6/6正文均归属且选择前成员计数0；H6A原11来自后注册observer时点，四个模型已选owner的5+2+2+2请求离线纠正后为0，原计数/文件保留。。本轮最终：H6A的11次正文请求均由后注册observer时点造成假提前分类，四条因果链离线纠正后为0；原结果不改。H7B实际选择前member正文计数0，最终57页轻量目录与关系完整。 | 目录和按需选择边界已分层核实；模型缺读取仍使A/B不通过。 |
| US15 (AH-571) | 作为维护者，我希望依赖环和版本冲突明确报出，从而失败不会靠截断或猜测隐藏。 | prepare确定版本、Required环、预算错误 | E08, E12, E26, E27, E38, E42, E43, E45, E50, E51, E53, E54, E56, E57：历史基线：环/确定版本冲突/深度/bytes/节点/Required类型失败在最终core与独立Pi负例明确阻断，非截断ready。H5/H6 检查点：错误分类保留原结果与独立归因两层：H5未知归属/睡眠/模型坏输入分列；H6A晚时点假EAGER纠正后真实READ_MISSING仍在；H6B裸owner合法输入误拦单列。。本轮最终：最终保留真实typed失败及来源：H5超时/未知观察、H6假EAGER时点和合法输入误拦、H7B真实READ_MISSING分列；成功final与原unknown均不覆盖失败边界。 | 无新增typed错误功能待项；历史失败和unknown继续保留。 |
| US16 (AH-571, AH-575, AH-574) | 作为使用多个Skill的用户，我希望共享依赖只准备并注入一次，从而重复路径不浪费请求和上下文。 | 多roots一次prepare；菱形共同依赖 | E08, E09, E14, E26, E27, E31, E37, E38, E39, E42, E47, E48, E52, E54, E55, E56, E57, E58, E59：历史基线：多根菱形共同依赖一次准备/一次正文；修正n3 cold请求菱形32→16、101节点810→115，锁/文件绑定逐项同。H5/H6 检查点：独立use/Required与去重既有功能证据保留。H6B首次provider已完整包含41537B根及5938B unslop；H6单Skill初始10项通过含cold-dollar/同session/跨进程与TTL路径，但cold-native-command误拦保留。。本轮最终：原共享Required去重、批量准备及受控SDK证据保留；H7 SDK实际根/Required完整身份通过。真实legacy17项按原cohort来源覆盖，Graph A/B未被拼接成通过。 | 原共享依赖去重范围无新增待项；自然任务未过不增加额外吞吐/跨cohort结论。 |
| US17 (AH-567, AH-569, AH-581) | 作为受限访问者，我希望重名、权限或目标缺失时不被替换为其他内容，从而得到准确失败而非错用资料。 | exact ref、scope、同名/复制/权限typed失败 | E06, E08, E12, E26, E27, E38, E42, E44, E47, E48, E49, E52, E53, E54, E55, E56, E57：历史基线：核心权限/同名/复制/ownerFileID冲突均过；Broker4更名重ID及RequiredRouter/Prompt独立反例通过。H5/H6 检查点：H6已验证省略可选snapshot/FileID与已发现稳定FileID旧显示路径；88项受控回归、两次实际安装SDK各10对wire/payload。H6单Skill自主native read已通过；余下native主文wrapper与B省略/SKILL.md为两处已证实observer合同误拦。。本轮最终：H7仍拒绝未知路径、越界、未发现owner、错scope/pin/File ID和改变参数。B的错误项目路径按实际assistant authored输入拒绝；无同名替换或observer假放行。 | 精确身份与失败边界验证完成；真实模型错误输入原样保留。 |
| US18 (AH-577) | 作为长会话用户，我希望Notion更新后旧会话继续使用已选版本，从而正文和资源不混版。 | 会话选择图；resume/fork/rewind/compaction | E13, E15, E23, E30, E34, E36, E37, E39, E42, E43, E48, E49, E50, E55, E58, E59：历史基线：真实SessionManager/分支/压缩与Mini8历史pin证据保留。Broker6/CLI8及最终Broker7/CLI9实际Pi七阶段都7/7：旧root+Required A、新会话B、resume A、首次optional B、refresh全B、resume B；tool/provider全文hash和选择锁逐节点验证。H5/H6 检查点：H5旧失败和unknown/fence不改写。H6单Skill初始11项实际10pass/1fail；此检查点尚未做updated6，不能用初始通过代替B→A后的分支/更新验证。。本轮最终：H7 updated6全部通过：真正续接H6 autonomous旧会话仍固定B s_404384…2b95，其余5项消费独立写回后的A s_0deb9c…8700。原case名称中的-b后缀保留，实际snapshot以回执为准；H6原10/1未改。 | 本轮原长会话/更新6项范围已验证；不将其替代Graph自然任务或日用激活。 |
| US19 (AH-578) | 作为另一台机器上的用户，我希望凭固定图恢复承诺保留的精确历史，从而不依赖原机本地缓存。 | ctl library graph plan/save/inspect/restore | E15, E30, E59：历史基线：最终Mini8自身认证/空四根，从Pro固定图恢复当前B之前的3节点6文件A，所有bytes/hash/版本向量一致。本轮最终：原CLI固定图/Mini独立恢复证据继续保留；本轮legacy会话更新与精确历史pin证明单列，不扩大已验证宿主或跨机器恢复范围。 | 原CLI固定图恢复范围无新增待项；其他宿主/新范围未运行仍明确列出。 |
| US20 (AH-575) | 作为等待冷加载的用户，我希望必要内容通过批量共享查询准备，从而减少可避免的网络往返。 | 同库prepare inventory；选中Files/Records有界批量 | E14, E26, E31, E38, E40, E56：历史基线：固定同fixture n3菱形32→16、101节点810→115，warm1→1；公共CLI61断言与真实NotionB cold26/warm1/revalidate19分层保留。本轮最终：既有批量查询和CLI9冷logical原命令修复成本按原回执保留；H7只修验证观察边界，没有重新发明性能矩阵或把失败成本移除。 | 无新增批量查询功能待项；不从本轮单样本推出普遍性能收益。 |
| US21 (AH-579) | 作为启用预取的用户，我希望少量提前准备可取消且不抢前台，从而只在有收益时减少等待。 | 显式prefetch预算；--priority prefetch等公开执行策略 | E17, E33, E60：历史基线：真实owned off前台4.832s/9请求/37730B；on前台3.999s但预取+前台9.782s/13请求/52821B；预算默认0、未用预取正文0。本轮最终：原预算预取受控与owned on/off证据保留，n=1限制不变；本轮模型及owned进程终态与清理已记录，不新增未经授权的预取或日用配置。 | 原预算预取范围无新增待项；不扩张样本量、性能结论或日用激活。 |
| US22 (AH-569, AH-575) | 作为修改正文的作者，我希望只使相关引用索引失效，从而不会牵动全库读取。 | parent/body/relation/parser派生索引与缓存 | E06, E14, E26, E31, E38, E40, E56, E61：历史基线：parent/body/relation/parser精确派生失效及真实Notion derive miss3→hit3→hit3；到期17metadata+2retained/0current，原错误要求0body失败保留。本轮最终：原精确派生索引与CLI9发现修复证据保留；最终生产57页metadata复核无未解释变化，H7观察器修复未改变产品引用索引或扩大授权。 | 原精确失效范围无新增待项。 |
| US23 (AH-580) | 作为消费大资源的用户，我希望已固定完整版本按需取文件而完整导出仍拿齐，从而性能与完整性兼得。 | 固定完整manifest；files/read exact；export完整 | E15, E16, E27, E28, E30, E32, E42, E43, E47, E48, E52, E53, E55, E57, E58, E59：历史基线：Mini8 entry420B→resource516B→full1106B精确A；公开CLI指定39200B两chunk、完整再补17B，Broker6lazyalias SDK实际完整read通过。H5/H6 检查点：H6单Skill自主native read实际完整读取438B主文及201B资源并到provider。H6A目标prepare内抓取了自身三页资源用于物化，但模型未做这些资源的native read、provider未收到资源正文；两者不能混记。。本轮最终：单Skill真实main438B/resource201B与固定版本完整provider证据按原case保留；Graph A仅物化资源而未消费，Graph B缺目标/资源native read。物化、工具读取、provider消费和完整导出分开计。 | 原按需/完整导出功能证据保留；A/B资源消费缺口仍未满足。 |
| US24 (AH-566, AH-582) | 作为安装插件的用户，我希望包内CLI和Broker采用同一新合同，从而不依赖开发机上的巧合配置。 | 独立npm安装；随包CLI默认resolver | E18, E09, E26, E28, E38, E40, E46, E47, E48, E49, E50, E52, E53, E54, E55, E56, E58, E59, E62：历史基线：CLI9独立30文件及Broker8 exact archive/runtime48已核；H4 actual SDK及真实两显式场景均使用同日用候选路径；H4自主alias误拦属于observer，不借安装身份推定完成。H5/H6 检查点：当前产品仍为CLI9/Broker8。H5与H6真实运行已实际发生，不能继续写“H5仅准备/尚未启动”；产品安装身份、受控SDK、真实模型任务分别记账。。本轮最终：实际产品包保持CLI9/Broker8：CLI9 JS及Broker8 tar身份冻结，后续H7/文档提交另计。H7验证器96项及真实legacy17项分层覆盖完成，六文档有独立读回；自然任务失败不改变包身份。 | 安装包/合同与文档可独立交付；日用激活仍被A/B Gate阻断。 |
| US25 (AH-578, AH-577) | 作为使用独立Agent上下文的用户，我希望传准确引用或版本锁即可继续授权读取，从而不依赖父进程隐式内存。 | 独立进程exact ref/session binding/graph lock恢复 | E15, E13, E30, E36, E37, E39, E59：历史基线：Mini8空根跨物理机exact图恢复，真实SessionManager及最终Broker7/CLI9实际Pi多进程恢复均通过；每个root/Required/optional的scope、pin、完整bytes/hash由正常public CLI和真实tool/provider产生，无私写消费缓存。本轮最终：updated6的独立新进程与真实resume按精确snapshot验证；旧会话B和5项新A分开。既有独立上下文/graph-lock恢复范围保留，未以父进程隐式内存补证明。 | 已验证独立读取/历史pin范围无新增待项；Graph自然任务仍独立失败。 |
| US26 (AH-565, AH-574, AH-579) | 作为取消任务的用户，我希望等待和预取真正停止且不串其他会话，从而不会迟到派发或错误加载。 | 实际PTY Escape；new_session；EOF；prefetch cancel | E10, E11, E17, E27, E33, E39, E60：历史基线：v4实际PTY SF1Awi：Tab选择、预算可见、Escape→CLI130/provider0/子进程关闭与重试；RPCabort未取消及new_session/EOF分别保留；Broker7七阶段EOF四host均实际0退出，最后一条后台list无close/metrics回执但两owned PID及所有后代检查均已不存在。本轮最终：本轮所有模型和精确owned进程已闭合；18个已审本地目录移至Trash，完整sessions/prefix另存并复核。旧终端final EOF单条观察缺口仍保留，进程闭合不冒充终端Stop实证。 | 无新增终端cohort；旧final EOF单条观察缺口不被RPC/清理补造。 |
| US27 (AH-581) | 作为生产库维护者，我希望测试有独立owned对象并保留失败证据，从而验收不污染生产或删除历史。 | owned输入/操作/归档；证据不可覆盖；保护核对 | E21, E22, E25, E30, E34, E35, E41, E43, E48, E49, E50, E55, E59, E60, E61, E62：历史基线：原A2父/子unknown、独立accept-current及fence均保留；旧两页原create-op归档，8meta2archivePATCH0body/provider；新owner两次单文件write/readback到完整B，生产Pstack未改。H5/H6 检查点：H5旧失败和unknown/fence不改写。H6单Skill初始11项实际10pass/1fail；此检查点尚未做updated6，不能用初始通过代替B→A后的分支/更新验证。。本轮最终：两原生owned页唯一归档并独立GET true，第三single View删除且census证实缺失；A/B Views刻意保留。18个精确本地目录Trash，旧session/失败/原证据hash保留；CLI1615与Broker恢复时index/工作字节保护有回执。 | 本批owned数据/本地目录清理与生产复核完成；不声称全机/tmp零残留，原unknown和模型失败保留。 |
| US28 (AH-565, AH-575, AH-581) | 作为评估性能的用户，我希望看到请求、字节与分阶段实测耗时，从而不被伪冷缓存或一次样本误导。 | 实际attempt/bytes/queue；五样本分阶段timing | E04, E14, E20, E31, E32, E33, E34, E42, E45, E47, E48, E50, E51, E53, E54, E55, E56, E57, E58, E59, E60, E61：历史基线：HTTP真实attempt/EntityIDs/bytes、n3受控请求优化、n1真实on/off与Mini8成本齐全；并行真实模型原值不作吞吐提升。H5/H6 检查点：H5补证额外11metadata/0body/write/provider、8024请求B/56968响应B、7452.536ms单列。H6A为1冷样本、9provider全200，task-final192378ms；四个后续样本notRun，不报告p95。原失败成本和全部原HTTP保留。 H6单Skill实际21provider全200；181Notion attempts含180HTTP200与1metadata transport failure，0write，70条public metrics完整；不能漏掉失败case成本。。本轮最终：真实运行成本逐cohort保留：H7B9provider200，consumer33Notion+独立collector4metadata；targeted28Notion/2provider，updated116Notion/10provider。census44HTTP全200，raw42metadata+2unclassified关系页，实际current/retained正文/写/provider均0；失败原统计不改。 | A/B各仅原冷样本，后4样本notRun；不报告p95、普遍吞吐或将不同cohort拼成性能矩阵。 |
| US29 (AH-568, AH-570) | 作为维护旧Skill的作者，我希望已有内容由CLI维护，仅必要关系和隐式引用被补正，从而不再手动搬运整套正文。 | CLI维护既有Pstack主文/关系/历史pin | E05, E07, E25, E26, E38, E61, E62：历史基线：生产四主文18目标映射22处链接，57绑定来源/Kind/Enabled/稳定身份census全过；architect原unknown保留且独立接受当前。本轮最终：现有Pstack治理原字节/历史pin证据保留；本轮只复核57精确页和完整关系，没有搬运或刷新上游正文。六文档发布保留AH558/AH560历史suffix全文。 | 原治理与最终metadata复核完成；不新增全量正文迁移。 |
| US30 (AH-581) | 作为未来新Skill套件的使用者，我希望相同合同能作用于Pstack之外的数据，从而系统不靠特例硬编码。 | renamed-identities；Required Router/Prompt异构反例 | E12, E15, E27, E30, E36, E37, E39, E56：历史基线：Broker4独立全名称/ID/库/路径更换和Required异构反例通过；非Pstack3节点6文件Mini8恢复，HTTP会话fixture另证；Broker6非Pstack三节点七阶段实际Pi消费通过；最终Broker7/CLI9同非Pstack三节点七阶段全部通过。本轮最终：原独立更名、更ID与Required Router/Prompt异构反例继续进入最终证据索引；H7修复复用产品解析和immutable身份，没有Pstack特例grammar。 | 原泛化反例范围无新增待项；未另改Matt生产图。 |
| US31 (AH-582) | 作为日用Pi用户，我希望新会话加载实际通过验收的产物，从而交付和测试版本一致。 | 日用Pi安装选择与新会话实际加载 | E18, E21, E26, E28, E38, E46, E47, E48, E49, E53, E54, E55, E57, E60, E62, E63：历史基线：CLI9与Broker8候选包已独立核对；同日用候选路径用于H4 actual SDK及两真实模型显式场景，日用配置仍未激活。H5/H6 检查点：CLI9/Broker8是经独立安装验证的候选；H6A仍未满足资源消费和完整Skill产物。任何H7B/legacy成功都不覆盖A的原失败。。本轮最终：候选产品和harness/文档已按各自source身份交付，但日用保持未激活。H6A真实资源/完整Skill缺口与H7B真实读取/产物缺口均保留；legacy覆盖成功不能覆盖A/B失败。 | AH-582日用新会话终验仍未执行；本轮不切换日用配置、不追加模型cohort。 05 限定勘误操作仍为 unknown，远端措辞纠正待核对。 |
| US32 (AH-579, AH-574) | 作为用户，我希望加载/预取不扩大执行和副作用授权，从而内容引用不会变成隐式操作许可。 | read-only transport；loaded/injection receipt边界 | E09, E16, E17, E27, E28, E33, E37, E39, E42, E47, E48, E51, E53, E54, E55, E56, E57, E59, E60, E61：历史基线：只读transport/prefetch不锁版本不投递，resource loaded:false；真实SDK无shell/旧ntn trap0，预取真实owned0write/provider。H5/H6 检查点：独立补证新增body/write/provider均0；H6A诊断新增HTTP/model均0。原模型只读工具面、scope/owner/snapshot和原HTTP保持，离线纠正没有为模型补读资源或补生成文件。。本轮最终：H7只修已证明的发现/时点和显式文件标签识别；工具允许集合、scope/pin/full hash与执行边界不放宽。模型输出中的PASS模板不算真实执行。census只读路由与独立成本全部保留。 | 原授权边界无新增待项；没有以加载、元数据关系或输出文本取得隐式执行许可。 |
| US33 (AH-567, AH-571) | 作为库管理员，我希望不同内容类型的关系有明确约束，从而不会把Prompt或嵌套路由误当必需指令。 | Members/Requires类型约束；prepare明确拒Prompt/Router Required | E08, E12, E26, E27, E38, E56, E61：历史基线：最终core类型合同与Broker4独立RequiredRouter/Prompt异构拓扑在provider0时拒绝PREPARE_REQUIRED_KIND；更名不影响失败路径。本轮最终：原Members/Requires typed约束与异构反例保留在最终回归；生产57页关系复核不把Prompt或嵌套Router自动改为必读指令。 | 原内容类型约束范围无新增待项。 |

## 证据分层索引

### E01 · 冻结验收基线

层次：**controlled / baseline**。

- "/Users/yoyo/Library/Logs/ntn-skills-verification/skill-graph-ng01-MKWuaO/result.json"

### E02 · 独立安装直连只读与认证

层次：**real Notion / earlier installed package**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-LMsyeE/manifest.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-LMsyeE/identity.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-LMsyeE/read-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-LMsyeE/pinned-resource-read.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-LMsyeE/official-ntn-probe.jsonl"

### E03 · 真实owned写入、附件、回读

层次：**real Notion / earlier installed package**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/manifest.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/08-native-body-write.stdout"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/09-native-field-write.stdout"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/10-native-readback.stdout"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/native-reference-api-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/attachment-final-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/final-controlled-yDW8f1/controlled.log"

### E04 · 多进程共享调度

层次：**real Node / SQLite / controlled HTTP**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng04-root-1793681747067.json"

### E05 · 上游字段保护

层次：**controlled HTTPS / public CLI**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng07/controlled/handoff.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng07/controlled/two-refresh-protection.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng07/controlled/portable-reimport.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng07/controlled/public-cli-http.json"

### E06 · 三类原生链接、资源、旧pin

层次：**real Notion UI / installed CLI5**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng08/ui-native-forms/installed5-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng08/ui-native-forms/archive-native-result.json"

### E07 · 生产Pstack关系及引用治理

层次：**real Notion / exact census**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng09/final-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng09/final-census-WFsuRv/result.json"

### E08 · 统一prepare use/inspect

层次：**core / public Node SQLite**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng12/controlled-o9w_qn2s/handoff.json"

### E09 · 首provider闭包、native链、多根

层次：**installed Pi / controlled provider / Broker v1**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng13/broker-notion-evidence-eoOLkX/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng13/broker-notion-evidence-6Zd0yH/manifest.json"

### E10 · new_session与RPC abort真实边界

层次：**installed Pi RPC / Broker v2**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/broker-notion-evidence-nvKp7N/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng13/broker-notion-evidence-G8Hk1k/manifest.json"

### E11 · 终端选择和Escape Stop

层次：**actual Pi PTY / Broker3 historical and Broker4; Broker5 runtime equivalence**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng15/broker-pi-graph-pty-QFA9Nc/manifest.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng15/broker-pi-graph-pty-SF1Awi/manifest.json"

### E12 · 更名、重ID、异构Required

层次：**installed Pi / controlled provider / Broker v3**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/broker-notion-evidence-Fz7HvR/manifest.json"

### E13 · 实际SessionManager和重启

层次：**actual installed SessionManager / independent Node**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng15/selected-graph-D3WrUx/session-evidence.json"

### E14 · 批量查询和精确失效

层次：**real Node HTTPS / three processes / controlled**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng16/controlled/public-cli-evidence.json"

### E15 · 固定图控制与真实Mini恢复

层次：**controlled CLI + real Pro/physical Mini**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/controlled/handoff.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/controlled/public-cli-evidence.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/producer-a-ready.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/producer-a-save.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/current-b-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/mini-full-verified.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/mini-partial2-verified.json"

### E16 · Broker按需物化接缝

层次：**real Node SQLite adapter + controlled host**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/partial-cli6-adapter.log"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/partial-host-boundaries-final.log"

### E17 · 预算预取与只读限制

层次：**controlled core / SQLite / Broker runtime**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/core-policy-current-contract.log"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/core-policy-deterministic-clock.log"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/sqlite-scheduler.log"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/broker-runtime.log"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/broker-foreground-regression.log"

### E18 · CLI6冻结产物

层次：**installed package identity / before final freeze**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-W7xCCt/package/ntn-skills-0.1.0.tgz"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng15/package-v3/pi-context-broker-0.0.2.tgz"

### E19 · 真实root-only目录与实际注册token

层次：**real Notion + installed Pi metadata / no model**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/gates-setup/gate-a-default-catalog.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/gates-setup/gate-b-default-catalog.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/graph-selection-nHopCs/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/graph-selection-SxmTSw/result.json"

### E20 · SDK观察器五样本与prompt v2冻结

层次：**controlled actual SDK HTTP / no real model**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/graph-observer-http-GGSX54/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/prompt-v2-freeze-q7ckkC/prompt-freeze.json"

### E21 · 原改动保护

层次：**root verified repository byte/index observations**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/cli-protected.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/broker-protected.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/stage2-commit-receipts.json"

### E22 · owned归档与失败保留

层次：**real owned cleanup / no permanent delete**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/owned-cleanup/failed-owned-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng08/ui-native-forms/archive-native-result.json"

### E23 · 原AH560历史15例

层次：**historical real model / old package only**。

- "/Users/yoyo/.local/state/ntn-skills-verification/pi-real-model-cache-_web8gk7/pi-cache-evidence-2givfs/manifest.json"
- "/Users/yoyo/.local/state/ntn-skills-verification/pi-real-model-cache-_web8gk7/pi-cache-evidence-n2TkwW/manifest.json"

### E24 · 生成规程实际执行与反例

层次：**controlled owned project / no real model**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/driver-check-ekEjJ5/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/prompt-v2-freeze-q7ckkC/related-tests.log"

### E25 · 原unknown写入的独立处理

层次：**real Notion / original outcome preserved**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng09/apply-01/architect-body-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng09/apply-01/bodies-result.json"

### E26 · CLI8与Broker完整回归、冻结安装身份

层次：**final CLI8 / earlier Broker4-5 equivalent runtime / complete suites**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/final-checks/cli-final-unit.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/final-checks/cli-final-types.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/broker-full-source-check.log"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-1C3lIQ/manifest.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/broker-v5-n6LhcK/installed-equivalence.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/broker-v4-tyjIGw/adapter-cli7.log"

### E27 · Broker4真实Pi十六图场景与Broker5字节等价

层次：**installed Pi / controlled provider / Broker4 with explicit Broker5 equivalence**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/broker-notion-evidence-l27VCB/pi-skill-graph/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/broker-notion-evidence-s1bZ8E/pi-skill-graph/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/graph-observer-http-V6XkFD/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/final-package-checkpoint.json"

### E28 · Broker6正常三工具、SDK真实传输与缺失资源别名

层次：**actual installed SDK HTTP / controlled provider / Broker6**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v2/graph-observer-http-M4pV6s/result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/native-path-alias/fix-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/broker-v6-ff353lls/installed-identity.json"

### E29 · 当前直连包静态无官方ntn审计

层次：**CLI8/Broker5 package/static audit with explicit historical exceptions**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/no-ntn-audit/final-audit.json"

### E30 · Mini8按需到完整A恢复、六页可恢复归档

层次：**physical Mini / real Notion / final CLI8 / owned cleanup**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/mini-partial8-verified.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/mini-partial8-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/cleanup/result.json"

### E31 · 修正fixture的批量矩阵与实际Notion三节点成本

层次：**controlled n=3 per condition plus real Notion n=1 per condition / CLI7 bytes equal CLI8**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng16/controlled/handoff.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng16/controlled/corrected/comparison.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng16/production-readonly/installed-1793694337009/verification-result.json"

### E32 · 按需物化完整成本回执

层次：**independent public CLI / core binary fixture / physical Mini; wire and content bytes separated**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/lazy-materialization-costs/receipt.json"

### E33 · 预算预取真实owned on/off

层次：**real Notion / isolated CLI7-8-equivalent roots / n=1 per arm**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/retained-prefetch-MnBaye/manifest.json"

### E34 · 原十五例当前真实模型失败与独立A→B回执

层次：**real flash-free / Broker5 / failed samples retained; not final acceptance**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-LZOyAZ/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-X8Dfhw/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-Qe8hg2/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/create-a.result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/apply-b-actual.result.json"

### E35 · 当前版本读取失败与首个Graph Gate失败

层次：**actual public CLI8 failure and actual Broker5 real-model failure; not availability**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/v6-current-b.result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/v6-current-b.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-package/graph-model-A-SQ1pSW/result.json"

### E36 · 无缓存seed的原生HTTPS服务与完整会话链准备

层次：**controlled HTTPS / actual public CLI8 / no Pi completion claim**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng15/native-service-smoke-h4qtur6s/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-ew8UZ7/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-koAXlN/manifest.json"

### E37 · Broker6真实Pi多节点A/B会话完整链

层次：**installed Pi RPC + public CLI8 Node/SQLite + controlled HTTPS/provider; seven stages passed, no cache seed**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-CkKuDu/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-CkKuDu/process-verification.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-CkKuDu/oracle-a.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-CkKuDu/oracle-b.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-CkKuDu/service/http.jsonl"

### E38 · CLI9与Broker7最终运行门

层次：**final source/full package + independently installed Node/SQLite adapter; not real-model task acceptance**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/final-checks/cli9-final-unit.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/final-checks/cli9-final-unit.log"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/final-checks/cli9-final-types.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/final-checks/cli9-final-package.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/broker7-package-check-l63yfjdj/result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/broker7-package-check-after-61e_lus3/result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/broker7-package-check-after-61e_lus3/check.log"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/broker7-node-adapter-7jbjy743/adapter-cli9.log"

### E39 · Broker7/CLI9真实Pi七阶段A/B会话终验

层次：**actual installed Pi RPC + CLI9 public Node/SQLite + controlled HTTPS/provider; 7/7 functional pass, one late EOF list close/metrics gap and all owned PIDs absent**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-5DdQKn/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-5DdQKn/process-verification.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-5DdQKn/oracle-a.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-5DdQKn/oracle-b.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-5DdQKn/service/http.jsonl"

### E40 · CLI9冷logical管理表误识别修复原命令实证

层次：**real Notion / final independently installed CLI9 / original read --refresh without added database; CLI8 failure retained**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-current-b-verified.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-current-b.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-current-b.command.json"

### E41 · Owned A2原unknown与独立当前接受决定

层次：**real public CLI9 write and original-operation review; main accepted_current separately, original parent unresolved and resource still B**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-restore-a2-actual.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-a2-original-current-check.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-a2-accept-current-plan.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-a2-review-markdown-version-correction.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-a2-native-v2-verified.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-a2-accept-current-v2-plan.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-a2-accept-current-v2-actual.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-a2-accept-current-v2-reconcile.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-a2-accepted-current-main.stdout"

### E42 · Broker7原15初始真实模型结果与精确提示诊断

层次：**real flash-free / Broker7 + H3; 1 passed, 2 failed and 8 prerequisite-skipped initial cases; case7 has both invalid URI attempts and one H3 false rejection**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/initial-coverage-result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/failure-diagnosis-v2.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/failure-diagnosis-path-supplement.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/autonomous-actual-system-verified.txt"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/cold-native-command-actual-system-verified.txt"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/autonomous-public-tool-observer.jsonl"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/cold-dollar-result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/cold-native-command-public-tool-observer.jsonl"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/owned-processes.jsonl"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/public-cli-processes.jsonl"

### E43 · 旧fenced owned fixture可恢复归档与新owner完整B

层次：**actual CLI9 Notion writes and readback; old unknown/fence retained, independent new owner create and two single-file writes verified; no aggregate replay**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/retirement-execution-1793701037401/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/create-a-actual.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/owned-record.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/view-a-verified.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/a-content-verified.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/write-b-main-plan.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/write-b-main-actual.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/write-b-main-verified.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/write-b-resource-plan.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/write-b-resource-actual.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/read-b-main.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/read-b-resource.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/b-content-verified.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/fixture-b.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/broker8-baseline-configuration-review.json"

### E44 · H3观察器冻结、大正文实际SDK与历史失败分类

层次：**17 controlled Node tests plus actual installed Broker7 SDK provider; 56,423-byte root and matched wire hashes; H4 revision pending**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v3/freeze.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v3/prior-attempts.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v3/graph-observer-http-RJRIM3/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/legacy-final-harness-ready.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/legacy-final-literal-surface-tests.log"

### E45 · Broker7 H3真实A/B Gates原失败

层次：**real flash-free / Broker7 / H3; original EAGER_MEMBERS and CANDIDATE_IDENTITY outcomes retained, H4 observation corrections pending; no generated procedure execution claimed**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h3/graph-model-A-8Plbzx/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h3/graph-model-B-TPJVgb/result.json"

### E46 · Broker8独立安装身份与下一轮数据配置

层次：**read-only package identity checkpoint; 48 runtime files matched exact tgz; later actual Broker8 H4 SDK/models are recorded separately in E47/E48**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/broker8-installed-identity.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/broker8-config.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/broker8-baseline-configuration-review.json"

### E47 · Broker8 H4共享观察器冻结与实际SDK

层次：**controlled actual installed Broker8/embedded CLI9 SDK; 78 related checks plus legacy20, exact provider wire hashes, host-help separately measured; this is not real-model task acceptance**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v4/freeze.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v4/graph-observer-http-ejGbJE/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/legacy-h4-help-home/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v4/file-extraction/actual-plan-recheck.json"

### E48 · Broker8 H4原15初始实际模型与合法资源alias误拦

层次：**real flash-free, Broker8/CLI9, frozen H4; 2 pass / 1 fail / 8 prerequisite-skipped; read-only diagnosis proves a legal manifest-bound host-index resource was blocked; original failure is retained, no fallback or result rewriting**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-y6izS4/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-y6izS4/initial-coverage-result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/broker8-initial-flash-free.result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v4/host-index-resource-readonly-6s0pddit/result.json"

### E49 · H5单次后续cohort准备与当前完整B

层次：**configuration and existing public-read proof only; no H5 real model or fixture restore started; before B / planned after A, unchanged task, budget, markers, tools and 15+2 assertions**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/b-current-after-h4.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/broker8-h5-config.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v5/fixture-root-resource/verification-result.json"

### E50 · H5真实A/B与单Skill原失败及独立诊断

层次：**real flash-free, Broker8/CLI9, H5; original outcomes and later observation-only diagnoses remain separate**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h5/graph-model-A-G3kOyT/result.json" — SHA-256 f12890a448d51c5ca165cb3947ecf7422b32f1c7ff70c7a873307a72f6a32219，33714 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h5/graph-model-B-ti3uRk/result.json" — SHA-256 f0021abd083c85f5f91f45e73446f31acee8f7520eb5158580a1465317af8940，33660 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-DmSpCQ/manifest.json" — SHA-256 614111303dcfc079892dc58c10735371bb0d59988691cc3cf69634e88c3a44ac，17587 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h5-gate-diagnosis/diagnosis.json" — SHA-256 4af6fbf11d33ccaae569691b6920b28c59687b29671176a06c3b487b1ef20741，98414 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h5-legacy-diagnosis/diagnosis.json" — SHA-256 d15d49f72657d4595f6fdabaf5c976f83edb26d33222ded1d9bc0a3524aba761，17873 bytes。

### E51 · H5独立retained-source归属补证

层次：**independent real metadata only plus pure offline attribution; 11 metadata, no new body/write/provider; original model failures stay failed**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/h5-supplementary-source-proof-BJqcCf/oracle/proof.json" — SHA-256 19da83e92f37b0456dfe91693db9a982250bba8e889917aba950da2a223e273e，66095 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/h5-supplementary-source-proof-BJqcCf/result.json" — SHA-256 78b08005a06fab8145fc1cd02a039d0b5874adf15ae37fbae51288295b33fd1f，16503 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/h5-supplementary-source-proof-BJqcCf/cost.json" — SHA-256 699e3788317e1e13fac7a29b5b89ada1983dfffaf96a84e0bb46e28929939e68，1178 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/h5-supplementary-source-proof-BJqcCf/derivation.json" — SHA-256 ffa2801e61c9c73b5d27daf1666bc36574569017f01adbc5863a6d810b351f5e，17593 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/h5-supplementary-source-proof-BJqcCf/final-observation.json" — SHA-256 f09a01a574a02154dcc1468ddd14381e5d77bfcdb20835421a90cd12f39b51ef，1430 bytes。

### E52 · H6共享观察器88项回归和两个实际SDK

层次：**controlled regression and real installed SDK with controlled provider, not a real-model task pass**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v6/freeze.json" — SHA-256 b4e28f3bdc6720d87ed155dbb28ebec18663263ad14f954b9ed297f1ee85d48c，19801 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v6/graph-observer-http-NGwP8n/result.json" — SHA-256 8926a6532d188828327ebafde54c4c0025352af0953a86ec9b62d2c4ddc50c09，12238 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v6/graph-observer-http-Hgm7jA/result.json" — SHA-256 190567d3c9cbd39e00b5c5b04659d9898d8b548884c0c5008793823b5788bef3，12208 bytes。

### E53 · H6A原失败与选择时点独立派生

层次：**real flash-free H6A remains failed; independent causal attribution changes only false timing classification from 11 to 0, evaluator remains READ_MISSING, artifact plan-only**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h6/graph-model-A-NFvEez/result.json" — SHA-256 edfe1cc6090750cb370ef7738b34cab9685ea4d416e16531ebd855f7fe8b1a46，36568 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h6/graph-matrix-A-DA0j0c/result.json" — SHA-256 bac39ca43554e131d8a5807579c7e78d062ff065466a79aa6b6f618f00a20919，6681 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h6-a-eager-review-JuV3Ra/diagnosis.json" — SHA-256 00d1f71e0f71eb2e14a06695190db4cd886a742f7096ab62c5812205d007f90b，23252 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h6-a-eager-review-JuV3Ra/source-chains.json" — SHA-256 5ebb7e3df2114d620209f21e282fa612f77cacad97af4e935ca71134d10e1f0b，28407 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h6-a-eager-review-JuV3Ra/derived-selection.trace.json" — SHA-256 ad787a08cf4c29ac420eb0fc6c0d1ef57e1301d8951b1213852ae69423bd544f，612399 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h6-a-eager-review-JuV3Ra/power-window.json" — SHA-256 e738419104625bb56862a1f70c6576a470899719c621e4b07e4a6a0dc871b60b，4483 bytes。

### E54 · H6B合法裸owner准备输入的观察器误拦

层次：**real flash-free H6B original READ_MISSING and independent public-contract diagnosis; no target/resource read or complete generated Skill inferred**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h6/graph-model-B-xoGFQs/result.json" — SHA-256 83c43d21316816076bc1d50fb01a2fd68ff6f7efc0a46e72a9f7a93d1c36ec57，32879 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h6/graph-matrix-B-7GTgCn/result.json" — SHA-256 b4ad7959eba59c2c03f01c9590247dcd5e07eaf8b6040d62ac453667ee878971，6697 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h6-gate-diagnosis/b-and-native-location.json" — SHA-256 4d5e3e9d1e0d672eb1473f25dea6caafb6d3264d07ba70a50227b3bc501b6e7e，35315 bytes。

### E55 · H6单Skill初始10pass/1fail与原生主文wrapper误拦

层次：**real flash-free H6 initial11 cases, 10 passed and cold-native-command failed; updated6 not yet observed at this checkpoint, original case numbering retained**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-HEjb03/manifest.json" — SHA-256 bf41b8e2824fce41c9285e536beaf67f540387610f6752ace868f0916ad63a65，55294 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-HEjb03/cold-autonomous-native-result.json" — SHA-256 7a6359b2929bda56690071cfc3694a3afe7548b4429c721843f1818d7e0efe58，3727 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-HEjb03/cold-native-command-result.json" — SHA-256 2fa9d13eb8791c625ed386f405638431b70d3b6c0aa2d50d5e1dd9832fbc9548，1068 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h6-gate-diagnosis/b-and-native-location.json" — SHA-256 4d5e3e9d1e0d672eb1473f25dea6caafb6d3264d07ba70a50227b3bc501b6e7e，35315 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h6-legacy-diagnosis/native-location-failure.json" — SHA-256 d4b308c1e344ee1676055bc6b01a27b7feadbccd2fe6db51c0063f55dd18235b，24293 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h6-legacy-diagnosis/initial-coverage-result.json" — SHA-256 4c0de92c65e1d1006a26670166842798ff586cfb4cf1b00555525e70094de275，56324 bytes。

### E56 · H7三处观察器修复、窄产物识别与最终冻结

层次：**96/96 controlled regressions; two real installed SDK runs with controlled provider, 10 wire pairs each. SDK original aggregate is retained; unchanged project creation/inspection functions bridge the narrow later artifact extractor change. Not a real-model task pass.**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v7/freeze.json" — SHA-256 92c369b047339eb1388cb7081890212e539616d074dada0fdb90427849155cd4，34070 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v7/regression-final.json" — SHA-256 4a0f3ebe681a901bf05ba54cb7315c73c0d7f75ae00558ccf911dea7c8f7d6ab，1931 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v7/graph-observer-http-PUEbMb/result.json" — SHA-256 6cc74e198e2937799ef3cbb7e4a74ddcd49a347d32878118ce975f720586e3fb，14539 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v7/graph-observer-http-wutwR7/result.json" — SHA-256 374023c60ff6be8e36113e0d68e87405539b4ccebae57d8227c3c30097fe7a16，12622 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v7/sdk-project-boundary-final.json" — SHA-256 555926dd0024f767e8943ac8c246932666467a1c57285e3f7c4b0cd6d74c2f51，3124 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v7/independent-observer-review-k0bcKg/review.json" — SHA-256 b3e46098eb1ef546edbdc9c8c16748d8f28ebb28c2e77dfbc922ee15e095e70e，10007 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v7/independent-project-review-t13uPM/review.json" — SHA-256 f1ccf27dd30d521c8b27ed2ff4d2603aa1bfc867f3ea360670d9eead1712c08c，4689 bytes。

### E57 · H7B真实模型最终READ_MISSING与原失败保存

层次：**Real flash-free/Broker8/CLI9/H7, one cold failed and four later samples notRun. Nine provider responses all HTTP200, successful final, no availability/observer/eager failure; missing native target/resource/project reads and incomplete generated files remain real failures.**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h7/graph-model-B-FUJa9C/result.json" — SHA-256 e6ef4f89a2e0f0570c4e09079a88ae9fdd4dee939109bb95f2dabfd93bc87994，34134 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h7/graph-matrix-B-sOq1iM/result.json" — SHA-256 51ccd442d1ae9d77d3afedc3f1fc1112fe390344ed6e53efe68e7164625fb4d1，6714 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h7-b-diagnosis-vmBDYI/diagnosis.json" — SHA-256 293c36c6f0bf188ac4a0ae79a51f43b84391032b2efd91636f1c6c27d8e1c292，70806 bytes。

### E58 · H7原生入口必要复验与11项分层覆盖

层次：**Real H7 cold-native-command targeted 1/1 pass; initial requirement coverage combines ten individually retained H6 successes with one H7 targeted success. The original H6 10-pass/1-fail manifest is unchanged; not a new all-pass cohort.**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-Y9H1QF/manifest.json" — SHA-256 52402219c2d9b81fe9c38117ce50158f10a75ed6e41daa7d51823ffa757b7e72，15450 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-Y9H1QF/cold-native-command-result.json" — SHA-256 e43a48b0526cc3f9a3f8bbcaa825692f61a5dd8529f2c926316ea5c1f2e33eb4，3712 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/broker8-h7-initial-coverage.json" — SHA-256 05248539256372d63569b4259eb26badf30d1a0f6994c6936d997257cdeb2c6b，53786 bytes。

### E59 · 两精确文件B到A、updated6与17项终态分层覆盖

层次：**Two original public file writes with independent readback; H7 updated6 all pass, genuinely resuming the retained H6 autonomous B session while five newer cases use A. Original case labels including -b suffix are preserved; snapshot identity determines actual version. 17 requirement coverage across H6 initial/H7 targeted/H7 updated is not one new matrix.**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/restored-a-content-verified.json" — SHA-256 97160c04b8cd226266d5e117ca4c690a613eaab803af1e1a153ca722e890bb5e，4357 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/fixture-restored-a.json" — SHA-256 dccb856faeeab12023743f56658ba70e4c582e61c315148f05d24eb6e75f0dc0，2714 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-tTddSZ/manifest.json" — SHA-256 a798e564c922c3330da79c4028b4651ccb5f3c1154a0394392997f8d7c37eb13，34180 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/broker8-h7-terminal-receipt.json" — SHA-256 9a5168db218dcd5f448e770523693054793bed89c55fd3e3afdf97cd2d11ec55，137740 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/legacy-h6-h7-session-retention.json" — SHA-256 5783224642d2e4028e2827116f18e45f61e4f182b83a958f1cf5ada8e5b625b5，998107 bytes。

### E60 · 两owned页、第三临时View、18个精确目录清理与原改动保护

层次：**Two exact original-create pages archived once and independently retrieved in_trash; third single View deleted through actual UI and confirmed by final census. Eighteen scoped local directories moved to Trash; sessions/prefixes and original failures retained. Deliberate A/B Views remain, and no global /tmp-clean claim is made.**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/cleanup-h7-complete.json" — SHA-256 881d2b064ebd302c4824bf0a7fb3a16a2258769080b30f8372513971186bcc07，4285 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/cleanup-h7-audit.json" — SHA-256 b52f5873cd27ca28a8bc7706d74ed9acc8b06a1a32fb58f68fa7674fa6a852b5，20173 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/legacy-h6-h7-scratch-trash-complete.json" — SHA-256 6b9933e3276ddd56b9568a8ce0dde5c3e9a8140a3c1ad38fb79462ed1ee21c02，4204 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h7-b-diagnosis-vmBDYI/cleanup-execution-6CsYI1/result.json" — SHA-256 83c81a2fccf470853bb42b4528453d303b5c358e737a5d4735487ca14eb16ee2，1607 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/closed-graph-scratch-plan-KMtlaO/execution-tPpHCO/result.json" — SHA-256 f257743d7345f2ef7c74b92186f00f6d1274c0711de3e30c0805bd4cdbca0f67，4060 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/single-view-cleanup-ntWJId/after-ui.json" — SHA-256 8aa3f4a5e93898fed2f32a9808517a37661a2300fcbda976fea386a49b56f651，23376 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/final-protection-FnM8Ik/result.json" — SHA-256 f65217b64962a26957db42f41fd7ede6f7d41439ec52aa9026accad1991aa792，2028 bytes。

### E61 · 最终生产metadata census与独立语义结论

层次：**First phase freezes complete schemas/Skills/Files/Sources/catalog; one separately authorized narrow continuation reads only missing relation/View/cleanup metadata. Raw 42 metadata + 2 unclassified_body counters and both original non-pass statuses are preserved. Two relation responses contain only property IDs/pagination; 48 rotated attachment signing fields are independently normalized only after stable object identity/all non-signing fields match. No new body-content proof, write, Records scan or model request.**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/final-production-census-preparation/plan.json" — SHA-256 b9c045899842d62e8f2880dd8bcc54299f828e8e168c0dab05d34896b5e05f9d，10532 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/final-production-census-43ef191a/result.json" — SHA-256 b1cbcea81523b2bd6134f6ebb1bde217c18881d1a342f61d76f58334c197bf5a，51979 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/final-production-census-runner-k2YR4v/launcher-result.json" — SHA-256 bcf69eee4199e92e63e24a96cc1ad86f6ac0d4afa7fabf0932dfe758da4f9603，1158 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/final-census-continuation-9e5d4b00/result.json" — SHA-256 4818b5828c1cf897322cd7d34880f6816c8148765f68dc11a618f75e8f7e860f，286589 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/final-census-continuation-runner-61Mz8b/launcher-result.json" — SHA-256 fdc7f3f1221a2ae3b4108155e7a4ead1573fa776d273abc83a997cd782526bae，1179 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/final-census-conclusion-JkSnne/result.json" — SHA-256 7f55c7120a7b75aa9f8bb5291fec26eac5316006e5f68dbb66a28dec6cfcaf39，51904 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/final-census-conclusion-JkSnne/receipt.json" — SHA-256 7cdc8620ef173e72682108816debcd897cce2d695340a8baa62a959ba6aa1dd0，630 bytes。

### E62 · 六文档实际发布、5页逐字读回与05页独立接受3项转义

层次：**Six unique pages independently read through installed CLI9; five byte-exact to final candidates, page 05 matches only the explicitly reviewed three-escape Markdown serialization and remains byteExact=false to its original candidate. Two complete AH-558/AH-560 historical suffixes unchanged. Seven page updates have Success responses and zero page dispatches are unresolved. Original strict failures and incomplete first-publisher HTTP totals remain preserved; this is documentation delivery, not A/B task acceptance.**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication-complete-TCdBv3/result.json" — SHA-256 0b6b59f9e980ec677f30c52679862331b13103b1afcee9413ab278a601ad84bf，10553 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication/independent-cli9-readback-VEUfV9/result.json" — SHA-256 354cb080c95dee3953bbed9e548eeb8c5d89826357034e32f2532ca0846f8fa5，27021 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication/accepted-current-serialization-1793717247785.json" — SHA-256 3dfc6a08236b0c0af789944da8b6bab6a4126b1230aa7721a8a493b86d2a3628，1963 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication/plans-final-1793716191920.json" — SHA-256 994fc9782a4a28004ed444a7bf5340b28f763652d89b5a343bcc19b84638b6b2，2985 bytes。

### E63 · Notion05限定勘误结果未知与独立基线读回

层次：**One explicit subsequent wording-correction PATCH returned WRITE_OUTCOME_UNKNOWN. Independent CLI9 metadata/body GETs observed the original f5 baseline; they do not establish that the unknown write was undispatched or not applied. Remote correction is not confirmed, no replay or accept-current occurred. E62 remains the earlier six-page cutoff with seven known-successful updates and zero unresolved dispatches; this subsequent operation adds one unresolved outcome. No model task or acceptance requirement changed.**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication-resource-erratum-JnpptS/terminal-receipt.json" — SHA-256 dd5a569e87867666ec84c947bc769f237e1f8fecac6d9c601df82e50943d8d87，4578 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication-resource-erratum-JnpptS/response.json" — SHA-256 85a76fcac1ad398740943651a966150a0ad83fae7913e53ef1a11a0235778717，405 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication-resource-erratum-JnpptS/failure-1793718495515.json" — SHA-256 49da8326d45819abddecdd1f4c94ad925ce77d1360842aac7a69429c7142e0d6，1220 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication-resource-erratum-JnpptS/plan.json" — SHA-256 5a117e49c3ab075d9d86fe5ff3fb6f92957eab61fbc8ecffd39ae0e18f3d8ed3，169909 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication-resource-erratum-JnpptS/independent-cli9-readback-SlZ4gH/result.json" — SHA-256 61e00375830e8f8b8e8307b39d65b14a4e8a15edd679eb241f744b98263f3c93，4205 bytes。
