# 当前多 Skill 与关系消费

[当前integration](../SKILL.md) 验证SDK合同与安装，[consumer-state](../../verify-notion-consumer-state/SKILL.md) 维护资格、固定选择、取消和交付模型。这里不恢复历史图证据平台。

当前 `Members` 与 `Requires` 只保存明确关系。目录元数据、展开检查与实际use是不同操作：未选Members正文不预读，Requires按本次明确需要的闭包获取。每个节点固定Source、scope、logical ID、physical owner与所需文件hash；跨scope或关系变动不能复用错误绑定。

保留多根共享依赖、循环/limit、部分目录、false-enabled、缺失/拒绝、取消和迟到结果等现有守卫。预算是完整获取的限制，不能把截短正文或删文件当作成功。一个根失败不能发布声称完整的新图，也不能把旧选择隐式换成同名成员。

源码沿现有notion-consumption-tools、host-prepare、consumer-state、session-active、fixed-resource-source等实际回归。完整manifest的负例通过同提交CLI decoder；未配置decoder而skip时不得算通过。独立安装沿 current HTTP verifier，实际Pi沿保留的SDK/日用助手。

当前Source贡献的相对链接需要明确映射。跨Skill根路径不能使用旧source_projection/upstream规则猜测；本地固定文件不提供远端历史恢复。作者治理在CLI验证领域负责，Broker只消费其当前身份和失效结果。

[请求成本](request-engine.md) 与 [内容唯一性](../../verify-context-broker/features/context-once.md) 使用实际请求和serializer观察。成功目录、一次use或合成图不得替代真实Pi、模型或UI结果；OMP/Tern延期，原生终端本轮未验收。
