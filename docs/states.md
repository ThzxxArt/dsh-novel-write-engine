## 0.2.14 字段与恢复

- **资源**：`characters[].current_state.resources` 是绝对值（set）；`summary.resource_changes[].delta` 是增量（add）。同一章同一角色同一资源同时出现会被拒绝（`ENGINE_RESOURCE_DOUBLE_COUNT`），错误回显 `original / delta / result`。负余额默认拒绝，`novel.yaml targets.allow_negative_balances: true` 时才允许债务。
- **标量清空**：`CharacterDelta.unset: string[]` 删除 `current_state` 顶层键；`null` 仍按值写入。`no_change` 只接受 `role`，带 `current_state/profile/growth/unset` 会被拒绝。
- **delta 键**：每个 section 只接受固定键（characters: action/reason/role/profile/current_state/unset/growth；foreshadows: action/reason/title/anchor/description/note/new_info/planned_resolve/resolved_anchor/kind；world: action/reason/kind/description/layout/capacity/detail；timeline: action/reason/story_time/description/location/characters；relationships: action/reason/a/b/type/type_code/description/note）。未知键拒绝并给 `allowed`，不再静默丢弃；`characters`/`world` 允许 `name` 与键一致的回显。
- **strict 伏笔**：`strict: true` 时新 `plot` 伏笔必须有 `planned_resolve`，否则 `ENGINE_FORESHADOW_UNPLANNED`；非 strict 只给 `FORESHADOW_UNPLANNED` advisory。
- **brief 收据**：`BriefReceipt.dependencies` 记录各依赖块摘要；归档把该章 superseded 收据移入 `history/briefs/chNNN.yaml`，`state/briefs.yaml` 每章每阶段只留 current + 最近 2 条（合计 ≤3）。`novel_state {kind:"briefs", view:"all"}` 合并两处读取。
- **doctor baseline**：`state/doctor-baseline.yaml` 保存 `{id, detail}` 列表；同 id 同 detail 的 warning 不再报告，计数或文案变化会恢复。`novel_doctor {reset:true}` 清空。
- **实体锚点**：`summary.new_element_anchors` 的每个锚点是正文逐字短语，长度 8–120 字（0.2.14 从 2 字收紧；旧 world 文档里更短的既有锚点仍可读）。实体名本身仍可走 name fallback。
- **amend 删除**：`novel_amend` 服务端比对行数/主键，缺行拒绝；`allow_delete:true` 表示有意删除。`before/after/changes` 是回执，不写入文档。

## 0.2.13 可选字段与分页

- `outline/worldbook.yaml` 的 `characters[].appearance` 是可选外貌基准；`description` 继续放人物传记，不再被 `LOCKED_DETAIL_DRIFT` 当作外貌标准。worldbook 有该角色但没有 `appearance` 时不回退首现段落；只有 worldbook 完全没有该角色才使用 `locks` 短句。
- `novel.yaml` 的 `targets.min_cjk_chars`（正整数或 null）和 `dialogue_ratio_metric`（`lines|chars|both`）可选；缺省不改变旧项目。
- `foreshadows.items[]` 可带 `planned_resolve`、`resolved_anchor`、`kind:'plot'|'motif'`；`advance_log[]` 可带 `anchor`。旧 51 条保持 `planned=0`，report 显示 `unplanned`，不自动补计划。`novel_amend` 是显式迁移入口：可导入旧的/手工确认的 resolved 行；带 `resolved_anchor` 的新增或变更行会按该章正文逐字校验，无 anchor 的旧 resolved 行仍可迁移；它不替代 `state_delta` 的写入链，doctor 会把旧行列为 `LEGACY_FORESHADOW_ANCHOR`。
- `relationships.items[]` 可带 `type_code`；旧关系不猜类型，doctor 报 `uncategorized`。新建关系必须给 `type_code`。
- `timeline.items[]` 可带 `event_key`；旧条目读取时计算，不重写文件。
- `state/briefs.yaml` 的 `BriefReceipt` 可带 `id/current/superseded_at/superseded_by`；旧文件读取时按章节/阶段取最新为 current，不删除历史。
- `checks/*.check.yaml` 的 `machine.numeric` 与 `machine.acknowledged_findings` 是 0.2.13 字段；旧 check 文档仍可读。旧 0.2.13 顶层 `acknowledged_findings` 也继续读取，但新写入放在 `machine` 下，避免 0.2.12 拒绝整个文档。
- `novel_state` 的 `page` 是读取包装，不是持久化字段；不要把 `page` 写回 ledger。
- `novel_state {kind:"pipeline"}` 除 pipeline 外返回 `briefs`/`briefs_source`/`previous_chapter_effort`/`effort:{lifetime,basis}`，与 `novel_report`、`novel_status` 同源。

## 0.2.9 archive_card

`state/chapters.yaml` 的归档行可带两个可选字段：

```yaml
archive_card:
  title: 开端之雨
  scene_type: 日常过渡章
  target_words: [100, 200]
  cast: [他]
  goal: 收到无名信
  conflict: 拆不拆
  hook: 蜡印
  notes: 作者备注
  archived_at: 2026-10-31T00:00:00.000Z
archive_card_digest: "v1:..."
```

它们由归档事务写入，`novel_amend` 只能比较、不能新增或改写。缺字段的旧记录走只读回退：outline 可读时用当前卡，outline 不可读且有备份时用备份卡；两者都没有时 fail closed。

`ChapterRecord` 的三个可选字段里，只有 `cjk_words`（汉字数，归档时写入；PG-03 的汉字下限用它核对）是 0.2.14 新增；`final_check` 与 `archived_at` 自 0.2.1 起就有。0.2.14 之前归档的行没有 `cjk_words`，`novel_state {kind:"chapters"}` 的紧凑行给 `cjk_words: null` 明示"没记录过"，而不是 0；归档章卡同样带 `cjk_words`，且与记录不一致时 `novel_amend` 拒绝——否则这个数字可以被改写成任意值，等于没有审计意义。

# 状态机

## 两种枚举，不能混用

| 层                             | 取值                                                      |
| ------------------------------ | --------------------------------------------------------- |
| 任务书阶段 `novel_brief.stage` | `P1` `P2` `P3` `P4` `P5` `P6` `P8`                        |
| 管线状态 `pipeline.stage`      | `idle` `P2` `P3` `P4` `P5` `P6` `ready_to_archive` `done` |

P7/P8/P9 在 `archiveChapter` 一次事务内完成，不单独成态。`done` 表示**当前章已归档**；下一章从 `done` 回到 P1，只有项目配置的 `targets.total_chapters` 已全部归档时面板才显示全书完成。

归档第 N 章后，`pipeline.chapter` 指向 N+1，`pipeline.stage` 仍是 `done`——`done` 属于刚归档的第 N 章，不属于 N+1。`getStatus`/`advise`/panel 在 JSON 中返回 `progress`；`guide`/`doctor` 用同一投影渲染标题与流水线 detail：`stage === 'done'` 时 `current=null`、`last_archived=N`、`next={chapter:N+1,stage:'P1'}`，全书完成时 `finished=true`、`next=null`。`label`/`resume` 是人类读法的唯一来源；不要再从 `chapter`+`stage` 直接拼“当前第 N+1 章，阶段 done”。

## 迁移表

| 从                 | 操作                | 到                                                      | 门控                          |
| ------------------ | ------------------- | ------------------------------------------------------- | ----------------------------- |
| `idle` / `done`    | `submitWorldPlan`   | `P2`                                                    | 01,02                         |
| `P2`               | `submitChapterPlan` | `P3`                                                    | 01,02,13                      |
| `P3`               | `submitDraft`       | `P4`                                                    | 01,02,04,03,05,06,13          |
| `P4`               | `submitReview`      | `P5`（有 blocker）/ `P6`                                | 01,02,09,07,11                |
| `P5`               | `submitRevision`    | `P4`                                                    | 01,02,04,03,05,09,08,11       |
| `P6`               | `submitRevision`    | `P4`                                                    | 01,02,04,03,05,08,09,11       |
| `P6`               | `runCheck`          | `ready_to_archive`（完整 scope）/ 停留 `P6`（单 scope） | 01,02,04,03,05,06,07,08,09,10,11 |
| `ready_to_archive` | `archiveChapter`    | `done`                                                  | 01,02,04,03,05,06,07,08,09,10,12,13 |

`runCheck` 的 PG-03 字数下限与 PG-07 评审分数下限不随 `scope` 关闭：check 是归档前置，单 scope 只跳过硬性内容/连续性机检（PG-04/PG-10），不能用一个“integrity only”绕过字数或评分。

唯一的数据依赖迁移是 P4 评审按 blocker 数量决定去向。

`novel_status` 的 `chapter` 只用于字数查询；`active_chapter` 是管线当前章。任何阶段只要该阶段任务书缺失或 digest 过期，`next.tool` 都先指 `novel_brief`；任务书当前后才指向实际写操作。P5/P6 有阻塞时指向 `novel_revise`；`ready_to_archive` 在 P8 任务书当前后指向 `novel_archive`；`done` 未完成时先取 P1。绝不指向只读的 `novel_status`，也不使用过期任务书硬推下一步。

## 门控顺序

`PG-01 → PG-02 → PG-04 → PG-03 → PG-05 → PG-06 → PG-13 → PG-09 → PG-07 → PG-08 → PG-10 → PG-11 → PG-12`

格式先于字数：弯引号与破折号既计入字数又判违规，先判字数会奖励写错标点。

## 轮次与回退

- 评审/修订/校验各上限 3 轮，由引擎自增，模型不能传轮次。
- 超限 → `PG-11` 阻塞，提示 `novel_rollback`。
- 回退只允许退到当前阶段或更早阶段（`idle → P2 → P3 → P4 → P5 → P6 → ready_to_archive → done`；`to_stage: P1` 落到 `idle`）；`P3 → P6` 这类前进跳过返回 `ENGINE_STAGE_ORDER`。
- 回退保留正文与当前 draft 摘要（P1/P2 除外），清空 pipeline 轮次；任务书收据留在 `state/briefs.yaml`，digest 仍匹配时可直接复用。

## 0.1.2 状态恢复（历史，仍适用）

- `load` 对 plan/review/check 采用可恢复读取：文件缺失、YAML 或窄化失败时，快照仍可建立，错误进入 `planError/reviewError/checkError`；但缺失只在当前周期真正消费该文档的阶段报错（例如 P3 的 plan、P5/P6 的 review、ready_to_archive 的 check）。
- `novel_status` / `novel_pipeline` 返回 `state_errors`，并把 `STATE_UNREADABLE` 加入 blocking；当前阶段晚于重建点时 `next` 指向 `novel_rollback`，已经处在 P2/P4/P6 时直接指向 brief 与阶段修复工具。
- 恢复目标：plan → P2；review → P4；check → P6。目标不会晚于当前阶段；多个错误按 plan 优先。
- 需要该文档的写操作会被提前拒绝：plan 阻断 draft/review/revision/check/archive；review 阻断 revision/check/archive；check 阻断 archive。`novel_plan_chapter`、`novel_review`、`novel_check` 可覆盖对应文件。
- review 存在但 `pipeline.review_digest` 缺失或被改动时归档 fail-closed；status 返回 `REVIEW_DIGEST_MISSING`/`REVIEW_DIGEST_MISMATCH`，`next` 回退 P4，重新 `novel_review` 后再归档；不要手改 `state/pipeline.yaml`。
- plan/review/check 的 `schema_version` 高于引擎支持版本时返回 `ENGINE_SCHEMA_TOO_NEW`，不会被当作可覆盖的损坏状态。

## 0.1.3 台账恢复与长书状态

- chapters/characters/world/locks/timeline/foreshadows/relationships/handoff 采用可恢复读取：错误进 `state_errors`，`novel_status`/panel 仍可读；`pipeline` 仍 fatal。`novel.yaml` 损坏进入 `PROJECT_UNREADABLE`，同样可读可修。
- 损坏台账的 `novel_state` 返回 `{error,message,path,raw}`；`next` 指向 `novel_amend`，修复时当前所有不可读状态文档可绕过 journal 的既有 hash，其他可读文件的外部改动仍 fail-closed。
- amend 不变量：chapters 只含已归档章、不减少、编号连续、已归档 `content_hash`/`archive_digest`/`assigned_ids` 不改写；`next_seq` 不降低且不撞已有 ID；chapters 不可读时不接受无法证明 floor 的 timeline/foreshadows/relationships 改写；locks/relationships 不引用不存在的实体；chapters 记录必须与 `chapters/` 文件 hash 一致。
- `novel.yaml` 可改 title/author/description/targets.total_chapters；genre/platform/created_at/words_per_chapter/dialogue_ratio 不可变；total_chapters 不得低于已归档章数。`novel.yaml` 本身损坏时，amend 接受完整项目文档并优先从备份恢复不可变基线。
- `novel_plan_chapter` 的 `cast` 是可选 1–8 人，名字必须来自 P1 世界计划或角色台账；旧 plan 仍可读。
- `archiveChapter` 继承 handoff 的 volume/volume_name；`act`/`act_progress` 默认按幕内位置派生，handoff 可覆盖；`open_hooks` 最久未动优先。

## 0.2.2 会话选择与项目身份

- `stateDir/projects.yaml` 仍是 v1；项目行新增可选 `created_at`，`root` 为规范化绝对路径，同一路径一行。`active` 只作为面板默认与无 Agent 调用的默认项。
- `stateDir/session-bindings.yaml` 按 DSH `SessionId` 保存 `{root,title,project_created_at,bound_at,source}`；显式 `project_root`、`/novel use`、成功 `novel_init` 才写。它不是项目状态，不属于项目目录，删掉不会删书。
- 无显式 root 的解析遇到绑定损坏返回 `ENGINE_SCHEMA_INVALID`；显式 root 读取 best-effort、不更新损坏绑定。坏行（缺 session_id/root）过滤；同一 session 只保留一行；同一 root + `created_at` 的等价绑定不重写。
- `project_created_at` 是身份校验：路径存在但 `novel.yaml.created_at` 不同时返回 `ENGINE_PROJECT_IDENTITY_MISMATCH`，禁止写入；空 `created_at` 的旧项目降级为路径弱身份，不硬判。
- 绑定目录消失返回 `ENGINE_PROJECT_MISSING`，保留绑定与登记；路径存在但没有 novel/state 返回 `PROJECT_NOT_FOUND`；`novel.yaml` 损坏但 state 仍在仍可加载为 damaged。
- `/novel scan --register` 只写 `projects.yaml`，不写项目、不写绑定、不改 active；同 root 不同 `created_at` 只标 `identity_changed`，不覆盖登记行。
- 面板的 `?root=` 只接受注册表/active/配置路径；面板选择与复制都不写项目、注册表或会话绑定。

## 0.2.1 状态分权与证据

- `pipeline.draft` 是活动章的标题/场景/叙述者/摘要/正文 hash 的唯一 owner；`plans/chNNN.chapter.yaml` 是 P2 不可变证据，不再被 P3/P5 写入 summary。旧项目没有 draft 时回退读 plan.summary。
- `state/briefs.yaml` 保存任务书收据，`pipeline.briefs` 仅作旧项目回退；重复 digest 直接 replay，不重复写事务。
- `history/` 保存历史评审/校验/正文/废弃稿/计划；`novel_state {kind:"history"}` 默认 50 条分页（带 `page.total/returned/next_cursor`），用 `limit`/`cursor` 继续翻页，不会静默截断；按 chapter+正整数 revision 读取；`chapter.rounds`（含 lifetime `rollbacks`）/`final_check`/`archived_at` 在归档时写入，`novel_report.effort` 保留本章难度；amend 不能改写这些证据字段。
- 通过参数形状校验、进入项目锁后被 gate/delta/state 拒绝的写操作追加 `aborted` + `attempt:true` journal 行，带 code；事务提交失败追加的 aborted 行也带 code；内容文件零写入。锁前的参数形状错误不写 journal。
- 备份目录新增 `manifest.json`；`novel_state {kind:"backups"}` 可列；P2/P4/P6 在旧文件存在时也建备份，`novel_restore` 因此能恢复正文/计划/世界观计划/评审/校验。只恢复活动章，恢复本身再建备份且不 replay；旧版无 manifest 备份只可列出。
- 只跑 `content` 或 `integrity` 的 check 通过后停留 P6，返回 `CHECK_SCOPE_PARTIAL`，必须再跑完整 scope 才能归档。

## 0.2.0 书级状态

- `outline/outline.yaml` 与 `outline/worldbook.yaml` 是规划层，不属于 `pipeline.stage`；它们损坏时进入 `state_errors`（`OUTLINE_UNREADABLE` / `WORLDBOOK_UNREADABLE`），`novel_amend` 可修。读取走 `narrow`：未知顶层键、未知 book 键、错误 `schema_version` 都按损坏处理。
- 卷区间必须不重叠且相邻卷首尾相接；章卡 `num` 唯一，标题为 4–8 字正文，`scene_type` 四选一，planned 卡的 `goal/conflict/hook` 非空，`target_words` 为正整数区间。
- `novel_amend` 修 outline 时仍保护已归档卡的 title/scene/target_words/cast/word_count/score/archived_at；修 worldbook 时仍校验容量非负、名称/术语段内唯一、必填文本非空。`worldbook.facts` 校验 alias/value/unit/tolerance，参与计数、brief 上下文、搜索与 P6 数字事实检查。
- 严格大纲（`book.strict=true`）下，P2/P3 必须存在当前章章卡，且标题/场景类型/目标字数区间/cast 与章卡一致（PG-13）。非严格模式只校验已存在的章卡。
- 归档事务回写章卡 `archived/archived_at/word_count/score`；严格模式缺卡由 PG-13 在 P2/P3 拦截，非严格模式归档时自动补卡。
- `novel_reopen` 只允许紧邻的已归档章，且活动章尚未开始，`reason` 必填；它从该章归档事务的备份恢复索引/台账/handoff/正文，再把管线设为 `chapter=N / stage=P3`。备份缺失或 outline 损坏即拒绝。
- P6 语义项为 5 条（新增 `L2-POV`），五条证据必须来自不同句子。
