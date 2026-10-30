# Changelog

## 0.2.6

### Added

- **语义证据配对**：`novel_check` 失败项新增 `conflicts`（`duplicate`/`same_sentence`/`interval_overlap`，带 `other_id`、重叠原文/字数/比例、段落、句子），submission 错误的 message 汇总最多五条配对；aborted journal 写紧凑 blocking，失败后仍可审计。句边界统一由 `domain/text.ts` 的 `splitSentenceSpans` 提供，支持 `…` 与英文句点。
- **world 实体锚点**：`summary.new_element_anchors` 支持 `name + anchors`；PG-05 与新世界实体归档共用 `entity-anchors.ts`，新 ledger 持久化 `anchors`，旧数据无 anchors 继续按 name 回退。
- **panel v6**：`summary.bookData` 增加身份/蓝图、当前章卡与 metrics、世界/人物/关系/伏笔/时间线、15 维质量、节奏、逐章 effort、outline drift、state_errors/pending/damaged 区分；`quality` 明确区分全书 `average` 与 `last_ten_average`。
- **pipeline 恢复**：`novel_restore { paths: ["state/pipeline.yaml"], txid }` 可从有效备份恢复损坏 pipeline；status/doctor 报 `PIPELINE_UNREADABLE`，普通写操作在恢复前 fail-closed。
- **回归**：summary-only 的 PG-01 旁路只对紧接的 P6 check 生效；outline restore 复用归档卷守卫；PG-05 对 null world row 不再崩溃；PG-09 重复句匹配所有段落。

### Fixed

- `resources:null` 不再被当成空对象；summary-only 不再静默吞掉 `issues`/`proof`；rulepack 递归 unknown-key 覆盖 `reader_intrusion`/`god_view`、`genres.*`、`water_words.scene_thresholds`。
- 面板 `pending` 不再丢失，活跃章详情改读 `pipeline.draft.summary`，`revisionLabel` 用本章 revise 轮次，samples/attempts 不再倒挂，章节行补齐 dialogue ratio 与 archived_at，教程版本升至 0.2.6。
- 测试与 docs 移除真实项目正文，新增覆盖 docs 的隐私扫描；工具数固定 28 并断言全集；R7 识别 `skipIf`；panel v6 从真实 engine 快照集成验证。

### Migration

- check/world/summary 新字段均为 additive；旧文档可读，不自动迁移 anchors。
- 面板 v6 与 v5 不混用；旧标签页显示刷新。
- 工具 28、操作 32、语义项 5、门控 13、导出 6 均不变。

## 0.2.5

### Fixed

- **语义证据跨句/跨段**：`novel_check` 的引文不再要求落在同一句；支持句末收尾引号、跨段证据，逐条返回 `pass|fail|missing|invalid|not_found|too_short|duplicate|overlap|same_sentence`，并在失败时给出 `nearest`/`conflict_with`。同一段被两条证据复用、或同一句不同子串仍按 `overlap`/`same_sentence` 拒绝；真实 r0076 的四段双句引文全部通过，r0075 的编造 POV 引文只报 `not_found`。
- **check submission/content 分流**：形状、缺项、引文不存在等提交错误改为 `ENGINE_CHECK_SUBMISSION_INVALID`，不写 check、不增加 blocking、不消耗 `rounds.check`；只有正文/机器门真正的 content failure 才写 check 并 `counted:true`。工具错误行会回传逐条 `items`。
- **world delta 双真源仲裁**：`summary.new_elements` 只作为意图声明；`state/world.yaml` 的存在性为真源。已有实体写 `created` 归一化为 `updated`，新实体写 `updated`/`no_change` 在 kind/正文可判定时归一化为 `created`；kind/detail 冲突仍拒绝。`archiveChapter` 返回 `delta_warnings` 与 `normalized_world`，warning 不再静默。
- **pending 只读诊断**：`inspectPending` 分类 `none|complete|untouched|partial`；status/doctor/audit/panel 对 complete/untouched 给 warning、partial 给 `ENGINE_PENDING_PARTIAL`，不再误报 hash mismatch。`novel_init` 会先恢复/拒绝崩溃 init，partial 不被 PROJECT_EXISTS 掩盖。
- **outline 归档不变量统一**：`novel_blueprint`、`novel_outline_import`（含 dry-run）、`novel_amend(outline)` 与 `novel_outline` 共用 `assertArchivedCardVolumes`/`assertArchivedCardsInVolumes` 和 active 卡保护；即使旧卡缺失或卷重排，归档章也必须由最终卡指向覆盖它的卷。`reindexed`/`would_reindex` 显式回显，omitted 归档卡不再伪造 `archived_at`。
- **summary-only 修复**：`novel_revise` 可只传 `summary`：正文 hash、章文件和历史不变，不消耗 revise 轮次，保持/推进到 P6；不要求 P4/P6 proof，接下来可直接 check/archive。summary-only 明确拒绝 `issues`/`proof`，避免静默吞掉评审/证明。P8 与工具文档已改为先 summary-only、只有正文需要改才走 P5。
- **PG-05 前置**：P3/P5 即检查 `summary.new_elements` 名字在正文出现、已在 world ledger 时报“remove/use updated”，并校验 `characters_appeared` 正文/叙述者别名，避免错误留到 P8。
- **资源余额**：`current_state.resources` 与旧余额深合并，保留兄弟资源；created/updated 都校验有限非负整数，负值/字符串/null/数组拒绝；P8 示例与错误提示改为非负。

### Hardened

- brief digest 绑定完整 project/outline/worldbook/plan/worldPlan，而不只是裁剪后的 context。
- characters/world 重复实体名在 load 与 amend 均拒绝；`strict_explicit` 只允许内部 provenance，公共 outline 写入拒绝该字段。
- FsStore 将 EACCES/EPERM/EROFS 包装为 `ENGINE_IO_PERMISSION`；rulepack 对每个 section/nested object 递归 knownKeys，包括 `reader_intrusion`/`god_view`、`genres.*` 与 `water_words.scene_thresholds`。
- worldbook 导出补 `数值事实`；duplicate paragraph 指回原章真实段落号；time regression 指向正文段落；timeline.characters 必须是已声明角色；export 在 artifact 缺失时使 replay 失效并重写。
- migration 备份 `backups/migrations/` 不参与 retention prune；无硬链接文件系统（FAT/SMB/WSL）用受控 rename fallback 回收 stale lock；面板选择中配置 projectRoot 优先于单行 registry；commands 错误行与 tools 一样保留 blocking/items。

### Migration

- check 文档 schema_version 不变；新增字段可选，旧 check 可读。旧项目已消耗的 rounds 不回滚。
- archive 遇到旧 `summary.new_elements` 与 ledger 冲突时按新规则成功并给 warning；不会回写旧 ledger。
- summary-only 是新增调用模式，旧 content/patch 修订语义不变。
- `strict_explicit` 若曾被外部写入，仍可被读取；新的公共写入必须改用 `strict`。
- 详细验收与真实项目/模型证据见 `docs/0.2.5-acceptance.md`、`docs/0.2.5-real-model-evidence.md`。

## 0.2.4

### Changed

- **BREAKING：`novel_outline` 改为按标识 upsert**：`chapters` 按 `num`、`volumes` 按 `title` 合并；省略的卡保持不动，不再因“提交集合就是全集”而静默删除。删除必须显式 `remove` / `remove_volumes`，活动章、归档章、不存在的卡和已完成卷都会被拒绝。
- **可解释写入**：`novel_outline` 新增 `dry_run`（返回 `would_add`/`would_update`/`would_remove`，零写盘、零 journal）、`added`/`updated`/`removed` 变更回显、`outline/outline.deprecated.yaml` 一级回退副本；`novel_restore` 支持 `paths: ["outline/outline.yaml"]`、不要求 `chapter`。
- **工具契约**：持久集合的数组参数声明 upsert/replace/remove 语义；`novel_blueprint` 的卷列表仍是 replace，但删除卷必须显式 `confirm_remove:true`。DSH 的强制 JSON Schema 子集不接受未知 `x-semantics` 关键字，因此语义落在参数描述与 `src/tools/semantics.ts` 契约表中，并由 `tests/tool-contract.spec.ts` 强制。
- **文档**：`novel_outline` 描述明确“upsert by key”，P2 brief 增加“未提交卡保持”的提示，工具文档与升级说明同步。

### Migration

- 老的**全量提交**调用在 upsert 下等价，无需改动。
- 老的**部分提交**以前会删掉未提交卡，现在只改提交的卡；这正是本次修正。
- 想清空计划卡：以前空数组可行，现在空数组是 no-op；必须显式 `remove: [3,4,...]`。数据格式不变，无需迁移文件。
- 同名卷会被新写入拒绝（upsert 以 `title` 为键，同名无法区分）。老项目只读加载仍兼容；若要提交 `volumes`/`remove_volumes`，先用 `novel_amend` 给其中一卷改名。

### Tests

- 新增 `tests/024.spec.ts`（部分 upsert、显式删除、active/unknown/submitted/archived 拒绝、dry_run 零写入、deprecated、outline 恢复、volumes upsert/remove、blueprint confirm）与 `tests/tool-contract.spec.ts`。
- 质量：80 个测试文件 / 848 项测试全绿；覆盖率 93.97 / 89.14 / 98.00 / 93.97，逐文件门禁通过。

## 0.2.3

### Changed

- **报表账本**：`novel_report.effort` 对旧章按 committed journal 回填 `submitReview`/`submitRevision`/`runCheck`/`rollback` 与 `archived_at`，旧 `final_check` 从 check 文档补读；`quality` 改为每章一份最终评审，新增 `samples`（章数）、`attempts`（committed 评审轮次，含历史）与 `trend_basis`，样本不足时 `trend` 为 `null` 而不是伪造 0。
- **简报按章隔离**：`state/briefs.yaml` 仍是全书 append-only 审计，但 `pipeline.briefs` 与 `getBrief` 只取当前章收据；重复领取同一章同一阶段直接 replay，不写 journal、不升 revision；仍取项目写锁做 journal 一致性检查，避免误恢复其他写者的 pending 事务。
- **角色与伏笔**：旧 `extra` 角色可从 worldbook/P1 或叙述者修正；伏笔 `resolved` 同步写 `advance_log`，记录章节、note 与 new_info。
- **归档失败可直接修订**：`ready_to_archive` 增加 `submitRevision` 回 P4，不必先 `novel_rollback`；P5 任务书与所有 brief 暴露 `manuscript_hash`/patch 示例。
- **P8 契约**：brief 带最小 `state_delta` schema、每段示例和 `worldbook_facts_empty`；delta 错误回显 expected 形态；`ENGINE_ISSUE_IMMUTABLE` 区分“格式错”和“评审归属不可改”。
- **提示降噪**：advisory 按 code 每章一条并合并去重后的证据；`LOCKED_DETAIL_DRIFT` 带 expected/actual 片段，重复段带阈值；`RESOURCE_MISMATCH` 只在正文明确写反向符号时报，不再把中文省略符号当矛盾。strict 模式下 `facts` 为空时 doctor 提醒；同段“数量×单价/人数×单价”算式不一致会报 advisory；中文句密度上限校准为 10/100 字。
- **失败重试**：有 key 的写操作在 journal 记录 `retry_key`/`retry_context`；与上次被拒尝试内容、brief、stage、revision 完全相同时返回 `ENGINE_RETRY_UNCHANGED`，防止原样重试浪费事务；换 brief 或改内容后放行。
- **默认规则包 1.0.1**：`period_density.max` 8→10（中文短句校准），并加入同段乘式/人数×单价算式 advisory。
- **面板 v5**：紧凑顶栏、首屏“当前章/下一步”、双栏工作台、统计条；项目选择器按写作/待修复/失效分组，失效默认折叠、可搜索、同名用父目录区分；advisories 与 legacy 独立展示；payload v5，旧标签页刷新。
- **项目卫生**：`check:host` 同时隔离 `HOME`/`DSH_HOME`，用临时注册表正控证明 `novel_init` 确实写入了隔离行，并回查真实 `projects.yaml` 未新增 Host Smoke；新增 `/novel projects --prune [--yes]`，默认只列失效登记，`--yes` 才删登记行，不删项目目录。
- **升级审计**：doctor 新增 `legacy-data`，只读标出旧 check、缺 rounds/archived_at、extra 角色、pre-0.2.3 无 anchor 伏笔、stale `pipeline.briefs`；`state/briefs.yaml` 的跨章历史收据是正常 append-only 审计，不误报；不自动改历史。新伏笔用 `format_version:1` 区分合法 anchorless 条目。
- **发布前复核**：`ready_to_archive` 的可修订归档阻断改推荐 P5→revise；锁定细节、资源归属、千分位/枚举算式、重复段证据定位修正；quality `attempts` 补齐 journal 缺口；`check:host` 在创建临时 home 前验 DSH、保留隔离正控；`check:artifacts` 校验 `dsh.client` 清单。

### Tests

- 新增 0.2.3 报表回填、quality 样本/attempts、briefs 按章、brief replay、ready_to_archive 直接修订、P5 hash、doctor legacy、面板分组/advisory/legacy、`projects --prune` 与 advisory 去重测试。
- 质量：78 个测试文件 / 836 项测试全绿；覆盖率 94.12 / 89.28 / 97.96 / 94.12，逐文件门禁通过；typecheck、lint、build、pack、artifacts、install、preset、host、crash、hygiene、isolated、rulepack 全过。
- 真实模型：`agnes-2.5-flash`（275 字 / 6 段）与 `agnes-3.0-flash`（373 字 / 8 段）在临时项目完成 P1→P8、归档、report/doctor/panel v5、六种导出、reopen 与重新归档；P1/P2/P3 真实，P4/P6 确定性夹具，详见 [0.2.3 真实模型证据](docs/0.2.3-real-model-evidence.md)。
- 版本升 0.2.3；`REMOTE_VERSION` 4 → 5；工具 28、服务操作 32、核心工具 10、门控 13、语义项 5、导出 6 均不变。

## 0.2.2

### Changed

- **会话级项目选择**：删除 `EngineService.lastRoot`；显式 `project_root` 成功加载后写入 `stateDir/session-bindings.yaml`，按 DSH `SessionId` 持久化，DSH 重启后仍在。A/B 会话不再因为“最近一次工具调用”互相串书。
- **四层解析**：显式参数 → 会话绑定 → 会话 cwd 的有限工作区发现（`cwd`、`cwd/novel`、唯一直接子目录）→ 唯一注册项目/配置 `projectRoot`。有 Agent 且多项目无上下文时返回 `ENGINE_PROJECT_AMBIGUOUS`，不再用 `active` 静默兜底。
- **删除/移动/替换 fail-closed**：绑定目录消失返回 `ENGINE_PROJECT_MISSING`；同路径换成另一本 `created_at` 不同（或新项目没有 `created_at`）的书返回 `ENGINE_PROJECT_IDENTITY_MISMATCH`；不自动回退、不自动重建、不自动清登记/绑定。移动后若注册表有同 `created_at` 的其他 root，错误提示候选但不会自动跳转。
- **注册表增强**：`projects.yaml` 保持 v1，新增可选 `created_at`；注册按规范化 root upsert，同一路径始终一行；重复注册幂等，显式 `register` 在路径被替换时返回 `replaced:true`；`active` 降级为面板默认与无 Agent 默认。
- **`novel_init` 的 root 规则**：省略 `project_root` 时只使用配置 `projectRoot`，不读会话绑定/工作区/active；创建成功后才绑定当前会话并登记。
- **工具 schema**：`novel_init` 使用独立的 `project_root` 说明；其他工具说明四层顺序；`novel_status` 新增 root/source 文本与 JSON `selection`。
- **面板 v4**：新增项目选择器、choose/missing 状态、`summary.root`、`projects[]`、`selection`、`resume`、`missing`；选择只改 GET `?root=` 与浏览器 `localStorage`，不写会话绑定；加入请求竞态/Abort、未登记偏好回退、损坏项目提示、移动端选择器布局。面板读取使用 `loadAt`，不会因查看项目而登记或绑定。

### Added

- **新增命令**：`/novel projects|current|use <path|title|.>|unbind|scan [--register]|resume`。`scan` 只扫有限工作区、最多 50 个候选、不递归/不跟随符号链接；普通 scan 不写，`--register` 只登记健康项目且不改 active/绑定，单条登记失败不中断整批。`resume` 与面板复制共用 `formatResumePrompt`，只读，不写绑定/注册表/项目；scan/resume 不是新工具（工具仍 28、操作仍 32）。
- **复制续写指令**：下一步卡新增只写浏览器剪贴板的按钮，文本与 `/novel resume` 同源；剪贴板失败时展示可手动选中的只读文本。

### Fixed

- **完整卷视图**：修复 0.2.1 只显示前 8 卷的 UI 截断，全部卷在滚动容器中展示并高亮当前卷；不新增 DTO 字段或接口。
- **删除项目的写入与事务**：写操作在取项目锁前确认 novel/state 证据，`FileLock` 不再把已删除目录重新 mkdir；事务在每次 rename 前与提交后检查 root，root 在 rename 之间消失时 abort、跳过补偿且不补写 journal，避免被后续 mkdir 从空目录重建。
- **扫描批次与只读**：`scanWorkspace` 在第一个超过 50 的候选处停止检查；`scan --register` 的登记写入失败按候选记录为 skipped，不中断后续候选；`resume` 和面板查看不再通过 `load()` 自动登记/绑定。
- **面板/初始化旧口径**：修正面板教程中“跟随最近工具调用/activate 切换”的旧说法，README 的初始化 root、旧面板版本号、注册表提示和工具写入说明。
- **第二轮全量 review 补强**：`novel_amend` 保留已解析 Selection，绑定路径被替换时不再绕过 `created_at` 身份检查，workspace amend 不再产生持久绑定；绑定有身份而磁盘项目失去 `created_at` 时 fail-closed；写工具/amend 在项目锁前返回 `ENGINE_PROJECT_MISSING`，doctor/guide 不再把丢失绑定伪装成“还没有项目”。
- **元数据与扫描**：重复显式读取不再抢 metadata 写锁；`SessionBindings.bind` 不因 source 变化重写文件；scan 不为已登记候选构建完整 Snapshot，新增候选快照 damaged 时不写占位登记；相对 `project_root` 按会话 cwd 解析，与 `/novel use` 一致。
- **读取容错与纯文本 diff**：显式 `project_root` 的读取不再因绑定/登记元数据损坏或不可写而失败，无 root 解析仍 fail-closed；`novel_diff` 的 `before`+`after` 纯文本模式不再读取项目，`chapter` 缺省返回 0。
- **事务根身份**：staging 期间根目录被删除或替换时 fail-closed，不重建、不写入替换目录；`FsStore.writeText/writeBytes/appendText` 不再用 recursive mkdir 重建缺失根。
- **面板与契约**：切换项目时显示骨架并隐藏旧书数据/复制按钮；`AbortSignal.any` 缺失时保留 10s 超时；missing 提示中文化并区分 `unreadable`，`/novel current` 显示失效绑定状态；`novel_word_count` 纯文本与 `novel_diff` 纯文本模式明确不读项目、不绑定会话；`check:host` 从构建产物派生 28 个工具名并校验 v4 字段。

### Tests

- 新增会话绑定、选择矩阵、并发绑定、扫描封顶、扫描单条写失败、命令、面板 v4、只读 resume/panel、damaged 绑定、符号链接根、工作区优先级、可见加载竞态、事务 root 删除、完整卷与剪贴板测试；README/DESIGN/docs/tools/面板教程与错误码同步。
- 版本升 0.2.2；`REMOTE_VERSION` 3 → 4；工具 28、服务操作 32、核心工具 10、门控 13、语义项 5、导出 6 均不变。
- 质量：77 个测试文件 / 772 项测试全绿；覆盖率 93.87 / 89.15 / 97.89 / 93.87，高于 0.2.1 基线；typecheck、lint、isolated、build、pack、artifacts、install、preset、host、crash、hygiene 全过。真实模型两条 P1→P8 链路通过，见 [0.2.2-real-model-evidence.md](https://github.com/ThzxxArt/dsh-novel-write-engine/blob/main/docs/0.2.2-real-model-evidence.md)。

## 0.2.1

- **面板可滚动**：`nwe-root` 改为 `height:100%; overflow-y:auto; overscroll-behavior:contain`，宿主 `overflow:hidden` 不再裁掉下方内容；教程弹框保持 fixed，Esc/遮罩/焦点返回不回归。教程弹框新增「续写下一章」可直接复制给 Agent 的话术：先 `novel_pipeline` 确认状态，缺章卡用全量 `novel_outline`，目标章数满了用 `novel_amend`，再按 P1→P8 推进并在归档前确认 `state_delta`。
- **指标单一 owner**：`outlineSummary` 接收目标章数与已归档章号，输出规划覆盖、归档覆盖、缺卡数与逐章 `card_coverage`；`novel_status`、`novel_report`、`novel_doctor`、panel、`/novel outline` 全部消费同一结果，40/800 不再显示 100%。剩余字数按实际平均字数估算，并保留最小目标口径。
- **字数说真话**：`WordMetrics` 新增 `punctuation_chars`；PG-03 失败消息并列汉字/标点/英文词/数字；brief 增加 `word_count_policy` 和 `dialogue_ratio_target`；中文弯引号、破折号、省略号归入中文标点，对话行按四种引号统计。
- **失败可审计**：通过参数形状校验、进入项目锁后被 gate/delta/state 拒绝的写操作在 journal 写 `status:"aborted"`、`attempt:true` 行，带 `code/reason/hint/blocking`；事务提交失败与崩溃恢复的 aborted 行也带 `code`；锁前纯参数形状错误不写 journal。`AuditRow` 增加 `seq/code/reason/hint/stage/attempt/blocking`；`novel_audit` 支持 chapter/op/status/since/until/cursor。
- **历史不再只活最后一份**：评审、校验、正文、废弃稿、P2 计划按 pipeline revision 写入 `history/`；`novel_state {kind:"history"}` 全量列出（`total`），按 chapter+正整数 revision 读取；`novel_report` 从历史评审聚合维度样本，`ChapterRecord` 保存 lifetime `rounds`（含 `rollbacks`）/`final_check`/`archived_at`，report 新增 `effort`；`novel_amend` 不能改写这些归档证据。
- **备份可列可恢复**：事务备份写入 `manifest.json`；P2/P4/P6 在已有旧文件时也建备份，因此计划/评审/校验可从真实事务恢复。`novel_state {kind:"backups"}` 列出 op/chapter/revision/files；新增 `novel_restore`，只恢复活动章且不做 replay（外部再次改动后同一 txid 仍会真正恢复），已归档章先 `novel_reopen`，恢复本身再建备份。`novel_reopen` 的 journal/manifest 现在记录被重开的章节。
- **计划与摘要分权**：P2 计划文件不再被 P3/P5 写入 summary；活动标题/场景/叙述者/摘要存入 `pipeline.draft`，旧项目回退读 plan.summary；P5 不再改写 P2 证据。归档前校验 `draft.content_hash` 与正文一致，正文被外部改动时拒绝封存（`DRAFT_STALE`/`ENGINE_TXN_ABORTED`）。
- **修订成本**：`novel_revise` 支持 `patch:{expected_hash,edits}`；hash 不匹配、锚点不唯一/越界/重叠都会零写入拒绝。
- **简报收据独立**：`state/briefs.yaml` 保存 receipt，pipeline.briefs 仅作旧项目回退；重复 digest 直接 replay，rollback 后不再无条件重签。
- **伏笔标签与锚点**：`title` 可保留可读短语，新增 `anchor` 作为正文逐字校验证据，且至少 8 个字符（单字锚点不再能绕过）；无 anchor 时仍要求 title 出现在正文；P8 brief 给出规则和示例。
- **质量门禁分层**：`check.machine.violations` 只放 blocker，advisory 放 `machine.advisories`；`acknowledge` 只接受本次 advisory code。新增 `DIALOGUE_RATIO`、`NUMERIC_CONTRADICTION` 与 `NUMERIC_FACT_MISMATCH`；数字矛盾因无法判定主语固定为 advisory，数字事实只匹配“别名+数字+声明单位”的相邻写法；worldbook 支持声明式 `facts`，并进入计数、brief 上下文、搜索与 P6 检查。
- **初始化与角色**：空 author/description 返回 warning；角色 role 从显式值、P1 计划、worldbook、narrator 推导，不再一律 extra；`insight` 的 cast/维度排序改用稳定 code-unit 比较。
- **真实模型**：`agnes-2.5-flash` 与 `agnes-3.0-flash` 在临时项目完成 P1→P8、归档、report/doctor/panel、六种导出、`novel_reopen` 与重新归档；P3 366 / 490 字，P2/P3 叙述者分别继承 P1 的林深/林渊；2.5 的 564 字在更早 600 字目标下被 PG-03 真实拒绝，本次 76 字由驱动脚本 300 字下限拦截（未进引擎）；详见 `docs/0.2.1-real-model-evidence.md`。
- **发布前回归收口**：无 target 时 status/stats/panel 的 null 覆盖显示不再伪装 100%；report 对重复评审去重；novel_state pipeline 返回合并后的 briefs、briefs 查询保留 0.2.0 pipeline.briefs 回退；restore review/check 重算 blocking；archive 把 P2 计划纳入事务哈希，reopen 拒绝归档后被改动的计划；doctor 只推荐活动章可恢复备份；amend/rollback 不再用旧 revision 缓存吞掉外部改动；worldbook entries 计入 facts。
- 版本升 0.2.1；panel payload v3；工具 27 → 28（新增 `novel_restore`），服务操作 31 → 32；文档、教程、任务书与测试同步。
- 质量：72 个测试文件 / 667 条测试；覆盖率 93.86 / 89.04 / 97.81 / 93.86；per-file 门禁通过。

## 0.2.0

- **整书生命周期**：新增 `outline/outline.yaml`（书级蓝图 + 卷 + 章卡）与 `outline/worldbook.yaml`（世界观设定集）。`novel_init` 自动建立两份空文档；旧项目缺少它们时按空规划读取，不报错。
- 新增 9 个工具 / 9 个操作：`novel_blueprint`、`novel_outline`、`novel_outline_import`、`novel_worldbook`、`novel_search`、`novel_doctor`、`novel_report`、`novel_guide`、`novel_reopen`。工具总数 18 → 27，服务操作 22 → 31；`toolsMode=core` 10 个。
- 大纲支持 Markdown / YAML / JSON 导入；`novel_outline_import` 可 `dry_run` 预览，关键字段缺失带行号报错。Markdown 模板与导出模板同形。
- 新增 PG-13 `OUTLINE_ALIGNMENT`：严格模式下 P2/P3 与归档都必须有当前章卡，标题、场景类型、目标字数区间、cast 必须与章卡一致；已归档卡不可改，要改先 `novel_reopen`。非严格模式只校验已存在的章卡。
- 归档事务同步回写章卡 `archived/archived_at/word_count/score`；非严格模式归档时自动补卡，大纲因此始终是完整进度视图。
- P1/P2/P3 任务书与上下文包自动带入 `book_plan`、`outline_card` 与相关 `worldbook` 条目；P1 章卡 cast 必须在世界计划中登记。
- 新增 `novel_reopen`：只允许紧邻的已归档章、活动章尚未开始时，从该章归档事务的备份恢复索引/台账/handoff/正文并把管线重开到 P3；备份缺失即拒绝。
- P6 语义项从 4 条增至 5 条，新增 `L2-POV`（叙述视角与计划一致），五条证据必须来自不同句子。
- 新增 `novel_report`（进度/大纲漂移/世界观/质量趋势/节奏/角色/伏笔/时间线/关系/活动）、`novel_doctor`（项目/流水线/状态/journal/正文 hash/孤立正文/大纲覆盖与漂移/当前阶段产物/锁/备份/目标进度/下一步）、`novel_search`（正文/摘要/大纲/世界观/台账）与 `novel_guide`（六态：no-project/new/planning/writing/blocked/finished）。
- `novel_status` 增加书级摘要；`/novel stats` 与 `/novel-stats` 都输出大纲覆盖、蓝图就绪、世界观条目、严格模式与目标章数。
- 导出扩展到 6 种：`md` / `txt` / `epub` / `outline` / `worldbook` / `proposal`；导出幂等键纳入大纲与世界观摘要。
- 面板 payload v2：新增全书规划（进度条、卷列表最多 8 卷并提示剩余卷数）、世界观计数、质量趋势、项目健康、最近活动；旧版本面板提示刷新。面板保持只读。
- 面板右上角新增「教程」帮助入口：可访问的弹框按开书准备、P1–P8 单章流水线、下一章循环与导出给出完整步骤，并包含面板说明、常见排错、起手话术和完成清单；支持 Esc、遮罩关闭、焦点返回与移动端滚动。
- 命令新增 `/novel outline|guide|report|doctor|search`，`/novel export` 与 `/novel-export` 支持 6 种 kind；`/novel admin` 暴露全部新增操作。
- 事件新增 `novel/planned`、`novel/reopened`、`novel/exported`。
- 修复：非活动章 `planWorld` 读取补 `validateWorldPlanShape`；大纲/世界观损坏进入 `state_errors` 并阻断依赖写操作；init 的“空目录”判定包含 outline/worldbook，避免覆盖只有规划文件的项目；`novel_report` 按章去重角色出场；`runTransaction` 的 committed journal 保留 pre-image hash 以支持 `novel_reopen`。
- 规划与重开修复：outline/worldbook 读取改走 `narrow`（未知顶层键、schema 版本、book 未知键都拒绝）；`novel_amend` 对大纲先做完整语义校验并保护归档卡 cast/target_words/word_count/score/archived_at，worldbook 校验 capacity/必填文本；`novel_reopen` 改为 reason 必填、损坏 outline 拒绝覆盖、旧 journal 无 `before` 时从备份恢复；`novel_outline_import` 不再把已有蓝图/卷的 `strict:false` 强制翻成 true；列表/世界观/统计的 present 以内容为准；doctor 增加大纲覆盖率与当前阶段产物；panel 健康纳入 journal、质量均值只取最近 10 章、进度条改用目标章数；search 覆盖 world abilities/artifacts/factions/rules、locks 与 handoff；P1–P3 的 worldbook context 做硬截断。
- 规划/归档一致性修复：损坏 outline/worldbook 不再被 blueprint/outline/import/worldbook 覆盖，outline/worldbook 纳入 journal 外部改动检测；chapters 不可读时禁止规划写并保护 amend 归档卡；`novel.yaml` 降低目标章数会校验现有卷/卡；`novel_reopen` 自动补卡、对齐归档 plan、提交前校验 outline；显式 `strict:false` 通过 `strict_explicit` 保留；Markdown 导出/导入保留前提、卷外卡不再被并入末卷、归档元数据给出明确警告；`novel_diff` 支持纯文本模式；`novel_worldbook` 返回逐段 counts；report 质量趋势/角色最后出场、guide 完成态、doctor journal 下一步与 0% 覆盖率口径修正；import 重算 preview 并拒绝过期 revision；panel 显示卷的计划/归档（最多 8 卷 + 剩余提示）与 0.2.0 工具中文标签。
- 状态与日志恢复修复：replay 缓存按 revision 失效（export 按内容键跨无关 revision 幂等）；损坏的 `archive-digests.json` 从 chapter index 重建且不再拖垮 journal；缺失 journal fail-closed；尾部撕裂日志只裁剪最后一个无换行片段；崩溃前 pending 的 staging 目录清理；写临时文件失败清理 `.tmp`；worldbook `updated_at` 稳定；search 包含活动草稿并按 gate 段落口径编号；report/doctor 暴露损坏评审；reopen 拒绝覆盖归档后的 amend；规划写拒绝 projectError；卷迁移自动推导归档卡卷；时间线角色类型校验；文本 diff 可脱离项目；admin plan_chapter 不再注入非法默认值；stats 命令补齐新增字段。
- 持久化与观测修复：卷范围重排时归档卡按新区间推导卷号；`novel_amend` 保护归档索引的标题/场景/字数/评语/摘要/评分/状态等派生事实；4 位章节文件名纳入孤立正文与归档卡校验；journal 只含 lock-reclaim/空文件时 fail-closed，stale lock 不再隐藏 journal 诊断；备份先写入 staging 再原子移入 backups，崩溃不再留下不可回收目录；PG-09 引用与 check 文档先窄化再落盘；hand-edited outline 可省略 nullable 归档字段；`novel_plan_chapter` 的 target_words 不再硬编码 2000–3000 且工具 schema 补齐必填；`/novel admin` 透传 warnings/replayed；volume-only Markdown 大纲可回导；面板/命令的 next reason 中文化；docs 的 report 字段、PG-13 码、工具计数与 P4 版本同步。
- 发布前回归修复：`novel_plan_chapter` 的必填字段在工具 schema 与服务端重新对齐；`check:host` 改为先 build，再断言宿主声明全部 27 个工具，并校验预设名与面板空态/结构；README 文档链接改为 GitHub 绝对地址，修正 `toolsMode`、`novel_panel`、六种导出与工具计数等文档漂移；事务 abort 行追加前修复撕裂日志尾；同 pid 但非 live nonce 的锁按 stale 读取，不再伪装成活跃 writer；journal 对账与 `auditHistory` 在读取期间出现 writer 时丢弃半提交误报；lock reclaim 仅在原锁确实被移除时写审计行。
- 真实模型验证：`agnes-2.5-flash` 与 `agnes-3.0-flash` 在发布前最终构建的临时项目完成单章 P1→P8、归档、report/doctor/search/panel、六种导出、`novel_reopen` 与重新归档；P3 分别 931 字 / 898 字，均通过 P6，重开后无 state_errors。详见 `docs/0.2.0-real-model-evidence.md`。
- 质量：新增 `tests/book-020.spec.ts`、`tests/book-domain.spec.ts`、`tests/insight-020.spec.ts`、`tests/coverage-020.spec.ts`、`tests/review-probe-020.spec.ts`、`tests/second-review-020.spec.ts` 与 `tests/third-review-020.spec.ts`；当前 71 个测试文件 / 625 条测试；覆盖率 93.94 / 89.16 / 98.02 / 93.94；门禁为全局 statements/lines/functions 90、branches 89，engine 90/85、commands 85、client 85、viewmodel 95，新增 `engine/book.ts`/`engine/insight.ts` 的 lines/statements/functions ≥95、branches ≥93。

## 0.1.3

- 八个权威台账（chapters/characters/world/locks/timeline/foreshadows/relationships/handoff）以及 `novel.yaml` 损坏或丢失时不再拖垮 `novel_status`/panel；`state_errors` 暴露全部错误，`novel_state` 对 ledger、project、review、check 返回损坏文档的 `raw` 文本，`next` 指向 `novel_amend`。
- `novel_amend` 会为当前所有不可读状态文档豁免 journal 的既有 hash；真正可读文件的外部改动仍 fail-closed。amend 增加 chapters 只含已归档章、不减少、已归档 `content_hash`/`archive_digest` 不可改写、`next_seq` 不得复用已归档 assigned ids、locks/relationships 引用闭合、chapters 与章节文件 hash 一致、handoff 续写点与 open_hooks 闭合等不变量。
- `archiveChapter` 将每章 digest 写入 journal 跟踪的 `state/archive-digests.json`，修复 chapters 索引时用它校验归档幂等性，避免重建索引时伪造/丢失 digest。
- `novel.yaml` 可通过 amend 修改 `title/author/description/targets.total_chapters`；`genre/platform/created_at/words_per_chapter/dialogue_ratio` 保持不可变；`total_chapters` 不得低于已归档章数；项目文件损坏/丢失时接受完整项目文档并优先用备份恢复不可变基线。
- P2/P3/P4/P5/P6 brief 包含 P1 `world_plan`；P3/P4 的 `characters` 只放本章活跃角色完整卡，`other_characters` 是压缩索引；P2 的 `characters` 是 P1 候选角色；P6 新增受保护的 `active_cast`。角色排序改为 cast → 正文/计划提及 → `last_seen` → 稳定 key；正文新出现的已知角色会补进显式 cast，独立提到的短名不会被长名误杀。
- `novel_plan_chapter` 新增可选 `cast`（1–8 人：`name/entry_state/goal/knowledge/exit_change`）；名字必须来自 P1 世界计划或角色台账；旧 plan 不需要 cast 也能读。
- 归档 handoff 继承上一章 volume/volume_name；`act`/`act_progress` 从上一章推进（第五幕/1/5，不再在第 21 章重置成第一幕），`handoff.act`/`act_progress` 可覆盖且会校验；`open_hooks` 按最久未动优先。status/panel/P1 显示活跃章的下一幕位置。
- `novel_state {kind:"chapters"}` 默认返回紧凑索引（num/title/word_count/score/status），新增 `include_summary` 与 `chapter_range`；300 章默认 ≤64 KB；panel 只送最近 30 行，并显示卷/幕标签和幕内进度；panel 平均分改用全书 archived 分数，不再被 30 行上限截断。
- 只跑 `content` 或 `integrity` 的 check 通过后停留在 P6，不再进入 archive 死循环；返回 `CHECK_SCOPE_PARTIAL` warning。check 始终执行 PG-03 字数与 PG-07 评分下限，scope 只控制 PG-04/PG-10 等机检。
- 新增 `src/domain/stable.ts`：`compareText` / `stableJson` 使用 code-unit 排序，替换 localeCompare 与 registry 排序；brief digest 不再随 `LANG` 变化。
- 删除 `TRANSITIONS[].guards` 死字段，`applicableGates` 是门控唯一 owner；opening 检查抽成共享 helper；P2 标题长度读取 rulepack；EPUB 保留段首全角缩进。
- `check:host` 改为遍历请求体 `tools[]`，不再用整段 JSON 子串把 persona 文本当成工具声明；CI 增加 Windows 测试、真实 host/preset job 与跨进程 SIGKILL gate。
- 新增 30 章真实引擎闭环、120 角色 cast、300 章读口、1000 行 journal amend 测试；`scripts/check-crash.mjs` 在真实子进程 SIGKILL 后验证 pending journal 恢复。状态 schema 仍为 v1，不新增工具/命令/运行时依赖。
- 第三轮全量复核修复：`PG-11` 真正约束 P5/P6 `novel_revise`，status 按下一步实际操作选择 revise/check 预算；`PG-06` 进入 `runCheck` 与 archive preflight；`archivePreflight` 复用同一 `GateInput` 评估全部归档门控（含 PG-05/PG-06/PG-12 的 content+integrity scope）；归档不再接受被收窄 scope 的 check。
- 修复 `assigned_ids` 篡改、chapters 不可读时绕过 next_seq floor、settings pack 绕过 locks/relationships/chapters 引用与 revision 冲突；export replay key 纳入活跃章 plan title，活跃章改名后不会返回旧文件。

## 0.1.2

- `novel_init` 显式传入的 `author`/`description` 必须是字符串；P1/P2 计划在服务边界做运行时窄化：世界计划数组/对象形状、章节标题 4–8 字、narrator、5–8 个节拍、opening/ending、target_words 全部校验，非法输入零写盘。
- P4 issue 的 `dimension` 必须是当前规则包的十五维之一，`location` 必须是本章实际段落；blocker 在 P4/P5 都不能 `waived`；P5 只能改 issue 的 `status`/`evidence`，不能改写问题定义或严重度。
- `novel_rollback` 只允许退回当前阶段或更早阶段；`P3 → P6` 这类前进跳过会被拒绝。
- plan/review/check 任一文件损坏时，`novel_status`/`novel_pipeline` 仍可读，返回 `state_errors` 与 `STATE_UNREADABLE` 阻塞，`next` 指向 `novel_rollback`；回退后可用既有阶段重建，不需要手改文件。P6 的 check 损坏优先于旧 revision 阻塞，`next` 直接给 `novel_check`。
- `novel_brief` 的 `fields`/`context` 暴露 `plan_error`/`review_error`/`check_error`；损坏状态会阻断需要该文档的写操作。schema 版本高于本引擎的 plan/review/check 不会被当作“可修复损坏”，而是 `ENGINE_SCHEMA_TOO_NEW`，绝不覆盖。
- `novel_archive` 对“review 存在但没有 `review_digest`”（或摘要已不匹配）的旧数据 fail-closed；status 返回 `REVIEW_DIGEST_MISSING`/`REVIEW_DIGEST_MISMATCH`，`next` 指向回退 P4 重新评审，不会让模型反复撞归档。
- 每个 brief 阶段有独立上下文预算（P1 6000 / P2 8000 / P3 16000 / P4-P5 24000 / P6 32000 / P8 12000）；正文、当前 plan/review/check、摘要等受保护内容不裁剪，截断项与省略数写入 `context_meta` 并参与 digest；预算计算把 `context_meta` 自身的增长算进去，不再用固定预留猜大小。
- 上下文按正文/计划提及、最近程度、稳定 key 选择角色/世界/锁定/伏笔/时间线/关系；同分按名称/ID 稳定排序，输入顺序变化不改变 brief；不引入 RAG、SQLite 或新依赖。
- 水词/爽点/感官窗口改为按非空白字符推进，空格、换行、全角空格不再改变窗口结果；全角标点仍按 DESIGN 计入 `nonWsChars`。
- `RESOURCE_MISMATCH` 同时核对角色、资源名、数量与正负方向；符号必须在金额附近，远处另一段的反向词不能替它开脱。
- `ready_to_archive` 的九相位条显示 P7 进行中，P8/P9 未完成，不再把尚未发生的 P7 标成已完成。
- `novel_check` 的 `scope` 真正生效：默认 `content + integrity`，允许只跑其中一类；空数组/未知值零写盘，scope 归一化为固定顺序后写入 check 文档并参与幂等 key。
- `check:host` 新增真实 headless 工具链：临时 profile 中通过本地 Messages peer 触发 `novel_init`，断言工具声明、工具结果、项目落盘与最终回答；Web 面板与 remove 链路保留。
- 文档同步 0.1.2 的契约、升级路径与已知限制；状态 schema 仍为 v1，不新增工具/命令/运行时依赖。

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
- 第四轮加固：跨进程归档幂等 replay、原子锁回收、持久化 staging pre-image、活跃项目解析（0.2.2 已由会话绑定取代）、修订不再重写评审 `content_hash`、低分评审可进入 P5、短对话不触发重复段阻塞、嵌套 schema 校验与稳定快照读取。
- 面板 UI/UX 改造：Hero + 四项统计、九阶段完成态、下一步中文动作、章节卡与评分进度、门控可视化、loading/empty/error/outdated 状态、响应式布局、键盘焦点与每 15 秒自动同步。
- 第五轮发布前加固：归档前逐文档 `narrow` 校验（非法 delta/handoff 不再写坏项目）、锁回收行不再遮蔽 pending 事务、修订 issue 状态校验、初始化不覆盖失落的 `novel.yaml` 状态、失败 root 不污染面板、长事务锁只按存活进程回收、draft/revision 备份使 `novel_diff` 有基线、journal 对全部历史 state 哈希对账、check 文档嵌套校验、面板单章完成态与全书完成态区分、工具警告回传、preset 补回 subagent 控制工具。
