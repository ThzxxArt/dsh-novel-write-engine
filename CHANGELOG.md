# Changelog

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
