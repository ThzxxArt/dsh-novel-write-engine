# 工具面

18 个工具全部是 `EngineService` 的薄适配器：参数窄化 → 一次操作 → 规范值 + render。

| 工具 | 阶段 | 操作 | 写盘 |
|---|---|---|---|
| `novel_init` | — | `initProject` | 是 |
| `novel_status` | 任意 | `getStatus` | 否 |
| `novel_brief` | P1~P6/P8 | `getBrief` | 仅 `briefs` |
| `novel_plan_world` | P1 | `submitWorldPlan` | 是 |
| `novel_plan_chapter` | P2 | `submitChapterPlan` | 是 |
| `novel_write_draft` | P3 | `submitDraft` | 是 |
| `novel_review` | P4 | `submitReview` | 是（`total` 必填） |
| `novel_revise` | P5/P6 | `submitRevision` | 是 |
| `novel_check` | P6 | `runCheck` | 是 |
| `novel_archive` | 归档 | `archiveChapter` | 事务（必须带 `state_delta`） |
| `novel_word_count` | 任意 | `countWords` | 否 |
| `novel_state` | 任意 | `queryState` | 否 |
| `novel_amend` | 任意 | `amend` | 是 |
| `novel_rollback` | 任意 | `rollback` | 是 |
| `novel_diff` | 任意 | `diff` | 否 |
| `novel_export` | 任意 | `export` | 导出目录 |
| `novel_audit` | 任意 | `auditHistory` | 否 |
| `novel_pipeline` | 任意 | `advise` | 否 |

## 错误三分类

- `EngineInputError`：改参数（阶段不对、项目不存在、路径越界）。
- `EngineBlockedError`：改正文（门控失败，`details` 列出全部阻塞）。
- `EngineFaultError`：查环境（IO、schema 过新、锁超时、事务中止）。

工具把错误格式化为 `[CODE] message — hint`。

## 命令

`/novel [status|next|stats|export <kind>|admin]`、`/novel-next`、`/novel-stats`、`/novel-export`、`/novel-admin`。

## core 模式

`toolsMode=core` 只注册 8 个高频工具；其余 10 个通过 `/novel admin <op> <json>` 执行（例如 `/novel admin novel_state {"kind":"pipeline"}`），不是“仍可按名字调用”。
