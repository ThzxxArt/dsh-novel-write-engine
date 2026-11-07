---
name: novel-write-engine
description: 网文工坊 · 创作室 0.3.0。确定性内核 + 多智能体创作室：状态、门控、artifacts、人工门与写盘入口全部由插件裁决。用于任何「写小说 / 写第 N 章 / 续写 / 改稿 / 评审 / 归档 / 发布」任务。
---

# 网文工坊 · 创作室（0.3.0）

你不是在「帮用户写小说」，你是在**驱动一个确定性创作室**。Run、Task、lease、门控、artifact 版本和人工门由内核维护；你只负责内容、调用工具和报告结果。

## 六条铁律

1. **先看状态，再动笔。** 任何创作动作前先 `novel_status`；启动 Run 用 `novel_run`，不要自己猜下一步。
2. **正文只有两个写入口：角色私有 `draft_submit` 与人工 host 编辑。** 主会话不再直接持有 `novel_write_draft` / `novel_revise` / `novel_archive`；这些是角色私有工具。
3. **字数、格式、评分与门控以内核返回为准。** 不要自己估算字数，不要复述旧数字。
4. **评审每一分都要定位。** 指不到「第 N 段」的扣分不要写；证据要逐字引用正文 8 字以上。
5. **不编设定。** 人物、地点、伏笔、资源状态拿不准就 `novel_state` 或 `novel_search` 查。
6. **四道人工门全部强制。** Bible / Outline / Chapter / Publish；没有 auto，没有跳过。批准只能走 host 通道。

## 角色与权限

12 个角色由 Agent Preset 注册，11 个参与章节流水线，Radar 只参与 `market` run：

| 角色 | 写权限 |
|---|---|
| Showrunner | Decision / BiblePlan / OutlinePlan |
| Architect | BiblePlan / OutlinePlan |
| Worldsmith | WorldbookPatch |
| Planner | ChapterPlan |
| Drafter | Draft |
| Critic-Story / Character / Prose | ReviewReport |
| Continuity | ContinuityReport |
| Polisher | PolishPatch |
| Archivist | StateDelta |
| Radar | MarketBrief |

写手不能写台账，审稿人不能改正文，档案员不能改正文。权限由 `contracts/roles.ts` + kernel 校验，不靠 prompt。

## 工具速查（10 个模型可见）

| 工具 | 用途 |
| --- | --- |
| `novel_init` | 创建 format v2 项目（genre{major,sub,tags}/audience/platform） |
| `novel_status` | 当前 Run、章节、评分、blocking、下一步、成本 |
| `novel_bible` | 读 Bible / 提议 BiblePlan artifact |
| `novel_outline` | 读书/卷/章卡 / 提议 OutlinePlan artifact |
| `novel_run` | 启动/暂停/恢复/取消/推进 Run |
| `novel_artifact` | 列表/读取/diff 不可变 artifact |
| `novel_state` | 查询 canon / ledger |
| `novel_search` | FTS5 记忆检索 |
| `novel_export` | Markdown/TXT/EPUB/Outline/Worldbook/Proposal |
| `novel_agent` | 角色列表 / assignment |

Host-only：`novel_approve`、`novel_admin`。它们不注册给任何 Agent。

## 流程

```text
novel_init
  -> novel_run action=start kind=book       # Bible -> Outline 人工门
  -> novel_run action=start kind=chapter    # plan -> draft -> 三审 -> continuity
  -> 人工门 Inbox 批准
  -> archive
  -> novel_run action=start kind=market     # 可选，Radar 独立 run
```

章节流水线：

```text
plan
  └─ draft
       ├─ review.story
       ├─ review.character
       ├─ review.prose
       └─ continuity.precheck
            └─ review.merge
                 ├─ pass -> continuity.final -> polish -> approve -> archive
                 └─ fail -> revise -> reviews（最多 3 轮）
```

## 门控

- `PG-01..PG-13`：brief/阶段/字数/格式/摘要/场景/评分/问题闭环/引文/连续性/轮次/原子归档/章卡对齐。
- `EG-01..EG-08`：声音指纹/场景契约/钩子/节奏/POV/canon/AI 味/patch 安全。
- `R-W-07（去 AI 味，4 分）` 是唯一 AI_TONE 映射；reviewer 扣分必须引用 `AI_TONE_*` 规则码。

## 类型体系

`genre` 必须是 `{ major, sub, tags[] }`，并单独提供 `audience` 与 `platform`：

```text
幻想 / 仙侠
东方修真 · 升级流 · 废柴逆袭 · 等级 · 热血 · 快节奏
```

12 大类 / 100 小类 / 137 标签；每本 3–12 个标签，每 facet ≤3，冲突/依赖由内核校验。

## 旧项目

0.3.0 不双读 0.2.x。旧项目只走：

```bash
dsh novel import ./old-project --to ./new-project
```

导入后检查 `IMPORT_REPORT.md`，人工确认 genre/标签映射；不会自动续写。

## 输出与错误

- 参数是严格 JSON 对象：英文双引号、无注释/尾逗号/围栏。
- 工具错误带稳定 code、message、hint、details；先读 details，再决定修复，不要原样重发大对象。
- 任何写操作失败都会留下 event/diagnostic；不要静默吞错。
