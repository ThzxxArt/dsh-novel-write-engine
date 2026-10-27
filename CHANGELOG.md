# Changelog

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
