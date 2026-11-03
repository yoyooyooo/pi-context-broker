# 直连请求引擎

AH-561 统一自有 CredentialProvider 和 Effect HTTP 引擎。保留产品名 `ntn-skills`，清除官方工具的运行、登录、Keychain、stderr 与 fallback 依赖。旧线上 helper 尚依赖官方工具时保持 blocked，不能为了取得新票 pass 再调用它。

| Feature ID | Issue | 实际证明 |
| --- | --- | --- |
| NG-VC-01 | AH-562 | 离线反例、两条冻结根提示、原生 CLI fail-before、独立 trace/oracle 合同。 |
| NG-RE-02 | AH-563 | 公开只读入口经自有认证直接 HTTP，完整分页与正文/hash。 |
| NG-RE-03 | AH-564 | 直连写入、附件与原 operation 恢复；unknown 保留且不盲重放。 |
| NG-RE-04 | AH-565 | 同机不同 cache root 的多 scope 公平限流、取消及 queue/attempt/operation 预算。 |
| NG-RE-05 | AH-566 | 两仓和安装产物、doctor、CI/helper、随包说明无官方工具依赖。 |
| NG-RE-21 | AH-582 | 日用 Pi 使用本次已验收的双仓产物，版本/hash和文档一致。 |

## Launch

从 Broker 根目录执行，复用当前已构建 CLI。下列离线入口不访问业务正文，不读取/复制凭据，不启动宿主或模型。

```bash
node scripts/verify-skill-graph-contract.mjs --help
node --test scripts/verify-skill-graph-contract.test.mjs
node scripts/verify-skill-graph-contract.mjs self-test
```

`self-test` 输出固定反例数量和逐项结果；没有测试、只有 schema 或文件存在不能算通过。该结果只属于 controlled 栏。

## Doctor

```bash
node scripts/verify-skill-graph-contract.mjs doctor --cli "$CLI_ENTRY"
```

`CLI_ENTRY` 是实际 Node bin 的绝对路径。Doctor 仅记录 Node 版本、入口 realpath/hash，不执行 CLI、探认证、暖缓存或访问 Notion。

## Drive

```bash
node scripts/verify-skill-graph-contract.mjs baseline --cli "$CLI_ENTRY" --cli-root "$CLI_CHECKOUT" --evidence-root "$EVIDENCE_ROOT"
```

`CLI_CHECKOUT` 是对应源码仓库，`EVIDENCE_ROOT` 在两个 checkout 外。runner 使用既有 `verificationCliEnvironment` 和无 `.agents` 祖先的系统 scratch；传入白名单环境，CLI 配置/状态/缓存/数据全部隔离且无继承 token。只运行真实 CLI `--version`、`schema prepare`、`schema update` 和只读 Git 观察。

未实现入口保留 fail-before，schema 出现记 schema-present-unverified；工作树源码与 HEAD 原文的 hash/残留分别记录，不能将历史源码冒充当前实现。新 run 永不覆盖旧 run。NG-RE-02～05 的功能验收仍需公开入口、实际 HTTP 和安装产物的独立证据。

HTTP账本要区分 CLI 调用、metadata/body/write/provider、attempt、字节及各段耗时。请求 ID 按真实 available 状态保存，断网或服务未提供时保持 null，不伪造。冷场景必须观察真实 body I/O；暖场景允许零 HTTP，仍要有实际创建的空 ledger。429/request_blocked/超时/断连使用本地受控服务，不故意触发生产限流。unknown 写回执不能因后续成功被覆盖。

## Evidence

保存 `run.json`、`prompts.json`、`contract-tests.json`、version/schema 回执、CLI HEAD、`request-engine-committed-baseline.json`、工作树请求层 hash 与 `result.json`。结果分 controlled、real_service、real_model、real_ui、installed_package 五栏；未执行项保持 not-run。

```bash
node scripts/verify-skill-graph-contract.mjs evidence --evidence "$RUN_EVIDENCE"
```

`RUN_EVIDENCE` 取本次输出。evidence 验证每个原始 artifact hash，返回 functionalStatus；`preserved` 不是功能成功。失败、未运行与未知写入均保留。认证 header/token 和原始 stderr 不落盘。

## Cleanup

```bash
node scripts/verify-skill-graph-contract.mjs cleanup --evidence "$RUN_EVIDENCE"
node scripts/verify-skill-graph-contract.mjs evidence --evidence "$RUN_EVIDENCE"
```

仅将本 run ownership 对应的离线 scratch 移入系统 Trash，保留证据，不清理远端。已有 RPC/model/UI/fixture runner 继续用自己的 owned-process/cleanup 流程；禁止用离线 runner 的成功替代宿主退出或远端恢复证明。
