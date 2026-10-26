# Changelog

## 0.1.0

- 新增 `EngineService` 单一写入口：22 个操作、revision、幂等重放、`KeyedMutex` + 文件锁。
- 新增 18 个 `novel_*` 工具、5 条 `/novel*` 命令与只读 HTTP 面板数据端点。
- 新增侧边栏「网文工坊」面板：项目头、九阶段进度、章节表、阻塞区。
- 新增内置 Agent 预设「网文工坊」：工具全开，无文件写权限。
- 新增规则包编译与五步检测流水线（格式、标点、语义、跨章、词表）。
- 新增 12 条门控与十五维评分算术校验。
- 新增事务化归档：staging → verify → backup → commit → journal → readback。
- 新增 Markdown / 纯文本 / EPUB 3 导出与 SVG 封面。
- 新增多项目注册表与设定包导入（预览 diff 后应用）。
- 新增入口技能 `novel-writing` 与 6 份阶段任务书。
- 新增严格 TDD 测试集：覆盖率四项 ≥85%，分层门槛与 12 条证伪行为。
