# dsh-novel-write-engine 实施计划（0.1.0）

> **0.1.3 迭代方案**见 [docs/0.1.3-plan.md](docs/0.1.3-plan.md)。本文件保留为 0.1.0 的历史实施计划，不再代表当前版本范围。

| 项 | 值 |
|---|---|
| 计划版本 | 1.0 |
| 日期 | 2026-10-26 |
| 目标版本 | `0.1.0`（全量功能，一次做完） |
| 规格来源 | [DESIGN.md](DESIGN.md)（2191 行，唯一权威） |
| 切片 | S1–S14，合计 **≈52.5 人日** |
| TDD 路线 | `strict`（先红后绿，测试与实现同片提交） |
| 覆盖率 | 全局四项 ≥85%；分层门槛见 §6；S13 冻结 |
| 执行路线 | inline（顺序执行，单写者） |

---

## 1. 目标与成功判据

**目标**：交付一个可安装的 DSH 插件，把小说创作的「状态、门禁、规则、账本」从提示词搬进代码——18 个工具、5 条命令、1 个侧边栏面板、1 个内置预设、1 份入口技能，全部由 `EngineService` 单一入口驱动。

**成功判据**（等于 DESIGN §14.3 发布门，逐条可验）：

1. 十四个切片全部完成，每片有对应测试。
2. 覆盖率四项（lines/branches/functions/statements）全部达标，CI 绿。
3. 12 条证伪测试全绿（§9.2 映射表）。
4. 架构测试全绿（R1–R6 + 规则码唯一 + 面板只读）。
5. 单章端到端：`init → plan → draft → review → revise → check → archive → export`，零手工改文件。
6. 面板在真实宿主可用，三个数据断言 + 一张截图。
7. 预设验收六条全过。
8. 卸载无残留；`--dump-config` 可见本插件层。
9. CHANGELOG 只列能力。
10. 自包含：干净 profile 里 `pnpm pack` 产物直接安装并跑通第 5 条。

---

## 2. 依据与基线

| 项 | 值 | 说明 |
|---|---|---|
| 宿主版本 | `>=0.2.1-rc.2 <0.3.0` | `engines.dsh` |
| 验证基线 | DSH `0.2.1-rc.3` | npm 已确认可解析 |
| Node | `>=24.9.0` | 本机 24.19.0 |
| pnpm | 11.x | 本机 11.28.5 |
| 运行时依赖 | `yaml` 一个 | 其余全部 devDependencies |
| 规格 | DESIGN.md | 本文不重复规格内容，只给执行顺序与验收 |

**需求就绪检查**：目标、边界、验收与数值口径均在 DESIGN.md 中唯一确定（附录 C 为口径唯一取值表）。无未决需求项。

**为何必须写代码**：本插件要消灭的正是「状态与门禁靠模型自觉」；提示词、文档、配置都无法提供机械保证。最小代码边界 = `EngineService` + `FsStore` + 规则求值 + 12 门控，即 S2–S6。

---

## 3. 架构与所有权

| 层 | 目录 | 所有权 | 测试形态 |
|---|---|---|---|
| L0 类型 | `src/types.ts` `src/codes.ts` `src/constants.ts` | 类型与错误码 | 类型检查 |
| L1 领域 | `src/domain/` | 纯函数：字数/分段/句长/SimHash/评分/ID/迁移表 | 表驱动单测 |
| L2 规则 | `src/rules/` | 规则包编译、注册表、求值 | 纯单测 + golden |
| L3 存储 | `src/store/` | 唯一 IO：原子写、事务、锁、迁移 | 真实 tmpdir |
| L4 引擎 | `src/engine/` | 22 操作、门控、任务书、投影 | 集成 |
| L5 适配 | `src/tools/` `src/commands/` `src/remote/` `src/skills/` | 薄壳 | 假 engine |

**单一入口**：工具、命令、面板、任务书只能调 `EngineService`；不存在第二条写路径。分层由 `tests/arch.spec.ts` 静态断言，不靠自觉。

**新表面检查**：18 工具、5 命令、3 remote 方法、1 技能、1 面板、1 预设都是新公开面。无既有 owner 可复用（`ctx.fs` 缺目录与事务能力，§3.3 已否）；不为兼容保留任何旧路径。

---

## 4. 技术栈与构建

```
运行时    Node 24 + TypeScript（ESM），单依赖 yaml
构建      tsdown（host, clean:true）→ tsdown -c client（clean:false）→ tsc -p tsconfig.client.json
产物      lib/index.js + lib/index.d.ts + lib/client.js（lazy-CJS factory）
测试      vitest + @vitest/coverage-v8 + happy-dom + @testing-library/react
静态      eslint + prettier；开发脚本用 Node 原生类型剥离（不引 tsx）
CI        GitHub Actions（typecheck → lint → build → coverage → isolated → pack）
```

`package.json` scripts（S1 落地）：

```jsonc
{
  "build": "tsdown && tsdown -c tsdown.client.config.ts && tsc -p tsconfig.client.json",
  "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit",
  "lint": "eslint . && prettier --check .",
  "test": "vitest run",
  "test:coverage": "vitest run --coverage",
  "test:isolated": "node scripts/check-isolated.ts",
  "validate:rulepack": "node scripts/validate-rulepack.ts"
}
```

**不引入**：zod / ajv / lowdb / sqlite / tsx / 任何 UI 组件库。面板用语义化 HTML + 主题变量，不引 `ui-primitives`，把上游依赖面压到最小。

---

## 5. TDD 路线

| 字段 | 值 |
|---|---|
| mode | `auto` |
| decision | **strict** |
| 授权 | 用户明确要求覆盖率 ≥85%；DESIGN §13.4 规定测试先行；项目从零构建，无存量兼容负担 |
| 测试姿态 | 每片先写失败测试 → 最小实现 → 重构；测试与实现同片提交 |
| 证据 | 每片提交前跑 `pnpm test:coverage`，本层门槛达标才允许提交 |

**切片内顺序**：契约测试 → 领域测试 → 集成测试。禁止先写实现再补测试（`arch.spec` 之外无例外）。

---

## 6. 覆盖率门禁（随切片加严）

| 切片 | 本片冻结的门槛 | 说明 |
|---|---|---|
| S2 | `domain` 100/100/100/100（perFile） | 纯函数，无理由不满 |
| S3 | `store` 92/88/92/92 | 真实 tmpdir + 故障注入 |
| S4 | `rules` 95/90/95/95 | 规则分支多 |
| S5–S6 | `engine` 90/85/90/90 | 真 store + 真 rules |
| S7 | `tools`/`commands`/`remote` 85 | 假 engine |
| S9 | `client` 85（viewmodel ≥95） | happy-dom + 假 ctx |
| S13 | **全局 85/85/85/85** 并冻结 | 兜底 |

**防作弊**（S1 落地、S13 复审）：`v8 ignore` 全仓 ≤5 处且必带理由；禁止 `.skip/.only/.todo`；禁止空断言；门槛只升不降，降门槛需人工批准并在 CHANGELOG 记录。

---

## 7. 任务分解

> 每片固定交付五件：文件、测试、验收命令、覆盖率状态、CHANGELOG 条目。
> 每片独立可运行、可回滚；不跨片共享未完成的临时文件。

### S1 · 包骨架与构建链（2.5 人日）

**目标**：空插件能装、能构建、能跑测试，架构约束与宿主替身就位。

**文件**
```
package.json  cordis.patch.yml  tsdown.config.ts  tsdown.client.config.ts
tsconfig.json  tsconfig.client.json  vitest.config.ts  eslint.config.js
.prettierrc.json  .gitignore  LICENSE  README.md  CHANGELOG.md
src/index.ts  src/types.ts  src/codes.ts  src/constants.ts
tests/harness/context.ts  tests/arch.spec.ts  tests/smoke.spec.ts
```

**要点**
- `dsh.bundle.patch` 指向根补丁；`dsh.client` 声明 web 半边；`files` 白名单 `lib/rulepacks/briefs/skills`。
- `apply()` 只装配：建 store（懒连接）、编译规则包（S4 前用空包桩）、注册适配器（S1 为空）、`ctx.effect` 托管清理。
- `tests/harness/context.ts`：12 个原语的假 `Context`（tools/skills/commands/logger/effect/inject/remote/...）。
- `tests/arch.spec.ts`：R1–R6 的扫描器从第一天就在（此时全绿是平凡真）。

**测试（先写）**
- `smoke.spec.ts`：`apply()` 不产生 IO（mock fs，断言零调用）；卸载时 `dispose` 被调用。
- `arch.spec.ts`：构造一个故意违规的临时源码字符串，断言扫描器能报错（元测试，防扫描器假绿）。

**验收**
```
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test
pnpm build && node --check lib/client.js   # 此时 client 为空壳也要可 check
pnpm pack --dry-run                        # 产物只含白名单
```

**完成定义**：以上全绿；`pnpm test:coverage` 只统计已存在文件（domain 尚空，不设门槛）。

---

### S2 · 领域层（3 人日）

**目标**：所有确定性算术与表在这里一次写完，100% 覆盖。

**文件**
```
src/domain/words.ts      # totalWordCount / cjkChars / nonWsChars / englishWords / numbers / punctuation
src/domain/paragraphs.ts # 分段、段字数、滑动窗口
src/domain/sentences.ts  # 句长序列、匀速检测、句号密度
src/domain/simhash.ts    # 段落级 SimHash + 相似度
src/domain/scoring.ts    # 150 分算术、维度封顶、互斥去重
src/domain/ids.ts        # FS/TE/RL/WS/IT 分配
src/domain/transitions.ts# 迁移表 + to() 纯函数
src/domain/index.ts
tests/domain/*.spec.ts
```

**必须覆盖的边界**（来自 DESIGN 附录 C/D）
- 弯引号 `“”`、破折号 `——`、省略号 `……` 计入 `englishPunct` 且同时可被判违规。
- `ABC123` 的 `123` 不计数字；全角与半角标点互斥不重叠。
- 空文本、纯空白、超长单段、90 字边界（89/90/91）。
- SimHash 确定性：同输入同输出；相似度 0.749/0.750/0.899/0.900 四点。
- 评分：`total = 150 - Σdelta`；维度扣满即止；同片段互斥只计一次；delta ≤0 拒绝。
- 迁移矩阵：`(stage × op)` 全组合，允许/拒绝 + `to()` 两个分支（P4 评审有/无 blocker）。

**验收**：`pnpm test -- domain`；`pnpm test:coverage` 中 `domain` 四项 100（perFile）。

---

### S3 · 存储层（4 人日）

**目标**：唯一 IO 层，做到「撕裂在结构上不存在」。

**文件**
```
src/store/path.ts      # resolve 后 startsWith(projectRoot+sep)；拒 .. / 绝对路径 / NUL / Windows 保留名
src/store/fs.ts        # readText/readYaml/exists/list/stat；YAML 窄化 + schema_version
src/store/atomic.ts    # 同目录 .tmp → fsync → rename → 目录 fsync
src/store/txn.ts       # 七步：stage/verify/backup/commit/journal/readback
src/store/lock.ts      # KeyedMutex + .engine.lock（O_EXCL, pid, startedAt）
src/store/journal.ts   # JSONL 追加 + 启动对账
src/store/schema.ts    # 12 份 YAML schema 的窄化器
src/store/migrate.ts   # v1→v2 链（0.1.0 无实际迁移，保留骨架 + 测试）
src/store/registry.ts  # 多项目注册表（S12 用，先建接口）
tests/store/*.spec.ts  tests/fixtures/projects/*
```

**测试（先写）**
- T-07 路径矩阵：`../x`、`/etc/passwd`、`C:\x`、`a\0b`、`CON`、`com1.txt` 全部 `ENGINE_PATH_ESCAPE`。
- T-08 schema 过新：`schema_version: 2` 拒绝且文件未被改写。
- T-09 迁移回滚：迁移中途抛错 → 目录快照与迁移前全等。
- 事务中止：staging 已写三个文件后注入失败 → 真实文件零变更、journal 记 `aborted`。
- 锁回收：pid 不存在 / startedAt 早于 90s → 回收并记 `lock_reclaimed`。

**验收**：`pnpm test -- store`；`store` 92/88/92/92；Windows 相关分支用 `v8 ignore` + 理由（预算内）。

---

### S4 · 规则层（6 人日）

**目标**：规则包编译一次、求值一次，同码唯一实现。

**文件**
```
src/rules/compiler.ts   # load → narrow → validate(6 断言) → normalize(优先级链) → freeze
src/rules/registry.ts   # code → 唯一实现；重复注册抛 ENGINE_RULEPACK_INVALID
src/rules/pipeline.ts   # 五步流水线（分段→密度→引号占比→豁免→词表）
src/rules/severity.ts
src/rules/checks/format.ts      # MD 污染 / 引号 / 分号 / 英文省略号 / 场景分隔 / 长段 / 标题 / 系统标签
src/rules/checks/lexicon.ts     # 零容忍 / soft / contextual / 元叙述 / 读者侵入 / 上帝视角 / 结论先行
src/rules/checks/punctuation.ts # 破折号预算 / 句号密度 / 省略号 run / 匀速 / 连续「了」
src/rules/checks/rhythm.ts      # 节奏画像输出
src/rules/checks/semantics.ts   # 形容词密度 / 爽点密度 / 感官 / 水字数（滑动窗口）
src/rules/checks/crosschapter.ts# 重复 / 伏笔休眠 / 资源余额 / 时间倒退 / 关系未声明
rulepacks/default.yaml  # 结构与全部阈值（词条内容 S8 补全）
scripts/validate-rulepack.ts
tests/rules/*.spec.ts  tests/fixtures/rulepacks/*.yaml
```

**测试（先写）**
- 编译器六条断言，每条一个非法包 fixture（sum≠150、坏 severity、重复码、exclusion 环、悬空键、阈值越界）。
- T-06：同 code 注册两次 → 报错。
- 顺序语义：先算引号占比再豁免；词表最后跑；豁免逐规则声明。
- 水字数用滑动窗口：在「单段 ≤90 字」的合规文本上仍能触发 150 字阈值。
- golden：`dirty.md` 每条规则至少一个命中，断言 `code + severity + paragraph` 三元组。

**验收**：`pnpm test -- rules`；`rules` 95/90/95/95；`pnpm validate:rulepack` 通过。

---

### S5 · 门控层（4 人日）

**目标**：12 条门控是纯函数，顺序固定，一次收集全部失败。

**文件**
```
src/engine/gates/index.ts     # GATE_REGISTRY + evaluateGates(固定顺序)
src/engine/gates/pg01..pg12.ts
src/engine/gates/evidence.ts  # reading proof 派生位置 + 子串校验
tests/gates/*.spec.ts
```

**测试（先写）**
- 顺序：构造同时违反 PG-03/PG-04 的输入，断言失败列表里 PG-04 在 PG-03 之前。
- 收集全部：一次返回 ≥3 条阻塞，而不是首条即返。
- T-03：不存在的片段 → `ENGINE_READING_PROOF_INVALID`；片段真实但错段（±1 之外）→ 拒绝；短于 12 字 → 拒绝。
- T-04：`total` 与 `150 - Σdelta` 差 1 → `ENGINE_SCORE_MISMATCH`。
- PG-11：轮次超限 → 阻塞；轮次由引擎自增，模型传轮次参数被忽略/拒绝。

**验收**：`pnpm test -- gates`；`engine/gates` 计入 engine 门槛。

---

### S6 · 引擎服务（7 人日）

**目标**：22 个操作全部落地，四条通道共用。

**文件**
```
src/engine/service.ts        # 22 操作 + keyedMutex + 幂等表 + revision
src/engine/errors.ts         # 三分类 + 错误码
src/engine/brief.ts          # 任务书组装 + digest + 签收
src/engine/projections/{summary,chapters,gates,stats}.ts
src/engine/journal.ts        # txid 生成 + 写盘
tests/engine/*.spec.ts
```

**测试（先写）**
- 22 个操作各至少一条成功 + 一条失败；写操作断言返回新 revision。
- 幂等：同键二次提交返回 `replayed: true` 且目录零变化。
- T-01：注入必失败门控 → 项目目录三态快照（路径+mtime+hash）前后全等。
- T-02：`Promise.all([archive, archive])` → 一成一败（或幂等 replay），无撕裂。
- INV-04：随机 100 次写 → 每条 journal txid 与写盘一一对应。
- 投影：`getStatus` / 命令 / 面板三处对同一快照输出一致（同一函数，三处调用）。

**验收**：`pnpm test -- engine`；`engine` 90/85/90/90。

---

### S7 · 适配层（5 人日）

**目标**：18 工具 + 5 命令 + 3 remote，全是薄壳。

**文件**
```
src/tools/index.ts + 18 个工具文件（init/status/brief/plan-world/plan-chapter/
  write-draft/review/revise/check/archive/word-count/state/amend/rollback/diff/export/audit/pipeline）
src/commands/index.ts        # /novel、next、stats、export、admin
src/remote/index.ts + types.ts
tests/tools/*.spec.ts  tests/commands/*.spec.ts  tests/remote/*.spec.ts
```

**测试（先写）**
- 每个工具：参数窄化失败 → `ToolArgsError`；成功 → 规范值形状 + render 输出断言。
- 错误映射：`EngineInputError` / `EngineBlockedError` / `EngineFaultError` 三种 message 形状。
- T-10：remote 导出对象运行时无写方法（属性枚举 + `@ts-expect-error` 双层钉死）。
- `/novel admin` 在 `tools.mode=core` 下可达隐藏的 10 个操作；`mode=all` 下不产生重复注册。
- 工具总数断言：`mode=all` 时恰好 18 个，`mode=core` 时恰好 8 个。

**验收**：`pnpm test -- tools commands remote`；适配层 85/85/85/85；记录一次真实会话的 18 工具 prompt 成本（回填附录 E #6）。

---

### S8 · 知识层（3 人日）

**目标**：技能、任务书、词表、类型与平台差异全部定稿。

**文件**
```
src/skills/entry.md + index.ts
briefs/{P1,P2,P3,P4,P5,P6,P8}.md
rulepacks/default.yaml        # 补全：62 词零容忍（总词条 96）、soft/contextual、12 类型、4 平台
tests/knowledge/*.spec.ts
```

**测试（先写）**
- 入口技能 ≤120 行，六条铁律齐全（快照 + 断言关键句）。
- 7 份任务书 digest 稳定；`getBrief` 对每个阶段返回字段与上下文包固定。
- 规则包：12 类型全部有键；4 平台全部有覆盖；词条无重复、无空值；`validate-rulepack` 通过。
- 0.1.0 仅中文：不期待 `locale/`，配置里也没有语言字段。

**验收**：`pnpm test -- knowledge`；`pnpm validate:rulepack`；规则包加载 <50ms。

---

### S9 · 客户端半边（4.5 人日）

**目标**：左侧栏「网文工坊」+ 只读面板，数据走 remote。

**第一个任务（spike，≤0.5 天）**：验证 typert remote 命名空间声明写法（附录 E #2）。若比预期重，立即切退路：面板降级为「静态壳 + 刷新按钮」，数据仍由对话内工具卡片呈现，**不阻塞 Host 交付**。

**文件**
```
tsdown.client.config.ts  src/client/entry.ts  src/client/index.tsx
src/client/panel/{index,ProjectHeader,ChapterTable,BlockedPanel}.tsx
src/client/viewmodel.ts  src/client/dto.ts
tests/client/*.spec.tsx
```

**测试（先写）**
- viewmodel：快照 → 面板数据的纯函数，≥95% 覆盖。
- 注册：假 ctx 断言 `sidebar.panellist` 与 keyed `main` 各注册一次，id 一致。
- 渲染：happy-dom 渲染三块内容；空项目、单章、门控阻塞三种状态。
- DTO 版本不匹配 → 显示「需刷新」而非崩溃。

**验收**：`pnpm build` 后 `lib/client.js` 以 `window.__ModuleLoader__.load({ id: "dsh-novel-write-engine"` 开头且 `node --check` 通过；面板在真实宿主显示真实数据（≥3 章样例）。

---

### S10 · 内置预设（0.5 人日）

**文件**：`cordis.patch.yml`、`presets/novel-write-engine.patch.yml`、`tests/preset/*.spec.ts`

**测试（先写）**
- T-11：`entryListProblem()` 通过；9 个顶层行 id 唯一；每个 `name` 可解析；group 的 isolate 键存在。
- 根补丁只有一行整包；预设补丁不重复插入工具。

**验收**：预设卡片显示、排序 20；会话头显示名字；对话开始后切换被拒；该会话含 18 个 `novel_*` 且不含 bash/pwsh/fs/fs-search；标准会话里 `novel_*` 仍在。

---

### S11 · 导出（2.5 人日）

**文件**
```
src/export/{index,markdown,txt,epub,zip,cover,blurb}.ts
tests/export/*.spec.ts
```

**要点**：EPUB 用 `node:zlib` 自写 ZIP（deflateRaw + 中央目录），`mimetype` 首条且 store 方式；封面纯 SVG 字符串；简介模板 + 变量填充。

**测试（先写）**
- T-12：解压回读，`mimetype` 首条且未压缩，`mimetype` 内容恰为 `application/epub+zip`。
- `.txt` 无 BOM；`.md` 字数与单章一致；导出目录幂等（同 kind/chapter 重跑不重复追加）。
- 封面 SVG 可被 XML 解析；书名/类型/作者变量正确转义。

**验收**：`pnpm test -- export`；三格式在样例项目上产出可打开。

---

### S12 · 多项目与运维能力（3.5 人日）

**文件**
```
src/store/registry.ts         # projects.yaml 读写 + active
src/engine/import.ts          # 设定包导入（显式、可 diff）
src/engine/audit.ts           # journal → 历史审计
src/engine/diff.ts            # revision 间差异
src/engine/rollback.ts        # 按 chapter 回退到指定阶段
tests/engine/{registry,import,audit,diff,rollback}.spec.ts
```

**测试（先写）**
- 注册表只是便利设施：删除后项目仍可打开（配置优先）。
- 导入：非法包拒绝；重复导入同一包幂等；导入前给出 diff 预览。
- 回退：回退后 stage/rounds 正确，正文按策略保留或标记废弃。
- 审计：journal 损坏/截断时给出可恢复提示，不自动改文件。

**验收**：`pnpm test -- registry import audit diff rollback`。

---

### S13 · 测试收口（4 人日）

**目标**：把「覆盖率 ≥85%」变成不可糊弄的门禁。

**文件**
```
tests/falsify/T-01..T-12.spec.ts   # 12 条证伪测试
tests/e2e/three-chapters.spec.ts   # 3 章样例全流程
scripts/check-v8-ignore.ts         # ignore 预算检查
vitest.config.ts                   # 冻结最终 thresholds
tests/fixtures/dirty/              # 规则回归集
```

**验收**
```
pnpm test:coverage    # 全局 85/85/85/85，分层门槛全过
pnpm test:isolated    # 每源文件独立 tsc
pnpm test             # 12 条证伪 + e2e 全绿
```
`doctor` 报告覆盖率最低的 5 个文件（防「全局达标、个别 0%」）。

---

### S14 · 文档与发布门禁（3 人日）

**文件**：`README.md`、`CHANGELOG.md`、`docs/{tools,states,rulepack}.md`、`.github/workflows/ci.yml`、`scripts/check-pack.ts`

**验收**
- §1 的十条成功判据逐条勾选。
- `pnpm pack` 产物只含白名单；干净 profile 安装后跑通 S13 的 e2e。
- 卸载后无残留（目录、配置键、面板入口、预设卡片）。
- CHANGELOG 只列能力，不列待办。

---

## 8. 依赖关系与执行顺序

```
S1 ─▶ S2 ─▶ S3 ─▶ S4 ─▶ S5 ─▶ S6 ─▶ S7 ─┬─▶ S8 ─┐
                                        ├─▶ S9 ─┼─▶ S11 ─▶ S12 ─▶ S13 ─▶ S14
                                        └─▶ S10 ┘
```

- S8、S9、S10 互不依赖，可在 S7 后并行；单人顺序执行时按 S8 → S9 → S10 推进。
- S11 依赖 S6（正文分页）与 S9 无强依赖；S12 依赖 S3（registry）与 S6（journal）。

---

## 9. 验证总账

### 9.1 命令矩阵（每片必跑）

```
pnpm typecheck      # host + client 两套 tsconfig
pnpm lint           # eslint + prettier --check
pnpm test           # 单测 + 集成
pnpm test:coverage  # 门槛在此生效
pnpm build          # 三阶段构建
pnpm test:isolated  # 单文件隔离编译（类型合并缺失只有这里能暴露）
```

### 9.2 12 条证伪测试落点

| # | 目标 | 落点 |
|---|---|---|
| T-01 | 门控失败零写盘 | S6 |
| T-02 | 并发归档一成一败 | S6 |
| T-03 | 读证明不可伪造 | S5 |
| T-04 | 分数算术闭合 | S5 |
| T-05 | delta 不能静默跳过 | S6 |
| T-06 | 规则码唯一 | S4 |
| T-07 | 路径不可逃逸 | S3 |
| T-08 | schema 过新拒绝 | S3 |
| T-09 | 迁移可回滚 | S3 |
| T-10 | 面板只读 | S7 |
| T-11 | 预设名录合法 | S10 |
| T-12 | EPUB 可解压 | S11 |

### 9.3 每片完成定义

1. 测试先红后绿，无先实现后补测。
2. 四条命令全绿：`typecheck` / `lint` / `test` / `test:coverage`。
3. 本层覆盖率达标；`v8 ignore` 数不增加（或增加处有理由且预算内）。
4. 无 `TODO` / `.skip` / `.only`。
5. CHANGELOG 增加一条能力描述（不写「后续」）。

---

## 10. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| typert remote 写法比预期重 | 中 | S9 卡住 | S9 首任务 spike；退路是静态壳 + 工具卡片，不阻塞 Host |
| DSH 客户端 API 漂移 | 中 | 构建失败 | 只引 3 个槽位与 `ctx.remote`；`test:isolated` 早期暴露 |
| 18 工具 prompt 成本超预期 | 中 | 上下文压力 | S7 实测；超 2k 则默认改 `tools.mode=core` + `/novel admin` |
| Windows rename/锁语义差异 | 中 | CI 红 | Linux 为主；Windows 分支 `v8 ignore` + CI matrix 备注 |
| 覆盖率靠 getter 刷高 | 低 | 门禁失真 | 评审看 `coverage-final.json` 分支数；S13 报告最低 5 文件 |
| EPUB 阅读器兼容 | 低 | 导出不可用 | S11 手动验 Readium/Apple Books；T-12 保证结构正确 |
| 上游 peer 版本变动 | 低 | 安装失败 | peer 钉到 `0.2.1-rc.3`；升级单独立项 |

**明确不做**：不推送、不发布、不建 GitHub Release（需单独授权）；不加第二个运行时依赖；不实现跨项目实时共享（D-10）。

---

## 11. 交付与提交纪律

- **一切片一提交**：整片测试通过、覆盖率达标、自检完成后提交；提交信息 `feat(sN): <能力>`。
- **提交前快照**：记录改动文件清单与关键断言，便于回滚。
- **不跨片携带未完成代码**：每片结束时仓库可构建、可测试。
- **v0.1.0 打 tag 在 S14 之后**，由用户授权。

---

## 12. 计划自检

| 检查项 | 结果 |
|---|---|
| 覆盖 DESIGN 全部 14 个切片 | ✅ S1–S14 一一对应 |
| 每片有可执行验收命令 | ✅ §9.1 + 各片验收 |
| 每片有测试前置 | ✅ §5 strict |
| 覆盖率门槛可检验 | ✅ §6 随切片加严，S13 冻结 |
| 12 条证伪测试有落点 | ✅ §9.2 |
| 无占位符 / TBD | ✅ |
| 分层与所有权一致 | ✅ §3 与 DESIGN §2 一致 |
| 风险有缓解 | ✅ §10 |
| 不越权发布 | ✅ §11 |

**执行路线**：inline。S1 完成后逐片推进；每片结束向用户汇报一次（一行状态 + 覆盖率数字），不做长任务静默。
