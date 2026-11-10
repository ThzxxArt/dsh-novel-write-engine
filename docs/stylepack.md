# 风格包（0.2.17）

风格包回答一个问题：**这本书该长什么样**。它不回答「什么词不能说」——那是规则包的事。

- 规则包（`rulepacks/default.yaml`）拥有**词表**与**全局阈值**，作用域是全书。
- 风格包（`stylepacks/*.yaml`）拥有**项目级目标**，作用域是单本书，存在 `novel.yaml.style`。

一个词只能有一个 owner：风格包的 `banned_patterns` 与规则包 `zero_tolerance` 的交集会在**编译期**从风格侧移除，并记 `STYLE_BANNED_OVERLAP`。

## 1. 8 份内置包

| id                  | 名称       | 适用题材                   | 一句话                                             |
| ------------------- | ---------- | -------------------------- | -------------------------------------------------- |
| `cold-suspense`     | 冷峻悬疑   | 悬疑推理 / 都市现代        | 克制的感官，线索前置，低温对白，章末留下未解问题。 |
| `hot-blooded-fast`  | 热血快节奏 | 玄幻修仙 / 都市现代        | 短句推进，动作优先，信息差和章末钩子驱动追读。     |
| `ensemble-power`    | 群像权谋   | 历史架空 / 西方奇幻        | 多视角轮转，对白机锋，信息不对称，章末翻盘或代价。 |
| `infinite-flow`     | 无限流     | 悬疑推理 / 科幻 / 游戏系统 | 规则先行，倒计时压迫，关卡目标明确，冷幽默解压。   |
| `light-daily`       | 轻松日常   | 都市现代 / 言情            | 口语吐槽，生活流细节，轻喜剧节奏，低比喻密度。     |
| `romance-push-pull` | 女频拉扯   | 言情 / 都市现代            | 情绪留白，关系张力，短对白，潜台词多于解释。       |
| `steady-farming`    | 稳健种田   | 历史架空 / 都市现代        | 具体生活细节，资源逐项积累，低冲突但有明确目标。   |
| `weird-horror`      | 怪谈克苏鲁 | 悬疑推理 / 末世流          | 规则文本，感官错位，具体细节承载不可解释的恐惧。   |

`stylepacks/index.yaml` 是**唯一清单**：加载器只读它点名的文件，目录里的野文件不会变成可选项。`pnpm check:docs` 断言清单与 `novel_init` 参数描述逐行一致。

## 2. 字段语义

| 字段                                                 | 取值                     | 机检                                               | 进任务书          |
| ---------------------------------------------------- | ------------------------ | -------------------------------------------------- | ----------------- |
| `sentence.short/medium/long_ratio`                   | 0..1，和 ≈1              | `STYLE_SENTENCE_MIX`                               | 是                |
| `sentence.burstiness`                                | low/medium/high          | 只作说明；实际判 `thresholds.burstiness_min`       | 是                |
| `sentence.max_consecutive_same_length`               | 1..12                    | `STYLE_BURSTINESS` 的 `longest_run`                | 是                |
| `paragraph.max_chars`                                | 40..400                  | `STYLE_PARAGRAPH_CHARS`（仅当比全局 90 更严）      | 是                |
| `paragraph.max_sentences`                            | 1..12                    | `STYLE_PARAGRAPH_SENTENCES`                        | 是                |
| `paragraph.max_actions` / `one_action_per_paragraph` | 0..12 / bool             | **不机检**（中文动词不可靠）                       | 是                |
| `dialogue.ratio`                                     | 0..1                     | `STYLE_DIALOGUE_RATIO`（判**偏离目标**，不是越界） | 是（作为 target） |
| `dialogue.tag_style` / `allow_*`                     | 枚举                     | 不机检                                             | 是                |
| `diction.*_density`                                  | low/medium/high          | 由 `thresholds` 决定是否机检                       | 是                |
| `diction.sensory_channels`                           | 7 枚举                   | `StyleMetrics.diction.sensory_channels_hit`        | 是                |
| `structure.cool_point_every_chars`                   | 200..5000                | `STYLE_COOL_POINT_GAP`                             | 是                |
| `structure.opening_moves` / `hook_moves`             | 枚举数组                 | 不机检                                             | 是                |
| `emotion.min_cues_per_1000`                          | 0..10                    | `STYLE_EMOTION_CUES`                               | 是                |
| `emotion.required_beats`                             | 5 枚举                   | 不机检                                             | 是                |
| `banned_patterns`                                    | 1..40 条，每条 2..40 字  | `STYLE_BANNED_PATTERN`                             | 是（前 12 条）    |
| `exemplars`                                          | 1..3 段，每段 40..400 字 | 不机检                                             | 是（1 段）        |
| `critic_rubric`                                      | 3..8 条，每条 4..60 字   | 不机检                                             | 是（全部）        |
| `thresholds.*`                                       | 见下                     | 决定十条规则                                       | 是                |

`thresholds` 的三个容差有默认值，包里不写就用默认：`sentence_mix_tolerance` 0.15、`dialogue_target_tolerance` 0.15、`cool_point_gap_factor` 1.5。

## 3. 对白有两个数（不要混）

- **目标值**：`dialogue.ratio`，单一数，进任务书告诉模型往哪写。
- **验收区间**：`novel.yaml.targets.dialogue_ratio`，`DIALOGUE_RATIO` 用它判越界。

两个判断、两个码。风格包的 `thresholds.dialogue_ratio_min/max` 若存在，只**收紧**项目区间（取交集），不放宽。

## 4. 写一份新包

1. 复制一份内置包，改 `id`（必须等于文件名）与 `name`（全目录唯一）。
2. 跑 `pnpm validate:stylepacks`——14 条断言会在编译期报出具体路径。
3. 把 id 加进 `stylepacks/index.yaml`，再跑 `pnpm check:docs` 更新两处清单。

**常见编译错误**

| 报错                                      | 原因                                                 |
| ----------------------------------------- | ---------------------------------------------------- |
| `id must equal the file name`             | 文件名与 `id` 不一致                                 |
| `ratios must sum to 1`                    | 三档句长比例之和不在 0.98–1.02                       |
| `unknown genre tag`                       | `genres` 里有 `STYLE_GENRE_ALIASES` 不认识的标签     |
| `a template pattern cannot start with ……` | 前导空洞等价于子串匹配，没有意义                     |
| `must be 2..40 characters`                | 单字禁句会误伤（`叮` 命中 `叮嘱`），改成具体套话形式 |

## 5. 不可变

风格是书的属性：`novel_init` 时由**用户确认**后写入，之后不可更改；旧项目（磁盘上没有 `style` 键）在**零归档章**时可迁移一次，同样要过确认。`null` 表示用户明确选择不用，与「已定」同等不可变。

选错只能新建项目——所以开书前用 `/novel style show <id>` 看完整参数，`novel_init` 会在落盘前再弹一次确认。
