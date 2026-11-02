## 0.2.13 genre profile 扩展

`genres.<题材>.profile` 还可选：

```yaml
profile:
  pleasure_keywords: [钱, 账, 数, 铺, 租, 工钱, 生意, 招牌]
  foreshadow_min_dormancy: 2
  motif_min_dormancy: 1
  foreshadow_dormant_after: 20
```

0.2.14 新增 `NUMERIC_FACTS_UNUSED`（声明了数字事实但正文从未命中）与 `DIALOGUE_RATIO_SKEWED`（行/字口径只有一侧越界）；两者都只是 advisory。`PERIOD_DENSITY` 只判 ≥80 字段落；`WATER_WORDS` 按最长词优先、不重复计数，密度以配置窗口为分母；`DUPLICATE_PARAGRAPH` 没有 8 字连续重合时不再升级为 blocker；`LOCKED_DETAIL_DRIFT` 报告最差段落，并允许「关键词 ≥2 且顺序一致」的自然改写。

`pleasure_keywords` 优先于全局词表；`foreshadow_dormant_after` 优先于全局休眠阈值；`motif_min_dormancy` 只作用于 `kind='motif'`。缺省回退全局值，所有 profile 仍只影响 advisory，不改变 blocker/门控/评分。`pleasure_keywords` 必须是字符串数组；空数组与缺省一样回退全局词表；三个 profile 休眠阈值必须是正整数；否则 `RULEPACK_INVALID`，不会让一次 `novel_check` 在运行时崩溃。默认包不得写入具体书稿的专有词。

## 0.2.9 genre profile

`genres.<题材>` 可增加可选的 `profile`，只影响 advisory：

```yaml
genres:
  都市现代:
    note: "..."
    profile:
      period_density: { min: 1.5, max: 10 }
      water_words: 0.02
      pleasure_density: 2
```

`period_density` 必须是合法区间且 `max` 不超过 100；`water_words` 是 0..1 的比例；`pleasure_density` 是每个滑动窗口的最低关键词命中数（正整数，2 表示至少命中 2 次），不是比例。未提供 profile 的题材继续使用全局阈值。profile 不改变 blocker、门控或评分。

# 规则包

`rulepacks/default.yaml` 是唯一口味来源；代码只负责执行。

## 结构

| 块 | 内容 |
|---|---|
| `lexicon` | 零容忍、软上限、按类型放宽、元叙述、读者侵入、上帝视角、结论先行 |
| `format` | 段落上限、Markdown、分号、英文省略号、标题正则、出戏标签（正则） |
| `punctuation` | 破折号预算（按场景）、句号密度、省略号连用、匀速句、连续「了」 |
| `semantics` | 形容词密度、爽点密度、感官密度、水词滑动窗口 |
| `crosschapter` | 重复相似度与最小段长、伏笔休眠、时间倒退、锁定描写 token 覆盖率 |
| `quality` | 十五维满分（必须合计 150）；过关线由插件配置 `minScore` 提供，不写在规则包 |
| `exclusions` | 跨维度互斥对 |
| `exemptions` | 明确豁免的规则码 |

## 编译器六条断言

1. 十五维合计严格 150。
2. 词条非空、limit 非负。
3. 同一词条不得跨列表重复（一个词一个 owner）。
4. 互斥对与豁免必须引用真实规则码。
5. 阈值在合理区间（段长 20..500、分数 0..150、句号密度 min ≤ max 且 max ≤ 100、对话主导率 > 0、爽点/感官密度 > 0、伏笔休眠为正）。
6. 标题、视角、出戏标签与省略号 token 的正则必须可编译。

违反任一条 → `ENGINE_RULEPACK_INVALID`，插件拒绝启动。

## 五步流水线

`segment → density → quote → exemption → lexicon`

词表永远最后跑：一段格式已经崩坏的正文，先修格式再谈用词。

## 改词表

1. 编辑 `rulepacks/default.yaml`。
2. `pnpm build && pnpm validate:rulepack`。
3. 跑 `pnpm test`（规则表驱动用例会指出行为变化）。

不要在代码里加 if：规则码与实现一对一，注册表拒绝重复注册。
