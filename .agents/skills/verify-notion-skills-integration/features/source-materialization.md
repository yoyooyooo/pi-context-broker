# Source 首次引用的实际 Pi 验证

沿 [integration Skill](../SKILL.md) 选择本轮配对的私有 packed build；CLI 的 verify-notion-source-onboarding 拥有业务管理与原件合同。本页只负责真实 Pi 的输入授权、管理交接、普通消费、provider 字节及新客户端复用。

## 输入

使用同一 CLI 提交的 `/absolute/selected/cli/scripts/sdk-fixture.ts --catalog --materialization` 生成新目录。输入只含独立远端事实、真实 Git 原件和固定 commit/blob/hash/bytes/mode，不含消费者 snapshot、SQLite 或 cache。包必须是独立安装目录，CLI、SDK、management 三个模块和 runtime manifest 的 hash 相符。选定实际 Pi 的绝对 entry；不要把源码单测当作这个入口的执行。

上游 fixture 的 HEAD 必须已经前移，且 root 的正文与已接受 commit 不同。runner 先实际读取 Git HEAD 和对应正文，再要求 Source plan 与最终 provider 完整正文仍绑定旧 accepted commit；只改无关文件不能证明没有误跟 HEAD。

runner 启动实际 Git smart HTTP backend、受控 Notion HTTP、同一安装包的固定 manager 和真实 Pi RPC/provider serializer。manager 拥有私有 canonical Store 和与消费者不同的受控凭据；client binding 只能选定固定命令，不能覆盖 generation、Source 集合、凭据、origin 或 Store。回执 scope 必须来自 SDK 对消费者的实际鉴权，manager_scope 保留管理端的实际鉴权；runner 从两边 SQLite identities 独立读取后比较，不能只比较请求回显。命令使用本轮明确选定的受支持 Node 绝对路径；示例 `node` 表示该路径。

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
~~~

每例先运行实际模型工具的 readonly list，再提交用户字面 `$lazy-root` 或 growth 的 `$lazy-required`。覆盖旧行缺 Content/Current State、仅 Source 无 Skill、Source 的 Content/Contributions 全空、已 ready 集合扩展四种初态。legacy-source 保留真实旧注册形状：Status=applied、Operation 为空、Last Revision 是原 Git commit；旧 commit 仅冻结所选 Git 输入，不能充当 current plan authority。旧行保留 page、Main File ID、stable Skill ID 和人工字段；Members 中的 sibling 不展开，Source 声明集合不能被局部选择替换。legacy 两例用真实 Requires 关系证明完整闭包；source-only 不凭 frontmatter 发明不存在的依赖关系。native-root 另以真实 native 主文为明确根，沿实际 Requires 修复旧 Source 依赖，保留 native 权威和三篇完整正文；authorization_root 的 physical page、scope 和 requires_digest 必须保持，Members 不展开。

每例随后启动相同 Store 的另一个空 Pi session/PID，确实在五分钟内复用第一次消费取得的缓存；Notion HTTP、Git HTTP、管理新调用均为 0。source-only 使用首次未物化候选的原精确 `alias@skill%3A<stable-id>@namespace` token，物化后的真实目录必须直接复用它，不能偷偷改成另一次宽松别名匹配。最后启动全新独立 client-2，配置、Store、cache、session 不与 client-1 共用，未复制消费者文件；它从同一 Notion 事实与 Git 取得自身原件，语义写为 0。

## 证据

保留 source-facts、after-materialization、after-independent-client、Notion/Git 原始账本、manager immutable inventory/绑定、真实 manager PID/exit、Pi PID/session/lifecycle、SDK 诊断、完整 wire 及每个原文 hash。现役 `notion-sdk-pi.mjs evidence` 独立复核 provider 文件与这些阶段事实，不能只看汇总 status。

`context-broker.notion-materialization` 和 session 的 `context-broker-materialization` 是管理证据；普通 `context-broker.notion-sdk` consume 及原始 provider 序列化是另一层证据。管理成功后才允许普通 consume 形成新选择。consume.remote_writes 恒为 none，投影写尝试恒为 0；body 来自完整 Git 原件，旧 Notion 生成正文不能充当 oracle。

当前 authority/receipt 负例沿以下现有单测核对：真实 input receipt、精确 roots/scope/session/branch、引用/代码围栏美元名、取消与撤销；请求/返回 Library、注册、commit/revision 和 physical identity；pending/blocked、迟到 receipt、旧 pin 和最终 provider fence。它们不能替代上述实际 Pi 成功路径。

~~~sh
bun test packages/context-broker/scripts/preparation-authority.test.ts packages/context-broker/scripts/source-materialization-contract.test.ts packages/context-broker/scripts/source-member-candidates.test.ts packages/context-broker/scripts/notion-management.test.ts packages/context-broker/scripts/source-materialization.test.ts packages/context-broker/scripts/notion-sdk.test.ts
node --test scripts/notion-sdk-pi.test.mjs scripts/skill-consumption-source-observer.test.mjs scripts/notion-skill-graph-model-evidence.test.mjs
~~~

未知写另由 CLI operation/source-writer 的真实 HTTP/Store 回放和 current-lifecycle 的 SourceWriterSettlement 负责。业务/控制 PATCH 结果未知时，即使 desired 相等也不能派发第二次；唯一原写终结前拒绝 successor，任一子意图未结清就不能先替换父 Source。客户端取消仅撤销等待和发布资格，不删除 manager pending 或因超时自动接管。

如果目录、TTL、readiness 或事实失效发生变化，还必须运行 [新进程缓存四例](session-cache-recovery.md#新进程复用) 的 http-warm-restart、http-warm-directory-expired、http-smart-revalidate、http-smart-current。它们拥有原先缓存全链路回归，新增物化案例不替代它们。

现役 CI 使用同一冻结 CLI 生成器、独立安装 Broker 与 Pi 1.6.0 执行以上五例，随后逐例运行同一 `evidence` 入口。失败也保留原始证据。`verification-skill-routing.test.mjs` 要求生成器、五次实际执行、五次独立回放及各自上传目录齐全；文档有命令不能替代该自动执行链。

## 结果范围

实际 Pi 加真实 Git backend、受控 Notion/provider 记 controlled-Pi。live Notion、自然模型及普通日用安装各自保留 not_run，直到同一候选实际执行。管理 ready、完整 consume、provider bytes、provider 接受和 turn 结束分别报告；Source materialization 不承诺人类阅读投影。

原始失败保留，新结果给 retest_of。未做独立冷启动 Skill 使用评估则 instruction_evaluation:not_run。清理只限本轮已退出的进程和自有绝对目录；任何仍有未知派发的 manager Store/原件都必须保留，不以删除或强制 ready 获得通过。
