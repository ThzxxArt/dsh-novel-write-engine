# 真实模型全链路记录：agnes-2.5-flash

> 运行时间：2026-11-23 15:47（Asia/Shanghai）
> 引擎：工作区 `0.2.19` 源码构建的 `lib/index.js`（未提交版本）
> 端点：`https://apihub.agnes-ai.com/v1/chat/completions`，OpenAI 兼容，`response_format: json_object`
> 密钥：只经环境变量注入，未写入仓库、配置或日志

## 1. 结果

| 项 | 值 |
| --- | --- |
| 结论 | **完整一章被接受**：P1 → P2 → P3 → P4 → P6 → P8 归档 → 导出 |
| 项目 | `实时验收之书 agnes-2.5-flash`（临时目录，跑完即删） |
| 正文 | 208 个汉字 / 4 段 / 229 计词 |
| 评审 | 150 分（引擎实算），格式五维 `R-W-06…10` 全部 `declared = effective`，无扣分 |
| 校验 | `verdict = pass`，`stage = ready_to_archive` |
| 自查清单 | √10 · ×1 · —2（有一条模型自己判 fail，引擎保留，未改判） |
| 归档 | `assigned_ids.timeline:0 = TE-001`，`stage = done`，`chapter = 2`，`blocking = 0` |
| 导出 | `exports/book.md`、`exports/cover.svg`、`exports/blurb.txt` |

## 2. 这一跑里引擎/驱动各拦了什么

| 阶段 | 结果 | 说明 |
| --- | --- | --- |
| P1 | accepted | 第一次提交即通过 |
| P2 | accepted | 第一次提交即通过 |
| P3 | accepted | 第一次提交即通过（208 汉字，落在项目声明的 150–320 计词区间） |
| P4 | accepted | 第一次提交即通过，`total = 150` 由引擎实算 |
| P6 | rejected ×2 + transport ×1 | 模型两次用自由文本当 `evidence`，驱动的本地检查拒绝（引擎要求逐字引用）；一次请求超时 |
| P6 | accepted | 改用句库编号后通过 |
| P8 | accepted | 第一次提交即通过；`timeline` 缺事件行，由驱动按 `summary.events` 补 `{action:"created"}` |

这一跑**没有**触发引擎的规则拒绝（`ENGINE_*`）：模型在第一次提交时格式就合规。开发过程中同一个模型被引擎拒绝过的形态另记在验收文档 §9.3。

## 3. 正文（模型原文，未改写）

老陈推开那扇生锈的铁门时，灰尘正从门缝里涌出来。桌上那只旧信封静静躺着，没有署名，右下角的日期栏被涂掉了一半。

他伸手拿起来，指尖触到信封表面有些发潮。里面滑出一张折叠的纸片和一张照片。照片上是三个年轻人站在废墟前，领口别着一枚徽章。

老陈把照片举到窗前，阳光穿透相纸背面，映出一行小字：灰烬里没有答案，只有下一个路口。他把照片翻回来，目光落回桌上的信封。

墙角挂钟响了六下，他忽然注意到信封内侧夹着半截火柴梗。火柴头上还带着一点暗红色的磷粉，像是被人反复摩挲过。

## 4. 章末摘要（模型输出，经引擎校验）

```json
{
  "events": ["发现旧信封与线索"],
  "characters_appeared": ["老陈"],
  "foreshadows": { "planted": [], "advanced": [], "resolved": [] },
  "new_elements": { "locations": [], "abilities": [], "artifacts": [] },
  "resource_changes": [],
  "opening": "老陈推开那扇生锈的铁门时，灰尘正从门缝里涌出来。",
  "continuity": { "opens_from": "承接上一章结尾的悬念", "ends_with": "发现带火柴梗的信封" },
  "hook_strength": 4,
  "pleasure_points": ["关键物证出现"],
  "plot_advancement": "mid"
}
```

## 5. 驱动做了什么、没做什么

驱动（一次性脚本，不入库）只负责跑真实任务书、把引擎的拒绝原样回灌给模型、把模型的答案提交给引擎。

- **没有**改写模型的正文、摘要或评审。
- **披露**：`timeline` 缺行时按 `summary.events` 补 `{action:"created"}`；这是账本必填项，不是内容创作。
- **披露**：评审的五个格式维度由引擎给分，驱动提交前把那五维的 `deductions` 清空（引擎本来也会覆盖）。
- **披露**：驱动本地拒绝过两次「用自由文本当语义证据」，原因是引擎要求逐字引用；改为从引擎正文里抽出的句库编号后，模型的选择仍然是模型自己的判断。
- P4 的三条 reading proof 由驱动指定段号（第 1 / 中间 / 最后一段），句子仍由模型从正文里挑选。
