# 历史 104 条证据对照 census，2026-11-25

AH-1227 的这份补充记录公开了已完成的 collector 1.2 重分析对照。104 条历史观察仍分成 16 个分析层，原主统计、admission、业务读回、失败与用量原件保持不变。这些计数没有合并成新的科学质量率，也没有增加模型执行。

## 对照结果

| 整体结果 | 原记录 | 新描述性分析 |
|---|---:|---:|
| pass | 25 | 38 |
| fail | 14 | 14 |
| unknown | 54 | 41 |
| not applicable | 11 | 11 |

13 条 unknown 通过原先保留的证据恢复为 pass。全部 14 条 fail、11 条 invalid 和 6 条完整 usage unknown 原件均保留，invalid 没有变成 valid。原始业务值不变，改变的是适用合同的可验证性。

合同级别另外记录了 16 条 selection unknown→pass、13 条 resource unknown→pass，以及一条仍属 invalid 观察的 resource unknown→fail。六条 clarification 合同继续 unknown。合同数与观察数分别记账。

| 原 collector | 观察数 |
|---|---:|
| 1.0.0 | 1 |
| 1.0.1 | 2 |
| 1.0.2 | 10 |
| 1.1.0 | 91 |

新分析统一使用源码绑定的公共 collector 1.2.0。最早 13 条的 normalizer 1.0.0→1.1.0 变化保留为五个显式新分析层，另 91 条保留为 11 个原 protocol 层。原冻结 protocol 没有改写。详细逐条身份、分析引用与未恢复原因见 [census.json](../benchmark/results/2026-11-25-retained-evidence-census/census.json)；汇总见 [summary.json](../benchmark/results/2026-11-25-retained-evidence-census/summary.json)。

## 两种已知成本口径

| 口径 | input tokens | output tokens |
|---|---:|---:|
| 原账务中完整 episode 字段之和 | 2,402,549 | 63,085 |
| 包含部分观察 episode 内已知成功请求的下界 | 2,406,425 | 63,121 |

两者相差 3,876 input / 36 output。已知模型请求仍为 476，六条观察的完整用量仍未知；这些小计不填作完整成本，原账务锚不变，金额也不按零处理。

## 文件与复算

[五文件公开包](../benchmark/results/2026-11-25-retained-evidence-census/README.md)共 611,249 bytes，使用既有 sanitizer 1.0.6。它引用[固定历史公开 raw 链](https://github.com/yoyooyooo/pi-context-broker/tree/aa3b222bc7a489e168ab89d30df4b0b2c6aecb77/benchmark/results/2026-11-25-observer-repair-continuation)，没有重新装包 104 条 raw。

使用 Node26 和一个全新的输出目录：

```sh
node benchmark/results/2026-11-25-retained-evidence-census/recompute.mjs \
  --manifest-sha256 83650b150a2be19084da4505d067f8e11e3c843b15b1edf06815bca29d70bace \
  --out /absolute/new-census-result
```

预期 `summary_sha256` 为 `10df1008d3227ed1aa5957068dfb4f0e8126717a5c4b5b7f814cf3600d51f459`。原五文件的 [manifest](../benchmark/results/2026-11-25-retained-evidence-census/manifest.json) 不包含本说明页。

已完成的隔离复算在禁止网络、私有读取、私有写入和公开包写入的环境中通过，复算 104 条、16 层的计数、合同变化与两种已知成本口径，源包和副本字节不变。该运行的独立 receipt 指纹为 `084eef597c4f77e42509f964f8b065918f9436bf01beeceaf1909b2b4e010e64`。

此入口复算公开 census 的算术与一致性，不执行私有 grader，不重放全部外部 raw，不重建缺失观察，也不调用模型。源码归属不一致、缺完整资源路径和 clarification 可观察性不足的项目继续保留 unknown。这份历史对照独立于后续真实 42 条条件。
