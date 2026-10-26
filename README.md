# dsh-novel-write-engine

把小说创作的「状态、门禁、规则、账本」从提示词搬进代码的 DeepSeek Harness 插件。

- 18 个 `novel_*` 工具、5 条 `/novel*` 命令、1 个侧边栏面板「网文工坊」、1 个内置 Agent 预设。
- 单一写入口 `EngineService`：门控先于写盘，归档是一次事务。
- 规则包与任务书外置，改阈值或写作指导不用改代码。

## 安装

```bash
npm install dsh-novel-write-engine
```

在 profile 的 bundle 列表里加入 `dsh-novel-write-engine`，重启 DSH。插件声明了 `dsh.bundle.patch`（两层：根行 + 内置预设）与 `dsh.client`（Web 面板）。

要求：Node ≥ 24.9，DSH `>=0.2.1-rc.2 <0.3.0`（`engines.dsh`）。

## 快速开始

在任意空目录里对模型说「开一本都市文，书名《…》」，或直接调用：

1. `novel_init` — 建项目（`novel.yaml` + `state/`）。
2. `novel_brief P1` → `novel_plan_world`
3. `novel_brief P2` → `novel_plan_chapter`
4. `novel_brief P3` → `novel_write_draft`
5. `novel_brief P4` → `novel_review`
6. 有 blocker：`novel_revise`；没有：`novel_brief P6` → `novel_check`
7. `novel_brief P8` → `novel_archive`（必须带 `state_delta`，逐实体核销）
8. `novel_export md|txt|epub`（单章导出为 `exports/book-chNNN.<kind>`）

面板在左侧栏「网文工坊」，只读：项目头、章节表、阻塞区。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `projectRoot` | `.` | 默认项目根；工具可用 `project_root` 覆盖 |
| `minScore` | `120` | PG-07 过关线，唯一 owner |
| `toolsMode` | `all` | `core` 只注册 8 个高频工具，其余走 `/novel admin <op> <json>` |
| `briefsOverrides` | 空 | 自定义任务书目录；空则使用随包 `briefs/` |
| `backupRetention` | `5` | 保留的归档备份目录数 |
| `stateDir` | `~/.dsh/novel-write-engine` | 多项目注册表位置 |

0.1.0 仅提供中文界面与任务书；不随包发布 `locale/`。规则包固定从包内加载，不接受运行期外部路径。

## 内置预设

「网文工坊」是一个**会话类型**：工具全开，但没有 bash / 文件写入 / 计划模式 —— 正文只能经引擎写。会话开始后不能切换预设。

## 开发

```bash
pnpm install
pnpm typecheck          # host + client
pnpm test               # 单元 + 集成 + e2e
pnpm test:coverage      # 四项 ≥85%，分层门槛见计划
pnpm build              # host → client → client d.ts
pnpm test:isolated      # 每个源文件独立编译
pnpm validate:rulepack  # 需先 build
pnpm check:pack         # 需先 build
```

设计文档：[DESIGN.md](DESIGN.md)；实施计划：[PLAN.md](PLAN.md)。

## 许可

MIT
