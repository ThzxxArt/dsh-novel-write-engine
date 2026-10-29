# 状态机

## 两种枚举，不能混用

| 层                             | 取值                                                      |
| ------------------------------ | --------------------------------------------------------- |
| 任务书阶段 `novel_brief.stage` | `P1` `P2` `P3` `P4` `P5` `P6` `P8`                        |
| 管线状态 `pipeline.stage`      | `idle` `P2` `P3` `P4` `P5` `P6` `ready_to_archive` `done` |

P7/P8/P9 在 `archiveChapter` 一次事务内完成，不单独成态。`done` 表示**当前章已归档**；下一章从 `done` 回到 P1，只有项目配置的 `targets.total_chapters` 已全部归档时面板才显示全书完成。

## 迁移表

| 从                 | 操作                | 到                                                      | 门控                          |
| ------------------ | ------------------- | ------------------------------------------------------- | ----------------------------- |
| `idle` / `done`    | `submitWorldPlan`   | `P2`                                                    | 01,02                         |
| `P2`               | `submitChapterPlan` | `P3`                                                    | 01,02,13                      |
| `P3`               | `submitDraft`       | `P4`                                                    | 01,02,04,03,05,06,13          |
| `P4`               | `submitReview`      | `P5`（有 blocker）/ `P6`                                | 01,02,09,07,11                |
| `P5`               | `submitRevision`    | `P4`                                                    | 01,02,04,03,05,09,08,11       |
| `P6`               | `submitRevision`    | `P4`                                                    | 01,02,04,03,05,08,09,11       |
| `P6`               | `runCheck`          | `ready_to_archive`（完整 scope）/ 停留 `P6`（单 scope） | 01,02,04,03,05,06,07,08,09,10,11 |
| `ready_to_archive` | `archiveChapter`    | `done`                                                  | 01,02,04,03,05,06,07,08,09,10,12,13 |

`runCheck` 的 PG-03 字数下限与 PG-07 评审分数下限不随 `scope` 关闭：check 是归档前置，单 scope 只跳过硬性内容/连续性机检（PG-04/PG-10），不能用一个“integrity only”绕过字数或评分。

唯一的数据依赖迁移是 P4 评审按 blocker 数量决定去向。

`novel_status` 的 `chapter` 只用于字数查询；`active_chapter` 是管线当前章。任何阶段只要该阶段任务书缺失或 digest 过期，`next.tool` 都先指 `novel_brief`；任务书当前后才指向实际写操作。P5/P6 有阻塞时指向 `novel_revise`；`ready_to_archive` 在 P8 任务书当前后指向 `novel_archive`；`done` 未完成时先取 P1。绝不指向只读的 `novel_status`，也不使用过期任务书硬推下一步。

## 门控顺序

`PG-01 → PG-02 → PG-04 → PG-03 → PG-05 → PG-06 → PG-13 → PG-09 → PG-07 → PG-08 → PG-10 → PG-11 → PG-12`

格式先于字数：弯引号与破折号既计入字数又判违规，先判字数会奖励写错标点。

## 轮次与回退

- 评审/修订/校验各上限 3 轮，由引擎自增，模型不能传轮次。
- 超限 → `PG-11` 阻塞，提示 `novel_rollback`。
- 回退只允许退到当前阶段或更早阶段（`idle → P2 → P3 → P4 → P5 → P6 → ready_to_archive → done`；`to_stage: P1` 落到 `idle`）；`P3 → P6` 这类前进跳过返回 `ENGINE_STAGE_ORDER`。
- 回退保留正文，清空任务书签收与轮次。

## 0.1.2 状态恢复（历史，仍适用）

- `load` 对 plan/review/check 采用可恢复读取：文件缺失、YAML 或窄化失败时，快照仍可建立，错误进入 `planError/reviewError/checkError`；但缺失只在当前周期真正消费该文档的阶段报错（例如 P3 的 plan、P5/P6 的 review、ready_to_archive 的 check）。
- `novel_status` / `novel_pipeline` 返回 `state_errors`，并把 `STATE_UNREADABLE` 加入 blocking；当前阶段晚于重建点时 `next` 指向 `novel_rollback`，已经处在 P2/P4/P6 时直接指向 brief 与阶段修复工具。
- 恢复目标：plan → P2；review → P4；check → P6。目标不会晚于当前阶段；多个错误按 plan 优先。
- 需要该文档的写操作会被提前拒绝：plan 阻断 draft/review/revision/check/archive；review 阻断 revision/check/archive；check 阻断 archive。`novel_plan_chapter`、`novel_review`、`novel_check` 可覆盖对应文件。
- review 存在但 `pipeline.review_digest` 缺失或被改动时归档 fail-closed；status 返回 `REVIEW_DIGEST_MISSING`/`REVIEW_DIGEST_MISMATCH`，`next` 回退 P4，重新 `novel_review` 后再归档；不要手改 `state/pipeline.yaml`。
- plan/review/check 的 `schema_version` 高于引擎支持版本时返回 `ENGINE_SCHEMA_TOO_NEW`，不会被当作可覆盖的损坏状态。

## 0.1.3 台账恢复与长书状态

- chapters/characters/world/locks/timeline/foreshadows/relationships/handoff 采用可恢复读取：错误进 `state_errors`，`novel_status`/panel 仍可读；`pipeline` 仍 fatal。`novel.yaml` 损坏进入 `PROJECT_UNREADABLE`，同样可读可修。
- 损坏台账的 `novel_state` 返回 `{error,message,path,raw}`；`next` 指向 `novel_amend`，修复时当前所有不可读状态文档可绕过 journal 的既有 hash，其他可读文件的外部改动仍 fail-closed。
- amend 不变量：chapters 只含已归档章、不减少、编号连续、已归档 `content_hash`/`archive_digest`/`assigned_ids` 不改写；`next_seq` 不降低且不撞已有 ID；chapters 不可读时不接受无法证明 floor 的 timeline/foreshadows/relationships 改写；locks/relationships 不引用不存在的实体；chapters 记录必须与 `chapters/` 文件 hash 一致。
- `novel.yaml` 可改 title/author/description/targets.total_chapters；genre/platform/created_at/words_per_chapter/dialogue_ratio 不可变；total_chapters 不得低于已归档章数。`novel.yaml` 本身损坏时，amend 接受完整项目文档并优先从备份恢复不可变基线。
- `novel_plan_chapter` 的 `cast` 是可选 1–8 人，名字必须来自 P1 世界计划或角色台账；旧 plan 仍可读。
- `archiveChapter` 继承 handoff 的 volume/volume_name；`act`/`act_progress` 默认按幕内位置派生，handoff 可覆盖；`open_hooks` 最久未动优先。
- 只跑 `content` 或 `integrity` 的 check 通过后停留 P6，返回 `CHECK_SCOPE_PARTIAL`，必须再跑完整 scope 才能归档。

## 0.2.0 书级状态

- `outline/outline.yaml` 与 `outline/worldbook.yaml` 是规划层，不属于 `pipeline.stage`；它们损坏时进入 `state_errors`（`OUTLINE_UNREADABLE` / `WORLDBOOK_UNREADABLE`），`novel_amend` 可修。读取走 `narrow`：未知顶层键、未知 book 键、错误 `schema_version` 都按损坏处理。
- 卷区间必须不重叠且相邻卷首尾相接；章卡 `num` 唯一，标题为 4–8 字正文，`scene_type` 四选一，planned 卡的 `goal/conflict/hook` 非空，`target_words` 为正整数区间。
- `novel_amend` 修 outline 时仍保护已归档卡的 title/scene/target_words/cast/word_count/score/archived_at；修 worldbook 时仍校验容量非负、名称/术语段内唯一、必填文本非空。
- 严格大纲（`book.strict=true`）下，P2/P3 必须存在当前章章卡，且标题/场景类型/目标字数区间/cast 与章卡一致（PG-13）。非严格模式只校验已存在的章卡。
- 归档事务回写章卡 `archived/archived_at/word_count/score`；严格模式缺卡由 PG-13 在 P2/P3 拦截，非严格模式归档时自动补卡。
- `novel_reopen` 只允许紧邻的已归档章，且活动章尚未开始，`reason` 必填；它从该章归档事务的备份恢复索引/台账/handoff/正文，再把管线设为 `chapter=N / stage=P3`。备份缺失或 outline 损坏即拒绝。
- P6 语义项为 5 条（新增 `L2-POV`），五条证据必须来自不同句子。
