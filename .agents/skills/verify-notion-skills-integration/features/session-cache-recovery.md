# 当前会话缓存与恢复

当前回归沿 [integration Skill](../SKILL.md)、[consumer-state Skill](../../verify-notion-consumer-state/SKILL.md) 与 session-active、session-short-ref、host-prepare、native-read-session。实际 Pi 用保留的 SDK/日用助手，不走旧跨宿主 CLI fixture 缓存流程。

## 新进程复用

修改缓存、变化证据、TTL、库选择、启动或 SDK 调用次序、会话复用时，必须运行下面四个实际 Pi 场景。
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

node scripts/notion-sdk-pi.mjs run --package /absolute/selected/broker \
  --fixture /absolute/owned/current-fixture/fixture.json \
  --source-http-helper /absolute/selected/cli/scripts/sdk-source-fixture.mjs \
  --pi /absolute/installed/pi/dist/bundle/cli.js \
  --scenario http-smart-revalidate --out /absolute/owned/smart-revalidate
node scripts/notion-sdk-pi.mjs evidence --evidence /absolute/owned/smart-revalidate

node scripts/notion-sdk-pi.mjs run --package /absolute/selected/broker \
  --fixture /absolute/owned/current-fixture/fixture.json \
  --source-http-helper /absolute/selected/cli/scripts/sdk-source-fixture.mjs \
  --pi /absolute/installed/pi/dist/bundle/cli.js \
  --scenario http-smart-current --out /absolute/owned/smart-current
node scripts/notion-sdk-pi.mjs evidence --evidence /absolute/owned/smart-current
```

| 场景 | 实际策略与必须观察的结果 |
| --- | --- |
| `http-warm-restart` | 正文和目录均为 5 分钟；新 PID、新 session 的整个暖阶段 HTTP 为 0，包括启动和后台工作。 |
| `http-warm-directory-expired` | 正文 5 分钟、目录 1 秒；目录确已到期时只允许目录 list 的请求，正文 consume HTTP 仍为 0。 |
| `http-smart-revalidate` | 同一 fixture 的四个独立 PID：正 5 分钟冷读与全暖读，随后正 1 秒元信息复核，再以相同正 1 秒策略复验已到独立期限的正文。全暖总 HTTP 为 0；metadata 的 Skill Markdown 为 0；正文到期必须实际下载并更新 body proof。四段保留相同完整 root + Requires 的 snapshot/hash、实际时延、全部 HTTP、请求/响应字节及未知字节计数。 |
| `http-smart-current` | 四个独立 PID/session：Required 单独变更后取消；下一进程经历 429 后取得新完整闭包；后到 current 变更保持已接纳 pin；新会话采用替换后的 Requires 全集。旧 current 不能在失败时进入 provider。 |

全部场景从第一个 Pi 的真实冷读取建立缓存，不预植快照或资格；后续 Pi 不继承已选会话。
各次读取都经实际 Pi RPC 提交 `$current-demo`，保留原始 prompt、session 和 provider 请求；不能用 SDK 直接调用代替这条 `$` 消费路径。
两个 warm 场景核对根与 Requires 都来自 `local_cache`，原 snapshot、完整正文和 `validated_at` 不变，完整闭包进入实际 provider 请求。
metadata 复核可更新证据时间，不更新独立 `body_verified_at`；一次 unchanged 或根页面时间不能替代 Files、Contributions、Requires 全集和最终全图读集准入。
smart-revalidate 在全部前序 Pi 退出后，仅将任务私有 SQLite 中已实际取得的 `body_verified_at` 和相应 `shared_body_valid_until` 一致移至 24 小时边界外；保存完整前后依据，核对 metadata、scope/权限、代次、manifest/pin、对象及其他表记录不变。第四个新 Pi 必须通过实际 reader 的到期判断重取正文，再核对新 body 时间、原始 HTTP 与完整 provider 字节。这个样本明确标记为受控正文年龄，不表示真实等待了 24 小时，也不使用 refresh/max-age=0 代替到期。`smart-revalidate.json` 的四段成本共享 fixture/content 身份，各段正 TTL 单独注明；不与 live Notion 的网络时延混为同一实验。
smart-current 核实际取消、429 和 SDK failed/cancelled 原件，以及每次 provider 的完整正文/hash；取消后重新选择必须有界结束，不能只用模型 NoDeadlock 或脚本启动失败判定守卫有效。
分别保留目录请求、consume 请求及总请求和各阶段时延；根结构 children 仍按真实请求分类，不能隐藏或改标来制造零请求。
只运行 `notion-sdk-pi.test.mjs` 的助手单测不算执行这些场景。受控 Pi 结果不代替普通日用安装或 live Notion 复验。
普通安装随后沿 [日用缓存入口](daily-installation-ui.md#普通安装的跨会话缓存) 执行 `cache-plan/cache-run`，保留现有配置和缓存，分别记录实际正文策略与目录请求。

## 共享 Notion 缓存

SDK/core 拥有持久 current evidence、远端 metadata、当前资格与固定文件；Broker 的目录 stub 是可丢弃阅读投影。完整 cache 命中保留原 validated_at；成功 metadata 复核单独记本次证据时间，不按投影写入时间续租。Source、credential、store、View 与 scope 隔离，失败、取消和迟到结果都不能延长新鲜度或覆盖更新观测。

已观察到变化即阻断旧 current，后续 unknown、timeout 或 429 不恢复旧资格。Core 在一次最终读集中同时检查 root 与全部 Requires 的事实 epoch、权限和退休状态；Broker 消费这个结果并保留原 ticket、scope、会话 pin 与完整交付守卫，不复制第二份 current evidence。
同 scope 跨进程、late return、重复 unchanged、Files/Contributions 完整集合、旧 observation 升级与损坏对象，沿配对 CLI current-lifecycle 与实际 SQLite/SDK 测试核对；这些具体存储回归不能代填上述 host 结果。精确 24 小时全文期限由 CLI 受控时钟覆盖；宿主成本沿上面的显式私有正文年龄样本观察，不修改日用库或把构造时间当作真实经过时间。

刷新遇 ACCESS_DENIED、NOT_FOUND 或 AUTH_REQUIRED 后，后续当前读取必须重新证明正文资格；不能从旧 native body cache 绕过持续拒绝。暂时网络故障不制造权限撤销。已选离线字节仍可按原固定绑定读取，与当前远端访问资格分开。

## 会话恢复

fork/branch/resume 只恢复当前分支合法绑定；压缩后若只剩标记/摘要，不能视为全文仍在。新选择要在完整 acquisition 后替换。标量/批量资源固定同一 scope、owner 和 snapshot；精确路径和字节 hash 每次消费保持验证。

`STATE_CUTOVER_REQUIRED` 透传原错误码，并提示新的 `NTN_SKILLS_HOME`；旧 sync/upstream config另用新的 `NTN_SKILLS_CONFIG_HOME`。state.sqlite 不在 cacheDir，换 cache目录不能完成断代。不删除用户旧状态来制造成功。

## 实际层级

独立包 current HTTP 验缓存、身份和取消；实际 Pi 生命周期必须观察真实公开动作与最终正文；真实 Notion 编辑和模型结果在 AH-1197/AH-637/AH-1198 单列。没有跨宿主、原生终端或真实模型结果时记 `not_run`，OMP/Tern 延期。
