# dsh-novel-write-engine 设计书

| 项 | 值 |
|---|---|
| 插件版本 | `0.1.0` |
| 目标仓库 | `https://github.com/ThzxxArt/dsh-novel-write-engine` |
| 协议 | MIT |
| 目标宿主 | DeepSeek Harness `>=0.2.1-rc.2 <0.3.0`，Node `>=24.9.0` |
| 验证基线 | DSH `0.2.1-rc.3`、Cordis `4.0.5`、Schemastery `3.18.5` |
| 硬约束 | 不依赖 Python、不做数据库、除正文外全部 YAML/JSON、**运行时不依赖任何外部技能文件**、**测试覆盖率 ≥85%** |

---

## 0. 一页纸

### 0.1 一句话

**一个不调用 LLM、不写数据库、只依赖一个 YAML 库的确定性「小说创作流水线内核」**：把多智能体写作流程里的**状态、门禁、规则、账本**从提示词搬进代码，模型只负责「写」与「判」，其余由引擎机械保证。

### 0.2 是什么 / 不是什么

| 是 | 说明 |
|---|---|
| 状态机 | 9 个命名阶段、迁移表数据化、非法迁移直接拒绝、断点可续 |
| 账本 | 角色/伏笔/时间线/关系/资源/章节索引，全部是正文的「影子」 |
| 门禁 | 12 条机器可判定的门控（PG-01~PG-12），任一不过即阻塞 |
| 规则引擎 | 字数、标点、格式、词表、节奏、跨章、一致性——约 30 条可机检规则 |
| 事务器 | 归档是一次原子提交（暂存→校验→提交→读回），不是「写一堆文件祈祷成功」 |
| 服务 | 22 个服务操作，同时被工具、命令、面板、任务书四条通道复用 |

| 不是 | 原因 |
|---|---|
| 不是第二个「技能包」 | 9 份阶段文档常驻上下文代价高；本引擎按需下发任务书 |
| 不是 LLM 编排器 | `apply` 里不能等长任务；模型自己决定是否派 subagent |
| 不是数据库 | 无 SQLite、无 ORM；状态是 YAML + 一份 JSONL 日志 |
| 不是 Python 包装 | 零 Python、零子进程；全 TypeScript |
| 不是 Web 应用 | 自带只读面板，不提供独立路由、不上公网 |

### 0.3 关键数字

```
阶段        9 个（模型执行 6 个，事务执行 3 个）
门控        12 条（PG-01 ~ PG-12）
服务操作    22 个（18 工具 + 3 面板投影 + 1 统计投影）
分层        6 层（L0 类型 / L1 领域 / L2 规则 / L3 存储 / L4 引擎 / L5 适配）
评分        15 维 / 满分 150 / 合格 120
循环上限    评审-修复 3 轮，校验-修订 3 轮
字数口径    total_word_count = 汉字 + 英文单词 + 数字 + 标点
文件        YAML 9 个 + JSONL 1 个 + 正文 Markdown N 个
运行时依赖  1 个（yaml）
斜杠命令    5 条
客户端半边  1 个面板（「网文工坊」）
Agent 预设  1 个（「网文工坊」）
覆盖率门禁  全局 85%，纯函数层 100%
```

### 0.4 架构一句话

```
模型 ──tool──▶ 适配层 ──▶ EngineService ──▶ 规则(L2) ──▶ 结果
                            │
                            ├─▶ 见证书  chapters/chapter-NNN.md   （唯一真实来源）
                            ├─▶ 影子    state/*.yaml              （由正文派生，绝不反向）
                            └─▶ 日志    state/journal.jsonl        （追加式事务轨迹）
```

**四条通道、一个入口**：工具、命令、面板、任务书全部调 `EngineService`，没有任何一条通道能绕过它直接读写文件。这是架构上最重要的一条约束（§2.0）。

### 0.5 章节索引

| 想知道什么 | 看哪里 |
|---|---|
| 它是什么、边界在哪 | §1 |
| 代码怎么分层、谁能调谁 | §2 |
| 与宿主、构建、发布形态的关系 | §3 |
| 项目目录、每个文件长什么样 | §4 |
| 字数怎么算、哪些词违规、怎么判 | §5 |
| 写盘怎么保证不撕裂 | §6 |
| 阶段怎么走、哪一步卡住、证据怎么验 | §7 |
| 技能、任务书、类型指南从哪来 | §8 |
| 模型看到几个工具、怎么调用 | §9 |
| 侧边栏面板与内置预设 | §10、§11 |
| 配置项与工具面预算 | §12 |
| 测试怎么分层、覆盖率怎么算 | §13 |
| 分几片做、怎样算能发版 | §14 |
| 为什么这么定 | §15、附录 A~E |

---

## 1. 定位、原则与边界

### 1.1 三层分离：整套设计的根

整套设计的第一条不变量，不是「9 阶段」，而是：

> **正文是唯一真实来源（SSOT）；角色卡、时间线、伏笔、索引全部是正文的影子，只能被正文写入，绝不反向驱动正文。**

| 层 | 载体 | 谁能写 | 用途 |
|---|---|---|---|
| **见证书** | `chapters/chapter-NNN.md` | 只有 `novel_write_draft` / `novel_revise`，且必须过字数与格式门 | 唯一权威 |
| **影子** | `state/*.yaml` | 只有 `novel_archive` 的事务（模型提交 delta，引擎落盘） | 一致性校验、后续章节上下文 |
| **规划** | `outline/*.yaml`、`plans/*.yaml` | 人可以随便改 | 写作指导，**不是数据来源** |

`novel_amend` 是状态文档的维护通道：只能改 allowlist 内的 `state/*.yaml`，不能写 `chapters/`；不参与阶段门控，但必须给出非空 `reason`。

铁律的落地方式：**引擎没有任何「从 outline 写 state」的代码路径**。大纲里的角色不会自动进角色库——只有正文写了、且归档事务提交了 delta，才会存在。

### 1.2 核心设计理念

| 理念 | 本引擎落地 |
|---|---|
| 正文 SSOT + 数据影子 | 三层分离（§1.1） |
| 数据随写随建 | 归档只接受「本章正文里出现过」的实体；引用未登记实体直接拒绝 |
| 首次描写锁定 | `world.yaml` 的 `locked: true` 字段，`novel_amend` 修改需显式原因 |
| 角色知识边界 | 保留为 **L2 语义规则**（模型判），引擎保证清单不被跳过 |
| 零容忍 | 严重度只有 `blocker` / `advisory`；没有「不阻塞」这个类别 |
| 9 阶段 + 硬门控 | 状态机 + PG-01~PG-12 |
| L1（机检）/ L2（语义）分层 | 引擎只跑 L1；L2 交给模型但**必须带原文证据** |
| 逐字阅读铁律 | 改造为**可验证引用**（§7.7），从口头承诺变成机器校验 |
| 评审-修复循环上限 | 3 轮，超限强制回退 |
| 编号全局唯一、引擎分配 | 模型只提交 key，引擎分配 `FS-001` 并回执 |
| 门控不能被主控自证绕过 | 引擎本身就是那个独立验证者（更强的形态） |
| 义务清单逐条核销 | 归档 delta 必须逐实体声明 `created/updated/no_change+reason`，静默跳过即拒绝 |

### 1.3 明确不做什么

| 不做 | 原因 |
|---|---|
| 常驻阶段文档 | token 成本；改为 `novel_brief` 按需下发 |
| 外部脚本运行时 | 用户硬约束；全部逻辑用 TypeScript 实现 |
| 数据库 | 用户硬约束；守卫的**目的**由「引擎独占写权」实现 |
| 人读型交接文件 | 除正文外全部 YAML；改为 `state/handoff.yaml`，渲染给人看但不落盘为权威 |
| 多份状态文件并存 | 合并进 `state/pipeline.yaml` 与 `state/session.yaml` |
| 「读了文件」式门控 | 没有 require 文件可读；改为「任务书签收」这一更硬的机制 |
| 「不展示就作废」式展示门控 | 工具结果天然可见；展示进 `render`，不需要仪式 |
| 语义模糊的严重度分级 | 只有 `blocker` / `advisory`，结构上没有第三种 |

### 1.4 规则包外置

词表与阈值随题材、平台、读者口味变化很快，因此**不进代码**：

| 层 | 位置 | 谁能改 |
|---|---|---|
| 引擎：规则的种类与求值方式 | `src/rules/` | 只有发版 |
| 规则包：词、阈值、严重度 | `rulepacks/*.yaml` | 用户可改、可增、可替换 |

默认包随插件发布，数值按本设计书定稿（§7.8、§8.2）：清单、词表、阈值全部落成 YAML 的键与值，同一规则只保留一个值（附录 C）。默认包自包含，运行时不引用任何包外文件。

### 1.5 七条设计原则

1. **确定性下沉**：凡是能用代码判定的，绝不交给模型「记得」。
2. **一次事务**：归档要么全成，要么全不动；没有撕裂窗口。
3. **拒绝比容许便宜**：非法迁移、非法字段、未签收任务书，一律显式报错。
4. **证据优先于结论**：模型说「通过了」必须附原文引用，引擎校验引用真实存在。
5. **编号唯一权威在引擎**：模型只产生 key，不产生 ID。
6. **可复盘**：每次写盘都有 journal 记录，任何状态可追溯到哪次操作。
7. **零外部副作用**：不联网、不调模型、不起子进程、不读环境变量当配置。

### 1.6 独立性

| 项 | 结论 |
|---|---|
| 运行时依赖 | **零**。不 import、不读、不引用任何外部技能目录或外部文件；知识在构建期折叠进 `src/skills/` 的入口技能与 `briefs/` 的任务书 |
| 规则包 | 随包发布，构建期做完整性校验（§8.4）；运行时不读包外路径 |
| 生命周期 | 插件自足：安装即可用，卸载无残留；不依赖任何其他插件的存在 |
| 命名 | 技能 `novel-write-engine`；工具前缀 `novel_`；事件前缀 `novel/`；命令 `/novel` |
| 共存 | 与本插件之外的任何创作工具无关；profile 里不必禁用任何东西 |

---

## 2. 架构

### 2.0 分层要解决的六个问题

| # | 问题 | 后果（如果不解决） |
|---|---|---|
| A1 | 逻辑写在适配器里 | 命令、面板、任务书各自复制一份取数与校验 → 四份实现漂移 |
| A2 | 规则与门控混写 | 规则要读 pipeline，门控要调规则，互相 import，纯函数层被污染 |
| A3 | 状态机是文字画的图 | 迁移表无法穷举测试，非法迁移只能靠人眼 |
| A4 | 没有只读投影层 | `status` / 命令 / 面板各读各的文件，字段一改三处不同步 |
| A5 | 没定义并发模型 | 同进程两个工具调用并发写同一项目 → staging 互相覆盖 |
| A6 | 测试没有口径 | 覆盖率退化成一句口号 |

对应修正：A1→§2.5+§2.6，A2→§2.1+§5，A3→§7.2，A4→§2.5，A5→§2.8，A6→§13。

### 2.1 分层

```
┌─────────────────────────────────────────────────────────────┐
│ L5 适配层   tools(18) · commands(5) · remote(3) · skill(1)   │ 薄壳：窄化 + 渲染
├─────────────────────────────────────────────────────────────┤
│ L4 引擎     EngineService：22 个操作 · 门控执行 · 任务书组装  │ 唯一编排者
├─────────────────────────────────────────────────────────────┤
│ L3 存储     FsStore：原子写 · 事务 · 锁 · 迁移 · 项目注册表    │ 唯一 IO
├─────────────────────────────────────────────────────────────┤
│ L2 规则     RulePackCompiler · 规则注册表 · 求值流水线        │ 纯函数，零 IO
├─────────────────────────────────────────────────────────────┤
│ L1 领域     字数 · 分段 · 评分算术 · SimHash · 迁移表         │ 纯函数，零 IO
├─────────────────────────────────────────────────────────────┤
│ L0 类型     types · codes · constants                        │ 零运行时
└─────────────────────────────────────────────────────────────┘
```

**数据只以纯值穿过层**：`ChapterText`、`Violation[]`、`Metrics`、`Snapshot`。`store` 只认识「可序列化的结构 + revision」，不认识规则；`rules` 只认识文本，不认识磁盘。

### 2.2 模块清单

| 模块 | 职责 | 依赖 | 有 IO | 测试方式 |
|---|---|---|---|---|
| `src/types.ts` | 全部跨层类型、常量、错误码 | — | 否 | 类型检查 |
| `src/domain/` | 字数、分段、句长、SimHash、评分算术、迁移表 | types | 否 | 纯单测 + 表驱动 |
| `src/rules/` | 规则包编译、规则注册表、求值流水线、严重度 | types, domain | 否 | 纯单测 + golden |
| `src/store/` | 原子写、事务、锁、schema 加载、迁移、注册表、备份 | types | **是** | 真实 tmpdir + 故障注入 |
| `src/engine/` | 22 个操作、门控、任务书、只读投影、journal | 全部下层 | 间接 | 集成（真 store + 真 rules） |
| `src/tools/` | 18 个 `defineTool`：窄化 → 调 op → 规范值 → render | engine | 否 | 假 engine（spy） |
| `src/commands/` | 5 条斜杠命令 | engine | 否 | 假 engine |
| `src/remote/` | 3 个只读投影 + DTO 版本 | engine | 否 | 假 engine + 形状断言 |
| `src/skills/` | 1 份入口技能正文 | — | 否 | 快照 + 字数上限 |
| `src/client/` | 侧栏入口 + 面板（view model 独立可测） | desktop 类型 | 否 | DOM + 假 ctx |
| `src/index.ts` | 装配：建 store → 建 engine → 注册适配器 | 全部 | 否 | 集成冒烟 |

### 2.3 依赖规则（由测试固化，不靠自觉）

| 编号 | 规则 | 违反后果 |
|---|---|---|
| R1 | 只有 `store/` 与 `index.ts` 可以 `import 'node:fs'` | 造成两套写盘语义 |
| R2 | `domain/`、`rules/` 不得 import `store/`、`engine/`、`node:*` | 纯函数层被污染，无法穷举测试 |
| R3 | `tools/`、`commands/`、`remote/` 只能 import `engine`，不得 import `store` | 绕过服务层，出现第二写入路径 |
| R4 | 同一规则码只能有一个实现（注册表唯一） | 重复计罚、口径漂移 |
| R5 | 层间只传纯数据：不传 `ctx`、不传类实例、不传函数 | 无法序列化、无法快照 |
| R6 | 客户端不得 import 任何 Host 侧模块（`node:*`、`store`、`engine`） | 打包失败或体积爆炸 |

**固化方式**：`tests/arch.spec.ts` 扫描 `src/` 下每个 `.ts` 的 import 语句，按上表断言。这是**普通单测**，不需要额外工具，跑得比 lint 还快。

> 这条设计的意义：架构文档会过期，测试不会。把「分层」写成断言，比写在文档里强一百倍。

### 2.4 运行时对象图

```ts
export function apply(ctx: Context, config: Config) {
  const store    = new FsStore(config)                    // 懒连接，不读盘
  const pack     = compileRulePack(config.rules)          // 编译 + 冻结 + 自校验
  const clock    = systemClock                            // 可注入，测试用假时钟
  const events   = new EventBus()                         // 3 个事件
  const engine   = new EngineService({ store, pack, config, clock, events, logger: ctx.logger })

  ctx.effect(() => () => engine.dispose())                // 卸载：刷 journal、释放锁

  registerTools(ctx, engine)                              // 18
  registerCommands(ctx, engine)                           // 4
  registerRemote(ctx, engine)                             // 3
  ctx.skills.register(ENTRY_SKILL)                        // 1

  // 发布门禁（不依赖宿主）：DSH_BUNDLE_ROOT=... pnpm check:preset
  // 运行时只注册工具/命令/skill/panel；不读取宿主预设内部结构。
}
```

**约束**：

| 项 | 规则 |
|---|---|
| 配置 | 只经 `apply(ctx, config)` 闭包传入，不读 `process.env` |
| 状态 | 全部在 `EngineService` 实例内；**禁止模块级 `new Map()`** |
| 预热 | `apply` 不做 IO：不建目录、不读项目文件、不联网 |
| 清理 | 锁与监听器经 `ctx.effect` 托管，卸载自动释放 |
| 失败 | `apply` 只在**配置非法**时抛错；项目不存在是「操作错误」，不是装配错误 |

### 2.5 服务操作契约（22 个）

**这是全系统的唯一入口**。工具、命令、面板、任务书都只能调这些操作。

| 类别 | 操作 | 写盘 | 门控依赖 | 幂等键 |
|---|---|---|---|---|
| 生命周期 | `initProject` | 是 | — | 项目根路径 |
| | `archiveChapter` | 是（事务） | PG-01~12 | `(chapter, contentHash)` |
| | `amend` | 是 | PG-01 | `(target, path, 期望 revision)` |
| | `rollback` | 是 | — | `(chapter, toStage)` |
| 提交 | `submitWorldPlan` | 是 | PG-01/02/11 | `(chapter, digest)` |
| | `submitChapterPlan` | 是 | PG-01/02 | `(chapter, digest)` |
| | `submitDraft` | 是 | PG-01/02/03/04/05/06 | `(chapter, contentHash)` |
| | `submitReview` | 是 | PG-01/02/07/09/11 | `(chapter, round, contentHash)` |
| | `submitRevision` | 是 | PG-01/02/03/04/08/09 | `(chapter, round, contentHash)` |
| | `runCheck` | 是 | PG-01/02/10 | `(chapter, contentHash)` |
| 查询 | `getStatus` | 否 | — | — |
| | `getBrief` | 是（仅 `briefs` 字段，幂等） | — | `(stage, chapter, stateDigest)` |
| | `countWords` | 否 | — | — |
| | `queryState` | 否 | — | — |
| | `diff` | 否 | — | — |
| | `auditHistory` | 否 | — | — |
| | `advise` | 否 | — | — |
| | `export` | 是（导出目录） | — | `(kind, chapter)` |
| 投影 | `panelSummary` | 否 | — | — |
| | `panelChapters` | 否 | — | — |
| | `panelGates` | 否 | — | — |
| | `stats` | 否 | — | — |

**契约形状**（所有操作统一）：

```ts
interface OpResult<T> { data: T; revision: number; warnings: Warning[] }

// 失败只有三种，见 §2.9
```

四条硬规定：

1. **写操作返回新 revision**，调用方不需要自己读回。
2. **幂等**：同一幂等键重复提交，第二次返回第一次的结果并标记 `replayed: true`（不做二次写盘）。
3. **门控先于写盘**：任何写操作内部顺序固定为「校验 → 门控 → 计算 → staging → 提交」，任一失败则文件系统零变更（由测试证伪，见 §13.5）。
4. **中止检查**：写操作在提交前检查 `exec.signal.aborted`；已中止则抛 `ENGINE_TXN_ABORTED`，staging 丢弃、零写盘。

### 2.6 四个适配器

| 适配器 | 做什么 | 不做什么 |
|---|---|---|
| Tool（18） | 参数窄化 → 调 op → 组装规范值 → `render` 成卡片 | 不读文件、不做校验、不算字数 |
| Command（5） | 解析参数 → 调 op → 输出 Markdown | 不引入第二数据路径 |
| Remote（3） | 调投影 op → 组装 DTO（带 `schemaVersion`） | **没有任何写方法**（接口层面就没有，INV-10） |
| Skill（1） | 一段 Markdown：何时用、怎么驱动、路由表 | 不含阶段知识（那由 `novel_brief` 投递） |

**为什么工具不能直接读文件**：一旦允许，模型就能绕过门控拿到「未经校验的正文」，然后基于它做判断。适配器薄，是为了让「唯一入口」成为事实而不是约定。

### 2.7 一次归档的调用链

```
模型 → novel_archive(tool)
        └─ 参数窄化（schema 校验，失败即 ToolArgsError）
        └─ engine.archiveChapter(input)
             ├─ keyedMutex(projectRoot) 串行化          ← 进程内
             ├─ FileLock(.engine.lock)                   ← 跨进程
             ├─ store.loadSnapshot()                     ← 读 pipeline/state/正文
             ├─ gates.evaluate(PG-01..PG-12)             ← 纯函数
             │    └─ 任一不过 → throw EngineBlockedError（零写盘）
             ├─ rules.run(full)                          ← 重跑全量机检，不信任旧结果
             ├─ delta 核销 + ID 分配                      ← 纯函数 + 计数器
             ├─ txn.stage(files)                         ← 写 .staging/<txid>/
             ├─ txn.verify()                             ← 三端一致性
             ├─ txn.commit()                             ← 备份 → rename → journal
             ├─ txn.readback()                           ← 重算 hash 比对
             └─ return { data: { assignedIds, metrics, verdict }, revision }
        └─ render：章节结算卡
```

**这张图是验收依据**：任何一个实现如果出现了图里没有的写盘点，就是架构违规。

### 2.8 并发模型

| 场景 | 机制 | 行为 |
|---|---|---|
| 同进程、同项目、多个写操作 | `KeyedMutex`（按 `projectRoot` 分键） | 串行；第二个排队等待，不失败 |
| 同进程、不同项目 | 不同 key | 真并行 |
| 跨进程（两个 DSH 实例） | `.engine.lock` 文件锁（O_EXCL + pid + 时间戳） | 后来者等锁，超时抛 `ENGINE_LOCK_TIMEOUT` |
| 只读操作 | 无锁 | 读 `revision`，写操作递增；读到中途变更则重试一次 |
| 工具被并发调用 | 同上 | 写串行、读无锁 |

**为什么不做「乐观锁 + 重试」**：创作项目是低频写（一章一次），串行化的代价可以忽略；而重试会掩盖「两个模型同时改同一章」这种需要人知道的事故。

### 2.9 错误三分类

| 类别 | 语义 | 谁的责任 | 载体 | 工具层表现 |
|---|---|---|---|---|
| `EngineInputError` | 参数或前置条件不对（阶段不对、项目不存在、delta 引用了不存在的实体） | 模型 | `code` + `hint` | 抛错，消息含「下一步调什么」 |
| `EngineBlockedError` | 门控没过（字数不够、分数不足、证据无效） | 内容 | `code` + `details[]` + `hint` | 抛错，`details` 结构化列出每条阻塞 |
| `EngineFaultError` | 系统故障（IO 失败、schema 过新、锁超时、事务中止） | 环境/代码 | `code` + `cause` | 抛错 + `logger.error`；建议用户查目录 |

**错误码表**（前 12 条，完整表在 `src/types.ts`）：

```
ENGINE_PROJECT_NOT_FOUND / ENGINE_PROJECT_EXISTS / ENGINE_STAGE_ORDER
ENGINE_GATE_BLOCKED / ENGINE_READING_PROOF_INVALID / ENGINE_SCORE_MISMATCH
ENGINE_DELTA_UNVERIFIED / ENGINE_SCHEMA_TOO_NEW / ENGINE_SCHEMA_INVALID
ENGINE_PATH_ESCAPE / ENGINE_LOCK_TIMEOUT / ENGINE_TXN_ABORTED
ENGINE_RULEPACK_INVALID / ENGINE_ID_EXHAUSTED
```

**为什么分三类而不是一个 `Error`**：三类对应三种完全不同的修复动作——改参数、改正文、查环境。混在一起，模型会拿「查环境」的办法去修「字数不够」。

### 2.10 扩展点与事件

| 扩展点 | 形态 | 用途 |
|---|---|---|
| 规则包 | 外置 YAML + 编译器校验 | 换词表、调阈值，不改代码 |
| 阶段任务书 | 外置 Markdown/YAML | 改写作指导，不改代码 |
| 事件 | 3 个：`novel/archived`、`novel/blocked`、`novel/amended` | 供其他插件订阅（统计、通知） |
| 服务注入 | `ctx.provide('novelEngine', engine)` | 高级插件可直接调操作 |
| 面板 | `novel-workshop` 单页 | 只读；未来可加「继续写」按钮（发消息，不写文件） |

事件载荷都带 `schemaVersion` 与 `projectRoot`，不允许出现文件绝对路径以外的敏感信息（如正文全文）。

### 2.11 架构不变量（INV）

| 编号 | 不变量 | 谁守 | 怎么测 |
|---|---|---|---|
| INV-01 | 正文只能经 `submitDraft` / `submitRevision` / `amend` 写 | engine 私有写方法 | 扫描 store 的写入调用点；集成测试断言其他路径 0 写 |
| INV-02 | `state/` 只能经 `archiveChapter` 事务写 | engine | 同上 + 目录 mtime 断言 |
| INV-03 | 门控失败时文件系统零变更 | engine 顺序 | 注入必失败门控，比对目录快照 |
| INV-04 | 每次写盘对应 journal 一条 txid | store | 随机 100 次写，断言 txid 一一对应 |
| INV-05 | ID 只由引擎分配，单调且不重复 | domain | 并发 100 次分配，断言集合大小 |
| INV-06 | `revision` 单调递增，写操作 CAS | store | 并发写，断言无覆盖 |
| INV-07 | 同一规则码只有一个实现 | rules 注册表 | 重复注册直接抛错 |
| INV-08 | `domain`/`rules` 零 IO | 分层 | `arch.spec.ts` |
| INV-09 | 路径不出 `projectRoot` | store | 恶意路径矩阵 |
| INV-10 | 面板只读 | remote 接口 | 类型断言 + 运行时无写方法 |
| INV-11 | 名字前缀唯一（工具/事件/技能） | 装配 | 注册时检查冲突清单 |
| INV-12 | 每个落盘文件带 `schema_version` | store | 遍历 fixture 校验 |

### 2.12 备选架构与否决理由

| 方案 | 否决理由 |
|---|---|
| 纯提示词（技能包） | 没有机械保证；状态、字数、门控全靠模型自觉——正是要解决的问题 |
| 一个大工具 + `action` 枚举 | schema 分支爆炸，模型命中率低，错误无法定位到环节 |
| 插件内跑 LLM 编排 | `apply` 阻塞、不可中断、不可观测；且绕过宿主的模型选择 |
| SQLite | 用户硬约束；且二进制库不可 diff、不可手改、迁移成本高 |
| 每阶段一个常驻技能 | token 成本高，且模型会在错误阶段加载错误文档 |
| 引擎内派发 subagent | 分钟级长任务，失败难恢复，与「工具毫秒级返回」的契约冲突 |
| 直接把逻辑写在工具里 | 命令/面板/任务书必然复制一遍（A1），四份实现漂移 |

---

## 3. 插件形态与宿主契约

### 3.1 双半边 bundle

```
dsh-novel-write-engine/
├── package.json              # dsh.bundle.patch + dsh.client + engines
├── cordis.patch.yml          # 根行：插入整包
├── presets/
│   └── novel-write-engine.patch.yml   # 预设行（§11）
├── tsdown.config.ts          # host 入口，dts: true，neverBundle
├── tsdown.client.config.ts   # lazy-CJS factory，clean:false
├── tsconfig.json
├── tsconfig.client.json
├── src/                      # §2.2 的十一个模块
├── rulepacks/default.yaml
├── briefs/{P1,P2,P3,P4,P5,P6,P8}.md
├── skills/entry.md
├── tests/
└── README.md
```

`package.json` 关键字段：

```jsonc
{
  "name": "dsh-novel-write-engine",
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "files": ["lib", "rulepacks", "briefs", "skills", "presets", "README.md", "LICENSE"],
  "exports": {
    ".":        { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": {
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-sidebar", "@deepseek-ai/dsh-client-ui-layout"], "external": ["react", "react/jsx-runtime"] },
    "bundle": { "patch": ["./cordis.patch.yml", "./presets/novel-write-engine.patch.yml"] }
  },
  "engines": { "dsh": ">=0.2.1-rc.2 <0.3.0", "node": ">=24.9.0" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.3",
    "@deepseek-ai/schemastery": "~3.18.5"
  },
  "dependencies": { "yaml": "^2.6.0" }
}
```

**不引 zod / ajv / lowdb**：Config 用 Schemastery（宿主已有，避免双实例）；运行时产物校验用手写窄化函数（字段数有限，手写更小、错误信息更可控）。

### 3.2 生命周期与状态归属

| 状态 | 放哪 | 为什么 |
|---|---|---|
| 配置 | `apply(ctx, config)` 闭包 | 指南 §4.2 |
| 项目根解析结果 | `EngineService` 实例字段 | HMR 后重建是正确语义 |
| 写锁句柄 | `ctx.effect(...)` 托管 | 卸载自动释放 |
| 规则包（已编译） | `EngineService` 实例字段 | 编译一次，全生命周期复用 |
| 缓存（快照、outline 解析） | 实例字段 + `revision` 校验 | **禁止模块级 Map**（指南 §13） |

### 3.3 为什么用 `node:fs` 而不是 `ctx.fs`

| 需求 | `ctx.fs` | `node:fs/promises` |
|---|---|---|
| 读/写文本 | ✅ | ✅ |
| 原子写 | ✅（内部 tmp+rename） | 需自己实现 |
| 版本守卫（CAS） | ✅ `replaceIfVersion` | 需自己实现 |
| **建目录** | ❌ 无 `mkdir` | ✅ |
| **删目录/改名** | ❌ | ✅ |
| **fsync 后 rename 的完整控制** | ❌ | ✅ |
| **多文件事务（staging 整体提交）** | ❌ 无此概念 | ✅ |

`FileSystem` 抽象只有 `resolve/stat/lstat/readText/streamText/readBytes/readByteRange/listDir/writeText/editText`（本机 `packages/fs/fs/src/index.ts` 实测），**没有目录创建与多文件事务**。而本引擎的核心价值就是「一次事务」，用 `ctx.fs` 等于在上层再拼一个事务层，两套写盘语义打架。

**代价与对策**：失去宿主的沙箱。所以 `Store` 必须自己满足三条（§6.2）：路径围栏、原子写、可替换接口。

### 3.4 与 DSH 原语的关系

| 原语 | 用不用 | 说明 |
|---|---|---|
| `ctx.tools` | ✅ | 18 个工具 |
| `ctx.skills.register` | ✅ 1 个 | 入口技能 |
| `ctx.commands` | ✅ 5 条 | 斜杠命令 |
| `ctx.subagents` | ❌ | 不派发；由模型用原生 `subagent` 决定 |
| `ctx.jobs` | ❌ | 所有操作毫秒级 |
| `ctx.fs` | ❌ | 见 §3.3 |
| `ctx.logger` | ✅ 少量 | 只记装配期与事务期（注意指南 §11.2：不一定出现在终端） |
| `ctx.agentPresets` | ❌ | 不注册、不自检；预设由补丁注册，发布门禁 `check:preset` 验名 |
| 客户端半边 | ✅ | `sidebar.panellist` + keyed `main` |

### 3.5 命名与类型合并纪律

- 工具名 `snake_case`、动词开头、`novel_` 前缀。
- 事件一律 `novel/` 前缀（3 个）。
- 每个源文件**自己**声明所需类型合并（`import type {} from '@deepseek-ai/dsh-tools'` 等），并用**隔离编译**验证（指南 §11.5 实测：聚合编译会掩盖缺失的声明合并）。
- 客户端每个文件自声明 `import type {} from '@deepseek-ai/dsh-client-ui-*'`，否则 `ctx.slots` / `ctx.locale` 直接 `TS2339`。

### 3.6 构建链（三条硬约束）

| 约束 | 内容 | 违反后果 |
|---|---|---|
| manifest | `exports["./client"]` + `dsh.client` | 浏览器不加载半边 |
| bundle 格式 | 手写 lazy-CJS factory：`window.__ModuleLoader__.load({ id: "<包名>", factory })` | id 与包名不等 → 半边挂不上 |
| 构建顺序 | `tsdown`(host, clean:true) → `tsdown -c client`(clean:false) → `tsc -p tsconfig.client.json` | 顺序反了会把 host 产物删掉 |

另外两条反直觉约束：patch 行必须写**裸包名**（不能写子路径）；一个包拆多行时，半边只挂在**根行**。

---

## 4. 领域模型

### 4.1 项目布局

```
<projectRoot>/
├── novel.yaml                    # 项目定义（人可编辑）
├── outline/
│   ├── outline.yaml              # 卷/幕/章规划（规划层）
│   └── volumes/vol-01.yaml
├── chapters/chapter-001.md       # 正文（唯一 SSOT，纯文本，禁 Markdown）
├── plans/{chNNN.world.yaml, chNNN.chapter.yaml}
├── reviews/chNNN.review.yaml
├── checks/chNNN.check.yaml
├── state/                        # 影子层（只有引擎能写）
│   ├── pipeline.yaml             # 控制流 SSOT
│   ├── chapters.yaml             # 章节索引
│   ├── characters.yaml
│   ├── world.yaml
│   ├── locks.yaml                # 首次描写快照（派生）
│   ├── timeline.yaml
│   ├── foreshadows.yaml
│   ├── relationships.yaml
│   ├── handoff.yaml              # 续写交接
│   └── journal.jsonl             # 追加式事务日志
├── backups/<txid>/               # 归档前快照
└── .engine.lock                  # 写锁（pid + 时间戳）
```

`state/` 与 `chapters/` 分开：影子文件频繁整体重写，正文几乎不变；分开后备份与 diff 噪声小得多。

### 4.2 文件 Schema

统一约定：每个 YAML 顶层有 `schema_version: 1`；未知顶层键**拒绝加载**（防手改静默错误）。

#### `novel.yaml`

```yaml
schema_version: 1
title: "书名"
genre: 都市现代            # 12 类枚举
platform: fanqie          # fanqie|qidian|qimao|jinjiang
author: ""
description: ""
created_at: "2026-10-26T14:00:00+08:00"
targets:
  words_per_chapter: [2000, 3000]
  total_chapters: null
  dialogue_ratio: [0.40, 0.60]
```

#### `state/pipeline.yaml`（控制流 SSOT，唯一）

```yaml
schema_version: 1
revision: 42
chapter: 3
stage: P4
rounds: { review: 1, revise: 0, check: 0 }
briefs:                       # 任务书签收（PG-01 依据）
  P4: { issued_at: "...", digest: "sha256:..." }
blocking:                     # 当前阻塞项（空数组 = 可推进）
  - { code: PG-07, scope: review, detail: "score 118 < 120" }
last_action: { op: "novel_review", at: "...", digest: "sha256:..." }
```

#### `state/chapters.yaml`（章节索引）

```yaml
schema_version: 1
chapters:
  - num: 1
    title: "标题"                # 不含「第1章」前缀，渲染时拼
    file: chapters/chapter-001.md
    word_count: 2480
    dialogue_lines: 62
    dialogue_ratio: 0.41
    scene_type: 日常过渡章
    narrator: "主角"
    score: 126
    status: reviewed            # draft|reviewed
    content_hash: "sha256:..."
    summary:
      events: ["..."]
      characters_appeared: ["主角", "配角A"]
      foreshadows: { planted: [], advanced: [{ key: "fs001", note: "..." }], resolved: [] }
      new_elements: { locations: [], abilities: [], artifacts: [] }
      resource_changes: [{ character: "主角", resource: "铜钱", delta: -200, reason: "ch001 正文" }]
      opening: "前两段原文"
      continuity: { opens_from: "前章结尾原文", ends_with: "本章结尾原文" }
      hook_strength: 4
      pleasure_points: ["打脸反派"]
      plot_advancement: high
```

#### `state/foreshadows.yaml`（生命周期是重点）

```yaml
schema_version: 1
next_seq: 8
items:
  - id: FS-007
    title: "泛黄诊断书"
    planted: 3
    last_touched: 5
    status: dormant            # planted|dormant|advanced|resolved
    resolved_at: null
    description: "..."
    advance_log:
      - { chapter: 5, note: "新线索：日期被改动", new_info: true }
```

`last_touched` + `status` 让「伏笔碎嘴症」从语义判断变成**可机检**：`chapter - last_touched < minDormancy` 且本章又提及 → `FS_REVISITED_TOO_SOON`。

#### `state/characters.yaml` / `world.yaml` / `locks.yaml`

```yaml
# characters.yaml
schema_version: 1
characters:
  - name: "主角"               # 中文姓名即唯一标识，不编号
    role: protagonist          # protagonist|antagonist|supporting|extra|ally|mentor|guardian|herald
    first_appearance: 1
    profile: { identity: "...", traits: ["..."] }
    current_state: { emotion: "...", location: "...", status: "..." }
    growth: [{ chapter: 1, change: "首次出场", status_change: "..." }]
    updated_at: 3

# world.yaml
schema_version: 1
locations:
  - name: "某办公室"
    first_appearance: 1
    locked: true
    description: "..."
    layout: "3 排工位，窗边一排…"
    capacity: 30
    changes: [{ chapter: 15, change: "扩招至 4 排", reason: "公司扩招" }]
abilities: []; artifacts: []; factions: []; rules: []

# locks.yaml（派生：归档时从 characters/world 的首次描写重算）
schema_version: 1
locked_at_chapter: 12
characters: { 主角: { first_appearance: 1, locked_at: 1, appearance: "≤120 字首次描写原文" } }
locations:  { 某办公室: { first_appearance: 1, locked_at: 1, layout: "...", capacity: 30 } }
```

`locks.yaml` **不是新数据源**：内容全部派生，作用只有一个——让 `runCheck(scope=integrity)` 能把「本章对某地点的描写」与「首次锁定描写」做机器比对（相似度低于阈值 → `LOCKED_DETAIL_DRIFT`）。

#### `timeline.yaml` / `relationships.yaml`

```yaml
# timeline.yaml
schema_version: 1
next_seq: 12
items:
  - { id: TE-012, chapter: 3, story_time: "Day 2 清晨", description: "...", location: "...", characters: ["主角"] }

# relationships.yaml
schema_version: 1
next_seq: 4
items:
  - { id: RL-004, a: "主角", b: "配角A", type: 师徒, since: 3, description: "...", evolution: [{ chapter: 5, note: "..." }] }
```

#### `reviews/chNNN.review.yaml`

```yaml
schema_version: 1
chapter: 1
round: 1
content_hash: "sha256:..."      # 绑定被评审的那一版正文
dimensions:
  - { id: R-W-01, max: 15, deductions: [{ rule: NO_MOTIVE, location: "第 12 段", delta: 3, note: "..." }] }
  - { id: R-W-04, max: 20, deductions: [] }
issues:
  - { id: REV-001, severity: blocker, dimension: R-W-04, location: "第 5 段", problem: "...", fix: "...", status: open }
total: 118
```

**分数不是裸数字**：`total = 150 - Σdelta`，每个维度 `score = max - Σdelta`，任一不等即 `ENGINE_SCORE_MISMATCH`。

#### `checks/chNNN.check.yaml`

```yaml
schema_version: 1
chapter: 1
scope: [content, integrity]
content_hash: "sha256:..."
machine:
  violations:
    - { code: SEMICOLON, severity: blocker, location: { paragraph: 3 }, detail: "发现 1 个 ；" }
  metrics: { total_word_count: 2480, non_empty_lines: 152, dialogue_lines: 62, dialogue_ratio: 0.41, paragraph_max: 88 }
semantic:
  items:
    - { id: L2-SCENE-ANCHOR, verdict: pass, evidence: "第 4 段：整层只有他一个人…", note: "已核对" }
verdict: pass
```

**语义项必须带证据**：`evidence` 里的引用，引擎回正文查找；找不到 = 证据无效 = 该 check 不成立。

#### `state/handoff.yaml`

```yaml
schema_version: 1
current_chapter: 3
volume: 1
volume_name: "第一卷"
act: "第1幕"
act_progress: "3/12"
next_chapter: 4
last_summary: "..."
open_hooks: [{ id: FS-007, title: "泛黄诊断书" }]
updated_at: "..."
```

需要给人看时由 `getStatus { format: markdown }` 渲染——**渲染结果不落盘**，避免第二个真相来源。

### 4.3 ID 分配：引擎是唯一权威

模型**永远不写 ID**，只写 `key`：

```yaml
foreshadows:
  create:
    - { key: "diagnosis_note", title: "泛黄诊断书", description: "..." }
  advance:
    - { key: "jade_pendant", note: "日期被改动", new_info: true }
```

引擎分配 `FS-008` 并回执映射：

```json
{ "assigned": { "foreshadows": { "diagnosis_note": "FS-008" } } }
```

**收益**：直接消除「文件侧自行编号导致 ID 漂移」这类缺陷。

编号规则：`FS-` / `TE-` / `RL-` / `WS-` / `IT-` + 三位零填充，全局递增；角色以姓名为主键不编号；溢出不截断（`FS-1000`）。

### 4.4 版本与迁移

- 每个 YAML 带 `schema_version`。
- 加载：`v == 1` 通过；`v > 1` 拒绝（`ENGINE_SCHEMA_TOO_NEW`，防旧版静默降级破坏新数据）；`v < 1` 走迁移链。
- 迁移显式：`src/store/migrate/v1_to_v2.ts`，每次迁移必须带单测 + fixture。

---

## 5. 规则引擎

### 5.1 分层：引擎只判能判的

| 层 | 谁判 | 例子 |
|---|---|---|
| **L1 机检** | 引擎（纯函数） | 字数、标点、Markdown 污染、段落长度、词表命中、句号密度、破折号预算、跨章重复、伏笔休眠、资源负余额 |
| **L2 语义** | 模型（结论必须带原文证据） | 角色知识边界、同章场景逻辑、描写功能性、对话区分度、断章质量、期待值兑现 |

**L2 不是「模型说了算」**：每条结论必须带 `evidence`（原文引用），引擎校验引用存在。这是对「不可验证的自我报告」的唯一反制。

### 5.2 规则包编译器

规则包不是「运行时读一个 YAML」，而是一次**编译**：

```
load(yaml) → narrow(手写窄化) → validate(六条断言) → normalize(平台层→类型层→用户 overrides) → freeze(只读)
```

六条断言（任一失败 → `ENGINE_RULEPACK_INVALID`，拒绝启动）：

1. 15 维满分加总 == 150；
2. 每条规则的 `severity ∈ {blocker, advisory}`；
3. 规则码全局唯一（INV-07）；
4. `exclusions` 互斥对无环、无自指；
5. `platform` 与 `genres` 引用的键都存在；
6. 阈值都在合法区间（如 `0 < similarityBlocker ≤ 1`）。

**为什么编译而不是「用时读」**：规则包是引擎的「法律」，法律必须在启动时验明；运行时才发现 `severity` 拼错，等于让错误规则静默生效。

### 5.3 字数算法（唯一口径）

```
totalWordCount = cjkChars + englishWords + numbers + punctuationTotal

cjkChars         = count(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/)
englishWords     = count(/[A-Za-z]+/)
numbers          = count(/(?<![A-Za-z0-9])[0-9]+(?![A-Za-z])/)
punctuationTotal = chinesePunct + englishPunct
  chinesePunct   = count(/[\u3000-\u303f\uff00-\uffef]/)
  englishPunct   = count(/[^\p{L}\p{N}_\s\u3000-\u303f\uff00-\uffef]/u)

# 辅助量（全引擎唯一定义）
nonWsChars    = count(/\S/)                    # 所有 /500、/100 的分母
totalLines    = text.split('\n').length        # 只此一个口径
nonEmptyLines = lines.filter(l => l.trim() !== '').length
```

要点：

- **标点计入字数**（平台实际计法）；`cjkChars` 单独输出但**绝不作为门槛依据**。
- 数字只计独立数字序列，`ABC123` 的 `123` 不计（避免与 `englishWords` 双计）。
- 全角/半角标点互斥不重叠（常见实现曾因区间重叠系统性偏高；本引擎用 `\p{L}\p{N}` 显式排除）。

> **口径陷阱（实测案例）**：弯引号 `“”`、破折号 `——`、省略号 `……` 都不在两个全角区内，会落进 `englishPunct`——**既被计入字数，又被判为非法引号**。后果：修完标点后字数会**下降**。
>
> 因此门控顺序固定 **先 PG-04（格式）后 PG-03（字数）**：字数只在一份「格式已干净」的正文上判。

> **两个容易混淆的指标必须显式区分**：
>
> | 指标 | 含义 | 用途 |
> |---|---|---|
> | `cjkChars` | 纯 CJK 汉字数 | 参考展示，**不作门槛依据** |
> | `nonWsChars` | **非空白字符数**（含标点、字母、数字） | 所有「/500」「/100」类密度阈值的分母 |
>
> 两者数量接近但含义不同；混用会让密度指标系统性偏移 15–20%。

**对话指标**：

```
dialogue_lines = 含英文直引号 " 的行数
dialogue_ratio = dialogue_lines / nonEmptyLines     // 小数字面量，禁百分比
```

### 5.4 格式规则（blocker 级）

| 规则码 | 判定 |
|---|---|
| `MD_CONTAMINATION` | 出现 `#` / `**` / `---` / `>` / Markdown 表格 |
| `ILLEGAL_QUOTE` | 出现 `“”「」『』` |
| `SEMICOLON` | 出现 `；` |
| `ENGLISH_ELLIPSIS` | 出现 `...` |
| `SCENE_SEPARATOR` | 出现 `———` / `***` / `…………` |
| `LONG_PARAGRAPH` | 单段 `totalWordCount > 90` |
| `TITLE_FORMAT` | 标题非「第X章 + 4~8 字」或含 `#` |
| `SYSTEM_LABEL` | 出现 `Day N` / `第X卷` / 作者名 / 读者称呼 |

### 5.5 词表与规则包结构

```yaml
# rulepacks/default.yaml（节选）
schema_version: 1
name: default
version: "1.0.0"

lexicon:
  zero_tolerance:                 # 命中即 blocker
    - { term: "总而言之", note: "AI 套话" }
    - { term: "不可否认", note: "AI 套话" }
    - { term: "不禁",     note: "AI 套话" }
  soft:                           # 每章 ≤ N 次，超出降为 advisory
    - { term: "犹如", limit: 1 }
  contextual:                     # 按类型放宽
    - { term: "赋能", limit: 2, genres: [都市现代, 游戏系统] }
  meta_narration:                 # 元叙述标记，-4 分且必须改
    - { term: "值得一提的是" }
    - { term: "众所周知" }
  reader_intrusion: [{ pattern: "我们(可以)?看" }]
  god_view: [{ pattern: "这注定是" }, { pattern: "当时的.{0,4}还不知道" }]
  conclusion_first: { verbs: [感到, 觉得, 知道, 明白, 意识到], causals: [因为, 所以, 于是] }

format:
  paragraph_max_words: 90
  forbid_markdown: true
  forbid_semicolon: true
  forbid_english_ellipsis: true
  title: { pattern: "^第\\d+章\\s", min_chars: 4, max_chars: 8 }

punctuation:
  dash:
    base: { 战斗/动作章: 3, 日常过渡章: 4, 情感爆发章: 6, 纯叙事章: 3 }
    scale_words: 3000                       # 预算 × max(1, ceil(字数/3000))
    dialogue_multiplier: 2
  period_density:                           # 每 100 字句号上限
    - { max_words: 19,  limit: null }
    - { max_words: 50,  limit: 6 }
    - { max_words: 90,  limit: 4 }
    - { max_words: null, limit: 3 }
  dialogue_dominant_exempt: true
  ellipsis_runs_max: 10
  uniform_sentence: { run: 3, tolerance: 2, window: [6, 40] }
  consecutive_le_max: 2
  exclamation: { per_chapter: [5, 10], per_paragraph: [1, 2] }

semantics:
  adjective_density_per_500: 5
  adjective_exclude: [快, 慢, 重, 轻]
  pleasure_density_per_500: 1
  plot_nodes_min: 3
  sensory: { min_hits: 3, min_paragraphs: 3, max_words_per_hit: 50 }
  water:
    scene_limits:
      战斗/动作章: { no_progress: 200, psychology: 150, environment: 100, flashback: 300 }
      日常过渡章: { no_progress: 300, psychology: 200, environment: 100, flashback: 300 }
      情感爆发章: { no_progress: 200, psychology: 200, environment: 100, flashback: 300 }
      纯叙事章:   { no_progress: 400, psychology: 300, environment: 150, flashback: 400 }
  opening:
    legal: [O-1, O-2, O-3, O-4, O-5, O-7]
    banned: [WAKE_UP, PURE_ENVIRONMENT, TIME_LABEL, O-6]
    max_words: { O-3: 50, O-4: 200 }

cross_chapter:
  repeat:     { lookback: 3, blocker: 0.90, advisory: 0.75 }  # 实现：duplicate_similarity / duplicate_advisory
  foreshadow: { min_dormancy: 2, max_dormancy: 40, max_mentions_per_chapter: 2 }
  resource:   { min_balance: 0 }
  scene_type: { max_consecutive_same: 2, combat_max_consecutive: 1 }
  narrator:   { protagonist_ratio_min: 0.80, max_switches_per_chapter: 2, supporting_monologue_max: 200 }

exclusions:                       # 同一片段只计最重一项
  - { when: [PURE_ATMOSPHERE, NO_PROGRESSION], keep: PURE_ATMOSPHERE }
  - { when: [STATIC_PSYCHOLOGY, EXCESSIVE_PSYCHOLOGY], keep: STATIC_PSYCHOLOGY }
  - { when: [ENVIRONMENT_OVERLIMIT, PURE_ATMOSPHERE], keep: PURE_ATMOSPHERE }
  - { when: [WAKE_UP_OPENING, WEAK_OPENING_HOOK], keep: WAKE_UP_OPENING }
  - { when: [NO_ENDING_HOOK, WEAK_ENDING_HOOK], keep: NO_ENDING_HOOK }
  - { when: [LITERARY_CLASSICAL, LITERARY_DISEASE], keep: LITERARY_DISEASE }

platform:
  fanqie:   { words_per_chapter: [2000, 3000], dialogue_ratio: [0.40, 0.60] }
  qidian:   { words_per_chapter: [2000, 3500], dialogue_ratio: [0.30, 0.50] }
  qimao:    { words_per_chapter: [1500, 2500], dialogue_ratio: [0.45, 0.65] }
  jinjiang: { words_per_chapter: [2500, 4000], dialogue_ratio: [0.35, 0.55] }

genres:
  都市现代: { note: "现实都市，冲突来自资源、关系与规则；爽点要落在可验证的行动上。" }
  # …其余 11 个类型同样必填，编译器缺一即拒绝
```

> **平台覆盖的是参数，不是规则**：`platform` 只改「字数区间 / 对话占比」，不改「有没有这条规则」。`novel_init` 在调用方未显式给出 `words_per_chapter` / `dialogue_ratio` 时读取它；`genres` 由任务书上下文注入当前类型，不注入全表。

**仓库自带的 `default` 包按本设计书定稿**（§7.8、附录 C）：词条、阈值、严重度全部落成 YAML，同一规则只保留一个值。

严重度分级：

| 规则 | 严重度 |
|---|---|
| 零容忍词 | `blocker` |
| soft / contextual 词超限 | `advisory` |
| 元叙述标记 | `blocker`（且 -4 分） |
| 破折号超预算、句号密度超标 | `advisory` |
| 段落超长 | `blocker` |

### 5.6 节奏画像

`metrics` 里输出结构化画像，供 P4 评审与 P5 修订参考：

```yaml
rhythm:
  dash: { narration: 3, narration_budget: 4, dialogue: 2, dialogue_budget: 8 }
  period_density: { max: 3.2, avg: 2.1, checked_paragraphs: 48 }
  sentence_length: { uniform_runs: 1, longest_run: 3 }
  ellipsis_runs: 4
  comma_ratio: 0.63
  dialogue_dominant_paragraphs: 12
```

### 5.7 跨章规则

| 规则码 | 判定 | 数据来源 |
|---|---|---|
| `CROSS_CHAPTER_REPEAT` | 与近 3 章正文段落相似度 > 阈值 | 正文 |
| `FS_REVISITED_TOO_SOON` | 提及伏笔时 `chapter - last_touched < minDormancy` 且 `new_info=false` | `foreshadows.yaml` |
| `FS_MENTION_OVER_LIMIT` | 同一伏笔本章提及 > 2 处 | 正文 + 台账 |
| `RESOURCE_NEGATIVE_BALANCE` | 累计 `resource_changes` 出现负余额 | `chapters.yaml` |
| `TIMELINE_TIME_REGRESSION` | 故事时间早于前一事件却标为后续章 | `timeline.yaml` |
| `RELATION_UNDECLARED` | 两角色强互动但 `relationships.yaml` 无记录（弱判定） | 正文 + 台账 |
| `CHARACTER_UNKNOWN` | `characters_appeared` 里的角色不在 `characters.yaml` | 索引 |
| `FORESHADOW_DANGLING` | 伏笔埋设后 `maxDormancy` 章未推进/回收 | 台账 |

相似度：**段落级 SimHash + 双阈值**（≥0.90 blocker「复写」；0.75~0.90 advisory「疑似」）。不做全文字符串比对，也不引第三方库（自实现 ~40 行）。

### 5.8 段落级检测流水线（顺序是语义的一部分）

```
① 分段      按 \n 切段，去空段；记录 [start, end) 与字数
② 密度      句号密度、句长序列、破折号计数、省略号 run、形容词计数
③ 引号占比  每段统计引号内字符数 / 引号内句号数
④ 豁免      对话主导段 → 跳过句号密度与句长匀速；对话内破折号单独计预算
⑤ 词表      在剩余文本上跑 lexicon（零容忍 / soft / contextual / 元叙述）
```

**为什么先算引号占比再豁免**：否则只能靠「段落里有没有引号」粗判，会把「一句对白 + 三句叙述」误判为对话段而放过句号密度。

**为什么词表放最后**：被豁免的对话段仍要查词表（角色可以说「不禁」吗？可以——但那是角色声音，所以 `zero_tolerance.term` 支持 `dialogueExempt: true`）。豁免是**逐规则声明**的，不是整段一刀切。

**「段」与「窗口」是两种单位，不能混用**：

| 检测 | 单位 | 为什么 |
|---|---|---|
| 段落长度 ≤90 字 | **段**（空行分隔） | 排版约束 |
| 句号密度 | **段** | 段落级节奏画像 |
| 句长匀速 | **段内句子序列** | 看句子节奏 |
| 水字数（无推进/心理/环境/插叙） | **滑动窗口**（按 `nonWsChars` 累积，跨段） | 阈值 150-400 字；若按单段判而单段上限 90 字，**这些规则永远无法触发** |

常见实现正是在这里出了静默缺陷：水字数把「每行」当段落，而段落上限卡 90 字，导致「单段 >150 字心理描写」在合规文本里永远不成立。本引擎规定：**水字数用滑动窗口，跨段累积，不清零直到命中或超出章长**。

### 5.9 跨章一致性：十一维

| # | 维度 | 判定方式 | 机检度 | 依赖 |
|---|---|---|---|---|
| 1 | 时间连续性 | 故事时间不得倒退；同事件时间一致 | ◐ | `timeline.yaml` |
| 2 | 地点一致性 | 首次描写的布局/特征被遵守 | ○ | `world.locations[].locked` |
| 3 | 角色行为一致性 | 决策与 `profile` 动机吻合 | ○ | `characters.yaml` |
| 4 | 数值一致性 | 资源余额、人数、等级 | ● | `chapters.yaml.summary` |
| 5 | 姓名来源 | 获知全名必须有渠道 | ○ | 正文 |
| 6 | 外貌一致性 | 首次描写后不得改写 | ◐ | `characters.profile` |
| 7 | 物品跟踪 | `IT-` 条目数与持有者流转 | ● | `world.artifacts` |
| 8 | POV 一致性 | `narrator` 与正文人称一致 | ◐ | `summary.narrator` |
| 9 | 章间桥接 | 本章开头承接前章结尾 | ◐ | `continuity.opens_from` |
| 10 | 空间布局 | 同场景人数/位置/可见性不自相矛盾 | ○ | 正文 |
| 11 | 势力人数 | 人数变化必须有原因 | ● | `world.factions` |

● 由 `runCheck` 直接判；◐ 引擎给事实，模型判；○ 模型判且必须附原文证据。

**这张表的意义**：11 维不该全压给模型。引擎直接判 3 维（●），给出事实层让模型判 4 维（◐），模型只需对剩下的 4 维（○）做判断并附原文证据。**机检度不是装饰，它决定哪一层负责**。

> **0.1.0 实现边界**：已落地时间回溯、资源余额、关系未声明、锁定地点描写、重复段落、伏笔休眠/过早回收；POV、章间桥接、姓名来源、空间布局、势力人数与物品流转仍由 P6 的四个语义项覆盖，尚未各自升级为独立规则码。这里明确写出，避免把“设计目标”误读成“已交付”。

### 5.10 十二种类型的关键差异

类型不是「风格标签」，但 0.1.0 的引擎只把它用于**任务书上下文、类型指南与 contextual 词表**；下表的“专项约束”是写作指导，不改变规则阈值。阈值仍由场景类型、平台参数与规则包决定：

| 类型 | 首个卖点位置 | 专项约束 |
|---|---|---|
| 玄幻修仙 | ≤300 字暗示体系 | 突破节奏 3-5 章小成 / 10-15 章大成；等级数值需全程一致 |
| 都市现代 | ≤300 字锚定身份 | 句号密度收紧至 2.5（>90 字段）；商业黑话按 contextual 放宽 |
| 西方奇幻 | ≤300 字完成穿越/入世 | 种族/语言需建条目 |
| 悬疑推理 | ≤300 字抛出异常 | 线索总数 ≤5，关键线索至少埋 2 次；每 2000 字至少 1 个新悬念 |
| 科幻 | ≤300 字展示设定 | 每章新增设定 ≤1 条 |
| 游戏系统 | ≤300 字激活系统 | 任务线 2-3 章一循环；面板 ≤6-8 项（面板不算元叙述） |
| 历史架空 | ≤300 字完成穿越/入场 | 每 10-15 章扩展新领域；历史日期必须与 `timeline` 对账 |
| 无限流 | ≤500 字进入副本 | 单副本 3-5 章；内外规则差异需显式声明 |
| 轻小说 | ≤300 字建立关系 | 对话占比 50%-65%；单章 1500-2500 字（覆盖默认下限） |
| 军事 | ≤300 字进入战斗态势 | 每 2-3 章一场战斗；对话 25%-35%；装备/编制条目化 |
| 末世流 | 前 300 字内爆发 | 句号密度收紧至 2.5；生存资源计入 `resource_changes` |
| 言情 | ≤500 字首次接触 | 亲密关系阶梯 7 级；单次独白 ≤3 段；情感爆发章心理阈值 200 |

**引擎怎么用**：`genre` 决定 `rulepack.genres` 的键，并把该条 `note` 注入任务书上下文；`contextual` 词表可按 `genre` 放宽。表本身是**配置**，不是代码常量。0.1.0 不实现按类型切换数值阈值，避免规则包与代码各存一套口径。

### 5.11 违规输出结构

```ts
interface Violation {
  code: string                 // SEMICOLON / BLACKLIST_HIT / FS_REVISITED_TOO_SOON ...
  severity: 'blocker' | 'advisory'
  location: { paragraph: number; offset?: number; line?: number }
  detail: string               // 人类可读
  metric?: { value: number; limit: number }
  rulePack: string
}
```

**没有 `info` 级别**。常见的 INFO（如爽点为空）不阻塞——本引擎要么 `advisory`（记录不阻塞），要么 `blocker`。不设第三个语义模糊的层级。

---

## 6. 存储层

### 6.1 `FsStore` 接口

```ts
interface Store {
  // 读
  readText(rel: string): Promise<string>
  readYaml<T>(rel: string, schema: Schema<T>): Promise<T>
  exists(rel: string): Promise<boolean>
  list(relDir: string): Promise<string[]>
  stat(rel: string): Promise<{ mtimeMs: number; size: number }>
  // 写（只有 engine 能拿到这些）
  writeAtomic(rel: string, data: string): Promise<void>
  transaction(build: (txn: Txn) => Promise<void>): Promise<TxnResult>
  // 元信息
  revision(): Promise<number>
  projectRoot: string
}
```

`Txn` 提供 `stage(rel, data)`、`remove(rel)`、`verify()`、`commit()`、`readback()`。

**可替换**：`FsStore` 是唯一实现；未来接远端再写第二个，不动上层。

### 6.2 三条硬约束

1. **路径围栏**：所有路径 `resolve` 后必须 `startsWith(projectRoot + sep)`，否则 `ENGINE_PATH_ESCAPE`。同时拒绝 `..`、绝对路径、NUL 字符、Windows 保留名（`CON`/`NUL`/`COM1`…）。
2. **原子写**：同目录 `*.tmp` → `fsync(fd)` → `rename`；目录 fsync（POSIX）以保证 rename 落盘。
3. **schema 校验**：读 YAML 后立刻窄化；未知顶层键拒绝；`schema_version` 越界按 §4.4 处理。

### 6.3 事务七步

```
1. 取写锁（进程内 keyed mutex + 跨进程 .engine.lock）
2. 计算全部新内容 → 写入 .staging/<txid>/
3. 在 staging 内跑三端一致性校验（正文 ↔ 索引 ↔ 影子）
4. 通过 → 备份受影响文件到 backups/<txid>/ → 追加 pending（预期 hash）→ 逐个 rename 覆盖
5. 读回校验：重读文件、重算 hash、与预期比对
6. 追加 committed（结果 + 文件清单 + hash）
7. 释放锁
```

任一步失败：已 rename 的文件按 pre-image 恢复，staging 丢弃，journal 记 `aborted`。
`pending` 行在 rename 前落盘，并同时记录每个目标的 pre-image hash（文件不存在为
`null`）；启动时若 pending 的所有预期 hash 都与磁盘一致，补记 `committed`；若磁盘仍是
全部 pre-image 的字节，补记 `aborted`；两者都不是（部分 rename 后崩溃）则拒绝自动修复
并要求从 `backups/` 恢复。

> 这取代了「多表事务 + 事后检测撕裂」的做法——**撕裂窗口在架构上不存在，而不是靠事后检测**。

### 6.4 journal 格式（JSONL，追加式）

```json
{"txid":"01H...","op":"archive","chapter":4,"at":"2026-10-26T14:00:00+08:00","status":"committed","files":["state/pipeline.yaml"],"hashes":{"state/pipeline.yaml":"sha256:b"},"before":{"state/pipeline.yaml":"sha256:a"},"revision":43}
```

- 只追加，不修改（损坏时人工介入，不做自动修复）。
- 状态为 `pending` / `committed` / `aborted`；`pending` 是崩溃恢复元数据，不出现在 `/novel audit` 的用户行里。
- 启动对账：先收敛末尾 `pending`（见 §6.3），再比较最后一条 `committed` 与文件实际 hash；不符 → 报 `ENGINE_TXN_ABORTED` 并提示从 `backups/` 恢复。
- journal 不参与门控，只用于追溯与恢复提示。

### 6.5 锁

| 层 | 机制 | 粒度 |
|---|---|---|
| 进程内 | `KeyedMutex`（Map<projectRoot, Promise chain>） | 项目 |
| 跨进程 | `.engine.lock`（O_EXCL 创建，内容 `{pid, startedAt, host}`） | 项目 |

陈旧锁判定：`pid` 不存在（`process.kill(pid, 0)` 抛 ESRCH）或 `startedAt` 早于 90 秒 → 回收。回收前写 journal `lock_reclaimed`。

### 6.6 快照与只读投影

- `loadSnapshot()` 一次性读 `pipeline + chapters + characters + world + foreshadows + timeline + relationships`，返回不可变对象 + `revision`。
- 只读操作（status / 面板 / 命令）用快照，不加锁；若读到的 `revision` 在读取期间变化 → 重读一次，仍变则返回「正在写入」。
- **投影统一在 `engine/projections/`**：`summary` / `chapters` / `gates` / `stats` 四个函数，入参快照，出参 DTO。命令、面板、`getStatus` 全部复用（A4 修正）。

### 6.7 备份与 GC

- 每次归档备份受影响文件到 `backups/<txid>/`。
- 保留最近 N 份（默认 5，可配），超出按时间清理——**只删 `backups/` 下自建目录**，不碰其他路径。
- GC 在归档成功后异步执行，失败只记日志，不影响归档结果。

### 6.8 多项目注册表

```yaml
# ~/.dsh/novel-engine/projects.yaml（不在项目内，避免污染仓库）
schema_version: 1
projects:
  - { root: "/abs/path/to/novel", title: "某书", lastOpenedAt: "..." }
active: "/abs/path/to/novel"
```

- 注册表是**便利设施**，不是真相：删了它，项目仍可打开。
- `projectRoot` 配置优先；注册表只在「未指定」时用于最近项目。
- 跨项目导入（`novel_export --kind=cast` → `novel_import`）走显式命令，不做后台同步（D-10）。

### 6.9 迁移

- 迁移函数签名：`(old: unknown) => new`，纯函数，可单测。
- 迁移链：`v1→v2→v3`，逐级执行，每级落盘前把原字节备份到 `backups/migrations/`。
- 迁移失败：先尝试用内存 pre-image 原地回滚，失败则按备份路径恢复，报 `ENGINE_SCHEMA_INVALID` + 具体字段路径。

---

## 7. 状态机与门控

### 7.1 九个阶段，两种性质

| 阶段 | 名称 | 性质 | 谁执行 | 产物 |
|---|---|---|---|---|
| P1 | 世界观约束 | agent | 模型 | `plans/chNNN.world.yaml` |
| P2 | 章节预检 | agent | 模型 | `plans/chNNN.chapter.yaml` |
| P3 | 初稿 | agent | 模型 | `chapters/chapter-NNN.md` |
| P4 | 评审 | agent | 模型（建议独立 subagent） | `reviews/chNNN.review.yaml` |
| P5 | 修订 | agent | 模型 | 覆盖正文 |
| P6 | 一致性校验 | agent + tool | 引擎跑机检，模型补语义 | `checks/chNNN.check.yaml` |
| P7 | 状态同步 | **事务** | 引擎 | `state/*.yaml` |
| P8 | 终审 | **事务** | 引擎 | 三端一致性报告 |
| P9 | 归档 | **事务** | 引擎 | 章节索引 + 交接 |

**为什么 P7/P8/P9 合并成一次事务**：常见的多阶段流水线里这三步分开，才出现「P7 写了一半」「P8 发现了但 P9 已归档」，才需要事后检测撕裂。本引擎做成一次 `archiveChapter`：**先校验（P8）、再落盘（P7）、最后提交（P9）**，全在同一 staging 事务内。

对外仍保留 9 个阶段名，是为了**可追溯**：`getStatus` 显示「P1-P6 已完成，P7/P8/P9 在归档事务中一起完成」。

**阶段名与管线状态值不是同一套枚举**（前者是任务书编号，后者是状态机取值）：

| 层 | 取值 |
|---|---|
| 任务书阶段（`novel_brief.stage`） | `P1` `P2` `P3` `P4` `P5` `P6` `P8` |
| 管线状态（`pipeline.stage`） | `idle` `P2` `P3` `P4` `P5` `P6` `ready_to_archive` `done` |

`pipeline.stage` 语义是「下一个期望的产物」。P1 期间管线停在 `idle`（世界观规划是模型侧工作，没有落盘状态）；P7/P8/P9 在归档事务内完成，不单独成态。这张表是唯一映射，代码中不允许出现 `P4_review` 之类的别名。

### 7.2 迁移表（数据化，可穷举）

```ts
type Stage = 'idle' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'ready_to_archive' | 'done'

const TRANSITIONS: readonly Transition[] = [
  // 新章：从 idle（首章）或 done（下一章）进入世界观规划
  { from: 'idle',  op: 'submitWorldPlan',   to: () => 'P2', guards: [] },
  { from: 'done',  op: 'submitWorldPlan',   to: () => 'P2', guards: [] },
  { from: 'P2',    op: 'submitChapterPlan', to: () => 'P3', guards: [] },
  { from: 'P3',    op: 'submitDraft',       to: () => 'P4', guards: ['PG-03','PG-04','PG-05','PG-06'] },
  // 评审：仍有 blocker → 修订；无 blocker → 直接进校验
  { from: 'P4',    op: 'submitReview',      to: (r) => r.openBlockers > 0 ? 'P5' : 'P6',
                                            guards: ['PG-07','PG-09','PG-11'] },
  { from: 'P5',    op: 'submitRevision',    to: () => 'P4', guards: ['PG-03','PG-04','PG-08','PG-09'] },
  // 校验不过 → 修订；正文一改，评审分数即失效，必须回 P4 重评
  { from: 'P6',    op: 'submitRevision',    to: () => 'P4', guards: ['PG-03','PG-04'] },
  { from: 'P6',    op: 'runCheck',          to: () => 'ready_to_archive', guards: ['PG-10'] },
  { from: 'ready_to_archive', op: 'archiveChapter', to: () => 'done', guards: ['PG-01','PG-02','PG-12'] },
]
```

- **只有一处数据依赖的迁移**：P4 的 `submitReview` 按 `openBlockers` 决定去 P5 还是 P6。它是迁移表里的一行（`to` 是一个纯函数），不是散落在 engine 里的 `if`。
- 状态与操作不匹配 → `ENGINE_STAGE_ORDER`，消息给出「当前阶段 + 可用操作」。
- 表是**唯一**迁移定义；`engine` 不写 `if (stage === ...)` 的分支判断（除表查询外）。
- 穷举测试：对 `(stage × op)` 全矩阵断言「允许/拒绝」，拒绝时错误码正确；`to()` 的两个返回值都要被覆盖（§13.5）。

### 7.3 循环与上限

| 循环 | 上限 | 超限行为 |
|---|---|---|
| P4 ⇄ P5（评审-修订） | 3 轮 | `ENGINE_GATE_BLOCKED`（PG-11），强制 `rollback` 到 P1（保留正文供参考，标记废弃） |
| P6 → P4（校验-修订-重评） | 3 轮 | 同上 |
| 单章总耗时 | 无上限 | 不做时间门控（创作不是批处理） |

轮次记在 `pipeline.rounds`，由引擎自增，**模型不能传轮次参数**（防自报「这是第 1 轮」）。

### 7.4 十二条门控

| 编号 | 名称 | 判定条件 | 触发点 |
|---|---|---|---|
| PG-01 | `BRIEF_REQUIRED` | 该阶段任务书已签发且 digest 与当前状态匹配 | 所有 submit |
| PG-02 | `STAGE_ORDER` | 只能提交当前阶段允许的产物 | 所有 submit |
| PG-03 | `WORD_COUNT` | `totalWordCount >= minWords` | P3 / P5 / P9 |
| PG-04 | `FORMAT` | 格式类规则 0 个 blocker | P3 / P5 / P6 / P9 |
| PG-05 | `SUMMARY_SCHEMA` | 10 必填字段齐全 + 类型正确 | P3 / P6 / P9 |
| PG-06 | `SCENE_TYPE` | 四选一 + 节奏约束（不连续 3 章同型；战斗不连续 2 章） | P3 / P9 |
| PG-07 | `SCORE` | 15 维齐全、算术闭合、`total >= minScore` | P4 / P9 |
| PG-08 | `ISSUES_CLEARED` | 所有 `blocker` issue 状态 `fixed` 且有证据 | P5 / P6 / P8 / P9 |
| PG-09 | `READING_PROOF` | 三处原文引用可在指定位置验证 | P4 / P5 / P6 |
| PG-10 | `CONSISTENCY` | 跨章对账（伏笔/时间线/资源/关系/重复） | P6 / P8 / P9 |
| PG-11 | `ROUNDS` | 轮次未超限 | P4 / P6 |
| PG-12 | `ARCHIVE_ATOMIC` | 事务三端一致 + 读回验证通过 | P9 |

**求值顺序固定**（不是「哪条先命中算哪条」）：

```
PG-01 任务书 → PG-02 阶段 → PG-04 格式 → PG-03 字数
  → PG-05 摘要 → PG-06 场景类型 → PG-09 阅读证明
  → PG-07 评分 → PG-08 问题清零 → PG-10 一致性
  → PG-11 轮次 → PG-12 归档事务
```

**为什么格式必须排在字数前**：见 §5.3 的口径陷阱——弯引号与破折号既计入字数又被判违规；若先判字数，会出现「写错引号所以够 2000 字，改对之后反而不够」的倒挂。

### 7.5 门控求值器（纯函数）

```ts
function evaluateGates(input: GateInput): GateResult
// GateInput: { op, stage, text, summary, review, check, snapshot, proof, rounds }
// GateResult: { passed: boolean, blocking: BlockingItem[] }
```

- **纯函数**：不读盘、不调工具、不看时钟（时间从 `snapshot` 取）。
- 每个门是一个独立函数，注册进 `GATE_REGISTRY`；求值器按固定顺序跑，收集**全部**失败项（不是遇到第一个就返回）——这样模型一次能改完所有问题。
- 门控不写盘：写盘由 engine 在门控通过后执行（INV-03）。

### 7.6 门控的取舍：哪些检查不该存在

门控不是越多越好。以下是**刻意不做**的检查，以及它们为什么会诱导出错误设计：

| 候选门控 | 本引擎 | 理由 |
|---|---|---|
| 「读过规则文件」标记 | **废除** | 没有可读文件；由 PG-01 任务书签收承担「你是否加载了本阶段规则」 |
| 「文件完整性」标记 | **废除** | 模型不负责文件完整性；`novel_brief` 一次给全 |
| 「产物文件存在」 | **内在化** | 产物由引擎写，「声称写了但没写」在结构上不可能 |
| 「产物文件非空」 | **内在化** | 同上 |
| 「状态文件已更新」 | **内在化** | 状态由引擎维护，不经过模型 |
| 「数据库记录存在」 | **废除** | 无数据库 |
| 「模型自报机器验证通过」 | **PG-04/05/07/10** | 引擎自己跑，模型无法自证 |
| 「检查工具轨迹里有没有读正文」 | **PG-09** | 轨迹可伪造；引用必须真实存在 |
| 「归档后一致性检测」 | **PG-12** | 事务内不可能撕裂，无需事后检测 |
| 「不展示就作废」的展示门控 | **render 内化** | 工具结果天然可见，仪式不产生信息 |

**判断标准**：一条门控只有在「失败可以被另一种方式伪造」时才值得存在。凡是「引擎自己能查的事」，就不该让模型先声明再检查——那是把机械保证退化成承诺。

### 7.7 证据模型：把「逐字阅读」变成可验证引用

靠「检查 tool_trace 里有没有 read_file 正文」验证的做法不可靠。问题：`read_file` 可以只读前 50 行，也可以读了但没看。

本引擎改为 **reading proof**：

1. 引擎对当前正文计算段落数与内容 hash；
2. 用 `(chapter, hash)` 派生的确定性种子，挑 3 个段落位置（约 15% / 55% / 90%）；
3. 要求提交方给出这 3 段的**逐字原文片段**（每段 ≥12 字，且必须是该段真实子串）；
4. 引擎回正文核对：片段必须存在于对应段落（允许 ±1 段容差）。

不通过时报错**指出位置与长度要求，但不回显原文**（防照抄报错蒙混）：

```
PG-09 READING_PROOF failed:
  - 需要 3 段引用；已提供 2 段
  - 位置 0.55 的引用未在第 47±1 段找到（引用长度 9 < 12）
  - 提示：请重读 chapters/chapter-001.md 的第 40-60 段
```

**能防**：跳过重读、只读摘要、凭上一版记忆评审。
**不能防**：模型复制自己刚写的文本（但那种情况下它确实持有文本，目的已达）。

### 7.8 评分体系（PG-07 的实现）

#### 十五维（按商业网文的实际权重设定）

| 组 | 编号 | 维度 | 满分 | 机检度 |
|---|---|---|---:|---|
| A 核心叙事（90） | R-W-01 | 人设驱动 | 15 | ○ 语义 |
| | R-W-02 | 情绪外化 | 10 | ◐ 半机检 |
| | R-W-03 | 对话区分度 | 10 | ○ 语义 |
| | R-W-04 | 爽点密度 | 20 | ◐ 半机检 |
| | R-W-05 | 断章法则 | 15 | ◐ 半机检 |
| | R-W-12 | 反文青病 | 20 | ◐ 半机检 |
| B 商业指标（45） | R-W-11 | 元描写与视角侵入 | 10 | ◐ 半机检 |
| | R-W-13 | 信息增量 | 15 | ● 可机检 |
| | R-W-14 | 钩子质量 | 10 | ◐ 半机检 |
| | R-W-15 | 期待值兑现 | 10 | ◐ 半机检 |
| C 格式硬性（15） | R-W-06 | 段落长度 | 4 | ● 可机检 |
| | R-W-07 | 去 AI 味 | 4 | ● 可机检 |
| | R-W-08 | 硬性禁令 | 4 | ● 可机检 |
| | R-W-09 | 字数 | 2 | ● 可机检 |
| | R-W-10 | 标题 | 1 | ● 可机检 |
| **合计** | | | **150** | |

> 15 项加总必须严格等于 150，规则包编译时断言（§5.2 第 1 条），不等则拒绝启动。
>
> **机检度是新增元数据**：● 的维度由引擎直接给分（模型不得覆盖）；◐ 的维度引擎给「事实层」证据、模型给「判断层」结论；○ 的维度必须由模型判断，但结论必须附原文证据（与 §7.7 同源机制）。

#### 分数必须是可核对的算术

```
total             = 150 - Σ(所有 dimension 的 deductions.delta)
dimension.score   = dimension.max - Σ(该 dimension 的 deductions.delta)
约束：0 <= dimension.score <= dimension.max
      每个 delta > 0
      每条 deduction 必须带 rule / location / note
```

引擎校验三件事：**算术闭合**、**每条 `location` 能在正文定位**（段落号合法）、**互斥规则未重复计分**。

> 裸分数无法复核、也无法定位问题。本引擎把「扣多少分」变成结构化数据，任何编造都会在算术上暴露（T-04）。

#### 互斥、去重与封顶

三条规则，缺一条就会出现「一事二罚」导致分数虚低：

1. **维度封顶**：单维度扣分累计不超过该维度满分（归零即止）。
2. **跨维度互斥**：同一片段同时触发两个维度时，只计更重的一项；互斥对在规则包 `exclusions` 声明（§5.5，共 6 对 + 可扩展）。
3. **同词去重**：某些词同时属于「黑名单」与「元叙述标记」（如「值得一提的是」「众所周知」）。按位置去重，只计一次，归入更重的维度（R-W-11，-4）。

去重键：`(spanStart, spanEnd, violationFamily)`；同一片段同一族只保留一条，候选按 `delta` 降序取首。

#### issue 生命周期

```
open ──revise(带证据)──▶ fixed
open ──amend(带原因)───▶ waived   ← 仅 advisory 可 waive
```

- `blocker` 级 issue **不能 waive**，只能 `fixed`。
- `fixed` 必须带 `evidence`（修订后正文的引用片段），引擎校验引用存在。
- 每轮修订后重新评审（P4 再跑一次），分数重算，轮次 +1（PG-11 管上限）。

### 7.9 写一章的完整时序

```
用户：写第 4 章

① novel_status
   → { chapter: 4, stage: 'idle', next: { tool: 'novel_brief', args: { stage: 'P1' } } }

② novel_brief { stage: 'P1' }
   → instructions(世界观约束任务书) + context(近 5 章摘要/伏笔台账/卷幕位置) + digest
   → pipeline.briefs.P1 记录签收

③ [模型工作] 产出约束清单

④ novel_plan_world { ... }                  → stage → P2（PG-01 校验已签收的 P1 digest）
⑤ novel_brief { stage: 'P2' } → ⑥ novel_plan_chapter { 预检表 } → stage → P3
⑦ novel_brief { stage: 'P3' }   ← 给「角色全文 + 前章结尾 + 待推进伏笔 + 上次评审遗留」
⑧ [模型写作]
⑨ novel_write_draft { content, summary }
   → 字数 2480 ✓ / 格式 0 blocker ✓ / summary 齐 ✓ / opening 是前两段原文 ✓ → stage → P4

⑩ novel_brief { stage: 'P4' }   ← 给机检报告 + 全量角色 + 前章
⑪ [模型逐字阅读 + 评分]（建议派独立 subagent）
⑫ novel_review { dimensions, issues, total, proof }
   → 算术闭合 ✓ / 15 维齐 ✓ / proof 三处命中 ✓ / total 118 < 120 → stage → P5，rounds.review=1

⑬ novel_brief { stage: 'P5' } → ⑭ novel_revise { body, resolved: [REV-001...], reading_proof }
   → 每个 fixed 的 issue 带 evidence，引擎校验引用存在 → stage → P4（rounds.review=2）

⑮ novel_review（第二轮）→ total 126 ≥ 120 → stage → P6

⑯ novel_check { scope: ['content','integrity'] }
   → 机检 0 blocker；跨章：FS-007 休眠不足但 new_info=true（放行）
   → 模型补 semantic items（每条带 evidence）→ stage → ready_to_archive

⑰ novel_archive { state_delta, handoff }
   → 重跑全量机检 ✓ → delta 逐实体核销 → 分配 FS-008
   → staging → 三端一致 → 备份 → 提交 → journal → 读回验证 → stage → done

⑱ 模型把 novel_archive 的 render 转述给用户（章节结算卡）
```

---

## 8. 知识层

### 8.1 入口技能（1 个）

```ts
ctx.skills.register({
  name: 'novel-write-engine',
  description: 'Drive the deterministic novel-writing pipeline: plan, draft, review, revise, verify, archive.',
  whenToUse: '用户要写小说章节、继续写、重写、检查章节一致性，或查看创作项目状态时。',
  invocation: { modelInvocable: true, userInvocable: true },
  content: ENTRY_SKILL_MD,   // 约 120 行
})
```

**技能正文只讲「怎么驱动」，不讲「怎么写好」**：

| 章节 | 内容 |
|---|---|
| 何时用 | 触发条件 |
| 核心循环 | `status → brief → 做 → submit → status` |
| 六条铁律 | 不跳阶段、不伪造指标、不绕过门控、ID 由引擎分配、正文 SSOT、blocker 必须修 |
| 路由表 | 「改情节」→ P3；「有 AI 味」→ P4；「前后矛盾」→ P6；「重写」→ P1 |
| 工具速查 | 18 个工具一行一个 |
| 失败处理 | 常见错误码 → 该做什么 |

**为什么不给 9 个阶段各注册一个技能**：那等于把 9 份阶段文档搬进上下文，token 成本高，且模型会在错误阶段加载错误文档。阶段知识由 `novel_brief` 精确投递。

### 8.2 阶段任务书（7 份，外置）

`briefs/{P1,P2,P3,P4,P5,P6,P8}.md`，由 `getBrief` 读取 + 组装上下文包：

| 阶段 | 任务书内容 | 上下文包 |
|---|---|---|
| P1 | 世界观约束清单的字段与判据 | 近 5 章摘要、伏笔台账、卷幕位置、类型约束 |
| P2 | 八部分预检表的填写规则 | 本章大纲、前章结尾、待推进伏笔、场景类型分布 |
| P3 | 写作铁律（字数/引号/直引号/摘要 10 字段） | 角色全文、锁定描写、前章结尾、本章预检表 |
| P4 | 15 维评分标准 + 扣分项写法 + proof 要求 | 机检报告、全量角色、前章、历史评分 |
| P5 | 按 issue 逐条修复的规则 + 证据要求 | 评审报告、issue 清单、当前正文 |
| P6 | 一致性 11 维 + 语义项证据要求 | 全量台账、当前机检、评审与 summary（历史 check 不在 0.1.0 上下文包内） |
| P8 | 终审清单（三端一致性的模型侧部分） | 当前 check、评审、summary、近 5 章摘要（delta 由 `novel_archive.state_delta` 提交） |

任务书是**外置文件**：改写作指导不改代码；升级时与引擎版本一起发布，用户可覆盖（`briefs.overrides`）。

### 8.3 12 类型指南与平台风格

- 类型指南进规则包 `genres`，不做常驻文档。
- 平台风格（字数/对话占比/爽点密度）进 `platform` 段。
- `getBrief` 只注入**当前类型**的条目，不注入全表。

### 8.4 规则包的自包含性

规则包随插件发布，是包的一部分，不是外部输入。

**四条约束**：

| # | 约束 | 怎么保证 |
|---|---|---|
| 1 | 构建期完整 | `scripts/validate-rulepack.ts` 校验每个包：schema 版本、12 类型齐全、必填段与键、词条无重复、`type: exact` 的词不进正则；缺一即构建失败 |
| 2 | 运行时不读包外路径 | `doctor` 与测试用只读 fs 断言：引擎读过的所有路径必须落在「包目录 / 项目目录」之内 |
| 3 | 无隐式依赖 | `package.json` 的 `files` 只含 `lib`/`rulepacks`/`briefs`/`skills`/`presets`（及 README/LICENSE）；`node:fs` 只允许出现在 `src/assets.ts` 与 `src/store/`，由 arch 测试扫描 |
| 4 | 更新只有两条路 | 新版本（包随之升级），或用户自备 `rules.overrides`；不做运行时同步、不认环境变量指向的包 |

**为什么写死这四条**：规则包一旦可以「从别处加载」，版本、回滚、可复现性全部失效。自包含让「同一插件版本 + 同一规则包 = 同一判定」成立。

---

## 9. 工具面与命令面

### 9.1 十八个工具（全部是 `EngineService` 的薄适配器）

| # | 工具 | 阶段 | 服务操作 | 写盘 |
|---|---|---|---|---|
| 1 | `novel_init` | — | `initProject` | 是 |
| 2 | `novel_status` | — | `getStatus` | 否 |
| 3 | `novel_brief` | P1~P6 | `getBrief` | 是（仅 `briefs`） |
| 4 | `novel_plan_world` | P1 | `submitWorldPlan` | 是 |
| 5 | `novel_plan_chapter` | P2 | `submitChapterPlan` | 是 |
| 6 | `novel_write_draft` | P3 | `submitDraft` | 是 |
| 7 | `novel_review` | P4 | `submitReview` | 是 |
| 8 | `novel_revise` | P5 | `submitRevision` | 是 |
| 9 | `novel_check` | P6 | `runCheck` | 是 |
| 10 | `novel_archive` | P7+P8+P9 | `archiveChapter` | 是（事务） |
| 11 | `novel_word_count` | 任意 | `countWords` | 否 |
| 12 | `novel_state` | 任意 | `queryState` | 否 |
| 13 | `novel_amend` | 任意 | `amend` | 是 |
| 14 | `novel_rollback` | 任意 | `rollback` | 是 |
| 15 | `novel_diff` | 任意 | `diff` | 否 |
| 16 | `novel_export` | 任意 | `export` | 是（导出目录） |
| 17 | `novel_audit` | 任意 | `auditHistory` | 否 |
| 18 | `novel_pipeline` | 任意 | `advise` | 否 |

### 9.2 四个关键契约

#### `novel_status`

```ts
parameters: {
  chapter: { type: 'number' },
  format:  { type: 'string', enum: ['json', 'markdown'] },
}
output.schema: {
  type: 'object', additionalProperties: false,
  properties: {
    project:  { type: 'object', required: true, additionalProperties: true },
    chapter:  { type: 'integer', required: true },
    stage:    { type: 'string', required: true },
    rounds:   { type: 'object', required: true, additionalProperties: true },
    blocking: { type: 'array', required: true, items: { type: 'object' } },
    next: { type: 'object', required: true, additionalProperties: false,
      properties: {
        tool:   { type: 'string', required: true },
        args:   { type: 'object', required: true, additionalProperties: true },
        reason: { type: 'string', required: true },
      } },
  },
}
```

`next` 是核心价值：**把「下一步做什么」从模型记忆搬进返回值**。

#### `novel_brief`

```ts
parameters: { stage: { type: 'string', required: true, enum: ['P1','P2','P3','P4','P5','P6','P8'] }, chapter: { type: 'number' } }
output: { stage, chapter, digest, title, content, content_hash, fields, context }
```

**这是替代 9 份 SKILL.md 的关键**：上下文包只给对方需要的数据。P3 拿「角色全文 + 前章结尾 + 待推进伏笔」；P6 拿「全量台账 + 机检报告」；不相关的一律不给。

#### `novel_write_draft`

```ts
parameters: {
  chapter:    { type: 'number', required: true },
  chapter_title: { type: 'string', required: true },   // 4~8 字，不含「第N章」
  content:    { type: 'string', required: true },   // 纯文本，禁 Markdown
  scene_type: { type: 'string', required: true, enum: ['战斗/动作章','日常过渡章','情感爆发章','纯叙事章'] },
  narrator:   { type: 'string', required: true },
  summary:    { type: 'object', required: true, additionalProperties: false, /* 10 字段，见 §4.2 */ },
  project_root: { type: 'string' },
}
```

`execute`：写正文 → 字数与格式规则 → 校验 summary 与正文一致（`opening` 必须是前两段原文；字数必须是实测值）→ 不通过则**整体拒绝，不落盘**。

**关键：拒绝时正文不写盘**，避免「写入了坏稿，再靠回退修」的脏状态。

#### `novel_archive`（最重的一个）

```ts
parameters: {
  chapter:     { type: 'number', required: true },
  state_delta: { type: 'object', required: true, additionalProperties: false, properties: {
    characters: { type: 'object', required: true, additionalProperties: true },
    foreshadows:{ type: 'object', required: true, additionalProperties: true },
    timeline:   { type: 'object', required: true, additionalProperties: true },
    world:      { type: 'object', required: true, additionalProperties: true },
    relationships: { type: 'object', required: true, additionalProperties: true },
  } },
  handoff: { type: 'object', required: false, additionalProperties: true }, // P8 可覆盖卷/幕/进度；缺省由章节数与规划派生
  project_root: { type: 'string' },
}
```

内部步骤（全在一个事务里）：校验阶段 → **重跑全量机检（不信任旧结果）** → delta 核销 → 分配 ID → staging → 三端一致 → 备份 → 提交 → journal → 读回验证 → 生成 handoff → 返回 `assignedIds + metrics + verdict`。

`state_delta` 的逐实体形状（键即实体标识，未声明即拒绝）：

```ts
characters:    { [name]: string → { action: 'created'|'updated'|'no_change', reason?, role?, profile?, current_state?, growth? } }
foreshadows:   { [key]:  string → { action, reason?, title?, description?, note?, new_info? } }
timeline:      { [index]: string → { action, reason?, story_time?, description?, location?, characters? } }
world:         { [name]: string → { action, reason?, kind?: 'location'|'ability'|'artifact'|'faction'|'rule', description?, layout?, capacity? } }
relationships: { ['a|b']: string → { action, reason?, a?, b?, type?, description?, note? } }
```

`no_change` 必须带非空 `reason`；`created` 的实体若已存在、`updated` 的实体不存在、伏笔 key 找不到对应 `FS-*`，一律 `ENGINE_DELTA_UNVERIFIED`，不做任何回退匹配。

**为什么 delta 必须逐实体声明 `no_change + reason`**：这是义务清单的核销机制。它防的是「这章出现了新角色，但管理员漏了」——静默跳过是这类流水线最隐蔽的失败模式。

### 9.3 为什么这样切分

| 备选 | 否决理由 |
|---|---|
| 一个大而全的 `novel_write` | 参数爆炸，模型易传错，错误无法定位到环节 |
| 通用 `novel_state` 读写 | 写通道一开，SSOT 即破；只允许「管线写」+「受控 amend」 |
| 合并 P1/P2 | 两者上下文不同（P1 看全局与伏笔节奏，P2 看本章大纲与承接） |
| 插件内部派发 subagent | 工具调用变分钟级长任务，不可中断、不可观测 |
| 一个 `novel_submit` + `phase` 判别式 | `oneOf` 分支过深，参数难命中 |

### 9.4 五条斜杠命令

```
/novel             → 状态卡（项目头 + 当前位置 + 下一步）
/novel next        → 下一步该调的工具与参数
/novel stats       → 字数 / 评分 / 伏笔 / 词表命中统计
/novel export      → 导出 md / txt / epub，附封面 SVG 与平台简介
/novel admin <op>  → 触达未注册在高频面的 10 个工具（仅 tools.mode=core 时需要）
```

命令与工具共用同一套投影（§6.6），不引入第二条数据路径；命令是「少一次工具调用」的糖，不是新能力。

### 9.5 错误语义

- 参数不合法 → 交给 DSH 的 `ToolArgsError`（模型看到标准错误）。
- 业务规则不过 → **抛异常**，message 带 `code` 与可操作建议：

```
PG-03 WORD_COUNT: 正文 1832 字 < 2000 字下限。
  差额 168 字。建议在「第 3 场对峙」后补一段主角的应对（不要拉长环境描写）。
```

- 「不理想但成功」→ 正常返回（例如 `advisory` 级问题，`verdict: pass`）。

---

## 10. 客户端半边：侧边栏「网文工坊」

### 10.1 槽位契约（源码核实）

| 槽 | kind / scope | 语义 | 注册字段 |
|---|---|---|---|
| `sidebar.panellist` | `list` / `root` | 左侧栏全局面板图标行；每个 id 对应一个 main panel | `id`、`order`、`locale`、`label`、`inject` |
| `main` | `keyed` / `root` | 中央主面板，按侧栏条目 id 选择 | `key`、`locale`、`inject` |
| `sidebar.panellist.actions` | `list` / `root` | More 菜单的固定/取消固定（可选） | `entries`、`onOpen`、`onPinnedChange` |

> 依据：`packages/client/ui-sidebar/src/client/contract/slots.ts:30-40`（注释原文 *"Each list id addresses the matching main panel"*）、`packages/client/ui-layout/src/client/index.ts:53+`（`main` 为 keyed，`conversation` 是保留 key）。官方 `ui-schedule` 是同款用法（`ui-schedule/src/client/index.ts:196-213`）。

> 实现细节：`MainPanelId` 是 Branded 字符串而非闭合联合（`ui-layout/src/client/service.ts:16`），所以 id 写成 `const PANEL_ID = 'novel-workshop' as MainPanelId`——本面板唯一需要的类型断言，官方同款（`ui-schedule/src/client/index.ts:67`）。

### 10.2 面板内容

命名：中文「网文工坊」，英文 `Novel Studio`，id `novel-workshop`。三块：

1. **项目头**：书名 / 类型 / 当前章 / 当前阶段 / 九格阶段进度。
2. **章节表**：章号、标题、字数、评分、门控状态（✅ / ⚠️ / ❌）；点一行展开该章摘要。
3. **阻塞区**：当前阶段还差什么——哪条门控没过、差几个字、缺哪个字段。**这是面板存在的理由**：把「为什么卡住」从对话搬到眼前。

**只读**。所有写操作仍走工具/对话；面板最多给一个「继续写」按钮，行为是往当前会话投一条消息，不直接改文件。

### 10.3 数据通道

- 只读 HTTP 路由 `/api/novel-write-engine/panel`：GET/HEAD，精确匹配，返回 `PanelPayloadDto`；连接层缺席时 503。
- 客户端相对请求 `api/novel-write-engine/panel`，兼容 `--public-url` 子路径；非 2xx 时展示宿主 `error` 字段。
- DTO 带 `schemaVersion`；版本不匹配时面板降级为「需刷新」提示（浏览器缓存与引擎版本可能不同步）。
- **退路**：typert 的 Host 侧命名空间声明若比预期重，面板降级为「静态壳 + 刷新按钮」，数据仍由对话内工具卡片呈现——不阻塞 Host 交付。

### 10.4 构建与开关

- 三条硬约束见 §3.6。
- **0.1.0 就声明 `dsh.client`**，装上即有入口。
- **入口不可单独关闭**：`dsh.client` 是包级声明。要「可关闭」必须拆子包；因此**单包常驻**（面板只读，没有关闭必要，多一个包多一份版本同步成本）。

### 10.5 验收

1. `pnpm build` 后 `lib/client.js` 以 `window.__ModuleLoader__.load({ id: "dsh-novel-write-engine"` 开头，`node --check` 通过。
2. 安装后刷新，左侧栏出现「网文工坊」；点击进入整页。
3. 面板显示真实数据（≥3 章样例）。
4. 门控失败时阻塞区列出具体编号与差额。
5. 卸载后入口消失，无残留。
6. 深/浅主题可读；窄屏折叠为图标。

---

## 11. 内置 Agent 预设「网文工坊」

### 11.1 机制（已核实）

预设不是一段提示词，而是**一份 Cordis YAML 组合**：

```ts
interface PresetDefinition {
  id: string; name?: string; description?: string; order?: number
  plugins: EntryOptions[]          // 这就是该 Agent 的完整能力名录
}
```

实现只有一行：`@deepseek-ai/dsh-agent-preset` 作为插件行被加载，`init` 时调 `ctx.agentPresets.register(config)`（`packages/preset/agent-preset/src/index.ts:24-30`）。

**分发路径（官方同款）**：`dsh.bundle.patch` 接收**文件数组**，按序应用。官方 `web-app` 用一个宿主补丁 + 4 个预设补丁发 4 个预设，每个预设补丁就一句 `- insert:`。

### 11.2 三条硬约束

| 约束 | 事实 | 对设计的影响 |
|---|---|---|
| **会话级锁定** | 对话一开始组合固定；中途切换返回 `agent-preset/locked` | 「网文工坊」是一个**会话类型**，不是开关；换预设＝新建会话 |
| **名录不继承** | `plugins` 是完整列表，没有「在标准预设上追加」的语法 | 要保留的官方行必须逐条写全；上游改名会让该行 `broken` |
| **persona 只能挂预设内** | `@deepseek-ai/dsh-persona` 是 *scope-only*：全局挂会与 `dsh-system-prompt` 撞车并失败 | 给小说助手身份，官方姿势就是放进预设 |

### 11.3 组合策略：工具在根，身份在预设

**为什么不把工具塞进预设**：

1. **根行必须存在**：客户端半边只随「说明符恰好等于包名」的行挂载；只挂进预设，侧边栏根本不会出现。
2. **会撞名**：同包两处挂载 = 两份实例，18 个工具重复注册。
3. **能力不该随会话类型消失**：工具在根上，标准会话里 `/novel` 照样能用。

| 层 | 挂什么 | 目的 |
|---|---|---|
| 根行 | `dsh-novel-write-engine` 整包 | 18 工具 + 技能 + 面板，任何会话可用 |
| 预设 | persona、time-context、tool-skill、ask-user、todo、present、web、compaction、delegation | 身份 + 精简名录 |

**预设刻意不给**：`tool-bash`、`tool-pwsh`、`tool-fs`、`tool-fs-search`、`tool-jobs`、`tool-schedule`、`tool-goal`、`plan-mode`、`plugin-manager`。

这不是省事，是**把「引擎独占写入权」从约定变成能力边界**：在那个会话里模型手上没有写文件的工具，唯一落盘路径是 `novel_write_draft` / `novel_revise` / `novel_archive`。

> 代价：预设会话里读不到项目外文件、不能执行命令。若日后觉得太紧，最小改动是加回 `tool-fs`，同时保留「外部改动检测」（mtime + hash 比对，不一致要求 `novel_amend`）。

### 11.4 补丁形状

```jsonc
"dsh": { "bundle": { "patch": ["./cordis.patch.yml", "./presets/novel-write-engine.patch.yml"] } }
```

```yaml
# presets/novel-write-engine.patch.yml
- insert:
    - id: preset-novel-write-engine
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: novel-write-engine
        name: 网文工坊
        description: 网文创作专用会话：18 个小说工具全开，无文件写权限，门控与字数由引擎裁决。
        order: 20
        plugins:
          - { id: persona,     name: '@deepseek-ai/dsh-persona', config: { prefix: "（见 §11.5）" } }
          - { id: time-context, name: '@deepseek-ai/dsh-time-context' }
          - { id: tool-skill,   name: '@deepseek-ai/dsh-tool-skill' }
          - { id: tool-ask-user,name: '@deepseek-ai/dsh-tool-ask-user' }
          - { id: tool-todo,    name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: false } }
          - { id: present,      name: '@deepseek-ai/dsh-tool-present' }
          - { id: tool-web,     name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } }
          - id: compaction
            name: cordis:group
            group: true
            isolate: { compaction: true, toolResultPruner: true }
            config:
              - { id: compaction-basic, name: '@deepseek-ai/dsh-compaction-basic' }
              - { id: command-compact,  name: '@deepseek-ai/dsh-command-compact' }
              - { id: tool-result-pruner, name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
                  config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } }
          - id: delegation
            name: cordis:group
            group: true
            isolate: { workflowEngine: true }
            config:
              - { id: tool-subagent,      name: '@deepseek-ai/dsh-tool-subagent',
                  config: { provider: spawn, toolName: subagent, modelSelection: true, modelDiscovery: true } }
              - { id: tool-subagent-fork, name: '@deepseek-ai/dsh-tool-subagent',
                  config: { provider: fork, toolName: subagent_fork } }
```

三处刻意选择：

- **不收 `workflow-ptc` / `tool-workflow`**：那套要 PTC 执行器；宁可没有 workflow，也不要半个引擎。
- **每条 `id` 都写**：预设内经 `mountPreset` 安装时 `id` 是重载与覆盖的锚点。
- **不挂 `agent-instructions`**：那行会读工作区 `AGENTS.md`，对小说会话是噪音。

### 11.5 主笔人格（原创文本）

```text
你是「网文工坊」的主笔，一位只认数字与状态的网文作者。

- 每章先看状态：novel_status 与 novel_brief 说了什么就按什么做，不凭记忆推测进度。
- 正文只经 novel_write_draft，改稿只经 novel_revise，归档只走 novel_archive。没有别的写入口。
- 字数、引号、格式、门控结论一律以引擎返回为准，不要自己估算，也不要复述旧数字。
- 评审每一分都要指到具体扣分项；指不出来就不要扣。
- 设定、前章细节、伏笔状态拿不准就查 novel_state，不许编。
```

不写死在代码里，放在补丁的 `persona.prefix`；用户可在设置里查看与编辑，改坏只影响这一个会话类型。

### 11.6 上游漂移与验收

三道防线：组合测试（`entryListProblem()` 校验名录 + 嵌套 id/isolate 断言）、发布门禁 `pnpm check:preset`（在真实 bundle root 上 `require.resolve` 每个非 group name）、最小引用面（只引 9 个顶层行）。`apply()` 不读宿主预设内部结构，也不做启动自检。

验收：预设卡片显示且排序在标准之后；会话头显示名字；对话开始后切换被拒且提示可见；该会话含 18 个 `novel_*` 且**不含** bash/pwsh/fs/fs-search；标准会话里 `novel_*` 仍在但无主笔人格；面板在任何预设下都在；卸载后无残留。

---

## 12. 配置与国际化

### 12.1 Config Schema

```ts
export interface Config {
  projectRoot: string          // './novel'
  minScore: number             // 120
  toolsMode: 'all' | 'core'    // 'all'
  briefsOverrides: string      // ''（空 = 使用随包任务书）
  backupRetention: number      // 5（只删 backups/ 下自建目录）
  stateDir: string             // '~/.dsh/novel-write-engine'
}
```

**0.1.0 只支持中文**：面板、命令、错误消息与任务书均为中文；不随包发布 `locale/`，也不读取系统 locale。英文覆盖列入 0.2.0，不在本版本伪装成已支持。

**阈值优先级（同一键只保留一个最终值，不叠乘、不取交集）**：

```
rulepack.platform（平台默认） < novel.yaml.targets（项目声明） < 插件 Config（显式覆盖）
```

项目文件只覆盖它声明了的键；未声明即沿用下一级。规则包不再携带 `quality.min_score`，过关线只有 `Config.minScore` 一个 owner。

全部字段有默认值且写在 schema 里（指南 §5.4）。**没有硬编码可调参数**：连「90 字段落」都在配置里。

### 12.2 工具面预算

18 个工具常驻所有会话，估算 prompt 成本约 1.5–2k tokens。提供一个逃生门：

- `tools.mode = 'all'`（默认）：18 个全注册。
- `tools.mode = 'core'`：只注册 8 个高频工具（`init/status/brief/write_draft/review/revise/check/archive`），其余 10 个通过 `/novel admin <op>` 命令触达（命令不占 prompt）。多项目注册表与设定包导入（§6.8）也只走 `/novel admin`：`novel_registry_list/register/activate/forget`、`novel_import`。

**为什么能做到**：工具与命令共用 `EngineService`（§2.6），所以「隐藏工具」不损失能力——这正是单一入口带来的额外收益。

### 12.3 国际化

- 0.1.0 仅中文：不发布 `locale/`，所有面向用户与模型的文案以中文为准。
- 任务书可用 `briefsOverrides` 指向用户目录覆盖；缺阶段文件时回退随包版本。
- 英文覆盖与 `ctx.locale` 集成延后到 0.2.0，届时再引入键表与缺失键报告。

---

## 13. 测试架构与覆盖率门禁

> **硬要求：测试覆盖率必须 ≥85%（四项指标，全局）。**
> 这一章把「≥85%」翻译成可执行、可检验、不可糊弄的规则。

### 13.1 覆盖率意味着什么、不意味着什么

| 意味着 | 不意味着 |
|---|---|
| 每一层的关键路径被执行过 | 断言写对了 |
| 错误分支不是死代码 | 错误处理是正确的 |
| 重构时有人替你踩雷 | 需求实现了 |

**所以**：85% 是**地板不是天花板**；配套还有 §13.5 的「证伪测试清单」——那 12 条是覆盖率测不出来的东西。

### 13.2 度量口径

| 项 | 规定 |
|---|---|
| 工具 | `vitest` + `@vitest/coverage-v8`（与宿主仓库一致，避免第二套覆盖率引擎） |
| 指标 | `lines` / `branches` / `functions` / `statements` **四项分别判定**，任一低于门槛即失败 |
| 分母 | `src/**/*.ts`，按 §13.3 的 glob 分段 |
| 报告 | `coverage/coverage-final.json` + `text-summary` + `html` |
| 失败行为 | CI 红；本地 `pnpm test:coverage` 退出码非 0 |

**排除清单（显式，每条都有理由）**：

| 路径 | 理由 |
|---|---|
| `src/index.ts` | 纯装配（30 行），由集成冒烟覆盖；计入分母会鼓励写「假装配」凑数 |
| `src/**/*.d.ts`、`src/types.ts` | 纯类型，零运行时 |
| `src/client/entry.ts` | lazy-CJS 包装，由 bundle 形状测试覆盖 |
| `rulepacks/*.yaml`、`briefs/*.md`、`skills/entry.md`、`presets/*.yml` | 数据，不执行 |
| `tests/**` | 测试自身 |

**不排除的东西**（容易被顺手排除、但不许排）：`store/` 的错误分支、`engine/` 的门控分支、`tools/` 的 render 函数。这三处正是「会撒谎」的地方。

### 13.3 分层门槛

| 层 | lines | branches | functions | statements | 说明 |
|---|---:|---:|---:|---:|---|
| `src/domain/**` | **100** | **100** | **100** | **100** | 纯函数，表驱动；`perFile: true` |
| `src/rules/**` | 95 | 90 | 95 | 95 | 规则分支多，留 5 点余量 |
| `src/store/**` | 92 | 88 | 92 | 92 | 真实 tmpdir，不 mock fs |
| `src/engine/**` | 90 | 85 | 90 | 90 | 真 store + 真 rules |
| `src/tools/**` | 85 | 85 | 85 | 85 | 假 engine |
| `src/commands/**` | 85 | 85 | 85 | 85 | 假 engine |
| `src/remote/**` | 85 | 85 | 85 | 85 | 形状断言 |
| `src/client/**` | 85 | 85 | 85 | 85 | view model 单独 ≥95 |
| **全局** | **85** | **85** | **85** | **85** | 兜底 |

**为什么纯函数层要 100%**：`domain` 是「字数、算术、迁移表」——它们错了，上面所有门控都错。而且它们无 IO、无异步、无时间，100% 是可达的；达不到说明设计里混进了不该有的东西。

**为什么 store 是 92 不是 100**：故障注入（ENOSPC/EACCES/rename 失败）覆盖了主要分支，但平台差异分支（Windows rename 语义）在 Linux CI 上不可达——这部分用 `v8 ignore` 标注并计入预算（§13.9）。

### 13.4 测试分层（八类）

| # | 类型 | 对象 | 手段 | 数量级 |
|---|---|---|---|---|
| 1 | 纯函数单测 | domain：字数、分段、句长、SimHash、评分算术、迁移表 | 表驱动 + 边界枚举 | ~250 |
| 2 | 规则单测 | rules：每条规则的命中/不命中/严重度/豁免 | 构造文本片段 | ~180 |
| 3 | 规则包单测 | 编译器六条断言、平台/类型覆盖顺序、互斥去重 | 合法/非法包 fixture | ~40 |
| 4 | 存储测试 | 原子写、事务七步、锁回收、journal、迁移 | 真实 tmpdir + 故障注入 | ~90 |
| 5 | 引擎集成 | 22 个操作、门控、幂等、投影 | 真 store + 真 rules + 假时钟 | ~120 |
| 6 | 适配器契约 | 18 工具 + 5 命令 + 3 remote 的规范值/渲染/错误映射 | 假 engine（spy） | ~110 |
| 7 | 架构测试 | 六条依赖规则、规则码唯一、面板只读 | 静态扫描源码 | ~20 |
| 8 | 端到端 | 一个 3 章样例项目跑完整流程 | 宿主替身 harness | ~10 |

**宿主替身 harness**（`tests/harness/`）：实现 12 个原语的假 `Context`（tools/skills/commands/logger/effect/inject…），让 `apply()` 能在无宿主环境跑起来。它同时是工具契约测试的基础设施。

### 13.5 必须存在的证伪测试（12 条）

这些是「覆盖率测不出来、但必须证明」的行为。缺一条，0.1.0 不发。

| # | 证伪目标 | 测试方式 | 对应 |
|---|---|---|---|
| T-01 | 门控失败时零写盘 | 注入必失败门控，对项目目录做前后快照（路径 + mtime + hash）比对全等 | INV-03 |
| T-02 | 两个归档并发只写一次 | `Promise.all([archive, archive])`，断言一次提交 + 一次幂等 replay（或 `ENGINE_LOCK_TIMEOUT`），文件无撕裂 | INV-06 |
| T-03 | 读证明不可伪造 | 提交不存在的片段 → `ENGINE_READING_PROOF_INVALID`；片段存在但错段 → 同样拒绝 | PG-09 |
| T-04 | 分数算术必须闭合 | `total` 与 `150 - Σdelta` 差 1 → 拒绝 | PG-07 |
| T-05 | delta 不能静默跳过 | 章节摘要声明的新角色但 delta 未声明 → 拒绝，错误列出未声明实体 | PG-12 |
| T-06 | 规则码唯一 | 同一 code 注册两次 → `ENGINE_RULEPACK_INVALID` | INV-07 |
| T-07 | 路径不可逃逸 | `../`、绝对路径、`..\\`、NUL、`CON` → 全部 `ENGINE_PATH_ESCAPE` | INV-09 |
| T-08 | schema 过新拒绝 | `schema_version: 2` → `ENGINE_SCHEMA_TOO_NEW`，文件不被改写 | INV-12 |
| T-09 | 迁移可回滚 | 迁移中注入异常 → 项目回到迁移前状态（备份恢复） | §6.9 |
| T-10 | 面板只读 | `remote` 导出对象运行时无写方法；类型层 `@ts-expect-error` 钉死 | INV-10 |
| T-11 | 预设名录合法 | `entryListProblem()` 通过 + 每个 name 可解析 + id 不重复 | §11.6 |
| T-12 | EPUB 可解压 | 用 `node:zlib` 解回 ZIP，断言 `mimetype` 首条且未压缩 | §14.2 |

### 13.6 架构约束测试

`tests/arch.spec.ts` 做四件事（普通单测，< 1 秒）：

1. 扫描每个 `.ts` 的 `import`，按 §2.3 断言 R1~R6；
2. 扫描 `src/` 中 `node:fs` 的出现位置，只允许 `store/` 与 `index.ts`；
3. 扫描 `tools/`、`commands/`、`remote/`，断言不含 `store.` 调用；
4. 扫描测试文件，断言无 `.skip(` / `.only(` / `.todo(`（防偷偷跳过）。

> 这条测试是「架构文档会过期、测试不会」的落地。它比任何评审都可靠。

### 13.7 测试数据

```
tests/fixtures/
├── empty/            # 只有 novel.yaml
├── single/           # 1 章已完成
├── three/            # 3 章，含 1 个未回收伏笔、1 个负余额尝试
├── dirty/            # 经典脏章节：弯引号、分号、Markdown、超长段、零容忍词
├── rulepacks/
│   ├── valid.yaml
│   ├── sum-not-150.yaml
│   ├── dup-code.yaml
│   └── cycle-exclusion.yaml
└── briefs/           # 任务书快照
```

`dirty/` 是规则回归的核心：每条规则至少一个命中样例，断言 `code + severity + paragraph` 三元组。

### 13.8 确定性与隔离

| 风险 | 规定 |
|---|---|
| 时间 | 注入 `Clock`；测试用固定时钟，禁止 `Date.now()` 直接调用（arch 测试扫描） |
| 随机 | 引擎内零随机；SimHash 用确定性哈希，不用 `Math.random` |
| 排序 | 所有输出数组显式排序（按章号/ID），避免依赖对象键序 |
| 文件系统 | 每个测试 `mkdtemp`，`afterEach` 清理；**禁止用真实项目目录** |
| 并发 | 并发测试用 `Promise.all` + 断言数量，不靠 `setTimeout` 等 |
| 快照 | 只对「稳定输出」用快照（规范值 DTO），不对错误消息用（会因人话调整而碎） |

### 13.9 防作弊规则

| 规则 | 检查方式 |
|---|---|
| `v8 ignore` 预算 | 全仓 ≤ 5 处，每处必须带 `/* reason: ... */`；超出即失败 |
| 禁止 `.skip` / `.only` / `.todo` | `arch.spec.ts` 扫描 |
| 禁止空断言 | 扫描 `expect(true)` / `expect(1).toBe(1)` |
| 覆盖率产物上传 | CI 上传 `coverage/`，PR 模板要求贴四项数字 |
| 分层门槛不可降 | 降门槛的 PR 必须在描述里写明理由，并由人批准 |

### 13.10 CI 流程

```yaml
# .github/workflows/ci.yml（要点）
- run: pnpm install --frozen-lockfile
- run: pnpm typecheck          # tsc --noEmit（host + client）
- run: pnpm lint               # eslint + prettier --check
- run: pnpm build              # tsdown host → client → tsc client
- run: pnpm test:coverage      # vitest run --coverage（门槛在此生效）
- run: pnpm test:isolated      # 每个源文件单独 tsc（指南 §11.5）
- run: pnpm pack --dry-run
- uses: actions/upload-artifact@v4
  with: { name: coverage, path: coverage/ }
```

**为什么把 `test:isolated` 放进 CI**：类型合并缺失在聚合编译下看不出来，只有在空工程里单文件编译才暴露（指南的实测教训）。

### 13.11 达标与不达标的处置

| 情形 | 处置 |
|---|---|
| 某层低于门槛 | 补测试；**不允许**靠加 `v8 ignore` 过关（预算 5 处） |
| 某分支确实不可达 | 加 ignore + 理由 + 在 §13.3 注记 |
| 全局达标但某文件 0% | 不算达标：`domain` 用 `perFile: true`，其余层在 `doctor` 里报告最低 5 个文件 |
| 覆盖率虚高（大量 getter/setter） | 评审时看 `coverage-final.json` 的分支数，不看单一百分比 |

---

## 14. 交付

### 14.1 切片与工期

| 切片 | 内容 | 估时（人日） |
|---|---|---|
| S1 | 包骨架 · 构建链 · Config · 装配 · `arch.spec` · harness | 2.5 |
| S2 | 领域层：字数 / 分段 / 句长 / SimHash / 评分算术 / 迁移表 | 3 |
| S3 | 存储层：FsStore · 原子写 · 事务七步 · 锁 · journal · schema · migrate | 4 |
| S4 | 规则层：编译器 · 注册表 · 求值流水线 · 八类规则 | 6 |
| S5 | 门控层：12 门控 · 求值器 · 证据模型 | 4 |
| S6 | 引擎服务：22 操作 · 幂等 · 4 个投影 | 7 |
| S7 | 适配层：18 工具 · 5 命令 · 3 remote | 5 |
| S8 | 知识层：入口技能 · 7 份任务书 · 类型与平台 · 规则包内容 | 3 |
| S9 | 客户端：构建链 · slot 注册 · 面板 · remote | 4.5 |
| S10 | 预设：补丁 · 人格 · 名录测试 | 0.5 |
| S11 | 导出：md / txt / epub（内置 zlib）· 封面 SVG · 平台简介 | 2.5 |
| S12 | 多项目注册表 · 切换 · 跨项目导入 · audit · diff · rollback | 3.5 |
| S13 | 测试收口：覆盖率达标 · dirty fixture · 12 条证伪测试 · e2e harness | 4 |
| S14 | 文档 · README · 双语 · 发布门禁 · `pnpm pack` 验证 | 3 |
| | **合计** | **≈ 52.5** |

> 52.5 人日是「一个人按测试先行节奏认真做完」的量；AI 辅助下日历时间约 12–18 天。节奏是**每片先写测试、再写实现**，宁可慢，不可错。

### 14.2 导出的三个格式

| 格式 | 实现 | 校验 |
|---|---|---|
| `.md` | 章节标题 + 正文拼接 | 字数与单章一致 |
| `.txt` | 同上，无 Markdown 装饰 | 编码 UTF-8 无 BOM |
| `.epub` | **自写 ZIP 容器**（`node:zlib` deflateRaw + 中央目录），`mimetype` 首条且 store 方式 | T-12 解压回读 |

封面 SVG 由纯字符串模板生成（书名 + 类型 + 作者），不引 canvas；平台简介按模板 + 变量填充，文案可自定义。

### 14.3 发布判据（0.1.0 Release Gate）

1. §14.1 十四个切片全部完成，且每片有对应测试。
2. **覆盖率四项全部 ≥ 门槛**（§13.3），CI 绿。
3. **12 条证伪测试全绿**（§13.5）。
4. 架构测试全绿（R1~R6 + 规则码唯一 + 面板只读）。
5. 单章端到端样例：`init → plan → draft → review → revise → check → archive → export`，零手工改文件。
6. 面板在真实宿主可用：三个数据断言（项目名、章节数、门控状态）+ 一张截图。
7. 预设验收六条全过（§11.6）。
8. 卸载无残留；`--dump-config` 能看到我们那一层。
9. CHANGELOG 只列能力，不列「后续待办」。
10. **自包含**：在未安装任何其他创作工具的干净 profile 里，`pnpm pack` 产物直接安装并跑通第 5 条端到端；构建期规则包完整性校验通过；运行时无包外路径读取（§8.4）。

### 14.4 发布动作纪律

**发布纪律**：0.1.0 只做本地构建、本地安装验证与全绿；`git push`、`npm publish`、GitHub Release 需单独授权。

---

## 15. 设计决策

| # | 决策点 | 结论 | 依据 |
|---|---|---|---|
| **D-01** | 编排权归谁 | 模型编排，插件做状态机 + 门禁 | 模型擅写、不擅记；状态必须机械保证（§7） |
| **D-02** | P7/P8/P9 是否合并 | 合并为一次原子归档 | 三步之间有撕裂窗口，合并后窗口消失（§6.3） |
| **D-03** | 阶段知识怎么投递 | `novel_brief` 按需下发，不做 9 个常驻技能 | token 成本与「加载错阶段」双风险（§8.2） |
| **D-04** | 「逐字阅读」怎么验 | 三处原文引用可验证（PG-09） | 口头承诺不可验证，引用可验证（§7.7） |
| **D-05** | 分数形态 | 结构化扣分项，算术必须闭合 | 裸分数无法复核、无法定位（§7.8） |
| **D-06** | 状态文件格式 | YAML 全量 + journal 用 JSONL | 人可读 + 追加式日志（§4.2、§6.4） |
| **D-07** | 规则包 | 随包定稿 + 用户可覆盖 | 开箱可用，灵活性来自外置（§1.4、§8.4） |
| **D-08** | 是否带 Web UI | 交付「网文工坊」面板 | 入口在宿主侧栏，取数走 remote（§10） |
| **D-09** | 功能范围与节奏 | 0.1.0 全量；0.1.x 只打磨；0.2 仅重大架构升级 | 版本只承载缺陷与打磨 |
| **D-10** | 多项目 | 注册表 + 切换 + 设定包导入导出；实时共享留 0.2 | 实时共享是架构级，需共享层与冲突裁决（§6.8） |
| **D-11** | 是否带内置预设 | 交付「网文工坊」预设；工具挂根、预设只做身份与名录裁剪 | 根行必须挂面板，预设裁能力（§11.3） |
| **D-12** | 测试覆盖率 | 四项指标全局 ≥85%；domain 层 100%；分层门槛见 §13.3 | 治「大量输出但不可信」（§13） |
| **D-13** | 架构 | 六层 + `EngineService` 单一入口；工具/命令/面板/任务书皆为薄适配器 | 消灭四份实现漂移（§2） |
| **D-14** | 独立性 | 不迁移、不共存；规则包随包发布，运行时不读包外路径 | 插件自足（§1.6、§8.4） |

三条固定口径：版本从 `0.1.0` 起；`projectRoot` 默认 `./novel`；段落长度按 `total_word_count`。

---

## 附录 A：术语对照

| 术语 | 说明 |
|---|---|
| 见证书 | 正文 `chapters/*.md`，唯一权威 |
| 影子 | 由正文派生的数据 `state/*.yaml` |
| 规划 | 大纲 `outline/*.yaml`，不是数据来源 |
| 阶段任务书 | 由 `novel_brief` 投递的阶段指令 |
| 门控 | 阶段推进的硬性检查，PG-01~PG-12 |
| 核销 | delta 逐实体声明，不可静默跳过 |
| 事务 | `archiveChapter` 的原子归档 |
| 阅读证明 | 可验证引用，PG-09 |
| 服务操作 | 本引擎核心抽象，22 个 |

## 附录 B：与开发指南的对照

| 指南要求 | 本文档 | 状态 |
|---|---|---|
| `dsh.bundle.patch` 三处不能少 | §3.1 / §11.4 | ✅ |
| `engines.dsh` + `engines.node` | §3.1 | ✅ |
| peer + dev 双声明、版本钉死 | §3.1 | ✅ |
| `neverBundle` 外部化 | §3.6 | ✅ |
| Config schema + 默认值 | §12.1 | ✅ |
| `apply` 只做装配 | §2.4 | ✅ |
| 无模块级可变状态 | §2.4 | ✅ |
| 工具三层契约（参数/规范值/渲染） | §9.2 | ✅ |
| 转发 `exec.signal` | §2.5（写盘前检查 abort） | ✅ |
| 每个文件自带类型合并 + 隔离编译 | §3.5 / §13.10 | ✅ |
| 客户端半边约束 | §3.6 | ✅ |
| 客户端 slot 类型合并 | §10.1 | ✅ |
| 自定义事件带命名空间 | §3.5 | ✅ |

## 附录 C：口径唯一取值表

同一语义只允许一个取值。下表是全部可调口径的单一来源；新增口径必须先登记在此，再进规则包或代码。

| # | 口径项 | 唯一取值 | 定义处 |
|---|---|---|---|
| 1 | 伏笔最小休眠期 | 2 章 | §5.7 |
| 2 | 破折号预算 | 按场景 3/4/6/3，乘 `max(1, ceil(字数/3000))`，对话段 ×2 | §5.5 |
| 3 | 纯氛围渲染 | 机检 100/150 字判 blocker；50 字以上用于扣分、不阻塞 | §5.5 |
| 4 | 标题长度 | 门控 4–8 字；平台差异只影响建议 | §5.4 |
| 5 | 爽点密度 | 默认 1/500 字；平台可覆盖 | §5.5 |
| 6 | 无限流单副本 | 3–5 章 | §5.10 |
| 7 | 句号密度收紧名单 | 5 类（都市现代 / 轻小说 / 军事 / 末世流 / 言情） | §5.5 |
| 8 | 交接字段 | 9 个字段，单一 schema | §4.2 |
| 9 | issue 字段名 | `problem`（评审与审计共用） | §4.2 |
| 10 | 外貌一致性 | advisory；机检只给事实，判断交模型 | §5.9 |
| 11 | 严重度 | 只有 `blocker` / `advisory` | §5.11 |
| 12 | 章节摘要字段 | 10 个，统一 | §4.2 |
| 13 | 单章字数 | 默认 2000–3000；平台可覆盖 | §5.5 |
| 14 | 平台阈值方向 | 只允许收紧，不允许放宽 | §5.5 |
| 15 | 情感爆发章心理阈值 | 200 字 | §5.5 |
| 16 | 合格线 | 120（`config.quality.minScore`） | §7.8、§12.1 |

三条结构性保证：门控是 12 条枚举（不存在第二套编号）；所有检查返回结构化 `violations`（空数组即真无问题）；未声明即拒绝（不存在「未声明按 no_change 登记」）。

## 附录 D：十个常见实现坑与绕开方式

| # | 常见缺陷 | 后果 | 本引擎做法 |
|---|---|---|---|
| 1 | 弯引号/破折号/省略号落进 `english_punct`，既算字数又算违规 | 修标点后字数下降，门控倒挂 | 固定「格式先于字数」（§7.4） |
| 2 | 两个同名 `chinese_chars` | 密度指标分母错 15-20% | 强制改名 `cjkChars` / `nonWsChars`（§5.3） |
| 3 | 水字数按「行」、段落上限也按「行」 | 150/300 字阈值**永远无法触发** | 段与滑动窗口分离（§5.8） |
| 4 | 行数口径 `split('\n')` 比 `readlines()` 多 1 | 对话行上界差一 | 只定义一次 `totalLines` |
| 5 | 同一段匀速句式逻辑写两份 | 违规计数虚高 | 规则注册表，同 code 唯一实现（INV-07） |
| 6 | 跨章重复检测 `except: return []` | 检测器坏了反而「通过」 | **fail-closed**：规则异常 → `degraded` 且按 blocker |
| 7 | 合格线三处兜底 | 同一项目三个答案 | 单一来源 `config.quality.minScore` |
| 8 | 未声明文件写隐式 no_change 并返回 0 | 「命令成功但卡门控」 | 未声明 = 直接拒绝（§9.2） |
| 9 | 状态机「检查完再落盘」，无锁无 CAS | 并发两次 transition 都通过 | 双层锁 + staging + revision（§2.8） |
| 10 | 章尾钩子两套词表 | 评分与门控互相打架 | 单一词表，评分为唯一扣分出口 |

**一句话总结**：这类缺陷多数来自「同一条规则在两个地方各写一遍」。本引擎的对策不是「写得更小心」，而是**让同一条规则在结构上只有一个定义点**——规则包一份、门控表一份、词表一份、分段函数一份。这也是 §2 架构存在的根本理由。

## 附录 E：未验证事项

| # | 事项 | 状态 | 何时验证 |
|---|---|---|---|
| 1 | `dsh.bundle.patch` 数组 + 预设补丁在真实安装下的行为 | 依据官方 `web-app` 源码，未实机 | S10 实现时 |
| 2 | typert remote 命名空间声明的完整写法 | 只读到 `schedule/catalog` 用法，未写过一个 | S9 第一个任务 |
| 3 | `ctx.clock` 是否存在（本设计用自注入 `Clock`） | 未确认，已按不依赖处理 | S2 |
| 4 | EPUB 在 Readium / Apple Books 的兼容性 | 未测 | S11 |
| 5 | 面板在窄屏 / 深色主题下的真实表现 | 未测 | S9 验收 |
| 6 | 18 个工具的 prompt 成本实测值 | 估 1.5–2k，未测 | S7 完成后用真实会话量一次 |
| 7 | Windows 下 rename 语义与锁回收 | 未测（本机 WSL） | S3 + CI matrix |

> 这张表的作用：把所有「我以为」标出来。没验证的，不写成已验证。
