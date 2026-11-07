# 创作室运行手册

## 人工门

Bible、Outline、Chapter、Publish 四道门都必须由人决定：

- `approve`：通过并继续同一 Run。
- `reject`：失败并保留失败原因。
- `edit` / `regenerate`：按人工意见重新生成；不会静默跳过。

工作台与 `/novel approve|reject` 是 host 通道；模型只能看到 `novel_approve` 的 host-only 说明，不能自行批准。

## Run Board

- 一个项目同时只允许一个 writer run（`chapter` / `rewrite`）。
- Review / Market / Book run 可以独立启动，但不能绕过 writer 锁。
- 过期 lease 会在下一次调度时自动回收；运行中每 30s 心跳续租。
- 取消会先停止调度，再标记所有未完成任务为 cancelled；不会继续写正文。

## 成本

- 每个 Run 的模型调用写入 `model_usage`。
- 超预算时 Run 进入 paused，并在 Board 上显示 `budget.exceeded`。
- 角色路由与预算在「设置」中修改；保存生成新的 project 配置版本。

## 恢复

- `backup.create` 生成 SQLite 备份；恢复前会再备份当前 DB。
- 有 active run 时禁止恢复。
- 正文、bible、outline、canon 始终以文件为准；DB 丢失后可 `repair` 重建索引。
