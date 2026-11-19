# 宿主发现与实际读取

[当前 integration](../SKILL.md) 先验证 SDK 合同与安装包。发现只提供完整 metadata，正文按实际选择获取；目录卡片或本地 stub 的存在不证明已加载正文。

保留本地、builtin 和当前 Notion Source 的独立身份。当前远端必须 enabled，精确 scope/owner 一致；文件或提示中的旧 notion_page/subscription 不能自动映射成 current。原始 UUID/URL 输入仍通过当前库验证。

源码沿 remote-catalog、naming-contract、member-read、native-read-session、host-prepare、notion-source-sdk 和 view-discovery。核对多来源消歧、冷发现无正文、选择后完整主文、相对资源、取消与缺失数据拒绝。普通 read 的每次实际授权/effects 要保留；重复字节可在当前请求中复用，但不能绕过授权。

真实 Pi 通过保留的 SDK 与 [日用安装助手](daily-installation-ui.md) 观察公开工具、实际 provider/serializer 和当前会话。源码 helper、SDK HTTP、实际 Pi 与模型效果分别报告。OMP/Tern 延期。
