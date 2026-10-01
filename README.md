# dsh-context-tamer

DSH 上下文降本插件：让长项目会话成本可控、输出不截断、换会话不丢细节。

## 解决的问题

- 上下文涨到几百 k，每轮 token 成本指数上升
- 输出频繁截断，重试白烧钱
- 重开对话怕丢细节，不敢换会话
- 多个项目共享一个工作区时，交接内容互相串

## 功能

- **实时上下文预算**：输入框下方状态芯片显示最近一步的真实上下文估算（含缓存读/写），绿/黄/红三档阈值预警，可调阈值持久化在 profile 条目配置（不依赖浏览器存储）
- **一键无感切换**：点「继续」→ 自动为**当前会话**生成专属交接文件（含最近对话摘要、统计、文件树、git log）→ 新会话自动选中该项目工作区 → 自动把带交接文件绝对路径的简短提示词写入输入框，待你补充任务后发送
- **每会话独立交接文件**：`~/.dsh/storages/handoffs/session-<hash>.md`，按会话追踪，同工作区多项目不再混淆；模型手动填写的 cwd 主交接文件永不覆盖
- **`/handoff` 命令**：宿主侧直接生成交接骨架到 `~/.dsh/storages/handoffs/`，项目目录保持干净
- **自动保鲜**：每轮结束自动刷新交接文件（只覆盖插件自己写的内容，模型填写的不动）
- **自动清理**：只保留最新 50 个会话交接文件、且只删 7 天前的（刚生成的文件永远不在删除范围）；cwd 主交接文件永不删除
- **Git 自动提交检查点**（可开关）：开启后，每轮结束时若距上次提交超过设定间隔，把**会话工作区**（会话 cwd）整体打一个检查点提交；点「继续」切换会话时强制提交一次（节流照旧生效于间隔）。安全护栏齐全：先探测 `git rev-parse --is-inside-work-tree`、工作区干净则跳过、提交时 `commit.gpgsign=false`（免 unattended 环境下的 GPG 签名卡住）、失败按 cwd 只警告一次并退避，任何异常都不会打断回合。默认关闭；间隔（分钟）与提交说明都在芯片弹层里可改

## Git 自动提交的启用与配置

芯片弹层里勾选「Git 自动提交（每轮结束检查点）」即开启，下方两栏分别是：

- **间隔（分钟）**：两次自动提交的最小间隔（1 ~ 1440，默认 5）
- **提交说明**：自定义 checkpoint 提交的 message（默认 `checkpoint: auto commit (dsh-context-tamer)`）

语义与边界：

- 只操作**会话的工作目录**（`session.header.cwd`），不碰 `~/.dsh` 自己
- 非 git 仓库 / 没有改动 / git 不在 PATH：安静跳过（首次失败会记一条日志，之后静默）
- 提交用 `git add -A`：尊重仓库自身的 `.gitignore`，未跟踪的敏感文件不会被误提交（前提是它们被正确 ignore 了）
- 与用户自己的提交节奏互不干扰：它只做「追加检查点」，不改写历史

## 交接文件管理

- 位置：`~/.dsh/storages/handoffs/`
  - `session-<hash>.md`：每次「继续」为当前会话生成，自动清理（保 50 新、删 7 天旧）
  - `<cwd-hash>.md`：按工作目录归一的交接文件（`/handoff` 命令与自动保鲜写入；模型填写后视为手写内容，永不覆盖、永不删除）
  - `index.json`：工作目录 → 交接文件 索引，新会话按 SOP 自动查找
- 不想保留某项目的历史：直接删 `~/.dsh/storages/handoffs/` 下对应文件即可，插件会自动重建

## 原理

记忆从聊天记录迁移到文件系统：会话只背当前状态，交接文档承载项目全貌，历史随 DSH 会话存档可查。继续流程：点击时先把当前会话的最近对话摘要与统计落盘为新交接文件 → 切换工作区 → 注入带该文件绝对路径的提示词，AI 精确读到当前项目的上下文。

## 安装（DSH ≥ 0.2.0：插件即 bundle）

1. `pnpm install`（zod）
2. junction 到 `~/.dsh/profiles/desktop/node_modules/dsh-context-tamer`
3. 在 `~/.dsh/profiles/desktop/package.json` 登记：`dependencies` 加 `dsh-context-tamer`（版本号），`dsh.profile.bundles` 加 `dsh-context-tamer`（排在两个内置 bundle 之后）
4. 重启桌面端 + 刷新页面（本包自带 `dsh.bundle.patch`，无需再写用户层 insert）

## 接口约定

- `GET/POST /dsh-context-tamer/config`：阈值（1000 ~ 1e8）、autoCommit、autoCommitIntervalMin（分钟）、autoCommitMessage
- `POST /dsh-context-tamer/continue`：为指定会话生成交接文件，返回 `{ cwd, handoffFile, stats }`（若开启自动提交，此处会强制提交一次检查点）
- `GET /dsh-context-tamer/sessions`：诊断端点，列出 live 会话 id → cwd
- 投影 key `contextTamer`：上下文估算与轮次/消息/工具事件计数

