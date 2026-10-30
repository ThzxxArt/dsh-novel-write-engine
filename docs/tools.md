# 工具面

28 个工具全部是 `EngineService` 的薄适配器：参数窄化 → 一次操作 → 规范值 + render。

## 0.2.6 证据、锚点与面板契约

- 语义证据：`novel_check` 的 `semantic[]` 仍是五项；失败时逐项 `items` + `conflicts`（`duplicate|same_sentence|interval_overlap`，带 `other_id/overlap_text/overlap_chars/overlap_ratio/sentence`），submission 错误 message 列出最多 5 条配对摘要，aborted journal 写紧凑 blocking。
- 实体锚点：`summary.new_element_anchors` 是章级唯一输入；`locations/abilities/artifacts` 的每个 name 映射到 1..8 个 2..120 字正文锚点。PG-05 与归档共用；有锚点时任一命中即可，无锚点才退回 name。新 world 实体持久化 `anchors`，旧文档不需要迁移。
- 面板 v6：`summary.bookData` additive，含 identity/blueprint/progress/current/worldbook/cast/relationships/foreshadows/timeline/outline/quality/pacing/effort/health；旧 v5 payload 显示刷新。`health` 增加 `pending`，`quality` 明确区分全书 `average` 与 `last_ten_average`。
- pipeline 恢复：`novel_restore { paths: ["state/pipeline.yaml"], txid }` 只接受损坏 pipeline 的备份恢复，不绕过 journal hash；恢复前 status/doctor 报告 `PIPELINE_UNREADABLE`。
- summary-only 的 PG-01 旁路只对紧随其后的 P6 check 生效，archive 仍需新的 P8 brief。

## 0.2.5 证据、修订与恢复契约

- `novel_check.semantic` 的五条引文可跨句/跨段；每条返回 `state`、`quote`、`nearest`、`conflict_with`。形状错误/引文不存在属于 submission error：`ENGINE_CHECK_SUBMISSION_INVALID`，不写 check、不消耗 `rounds.check`，错误行带 `items`。
- 只有正文/机器门真的 content failure 才写 `failure_class:"content"`、`counted:true` 并增加 `rounds.check`；pass 不增加。
- `novel_revise` 新增 summary-only：只传 `chapter` + `summary`（不带 `content`/`patch`/`proof`），正文 hash/章历史不变，不消耗 revise 轮次；从 P6/ready_to_archive 可直接继续 check/archive。content/patch 修订仍要求 `proof`。
- `novel_archive` 的 `state_delta.world` 以 `state/world.yaml` 存在性为准，返回 `delta_warnings`/`normalized_world`；`summary.new_elements` 只是意图声明。
- status/doctor/audit/panel 会报告 `PENDING_RECOVERABLE`、`PENDING_ABORTABLE` 或 `ENGINE_PENDING_PARTIAL`；只读面不写 pending 的 terminal row。
- 错误行统一：`[CODE] message — hint`，`EngineBlockedError` 附 `blocking`，submission 错误附 `items`（tools 与 commands 一致）。

## 0.2.4 大纲写入契约

- `novel_outline.chapters` **按 `num` upsert**，`volumes` **按 `title` upsert**；未提交的卡不删。
- 删除只能显式：`remove: number[]`、`remove_volumes: string[]`；活动章、归档章、不存在的章、已完成卷会被拒绝。只删不写时可省略 `chapters`：`novel_outline {remove:[2]}`；空 `{}`/`chapters:[]` 是 no-op。
- `dry_run:true` 返回 `would_add/would_update/would_remove`，不写盘、不写 journal。
- 成功返回 `added/updated/removed`（章）与 `volumes_added/volumes_updated/volumes_removed`（卷）；三者之外的卡不变。
- `novel_outline` 正常写入保留上一版 `outline/outline.deprecated.yaml`；`novel_restore {txid, paths:["outline/outline.yaml"]}` 可从备份恢复整份大纲（要求与当前章索引一致）。
- `novel_blueprint.volumes` 仍是整体 replace；删卷必须 `confirm_remove:true`。

| 工具                 | 阶段     | 操作                                                                                                                                     | 写盘                                                                         |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `novel_init`         | —        | `initProject`                                                                                                                            | 是                                                                           |
| `novel_status`       | 任意     | `getStatus`；`chapter` 仅用于字数查询，`active_chapter` 才是当前章；`selection` 暴露 root/source；`state_errors` 暴露 plan/review/check、八个 ledger 与 outline/worldbook 的损坏 | 项目正文否；显式 `project_root` 成功会写会话绑定 |
| `novel_brief`        | P1~P6/P8 | `getBrief`；只签当前活跃章，返回 `fields`、`context`；`context.world_plan`、`context.context_meta` 与 `*_error` 在 `context`/`fields` 内 | 仅 `state/briefs.yaml`                                                        |
| `novel_plan_world`   | P1       | `submitWorldPlan`；数组/对象形状在服务边界窄化                                                                                           | 是                                                                           |
| `novel_plan_chapter` | P2       | `submitChapterPlan`；标题长度读 rulepack、5–8 个节拍、narrator/opening/ending 非空；可选 `cast` 1–8 人                                   | 是                                                                           |
| `novel_write_draft`  | P3       | `submitDraft`                                                                                                                            | 是                                                                           |
| `novel_review`       | P4       | `submitReview`                                                                                                                           | 是（`total` 必填；issue 维度/段落校验；blocker 不可 waived）                 |
| `novel_revise`       | P5/P6    | `submitRevision`；`content` 与 `patch:{expected_hash,edits}` 二选一；或只传 `summary` 做 summary-only | 是（blocker 不可降级或 waived；issue 只能改 status/evidence；content/patch 需 `proof`） |
| `novel_check`        | P6       | `runCheck`；`acknowledge` 只能列 advisory code，blocker 不可被知悉放行                                                                   | 是（五个语义项必填；`scope` 默认 content+integrity；单 scope 通过仍停留 P6） |
| `novel_archive`      | 归档     | `archiveChapter`                                                                                                                         | 事务（必须带 `state_delta`；旧 review 无 digest 时拒绝）                     |
| `novel_word_count`   | 任意     | `countWords`；纯文本模式不读项目，`project_root` 仅用于项目模式                                                                           | 项目正文否；项目模式显式 `project_root` 会写会话绑定                          |
| `novel_state`        | 任意     | `queryState`；chapters 默认紧凑索引，支持 `include_summary` / `chapter_range`；`history` / `backups` / `briefs` 只读；损坏文档返回 raw     | 否                                                                           |
| `novel_amend`        | 任意     | `amend`；支持 `novel.yaml` 元数据、八个 ledger 与 outline/worldbook，带不变量、归档卡保护与单一目标 repair                              | 是                                                                           |
| `novel_rollback`     | 任意     | `rollback`；只能退回当前阶段或更早                                                                                                       | 是                                                                           |
| `novel_diff`         | 任意     | `diff`；`before`+`after` 文本模式不读项目，`project_root` 仅用于项目模式                                                                  | 项目正文否；项目模式显式 `project_root` 会写会话绑定                          |
| `novel_export`       | 任意     | `export`；md/txt/epub/outline/worldbook/proposal                                                                                         | 导出目录                                                                     |
| `novel_audit`        | 任意     | `auditHistory`；含被拒 attempt，支持 chapter/op/status/since/until/cursor                                                    | 否                                                                           |
| `novel_pipeline`     | 任意     | `advise`                                                                                                                                 | 否                                                                           |
| `novel_blueprint`    | 任意     | `submitBookPlan`；卷列表为 replace，删除卷需 `confirm_remove:true`                                                                        | 是                                                                           |
| `novel_outline`      | 任意     | `submitOutline`；chapters 按 num、volumes 按 title upsert；显式 remove、dry_run、变更回显；归档卡保护                                    | 是                                                                           |
| `novel_outline_import` | 任意   | `importOutline`；Markdown/YAML/JSON，`dry_run` 预览                                                                                      | 可选                                                                         |
| `novel_worldbook`    | 任意     | `submitWorldbook`；按段替换                                                                                                              | 是                                                                           |
| `novel_search`       | 任意     | `search`；正文/摘要/大纲/世界观/台账                                                                                                     | 否                                                                           |
| `novel_doctor`       | 任意     | `doctor`；项目/流水线/状态/journal/正文/大纲覆盖与漂移/阶段产物/锁/备份                                                                  | 否                                                                           |
| `novel_report`       | 任意     | `report`；进度/质量/节奏/角色/伏笔/时间线/关系                                                                                           | 否                                                                           |
| `novel_guide`        | 任意     | `guide`；六态引导（no-project/new/planning/writing/blocked/finished），无项目可用                                                        | 否                                                                           |
| `novel_reopen`       | 已归档章 | `reopenChapter`；从归档备份恢复并重开 P3；`chapter` 与 `reason` 必填                                                                     | 事务                                                                         |
| `novel_restore`      | 活动章/大纲/损坏 pipeline | `restoreBackup`；从带 manifest 的备份恢复正文/计划/评审/校验、outline/outline.yaml，或损坏的 state/pipeline.yaml；已归档章拒绝，先 `novel_reopen` | 事务 |

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

`/novel [status|next|stats|outline|guide|report|doctor|search <词>|export <kind>|projects|current|use <path|title|.>|unbind|scan [--register]|resume|admin]`、`/novel-next`、`/novel-stats`、`/novel-export`、`/novel-admin`。

`scan`/`resume` 只是 `/novel` 子命令，不进入工具 schema；工具仍 28 个、服务操作仍 32 个。

## core 模式

`toolsMode=core` 只注册 10 个高频工具：`init/status/guide/brief/outline/write_draft/review/revise/check/archive`。其余 18 个通过 `/novel admin <op> <json>` 执行（例如 `/novel admin novel_state {"kind":"pipeline"}`），不是“仍可按名字调用”。多项目与设定包导入也只走命令入口：`novel_registry_list`、`novel_registry_register`、`novel_registry_activate`、`novel_registry_forget`、`novel_import`。

## 0.2.0 契约补充

- `novel_state` 新增 `kind: outline | worldbook`；损坏时返回 `{error,message,path,raw}`。
- `novel_blueprint` / `novel_outline` / `novel_worldbook` 是书级写操作，不受阶段门控，但会推进 revision 与 journal；严格大纲首次提交默认开启，已有蓝图内容时尊重显式 `strict:false`。`novel_blueprint` 的卷列表仍是 replace，删卷必须 `confirm_remove:true`；`novel_outline` 的 chapters/volumes 是 upsert，省略不删，删除走 `remove`/`remove_volumes`。
- `novel_amend` 允许修复 `outline/outline.yaml` 与 `outline/worldbook.yaml`；已归档卡的 title/scene/target_words/cast/word_count/score/archived_at 仍不可改。
- `novel_doctor` 新增大纲覆盖率与当前阶段产物检查；`novel_report` 的 outline/worldbook `present` 以内容为准。
- `novel_outline_import` 的 `dry_run=true` 不写盘；解析失败带 Markdown 行号。
- `novel_export` 新增 `outline | worldbook | proposal`；`chapter` 只对 `md/txt/epub` 有效。
- `novel_reopen` 必须传 `chapter` 与 `reason`；只允许紧邻的已归档章，活动章未开始；损坏的 outline 会拒绝重开，避免覆盖规划。

## 0.2.3 契约补充

- `novel_status` 增加 `manuscript_hash`（活动正文 SHA-256，无正文为 `null`）；所有 brief 的 `fields.manuscript_hash` 同源。`novel_revise` 的 patch 可直接用这个值。
- `ready_to_archive` 新增 `submitRevision` 回 P4：归档失败后可先 `novel_brief P5`，再直接修订；不需要 `novel_rollback`，不写额外的废弃稿快照。
- 修订尝试改写 issue 的 `dimension/location/problem/fix/severity`、或把 blocker 降级/waived 时返回 `ENGINE_ISSUE_IMMUTABLE`；错误消息回显字段与收到的值。格式错误仍是 `ENGINE_SCHEMA_INVALID`。
- 有 `key` 的写操作会在 journal 记录 `retry_key`/`retry_context`；与上次被拒尝试内容、brief、stage、revision 完全相同时返回 `ENGINE_RETRY_UNCHANGED`，换 brief 或改内容后才放行。无 key 的维护操作不做此限制。
- P8 brief 的 `fields.delta_rules.minimal_schema` 给出五个 section 的最小形状与示例；delta 错误会带 `expected` 形态。
- `novel_report.effort` 对缺少 `rounds/archived_at` 的旧章按 committed journal 回填；`quality` 每章只取最终评审，`samples`=章数，`attempts`=committed 评审轮次（含历史），`trend_basis` 说明趋势为空/可算的原因。
- `pipeline.briefs` 只含当前章收据；`novel_state {kind:"briefs"}` 仍返回全书 append-only 收据。重复领取同章同阶段返回 `replayed:true`，不写 journal。
- advisory 按 code 每章一条并合并证据；`RESOURCE_MISMATCH` 只在正文同窗口明确写反向符号时报，缺资源名/无符号不再报。同段“数量 × 单价 = 总额”或“人数，每人金额，共总额”不一致时，`NUMERIC_CONTRADICTION` 报 advisory；跨段/多单位换算仍不在本轮。`novel_check` 的 check 文档仍只把 blocker 放入 `machine.violations`。
- 中文句密度上限从 8 调到 10/100 字，避免把普通短句叙事当异常；仍是 advisory，不阻塞归档。
- `novel_doctor` 新增 `legacy-data` warning（旧 check、缺 rounds、extra 角色、pre-0.2.3 无 anchor 伏笔、stale `pipeline.briefs`）和 strict 模式 `worldbook.facts` 为空提醒；只读，不改历史。`state/briefs.yaml` 的跨章历史收据是正常 append-only 审计，不报 stale。
- `/novel projects --prune [--yes]` 默认只列 `missing/not-project/unreadable` 登记行；`--yes` 才调用 `forgetProject`，只删登记、不删项目目录，active 被清理时同时清空。
- 面板 payload v6：`summary.advisories[]`、`summary.legacy[]`；`quality.trend` 可为 `null`，并带 `trend_basis/samples/attempts`。旧 v5 标签页显示“需要刷新”。

## 0.2.2 契约补充

- 所有工具的 `project_root` 语义：**项目模式下显式传入成功后绑定当前 DSH 会话并持久化**；省略时按「会话绑定 → cwd 唯一项目 → 唯一注册项目/配置 `projectRoot`」解析。多项目无法唯一确定时返回 `ENGINE_PROJECT_AMBIGUOUS`，不会用 `active` 猜。例外：`novel_word_count` 的纯文本模式与 `novel_diff` 的 `before`+`after` 文本模式不读项目、不绑定会话，schema 已单独标注。
- 读取路径的绑定/登记写入是 best-effort：显式 `project_root` 的读取不因元数据文件损坏或不可写而失败；省略 root 的解析仍对损坏绑定 fail-closed。写事务提交后才更新元数据，失败只回 `SESSION_BINDING_FAILED` warning。
- `novel_init` 是例外：省略 `project_root` 时只落配置 `projectRoot`，不读会话绑定/工作区/active；创建成功后才绑定当前会话。
- `novel_status` 文本新增「项目根 … · 选择来源 …」一行；JSON 的 `selection` 为 `{source, root}`。
- 新增错误码：`ENGINE_PROJECT_AMBIGUOUS`（列候选，要求显式选择）、`ENGINE_PROJECT_MISSING`（会话绑定目录不存在，保留绑定）、`ENGINE_PROJECT_IDENTITY_MISMATCH`（原路径换成另一本书，禁止写入）。
- `/novel scan` 只扫 `cwd`、`cwd/novel`、直接子目录；最多 50 个候选，不递归、不跟随符号链接；普通模式只读，`--register` 只登记 `ok`，不改 active/绑定。
- `/novel use` 成功绑定后 best-effort 登记项目，便于随后在 `/novel projects` 与面板看到；不改 active。损坏项目（`novel.yaml` 不可读）不绑定、不登记，先用显式 `project_root` 修复。
- `/novel resume` 只读，要求 Agent 会话；文本由 `formatResumePrompt` 生成，与面板复制按钮同源，包含书名、绝对 root、章节、阶段、下一步和首调用显式 `project_root` 的约束。
- 面板 payload v4：`projects[]`、`selection`、`summary.root`、`missing`、`resume`；选择器只改 GET `?root=` 与 `localStorage`，不写会话绑定。

## 0.2.1 契约补充

- 通过参数形状校验并进入项目锁后，被 gate/delta/state 拒绝的写操作会追加 `status:"aborted"`、`attempt:true` 的 journal 行，带 `code`、`reason`、`hint` 与 `blocking`；内容文件不动，`novel_audit` 可按章、操作、状态和时间过滤，用 `seq` 游标翻页。锁前的纯参数形状错误不会写 journal（此时还没有可证明的项目上下文）。
- `novel_state {kind:"history"}` 列出 `history/` 下的评审/校验/正文/废弃稿/计划版本，返回 `entries` 全量（不静默截断）与 `total`；带 `chapter` 与正整数 `revision` 时返回该章该版本文本，未带 chapter 时默认活动章。`kind:"backups"` 返回 manifest（op/chapter/revision/files/reason）；没有 manifest 的旧备份只可列出。
- `novel_revise` 的 `patch` 模式必须带 `expected_hash`；`old_text` 默认必须唯一，`occurrence` 才允许多处；hash 不匹配时零写入。
- `novel_check` 把 blocker 放 `machine.violations`，advisory 放 `machine.advisories`；`acknowledge` 只接受本次 advisory code，未知 code 或 blocker 返回 `ENGINE_SCHEMA_INVALID`。
- `novel_restore` 可恢复活动章、`paths: ["outline/outline.yaml"]` 的整份大纲，或 `paths: ["state/pipeline.yaml"]` 的损坏 pipeline（只在该文件不可读时）；已归档章返回 `ENGINE_STAGE_ORDER`，必须先 `novel_reopen`。`paths` 省略时恢复 manifest 记录的本章正文/计划/世界观计划/评审/校验 pre-image；显式 paths 也必须在 manifest 内。每次恢复本身是事务并再建备份，不做 replay。P2/P4/P6 在已有旧文件时会建备份，因此第二次提交起计划/评审/校验可恢复；outline 事务的 pre-image 同样可恢复。
- P2 计划文件不再写 `summary`；活动摘要/标题/场景/叙述者位于 `pipeline.draft`，归档时写入 `ChapterRecord`，`ChapterRecord.rounds/final_check/archived_at`（含 `rollbacks`）供 `novel_report.effort` 使用。归档前正文 hash 必须仍等于 `draft.content_hash`，否则返回 `ENGINE_TXN_ABORTED`；`status` 用 `DRAFT_STALE` 指回 P3。
- `card_coverage` 是“已归档章中有 archived 章卡”的逐章比例；`planned_coverage`/`archived_coverage` 才以目标章数为分母。worldbook 的 `facts` 同时进入计数、brief 上下文与 P6 数字事实检查。
- `NUMERIC_CONTRADICTION` 固定为 advisory（中文主语不明确，不能可靠区分车/船等不同对象），`NUMERIC_FACT_MISMATCH` 只匹配“别名 + 数字 + 声明单位”的相邻写法，避免把旁边的数量词当成事实。
