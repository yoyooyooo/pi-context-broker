# 默认 View 与准备

当前入口是 [integration Skill](../SKILL.md) 的 SDK/安装路径，以及已有 view-discovery、host-prepare、catalog-cache 回归。管理用 `ctl views` stub 只证明 View 命令路由，不证明远端目录或正文。

## 目录选择

明确配置 View 时只使用该 View。未明确选择时按实际 API 顺序选择第一项，不按名称排序。零 Views 返回空目录；权限失败、过期 query、截断或缺游标不能回退全库。View 结果保持原生顺序与部分覆盖；失败成员可见，成功成员不能消失，也不能标成全量成功。

Default Context checkbox 是当前 metadata，不能覆盖显式 View 或变成第二个全局过滤器。关系和身份使用 Source、scope、logical ID、物理 locator；同名不等价。测试只取窄 metadata，不为了验证 View 额外逐页读取正文。

## 准备与投递

准备政策以本次配置为准。`pending`、`prepared`、完整已选正文、provider 接受和 session active 分开。准备受 node/bytes/depth/time 预算控制，不能截短正文伪造满足预算。取消不发布准备完成；迟到结果不能进入后续任务。View 切换使旧准备资格失效，已有固定会话选择另行判断。

纯诊断 oracle 继续核对 scope、snapshot、正文长度/hash、预算和未加载状态；完整 provider body oracle核对实际全文。二者都不替代 SDK acquisition 或真实宿主动作。

## 实际 Pi

使用保留的 `scripts/notion-sdk-pi.mjs` 当前场景与匹配安装。日用 View/真实 Notion 按 [日用地图](daily-installation-ui.md)，未实际执行则明确 `not_run`。旧 CLI fixture 预取、默认双宿主和 Tern 菜单流程已退役，不用它们证明当前默认上下文。
