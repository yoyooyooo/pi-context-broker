# 当前会话缓存与恢复

当前回归沿 [integration Skill](../SKILL.md)、[consumer-state Skill](../../verify-notion-consumer-state/SKILL.md) 与 session-active、session-short-ref、host-prepare、native-read-session。实际 Pi 用保留的 SDK/日用助手，不走旧跨宿主 CLI fixture 缓存流程。

## 新进程复用

修改缓存、TTL、库选择、启动或 SDK 调用次序、会话复用时，必须运行下面两个实际 Pi 场景。
使用同一配对的独立安装包、current HTTP fixture、源码 HTTP helper 和实际 Pi entry；输出目录必须是本轮未占用的自有路径。

```sh
node scripts/notion-sdk-pi.mjs run --package /absolute/selected/broker \
  --fixture /absolute/owned/current-fixture/fixture.json \
  --source-http-helper /absolute/selected/cli/scripts/sdk-source-fixture.mjs \
  --pi /absolute/installed/pi/dist/bundle/cli.js \
  --scenario http-warm-restart --out /absolute/owned/warm-restart
node scripts/notion-sdk-pi.mjs evidence --evidence /absolute/owned/warm-restart

node scripts/notion-sdk-pi.mjs run --package /absolute/selected/broker \
  --fixture /absolute/owned/current-fixture/fixture.json \
  --source-http-helper /absolute/selected/cli/scripts/sdk-source-fixture.mjs \
  --pi /absolute/installed/pi/dist/bundle/cli.js \
  --scenario http-warm-directory-expired --out /absolute/owned/warm-directory-expired
node scripts/notion-sdk-pi.mjs evidence --evidence /absolute/owned/warm-directory-expired
```

| 场景 | 实际策略与必须观察的结果 |
| --- | --- |
| `http-warm-restart` | 正文和目录均为 5 分钟；新 PID、新 session 的整个暖阶段 HTTP 为 0，包括启动和后台工作。 |
| `http-warm-directory-expired` | 正文 5 分钟、目录 1 秒；目录确已到期时只允许目录 list 的请求，正文 consume HTTP 仍为 0。 |

两者都从第一个 Pi 的真实冷读取建立缓存，不预植快照；第二个 Pi 不继承已选会话。
两次读取都经实际 Pi RPC 提交 `$current-demo`，保留原始 prompt、session 和 provider 请求；不能用 SDK 直接调用代替这条 `$` 消费路径。
核对根与 Requires 都来自 `local_cache`，原 snapshot、完整正文和 `validated_at` 不变，完整闭包进入实际 provider 请求。
分别保留目录请求、consume 请求及总请求和各阶段时延；根结构 children 仍按真实请求分类，不能隐藏或改标来制造零请求。
只运行 `notion-sdk-pi.test.mjs` 的助手单测不算执行这些场景。受控 Pi 结果不代替普通日用安装或 live Notion 复验。
普通安装随后沿 [日用缓存入口](daily-installation-ui.md#普通安装的跨会话缓存) 执行 `cache-plan/cache-run`，保留现有配置和缓存，分别记录实际正文策略与目录请求。

## 共享 Notion 缓存

SDK/core 拥有远端 metadata、当前资格与固定文件；Broker 的目录 stub 是可丢弃阅读投影。命中时保留原 validated_at，不按投影写入时间续 TTL。Source、credential、store、View 与 scope 隔离，失败、取消和迟到结果都不能延长新鲜度或覆盖更新观测。

刷新遇 ACCESS_DENIED、NOT_FOUND 或 AUTH_REQUIRED 后，后续当前读取必须重新证明正文资格；不能从旧 native body cache 绕过持续拒绝。暂时网络故障不制造权限撤销。已选离线字节仍可按原固定绑定读取，与当前远端访问资格分开。

## 会话恢复

fork/branch/resume 只恢复当前分支合法绑定；压缩后若只剩标记/摘要，不能视为全文仍在。新选择要在完整 acquisition 后替换。标量/批量资源固定同一 scope、owner 和 snapshot；精确路径和字节 hash 每次消费保持验证。

`STATE_CUTOVER_REQUIRED` 透传原错误码，并提示新的 `NTN_SKILLS_HOME`；旧 sync/upstream config另用新的 `NTN_SKILLS_CONFIG_HOME`。state.sqlite 不在 cacheDir，换 cache目录不能完成断代。不删除用户旧状态来制造成功。

## 实际层级

独立包 current HTTP 验缓存、身份和取消；实际 Pi 生命周期必须观察真实公开动作与最终正文；真实 Notion 编辑和模型结果在 AH-1197/AH-637/AH-1198 单列。没有跨宿主、原生终端或真实模型结果时记 `not_run`，OMP/Tern 延期。
