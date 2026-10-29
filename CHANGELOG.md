# Changelog

## 0.2.1

- **面板可滚动**：`nwe-root` 改为 `height:100%; overflow-y:auto; overscroll-behavior:contain`，宿主 `overflow:hidden` 不再裁掉下方内容；教程弹框保持 fixed，Esc/遮罩/焦点返回不回归。教程弹框新增「续写下一章」可直接复制给 Agent 的话术：先 `novel_pipeline` 确认状态，缺章卡用全量 `novel_outline`，目标章数满了用 `novel_amend`，再按 P1→P8 推进并在归档前确认 `state_delta`。
- **指标单一 owner**：`outlineSummary` 接收目标章数与已归档章号，输出规划覆盖、归档覆盖、缺卡数与逐章 `card_coverage`；`novel_status`、`novel_report`、`novel_doctor`、panel、`/novel outline` 全部消费同一结果，40/800 不再显示 100%。剩余字数按实际平均字数估算，并保留最小目标口径。
- **字数说真话**：`WordMetrics` 新增 `punctuation_chars`；PG-03 失败消息并列汉字/标点/英文词/数字；brief 增加 `word_count_policy` 和 `dialogue_ratio_target`；中文弯引号、破折号、省略号归入中文标点，对话行按四种引号统计。
- **失败可审计**：通过参数形状校验、进入项目锁后被 gate/delta/state 拒绝的写操作在 journal 写 `status:"aborted"`、`attempt:true` 行，带 `code/reason/hint/blocking`；事务提交失败与崩溃恢复的 aborted 行也带 `code`；锁前纯参数形状错误不写 journal。`AuditRow` 增加 `seq/code/reason/hint/stage/attempt/blocking`；`novel_audit` 支持 chapter/op/status/since/until/cursor。
- **历史不再只活最后一份**：评审、校验、正文、废弃稿、P2 计划按 pipeline revision 写入 `history/`；`novel_state {kind:"history"}` 全量列出（`total`），按 chapter+正整数 revision 读取；`novel_report` 从历史评审聚合维度样本，`ChapterRecord` 保存 lifetime `rounds`（含 `rollbacks`）/`final_check`/`archived_at`，report 新增 `effort`；`novel_amend` 不能改写这些归档证据。
- **备份可列可恢复**：事务备份写入 `manifest.json`；P2/P4/P6 在已有旧文件时也建备份，因此计划/评审/校验可从真实事务恢复。`novel_state {kind:"backups"}` 列出 op/chapter/revision/files；新增 `novel_restore`，只恢复活动章且不做 replay（外部再次改动后同一 txid 仍会真正恢复），已归档章先 `novel_reopen`，恢复本身再建备份。`novel_reopen` 的 journal/manifest 现在记录被重开的章节。
- **计划与摘要分权**：P2 计划文件不再被 P3/P5 写入 summary；活动标题/场景/叙述者/摘要存入 `pipeline.draft`，旧项目回退读 plan.summary；P5 不再改写 P2 证据。归档前校验 `draft.content_hash` 与正文一致，正文被外部改动时拒绝封存（`DRAFT_STALE`/`ENGINE_TXN_ABORTED`）。
- **修订成本**：`novel_revise` 支持 `patch:{expected_hash,edits}`；hash 不匹配、锚点不唯一/越界/重叠都会零写入拒绝。
- **简报收据独立**：`state/briefs.yaml` 保存 receipt，pipeline.briefs 仅作旧项目回退；重复 digest 直接 replay，rollback 后不再无条件重签。
- **伏笔标签与锚点**：`title` 可保留可读短语，新增 `anchor` 作为正文逐字校验证据，且至少 8 个字符（单字锚点不再能绕过）；无 anchor 时仍要求 title 出现在正文；P8 brief 给出规则和示例。
- **质量门禁分层**：`check.machine.violations` 只放 blocker，advisory 放 `machine.advisories`；`acknowledge` 只接受本次 advisory code。新增 `DIALOGUE_RATIO`、`NUMERIC_CONTRADICTION` 与 `NUMERIC_FACT_MISMATCH`；数字矛盾因无法判定主语固定为 advisory，数字事实只匹配“别名+数字+声明单位”的相邻写法；worldbook 支持声明式 `facts`，并进入计数、brief 上下文、搜索与 P6 检查。
- **初始化与角色**：空 author/description 返回 warning；角色 role 从显式值、P1 计划、worldbook、narrator 推导，不再一律 extra；`insight` 的 cast/维度排序改用稳定 code-unit 比较。
- **真实模型**：`agnes-2.5-flash` 与 `agnes-3.0-flash` 在临时项目完成 P1→P8、归档、report/doctor/panel、六种导出、`novel_reopen` 与重新归档；P3 366 / 490 字，P2/P3 叙述者分别继承 P1 的林深/林渊；2.5 的 564 字在更早 600 字目标下被 PG-03 真实拒绝，本次 76 字由驱动脚本 300 字下限拦截（未进引擎）；详见 `docs/0.2.1-real-model-evidence.md`。
- **发布前回归收口**：无 target 时 status/stats/panel 的 null 覆盖显示不再伪装 100%；report 对重复评审去重；novel_state pipeline 返回合并后的 briefs、briefs 查询保留 0.2.0 pipeline.briefs 回退；restore review/check 重算 blocking；archive 把 P2 计划纳入事务哈希，reopen 拒绝归档后被改动的计划；doctor 只推荐活动章可恢复备份；amend/rollback 不再用旧 revision 缓存吞掉外部改动；worldbook entries 计入 facts。
- 版本升 0.2.1；panel payload v3；工具 27 → 28（新增 `novel_restore`），服务操作 31 → 32；文档、教程、任务书与测试同步。
- 质量：72 个测试文件 / 667 条测试；覆盖率 93.86 / 89.04 / 97.81 / 93.86；per-file 门禁通过。

## 0.2.0

- **整书生命周期**：新增 `outline/outline.yaml`（书级蓝图 + 卷 + 章卡）与 `outline/worldbook.yaml`（世界观设定集）。`novel_init` 自动建立两份空文档；旧项目缺少它们时按空规划读取，不报错。
- 新增 9 个工具 / 9 个操作：`novel_blueprint`、`novel_outline`、`novel_outline_import`、`novel_worldbook`、`novel_search`、`novel_doctor`、`novel_report`、`novel_guide`、`novel_reopen`。工具总数 18 → 27，服务操作 22 → 31；`toolsMode=core` 10 个。
- 大纲支持 Markdown / YAML / JSON 导入；`novel_outline_import` 可 `dry_run` 预览，关键字段缺失带行号报错。Markdown 模板与导出模板同形。
- 新增 PG-13 `OUTLINE_ALIGNMENT`：严格模式下 P2/P3 与归档都必须有当前章卡，标题、场景类型、目标字数区间、cast 必须与章卡一致；已归档卡不可改，要改先 `novel_reopen`。非严格模式只校验已存在的章卡。
- 归档事务同步回写章卡 `archived/archived_at/word_count/score`；非严格模式归档时自动补卡，大纲因此始终是完整进度视图。
- P1/P2/P3 任务书与上下文包自动带入 `book_plan`、`outline_card` 与相关 `worldbook` 条目；P1 章卡 cast 必须在世界计划中登记。
- 新增 `novel_reopen`：只允许紧邻的已归档章、活动章尚未开始时，从该章归档事务的备份恢复索引/台账/handoff/正文并把管线重开到 P3；备份缺失即拒绝。
- P6 语义项从 4 条增至 5 条，新增 `L2-POV`（叙述视角与计划一致），五条证据必须来自不同句子。
- 新增 `novel_report`（进度/大纲漂移/世界观/质量趋势/节奏/角色/伏笔/时间线/关系/活动）、`novel_doctor`（项目/流水线/状态/journal/正文 hash/孤立正文/大纲覆盖与漂移/当前阶段产物/锁/备份/目标进度/下一步）、`novel_search`（正文/摘要/大纲/世界观/台账）与 `novel_guide`（六态：no-project/new/planning/writing/blocked/finished）。
- `novel_status` 增加书级摘要；`/novel stats` 与 `/novel-stats` 都输出大纲覆盖、蓝图就绪、世界观条目、严格模式与目标章数。
- 导出扩展到 6 种：`md` / `txt` / `epub` / `outline` / `worldbook` / `proposal`；导出幂等键纳入大纲与世界观摘要。
- 面板 payload v2：新增全书规划（进度条、卷列表最多 8 卷并提示剩余卷数）、世界观计数、质量趋势、项目健康、最近活动；旧版本面板提示刷新。面板保持只读。
- 面板右上角新增「教程」帮助入口：可访问的弹框按开书准备、P1–P8 单章流水线、下一章循环与导出给出完整步骤，并包含面板说明、常见排错、起手话术和完成清单；支持 Esc、遮罩关闭、焦点返回与移动端滚动。
- 命令新增 `/novel outline|guide|report|doctor|search`，`/novel export` 与 `/novel-export` 支持 6 种 kind；`/novel admin` 暴露全部新增操作。
- 事件新增 `novel/planned`、`novel/reopened`、`novel/exported`。
- 修复：非活动章 `planWorld` 读取补 `validateWorldPlanShape`；大纲/世界观损坏进入 `state_errors` 并阻断依赖写操作；init 的“空目录”判定包含 outline/worldbook，避免覆盖只有规划文件的项目；`novel_report` 按章去重角色出场；`runTransaction` 的 committed journal 保留 pre-image hash 以支持 `novel_reopen`。
- 规划与重开修复：outline/worldbook 读取改走 `narrow`（未知顶层键、schema 版本、book 未知键都拒绝）；`novel_amend` 对大纲先做完整语义校验并保护归档卡 cast/target_words/word_count/score/archived_at，worldbook 校验 capacity/必填文本；`novel_reopen` 改为 reason 必填、损坏 outline 拒绝覆盖、旧 journal 无 `before` 时从备份恢复；`novel_outline_import` 不再把已有蓝图/卷的 `strict:false` 强制翻成 true；列表/世界观/统计的 present 以内容为准；doctor 增加大纲覆盖率与当前阶段产物；panel 健康纳入 journal、质量均值只取最近 10 章、进度条改用目标章数；search 覆盖 world abilities/artifacts/factions/rules、locks 与 handoff；P1–P3 的 worldbook context 做硬截断。
- 规划/归档一致性修复：损坏 outline/worldbook 不再被 blueprint/outline/import/worldbook 覆盖，outline/worldbook 纳入 journal 外部改动检测；chapters 不可读时禁止规划写并保护 amend 归档卡；`novel.yaml` 降低目标章数会校验现有卷/卡；`novel_reopen` 自动补卡、对齐归档 plan、提交前校验 outline；显式 `strict:false` 通过 `strict_explicit` 保留；Markdown 导出/导入保留前提、卷外卡不再被并入末卷、归档元数据给出明确警告；`novel_diff` 支持纯文本模式；`novel_worldbook` 返回逐段 counts；report 质量趋势/角色最后出场、guide 完成态、doctor journal 下一步与 0% 覆盖率口径修正；import 重算 preview 并拒绝过期 revision；panel 显示卷的计划/归档（最多 8 卷 + 剩余提示）与 0.2.0 工具中文标签。
- 状态与日志恢复修复：replay 缓存按 revision 失效（export 按内容键跨无关 revision 幂等）；损坏的 `archive-digests.json` 从 chapter index 重建且不再拖垮 journal；缺失 journal fail-closed；尾部撕裂日志只裁剪最后一个无换行片段；崩溃前 pending 的 staging 目录清理；写临时文件失败清理 `.tmp`；worldbook `updated_at` 稳定；search 包含活动草稿并按 gate 段落口径编号；report/doctor 暴露损坏评审；reopen 拒绝覆盖归档后的 amend；规划写拒绝 projectError；卷迁移自动推导归档卡卷；时间线角色类型校验；文本 diff 可脱离项目；admin plan_chapter 不再注入非法默认值；stats 命令补齐新增字段。
- 持久化与观测修复：卷范围重排时归档卡按新区间推导卷号；`novel_amend` 保护归档索引的标题/场景/字数/评语/摘要/评分/状态等派生事实；4 位章节文件名纳入孤立正文与归档卡校验；journal 只含 lock-reclaim/空文件时 fail-closed，stale lock 不再隐藏 journal 诊断；备份先写入 staging 再原子移入 backups，崩溃不再留下不可回收目录；PG-09 引用与 check 文档先窄化再落盘；hand-edited outline 可省略 nullable 归档字段；`novel_plan_chapter` 的 target_words 不再硬编码 2000–3000 且工具 schema 补齐必填；`/novel admin` 透传 warnings/replayed；volume-only Markdown 大纲可回导；面板/命令的 next reason 中文化；docs 的 report 字段、PG-13 码、工具计数与 P4 版本同步。
- 发布前回归修复：`novel_plan_chapter` 的必填字段在工具 schema 与服务端重新对齐；`check:host` 改为先 build，再断言宿主声明全部 27 个工具，并校验预设名与面板空态/结构；README 文档链接改为 GitHub 绝对地址，修正 `toolsMode`、`novel_panel`、六种导出与工具计数等文档漂移；事务 abort 行追加前修复撕裂日志尾；同 pid 但非 live nonce 的锁按 stale 读取，不再伪装成活跃 writer；journal 对账与 `auditHistory` 在读取期间出现 writer 时丢弃半提交误报；lock reclaim 仅在原锁确实被移除时写审计行。
- 真实模型验证：`agnes-2.5-flash` 与 `agnes-3.0-flash` 在发布前最终构建的临时项目完成单章 P1→P8、归档、report/doctor/search/panel、六种导出、`novel_reopen` 与重新归档；P3 分别 931 字 / 898 字，均通过 P6，重开后无 state_errors。详见 `docs/0.2.0-real-model-evidence.md`。
- 质量：新增 `tests/book-020.spec.ts`、`tests/book-domain.spec.ts`、`tests/insight-020.spec.ts`、`tests/coverage-020.spec.ts`、`tests/review-probe-020.spec.ts`、`tests/second-review-020.spec.ts` 与 `tests/third-review-020.spec.ts`；当前 71 个测试文件 / 625 条测试；覆盖率 93.94 / 89.16 / 98.02 / 93.94；门禁为全局 statements/lines/functions 90、branches 89，engine 90/85、commands 85、client 85、viewmodel 95，新增 `engine/book.ts`/`engine/insight.ts` 的 lines/statements/functions ≥95、branches ≥93。

## 0.1.3

- 八个权威台账（chapters/characters/world/locks/timeline/foreshadows/relationships/handoff）以及 `novel.yaml` 损坏或丢失时不再拖垮 `novel_status`/panel；`state_errors` 暴露全部错误，`novel_state` 对 ledger、project、review、check 返回损坏文档的 `raw` 文本，`next` 指向 `novel_amend`。
- `novel_amend` 会为当前所有不可读状态文档豁免 journal 的既有 hash；真正可读文件的外部改动仍 fail-closed。amend 增加 chapters 只含已归档章、不减少、已归档 `content_hash`/`archive_digest` 不可改写、`next_seq` 不得复用已归档 assigned ids、locks/relationships 引用闭合、chapters 与章节文件 hash 一致、handoff 续写点与 open_hooks 闭合等不变量。
- `archiveChapter` 将每章 digest 写入 journal 跟踪的 `state/archive-digests.json`，修复 chapters 索引时用它校验归档幂等性，避免重建索引时伪造/丢失 digest。
- `novel.yaml` 可通过 amend 修改 `title/author/description/targets.total_chapters`；`genre/platform/created_at/words_per_chapter/dialogue_ratio` 保持不可变；`total_chapters` 不得低于已归档章数；项目文件损坏/丢失时接受完整项目文档并优先用备份恢复不可变基线。
- P2/P3/P4/P5/P6 brief 包含 P1 `world_plan`；P3/P4 的 `characters` 只放本章活跃角色完整卡，`other_characters` 是压缩索引；P2 的 `characters` 是 P1 候选角色；P6 新增受保护的 `active_cast`。角色排序改为 cast → 正文/计划提及 → `last_seen` → 稳定 key；正文新出现的已知角色会补进显式 cast，独立提到的短名不会被长名误杀。
- `novel_plan_chapter` 新增可选 `cast`（1–8 人：`name/entry_state/goal/knowledge/exit_change`）；名字必须来自 P1 世界计划或角色台账；旧 plan 不需要 cast 也能读。
- 归档 handoff 继承上一章 volume/volume_name；`act`/`act_progress` 从上一章推进（第五幕/1/5，不再在第 21 章重置成第一幕），`handoff.act`/`act_progress` 可覆盖且会校验；`open_hooks` 按最久未动优先。status/panel/P1 显示活跃章的下一幕位置。
- `novel_state {kind:"chapters"}` 默认返回紧凑索引（num/title/word_count/score/status），新增 `include_summary` 与 `chapter_range`；300 章默认 ≤64 KB；panel 只送最近 30 行，并显示卷/幕标签和幕内进度；panel 平均分改用全书 archived 分数，不再被 30 行上限截断。
- 只跑 `content` 或 `integrity` 的 check 通过后停留在 P6，不再进入 archive 死循环；返回 `CHECK_SCOPE_PARTIAL` warning。check 始终执行 PG-03 字数与 PG-07 评分下限，scope 只控制 PG-04/PG-10 等机检。
- 新增 `src/domain/stable.ts`：`compareText` / `stableJson` 使用 code-unit 排序，替换 localeCompare 与 registry 排序；brief digest 不再随 `LANG` 变化。
- 删除 `TRANSITIONS[].guards` 死字段，`applicableGates` 是门控唯一 owner；opening 检查抽成共享 helper；P2 标题长度读取 rulepack；EPUB 保留段首全角缩进。
- `check:host` 改为遍历请求体 `tools[]`，不再用整段 JSON 子串把 persona 文本当成工具声明；CI 增加 Windows 测试、真实 host/preset job 与跨进程 SIGKILL gate。
- 新增 30 章真实引擎闭环、120 角色 cast、300 章读口、1000 行 journal amend 测试；`scripts/check-crash.mjs` 在真实子进程 SIGKILL 后验证 pending journal 恢复。状态 schema 仍为 v1，不新增工具/命令/运行时依赖。
- 第三轮全量复核修复：`PG-11` 真正约束 P5/P6 `novel_revise`，status 按下一步实际操作选择 revise/check 预算；`PG-06` 进入 `runCheck` 与 archive preflight；`archivePreflight` 复用同一 `GateInput` 评估全部归档门控（含 PG-05/PG-06/PG-12 的 content+integrity scope）；归档不再接受被收窄 scope 的 check。
- 修复 `assigned_ids` 篡改、chapters 不可读时绕过 next_seq floor、settings pack 绕过 locks/relationships/chapters 引用与 revision 冲突；export replay key 纳入活跃章 plan title，活跃章改名后不会返回旧文件。

## 0.1.2

- `novel_init` 显式传入的 `author`/`description` 必须是字符串；P1/P2 计划在服务边界做运行时窄化：世界计划数组/对象形状、章节标题 4–8 字、narrator、5–8 个节拍、opening/ending、target_words 全部校验，非法输入零写盘。
- P4 issue 的 `dimension` 必须是当前规则包的十五维之一，`location` 必须是本章实际段落；blocker 在 P4/P5 都不能 `waived`；P5 只能改 issue 的 `status`/`evidence`，不能改写问题定义或严重度。
- `novel_rollback` 只允许退回当前阶段或更早阶段；`P3 → P6` 这类前进跳过会被拒绝。
- plan/review/check 任一文件损坏时，`novel_status`/`novel_pipeline` 仍可读，返回 `state_errors` 与 `STATE_UNREADABLE` 阻塞，`next` 指向 `novel_rollback`；回退后可用既有阶段重建，不需要手改文件。P6 的 check 损坏优先于旧 revision 阻塞，`next` 直接给 `novel_check`。
- `novel_brief` 的 `fields`/`context` 暴露 `plan_error`/`review_error`/`check_error`；损坏状态会阻断需要该文档的写操作。schema 版本高于本引擎的 plan/review/check 不会被当作“可修复损坏”，而是 `ENGINE_SCHEMA_TOO_NEW`，绝不覆盖。
- `novel_archive` 对“review 存在但没有 `review_digest`”（或摘要已不匹配）的旧数据 fail-closed；status 返回 `REVIEW_DIGEST_MISSING`/`REVIEW_DIGEST_MISMATCH`，`next` 指向回退 P4 重新评审，不会让模型反复撞归档。
- 每个 brief 阶段有独立上下文预算（P1 6000 / P2 8000 / P3 16000 / P4-P5 24000 / P6 32000 / P8 12000）；正文、当前 plan/review/check、摘要等受保护内容不裁剪，截断项与省略数写入 `context_meta` 并参与 digest；预算计算把 `context_meta` 自身的增长算进去，不再用固定预留猜大小。
- 上下文按正文/计划提及、最近程度、稳定 key 选择角色/世界/锁定/伏笔/时间线/关系；同分按名称/ID 稳定排序，输入顺序变化不改变 brief；不引入 RAG、SQLite 或新依赖。
- 水词/爽点/感官窗口改为按非空白字符推进，空格、换行、全角空格不再改变窗口结果；全角标点仍按 DESIGN 计入 `nonWsChars`。
- `RESOURCE_MISMATCH` 同时核对角色、资源名、数量与正负方向；符号必须在金额附近，远处另一段的反向词不能替它开脱。
- `ready_to_archive` 的九相位条显示 P7 进行中，P8/P9 未完成，不再把尚未发生的 P7 标成已完成。
- `novel_check` 的 `scope` 真正生效：默认 `content + integrity`，允许只跑其中一类；空数组/未知值零写盘，scope 归一化为固定顺序后写入 check 文档并参与幂等 key。
- `check:host` 新增真实 headless 工具链：临时 profile 中通过本地 Messages peer 触发 `novel_init`，断言工具声明、工具结果、项目落盘与最终回答；Web 面板与 remove 链路保留。
- 文档同步 0.1.2 的契约、升级路径与已知限制；状态 schema 仍为 v1，不新增工具/命令/运行时依赖。

## 0.1.1

- `novel_brief` 现在把 `fields` 一并返回，P4 可直接读取 `score_exclusions` 与 `next_tool`；非当前活跃章的 brief 请求被拒绝。
- `next.tool` 现在按当前阶段与 brief 的真实 digest 计算：任何阶段 brief 缺失或过期都先返回 `novel_brief`；P5/P6 有阻塞且 brief 当前后返回 `novel_revise`；`ready_to_archive` 在 P8 brief 当前后返回 `novel_archive`，不再形成 brief/read 死循环。
- brief digest 纳入 `min_score`，并改为在写锁内计算；配置或上下文变化后旧 brief 立即失效。
- P6 四个语义项必须使用四条不同、至少 8 字、来自不同句子且互不重叠的正文引用；同一句的滑动子串不再通过。
- PG-09 的开头/中间/结尾边界改用正文实际段落号；middle 必须来自正文内部，提交的 `paragraph` 只保留 ±1 定位提示。
- 新埋设伏笔的 summary title 与最终 title 都必须出现在正文；新地点/能力/物品必须在正文与 summary 同时出现；未知 world kind 与 detail 覆盖保留字段被拒绝。
- `novel_status` 增加 `active_chapter`；`novel_state` 的 `review`/`check` 支持按历史章读取。
- `engines.dsh` 收紧为 `>=0.2.1-rc.2 <0.3.0-0`，不再放行 `0.3.0` 预发布。
- 非法 YAML（状态文档、章节/世界 plan、注册表）统一转为 `ENGINE_SCHEMA_INVALID`；损坏的 plan 会在 brief 中报告并可由 `novel_plan_chapter` 覆盖修复。
- 同 pid 的陈旧锁只在 nonce 仍由本进程持有时视为活锁；释放失败、pid 复用与容器 PID 1 不再造成永久写锁；锁回收改为 hard-link 比较，避免三进程窗口误删活锁。
- `..foo` 合法路径不再误判逃逸；重复 staging path 在写盘前拒绝；已提交事务遗留的 staging 会被安全清理。
- `next_seq` 落后于台账、重复 ID、resolved 伏笔再次 advance/resolve、planted key 撞已有 ID 都会拒绝，不再产生重复 ID 或复活已解决线索。
- `PG-11` 按 `review` / `revise` / `check` 各自计数；review 预算耗尽不再误伤同一章的 check；耗尽时 `next` 指向 `novel_rollback`，status/panel 显示 PG-11。
- `PG-05` 的 `opening` 增加 12 字下限；互斥扣分对 `第 01 段` 与 `第 1 段` 使用同一 canonical key。
- `PG-10` 不再被换行拆短的重复段落绕过；`PG-07` 在归档边界重新应用互斥扣分。
- 归档边界重新校验阅读证明；缺少 `archive_digest` 的手写章节索引不再走幂等重放；review 内容摘要写入 pipeline，手工改写 review 后归档会被拒绝。
- 读操作的 `chapter` 参数统一校验；主动 draft 可按章导出；注册表命令缺少 root 时返回 `ENGINE_SCHEMA_INVALID`。
- `novel_status` 显示轮次；工具错误保留 `blocking` 数组的 code/detail/hint；根目录省略时的解析顺序在工具描述与 README 中如实说明。
- `EngineService.dispose()` 由 `apply()` 的 `ctx.effect` 托管，卸载幂等。

## 0.1.0

- 新增 `EngineService` 单一写入口：22 个操作、revision、幂等重放、`KeyedMutex` + 文件锁。
- 新增 18 个 `novel_*` 工具、5 条 `/novel*` 命令与只读 HTTP 面板数据端点。
- 新增侧边栏「网文工坊」面板：项目头、九阶段进度、章节表、阻塞区。
- 新增内置 Agent 预设「网文工坊」：工具全开，无文件写权限。
- 新增规则包编译与五步检测流水线（格式、标点、语义、跨章、词表）。
- 新增 12 条门控与十五维评分算术校验。
- 新增事务化归档：staging → verify → backup → pending journal → rename → readback → committed journal；崩溃后可按 pending hash 自动恢复或拒绝半迁移。
- 新增 Markdown / 纯文本 / EPUB 3 导出与 SVG 封面、平台简介文件。
- 新增多项目注册表与设定包导入的引擎 API（预览 diff 后在单事务内应用），并通过 `/novel admin` 暴露注册表与导入操作。
- 新增入口技能 `novel-write-engine` 与 7 份阶段任务书（P1/P2/P3/P4/P5/P6/P8）。
- 归档改为强制 `state_delta` 逐实体核销，六类状态文档（角色/世界/锁定/关系/时间线/伏笔）在同一事务内落盘。
- 新增 V8 覆盖率分层门禁与 domain 逐文件 100% 检查。
- 面板 exact route 复用 connection 的 Host/Origin/认证闸门；没有阻塞的阶段显示下一步工具与原因。
- `FsStore` 对读、写、事务目标拒绝项目内 symlink 重定向。
- `/novel admin` 增加 `novel_registry_list/register/activate/forget` 与 `novel_import`，让多项目注册表和设定包导入有显式命令入口。
- 第四轮加固：跨进程归档幂等 replay、原子锁回收、持久化 staging pre-image、活跃项目解析、面板跟随最近工具调用项目、修订不再重写评审 `content_hash`、低分评审可进入 P5、短对话不触发重复段阻塞、嵌套 schema 校验与稳定快照读取。
- 面板 UI/UX 改造：Hero + 四项统计、九阶段完成态、下一步中文动作、章节卡与评分进度、门控可视化、loading/empty/error/outdated 状态、响应式布局、键盘焦点与每 15 秒自动同步。
- 第五轮发布前加固：归档前逐文档 `narrow` 校验（非法 delta/handoff 不再写坏项目）、锁回收行不再遮蔽 pending 事务、修订 issue 状态校验、初始化不覆盖失落的 `novel.yaml` 状态、失败 root 不污染面板、长事务锁只按存活进程回收、draft/revision 备份使 `novel_diff` 有基线、journal 对全部历史 state 哈希对账、check 文档嵌套校验、面板单章完成态与全书完成态区分、工具警告回传、preset 补回 subagent 控制工具。
