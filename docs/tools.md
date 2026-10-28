# 工具面

18 个工具全部是 `EngineService` 的薄适配器：参数窄化 → 一次操作 → 规范值 + render。

| 工具                 | 阶段     | 操作                                                                                                                                     | 写盘                                                                         |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `novel_init`         | —        | `initProject`                                                                                                                            | 是                                                                           |
| `novel_status`       | 任意     | `getStatus`；`chapter` 仅用于字数查询，`active_chapter` 才是当前章；`state_errors` 暴露 plan/review/check 与八个 ledger 的损坏           | 否                                                                           |
| `novel_brief`        | P1~P6/P8 | `getBrief`；只签当前活跃章，返回 `fields`、`context`；`context.world_plan`、`context.context_meta` 与 `*_error` 在 `context`/`fields` 内 | 仅 `briefs`                                                                  |
| `novel_plan_world`   | P1       | `submitWorldPlan`；数组/对象形状在服务边界窄化                                                                                           | 是                                                                           |
| `novel_plan_chapter` | P2       | `submitChapterPlan`；标题长度读 rulepack、5–8 个节拍、narrator/opening/ending 非空；可选 `cast` 1–8 人                                   | 是                                                                           |
| `novel_write_draft`  | P3       | `submitDraft`                                                                                                                            | 是                                                                           |
| `novel_review`       | P4       | `submitReview`                                                                                                                           | 是（`total` 必填；issue 维度/段落校验；blocker 不可 waived）                 |
| `novel_revise`       | P5/P6    | `submitRevision`                                                                                                                         | 是（blocker 不可降级或 waived；issue 只能改 status/evidence）                |
| `novel_check`        | P6       | `runCheck`                                                                                                                               | 是（四个语义项必填；`scope` 默认 content+integrity；单 scope 通过仍停留 P6） |
| `novel_archive`      | 归档     | `archiveChapter`                                                                                                                         | 事务（必须带 `state_delta`；旧 review 无 digest 时拒绝）                     |
| `novel_word_count`   | 任意     | `countWords`                                                                                                                             | 否                                                                           |
| `novel_state`        | 任意     | `queryState`；chapters 默认紧凑索引，支持 `include_summary` / `chapter_range`；损坏 ledger 返回 raw                                      | 否                                                                           |
| `novel_amend`        | 任意     | `amend`；支持 `novel.yaml` 元数据与八个 ledger，带不变量与单一目标 repair                                                                | 是                                                                           |
| `novel_rollback`     | 任意     | `rollback`；只能退回当前阶段或更早                                                                                                       | 是                                                                           |
| `novel_diff`         | 任意     | `diff`                                                                                                                                   | 否                                                                           |
| `novel_export`       | 任意     | `export`                                                                                                                                 | 导出目录                                                                     |
| `novel_audit`        | 任意     | `auditHistory`                                                                                                                           | 否                                                                           |
| `novel_pipeline`     | 任意     | `advise`                                                                                                                                 | 否                                                                           |

## 错误三分类

- `EngineInputError`：改参数（阶段不对、项目不存在、路径越界）。
- `EngineBlockedError`：改正文（门控失败，`details` 列出全部阻塞）。
- `EngineFaultError`：查环境（IO、schema 过新、锁超时、事务中止）。

工具把错误格式化为 `[CODE] message — hint`。

## 0.1.3 契约补充

- 八个 ledger 损坏时 `state_errors` 的 code 为 `CHAPTERS_UNREADABLE`、`CHARACTERS_UNREADABLE`、`WORLD_UNREADABLE`、`LOCKS_UNREADABLE`、`TIMELINE_UNREADABLE`、`FORESHADOWS_UNREADABLE`、`RELATIONSHIPS_UNREADABLE`、`HANDOFF_UNREADABLE`，plan/review/check/worldPlan 有对应 `*_UNREADABLE`，`novel.yaml` 为 `PROJECT_UNREADABLE`。status/panel 仍可读，损坏 ledger/project 的 `next.tool = novel_amend`。
- `novel_state` 对损坏 ledger/project/review/check 返回 `{error,message,path,raw}`；`novel_amend` 的 `content` 对损坏目标必须是完整新文档，对可读 `novel.yaml` 是可变量字段 patch（目标文档与 `state/pipeline.yaml` 同一事务写入），`reason` 必填。amend 支持 `novel.yaml`，可修 title/author/description/targets.total_chapters；损坏时接受完整项目文档。
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

`/novel [status|next|stats|export <kind>|admin]`、`/novel-next`、`/novel-stats`、`/novel-export`、`/novel-admin`。

## core 模式

`toolsMode=core` 只注册 8 个高频工具：`init/status/brief/write_draft/review/revise/check/archive`。其余 10 个（`plan_world`、`plan_chapter`、`word_count`、`state`、`amend`、`rollback`、`diff`、`export`、`audit`、`pipeline`）通过 `/novel admin <op> <json>` 执行（例如 `/novel admin novel_state {"kind":"pipeline"}`），不是“仍可按名字调用”。多项目与设定包导入也只走命令入口：`novel_registry_list`、`novel_registry_register`、`novel_registry_activate`、`novel_registry_forget`、`novel_import`。
