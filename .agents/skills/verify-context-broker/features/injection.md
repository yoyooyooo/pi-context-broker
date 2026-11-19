# 当前发现、选择与注入

当前 remote 来源通过 SDK 提供完整 metadata。目录出现只说明可发现；只有用户或模型实际选择并完成当前 acquisition 后，完整正文才可进入本次请求。普通聊天不自动接受候选，默认上下文也必须遵守本次实际 View 和预算。

## 当前回归

`bun run check:broker` 覆盖已有 input-guard、accepted-selections、host-prepare、native-read-session、skill-context-session 与 guidance 测试。局部改动直接运行对应文件，不增加入口包装器。

保留以下状态区分：完整目录与部分目录；未选择与已接受；准备完成与已投递；本地固定文件与当前远端资格；provider 接受与 turn 完成。目录 stub、loaded 标记、日志中的 inject 字样和工具 receipt 都不能单独证明全文已进入模型请求。

## Missing-reference regression route

普通未知字面引用保持原文。用户明确接受的引用随后失效时，必须说明未加载，不能签发 loaded/active 结果。身份、scope、enabled、权限、缺失页面与正文完整性失败必须阻断该选择，且不能污染其他正常来源。

当前 exact logical ID、物理 UUID/URL 输入和来源 namespace 各有边界：物理 UUID 是输入选择方式，不是接受旧 `notion_page` locator 的理由。相同名称跨 Source 保持独立；本地和 builtin 的真实读取守卫也必须保留。

## 实际 Pi

实际注入使用已保留的 `scripts/notion-sdk-pi.mjs`，先读其帮助并选择匹配安装与当前输入。它覆盖的 SDK、工具、RPC 与 provider/serializer 层分别记录。日用有效配置与真实服务另按 [日用地图](../../verify-notion-skills-integration/features/daily-installation-ui.md)；原生终端菜单与真实模型不得由源码通过推断。

会话变化沿 [lifecycle](lifecycle.md)，正文唯一性沿 [context-once](context-once.md)。OMP/Tern 延期，无本轮双宿主结论。
