# dsh-novel-write-engine

把小说创作的「状态、门禁、规则、账本」从提示词搬进代码的 DeepSeek Harness 插件。

它不是一个提示词合集，也不是独立的写作软件。它把「这一章处于什么阶段、下一步只能做什么、正文是否达标、归档要核销哪些实体」变成可执行、可回滚、可审计的引擎；模型负责写，引擎负责裁决和记账。

> **当前版本：0.1.1** · 中文界面 · MIT
>
> **宿主范围**：DSH `>=0.2.1-rc.2 <0.3.0-0`；Node `>=24.9.0`。

---

## 目录

- [一、它解决什么问题](#一它解决什么问题)
- [二、功能全貌](#二功能全貌)
- [三、兼容性与前置条件](#三兼容性与前置条件)
- [四、先装好 DSH 宿主](#四先装好-dsh-宿主)
- [五、安装本插件](#五安装本插件)
- [六、验证安装](#六验证安装)
- [七、五分钟快速开始](#七五分钟快速开始)
- [八、使用方式](#八使用方式)
- [九、配置](#九配置)
- [十、数据、备份与状态](#十数据备份与状态)
- [十一、升级](#十一升级)
- [十二、卸载](#十二卸载)
- [十三、故障排查](#十三故障排查)
- [十四、安全与边界](#十四安全与边界)
- [十五、已知限制](#十五已知限制)
- [十六、开发与验证](#十六开发与验证)
- [十七、文档地图与许可](#十七文档地图与许可)

---

## 一、它解决什么问题

网文连载最常见的失败，不是「模型不会写」，而是：

- 写着写着忘了这是第几章、上一章结尾是什么、哪些伏笔还没回收；
- 每章的字数、格式、评分标准靠模型自己记，越写越松；
- 评审只给一个「87 分」，指不出扣分在哪一段，也无法核对；
- 归档时角色、地点、时间线、关系、伏笔只更新一半，下一章开始自相矛盾；
- 多个项目、多个会话之间状态漂移，换一个会话就像换了一个人。

本插件把这些东西收进一个 **单一写入口 `EngineService`**：

```text
模型 / 用户
   │
   ├── 18 个 novel_* 工具
   ├── 5 条 /novel* 命令
   ├── 只读侧边栏「网文工坊」
   └── 7 份阶段任务书（briefs）
          │
          ▼
     EngineService（唯一写入口）
          │
          ├── 12 条门控 PG-01 ~ PG-12
          ├── 15 维评分 / 满分 150
          ├── 规则包 rulepacks/default.yaml
          ├── 事务化归档 + journal 审计
          └── chapters/ 正文 + state/ 影子账本
```

**最重要的架构约束**：工具、命令、面板、任务书都不能直接读改写项目文件；所有写操作都经过 `EngineService`。正文 `chapters/chapter-NNN.md` 是唯一真实来源，`state/*.yaml` 是引擎维护的影子层，不允许反向手改。

### 它不是什么

- 不是独立的桌面写作应用，不能脱离 DSH 运行。
- 不是「装完就自动写完整本书」的生成器；它管流程、门禁和状态，正文仍由模型写。
- 不是独立 CLI；必须作为 DSH 插件安装到某个 profile 才能使用。
- 不提供云端同步、账号体系、在线书城或多人协作。
- 0.1.1 只有中文界面与中文任务书，没有 `locale/`，也不读取系统语言。

---

## 二、功能全貌

| 能力 | 说明 |
|---|---|
| 18 个 `novel_*` 工具 | 从建项目、领任务书、写初稿、评审、修订、校验、归档到导出、审计、回退 |
| 5 条 `/novel*` 命令 | 状态、下一步、统计、导出、隐藏操作；命令与工具共用同一套服务 |
| 1 个侧边栏面板「网文工坊」 | 只读；Hero、统计、九阶段轨、下一步卡、章节卡、门控区 |
| 1 个内置 Agent 预设「网文工坊」 | 18 个工具全开，**不挂载 bash / 文件写入工具**；会话开始后不能切换 |
| 1 个入口技能 | 告诉模型什么时候该用引擎、哪些写入口是唯一的 |
| 12 条门控 | 任务书、阶段、字数、格式、摘要、场景类型、评分、问题清零、阅读证明、一致性、轮次、归档原子性 |
| 15 维评分 | 满分 150，默认过关线 120；分数必须逐项可核对 |
| 事务化归档 | staging → 校验 → 备份 → pending journal → rename → 读回 → committed journal |
| 规则包外置 | 词表、格式、标点、语义、跨章阈值都在 `rulepacks/default.yaml`，代码只执行 |
| 三种导出 | Markdown、纯文本、EPUB 3；附 `cover.svg` 与 `blurb.txt` |
| 多项目注册表 | `stateDir/projects.yaml` 记录已知项目与当前项目；不影响项目目录 |
| 运行期依赖极少 | 只有 `yaml` 一个运行时依赖；不联网、不调用外部 API、不读环境变量里的密钥 |

### 关键设计

- **状态机而不是自由对话**：阶段只能按合法迁移前进；不合法操作返回 `ENGINE_STAGE_ORDER` 并告诉你当前可用操作。
- **门控先于写盘**：写初稿、修订、归档都是先校验、后落盘；坏稿不会进入项目。
- **评分是算术，不是感觉**：`total = 150 - Σdelta`，每个维度 `score = max - Σdelta`，不闭合就拒绝。
- **阅读证明**：P4/P5 要提交三段逐字引用，P6 会重新核验这份证明；开头/结尾按实际段落判定，防「没读就评」。
- **归档是一次事务**：P7 状态同步、P8 终审、P9 索引与交接不是三个可以半途而废的步骤。
- **模型不分配 ID**：只写 `key`，引擎分配 `FS-*` / `TE-*` / `RL-*` 等编号并回执映射。
- **可控修订**：`novel_amend` 是唯一的状态手工修改入口，必须带原因并写入 journal；`novel_rollback` 保留正文供参考。

### 九个阶段

| 阶段 | 名称 | 谁执行 | 产物 |
|---|---|---|---|
| P1 | 世界观约束 | 模型 | `plans/chNNN.world.yaml` |
| P2 | 章节计划 | 模型 | `plans/chNNN.chapter.yaml` |
| P3 | 初稿 | 模型 | `chapters/chapter-NNN.md` |
| P4 | 评审 | 模型 | `reviews/chNNN.review.yaml` |
| P5 | 修订 | 模型（有 blocker 时） | 覆盖正文 |
| P6 | 一致性校验 | 引擎机检 + 模型语义项 | `checks/chNNN.check.yaml` |
| P7 | 状态同步 | **引擎事务** | `state/*.yaml` |
| P8 | 终审 | **引擎事务** | 三端一致性报告 |
| P9 | 归档 | **引擎事务** | 章节索引 + 交接 |

P7/P8/P9 在 `novel_archive` 一次事务里完成。单章归档后状态是 `done`；下一章仍从 P1 开始。只有项目配置的 `total_chapters` 全部归档，面板才显示「全书完成」。

### 十二道门控

| 编号 | 名称 | 管什么 |
|---|---|---|
| PG-01 | `BRIEF_REQUIRED` | 当前阶段任务书已签发，digest 匹配 |
| PG-02 | `STAGE_ORDER` | 只能提交当前阶段允许的产物 |
| PG-03 | `WORD_COUNT` | 字数达到项目下限 |
| PG-04 | `FORMAT` | 段落、标点、Markdown、标题等格式 blocker 为零 |
| PG-05 | `SUMMARY_SCHEMA` | 十章摘要的十个字段齐全且类型正确 |
| PG-06 | `SCENE_TYPE` | 场景类型合法，节奏约束满足 |
| PG-07 | `SCORE` | 十五维齐全、算术闭合、总分达到 `minScore` |
| PG-08 | `ISSUES_CLEARED` | 所有 blocker issue 已修复并带正文证据 |
| PG-09 | `READING_PROOF` | 三段逐字引用能在正文对应位置找到；开头/结尾按实际段落判定 |
| PG-10 | `CONSISTENCY` | 伏笔、时间线、资源、关系、重复段落等跨章对账 |
| PG-11 | `ROUNDS` | 评审/修订、校验/修订均不超过 3 轮 |
| PG-12 | `ARCHIVE_ATOMIC` | 归档事务三端一致且读回验证通过 |

门控按固定顺序求值，并且**收集全部失败项**，不是遇到第一个就返回——这样模型可以一次改完。

### 十五维评分

| 组 | 维度 |
|---|---|
| A 核心叙事（90） | R-W-01 人设驱动 15 · R-W-02 情绪外化 10 · R-W-03 对话区分度 10 · R-W-04 爽点密度 20 · R-W-05 断章法则 15 · R-W-12 反文青病 20 |
| B 商业指标（45） | R-W-11 元描写与视角侵入 10 · R-W-13 信息增量 15 · R-W-14 钩子质量 10 · R-W-15 期待值兑现 10 |
| C 格式硬性（15） | R-W-06 段落长度 4 · R-W-07 去 AI 味 4 · R-W-08 硬性禁令 4 · R-W-09 字数 2 · R-W-10 标题 1 |

合计严格 150。默认 `minScore = 120`，可在配置里改；它是 PG-07 的唯一过关线。

### 类型与平台

- 类型（12）：玄幻修仙、都市现代、西方奇幻、悬疑推理、科幻、游戏系统、历史架空、无限流、轻小说、军事、末世流、言情。
- 平台（4）：`fanqie`（番茄）、`qidian`（起点）、`qimao`（七猫）、`jinjiang`（晋江）。

平台只决定规则包里的默认字数区间与对话比例；项目 `novel.yaml` 可以覆盖自己声明的那部分。

---

## 三、兼容性与前置条件

| 项目 | 要求 |
|---|---|
| DSH | `>=0.2.1-rc.2 <0.3.0-0`；由 `package.json` 的 `engines.dsh` 声明，安装与启动都会检查 |
| Node.js | `>=24.9.0` |
| pnpm | CLI 安装/卸载插件需要；建议 11.x（本仓库开发基线为 11.28.9） |
| 宿主形态 | Web（面板 + 预设）、Desktop（面板 + 预设，插件由桌面壳管理）、headless（只有工具/命令，无面板/预设） |
| 磁盘 | 项目根目录可写；默认 `stateDir` 可写 |
| 网络 | 安装时需要访问 npm / Git 托管；运行插件本身不联网 |
| 语言 | 0.1.1 仅中文 |

检查命令：

```bash
node --version       # 应 >= 24.9.0
dsh --version        # 应 >= 0.2.1-rc.2，且 < 0.3.0-0
pnpm --version       # CLI 安装插件时需要
```

如果 `dsh` 不在 PATH 里，可以用 `npx @deepseek-ai/dsh` 代替下文的 `dsh`。但 `dsh plugin` 仍然需要本机有 `pnpm`。

> 本仓库固定 pnpm 11.28.9。若本机版本不符，先执行 `corepack prepare pnpm@11.28.9 --activate`，或直接把下文的 `pnpm` 换成 `corepack pnpm`。

---

## 四、先装好 DSH 宿主

如果你已经在使用 DSH Web，并且 `dsh --version` 满足要求，可以直接跳到[第五节](#五安装本插件)。

### 方式 A：npx 直接运行（最快）

```bash
# 先确保有 pnpm，因为后面安装插件要用
corepack enable
corepack prepare pnpm@11.28.9 --activate

# 启动 Web UI；默认 http://127.0.0.1:3080
npx @deepseek-ai/dsh web
```

不想自动打开浏览器：

```bash
npx @deepseek-ai/dsh web --no-open
```

### 方式 B：全局安装 CLI

```bash
npm install -g @deepseek-ai/dsh
dsh web
```

升级：

```bash
npm update -g @deepseek-ai/dsh
```

### 方式 C：从源码运行

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
corepack pnpm install
corepack pnpm run build
corepack pnpm dsh web
```

### 方式 D：Desktop

从 DSH 官方发行页安装 Desktop。Desktop 使用自己保留的 `desktop` profile，插件应在 Desktop 的「插件」页安装，**不要**用 `dsh plugin --profile web` 去改装 Desktop——那是另一个 profile。

### DSH 的 profile 与 `DSH_HOME`

DSH 把不同应用形态放在 profile 里：

| 启动方式 | profile | 面板 | 内置预设 |
|---|---|---|---|
| `dsh web` | `web` | 有 | 有 |
| Desktop | `desktop` | 有 | 有 |
| `dsh headless` | `headless` | 无 | 无 |
| `dsh --profile <名字> web` | `<名字>` | 取决于该 profile | 取决于该 profile |

profile 默认位于：

```text
~/.dsh/profiles/<profile>/
```

Windows 为 `%USERPROFILE%\.dsh\profiles\<profile>\`。如果设置了 `DSH_HOME`，则以 `$DSH_HOME/profiles/<profile>/` 为准。

**结论**：插件必须装进你实际启动的那个 profile。装在 `web`、却用 `--profile myweb` 启动，是不会出现面板和预设的。

---

## 五、安装本插件

前置条件：DSH 已安装并满足版本要求，本机有 pnpm。

### 5.1 从 npm 安装（推荐）

```bash
corepack enable
corepack prepare pnpm@11.28.9 --activate

# 安装最新版到 web profile
dsh plugin --profile web add dsh-novel-write-engine
```

固定版本：

```bash
dsh plugin --profile web add dsh-novel-write-engine@0.1.1
```

`dsh` 不在 PATH 时，用 `npx @deepseek-ai/dsh` 代替命令开头的 `dsh`。

安装命令会下载 npm 包、写入 `~/.dsh/profiles/web` 的依赖，并把插件加入该 profile 的 `dsh.profile.bundles`。不要用 `npm install` 代替：它只会下载包，不会把插件加入 profile。

`web` 是 `dsh web` 使用的默认 profile。自定义 profile 把 `web` 换成实际名字；Desktop 使用自己的 `desktop` profile，请在桌面端插件页安装。

安装后重启 DSH，或刷新 Web 页面。

### 5.2 从源码目录安装（开发）

```bash
git clone https://github.com/ThzxxArt/dsh-novel-write-engine.git
cd dsh-novel-write-engine

corepack enable
corepack prepare pnpm@11.28.9 --activate
corepack pnpm install
corepack pnpm build

# 把当前目录装进 web profile
dsh plugin --profile web add "$PWD"
```

PowerShell：

```powershell
git clone https://github.com/ThzxxArt/dsh-novel-write-engine.git
cd dsh-novel-write-engine
corepack enable
corepack prepare pnpm@11.28.9 --activate
corepack pnpm install
corepack pnpm build
dsh plugin --profile web add (Get-Location).Path
```

源码目录安装是 **link** 关系，不是拷贝：profile 的 `dependencies` 里出现的是 `link:/你的/源码目录`。之后修改 `src/` 必须重新 `corepack pnpm build` 并重启 DSH；否则 DSH 仍加载旧的 `lib/`。

### 5.3 从 tarball 安装（离线）

在能构建的机器上：

```bash
git clone https://github.com/ThzxxArt/dsh-novel-write-engine.git
cd dsh-novel-write-engine
corepack pnpm install
corepack pnpm build
corepack pnpm pack
```

会得到类似：

```text
dsh-novel-write-engine-0.1.1.tgz
```

把这个 tarball 复制到目标机器，放在一个**稳定、不会随手删除**的路径，然后：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-novel-write-engine-0.1.1.tgz
```

tarball 安装不会运行源码构建，也不会要求 `allowBuilds`；包内已经包含 `lib/`、`rulepacks/`、`briefs/`、`skills/`、`presets/` 和两层 patch。它是最接近「发布产物」的安装方式。

升级时用新的 tarball 重装；旧的 tarball 可以留档，便于回滚。

### 5.4 从 DSH 插件页安装

适用于你不想在终端里操作，或者 DSH 跑在另一台机器上。插件页既能装 npm 包名，也能装本地目录或 tarball；路径必须是 **DSH 宿主** 能访问的路径。

1. 打开 DSH Web，左侧栏进入 **插件**。
2. 点 **添加插件**（或旁边的箭头 → **安装第三方插件**）。
3. 在包名字段填入以下任一形式：
   - npm 包名：`dsh-novel-write-engine`
   - 精确版本：`dsh-novel-write-engine@0.1.1`
   - 源码目录：`/absolute/path/to/dsh-novel-write-engine`
   - tarball：`/absolute/path/to/dsh-novel-write-engine-0.1.1.tgz`
4. npm 包名从 npm 官方源安装；本地目录和 tarball 直接使用宿主路径。
5. 点 **安装**，等待完成。
6. 如果出现 **立即启用**，点它；否则安装后到「已安装插件」里把 **dsh-novel-write-engine** 打开。
7. 刷新页面；新开一个会话。

> Desktop 的插件页管理的是 `desktop` profile，和 CLI 的 `web` profile 是两套依赖、两套锁文件。不要混用。

---

## 六、验证安装

按顺序做这四步，任何一步失败都能定位到不同层。

### 1. 看配置层

```bash
dsh --profile web --dump-config | grep -A8 '# == dsh-novel-write-engine'
```

有 `# == dsh-novel-write-engine` 说明 bundle 层已合成。没有则是装错 profile，或安装没有成功。

### 2. 看侧边栏

重启 DSH（或刷新页面）后，左侧栏应出现 **网文工坊**。

- 没有入口：当前不是 Web/Desktop profile，或 client bundle 没有加载。
- 入口在但页面 404/空白：检查 DSH 版本、浏览器缓存，重启后再试。

### 3. 看会话预设

新开一个会话，在预设选择器里应出现 **网文工坊**。

- 没有预设：你用的是 headless / acp / sdk profile，它们没有 `agentPresets` 服务；工具仍然可用。
- 有预设但选不了：看插件页是否已启用；看 DSH 版本是否满足范围。

### 4. 看工具与命令

在任意会话里输入：

```text
/novel
```

应返回状态卡或「还没有项目」的提示。也可以直接对模型说：

```text
列出你当前可用的 novel_* 工具。
```

应能看到 18 个（`toolsMode=core` 时只有 8 个，见[第八节](#八使用方式)）。

---

## 七、五分钟快速开始

### 1. 新开一个「网文工坊」会话

左侧栏 → 新建会话 → 预设选 **网文工坊**。

这个预设的工具是「小说专用」的：有 18 个 `novel_*` 工具、任务书、网页、待办、子智能体等，但**不挂载 bash / 文件写入工具**。正文只能经引擎写。

### 2. 直接说人话

例如：

```text
在 /home/me/novels/星海 开一本都市现代、番茄平台的书，
书名《星海旧梦》，作者是我，每章 2200–2800 字，共 120 章。
先做第一章的世界观约束和章节计划，不要一次写太多。
```

模型会调用 `novel_init` 建项目，然后按阶段领取任务书。

### 3. 等价的 `novel_init` 参数

如果你想自己确认字段：

```json
{
  "title": "星海旧梦",
  "genre": "都市现代",
  "platform": "fanqie",
  "author": "你的笔名",
  "description": "一句话简介",
  "words_per_chapter": [2200, 2800],
  "total_chapters": 120,
  "project_root": "/home/me/novels/星海"
}
```

`genre` 必须是 12 类之一，`platform` 必须是 `fanqie` / `qidian` / `qimao` / `jinjiang` 之一。`project_root` 省略时按「最近活跃项目 → 注册表 active → 配置里的 `projectRoot`（默认 `./novel`，相对于 DSH 进程工作目录）」解析；有多个项目时请显式传 `project_root`，避免写错书。

### 4. 一章的标准调用顺序

| 步骤 | 调用 | 说明 |
|---|---|---|
| 1 | `novel_brief P1` | 领取 P1 世界观任务书，签收 digest |
| 2 | `novel_plan_world` | 提交世界观约束 |
| 3 | `novel_brief P2` | 领取 P2 章节计划任务书 |
| 4 | `novel_plan_chapter` | 提交本章计划 |
| 5 | `novel_brief P3` | 领取 P3 初稿任务书 |
| 6 | `novel_write_draft` | 提交正文；格式/字数/摘要不过则整体拒绝 |
| 7 | `novel_brief P4` | 领取 P4 评审任务书 |
| 8 | `novel_review` | 十五维评分 + 三段阅读证明 |
| 9 | 有 blocker：`novel_brief P5` → `novel_revise` | 修订后回到 P4 重评 |
| 10 | 无 blocker：`novel_brief P6` → `novel_check` | 机检 + 四个语义项 |
| 11 | `novel_brief P8` | 领取终审任务书 |
| 12 | `novel_archive` | 必须带 `state_delta`，一次事务归档 |
| 13 | `novel_export md` | 或 `txt` / `epub` |

关键点：

- **每一步提交前都要先领任务书**，PG-01 会检查 digest。`novel_status` / `novel_pipeline` 在任务书缺失或过期时会先返回 `novel_brief`，不会让你直接撞 PG-01。
- `ready_to_archive` 在 P8 任务书当前后，`next.tool` 才返回 `novel_archive`；P5/P6 有阻塞时返回 `novel_revise`。
- `novel_review` 的 `total` 是必填的，必须等于 `150 - Σdelta`；三段阅读证明必须逐字来自正文，开头/结尾按**实际段落**判定。
- `novel_check` 的 `semantic` 恰好四个语义项，每项带至少 8 字、四条互不相同的正文引用。
- `novel_archive` 的 `state_delta` 要逐实体核销角色、伏笔、时间线、世界、关系；新伏笔标题必须出现在正文，`no_change` 也要写原因。
- 正文改动后，旧的评审分数和 check 会失效；不要试图手工改 `state/` 绕过。

### 5. 看面板

归档后打开左侧 **网文工坊**：

- Hero：书名、类型、平台、当前章、阶段；
- 统计：已归档章节、总字数、平均分、待处理门控；
- 九阶段轨；
- 下一步卡；
- 章节卡与门控区。

面板每 15 秒静默同步一次，也可以点刷新；它**只读**，所有写操作仍在对话/工具里。

---

## 八、使用方式

### 8.1 三种会话形态

| 形态 | 怎么进 | 工具 | 写文件能力 | 面板/预设 |
|---|---|---|---|---|
| 内置预设「网文工坊」 | 新会话选预设 | 18 个全开 | 不挂 bash/fs 写入工具，正文只经引擎 | 有 |
| 普通会话 | 任意标准会话 | 18 个工具在根层注册 | 可能还有 bash/fs；引擎保证会被绕过 | 有面板，无专用预设 |
| headless / 自动化 | `dsh --profile headless "..."` | 18 个（或 core 8 个） | 取决于该 profile | 无面板、无预设 |

**要用「引擎保证」就用「网文工坊」预设。** 普通会话里，模型仍然可以用文件工具直接改 `state/` 或正文；那时你得到的是「引擎工具 + 人工操作」的混合状态，事务、门控、审计都不再完整。

预设是会话类型，**会话开始后不能切换**。要换形态就新开一个会话。

### 8.2 18 个工具

| 工具 | 阶段 | 做什么 | 写盘 |
|---|---|---|---|
| `novel_init` | — | 建项目：`novel.yaml` + `state/` + 目录 | 是 |
| `novel_status` | 任意 | 当前活跃章、阶段、轮次、阻塞项、下一步；`chapter` 只用于字数查询 | 否 |
| `novel_brief` | P1–P6 / P8 | 领取当前活跃章的任务书，返回 `fields` 并记录 digest | 仅任务书签收 |
| `novel_plan_world` | P1 | 提交世界观约束 | 是 |
| `novel_plan_chapter` | P2 | 提交章节计划 | 是 |
| `novel_write_draft` | P3 | 提交初稿；格式/字数/摘要不过整体拒绝 | 是 |
| `novel_review` | P4 | 十五维评分、问题清单、三段阅读证明 | 是 |
| `novel_revise` | P5/P6 | 提交修订；blocker 必须有正文证据 | 是 |
| `novel_check` | P6 | 机检 + 四个语义一致性项 | 是 |
| `novel_archive` | P7–P9 | 事务归档；必须带 `state_delta` | 事务 |
| `novel_word_count` | 任意 | 按引擎唯一口径数字数 | 否 |
| `novel_state` | 任意 | 读账本、计划、评审、检查、handoff；`review`/`check` 可按历史章读取 | 否 |
| `novel_amend` | 任意 | 带原因修订一个状态文档 | 是，入 journal |
| `novel_rollback` | 任意 | 回退到 P1–P6，保留正文供参考 | 是 |
| `novel_diff` | 任意 | 与上次归档备份或两段文本比较 | 否 |
| `novel_export` | 任意 | 导出 `md` / `txt` / `epub` | 导出目录 |
| `novel_audit` | 任意 | 读追加式 journal 审计记录 | 否 |
| `novel_pipeline` | 任意 | 「下一步该做什么」的建议 | 否 |

工具失败时统一返回：

```text
[ENGINE_XXX] 说明 — 可操作建议
```

三类错误：

- **改参数**：`ENGINE_SCHEMA_INVALID`、`ENGINE_STAGE_ORDER`、`ENGINE_PROJECT_NOT_FOUND`、`ENGINE_PROJECT_EXISTS`；
- **改正文**：`ENGINE_GATE_BLOCKED`、`ENGINE_SCORE_MISMATCH`、`ENGINE_READING_PROOF_INVALID`、`ENGINE_DELTA_UNVERIFIED`；
- **查环境**：`ENGINE_SCHEMA_TOO_NEW`、`ENGINE_PATH_ESCAPE`、`ENGINE_LOCK_TIMEOUT`、`ENGINE_TXN_ABORTED`、`ENGINE_RULEPACK_INVALID`。

### 8.3 五条命令

注册的命令是 5 条：

| 命令 | 作用 |
|---|---|
| `/novel` | 不带参数 = 状态；`/novel status` 同义 |
| `/novel-next` | 下一步工具与理由 |
| `/novel-stats` | 章节数、总字数、平均分、未回收伏笔、规则包版本 |
| `/novel-export` | 导出 `md` / `txt` / `epub`，例如 `/novel-export epub` |
| `/novel-admin` | `/novel-admin <op> <json>` 执行隐藏/运维操作 |

`/novel` 还有子命令：

```text
/novel next
/novel stats
/novel export md|txt|epub
/novel admin
/novel admin novel_state {"kind":"pipeline"}
```

**`toolsMode=core` 时**只注册 8 个高频工具：

```text
novel_init, novel_status, novel_brief, novel_write_draft,
novel_review, novel_revise, novel_check, novel_archive
```

其余 10 个工具不消失，改走命令：

```text
/novel admin novel_plan_world {...}
/novel admin novel_plan_chapter {...}
/novel admin novel_word_count {"text":"..."}
/novel admin novel_state {"kind":"pipeline"}
/novel admin novel_amend {...}
/novel admin novel_rollback {...}
/novel admin novel_diff {...}
/novel admin novel_export {"kind":"md"}
/novel admin novel_audit {"limit":20}
/novel admin novel_pipeline
```

多项目注册表与设定包导入**只有命令入口**：

```text
/novel admin novel_registry_list
/novel admin novel_registry_register {"root":"/abs/book"}
/novel admin novel_registry_activate {"root":"/abs/book"}
/novel admin novel_registry_forget {"root":"/abs/book"}
/novel admin novel_import {"kind":"characters","content":{...},"dryRun":true}
/novel admin novel_import {"kind":"characters","content":{...},"dryRun":false}
```

`novel_import` 先预览 diff；`dryRun: true` 不写盘。`novel_registry_forget` 只删注册表行，**永远不删项目目录**。

### 8.4 侧边栏「网文工坊」

- 只读 HTTP 路由：`GET/HEAD /api/novel-write-engine/panel`；
- 精确路由，复用 connection 的认证/Origin 闸门；未认证返回 401/403，连接层缺席返回 503；
- 返回 `schemaVersion`；版本不一致时面板提示刷新；
- 状态：loading（骨架）、empty（显示 `novel_init`）、error（重试）、outdated（刷新）、ready；
- 章节超过 30 章时只渲染最近 30 张，并显示总记录数；
- 窄屏纵向堆叠，支持减少动态效果；
- 面板跟随**最近一次工具调用**的项目；冷启动时读注册表的 active，最后回退到配置的 `projectRoot`。

面板不是第二个写入口。它没有改名、归档、回退按钮。

### 8.5 导出

工具调用（由模型执行）：

```json
{ "kind": "md" }
{ "kind": "txt" }
{ "kind": "epub" }
{ "kind": "md", "chapter": 3 }
```

对话命令（全书）：

```text
/novel export md
/novel export txt
/novel export epub
/novel-export epub
```

输出：

```text
exports/
├── book.md / book.txt / book.epub        # 全书
├── book-ch001.md / .txt / .epub          # 单章
├── cover.svg
└── blurb.txt
```

- Markdown：`# 书名`、`## 第N章 标题`；
- 纯文本：无 Markdown 装饰，UTF-8 无 BOM；
- EPUB：EPUB 3，自写 ZIP 容器，`mimetype` 首条且 store 方式；
- 封面是纯 SVG 字符串，不依赖 canvas；平台简介由模板生成，不调用模型。

### 8.6 多项目

- `stateDir/projects.yaml` 记录已知项目与 active；
- 工具可用 `project_root` 覆盖当前项目；
- 面板跟随最近一次工具调用的项目；
- 切换 active：`/novel admin novel_registry_activate {"root":"/abs/book"}`；
- 删除注册行：`/novel admin novel_registry_forget {"root":"/abs/book"}`；项目文件不动。

---

## 九、配置

### 9.1 六个配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `projectRoot` | `./novel` | 默认项目根；相对路径相对于 DSH 进程工作目录。工具可用 `project_root` 覆盖 |
| `minScore` | `120` | PG-07 过关线，整数 0..150；唯一 owner |
| `toolsMode` | `all` | `all` 注册 18 个工具；`core` 只注册 8 个，其余走 `/novel admin` |
| `briefsOverrides` | 空 | 自定义任务书目录；某阶段文件缺失时回退包内 `briefs/<阶段>.md` |
| `backupRetention` | `5` | 保留的归档备份目录数；只清理引擎自己创建的 `backups/<txid>` |
| `stateDir` | 空 → `~/.dsh/novel-write-engine` | 多项目注册表位置；**不要放进项目目录** |

> `stateDir` 的默认值是代码按当前用户 home 拼出的 `~/.dsh/novel-write-engine`，不跟随 `DSH_HOME`。如果你改了 `DSH_HOME`，建议显式把它设成绝对路径。
>
> 非法值不会静默改写：`toolsMode` 不是 `all|core`、`minScore` 越界、`backupRetention < 1` 都会让插件拒绝启动。

### 9.2 在哪里改

不要改 `node_modules` 里的 `cordis.patch.yml`，也不要在项目目录里放「插件配置」。正确位置是**你启动的那个 profile 的用户 patch**：

```text
$DSH_HOME/profiles/<profile>/cordis.patch.yml
```

默认 Web：

```text
~/.dsh/profiles/web/cordis.patch.yml
```

在文件末尾追加（如果已经有同 `id` 的覆盖项，就改那一条，不要重复）：

```yaml
- id: novel-write-engine
  name: dsh-novel-write-engine
  config:
    projectRoot: /home/me/novels
    minScore: 125
    toolsMode: core
    briefsOverrides: /home/me/novel-briefs
    backupRetention: 10
    stateDir: /home/me/.dsh-novel-state
```

Windows 路径：

```yaml
- id: novel-write-engine
  name: dsh-novel-write-engine
  config:
    projectRoot: D:/novels
    minScore: 125
    toolsMode: all
    briefsOverrides: ""
    backupRetention: 5
    stateDir: C:/Users/you/.dsh/novel-write-engine
```

**patch 会替换整行 config**。因此：

- 你想保留默认值的键可以省略（schema 会填默认值）；
- 但不要把「只改一个键」理解成深合并；
- 最稳妥的写法是把你关心的键都写全；
- 改完重启 DSH（或让 HMR 重载），再新开会话验证。

### 9.3 任务书覆盖

`briefsOverrides` 指向一个目录，里面按阶段放：

```text
P1.md
P2.md
P3.md
P4.md
P5.md
P6.md
P8.md
```

某个文件不存在时，该阶段回退到包内 `briefs/` 的版本；不会因为缺一个文件而整体失效。任务书内容会参与 PG-01 的 digest，改任务书等于改门控输入，最好在开新书前确定。

### 9.4 规则包不能运行期切换

`rulepacks/default.yaml` 是随包加载的：词表、格式、标点、语义、跨章阈值、平台默认值都在里面。0.1.1 **不接受**运行期外部规则包路径。

要改规则，只有两条路：

1. 改源码里的 `rulepacks/default.yaml`，重新 `corepack pnpm build`；源码目录安装重启即可，tarball 分发则重新打包/安装；
2. 等后续版本提供正式的规则包覆盖机制。

改规则后至少跑：

```bash
corepack pnpm build
corepack pnpm validate:rulepack
corepack pnpm test
```

规则包编译器会检查十五维合计 150、词条唯一 owner、互斥/豁免引用真实规则码、阈值区间、正则可编译；不合法会 `ENGINE_RULEPACK_INVALID`，插件拒绝启动。

---

## 十、数据、备份与状态

### 10.1 项目布局

```text
<projectRoot>/
├── novel.yaml                    # 项目定义（书名、类型、平台、目标）
├── outline/                      # 卷/幕/章规划
├── chapters/chapter-001.md       # 正文（唯一 SSOT）
├── plans/chNNN.world.yaml        # P1
├── plans/chNNN.chapter.yaml      # P2
├── reviews/chNNN.review.yaml     # P4
├── checks/chNNN.check.yaml       # P6
├── state/
│   ├── pipeline.yaml             # 控制流 SSOT
│   ├── chapters.yaml             # 章节索引
│   ├── characters.yaml
│   ├── world.yaml
│   ├── locks.yaml
│   ├── timeline.yaml
│   ├── foreshadows.yaml
│   ├── relationships.yaml
│   ├── handoff.yaml
│   └── journal.jsonl             # 追加式事务日志
├── backups/<txid>/               # 归档前快照
├── exports/                      # 导出产物
└── .engine.lock                  # 写锁（pid + 时间戳）
```

- 所有 YAML 顶层都有 `schema_version`；未知顶层键拒绝加载。
- `schema_version > 1` 会被拒绝（`ENGINE_SCHEMA_TOO_NEW`），防止旧版静默破坏新数据。
- `state/` 是影子层，只有引擎能写；不要把 `state/chapters.yaml` 当成正文来源。
- `journal.jsonl` 是追加式审计；`novel_audit` 读它。
- 备份只清理引擎自己创建的 `backups/<txid>`；你自己放进 `backups/` 的文件不会被删。

### 10.2 多项目注册表

默认：

```text
~/.dsh/novel-write-engine/projects.yaml
```

只记录项目路径、标题、active；**不保存正文**。删掉它不会删任何书。面板在冷启动时用它找 active 项目。

### 10.3 手工修改的边界

- 正文可以读，但不建议手改；正文一改，评审分数、check、content hash 都会失效。
- `state/` 不要手改；要改就用 `novel_amend`，它要求 `reason` 并写入 journal。
- 要回退阶段用 `novel_rollback`；它会保留正文为参考，清空任务书签收与轮次。
- 不要在引擎运行时删 `.engine.lock`；锁由引擎回收，手删可能让两个写者同时进入。

### 10.4 备份与恢复

- 归档等事务会生成 `backups/<txid>/`；
- `backupRetention` 控制保留数量，默认 5；
- 事务日志会记录 pending/committed；崩溃后引擎按 journal 恢复或拒绝半迁移；
- 要手动保底，最稳妥的是在升级前复制整个项目目录，或在 DSH 外做文件快照。

---

## 十一、升级

### 11.1 升级前

1. 看 [CHANGELOG.md](CHANGELOG.md) 和 DSH 的版本要求；
2. 确认 `dsh --version` 仍满足插件 `engines.dsh`；
3. 复制一份项目目录（或至少确认 `backups/` 完整）；
4. 升级后新开会话验证，不要指望旧会话立刻换工具定义。

### 11.2 从 npm 升级（正式分发，推荐）

```bash
# 在目标 profile 里升级到最新版
dsh plugin --profile web remove dsh-novel-write-engine
dsh plugin --profile web add dsh-novel-write-engine@latest
```

也可以固定版本：

```bash
dsh plugin --profile web add dsh-novel-write-engine@0.1.1
```

升级后核对：

```bash
dsh --profile web --dump-config | grep -A6 '# == dsh-novel-write-engine'
```

> profile 的依赖由 pnpm 管理。不要在 `~/.dsh/profiles/web` 里直接 `npm update` 或手改 `package.json`/锁文件；那会绕开 `dsh.profile.bundles` 的激活逻辑，出现“包装了但插件没启用”。统一用 `dsh plugin remove` + `add`，或在插件页点 **更新**。

### 11.3 从源码目录升级

```bash
cd /path/to/dsh-novel-write-engine
git pull

corepack enable
corepack prepare pnpm@11.28.9 --activate
corepack pnpm install
corepack pnpm build

# 先移除旧链接，再装新目录（同一路径时，remove + add 最干净）
dsh plugin --profile web remove dsh-novel-write-engine
dsh plugin --profile web add "$PWD"
```

然后重启 DSH，或刷新 Web 页面并新开会话。

### 11.4 从 tarball 升级

先构建新 tarball：

```bash
corepack pnpm build
corepack pnpm pack
```

再：

```bash
dsh plugin --profile web remove dsh-novel-write-engine
dsh plugin --profile web add /absolute/path/to/dsh-novel-write-engine-0.1.1.tgz
```

### 11.5 在 Web / Desktop 里升级

从 npm 安装的 bundle 会在插件页出现 **版本** 区块和 **更新** 按钮；源码目录（`link:`）和 tarball（`file:`）不属于这一类，页面不会给「更新」。两种路径分别是：

**npm 安装：**

1. 插件页 → 打开 `dsh-novel-write-engine`；
2. 点 **更新到 x.y.z**；
3. 刷新页面，新开会话。

**源码目录 / tarball：**

1. 插件页 → 打开 `dsh-novel-write-engine` → **卸载**；
2. **添加插件** → 填新的目录或 tarball → 安装 → 启用；
3. 刷新页面，新开会话。

插件页更新底层仍然是「移除旧版本 → 安装新版本 → 失败则恢复旧版本」。

### 11.6 升级配置会保留吗

用户配置写在 profile 的 `cordis.patch.yml`，不在包内。`remove`/`add` 不会删除它；只要新版本仍然使用 `id: novel-write-engine`，覆盖项继续生效。

升级后仍建议检查：

```bash
dsh --profile web --dump-config | grep -A8 '# == dsh-novel-write-engine'
```

### 11.7 升级 DSH 本身

- `npx`：每次运行可加 `@latest`，例如 `npx @deepseek-ai/dsh@latest web`；
- 全局：`npm update -g @deepseek-ai/dsh`；
- 源码：`git pull && corepack pnpm install && corepack pnpm run build`；
- Desktop：用官方安装包或应用内更新。

DSH 升级后如果 `engines.dsh` 不再匹配，插件会被拒绝。此时升级插件，或把 DSH 降到兼容版本；不要用「改 package.json 绕过」当长期方案。

---

## 十二、卸载

### 12.1 在 Web / Desktop 卸载

1. 左侧栏 → **插件**；
2. 打开 **dsh-novel-write-engine**；
3. 点 **卸载**，确认；
4. 刷新页面；
5. 新开会话确认 `novel_*` 工具与「网文工坊」预设消失。

### 12.2 用 CLI 卸载

建议先停止 DSH（尤其是没有 HMR 的 profile）：

```bash
dsh plugin --profile web remove dsh-novel-write-engine
```

如果 DSH 正在运行且 profile 支持 HMR，也可以在运行时移除；以插件页/CLI 的提示为准。若提示当前 profile 正在使用该包，停止 DSH 后重试。

> `dsh plugin remove` 只从 profile 移除插件层，不会删除你的小说项目、`stateDir` 注册表或备份。

卸载会：

- 从 profile 的 `dsh.profile.bundles` 移除该层；
- 从 `dependencies` 移除包；
- 停止并卸载它的 Host 行与 client 面板；
- **不会**删除你的小说项目、`stateDir` 注册表或备份。

### 12.3 清理配置覆盖

如果你在 profile 的 `cordis.patch.yml` 里加过：

```yaml
- id: novel-write-engine
  name: dsh-novel-write-engine
  config: ...
```

卸载后把这一段删掉。否则它会成为一个指向不存在行的用户 patch；不同 DSH 版本对这种情况的提示可能不同，清掉最干净。

### 12.4 清理数据（可选）

卸载插件不会删书。确认不再需要后，再手动清理：

```bash
# 多项目注册表（只影响「最近项目」提示，不影响书）
rm -rf "$HOME/.dsh/novel-write-engine"

# 某个项目（先确认路径！）
rm -rf "/absolute/path/to/your/novel-project"
```

Windows PowerShell：

```powershell
Remove-Item -Recurse -Force "$HOME\.dsh\novel-write-engine"
Remove-Item -Recurse -Force "D:\novels\your-book"
```

**不要**为了卸载本插件去删整个 `~/.dsh`：那里还有 DSH 的配置、凭据、会话和其他插件。

### 12.5 验证卸载

```bash
dsh --profile web --dump-config | grep dsh-novel-write-engine
# 应无输出
```

新开会话：面板入口消失，预设列表里没有「网文工坊」，`/novel` 不再被识别。

---

## 十三、故障排查

| 现象 | 最可能的原因 | 处理 |
|---|---|---|
| `dsh plugin add` 404 / 找不到包 | 包名拼错、registry 不可达，或镜像尚未同步 | 确认 `npm view dsh-novel-write-engine version`；必要时切回官方 registry |
| `npm install` 成功但 DSH 没有插件 | `npm install` 不会把插件加入 profile | 执行 `dsh plugin --profile web add dsh-novel-write-engine`，见 5.1 |
| `dsh: command not found` | CLI 未全局安装 | 用 `npx @deepseek-ai/dsh ...`，或先 `npm i -g @deepseek-ai/dsh` |
| `dsh plugin` 报找不到 pnpm | 只装了 DSH，没装 pnpm | `corepack enable && corepack prepare pnpm@11.28.9 --activate` |
| `--dump-config` 没有插件层 | 装到了别的 profile | 用实际启动的 profile 重装；`dsh --profile <name> ...` |
| 插件页显示已安装但开关打不开 | 包不完整/版本不兼容/被更高层覆盖 | 看插件页诊断；用 tarball 重装；检查 `engines.dsh` |
| 侧边栏没有「网文工坊」 | 不是 Web/Desktop profile，或 client bundle 未加载 | 用 `dsh web` / Desktop；刷新；重启 |
| 预设列表没有「网文工坊」 | headless/acp/sdk 没有 `agentPresets`，或插件未启用 | 改用 Web；插件页启用；新开会话 |
| 会话里没有 `novel_*` 工具 | 插件未启用、旧会话未刷新、装错 profile | 新开会话；重启；`--dump-config` 核对 |
| `ENGINE_STAGE_ORDER` | 跳过了阶段或顺序不对 | `/novel` / `novel_status` 看下一步；按 `novel_brief` 领任务书 |
| `ENGINE_GATE_BLOCKED` | 门控未过 | 看 `blocking` 的 code/detail/hint；改正文或补证据；不要手改 state |
| `ENGINE_PROJECT_NOT_FOUND` | 项目根不对/未初始化 | `novel_init`，或传正确的 `project_root` |
| 面板空白/显示没有项目 | 当前没有项目，或 active 指向旧路径 | 先 `novel_init`；`/novel admin novel_registry_activate` 切到正确项目 |
| 面板显示「需要刷新」 | 浏览器缓存了旧 client bundle | 刷新页面；重启 DSH |
| 升级后仍是旧行为 | 源码目录没 `corepack pnpm build`，或旧会话未换 | 重新构建；重启；新开会话 |
| 卸载后配置项还在 | profile 的 `cordis.patch.yml` 还留着覆盖 | 删除 `id: novel-write-engine` 的段落 |
| `EACCES` / 写入失败 | 项目根或 `stateDir` 对 DSH 进程不可写 | 改权限，或换可写路径 |

### 仍然卡住时，提供这四样信息

1. `dsh --version` 与 `node --version`；
2. `dsh --profile <name> --dump-config` 里插件层那一段；
3. 插件页的版本/诊断，或 `dsh plugin --profile <name> list` 的输出；
4. 具体报错的 `[ENGINE_*]` 代码与完整 hint。

不要贴出 API Key、Token、密码或完整正文。

---

## 十四、安全与边界

### 14.1 它在宿主进程里运行

DSH bundle 的 Host 半边在 DSH 进程内执行，不受工作区沙箱限制。安装本插件等于允许它在 DSH 进程权限下读写你给它的项目目录和 `stateDir`。只从你信任的 npm 包、源码或 tarball 安装。

### 14.2 它不联网

插件本身没有 `fetch`、HTTP 客户端或遥测；运行期依赖只有 `yaml`。它不读取环境变量里的 API Key，也不会把正文发到任何服务。模型调用本身由 DSH 负责，与本插件无关。

### 14.3 面板是只读的

`/api/novel-write-engine/panel` 只接受 `GET`/`HEAD`，并复用 DSH connection 的认证与 Origin 校验。它不能改项目；所有写操作仍然要经过工具/命令。

### 14.4 状态文件不是「随便改的 YAML」

`state/` 是引擎的影子层。手改会让 journal 哈希对账失败，后续事务可能拒绝执行。要改状态，用 `novel_amend` 并写原因；要回退，用 `novel_rollback`。

### 14.5 备份不是万能的

`backups/` 保留的是引擎事务快照，不是外部备份。磁盘损坏、误删整目录、手动 `rm -rf` 都不在它的保护范围。重要书稿请另做文件级备份。

### 14.6 安装来源

- 优先从 npm 官方 registry 安装，并核对包名、发布者与版本；离线环境可用你自己构建的 tarball，并记录 SHA-256；
- 不要从聊天记录里复制来路不明的 Git 地址并给 `allowBuilds` 授权；
- `allowBuilds` 等于允许包在安装时以你的用户权限执行脚本。

---

## 十五、已知限制

- **0.1.1 只有中文**：面板、命令、错误、任务书都是中文；没有 `locale/`，不跟随系统语言。
- **通过 npm 分发**：安装与升级统一使用 `dsh plugin add`；源码目录和 tarball 用于开发或离线环境。
- **面板与预设只在 Web/Desktop**：headless / acp / sdk 没有 `agentPresets` 服务，也没有浏览器面板；18 个工具仍可用。
- **规则包不可运行期替换**：要改词表/阈值，必须改源码、重新构建、重新安装。
- **普通会话可能绕过引擎**：只有「网文工坊」预设不挂 bash/fs 写工具；在普通会话里手动改文件，事务与门控保证不再完整。
- **预设会话开始后不能切换**。
- **单章轮次上限 3**：超过需要 `novel_rollback`，不是无限重试。
- **面板只读**：没有在面板里直接改正文/归档的按钮。
- **DSH 仍是 developer preview**：`0.3.0` 之前可能有破坏性变更；升级 DSH 前先看插件 `engines.dsh`。
- **没有云同步/多人协作/在线书城**：数据都在本机项目目录与 `stateDir`。

---

## 十六、开发与验证

### 16.1 环境

```bash
corepack enable
corepack prepare pnpm@11.28.9 --activate
corepack pnpm install
```

### 16.2 常用命令

```bash
corepack pnpm typecheck          # host + client 类型检查
corepack pnpm test               # 单元 + 集成 + e2e
corepack pnpm test:coverage      # 覆盖率 + 分层门禁
corepack pnpm build              # host → client → client d.ts
corepack pnpm test:isolated      # 每个源文件独立编译
corepack pnpm validate:rulepack  # 需先 build
corepack pnpm check:artifacts    # 真正 import 构建后的 host / client
corepack pnpm check:hygiene      # v8 ignore 预算 + 假断言扫描
corepack pnpm check:pack         # 需先 build；检查 tarball 内容
corepack pnpm check:install      # 需先 build；空项目安装并加载
corepack pnpm check:host         # 需本机 dsh；真实 Web 宿主安装/面板/卸载
```

预设层需要真实 DSH checkout：

```bash
DSH_BUNDLE_ROOT=/path/to/deepseek-harness/packages/bundle/web-app corepack pnpm check:preset
```

`check:preset` 不伪造 bundle root；没有宿主 checkout 时它不会假装通过。

`check:host` 使用临时 `DSH_HOME` 与临时 profile：`npm pack → dsh plugin add → --dump-config → 启动 Web → 面板 401/200 → 卸载 → 确认层消失`。它需要 PATH 里有 `dsh`（或设置 `DSH_BIN`），不会碰你的真实 profile；没有 DSH 时以退出码 2 明确失败，不伪造通过。

### 16.3 发布前手动验证

1. `corepack pnpm build && corepack pnpm pack`；
2. 在临时 DSH home 里 `dsh plugin --profile web add <tarball>`；
3. `--dump-config` 确认插件层；
4. 启动 Web，确认面板、预设、18 个工具、`/novel`；
5. 跑一遍 `novel_init → P1 → … → archive → export`；
6. `dsh plugin remove`，确认层与面板消失；
7. 确认项目数据未被卸载动作删除。

`pnpm check:host` 覆盖第 1–4 与第 6 步的自动断言；第 5 步仍是人工全流程（需要可用模型）。

### 16.4 项目结构

```text
src/
├── domain/       # 字数、评分、迁移、SimHash、文本
├── rules/        # 规则编译器、注册表、检测流水线
├── store/        # FsStore、事务、锁、journal、迁移、注册表
├── engine/       # EngineService、门控、任务书、投影
├── tools/        # 18 个工具适配器
├── commands/     # 5 条命令 + admin
├── client/       # 侧边栏面板
├── remote/       # 只读 panel 路由
├── export/       # Markdown / TXT / EPUB
└── skills/       # 入口技能
briefs/           # P1/P2/P3/P4/P5/P6/P8 任务书
rulepacks/        # default.yaml
presets/          # 内置 Agent 预设 patch
tests/            # 单测、集成、falsify、e2e
```

### 16.5 当前验证基线

0.1.1 在 Node 24.19 / DSH 0.2.1-rc.3 上完成过：

- `corepack pnpm test` 全绿（当前树 348 项）；
- 覆盖率语句/分支/函数/行均达到门槛；
- `typecheck`、`lint`、`check:hygiene`、`test:isolated`、`build`、`validate:rulepack`、`check:pack`、`check:artifacts`、`check:install` 全绿；
- `check:host` 在临时 DSH profile 中实测：插件层出现、预设可见、面板未认证 401、认证后 200、`remove` 后层消失。

具体数字会随代码变化；发布前请以重新跑出的结果为准，不要把上面的历史数字当保证。

---

## 十七、文档地图与许可

| 文档 | 内容 |
|---|---|
| [DESIGN.md](DESIGN.md) | 完整设计书：架构、数据模型、规则、门控、事务、面板、预设 |
| [PLAN.md](PLAN.md) | 0.1.0 实施计划（历史） |
| [docs/0.1.1-plan.md](docs/0.1.1-plan.md) | 0.1.1 契约收口与证据加固方案 |
| [docs/tools.md](docs/tools.md) | 18 个工具与命令面速查 |
| [docs/states.md](docs/states.md) | 状态机、迁移表、轮次与回退 |
| [docs/rulepack.md](docs/rulepack.md) | 规则包结构、编译器断言、改词表流程 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |
| [LICENSE](LICENSE) | MIT |

### 反馈

- 仓库：<https://github.com/ThzxxArt/dsh-novel-write-engine>
- 问题：请附 DSH/Node 版本、安装方式、`--dump-config` 片段、完整 `[ENGINE_*]` 错误与 hint。
- 不要提交真实 Token、密码、未公开书稿或含个人信息的项目文件。

### 许可

MIT。见 [LICENSE](LICENSE)。
