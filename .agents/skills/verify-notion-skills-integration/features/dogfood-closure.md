# 当前日用收口

目标是同一当前Skill从Notion四表，经正式CLI/SDK到实际Pi和模型的完整日用路径。当前范围由AH-1063与Linear现行正文负责；Pro本机完整Skill迁移另沿AH-516。旧基线提交、固定历史样本和已退役兼容条件不作为当前执行合同。

## 单轨边界

Notion展示最新正文，CLI消费current身份。远端目录只接受 `shared_skill`；原始UUID/URL可以作为输入，但不接受旧locator自动等价。普通消费SDK v2恒零语义写入，旧`readOnly`参数在I/O前拒绝。`source.command`、retention/adoption、历史Publication和旧导出回退均不能恢复。

管理负责完整Files/Records与当前operation，未结清操作不重放未知写。消费负责完整目录、精确Source/scope/owner/File、当前权限与固定本地字节。状态和实现守卫沿 [consumer-state](../../verify-notion-consumer-state/SKILL.md)，作者操作沿CLI原有领域Skill。

## 收口顺序

1. 当前CLI和Broker代码检查完成，真实decoder通过完整manifest正反例。
2. 同一CLI/SDK候选完成独立包/current HTTP消费，校验实际字节、完整资源、取消和零写。
3. 真实Notion表切换后，核对Pi有效配置真正加载的匹配安装，再按 [日用助手](daily-installation-ui.md) 执行现有candidate-plan/run。
4. 分别检查发现、明确选择、完整主文/资源、实际provider/serializer、模型任务、取消与后续会话恢复。
5. 根据实际结果更新Linear和Notion冷启动入口；只有已完成的层级记通过，未执行保留not_run。

不把临时独立安装视为日用切换，不用旧会话或模型自述证明当前成功。真实任务不要预塞oracle/预期叶子ref；独立审阅使用真实输出和完整字节。现有生成产物助手若被实际任务使用，仍须完整审阅并在自有项目中实际执行相应产物，不能以原项目测试冒充生成helper成功。

## 观察与清理

来源metadata/body/resource、实际HTTP、provider正文和模型usage按 [成本地图](skill-consumption-cost.md) 分开。unknown不填零，失败不改判。当前无版本管理/证据冗余平台；必要请求诊断和原输入由原助手产生并保留。

只操作明确属于本轮的输入、输出和进程。保留用户会话、配置和未结清Store；临时目录经系统Trash处理，不永久删除。OMP/Tern延期，原生终端菜单专项本轮未验收，不能从RPC或包成功推断UI成绩。
