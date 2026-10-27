---
name: novel-write-engine
description: 引擎版小说创作流程——状态、门控、字数与写盘入口全部由插件裁决。用于任何「写小说 / 写第 N 章 / 续写 / 改稿 / 归档」任务。
---

# 网文工坊（引擎版）

你不是在「帮用户写小说」，你是在**驱动一台有状态的引擎**。状态由引擎维护，你只负责内容与调用。

## 六条铁律

1. **先看状态，再动笔。** 任何创作动作前先 `novel_status`；每章开工先 `novel_brief <阶段>`。
2. **正文只有两个写入口。** `novel_write_draft`（初稿）与 `novel_revise`（修订）。`novel_amend` 只改状态文档，不写正文；没有第四条路。
3. **字数与门控以引擎返回为准。** 不要自己估算字数，不要复述旧数字。
4. **评审每一分都要定位。** 指不到「第 N 段」的扣分不要写；证据要逐字引用。
5. **不编设定。** 人物、地点、伏笔、资源状态拿不准就 `novel_state` 查。
6. **归档是一次事务，且必须核销。** `novel_archive` 必须带 `state_delta`：本章每个角色/伏笔/事件/新设定/关系逐条声明 `created|updated|no_change`；不要手工拼章节索引或交接文件。

## 流程路由

| 当前阶段         | 任务书           | 下一动作             |
| ---------------- | ---------------- | -------------------- |
| idle             | `novel_brief P1` | `novel_plan_world`   |
| P2               | `novel_brief P2` | `novel_plan_chapter` |
| P3               | `novel_brief P3` | `novel_write_draft`  |
| P4               | `novel_brief P4` | `novel_review`       |
| P5               | `novel_brief P5` | `novel_revise`       |
| P6               | `novel_brief P6` | `novel_check`        |
| ready_to_archive | `novel_brief P8` | `novel_archive`      |
| done             | —                | 下一章从 P1 开始     |

拿不准就走 `novel_pipeline`，它直接告诉你调什么、传什么。任务书缺失或 digest 过期时，它第一步会返回 `novel_brief`；照它给的 `args` 领取后再继续，不要直接调用被门控的写工具。

## 工具速查

| 工具 | 用途 |
| --- | --- |
| `novel_init` | 建项目 |
| `novel_status` | 当前章/阶段/阻塞/下一步 |
| `novel_brief` | 取阶段任务书与上下文 |
| `novel_plan_world` | P1 世界观计划 |
| `novel_plan_chapter` | P2 章节计划 |
| `novel_write_draft` | P3 初稿 |
| `novel_review` | P4 十五维评分 |
| `novel_revise` | P5 修订 |
| `novel_check` | P6 一致性校验 |
| `novel_archive` | 归档事务 |
| `novel_word_count` | 字数口径 |
| `novel_state` | 只读台账/计划/评审 |
| `novel_amend` | 受控改状态文档 |
| `novel_rollback` | 回退阶段 |
| `novel_diff` | 与备份/文本对比 |
| `novel_export` | md/txt/epub |
| `novel_audit` | 事务审计 |
| `novel_pipeline` | 推荐下一步与参数 |

## 工具怎么用

- 参数是 JSON 对象；`summary`、`dimensions`、`issues`、`proof` 是结构化对象，按任务书字段填。
- `novel_check` 必须带四个语义项（`L2-SCENE-ANCHOR` / `L2-CHARACTER-STATE` / `L2-CAUSALITY` / `L2-VOICE`），每项都要有正文逐字引用；缺一项即校验不过。
- 失败分三类：参数错（改参数）、门控没过（改正文）、系统故障（查目录/稍后重试）。错误消息里的 code 说明属于哪类。
- 门控失败会一次列出**全部**阻塞项；一次改完再交，不要逐条试。

## 交付

- 每章归档后，用户在面板「网文工坊」看到章节表与阻塞区。
- 导出：`novel_export md|txt|epub`。
- 不要在对话里重复整章正文；工具结果已经可见。
