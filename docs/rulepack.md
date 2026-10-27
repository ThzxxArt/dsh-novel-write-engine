# 规则包

`rulepacks/default.yaml` 是唯一口味来源；代码只负责执行。

## 结构

| 块 | 内容 |
|---|---|
| `lexicon` | 零容忍、软上限、按类型放宽、元叙述、读者侵入、上帝视角、结论先行 |
| `format` | 段落上限、Markdown、分号、英文省略号、标题正则、出戏标签 |
| `punctuation` | 破折号预算（按场景）、句号密度、省略号连用、匀速句、连续「了」 |
| `semantics` | 形容词密度、爽点密度、感官密度、水词滑动窗口 |
| `crosschapter` | 重复相似度与最小段长、伏笔休眠、时间倒退、锁定描写相似度 |
| `quality` | 十五维满分（必须合计 150）与过关线 |
| `exclusions` | 跨维度互斥对 |
| `exemptions` | 明确豁免的规则码 |

## 编译器六条断言

1. 十五维合计严格 150。
2. 词条非空、limit 非负。
3. 同一词条不得跨列表重复（一个词一个 owner）。
4. 互斥对与豁免必须引用真实规则码。
5. 阈值在合理区间（段长 20..500、分数 0..150、句号密度 min ≤ max）。
6. 标题与视角正则必须可编译。

违反任一条 → `ENGINE_RULEPACK_INVALID`，插件拒绝启动。

## 五步流水线

`segment → density → quote → exemption → lexicon`

词表永远最后跑：一段格式已经崩坏的正文，先修格式再谈用词。

## 改词表

1. 编辑 `rulepacks/default.yaml`。
2. `pnpm build && pnpm validate:rulepack`。
3. 跑 `pnpm test`（golden 用例会指出行为变化）。

不要在代码里加 if：规则码与实现一对一，注册表拒绝重复注册。
