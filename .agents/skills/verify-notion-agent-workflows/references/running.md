# 自然旅程的准备、运行与证据

## 目录

- 输入与对象准备
- 当前候选配置
- 事件和私有判定
- 读回与清理
- 覆盖与结果边界

## 输入与对象准备

在 Broker 根目录工作。只使用当前配对 CLI/SDK 构建和正常 Pi 环境；确认凭据已通过正常环境提供。命令与日志不输出 token。准备阶段和被测 Pi 使用独立状态，不能复制 oracle 到被测缓存。

先读取 [loader](../../../../scripts/notion-agent-scenarios.mjs) 导出的选择函数，按场景 ID 选择；不要把完整语料发给被测模型。对象准备复用 scripts/notion-agent-fixtures.mjs：

    prepareAgentFixtures({
      recipe,                 // corpus.fixtures[scenario.fixture]
      runId,                  // 唯一本轮名称，仅字母、数字、下划线、短横线
      root,                   // 本轮全新、尚不存在的绝对目录
      entry,                  // 当前 Skills database ID
      cli,                    // 当前配对的 dist/ntn-skills.js 绝对路径
      node,                   // 实际 Node，可省略而沿用 process.execPath
      globalSkillsRoot        // 可省略而用真实 ~/.agents/skills
    })

返回 bindings，并同时保存 root/bindings.json。entry 不是 CLI 路径；cli 不是 shim。准备只通过公共管理命令写自有测试对象。builtin 只读取当前库里的精确既有对象，其 ownership 为 external，不能清理。

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
      "database": "REPLACE_WITH_CURRENT_SKILLS_DATABASE_ID",
      "packageIndex": 0
    }

从正常 settings 的 packages 中核对实际 Broker 注册位置，packageIndex 从零开始；不能复制示例值。先按 integration Skill 核源码、构建与 embedded CLI/SDK 的同一身份。

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
      root: input.fixtureRoot, entry: input.database,
      cli: join(input.cliRoot, 'dist/ntn-skills.js'),
    });
    const config = {
      version: 1, scope: 'notion-agent-workflow',
      scenarioFile: input.scenarioFile, scenarioId: input.scenarioId, profile: input.profile,
      bindingsFile: join(input.fixtureRoot, 'bindings.json'),
      brokerRoot: input.brokerRoot, cliRoot: input.cliRoot,
      sourceId: input.sourceId, database: input.database, packageIndex: input.packageIndex,
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
| brokerRoot / cliRoot | 实际配对包目录，不是任意同版本副本 |
| sourceId / database / packageIndex | 正常配置中所选 Notion source、库与真实 Broker 注册位置 |
| evidenceRoot | 本轮自有原始结果根 |
| model / thinkingLevel | magpie/group/worker / high |
| timeoutMs / catalogTimeoutMs | 可选有界等待预算，不能无限重试 |
| viewId | 可选的本轮真实 View 绑定；filtered-view 不能用假返回值代替 |
| retestOf | 可选，关联保留的首次失败原件 |

cwd 来自 bindings.private.fixture.projectRoot；ownership 来自 fixtureRoot/ownership.json，不由调用者随意声明。不要把 token、正确答案、期望工具调用或私有字段塞入 prompt、system prompt、context 文件或模型环境提示。

daily 正常加载全局与项目 native Skills、其他扩展/MCP；no-native-skills 只关闭默认 native 发现，仍需如实记录 Broker local 与可读路径。正式请求和响应必须证明实际 worker 路由；模型配置标签、RPC success 和进程退出零均不足以通过。

## 事件和私有判定

每轮只含 id、自然 prompt、可选 before 与 expect。prompt 仅展开双花括号中的公开字符串。binder 校验键；未来出版版本的真实 scope/snapshot/version 在事件完成后才绑定。bindAgentTurn 每轮使用当时的真实状态，不将逻辑 A/B 标签当成真实哈希。

有限事件由 validateAgentEvent 校验：发布指定版本、调整启停、删除自有对象、独立读回、删除/恢复阅读投影，以及真实 restart/fork/compact 和自有故障。事件必须由真实命令或 RPC 完成，有独立读回屏障。任意 shell、未知字段、通用循环、动态生成的用户救援都不属于事件。

fork 从指定先前用户 turn 之前分叉；保留此前有效分支。compact 使用真正的公开操作，不手写 JSONL 或替换成新空会话。失败注入只能操作自有 Store/对象；必须保留发生事实及恢复范围。

私有 expect 使用有限 kind：

| 类别 | 判定内容 |
| --- | --- |
| completed | 请求实际发送、provider 完成、非空有效响应 |
| visibility | 精确 native-discovery、当前 model-catalog 或真实 source-pending 时序 |
| tool-attempts | 指定工具真实尝试的上下界，失败与撤回也计入 |
| body / resource | 当前请求中的完整主文/资源及精确归属 |
| selection / selection-any | 指定逻辑对象/版本或明确允许的等价集合 |
| output / clarification | 必要业务事实、禁止事实或预写澄清主题，不比较整段标准答案 |
| no-semantic-writes | 普通消费无语义写，不能凭缺日志推零 |
| business-readback | 真正独立读回的对象、版本、元数据、保护内容或投影状态 |

目录 pending 与 unauthorized 是明确的场景前提。pending 需要首请求与真实后台目录完成时间交叉证据；source 已 ready 的样本不计作 pending。unauthorized 使用本轮故障环境，不能关闭 source 再将“零误用”算通过。显式 offline 单独记账；filtered-view 必须来自真实视图，缺能力保持明确失败/阻断。

输出必要事实来自业务规则。例如报销金额格式是被测 Skill 自身的业务约定；私有判据只检查关键金额，不把完整答案给模型。语义等价选择不能掩盖用户明确指定的来源或管理对象。

## 读回与清理

readAgentFixture(bindings, alias, {version, key, state, properties, projection}) 独立读取实际状态并保存回执。state 为 present 或 absent；properties 只比较声明的 description/enabled/defaultContext；projection 可比较 same-as-baseline 或 absent。声明 expected 与观察 observed 必须分开。

停用对象的 metadata-only 读回不能伪称 fresh 正文已可消费；已选固定任务和新的 current 请求分别验收。投影恢复比较稳定正文、目录与必要关系，容许页面 ID、审计时间变化；完整资源树、路径与可执行权限另核，不要求 Markdown/Notion 渲染逐字相同。

不要在读回中修字段、清 pending、补关联、重新投影或执行新的管理操作。若被测 Agent 声称完成后需要这些修补，保存失败。预定 teardown 只在场景判断完成后收回所有自有测试对象。

确认所有本轮 Pi 进程已退出，再调用：

    cleanupAgentFixtures(bindings, { subjectExited: true, trash: '/usr/bin/trash' })

只清理 ownership 中的自有对象；external builtin 跳过。文件目录只能移入系统 Trash。保留运行原件与首败关系；不要清理用户会话、全局配置、非自有 Skill 或另一个活跃运行的状态。

## 覆盖与结果边界

checkAgentContractCoverage 只读取配对 CLI 的当前索引，检查每个 C 声明都有正确 T 映射。它不把一个自然 case 提升为整个 T 的证明。每个 T 可生成一张原有薄回执，raw_evidence 指向同一真实运行；实际成本按运行身份去重。

全批报告逐项列出所有 required 场景/profile、所选 holdout、首败与复验。各自报告准备、发现、模型、CLI、当前实际交付与真实效果，保留 failed/blocked/not_run。记录哪一部分只是结构检查、作者实跑或独立 Agent 使用；未运行的真实入口不能从同一 hash、旧成绩或其他层级外推。
