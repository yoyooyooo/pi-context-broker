# 独立安装与发布门禁

用户安装 npm broker 或 Tern 归档后，运行入口及依赖应完整；发布检查失败不能产生发布 commit、tag 或 push。

## Sub-features

- `package-runtime`：npm tarball 解包、生产依赖安装后能加载 OMP 扩展，连续请求正文各一份。
- `package-query`：npm/Tern 两个独立 Node 查询程序能解析中文 alias、UTF-16 编辑范围且不返回 Skill 正文。
- `package-closure`：Tern manifest、Luau 依赖、独立 query、CLI 和三份随包 Skill 的完整参考资源都在归档中；不含退役的 builtin.luau/save-workflow。
- `package-docs`：npm/Tern 双语 README、broker 参考和贡献指南的本地链接与章节锚点在解包后可达。
- `release-gate`：检查失败阻止 commit/tag/push；成功且 `--no-push` 只产生本地 tag；规划模式不执行检查。
- `package-desktop`：独立 Tern 插件安装后的实际界面由 [编辑器地图](editor.md) 覆盖。
- `package-source`：`node scripts/verify-notion-integration.mjs run installed --package /absolute/pi-context-broker.tgz` 在独立临时prefix安装指定归档，双宿主加载安装后的扩展并消费source。先 `doctor installed` 带同一 `--package`；未运行时不能用源码source结果代替，详见[安装消费地图](../../verify-notion-skills-integration/features/installed-consumption.md)。

## How to get to it (user POV)

- 从 npm 安装 `pi-context-broker`，由 Pi/OMP 加载其 extension；运行 `context-broker-complete`。
- 下载对应 GitHub Release 的 Tern 归档，解包后通过 `tern plugin install /absolute/extracted-directory` 安装。Git 源码目录用于开发，需要先完成构建。
- 维护者运行 `bun run release patch`，或者使用 `release:check`/`--dry-run` 查看计划。

## Driving it with control.mjs

Preconditions:

- Node.js 22.x 中的 22.22.3+，或 24.20.0+、仅用于构建的 Bun、OMP、npm、Git、tar；npm registry 网络可用。
- `control.mjs doctor distribution` ready。runner 构建并打包当前 checkout；不调用仓库的真实 release，不创建线上发布。

- **完整路径。** 运行 `node .agents/skills/verify-context-broker/scripts/control.mjs run distribution`。先打包到临时 archives，解包 npm/Tern，npm 只安装生产依赖且跳过 install scripts/peer 自动安装。解包后的 OMP 两次真实 prompt，provider 中正文都恰好一份。
- **独立查询。** 两份 query 从仓库外独立 Node 进程接收 `中文😀\n使用 $架构 tail`，返回身份限定的 `$design-review@…@local` 与正确 UTF-16 from/to/len；结果无私有 body marker；拆开 emoji surrogate 的 cursor 以非零退出。
- **文档导航。** 解包后从 npm 的双语 README、双语参考和贡献指南、Tern 的双语 README 递归检查本地链接与标题锚点，防止下沉文档漏包或投影仍指向 workspace。线上链接与实际 Markdown 呈现需另行核对，不由文件存在替代。
- **发布行为。** 同一命令执行 `node --test scripts/release.test.mjs`。它创建临时 repo 与本地 bare remote、受控 registry 回复及检查命令，观察 commit count、tag、remote refs、拒绝 push 的 hook。检查失败无发布 refs；成功 `--no-push` 有正确版本的 annotated tag，原 main 不变；规划模式未执行 gate。
- **证据。** manifest 指向 `broker-artifacts-*`，含 `archives`、`npm/package`、`tern`、`provider.jsonl` 和 session；release tests 的各个 `pi-context-broker-release-*` 保存 repo/remote.git 与 gate.json。transcript 保留所有断言结果，完成后执行 `control.mjs evidence`。
- **桌面安装。** 本路径仅检查 Tern 文件完整与查询能力；需要证明真实插件装入窗口并能交互时再执行 `run editor`。

- **随包消费。** 未配置 source 的冷安装可发现三份 `@builtin` 候选；选择正文并读取相对参考文件。两份产物的 Skill 库存一致，同名本地/Notion 内容可以精确消歧。复用现有包/宿主检查。

## Gotchas

- 本脚本只驱动解包后的 OMP；Pi package 安装运行未被它覆盖。Pi 源码 host 回归通过不等价于 Pi 独立安装通过。
- 正式 Tern 归档必须自带 query/runtime/Skill 资源；冷安装不得借用 checkout、全局 CLI 或旧中央 Skill 目录补齐缺失内容。
- artifact runner 会重建当前查询和文档投影；不要与源码/构建更新并行，让版本归属明确。
- `release --dry-run` 与 `--precheck` 在返回计划前仍会 fetch/prune tags 和查询 npm；`--no-push` 仍会创建本地 release commit/tag。只用临时测试 repo 验证发布行为。
- 本地测试不是 npm Trusted Publishing、线上 release 或远端 CI 成功的证明；需分别回读对应真实结果。
- 保留证据仓库，不执行永久删除、git clean/reset 来清理。
