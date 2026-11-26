# 自然旅程的准备、运行与证据

## 目录

- 空父页首次使用
- 输入与对象准备
- 当前候选配置
- 事件和私有判定
- 读回与清理
- 覆盖与结果边界

## 空父页首次使用

`native-onboarding` 只接受授权的空父页，区别于下面基于已有 library 的 daily/no-native-skills。不调用 prepareAgentFixtures，不预置库、维护 Skill、Store、缓存或日用配置。公开资料来自实际安装候选的 README、CLI help 和 bootstrap。业务 oracle 留在控制端；主体的 public-input.json 只保存父页、README 身份、原始自然任务和预算。

先用当前 `next` 的任务独占 pair 构建实际归档并干净安装。两仓代码、archive 和安装依赖均由 paired-environment 冻结：

```sh
node scripts/paired-environment.mjs build --root /absolute/owned/pair \
  --id onboarding-packed --install-mode packed
```

准备一个私有 bindings.json。`parent.url` 和 `readme.path` 由所选候选填入，不能给模型私有判据或逐步命令答案：

```json
{
  "version": 1,
  "public": {
    "business.goal": "创建名为 travel-policy 的技能。主文写明交通支出需要保留票据，并附 references/rules.md 说明票据需要日期和金额；再用它检查一张只有金额的车票。"
  },
  "private": {
    "objects": {}, "bodies": {}, "facts": {},
    "readbacks": { "onboarding": {} }
  }
}
```

另存 oracle.json。每个预期 Skill 要列出完整文件集合，至少含 SKILL.md；每个文件声明 `contains` 或精确 `sha256`。`contains` 用于业务文字约束，不代替完整读回。二进制或原件转存用 sha256。业务目标包含实际使用回答时，再声明 `output.contains`，比对原始有效 session 中的最终回答；正文读回和回答判据分别保存，正确回答不抵消缺文件或无效运行。是否允许额外 Skill 必须显式选择：

```json
{
  "version": 1,
  "allowAdditionalSkills": true,
  "output": { "contains": ["日期"] },
  "skills": [{
    "name": "travel-policy",
    "files": [
      { "path": "SKILL.md", "contains": ["票据"] },
      { "path": "references/rules.md", "contains": ["日期", "金额"] }
    ]
  }]
}
```

场景仍是 scripts/notion-agent-scenarios.json 的 `onboarding-empty-parent`，通过同一公开 candidate 入口运行。以下路径和 UUID 都须换成本轮实际输入；modelsFile 使用显式环境变量引用，不复制日用认证文件，不写入凭据值。

```json
{
  "version": 1,
  "scope": "notion-agent-workflow",
  "profile": "native-onboarding",
  "scenarioFile": "/absolute/owned/pair/broker/scripts/notion-agent-scenarios.json",
  "scenarioId": "onboarding-empty-parent",
  "bindingsFile": "/absolute/owned/bindings.json",
  "pairedEnvironment": { "root": "/absolute/owned/pair", "build": "onboarding-packed" },
  "parent": "11111111-2222-3333-4444-555555555555",
  "modelsFile": "/absolute/owned/models.json",
  "passEnv": ["NOTION_API_TOKEN", "MAGPIE_API_KEY"],
  "evidenceRoot": "/absolute/owned/onboarding-evidence",
  "oracleFile": "/absolute/owned/oracle.json",
  "model": "magpie/group/worker",
  "thinkingLevel": "high",
  "timeoutMs": 1800000
}
```

```sh
node scripts/verify-pi-daily-installation.mjs candidate-plan --config /absolute/owned/onboarding.json
node scripts/verify-pi-daily-installation.mjs candidate-run --config /absolute/owned/onboarding.json --live
```

从选定 build 的 `source/broker` 执行上述入口，可直接使用该 generation 的私有依赖。candidate-plan 只检查输入。candidate-run 自动创建本轮空 native Skills 目录，并以 `--pi-mode native --native-skills` 启动单个 private command run。脚本在首次请求前以只读 API 核父页为空；随后用原生 RPC helper 保持同一 Pi session，所有模型轮次与 CLI 使用相同 run 的声明。保存 `run.json`、`pi-launch.json`、`loaded.jsonl`、原始 session、RPC frames、provider payload/transport 和 CLI 进程记录。

独立 grader 只接受原始 tool-result 中真实返回的唯一 v2 Library root。它通过另一个 fresh paired run 的 `--library ROOT_UUID` 启动，先执行公开 `ctl library init --library ROOT_UUID` 和 `ctl library inspect --library ROOT_UUID` 验证四表/schema 并交叉核对 episode 的完整 descriptor；`reused` 必须为 true。随后独立 GET 实际根页面、四个 DB 和四个 data source：root.parent 必须是授权外层父页，DB 必须直属该 root，DS 必须直属注册 DB。这些事实保存在 `library-placement.json`，不能从 descriptor 反推。Ready descriptor 没有 `parent_page_id`。

list 必须报告 `explicit_library`、精确 `library_id`、穷尽覆盖、无失败 source 和完整分页，逐个 Skill 完整读取主文和支持文件，包括二进制、空文件和长文本。消费目录内额外 Skill 也完整保留读回。新的 `init --parent` 会创建另一张独立根页面；原初始化有未知结果时保留原 operation 对账，不能以再跑 init 代替恢复。

主正文要求从第一行到 total_lines 的完整范围，并与 snapshot manifest 的字节数和 SHA-256 一致。files 只接受当前 `files` 字段及完整 manifest，目录必须与 file_bindings 一致；出现未读完的分页即失败。支持文件的 `read --output` 采用当前完整字节合同，核对 owner、path、固定 snapshot/version/file ref、output 路径、字节数与 SHA-256，再对实际落盘内容复核。缺失字段不能降级成完整成功。oracle 不传给主体或 grader，控制端在完整读回之后比较内容。

内部 fresh grader 输入固定为 `{version: 1, libraryId, parent, library}`，其中 library 是该 episode 原始 tool-result 的 descriptor，不是预期答案。现役 adapter 将此输入交给 paired `--target command --pi-mode native --native-skills EMPTY --library ROOT_UUID`，在当次 `PAIRED_BROKER_SOURCE` 调用 `runOnboardingGrader(inputPath)`；它使用同一 build 的实际 `PAIRED_CLI_ENTRY`，不继承 episode 的 config/state/cache/data/scheduler/session。原始 CLI 输出保存在新 run 的 readback-commands，完整文件保存在 readback-files，四表身份和完整性结论保存在 readback.json。

`result.json` 分开报告 `process`、`validity`、`episodeStatus`、`business` 和 `hardContracts`。模型任务退出零但 runtime drift/unknown，仍是 invalid；若已取得 Library root，仍执行只读对账并保留独立业务结果。无法取得唯一 Library root 或 grader 不完整时标 `unknown_reconcile_before_retry`，保留父页、Store、session 和原始输出供人工对账，不重复初始化或执行外部修补。此模式不声称 API 权限沙箱、请求前 Benchmark 握手或每日安装通过。

有限接线检查使用 `node --test scripts/notion-agent-onboarding.test.mjs scripts/notion-agent-scenarios.test.mjs scripts/paired-environment.test.mjs`。fixture、受控 provider、plan 和帮助输出不计作真模型 onboarding 通过。真实使用与独立 Skill 评价未执行时各标 not_run。

## 输入与对象准备

以下适用于 daily/no-native-skills。在 Broker 根目录工作。只使用当前配对 CLI/SDK 构建和正常 Pi 环境；确认凭据已通过正常环境提供。命令与日志不输出 token。准备阶段和被测 Pi 使用独立状态，不能复制 oracle 到被测缓存。

准备器将 CLI config/state/cache/data 和 request scheduler 绑定到 fixture 自有根；被测 Pi 使用另一个本轮 state 根及 scheduler。`NTN_SKILLS_HOME` 不会改变 scheduler 的默认位置，必须同时设置 `NTN_SKILLS_SCHEDULER_ROOT`。运行初态回执记录实际 scheduler 路径，正常用户 scheduler 不作为 fixture 或模型验收的共享账本。

正常 `pi` 可以是保留的 shell launcher。运行器先启动该入口，再用现役进程 observer 核对 owned PID、父进程、参数、实际 Pi package bin、manifest 和 Node；Jiti 只从已观察的 Pi entry 加载。每个重启段都保留 launcher、真实进程和 loader 的身份，并在自然退出后核对终态；不从 launcher 的文本或所在目录猜依赖路径。

先读取 [loader](../../../../scripts/notion-agent-scenarios.mjs) 导出的选择函数，按场景 ID 选择；不要把完整语料发给被测模型。对象准备复用 scripts/notion-agent-fixtures.mjs：

    prepareAgentFixtures({
      recipe,                 // corpus.fixtures[scenario.fixture]
      runId,                  // 唯一本轮名称，仅字母、数字、下划线、短横线
      root,                   // 本轮全新、尚不存在的绝对目录
      libraryId,              // 当前 Library 根页面的 canonical UUID
      cli,                    // 当前配对的 dist/ntn-skills.js 绝对路径
      node,                   // 实际 Node，可省略而沿用 process.execPath
      globalSkillsRoot        // 可省略而用真实 ~/.agents/skills
    })

返回 bindings，并同时保存 root/bindings.json。libraryId 是 Library 根页面；cli 是实际可执行文件。准备只通过公共管理命令写自有测试对象。builtin 只读取当前库里的精确既有对象，其 ownership 为 external，不能清理。

fixture 包含有限 kind、对象/版本/完整文件树、公开业务材料、私有事实、读回声明和环境前提。global 使用真实全局目录，project 使用本轮项目；notion 创建原生对象，source 从固定 Git 声明取得完整树，builtin 只读绑定现有维护说明。Source/builtin 的空 files 代表等待真实读取产生完整原件，不能当成已验证的空树。

同名对象保持相同展示名与本轮后缀，不按 alias 各造不同名称绕开冲突。普通同名负例的 Notion 对象默认目录可见；Enabled 与 Default Context 专项按语料四种组合设置。公开字符串只含对象 name/url/path 或 business.* 材料，私有 objects/bodies/facts/readbacks 不进入 prompt。

下面的准备输入由实际安装信息填写。示例绝对路径与库 ID 是占位；缺任何真实输入时先补齐，不能运行占位取得成绩。

    {
      "runId": "workflow-unique-run",
      "scenarioId": "mixed-explicit-global",
      "profile": "daily",
      "scenarioFile": "/absolute/broker/scripts/notion-agent-scenarios.json",
      "fixtureRoot": "/absolute/owned/new-fixture",
      "configPath": "/absolute/owned/new-workflow.json",
      "evidenceRoot": "/absolute/owned/evidence",
      "brokerRoot": "/absolute/broker/packages/context-broker",
      "cliRoot": "/absolute/cli/packages/cli",
      "sourceId": "notion",
      "library": "REPLACE_WITH_CANONICAL_LIBRARY_ROOT_UUID",
      "packageIndex": 0
    }

从正常 settings 的 packages 中核对实际 Broker 注册位置，packageIndex 从零开始；不能复制示例值。candidate-plan 校验本次语料、绑定和合同映射；candidate-run 在启动 Pi 前自动验证所选 CLI/SDK 与 embedded bundle 的版本、能力和字节，并记录源码身份。候选运行无需自行 import 内部预检函数，也不需要执行双机安装交付；只有独立包诊断或安装交付另走 [integration Skill](../../verify-notion-skills-integration/SKILL.md)。

可在 Broker 根目录直接调用模块准备单个场景。这是现役运行器的输入准备，不是另一个执行入口：

    node --input-type=module - /absolute/owned/preparation-input.json <<'JS'
    import { readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { loadAgentCorpus, selectAgentScenarios, checkAgentContractCoverage } from './scripts/notion-agent-scenarios.mjs';
    import { prepareAgentFixtures } from './scripts/notion-agent-fixtures.mjs';
    const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const corpus = await loadAgentCorpus(input.scenarioFile);
    const [scenario] = selectAgentScenarios(corpus, { ids: [input.scenarioId] });
    const index = JSON.parse(await readFile(join(input.cliRoot, '../../verification/skill-domains.json'), 'utf8'));
    checkAgentContractCoverage({ ...corpus, scenarios: [scenario] }, index);
    if (!scenario.profiles.includes(input.profile)) throw new Error('Scenario/profile precondition does not hold');
    await prepareAgentFixtures({
      recipe: corpus.fixtures[scenario.fixture], runId: input.runId,
      root: input.fixtureRoot, libraryId: input.library,
      cli: join(input.cliRoot, 'dist/ntn-skills.js'),
    });
    const config = {
      version: 1, scope: 'notion-agent-workflow',
      scenarioFile: input.scenarioFile, scenarioId: input.scenarioId, profile: input.profile,
      bindingsFile: join(input.fixtureRoot, 'bindings.json'),
      brokerRoot: input.brokerRoot, cliRoot: input.cliRoot,
      sourceId: input.sourceId, library: input.library, packageIndex: input.packageIndex,
      evidenceRoot: input.evidenceRoot,
      model: 'magpie/group/worker', thinkingLevel: 'high',
    };
    await writeFile(input.configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ configPath: input.configPath, bindingsFile: config.bindingsFile }));
    JS

每个 scenario/profile 准备独立状态与对象，避免前一臂修改、预热或删掉后一臂初态。只需要当前切片时不要创建全语料的 Notion 对象。保留准备回执及失败；部分准备失败不能归为 Agent 选路失败。

## 当前候选配置

公开入口仍是 scripts/verify-pi-daily-installation.mjs 的 candidate-plan 与 candidate-run --live。自然配置只接受以下字段：

| 字段 | 含义 |
| --- | --- |
| version / scope | 1 / notion-agent-workflow |
| scenarioFile / scenarioId / profile | 校验后的长期语料、选中 case、daily 或 no-native-skills |
| bindingsFile | 本轮真实 fixture 绑定 JSON |
| brokerRoot / cliRoot | 当前 next checkout 的 packages/context-broker 与 packages/cli；CLI checkout 提供同一份 verification 索引，不用任意同版本 npm 副本代替 |
| sourceId / library / packageIndex | 正常配置中所选 Notion source、canonical Library root UUID 与真实 Broker 注册位置 |
| additionalLibrary | 仅 `library-journey` 使用 `{sourceId, library}`，明确声明唯一第二根；其他场景仍拒绝额外 enabled Notion Source |
| evidenceRoot | 本轮自有原始结果根 |
| model / thinkingLevel | magpie/group/worker / high |
| timeoutMs / catalogTimeoutMs | 可选有界等待预算；每轮默认 30 分钟，目录默认 90 秒，实际值写入计划。公开管理命令自身可等待 10 分钟，每轮须额外容纳检查、读回和模型响应；不能无限重试 |
| viewId | 可选的本轮真实 View 绑定；filtered-view 不能用假返回值代替 |
| retestOf | 可选，关联保留的首次失败原件 |

cwd 来自 bindings.private.fixture.projectRoot；ownership 来自 fixtureRoot/ownership.json，不由调用者随意声明。不要把 token、正确答案、期望工具调用或私有字段塞入 prompt、system prompt、context 文件或模型环境提示。

运行器在本轮私有 CLI config 写入 `default_library: config.library`，供普通输入接纳时固定 Library；不能把唯一 Source 当成隐式默认，也不改用户的全局 config。SDK `library` 解析是只读选库观察，按真实请求计数，不算正文读取。

## 双库自然旅程

用同一已授权 token 准备两套真实根 A/B。正例必须分别实际 inspect、写入及完整读回；403、只读权限或一个库不存在不能证明跨库隔离。继续用 `prepareAgentFixtures`，在既有参数之外传 `libraries:{A:ROOT_A,B:ROOT_B}`，且 `libraryId:ROOT_A`。当前三份配方是 `library-management`、`library-references`、`library-original-operation`，每个对象声明 `library:A/B`；`identityKey` 只让跨库对象共享稳定 Skill ID，同库重复身份会在任何写入前拒绝。

运行配置保持 `library:ROOT_A`，加 `additionalLibrary:{sourceId:"notion-library-b",library:ROOT_B}`。第二 Source 仅存在于本轮私有配置，使用独立缓存目录；正常全局配置与默认库不改变。保留 normal HOME、普通 Pi、扩展和 MCP。三个 journey 分别使用独立对象和 Store，顺序运行以免同 token 的独立调度器互相制造 429。

| 场景 | 实际证明 |
| --- | --- |
| `library-b-management-consumption` | 先采用 A；通过公开 Broker 命令选 B 后继续 A pin；Agent 更新 B 的同名同 ID 对象并采用 B，真实 restart/resume 保留结果；A 的正文、完整子项及 metadata 独立前后核对 |
| `library-cross-references` | B 正文短引用绑定 B；B 的完整 A 链接进入 A 正文后，其短引用仍绑定 A；两个目标的 Skill ID、资源路径相同而字节不同。原 A 当前对象真实移除后的负例单列，不称为 Library 权限拒绝 |
| `library-agent-original-resume` | 公开 writer 在 Agent 当次原 Store 中受请求预算中断；Agent 从原 stdout 日志和声明自行续接同一次操作；独立读取原 operation、原 Record 退役、Source 就绪与完整文件，并核对实际 CLI 参数指纹 |

`library-select` 通过真实 `/context-broker library ROOT` 执行，单独保存控制事件回执；只有同一 active branch 上 requested→ready 完成才提交下一自然输入。它不计作模型理解或业务完成。启动/恢复屏障读取实际活跃分支，不能固定等待初始 A 的目录。

`interrupt-agent-source-write` 只负责制造原始中断。失败文件保留原 CLI stdout 字节，prompt 不填 operation ID、resume flag 或恢复命令。验证器只读核对原 Library、声明及 input fingerprint、原 Store 文件身份和 CLI 字节，并要求观察到 Agent 成功执行一次精确原 intent 的 public resume。不能用原有 `resume-source-write` 控制事件替代这项证明。失败证据和未决 Store 保留，禁止复制状态到新 Store 后宣称恢复成功。

正文中的 `{{object.ref}}`、`{{object.shortRef}}` 只在 fixture 文件准备时由所选 CLI 的实际 ref 协议生成，不进入公开 prompt bindings。业务输入只给名称、根页面 URL、原声明或失败日志路径。三条自然成绩与控制端接线测试、真实 installed SDK/Pi、live CLI、形式化模型分开报告。

准备函数同时创建 ownership.temporaryRoot，固定为 fixtureRoot/temporary。运行器只接受这一本轮目录作为 TMPDIR，拒绝外部路径或符号链接。它在全新自有项目写入简短 AGENTS.md，说明临时文件位置、shell 显式模板与精确输入保留约定；已有原生项目说明则拒绝覆盖。initial-state.json 与 result.configuration 记录路径、说明文件哈希和这项计划内环境差异。

Node 等遵守 TMPDIR 的临时文件 API 会使用这个目录。macOS 裸 mktemp -d 可能忽略 TMPDIR，因此原生项目说明要求 shell 使用显式模板 `mktemp -d "${TMPDIR%/}/work.XXXXXX"`。这只是临时材料约定，不是文件系统沙箱；硬编码其他路径仍可能越界，不能据 TMPDIR 声称全部文件已收口。不改 PATH，不加载验证 Skill 或 oracle，不改变业务 prompt。正常 HOME、全局 Skill 与扩展发现保持原样，不扫描系统临时目录推测所有权。

默认维护、Source 同步及明确离线检查安装包的场景，按私有正文断言绑定 `paired-maintain@A/SKILL.md` 或 `paired-sync@A/SKILL.md`：原件来自本轮 Broker 的实际配对包，并在观测目录冻结。绑定只用于核对真实 native read 和 provider 请求，不预加载正文；旧全局包的目录存在不能证明它属于当前候选。默认咨询 fixture 不创建官方 Notion 副本，也不以远端查找作为前置步骤。`connected-maintenance-filtered-view` 的用户明确指定 Notion 团队流程，继续验证 View 外发现与精确来源读取；不能把它改成默认产品指导场景。

daily 正常加载全局与项目 native Skills、其他扩展/MCP；no-native-skills 只关闭默认 native 发现，仍需如实记录 Broker local 与可读路径。正式请求和响应必须证明实际 worker 路由；模型配置标签、RPC success 和进程退出零均不足以通过。

## 事件和私有判定

每轮只含 id、自然 prompt、可选 before 与 expect。prompt 仅展开双花括号中的公开字符串。binder 校验键；未来出版版本的真实 scope/snapshot/version 在事件完成后才绑定。bindAgentTurn 每轮使用当时的真实状态，不将逻辑 A/B 标签当成真实哈希。

有限事件由 validateAgentEvent 校验：发布指定版本、调整启停、删除自有对象、独立读回、删除/恢复阅读投影、真实 Source writer 预算中断及原 operation 恢复，以及真实 restart/fork/compact 和自有故障。事件必须由真实命令或 RPC 完成，有独立读回屏障。任意 shell、未知字段、通用循环、动态生成的用户救援都不属于事件。

fork 从指定先前用户 turn 之前分叉；保留此前有效分支。compact 使用真正的公开操作，不手写 JSONL 或替换成新空会话。失败注入只能操作自有 Store/对象；必须保留发生事实及恢复范围。Source applying 旅程从尚不存在的自有 Source 开始：公开 writer 在真实请求预算内中断，独立确认相同 Operation 和 applying 后才提交模型请求；随后用同一声明与 operation 恢复并读回完整 A。它不宣称旧 pin 或 A→B 行为，也不能靠手工写状态伪造中断。

私有 expect 使用有限 kind：

| 类别 | 判定内容 |
| --- | --- |
| completed | 请求实际发送、provider 完成、非空有效响应 |
| candidate-cli | 当前轮真实执行配对 CLI；以子进程入口、文件字节和父子关系核验，命令文本与已构建文件不能替代执行 |
| single-projection-restore | 当前轮只有一次公开投影恢复命令且自然退出 0；失败后另启恢复、额外投影写入均失败。帮助与已知只读命令另计；未知命令形态保持 blocked，恢复内容仍须独立业务读回 |
| visibility | 精确 native-discovery、当前 model-catalog 或真实 source-pending 时序 |
| metadata-lookup | 点名查询的原始工具结果和实际 provider 投递；同会话外部启用还核首轮完整未命中、原 TTL 未到、独立事件、真实元数据 HTTP 与固定选择不变 |
| content-search | 生产 CLI 独立读回的正文专属检索词、实际内容模式调用、当前源与 Skill／File 归属、原始工具结果及 provider 投递；全程 roots、固定 bindings、Requires locks 与 active sources 不变。非穷尽结果和空结果均不能证明不存在 |
| tool-attempts | 指定工具真实尝试的上下界，失败与撤回也计入 |
| forbidden-tool-input | 实际工具参数不得触及声明的安装包路径或命令；失败尝试也计，不能按同名目录误伤合法 Notion Git 缓存 |
| source-network-attempts | 完整 source 观测中的实际 Notion HTTP 尝试；未知 CLI 子进程流量保持 blocked，不能以语义写为零推断没有联网 |
| source-operation-attempts | 完整 SDK 生命周期中指定操作的尝试数，含失败和取消；用于证明元数据旅程没有 content-search。它不是 HTTP 次数 |
| body / resource | 当前请求中的完整主文/资源及精确归属 |
| selection / selection-any | 指定逻辑对象/版本或明确允许的等价集合 |
| output / clarification | 必要业务事实、禁止事实或预写澄清主题，不比较整段标准答案 |
| no-semantic-writes | 普通消费无语义写，不能凭缺日志推零 |
| business-readback | 真正独立读回的对象、版本、元数据、保护内容或投影状态 |

目录 pending 与 unauthorized 是明确的场景前提。pending 需要首请求与真实后台目录完成时间交叉证据；source 已 ready 的样本不计作 pending。unauthorized 使用本轮故障环境，不能关闭 source 再将“零误用”算通过。显式 offline 单独记账；filtered-view 必须来自真实视图，缺能力保持明确失败/阻断。

### 正文检索与独立授权准备

`discovery-content-body` 与 `holdout-discovery-content-file` 沿同一 candidate-plan／candidate-run 入口运行。前者的词组只位于主文，后者使用不同业务材料和附属 Markdown 表格。配方由既有 `prepareAgentFixtures` 调用冻结的公开 CLI 创建并读回。分析器再核读回原件的 name、description、owner、物理 Skill／File 和正文哈希；不能用事先写入的假 metadata 或命中记录替代。私有 expect、匹配对象和正文判据只供控制器使用，prompt 只展开用户公开给出的检索词，不提供工具名、参数或预期命中身份。

仅配方显式声明 `environment.mcpAuthorization: "cli-login"` 且场景包含 content-search 判定时，现役 runner 才在新建的本轮私有状态中执行冻结 CLI 的 `auth mcp login --no-browser`，最多等待五分钟。授权地址保留于本轮 `mcp-authorization/login.stderr`，由操作者在已登录浏览器完成；随后用 `auth mcp status` 独立读回相同 connection 和 grant epoch。该步骤在 Pi 启动前完成，保留单独的 controller setup receipt，不计入模型旅程，不读或复制凭据文件，也不向 RPC 传入授权 presenter。失败、取消或超时会保留原件并终止本次运行，不能预先声称 Agent 内容检索通过。

需要标准环境代理时，用 `node --use-env-proxy` 启动 candidate runner，或明确设置 `NODE_USE_ENV_PROXY=1`。runner 将自身的显式代理选择传给私有 CLI 和 Pi；只有 HTTP(S)_PROXY 变量不足以证明 Node 已启用代理。

`discovery-metadata-without-content` 不声明授权准备，并核实际 content-search SDK 调用为零。正文调用的 REST 指标不包含 MCP 或 OAuth HTTP，相关总量保留 `null`，即使 REST trace 完整或为空也不能填零。正文证明只支持远程发现、归属和当前选择未变；实际固定正文投递、完整网络次数和远程索引的精确匹配语义另需证据。

pending 的控制端只等到真实目录操作开始就提交自然输入，不等待目录完成，也不额外调用 list。最终仍核首个真实模型请求处在该操作完成之前。若窗口已结束，记录时序前提未达成；不得伪造 pending 或把该样本当作产品失败。启动期间的泛化 pending 提示不能单独证明某个 Source 的排队状态。

输出必要事实来自业务规则。例如报销金额格式是被测 Skill 自身的业务约定；私有判据只检查关键金额，不把完整答案给模型。语义等价选择不能掩盖用户明确指定的来源或管理对象。

### 已有会话中新启用的 Skill

`discovery-enabled-in-existing-session` 与对应 `holdout-` 场景保持同一 Pi 进程和 session，
两轮只询问同名 Skill 是否可用及用途。外层控制器在两轮之间用既有 `set-enabled`
事件启用自有目标并独立读回；自然输入不提示刚启用、刷新或工具。准备器与被测 Pi
使用独立状态，控制端的公共 CLI 写入不经过被测会话的工具事件。

fixture 的 `visible` 是自有过滤 View 的唯一成员，`target` 初始 Disabled、Default Context
关闭；启用后仍不在默认 View。不能仅凭 Default Context=false 声称 View 已排除目标。
两轮都须由 Agent 自主选择带 refresh:true 的点名查询。第一轮必须有完整目录查询的空结果；
这只证明当前可用目录未命中，不证明远端页面不存在。
第二轮的 `metadata-lookup.afterTurn` 从前一轮分析原件核对同一会话、进程和原始分支，
并按前次返回的 age/max_age 与实际单调时钟证明 TTL 尚未到期。若时间窗口已过，
记录时序前提未达成，不将其算作强制刷新成功。

命中还须将实际工具文本关联到真实 provider 请求，用当次短引用表核对独立 owner/scope，
并观察外部事件完成后的新验证时间与真实 SDK 元数据 HTTP。单有 refresh 参数或最后一句
正确答案均不足以通过。两轮只作元数据发现，不采用或暴露目标正文；刷新前后的任务选择
保持一致。本场景没有预先采用其他 Skill，已有完整 root/Requires 的保护另由对应状态回归验证。

## 当前模型与工具证据

daily 和 no-native-skills 使用正常模型的实际 API 配置，包含模型级覆盖。当前自然观察器支持 Node Undici 上的 `openai-completions` 和 `openai-responses`，分别关联精确的 POST 路径。相同 origin 上的 MCP 请求独立计数。原始 payload 的字节、hash 与正文 oracle 保持原样；Responses 的 `input`、`reasoning.effort` 和 `function_call_output` 只在语义校验时投影。工具结果必须通过同一 payload 中更早的 function call 关联完整 native call ID、名称和原参数，不能截断 ID 猜归属。

Responses 完成证据来自被动观察的完整 SSE `response.completed` 事件，并与实际 assistant/native response 的 ID、模型和 usage 核对。HTTP 200、Pi 退出成功或单独的 payload hash 都不能补足这个终态。观察器保留事件大小上限，只落盘终态标识与用量；压缩、截断、重复终态、缺失用量或未知协议保持未证明。它不替换 fetch、dispatcher、请求、响应或流，也不更改正常模型接口。

工具参数关联保留原生参数。只有实际加载的 Pi runtime 与当次工具 schema 都有封存原件，且删除明确声明为可选、不可为 null 的顶层 null 字段后与执行输入完全相等，才记录这一转换；required、未知字段和非 null 差异仍失败。codemode 依赖受审的实际 bundled runtime、完整 native/direct 调用集合及终态，每个嵌套工具仍独立判断。持久化 store、图片和 spill 结果不计作透明只读容器。有限目录枚举还须绑定真实 shell 子进程、参数、cwd、启动环境、实际解析的程序与完整退出证据；工具名和命令文本不能单独证明无语义写。该证明不扩展为宿主或插件全部流量为零。

复验通过 `retestOf` 关联首败。保留旧 session、Store、输入、业务读回及失败判定；缺失的协议原件不能事后补造。已执行的项目上下文或已被修改的独立管理 fixture 使用新的自有复验对象和目录；尚未完成的原 Source operation 继续沿原 Store、声明和身份恢复，不能重新创建操作替代它。

## 读回与清理

readAgentFixture(bindings, alias, {version, key, state, properties, projection}) 独立读取实际状态并保存回执。state 为 present 或 absent；properties 只比较声明的 description/enabled/defaultContext；projection 可比较 same-as-baseline 或 absent。声明 expected 与观察 observed 必须分开。

停用对象的 metadata-only 读回不能伪称 fresh 正文已可消费；已选固定任务和新的 current 请求分别验收。投影恢复比较稳定正文、目录与必要关系，容许页面 ID、审计时间变化；完整资源树、路径与可执行权限另核，不要求 Markdown/Notion 渲染逐字相同。

不要在读回中修字段、清 pending、补关联、重新投影或执行新的管理操作。若被测 Agent 声称完成后需要这些修补，保存失败。预定 teardown 只在场景判断完成后收回所有自有测试对象。

根据运行结果中的进程 close 回执确认所有本轮 Pi 已退出；最后一句回答或短等待返回不代表退出。然后调用：

    cleanupAgentFixtures(bindings, { subjectExited: true, trash: '/usr/bin/trash', preserveBindings: true })

保存完整返回回执。preserveBindings 保留原绑定文件，把退场期间的身份检查另存为补充原件。只回收 ownership 中的自有 Notion 对象及全局或项目 Skill；external builtin 跳过，文件目录只移入系统 Trash。retainedEvidence 明确保留本轮输入、oracle、Store、项目配置和 temporary 材料，不把这些复核或恢复所需的原件再删掉。无需再写本地清理脚本或扫描系统临时目录。保留运行原件与首败关系；不要清理用户会话、全局配置、非自有 Skill 或另一个活跃运行的状态。

## 覆盖与结果边界

checkAgentContractCoverage 只读取配对 CLI 的当前索引，检查每个 C 声明都有正确 T 映射。它不把一个自然 case 提升为整个 T 的证明。每个 T 可生成一张原有薄回执，raw_evidence 指向同一真实运行；实际成本按运行身份去重。

全批报告逐项列出所有 required 场景/profile、所选 holdout、首败与复验。各自报告准备、发现、模型、CLI、当前实际交付与真实效果，保留 failed/blocked/not_run。记录哪一部分只是结构检查、作者实跑或独立 Agent 使用；未运行的真实入口不能从同一 hash、旧成绩或其他层级外推。

### 正文计数与实际交付

正数的 `body` 断言默认 `receiptRequired: true`，统计精确 owner、scope、snapshot、version 和文件路径的完整交付。本地 Skill 则统计对应文件成功读取后进入请求的真实工具结果。历史创建输入、其他 owner 或另一版本中相同的文字不充作该文件的交付；同一逻辑文件真的交付两次，仍不满足期望一次的约束。

报告另保留整个请求里的全文出现次数，供成本和暴露分析。`occurrences: 0` 始终检查该轮全部请求中的原始全文，无论是否有回执。只有约束本身针对原始文字计数时才使用 `receiptRequired: false`。selection 和 resource 仍各自需要精确回执及实际任务状态。

管理写入轮使用 `candidate-cli` 要求实际执行冻结的配对 CLI。CLI 进程观察器只被动记录真实 Node 子进程入口，不改 PATH 或模型指令；检查入口实路径、SHA、字节数及进程归属。这个证明不代表任意 shell 的写入或网络效果都已覆盖，未知效果仍保留 blocked。已执行了别的 CLI，即使最后对象正确，也不能算当前候选通过。

投影删除恢复另使用 `single-projection-restore`。观察器只保存真实 CLI 参数的逐项哈希和选项形态，不保存参数正文。分析器从已封存的进程原件判定有限公共命令形态；`--help`、读取和只读预览不算恢复写调用，两个内部 operation ID 也不算两次命令。需要第二个进程续行才成功仍不满足本场景。旧原件缺少参数观测时不可倒填为机械通过；独立审计保留自己的证据范围。
