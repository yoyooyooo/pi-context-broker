# Broker documentation / 文档导航

[English reference](./reference.md) · [中文参考](./reference.zh-CN.md) · [Overview / 项目入口](../README.md)

Use the references for the current configuration and activation contract: built-in filesystem/Notion sources, legacy roots/catalogs, host Skill discovery and selected read/native activation, canonical tokens, source scope, pinned snapshots/resources, metadata refresh and restart semantics, persistent transcript activation records, and the submission/preparation gate.

当前配置与激活合同以双语参考为准：内置 filesystem/Notion sources、原有 roots/catalogs、宿主 Skill 目录与选中后的 read/native 激活、canonical tokens、source scope、pinned snapshots/resources、元数据刷新与重启语义、持久会话激活记录与提交 preparation 门控。

- [Configuration example / 配置示例](../examples/config.example.yml) and [schema](../examples/config.schema.json).
- [English source contract](./reference.md#built-in-sources) and [中文 source 合同](./reference.zh-CN.md#内置-sources).
- [Bundled Skills](./reference.md#bundled-skills) / [随包 Skills](./reference.zh-CN.md#随包-skills): ordinary `$...@builtin` discovery and loading on Pi/OMP/Tern when a Notion source is enabled, with offline package instructions and references; explicit local installation and Notion publication remain separate / 启用 Notion source 后 Pi/OMP/Tern 才通过普通 `$...@builtin` 发现随包指令与引用，未连接时也可离线读取；显式本地安装和 Notion 发布仍是独立操作。
- [Security / 安全边界](../SECURITY.md) and [changelog / 变更记录](../CHANGELOG.md).
- Verification procedures / 验证规程: `.agents/skills/verify-context-broker/SKILL.md` and `.agents/skills/verify-notion-skills-integration/SKILL.md` in the [broker checkout](https://github.com/yoyooyooo/pi-context-broker), plus `.cursor/skills/verify-ntn-skills/SKILL.md` in the [CLI checkout](https://github.com/yoyooyooo/notion-skills-cli). The integration Skill owns nine maps for source configuration/discovery, host discovery/read, default-context preparation, dollar selection, snapshot/resources, session/cache/recovery, installed consumption, daily native menu and builtin management. These paths describe checkout procedures; consult retained run evidence for acceptance status / 这些路径是 checkout 操作规程，实际验收状态以保留的运行证据为准。
