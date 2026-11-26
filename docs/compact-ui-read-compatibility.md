# compact-ui 的完整 read 合同

`pi-compact-ui@0.1.3` 为隐藏原生工具行而重新注册 `read`，只向模型提供原生 `path/offset/limit`。Broker 尊重第三方执行所有权，因此这个 profile 不能暴露 Broker 的 `paths/from/refresh/budget` 合同。原有已登记引用的单路径 delegate 仍有其限定范围，不能据此把所有 Notion 读取判成失效。

本兼容构建只将 `read` 改用 Pi 1.6 的 `registerToolRenderer`：当前工具提供者保留说明、参数和执行，compact-ui 保留分组、折叠、主题和用户偏好。其他六项原生工具继续使用上游委托。批量读取的人类摘要显示文件数，完整参数与结果仍在展开分组中。

## 可复现准备

仓库只保存补丁、上游身份与准备程序，不 vendor 上游实现。`scripts/compat/pi-compact-ui/manifest.json` 固定官方 npm tarball 的 SHA-256、SHA-512 SRI、三个原始成员和三个结果成员。准备入口拒绝其他 tarball、补丁漂移、已有输出目录或不匹配的补丁结果。

```sh
npm pack pi-compact-ui@0.1.3 --ignore-scripts --pack-destination /absolute/owned/upstream --cache /absolute/owned/npm-cache
node scripts/compat/pi-compact-ui/prepare.mjs --archive /absolute/owned/upstream/pi-compact-ui-0.1.3.tgz --output /absolute/owned/new-compatibility-build
```

输出包含 `package/`、`archives/pi-compact-ui-0.1.3-yoyo.1.tgz` 与 `receipt.json`。程序不安装到日用、不修改 Pi 配置、不执行发布。衍生包设置 `private: true`；上游包没有声明许可证，这里不增补或变更其许可声明。保留官方原件、补丁和来源回执，不能把这个本地衍生版本写成官方升级。

## 日用采用

先按 [next 日用交付](next-worktree-delivery.md) 冻结最新 CLI/Broker 来源，检查真实 `origin/next` 与构建输入。兼容脚本位于 Broker 的构建输入根之外，不单独触发产品重编译；上游产品输入变化仍必须重建，不能用旧实验包覆盖新主线。

将已核兼容 tarball 的三个普通成员安装到新 generation 的 `compat/pi-compact-ui/`，逐文件核对 `result_files`。使用 Pi 提供的运行时 API，不在全局 npm cache 里补丁，也不另装一套宿主。只替换当前已配置的唯一 compact-ui package slot，保留它的设置和其他插件；没有该插件的 profile 不新增插件。日用 Broker 与 CLI 仍指向同一新 generation。

变更前保全实际 Pi 配置与 CLI 符号链接。每台机器读取正常 `pi` 的实际入口、版本和配置存储，再决定所改文件；不能把遗留 YAML 或 `pi list` 当作当前装载证明。回滚使用该 generation 的原始备份，并先核当前配置仍属于本次变更，避免覆盖随后的人类或其他任务更新。

fresh 普通 Pi 必须读回实际 `read` 的 `sourceInfo`、完整说明与 schema，并证明唯一 Broker 来自新 generation。保留 compact-ui 的既有配置字节。局部候选验证可以只在精确 task-owned cwd 使用公开 `project_trust` 钩子，核对项目配置 SHA 并返回 `remember:false`；不得放宽全局项目信任。项目覆盖是采用前验证，不能替代切换后的普通 profile 读回。

## 验证范围

使用实际 Pi 1.6 registry 和工具调度验证：compact-only 保留 builtin `read`；compact/Broker 两种顺序保留 Broker 的完整合同；已有第三方 `read` 的 owner、schema 与执行次数保持不变。单路径、批量和拒绝输入沿真实注册的执行入口验证，不发送模型请求。

使用实际 `ToolExecutionComponent` 和 `Container` 验证分组，而非只检查空 renderer：pending、success、error，折叠和展开，普通和窄宽度，两种 resolver 顺序都应每条 read 只出现一行、正文只出现一次，批量显示文件数。

可复用的实际组件验证入口：

```sh
node scripts/compat/pi-compact-ui/verify-ui.mjs --pi-root /absolute/pi-package --compact-entry /absolute/derived-package/index.ts --broker-renderer-source /absolute/paired-build/source/broker/packages/context-broker/src/pi-read-renderer.ts --out /absolute/new-owned-ui-evidence
```

该入口读取所选实际 Pi、插件与 Broker renderer，记录其 SHA，并在全新目录保存 16 项检查和渲染快照。它不安装插件、不执行工具、不发送模型请求。

模型行为证据与以上受控验证分别记录。恢复普通 profile 的完整合同会增加它此前被删去的工具说明；219 字节精简的比较基准是完整 Broker `read`，不能把这个数字用于 compact-ui 原先的 54 字节说明。小样本未知和统计不足保持原值，不由 UI 或安装验证补成一般非劣证明。
