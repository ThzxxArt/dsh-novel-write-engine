# 状态机

## 两种枚举，不能混用

| 层 | 取值 |
|---|---|
| 任务书阶段 `novel_brief.stage` | `P1` `P2` `P3` `P4` `P5` `P6` `P8` |
| 管线状态 `pipeline.stage` | `idle` `P2` `P3` `P4` `P5` `P6` `ready_to_archive` `done` |

P7/P8/P9 在 `archiveChapter` 一次事务内完成，不单独成态。`done` 表示**当前章已归档**；下一章从 `done` 回到 P1，只有项目配置的 `targets.total_chapters` 已全部归档时面板才显示全书完成。

## 迁移表

| 从 | 操作 | 到 | 门控 |
|---|---|---|---|
| `idle` / `done` | `submitWorldPlan` | `P2` | 01,02 |
| `P2` | `submitChapterPlan` | `P3` | 01,02 |
| `P3` | `submitDraft` | `P4` | 01,02,04,03,05,06 |
| `P4` | `submitReview` | `P5`（有 blocker）/ `P6` | 01,02,09,07,11 |
| `P5` | `submitRevision` | `P4` | 01,02,04,03,05,09,08 |
| `P6` | `submitRevision` | `P4` | 01,02,04,03,05,08,09 |
| `P6` | `runCheck` | `ready_to_archive` | 01,02,04,05,08,09,10,11 |
| `ready_to_archive` | `archiveChapter` | `done` | 01,02,04,03,05,06,07,08,10,12 |

唯一的数据依赖迁移是 P4 评审按 blocker 数量决定去向。

## 门控顺序

`PG-01 → PG-02 → PG-04 → PG-03 → PG-05 → PG-06 → PG-09 → PG-07 → PG-08 → PG-10 → PG-11 → PG-12`

格式先于字数：弯引号与破折号既计入字数又判违规，先判字数会奖励写错标点。

## 轮次与回退

- 评审/修订/校验各上限 3 轮，由引擎自增，模型不能传轮次。
- 超限 → `PG-11` 阻塞，提示 `novel_rollback`。
- 回退保留正文，清空任务书签收与轮次。
