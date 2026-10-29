# 工具面

28 个工具全部是 `EngineService` 的薄适配器：参数窄化 → 一次操作 → 规范值 + render。

| 工具                 | 阶段     | 操作                                                                                                                                     | 写盘                                                                         |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `novel_init`         | —        | `initProject`                                                                                                                            | 是                                                                           |
| `novel_status`       | 任意     | `getStatus`；`chapter` 仅用于字数查询，`active_chapter` 才是当前章；`state_errors` 暴露 plan/review/check、八个 ledger 与 outline/worldbook 的损坏           | 否                                                                           |
| `novel_brief`        | P1~P6/P8 | `getBrief`；只签当前活跃章，返回 `fields`、`context`；`context.world_plan`、`context.context_meta` 与 `*_error` 在 `context`/`fields` 内 | 仅 `state/briefs.yaml`                                                        |
| `novel_plan_world`   | P1       | `submitWorldPlan`；数组/对象形状在服务边界窄化                                                                                           | 是                                                                           |
| `novel_plan_chapter` | P2       | `submitChapterPlan`；标题长度读 rulepack、5–8 个节拍、narrator/opening/ending 非空；可选 `cast` 1–8 人                                   | 是                                                                           |
| `novel_write_draft`  | P3       | `submitDraft`                                                                                                                            | 是                                                                           |
| `novel_review`       | P4       | `submitReview`                                                                                                                           | 是（`total` 必填；issue 维度/段落校验；blocker 不可 waived）                 |
| `novel_revise`       | P5/P6    | `submitRevision`；`content` 与 `patch:{expected_hash,edits}` 二选一                                                                       | 是（blocker 不可降级或 waived；issue 只能改 status/evidence）                |
| `novel_check`        | P6       | `runCheck`；`acknowledge` 只能列 advisory code，blocker 不可被知悉放行                                                                   | 是（五个语义项必填；`scope` 默认 content+integrity；单 scope 通过仍停留 P6） |
| `novel_archive`      | 归档     | `archiveChapter`                                                                                                                         | 事务（必须带 `state_delta`；旧 review 无 digest 时拒绝）                     |
| `novel_word_count`   | 任意     | `countWords`                                                                                                                             | 否                                                                           |
| `novel_state`        | 任意     | `queryState`；chapters 默认紧凑索引，支持 `include_summary` / `chapter_range`；`history` / `backups` / `briefs` 只读；损坏文档返回 raw     | 否                                                                           |
| `novel_amend`        | 任意     | `amend`；支持 `novel.yaml` 元数据、八个 ledger 与 outline/worldbook，带不变量、归档卡保护与单一目标 repair                              | 是                                                                           |
| `novel_rollback`     | 任意     | `rollback`；只能退回当前阶段或更早                                                                                                       | 是                                                                           |
| `novel_diff`         | 任意     | `diff`                                                                                                                                   | 否                                                                           |
| `novel_export`       | 任意     | `export`；md/txt/epub/outline/worldbook/proposal                                                                                         | 导出目录                                                                     |
| `novel_audit`        | 任意     | `auditHistory`；含被拒 attempt，支持 chapter/op/status/since/until/cursor                                                    | 否                                                                           |
| `novel_pipeline`     | 任意     | `advise`                                                                                                                                 | 否                                                                           |
| `novel_blueprint`    | 任意     | `submitBookPlan`                                                                                                                         | 是                                                                           |
| `novel_outline`      | 任意     | `submitOutline`；严格模式、归档卡保护                                                                                                    | 是                                                                           |
| `novel_outline_import` | 任意   | `importOutline`；Markdown/YAML/JSON，`dry_run` 预览                                                                                      | 可选                                                                         |
| `novel_worldbook`    | 任意     | `submitWorldbook`；按段替换                                                                                                              | 是                                                                           |
| `novel_search`       | 任意     | `search`；正文/摘要/大纲/世界观/台账                                                                                                     | 否                                                                           |
| `novel_doctor`       | 任意     | `doctor`；项目/流水线/状态/journal/正文/大纲覆盖与漂移/阶段产物/锁/备份                                                                  | 否                                                                           |
| `novel_report`       | 任意     | `report`；进度/质量/节奏/角色/伏笔/时间线/关系                                                                                           | 否                                                                           |
| `novel_guide`        | 任意     | `guide`；六态引导（no-project/new/planning/writing/blocked/finished），无项目可用                                                        | 否                                                                           |
| `novel_reopen`       | 已归档章 | `reopenChapter`；从归档备份恢复并重开 P3；`chapter` 与 `reason` 必填                                                                     | 事务                                                                         |
| `novel_restore`      | 活动章   | `restoreBackup`；从带 manifest 的备份恢复正文/计划/评审/校验；已归档章拒绝，先 `novel_reopen`                                             | 事务                                                                         |

## 错误三分类

- `EngineInputError`：改参数（阶段不对、项目不存在、路径越界）。
- `EngineBlockedError`：改正文（门控失败，`details` 列出全部阻塞）。
- `EngineFaultError`：查环境（IO、schema 过新、锁超时、事务中止）。

工具把错误格式化为 `[CODE] message — hint`。

## 0.1.3 契约补充

- 八个 ledger 损坏时 `state_errors` 的 code 为 `CHAPTERS_UNREADABLE`、`CHARACTERS_UNREADABLE`、`WORLD_UNREADABLE`、`LOCKS_UNREADABLE`、`TIMELINE_UNREADABLE`、`FORESHADOWS_UNREADABLE`、`RELATIONSHIPS_UNREADABLE`、`HANDOFF_UNREADABLE`，plan/review/check/worldPlan 有对应 `*_UNREADABLE`，`novel.yaml` 为 `PROJECT_UNREADABLE`，规划文档为 `OUTLINE_UNREADABLE` / `WORLDBOOK_UNREADABLE`。status/panel 仍可读，损坏 ledger/project/规划文档的 `next.tool = novel_amend`。
- `novel_state` 对损坏 ledger/project/review/check/outline/worldbook 返回 `{error,message,path,raw}`；`novel_amend` 的 `content` 对损坏目标必须是完整新文档，对可读 `novel.yaml` 是可变量字段 patch（目标文档与 `state/pipeline.yaml` 同一事务写入），`reason` 必填。amend 支持 `novel.yaml`，可修 title/author/description/targets.total_chapters；损坏时接受完整项目文档。
- `novel_plan_chapter.cast` 可选 1–8 人：`{name,entry_state?,goal?,knowledge?,exit_change?}`；名字必须来自 P1 世界计划或角色台账；标题不得自带 `第N章` 前缀。
- P2/P3/P4/P5/P6 brief 的 `context.world_plan` 来自 P1；P3/P4 的 `context.characters` 是本章活跃卡，`other_characters` 是压缩索引；P6 的 `context.active_cast` 受预算保护。world_plan 的目标/约束受保护，角色/地点名单可裁剪。
- `novel_state {kind:"chapters"}` 默认不含 summary；`include_summary:true` 或 `chapter_range:[start,end]` 按需取。panel 只返回最近 30 行。
- 只跑 `content` 或 `integrity` 的 `novel_check` 仍返回 `verdict:"pass"`，但 `stage` 保持 `P6` 并附 `CHECK_SCOPE_PARTIAL`；partial pass 不消耗 check 轮次；必须再跑完整 scope。
- `novel_archive` 继承 handoff 的 volume/volume_name；`act`/`act_progress` 默认按幕内位置派生，handoff 可覆盖。

## 0.1.2 契约补充（历史，仍适用）

- `novel_status` 的 `state_errors` 是结构化数组：`{path, code, message}`。当前阶段晚于重建点时 `next.tool` 为 `novel_rollback`（plan→P2、review→P4、check→P6）；已经处在重建点时直接指向 `novel_brief` 与对应阶段修复工具，不会形成 rollback 循环。P6 的 check 损坏优先于旧 revision 阻塞，直接给 `novel_check`；归档前发现 `review_digest` 缺失/不匹配时，status 给 `REVIEW_DIGEST_MISSING`/`REVIEW_DIGEST_MISMATCH` 并回退 P4。
- `novel_brief` 的 `context.context_meta` 包含 `budget/used/over_budget/protected/truncated/omitted`；`fields` 同时暴露 `plan_error/review_error/check_error`。
- `novel_check.scope` 只接受 `content`、`integrity`，空数组或未知值返回 `ENGINE_SCHEMA_INVALID`；实际 scope 写入 check 文档并参与幂等 key。
- `novel_rollback` 的阶段序：`idle < P2 < P3 < P4 < P5 < P6 < ready_to_archive < done`；`to_stage: P1` 落到 `idle`。目标晚于当前阶段时返回 `ENGINE_STAGE_ORDER`，不写盘。
- `novel_archive` 在 review 存在但 `pipeline.review_digest` 缺失时返回 `ENGINE_SCHEMA_INVALID`，提示重新 `novel_review`；不会把旧 review 当作可信输入。

## 命令

`/novel [status|next|stats|outline|guide|report|doctor|search <词>|export <kind>|admin]`、`/novel-next`、`/novel-stats`、`/novel-export`、`/novel-admin`。

## core 模式

`toolsMode=core` 只注册 10 个高频工具：`init/status/guide/brief/outline/write_draft/review/revise/check/archive`。其余 18 个通过 `/novel admin <op> <json>` 执行（例如 `/novel admin novel_state {"kind":"pipeline"}`），不是“仍可按名字调用”。多项目与设定包导入也只走命令入口：`novel_registry_list`、`novel_registry_register`、`novel_registry_activate`、`novel_registry_forget`、`novel_import`。

## 0.2.0 契约补充

- `novel_state` 新增 `kind: outline | worldbook`；损坏时返回 `{error,message,path,raw}`。
- `novel_blueprint` / `novel_outline` / `novel_worldbook` 是书级写操作，不受阶段门控，但会推进 revision 与 journal；严格大纲首次提交默认开启，已有蓝图内容时尊重显式 `strict:false`。
- `novel_amend` 允许修复 `outline/outline.yaml` 与 `outline/worldbook.yaml`；已归档卡的 title/scene/target_words/cast/word_count/score/archived_at 仍不可改。
- `novel_doctor` 新增大纲覆盖率与当前阶段产物检查；`novel_report` 的 outline/worldbook `present` 以内容为准。
- `novel_outline_import` 的 `dry_run=true` 不写盘；解析失败带 Markdown 行号。
- `novel_export` 新增 `outline | worldbook | proposal`；`chapter` 只对 `md/txt/epub` 有效。
- `novel_reopen` 必须传 `chapter` 与 `reason`；只允许紧邻的已归档章，活动章未开始；损坏的 outline 会拒绝重开，避免覆盖规划。

## 0.2.1 契约补充

- 通过参数形状校验并进入项目锁后，被 gate/delta/state 拒绝的写操作会追加 `status:"aborted"`、`attempt:true` 的 journal 行，带 `code`、`reason`、`hint` 与 `blocking`；内容文件不动，`novel_audit` 可按章、操作、状态和时间过滤，用 `seq` 游标翻页。锁前的纯参数形状错误不会写 journal（此时还没有可证明的项目上下文）。
- `novel_state {kind:"history"}` 列出 `history/` 下的评审/校验/正文/废弃稿/计划版本，返回 `entries` 全量（不静默截断）与 `total`；带 `chapter` 与正整数 `revision` 时返回该章该版本文本，未带 chapter 时默认活动章。`kind:"backups"` 返回 manifest（op/chapter/revision/files/reason）；没有 manifest 的旧备份只可列出。
- `novel_revise` 的 `patch` 模式必须带 `expected_hash`；`old_text` 默认必须唯一，`occurrence` 才允许多处；hash 不匹配时零写入。
- `novel_check` 把 blocker 放 `machine.violations`，advisory 放 `machine.advisories`；`acknowledge` 只接受本次 advisory code，未知 code 或 blocker 返回 `ENGINE_SCHEMA_INVALID`。
- `novel_restore` 只能恢复活动章；已归档章返回 `ENGINE_STAGE_ORDER`，必须先 `novel_reopen`。`paths` 省略时恢复 manifest 记录的本章正文/计划/世界观计划/评审/校验 pre-image；显式 paths 也必须在 manifest 内。每次恢复本身是事务并再建备份，不做 replay。P2/P4/P6 在已有旧文件时会建备份，因此第二次提交起计划/评审/校验可恢复。
- P2 计划文件不再写 `summary`；活动摘要/标题/场景/叙述者位于 `pipeline.draft`，归档时写入 `ChapterRecord`，`ChapterRecord.rounds/final_check/archived_at`（含 `rollbacks`）供 `novel_report.effort` 使用。归档前正文 hash 必须仍等于 `draft.content_hash`，否则返回 `ENGINE_TXN_ABORTED`；`status` 用 `DRAFT_STALE` 指回 P3。
- `card_coverage` 是“已归档章中有 archived 章卡”的逐章比例；`planned_coverage`/`archived_coverage` 才以目标章数为分母。worldbook 的 `facts` 同时进入计数、brief 上下文与 P6 数字事实检查。
- `NUMERIC_CONTRADICTION` 固定为 advisory（中文主语不明确，不能可靠区分车/船等不同对象），`NUMERIC_FACT_MISMATCH` 只匹配“别名 + 数字 + 声明单位”的相邻写法，避免把旁边的数量词当成事实。
