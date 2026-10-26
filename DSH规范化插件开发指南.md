# DSH 规范化插件开发指南

> **适用对象**：拿到本文件后需要独立为 DeepSeek Harness（下称 DSH）开发、调试、发布插件的工程师或 AI Agent。
> **文档性质**：可执行规范 + 完整案例库 + 参考手册。凡标「已验证」的代码与命令，均在 `dsh 0.2.1-rc.3`（npm 发布包）上跑通过；未验证处会显式标注「未验证/社区经验」。
> **核验时间**：2026-10-26（Asia/Shanghai）。
> **基线版本**：DSH `0.2.1-rc.3`、`@deepseek-ai/cordis` `4.0.5`、`@deepseek-ai/schemastery` `3.18.5`、Node.js `>= 24.9.0`、tsdown `0.22.14`。
> **本文档的验证强度**：第二部分的 10 个完整模块**逐个单独编译**（不是聚合编译）；工程模板另经 `tsdown` 构建、`npm pack --dry-run`、`dsh plugin add` / `--dump-config` / `remove` 全链路验证；客户端半边经 `node --check` 与真实 bundle 格式核验。

**目录**

| 章节 | 内容 | 什么时候读 |
|---|---|---|
| §0 | 先读这一页（心智模型、任务分流、最小代码） | **必读** |
| §1 | 概念模型：插件/Fiber/Effect/Service/Bundle/Profile/Patch | 设计前 |
| §2 | 版本与环境基线、版本漂移 | 建项目时 |
| §3 | 项目骨架（package.json / tsconfig / tsdown / patch） | 抄代码时 |
| §4 | 插件本体契约（三种形态、apply 纪律、HMR） | 写第一个插件时 |
| §5 | 配置 schema、volatile、优先级 | 需要配置项时 |
| §6 | 工具开发（参数/规范值/渲染/取消/并发/UI/PTC） | **核心** |
| §7 | 服务、事件、执行流水线策略、斜杠命令 | 做集成时 |
| §8 | 后台任务 | 长任务时 |
| §9 | Web 客户端半边（bundle 格式、slots、设置卡） | 要改 UI 时 |
| §10 | 打包、发布、安装、层顺序 | 交付前 |
| §11 | 调试与测试、故障对照表 | 出问题时 |
| §12 | 规范化清单 | 提交前**必须**过 |
| §13 | 反模式清单 | 评审时 |
| §14 | 速查索引 + 本指南验证记录 | 随时 |
| **第二部分** | **完整案例库（9 个可直接落地的完整工程 + 6 个配方）** | **动手时先看这里** |
| §14.5–14.6 | 最小工具插件全文、术语中英对照 | 落地时 |
| 附录 A | 任务 → 案例对照表 | 查表时 |

---

## 0. 先读这一页

### 0.1 三十秒心智模型

```
插件 = 一个导出 apply(ctx, config) 的 ES 模块
bundle = 一个带 dsh.bundle.patch 的 npm 包（把插件行注入配置层）
profile = $DSH_HOME/profiles/<name>/ 下的启动组合（列出要装哪些 bundle）
patch = YAML 数组，按行 insert / 覆盖配置
Fiber = 一个插件实例的生命周期作用域
Effect = 一切注册的可回收句柄
```

一句话：**你写的是插件模块，交付的是 bundle 包，用户装进 profile 后启动。**

### 0.2 任务分流表（先判断你要做哪种插件）

| 你想做的事 | 需要写的东西 | 关键 API | 见章节 |
|---|---|---|---|
| 给模型加一个能力 | 工具插件 | `ctx.tools.register(defineTool(...))` | §6 |
| 拦截/审计/改写模型调用 | 策略插件 | `tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/result` | §7.5 |
| 复用别人的能力 | 消费型插件 | `inject` + `ctx.<service>` | §7.1 |
| 对外提供能力 | 服务型插件 | `class X extends Service` + 声明合并 | §7.2 |
| 加斜杠命令 | 命令插件 | `ctx.commands` | §7.6 |
| 长任务/后台跑 | 后台任务工具 | `ctx.jobs.start(...)` + `run_in_background` | §8 |
| 改 Web UI | 客户端半边 | `dsh.client` + `slots` | §9 |
| 只调配置 | 配置 schema | `Config` + Schemastery | §5 |

### 0.3 最小可运行代码（已验证）

```ts
// src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-hello-plugin'
export const inject = ['tools']

export interface Config { greeting: string }
export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
})

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: { name: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, text) => [{ type: 'text', text }],
    },
    async execute(args) { return `${config.greeting}, ${args.name}!` },
  }))
}
```

配套 `package.json` 三处不能少（缺一则 install 后不生效）：

```jsonc
{
  "name": "dsh-hello-plugin",
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": { ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" } },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }   // ← 关键：没有它只装成普通依赖
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: hello-plugin
      name: dsh-hello-plugin
```

---

## 1. 概念模型（决定你 80% 的设计选择）

### 1.1 七个名词，一次说清

| 名词 | 是什么 | 谁拥有 | 常见误解 |
|---|---|---|---|
| **插件（plugin）** | 导出 `apply` 的模块；也可 export `name`/`inject`/`Config` | 你 | 以为插件必须是个包 —— 本地 `.ts` 文件就能当插件跑 |
| **Fiber** | 插件实例的作用域与生命周期状态机 | Cordis | 以为 `apply` 只跑一次 —— 依赖变化会卸载重载 |
| **Effect** | 通过 `ctx` 注册的资源句柄，卸载自动回收 | Cordis | 以为要手动 `removeListener` —— 不需要 |
| **服务（service）** | 挂在 `ctx` 上的命名能力（`ctx.tools`/`ctx.llm`/`ctx.web`…） | 提供方插件 | 以为服务是 import 的 —— 是注入的 |
| **bundle（组合包）** | 带 `dsh.bundle.patch` 的 npm 包，贡献一个配置层 | 你（发布方） | 以为 npm 包自动是插件 —— 必须声明 `dsh.bundle` |
| **profile** | `$DSH_HOME/profiles/<name>/`，有序 bundle 列表 + 用户 patch | 用户 | 以为 profile 也是包 —— 没有东西同时是两者 |
| **patch** | YAML 数组，按行 `insert`/覆盖 loader 配置 | 各层作者 | 以为 config 是深合并 —— **整行 config 被替换** |

### 1.2 Fiber 状态机

```
PENDING → LOADING → ACTIVE
                 ↘ FAILED
ACTIVE → UNLOADING → DISPOSED
```

对你的实际影响：

- **`inject` 声明的服务没就绪 → 插件停在 PENDING，`apply` 不执行。** 不是报错，是等待。
- **依赖服务消失（提供方被卸载/替换）→ 你的插件被自动 dispose。** 服务回来后重新 `apply`。
- **`apply` 抛异常 → FAILED。** 启动期会让 boot 审计变红；稳态下只是一条告警。
- **`apply` 里不要做长耗时同步 IO**，它阻塞整个加载链。

### 1.3 自动清理：唯一的资源纪律

```ts
export function apply(ctx: Context) {
  ctx.on('tools/result', h)              // 卸载自动移除
  ctx.tools.register(tool)               // 卸载自动注销
  ctx.effect(() => {                     // 任意外部资源
    const ws = new WebSocket(url)
    return () => ws.close()
  }, 'my-plugin: websocket')             // 第二参数是 label，出问题时能定位
}
```

规则细节（容易踩）：

1. Dispose 按注册**逆序**开始，但**多个异步 disposer 并发执行，不保证逐个完成**。
2. 有顺序依赖的清理，必须放进**同一个 `ctx.effect` 返回的 disposer** 里串行 `await`。
3. `dispose` 语义保证三件事：本插件注册全移除、子插件递归卸载、返回的 Promise 在异步清理完成后兑现。

### 1.4 `ctx.plugin()` 与嵌套上下文

```ts
export function apply(ctx: Context) {
  // 子插件：继承父上下文，独立 Fiber，随父卸载
  ctx.plugin(childPlugin, childConfig)
}
```

用途：把一个包拆成多个可选子能力（例如「路由」和「工具」），让它们各自等待各自的依赖。注意子插件失败只影响它自己的 Fiber。

### 1.5 能力分层：什么时候该拆包

官方三角色模型（Bash 是模板）：

```
Service Definition (dsh-shell)  ←──  Provider (dsh-bash-local)
        ↑                                   │
        └────────── Consumer (dsh-tool-bash) ┘
```

- **Definition** 定义服务契约与类型；**Provider** 实现；**Consumer** 把它暴露给模型。
- Provider 与 Consumer **互不依赖**，都只依赖 Definition。
- 只有当三者需要独立演进/替换时拆包，否则一个包承担多个角色完全可以。

对你的判断标准：**别人能不能在不改你代码的前提下换掉其中一角？** 能 → 拆；不能 → 别拆。

---

## 2. 版本与环境基线

### 2.1 当前版本事实（2026-10-26 实测）

| 渠道 | 版本 | 说明 |
|---|---|---|
| GitHub Release（最新） | **`dsh-v0.2.1-rc.3`**，2026-10-23 | 最新发布 |
| npm `next` | `0.2.1-rc.3` | 与最新 release 对齐 |
| npm `latest` | `0.2.1-rc.2` | **默认 `npx` 拿到的是这个，不是最新** |
| npm `alpha` | `0.2.1-alpha.5` | 早于 rc 线 |
| 本机安装 | `0.2.1-rc.3` | `dsh --version` |

**坑一：`latest` 落后 `next`。** 想要最新：

```sh
npx @deepseek-ai/dsh@next web
```

**坑二：生态包（`@deepseek-ai/dsh-tools` 等）的 `latest` 标签严重滞后**（实测为 `0.0.1-rc.1`）。给插件声明 peer 依赖时：

- ✅ 写**精确版本**（`0.2.1-rc.3`）或 `@next` 解析出的版本；
- ❌ 不要写 `latest`/`^` 靠 `latest` 标签解析 —— 会拿到远古版本。

**坑三：Node 版本。** 从 `0.2.1-rc.2` 起要求 **Node.js ≥ 24.9.0**，不再支持 Node 22。仓库根 `engines.node` 为 `>=24.9.0`。老社区插件里写的 `"node": "^22.19.0 || >=24.0.0"` 已不再准确。

### 2.2 版本对齐矩阵（写进你插件的 package.json）

| 包 | 版本基线 | 放哪 | 为什么 |
|---|---|---|---|
| `@deepseek-ai/cordis` | `~4.0.5` | peer + dev | 必须与宿主共享**同一个** Cordis 实例 |
| `@deepseek-ai/dsh-tools` | `0.2.1-rc.3` | peer + dev | `defineTool` 与注册表契约 |
| `@deepseek-ai/schemastery` | `~3.18.5` | peer + dev（或 deps） | Config 校验器 |
| 其他 `@deepseek-ai/dsh-*` | 与宿主同版本 | peer + dev | 同一实例，避免双份服务 |
| 你自己的第三方依赖 | 任意 | `dependencies` | 随包安装 |
| `tsdown` / `typescript` / `@types/node` | 见 §3.3 | dev | 构建期 |

**铁律（官方文档原文口径）**：需要与宿主共享实例的 dsh 包，**同时**声明在 `peerDependencies` 与 `devDependencies`；运行期宿主解析已包含的 peer 用安装里的副本，dev 副本供类型检查与独立测试使用。

`engines.dsh` 用 SemVer 范围声明兼容性，安装与 profile 启动都会拒绝不满足的组合包：

```json
"engines": { "dsh": ">=0.2.1-rc.2 <0.3.0", "node": ">=24.9.0" }
```

没有 `engines.dsh` 时，改为检查 `@deepseek-ai/dsh*` peer 范围。

### 2.3 版本漂移：发布包 ≠ 主干

实测对照（`0.2.1-rc.3`）：

| API | npm 发布包 `0.2.1-rc.3` | 仓库主干（rc.3 + 1533 commits） |
|---|---|---|
| `ctx.tools.register(def)` | ✅ | ✅ |
| `ctx.tools.register(def, { when })` | ❌ 无此重载 | ✅ |
| `ResolvedToolSet` / `exec.toolSet` | ❌ | ✅ |
| `timeoutMs` / `isConcurrencySafe` / `presentCall` / `presentResult` / `presentationMeta` | ✅ | ✅ |
| `projectContent` / `finalizeContent` / `deferContext` / `concludeTurn` | ✅ | ✅ |

**做法**：把「我要用的 API 在不在」当成一次显式检查，而不是假设。三种确认手段，从快到慢：

```sh
# 1) 查你实际安装的类型（最权威）
grep -rn "when?:" node_modules/@deepseek-ai/dsh-tools/lib/types/*.d.ts

# 2) 查发布包源码
npm pack @deepseek-ai/dsh-tools@0.2.1-rc.3 --dry-run   # 看文件清单
npm view @deepseek-ai/dsh-tools@0.2.1-rc.3 dist.tarball

# 3) 读官方升级指南（说明「哪个版本引入/移除」，最权威的语义来源）
ls /path/to/deepseek-harness/docs/upgrade-guide/<version>/
```

写进本指南的所有代码（§14.5 + 第二部分全部案例）都已在**发布包 `0.2.1-rc.3`** 上通过类型检查，可以直接落地。

### 2.4 三种运行形态（决定你的调试方式）

| 形态 | 启动 | 你的插件从哪来 | 适用 |
|---|---|---|---|
| **源码 checkout** | `pnpm dsh web` | `--patch` overlay 指向 `.ts`，tsx 直接跑 | 开发迭代（最快） |
| **安装形态** | `dsh web`（npm 包） | profile 的 `node_modules` 里构建后的 `lib/` | 交付验收 |
| **桌面/服务** | 产品内置 | 同上 | 最终用户 |

---

## 3. 项目骨架（照抄即可）

### 3.1 目录布局

```
dsh-hello-plugin/
├── package.json            # dsh.bundle + engines + peer/dev 双声明
├── cordis.patch.yml        # 配置层：insert 插件行
├── tsconfig.json           # 类型检查（noEmit，host + client）
├── tsconfig.client.json    # 仅客户端声明（有半边时）
├── tsdown.config.ts        # host 半边打包（含 dts）
├── tsdown.client.config.ts # 客户端半边打包（有半边时）
├── lib/                    # 构建产物（不进 git）
│   ├── index.js
│   ├── index.d.ts
│   ├── client.js           # 有半边时
│   └── types/client/*.d.ts # 有半边时
├── locale/                 # 可选：插件展示元信息 / UI 文案
│   ├── en.json
│   └── zh.json
├── icon.svg                # 可选：插件卡片图标（≤256 KiB）
├── README.md               # 用户看到的简介（插件页会渲染）
├── src/
│   ├── index.ts            # 入口：name / inject / Config / apply
│   └── client/index.tsx    # 可选：浏览器半边
└── tests/
```

### 3.2 `package.json`（完整，含注释说明）

```jsonc
{
  "name": "dsh-hello-plugin",            // 或 @yourscope/dsh-hello-plugin
  "version": "0.1.0",
  "description": "One sentence, sentence case, ends with a period.",
  "type": "module",
  "license": "MIT",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json"
    // 发布展示元信息时追加： "./locale/*.json": "./locale/*.json"
  },
  "files": [
    "lib",
    "cordis.patch.yml",
    "README.md"
    // 有则加： "locale/*.json", "icon.svg", "docs"
  ],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml",   // string 或有序数组
      "listedByDefault": true          // 可选：GUI 列表是否预先展示（默认 true）
    },
    "client": {                        // 仅当有浏览器半边
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-settings"],
      "external": []                   // 可选：额外 require 的客户端模块
    }
  },
  "engines": {
    "dsh": ">=0.2.1-rc.2 <0.3.0",
    "node": ">=24.9.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.3",
    "@deepseek-ai/schemastery": "~3.18.5"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.3",
    "@deepseek-ai/schemastery": "~3.18.5",
    "@types/node": "^24.0.0",
    "tsdown": "^0.22.14",              // ← 别钉 0.22.2，见 §3.4
    "typescript": "^6.0.3"
  },
  "scripts": {
    "build": "tsdown && tsdown -c tsdown.client.config.ts && tsc -p tsconfig.client.json",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

**逐项为什么：**

- `main`/`exports` 必须指向**构建产物**：Node 的 ESM 解析不认 `.ts`（源码形态由 tsx 负责，不适用于安装形态）。
- `types` 指向 `./lib/index.d.ts`（由 `tsdown` 的 `dts: true` 生成），**不是** `lib/types/index.d.ts` —— 那是「tsc 单独产声明」的旧方案，多文件插件容易踩 `.ts` 扩展名坑，见 §3.3。
- `exports` 里**不要**发布 `./src/*`；`files` 里**不要**包含 `src`、`tsconfig`（sourcemap 按需，默认建议带）。
- `dsh.bundle.patch` 可以是字符串，也可以是**有序数组**（`["./base.patch.yml", "./web.patch.yml"]`），按序应用为同一层（源码依据：`bundlePatchFiles`）。
- `dsh.bundle.listedByDefault`：`false` 时该 bundle 在 GUI 列表里默认隐藏，直到 profile 启用它。做「一批官方但默认关闭」的组合包时用。
- `dsh.client` 只在你有浏览器半边时写；`external` 声明超出客户端基线的模块请求（`<pkg>/client` 这类子路径也要写），见 §9.2。
- 没有 `dsh.bundle` 的包**仍能安装**，但只作普通依赖，`dsh plugin` 会打一次性警告且不激活任何层。

### 3.3 `tsconfig.json` + `tsconfig.client.json`

```jsonc
// tsconfig.json —— 只做类型检查（host + client 都覆盖）
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],              // DOM：有客户端半边时必需
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,     // ★ 会逼你处理可选属性，见 §8
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,     // 允许源码里写 .ts/.tsx
    "noEmit": true,
    "types": ["node"],                      // ← 需要 @types/node，否则 TS2688
    "jsx": "react-jsx"                      // ← 有客户端半边时必需
  },
  "include": ["src", "tsdown.config.ts", "tsdown.client.config.ts"]
}
```

```jsonc
// tsconfig.client.json —— 只产客户端声明（host 声明由 tsdown dts 生成）
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "declarationMap": true,
    "emitDeclarationOnly": true,
    "outDir": "lib/types/client",
    "rootDir": "src/client",
    "noEmit": false
  },
  "include": ["src/client"]
}
```

> **实测坑 1**：`"types": ["node"]` 而不装 `@types/node` → `error TS2688: Cannot find type definition file for 'node'`。
>
> **实测坑 2（多文件插件必踩）**：如果按旧方案写 `tsconfig.build.json` 并设 `"allowImportingTsExtensions": false`，源码里所有 `import './util.ts'` 都会报 `TS5097: An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled`。两个正解：
>
> - **推荐**：相对导入**不写扩展名**（`import { x } from './util'`），Bundler 解析正常，`.d.ts` 也干净；
> - 或让 `tsdown` 的 `dts: true` 统一产声明（它会把声明打成一个文件，内部 specifier 不外泄）。
>
> **实测坑 3**：一个包同时有 `src/index.ts` 和 `src/client/*.tsx` 时，`tsc -p tsconfig.build.json`（include `src`）会把 `.tsx` 也编进去并报 `TS6142: '--jsx' is not set`。所以声明构建必须**分开 include**：host 走 tsdown，client 走 `tsconfig.client.json`。

### 3.4 `tsdown.config.ts`（host 半边）

```ts
// tsdown.config.ts —— host 半边（一个入口一个产物）
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'lib',
  clean: true,             // 注意：client 构建要 clean: false，顺序固定 host 先跑
  sourcemap: true,
  dts: true,               // ★ 声明由 tsdown 一并产出 lib/index.d.ts
  fixedExtension: false,
  deps: {
    neverBundle: true,     // 外部化所有依赖，绝不把 @deepseek-ai/* 打进产物
  },
})
```

**为什么 `neverBundle` 是硬要求**：Cordis 的 `Service`、注册表实例都以「同一模块实例」为前提。把 `@deepseek-ai/cordis` 打进你的产物会造出第二份类，`instanceof` 与 `ctx.get()` 全部失效。

> **实测坑（版本敏感）**：`neverBundle: true` 在 **tsdown `0.22.2` 上直接构建失败**：
> `Warning: Invalid input options ... For the "external". Invalid type: Expected ((string | RegExp) | Array | Function) but received true.` → `Error: Value is none of these types ... on BindingInputOptions.external`。
> 在 **`0.22.14` 上正常**。两种写法二选一：
>
> - 升级到 `tsdown@^0.22.14` 并用 `neverBundle: true`；
> - 或任何版本都安全地写 `neverBundle: [/^@deepseek-ai\//]`（正则数组）。
>
> 无论哪种，**构建后必须检查** `lib/index.js` 头部仍是真实 `import ... from '@deepseek-ai/dsh-tools'`，而不是被内联的代码。

### 3.5 `cordis.patch.yml`

```yaml
# 最小形态：插入一行
- insert:
    - id: hello-plugin            # 行的稳定 id，后续层靠它覆盖
      name: dsh-hello-plugin      # 包名解析（bare specifier 才带浏览器半边，见 §9.4）
      config:
        greeting: Hello
```

一个包需要挂多行时（例如「工具」+「启动标志」两个插件），给每行一个**带命名空间前缀的 id**，避免与别人的行撞名：

```yaml
- insert:
    - id: hello-plugin:tools
      name: dsh-hello-plugin
      config: { greeting: Hello }
    - id: hello-plugin:startup
      name: dsh-hello-plugin/startup    # 子路径导出，指向另一个插件模块
      disabled: true                    # 需要命令行标志的部署才开
```

> 官方生成器（creation-recommendations）对自动生成的 bundle 强制「插入 id 必须以包名加冒号开头」，手写时按同一约定做，升级与排障都省事。

写法要点：

| 场景 | 写法 |
|---|---|
| 新增一行 | `- insert: [{ id, name, config }]` |
| 覆盖别人的行（按 id） | `- id: <existing-id>\n  config: {...}` —— **整行 config 被替换** |
| 禁用一行 | `- id: x\n  disabled: true` |
| 条件启用 | `disabled: !!js "ctx.get('profileContext')?.name !== 'web'"` |

**`!!js` 表达式**在 loader 求值，可读注入的服务；用于「按部署取值」。需要 `inject` 的行会先等待注入，再求值自身的 `!!js` 配置。

**config 替换而非深合并**：这条规则决定了你要么重述全部键，要么把默认值交给 schema。规范化做法是**后者**。

### 3.6 一键骨架（复制粘贴）

```sh
mkdir -p dsh-hello-plugin/src dsh-hello-plugin/tests
cd dsh-hello-plugin
# host-only 工程写 5 个文件：
#   package.json        → §3.2（删掉 exports/./client、dsh.client、build 里的 client 步骤）
#   cordis.patch.yml    → §3.5
#   tsconfig.json       → §3.3
#   tsdown.config.ts    → §3.4
#   src/index.ts        → §0.3（最小版）或 §14.5（带 timeout/并发/审计的完整版）
#
# 带客户端半边的工程再写 3 个：
#   tsconfig.client.json      → §3.3
#   tsdown.client.config.ts   → §9.3
#   src/client/index.tsx      → §9.5
pnpm install
pnpm typecheck && pnpm build
```

> `pnpm install` 之后如果 `tsdown` 报找不到配置加载器，先确认 Node ≥ 24.9（tsdown 用 Node 原生 TS 剥离加载 `tsdown.config.ts`）。

构建成功判据（host-only 与 full 两种）：

```sh
# host-only
lib/index.js
lib/index.js.map
lib/index.d.ts
lib/index.d.ts.map

# 带客户端半边
lib/index.js
lib/index.js.map
lib/index.d.ts
lib/index.d.ts.map
lib/client.js
lib/client.js.map
lib/types/client/index.d.ts          # ← 由 tsc -p tsconfig.client.json 产出
lib/types/client/HelloSection.d.ts
```

然后**立即**验证它能被宿主接受（这一步比启动整机快得多）：

```sh
dsh plugin --profile demo add /abs/path/to/dsh-hello-plugin
dsh --profile demo --dump-config | grep -A4 "dsh-hello-plugin"
```

看到 `# == dsh-hello-plugin` 层即说明 package.json / patch / 产物三件事都对。

---

## 4. 插件本体契约

### 4.1 三种导出形态

```ts
// ① 函数式（绝大多数场景）
// 片段：只示形态。完整可编译版本见案例 1。
export const name = 'my-plugin'
export const inject = ['tools']
export function apply(ctx: Context, config: Config) { /* ... */ }
```

```ts
// ② 对象式（想在一个文件里聚合多个插件时）
// 片段：同上。
export default {
  name: 'my-plugin',
  inject: ['tools'],
  apply(ctx: Context) { /* ... */ },
}
```

```ts
// ③ 类式 Service（要对外提供服务时）
import { Service, type Context } from '@deepseek-ai/cordis'

export default class MyService extends Service {
  static inject = ['tools']
  constructor(ctx: Context) {
    super(ctx, 'myService')       // ← ctx 上的服务名
    // 构造函数里只做同步初始化
  }
  record(event: string, value: number) { /* 公开方法 */ }
}
```

补充：

- `apply` 可以是 `async`，但**加载链会等它**；不要在 `apply` 里 `await` 永不 settle 的东西。
- 导出的 `name` 用于日志与诊断，与包名不必相同，但**强烈建议一致**（便于定位）。
- `inject` 既可以是数组，也可以是 `{ required: [...], optional: [...] }` 形态（按需选，数组最常用）。

### 4.2 `apply` 里该做什么、不该做什么

| ✅ 该做 | ❌ 不该做 |
|---|---|
| 注册工具/监听/服务/路由 | 手写 `process.on('exit')` 清理 |
| 读 `config`，把可调参数落到闭包 | 在模块顶层读 `process.env` 当配置 |
| 用 `ctx.effect` 包裹外部资源 | 在 `apply` 里做长耗时同步 IO |
| 逻辑拆分到独立文件，`apply` 只做装配 | 在 `apply` 里 catch 掉所有错误静默 |
| 参数校验交给 schema/`defineTool` | 用 `any` 绕过类型 |

**装配模式（推荐，来自生产插件）**：

```ts
export function apply(ctx: Context, config: Config): void {
  const adapters = new AdapterRegistry(ctx)
  const diagnostics = new Diagnostics()

  ctx.effect(() => adapters.register(searxngAdapter), 'x: searxng')
  ctx.effect(() => adapters.register(readableAdapter), 'x: readable')

  const dispatcher = new Dispatcher(ctx, config, adapters, diagnostics)
  ctx.effect(() => ctx.web.registerSearchProvider(dispatcher), 'x: provider')

  ctx.inject(['webServer'], (webCtx) => registerRoutes(webCtx, { config, dispatcher }))
}
```

好处：`apply` 是「接线图」，业务在类里可单测；每个 effect 带 label，卸载与排障都能定位。

### 4.3 可选依赖与延迟注入

```ts
// 必需：缺失就不加载
export const inject = ['tools']

// 可选：查询式
export function apply(ctx: Context) {
  const metrics = ctx.get('metrics')       // 可能 undefined
  metrics?.record('plugin_loaded', 1)
}

// 可选：等到就绪再执行（不阻塞整个插件）
export function apply(ctx: Context) {
  ctx.inject(['webServer', 'connection'], (c) => {
    // 这两个服务就绪时才跑；消失时这个子 Fiber 被 dispose
  })
}
```

选择原则：**能力不存在就不该工作** → `inject`；**能力存在则增强** → `ctx.inject` 子上下文；**两者都行** → `ctx.get`。

### 4.4 类型安全：声明合并

```ts
// 提供方：让 ctx.metrics 有类型
declare module '@deepseek-ai/cordis' {
  interface Context { metrics: MetricsService }
}

// 事件：让 ctx.on/emit 有类型
declare module '@deepseek-ai/cordis' {
  interface Events {
    'my-plugin/ready': (payload: { id: string }) => void
    'my-plugin/transform': (input: string, next: () => Promise<string>) => Promise<string>
  }
}
```

事件命名规范：`namespace/action`，全小写 kebab（`tools/pre-execute`、`agent/pre-step`、`loader/volatile-update`）。**你的插件自定义事件必须带自己的命名空间前缀**，避免与内置事件冲突。

### 4.5 HMR 与重载语义

改了被 loader 监视的文件后：

1. 旧插件被卸载（所有 effect 回收）；
2. 新代码被加载；
3. 新 `apply` 执行。

推论：**任何「只初始化一次」的假设都不成立**。别把状态放在模块顶层可变变量里（HMR 会保留模块作用域还是重建，取决于加载器），要放插件实例状态或用 `ctx.effect` 托管。

改了某行的 `config` → 该插件被**整实例替换**，不是「热更新配置」。所以 `apply` 必须能从零重建一切。

---

## 5. 配置（Config schema）

### 5.1 标准写法

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  greeting: string
  maxRetries: number
  mode: 'fast' | 'accurate'
  verbose?: boolean
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().step(1).min(0).default(3),
  mode: Schema.union(['fast', 'accurate']).default('fast'),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) {
  // config 已校验 + 已填默认值
}
```

**硬要求**：导出**同名**的 `Config` 类型与 Schema 值；默认值写在 schema 里；**不要导出普通对象**（不满足 Cordis 要求的 Standard Schema 接口，加载即失败）。

### 5.2 常用 schema 方法

| 需求 | 写法 |
|---|---|
| 默认值 | `.default(v)` |
| 必填 | `.required()` |
| 整数/步长 | `.step(1)` |
| 范围 | `.min(0).max(100)` |
| 枚举 | `Schema.union(['a','b'])` |
| 描述（进配置目录/表单） | `.description('...')` |
| 数组 | `Schema.array(Schema.string()).default([])` |
| 字典 | `Schema.dict(Schema.number())` |
| 密钥（不进表单响应） | `.role('secret')` |
| 即时可改（不重启） | `.volatile()` + `ctx.on('loader/volatile-update', ...)` |

### 5.3 即时配置（volatile）

```ts
import type { Context, Volatile } from '@deepseek-ai/cordis'
// 必须导入 loader 的类型，否则 'loader/volatile-update' 不在 Events 里（实测 TS2345）
import type {} from '@deepseek-ai/cordis-plugin-loader'
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  endpoint: Volatile<string | undefined>
  retries: Volatile<number>
}

export const Config = Schema.object({
  endpoint: Schema.string().volatile(),
  retries: Schema.number().step(1).min(0).default(3).volatile(),
})

export function apply(ctx: Context, config: Config): void {
  ctx.on('loader/volatile-update', () => {
    // 重新读取即可，无需重载插件
    ctx.logger.info('retries = %d', config.retries.get())
  })
}
```

> `@deepseek-ai/cordis-plugin-loader` 只是**类型**依赖（`import type {}`），加进 `devDependencies` 即可，运行时不需要它。
> 依赖它的事件声明在 `@deepseek-ai/cordis-plugin-loader/lib/types/index.d.ts` 的 `Events` 合并里。

规则：

- **在操作开始时 `.get()`**；需要一致快照的请求**一次性捕获全部所需值**。
- 跨字段校验用 `.check()`，它在 Host 侧持久化前执行，**不进入**序列化的表单 schema。
- 普通（非 volatile）字段的修改会触发插件重载（`apply` 重跑）。

### 5.4 配置设计原则（官方硬约定）

1. **无硬编码可调参数。** 判定标准：能不能只在 `cordis.yml` 里改掉它，而不动代码？不能 → 提成配置字段。
2. **配置错误要响亮。** 把自身完备的约束写进 schema，让非法配置在**加载时**失败并给出明确错误，而不是运行到一半才炸。
3. **引用别的服务/资源 → 用依赖注入，不要塞 id 字符串。**

反例与正例：

```ts
// ❌ 硬编码
const TIMEOUT = 30_000
const ENDPOINT = 'https://api.example.com'

// ✅ 可配置 + 有默认
export interface Config { timeoutMs: number; endpoint: string }
export const Config = Schema.object({
  timeoutMs: Schema.number().step(1).min(1).default(30_000),
  endpoint: Schema.string().default('https://api.example.com'),
})
```

### 5.5 配置来源与优先级

生效配置从**空根**开始逐层叠加：

1. `dsh.profile.bundles` 列表中各 bundle 的 patch（按列表顺序）
2. profile 自己的 `cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml`（机器级偏好，**优先于**逐 profile 层）
4. 每个 `--patch <path>` overlay（按 argv 顺序）

后层按行胜出，且 **patch 替换目标行整个 `config`，不深合并**。

给插件作者的两条推论：

- 你要覆盖别人行时，必须**重述该行需要的每一个键**；
- 你提供的默认值应该让用户「大概率不需要覆盖」——其余交给 schema 兜。

---

## 6. 工具开发（核心章节）

工具是 DSH 插件最常用的形态。工具契约分三层：**参数 schema**（模型看）、**规范值**（程序看）、**渲染内容**（模型读）。搞混这三层是绝大多数 bug 的根源。

### 6.1 三层模型

```
模型 arguments ──[参数 schema 校验]──> args（已收窄类型）
                                          │
                                     execute(args, exec)
                                          │
                                 返回「规范 JSON 值」
                                          │
                       ┌──────────────────┴──────────────────┐
                output.render                      output.presentationMeta
              （模型可见的内容块）                  （UI 可回放的元数据）
```

铁律：

- `execute` **只返回规范值**，不返回内容块，不拼自然语言给模型「解析」。
- `render` 负责模型可见文本；`presentationMeta` 负责 UI 可回放状态；两者都是**纯函数**。
- 失败 → **抛异常**；成功的「不理想结果」（例如进程非零退出）→ 写进规范值，由 render 解释。

### 6.2 完整签名

```ts
defineTool({
  name: string,
  description: string,              // 模型可见
  parameters: ParameterSchemaSpec,  // 隐式开放对象根
  output: {
    schema: ValueSchemaSpec,        // 规范值的 JSON Schema 子集
    render(args, value): ContentBlock[],
    presentationMeta?(args, value): JsonValue,
  },
  deferLoading?: true,
  timeoutMs?: number,
  isConcurrencySafe?(args): boolean,
  execute(args, exec): Promise<InferValue<O>>,
  projectContent?(exec, result): ContentBlock[] | undefined,
  finalizeContent?(exec, result): ContentBlock[] | undefined,
  presentCall?(args): ToolCallView | undefined,
  presentResult?(args, result): ToolResultView | undefined,
}): ToolDefinition
```

`exec`（`ToolRunContext`）你能用的字段：

| 字段 | 含义 | 注意 |
|---|---|---|
| `exec.signal` | 调用方持有的取消信号 | **必须观测**，触发即停 |
| `exec.agent` | 代其执行的 agent（可能 undefined） | 用于 `agent.inject(...)` 异步通知 |
| `exec.callId` | 本次调用 id | 日志关联 |
| `exec.token` | 不透明执行令牌 | **不要**持久化或跨调用复用 |
| `exec.arguments` | 已冻结的只读参数 | 只读 |
| `exec.deferContext(msg)` | 结果落地时追加一条上下文（复合工具用） | 需要完整 `UserMessage`：`{ id, role: 'user', content, source }`，且 `source.kind` 要在 `MessageSourceMap` 里声明。插件做异步通知请优先用 `exec.agent.inject(...)` |
| `exec.concludeTurn()` | 标记成功后结束当前轮次 | 谨慎使用，复合工具要透传嵌套结果 |

### 6.3 参数 schema DSL

`parameters` 是**隐式开放对象根**，每个属性可标 `required: true`：

```ts
parameters: {
  path:   { type: 'string', required: true, description: 'Absolute path' },
  limit:  { type: 'number' },                                  // 可选
  mode:   { type: 'string', enum: ['fast', 'full'] },          // 字面量约束
  tags:   { type: 'array', items: { type: 'string' } },
  force:  { type: 'boolean', default: false },                 // 非校验性注解
}
```

支持的类型：`string` | `number` | `integer` | `boolean` | `null` | `array` | `object` | `json`（仅作者侧，无约束） | `oneOf`（恰好命中一个分支，至少两支）。

`oneOf` 用来表达「二选一」的参数形状（已编译验证）：

```ts
parameters: {
  target: {
    type: 'oneOf',
    required: true,
    description: 'Either { path } or { id }.',
    oneOf: [
      { type: 'object', additionalProperties: false,
        properties: { path: { type: 'string', required: true } } },
      { type: 'object', additionalProperties: false,
        properties: { id: { type: 'string', required: true } } },
    ],
  },
},
// execute 里用 in 收窄：
async execute(args) {
  const target = args.target
  return 'path' in target
    ? { kind: 'path' as const, value: target.path }
    : { kind: 'id' as const, value: target.id }
}
```

注意 `oneOf` 的每个分支都是**显式对象节点**，同样必须写 `additionalProperties`；分支属性同样要 `required: true`。

> `default` / `examples` 是**非校验性注解**：它们会投影进 JSON Schema 给模型看，但**不会为缺失的参数补值**。要真正的默认值，在 `execute` 里 `args.x ?? DEFAULT`，或把「缺省」写进 `Config`。

**必须记住的三条：**

1. **显式对象节点必须声明 `additionalProperties: true | false`**（否则编译报错）。
2. **对象节点里的属性同样用 `required: true` 表达必填** —— 不写就是可选，并且推导为 `T | undefined`。
3. 标量上的 `enum`/`const` 值必须与节点类型匹配（`{type:'number', enum:['a']}` 非法）。

> 实测坑：输出对象里写 `{ greeting: { type: 'string' } }` 不写 `required`，`value.greeting` 的类型是 `string | undefined`，赋值给 `string` 直接编译失败（`TS2322`）。

**schema 表达不了的要自己查**：非空字符串、正数、跨字段规则（如 `end > start`）。校验失败就抛错，注册表会转成普通错误结果。

### 6.4 输出规范值

```ts
output: {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path:    { type: 'string', required: true },
      bytes:   { type: 'integer', required: true },
      preview: { type: 'string', required: true },
    },
  },
  render: (_args, v) => [{ type: 'text', text: `${v.path} (${v.bytes} bytes)\n${v.preview}` }],
}
```

设计准则（PTC 模式会直接暴露你的 schema 给程序调用）：

- 根可以是对象、数组、标量或 `null` —— **结果是什么就写什么**，别为了「统一」硬包一层对象。
- 返回**句柄与字段**，别返回「请从这段文字里找 id」。
- 面向人的解释放 `render`，不要塞进规范值。
- 中间值不会被持久化，也不受提示词截断/字节上限限制 —— 但**内存**仍然是你自己的责任。

### 6.5 失败语义

| 情况 | 结果 |
|---|---|
| 参数不匹配 schema | `ToolArgsError`（`INVALID_ARGS`），模型看到普通错误 |
| `execute` 抛异常 | 捕获后 `isError: true` |
| 返回值不匹配 `output.schema` | `ToolOutputError`（`INVALID_TOOL_OUTPUT`） |
| 未知工具名 | `UNKNOWN_TOOL` |
| 调用前取消 | `ABORTED_BEFORE_DISPATCH` |
| 调用后取消 | 成功结果被替换为 `ABORTED` |
| 超时（声明了 `timeoutMs`） | `TOOL_TIMEOUT` |

**推论**：基础设施故障 → 抛；业务上的「不理想但成功」 → 正常返回规范值（例如 `{ exitCode: 1 }`），让 render 解释。

### 6.6 取消与超时

```ts
async execute(args, exec) {
  const ac = new AbortController()
  // 把 exec.signal 转发到你的下游
  exec.signal.addEventListener('abort', () => ac.abort(exec.signal.reason), { once: true })
  return doWork(args, ac.signal)
}
```

- **协作式取消**：框架不能硬杀同进程代码。你必须把 signal 转发给 `fetch`/`fs`/`child_process` 等。
- `timeoutMs` 由基础组合包内置的 `dsh-tool-call-timeout-policy` 执行（**默认已挂载**，无需你配置）。它只在**你声明了 `timeoutMs`** 时生效，且**声明即承诺**你的实现能协作停稳。
- 声明了却忽略 signal → 调用方会一直等，超时毫无意义。

### 6.7 并发安全

```ts
isConcurrencySafe: (args) => args.readOnly === true,
```

- 只有显式返回 `true` 才允许与兄弟调用并行；**省略 = 独占**。
- 返回 `true` 意味着：不修改父级状态，共享状态能容忍并发，竞态只允许「可交换或失败关闭」。
- 该元数据**永不发给模型**。

### 6.8 UI 展示（Host 侧渲染意图）

不写展示方法 → 通用卡片（标题 = 工具名，原始参数）。写了就有专用卡片：

```ts
// 调用态（PENDING）
presentCall: (args) => ({
  card: 'generic',
  title: `Read ${args.path}`,
  kind: 'read',
  locations: [{ path: args.path, line: args.limit }],
})
```

```ts
// 结果态（COMPLETED）
presentResult: (_args, result) => result.isError
  ? { card: 'generic', title: 'Failed', content: result.content }
  : undefined,
```

三种 `card` 意图：

| card | 用于 | 关键字段 |
|---|---|---|
| `generic` | 默认 | `title`、`kind`（`read`/`search`/`edit`/`execute`/`fetch`/…）、`rawInput`、`content`、`locations` |
| `terminal` | 本质是 shell 命令 | `title`（命令行）、`description`、`cwd` |
| `diff` | 创建/修改文件 | `diffs: [{ path, oldText, newText }]`（新文件 `oldText: null`） |

结果态另有 `read` / `search` / `web` 等专用视图，从 `result.meta`（即 `presentationMeta` 的产物）重建。

**四条硬规则：**

1. **纯函数**：实时流式与日志回放都会调用；不做 IO、不读会话、不用时钟/随机数。
2. **UI 格式不进模型结果**：围栏 ` ```console `、diff、相对化路径都只服务 UI。
3. `defineTool` 对展示路径做**软校验**：参数不匹配（旧日志/坏参数）→ 返回 `undefined` 走通用卡片，绝不抛异常。
4. 内置 Web Client **不消费** `presentCall/presentResult`；Web 卡片走客户端插件的 keyed slot（§9.5）。想让 Web 有自己的卡片，必须写客户端半边。

`presentationMeta` 的典型用途：把「应用后的 hunk」等结果期事实持久化，让回放能重放卡片：

```ts
output: {
  schema: { type: 'object', additionalProperties: false, properties: { applied: { type: 'string', required: true } } },
  render: (_a, v) => [{ type: 'text', text: 'written' }],
  presentationMeta: (_a, v) => ({ hunk: v.applied }),
}
```

### 6.9 PTC 模式（程序化调用）

PTC 执行器默认关闭（`tool-executor-ptc` 行 `disabled: true`），由 profile/preset 打开。打开后：

- 每个可见工具都可通过 `await tools.<name>(args)` 调用，**无需你额外集成**；
- `ToolArgsMap`/`ToolOutputMap` 从同一份 schema 派生；
- 成功返回**策略处理后的规范 JSON 值**（不是渲染后的内容）；
- 失败以真正的 `ToolCallError` reject，只能看 `name`/`toolName`/`message`。

因此：**把 `output.schema` 当公开 API 设计**。返回句柄与字段，别让程序解析自然语言。

### 6.10 条件工具（按模型/步骤开关）—— ⚠️ 版本敏感

```ts
ctx.tools.register(tool, {
  when: ({ agent, modelSelection, signal }) => modelSelection.model.includes('vision'),
})
```

语义（以下描述对应**已合入主干的实现**）：

- 每个模型步骤计算一次，可同步可异步；
- 返回 `false` → 从工具描述、PTC 绑定、执行集合中一并排除；
- **抛错** → `TOOL_ACTIVATION_FAILED`，中止该步骤准备（不是「不可用」）；
- 条件必须响应取消，**不得**改注册或执行工具；
- 没有已解析 `toolSet` 的调用（如某些嵌套派发）无法调用条件工具，返回 `UNKNOWN_TOOL`。

**版本事实（必须自己确认）**：截至 `0.2.1-rc.3` 的**发布包**，`ToolsService.register` 只有 `register(definition): () => void` 一个签名 —— `{ when }` 重载在 rc.3 tag **之后**的主干才出现。用之前先查你实际安装的类型：

```sh
grep -n "register(" node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts
# 只有 register(definition: ToolDefinition) → 该版本不支持 when
```


### 6.11 工具命名与描述规范

| 项 | 规范 | 例子 |
|---|---|---|
| 工具名 | `snake_case`，动词开头，全局唯一 | `read_file`、`web_search` |
| 描述 | 一句话说明「做什么 + 边界」，句末标点 | `Read a file from disk. Returns at most limit lines.` |
| 参数名 | `snake_case`，每个都写 `description` | `path`、`timeout_ms` |
| 输出字段 | `snake_case`，语义稳定 | `exit_code`、`total_lines` |

反模式：`myTool`、`do_thing`、描述写成一段营销文案、参数名 `a`/`b`。

### 6.12 生产级工具清单（对照自查）

- [ ] `description` 说清能力与限制
- [ ] 每个参数有 `description`，必填标 `required: true`
- [ ] 输出根类型就是结果本身（不是无意义的包装）
- [ ] `execute` 全程转发 `exec.signal`
- [ ] 声明了 `timeoutMs` 且实现能停稳
- [ ] 只读工具声明 `isConcurrencySafe`
- [ ] 错误用抛异常，不返回 `"error: ..."` 字符串
- [ ] `render` 纯函数、无 IO
- [ ] 大输出自己截断，并在规范值里给出 `truncated`/`total` 之类的字段
- [ ] 参数 schema 表达不了的约束在 `execute` 开头显式校验

---

## 7. 服务、事件与策略钩子

### 7.1 消费服务

```ts
export const inject = ['tools', 'llm']

export function apply(ctx: Context) {
  ctx.tools.register(/* ... */)
  ctx.llm.registerAdapter(/* ... */)
}
```

内置服务速查（`ctx.<key>`，完整清单见官方子系统页，**不要维护静态副本**）：

| 类别 | 服务 |
|---|---|
| 模型/工具 | `tools`、`llm`、`agents`、`agentLoop`、`agentPresets` |
| 会话 | `sessionPersistence`、`sessionProjections`、`sessionQuery` |
| 执行环境 | `shell`、`fs`、`sandbox`、`sandboxPolicy`、`jobs`、`terminals` |
| Web/UI | `web`、`webServer`、`webApp`、`connection`、`clientModules` |
| 交互 | `approval`、`userQuestions`、`commands`、`planMode` |
| 其它 | `skills`、`schedule`、`goals`、`workflowEngine`、`mcpResources` |

> 注意：`todo` 只是**工具**（`dsh-tool-todo`），没有对应服务 —— 别写 `inject: ['todo']`。

> 服务名的**单复数**有约定：engine/runtime/policy/controller/resolver/store 用单数 key；持有多个具名成员的 registry 用复数。

### 7.2 提供服务（Service 基类）

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context { metrics: MetricsService }
}

export default class MetricsService extends Service {
  static inject = ['llm']
  constructor(ctx: Context) {
    super(ctx, 'metrics')
  }
  record(event: string, value: number) { /* ... */ }
}
```

消费方：

```ts
export const inject = ['metrics']
export function apply(ctx: Context) { ctx.metrics.record('tool_call', 1) }
```

**服务隔离**（同一服务多实例）：

```yaml
- id: group-a
  name: '@deepseek-ai/cordis-plugin-group'
  group: true
  isolate:
    shell: true
  config:
    - name: '@deepseek-ai/dsh-bash-local'
      config: { timeoutMs: 5000 }
    - name: './src/plugin-a.ts'
```

组内插件只看到本组的 `shell` 实例。

### 7.3 事件四种模式

| 模式 | 调用 | 监听器契约 | 典型用途 |
|---|---|---|---|
| `emit` | `ctx.emit(name, payload)` | 返回值被忽略，全部同步执行 | 广播通知（`tools/change`） |
| `bail` | `ctx.bail(name, input)` | 首个非 `null/false/undefined` 返回值成为结果 | 短路判定 |
| `serial` | `await ctx.serial(name, ctx)` | 顺序 + 等待异步，首个非空值终止 | 有序阶段 |
| `waterfall` | `await ctx.waterfall(name, input, next)` | **必须调用 `next()`** 才能传给下游 | 流水线/拦截（工具策略） |

```ts
// waterfall 监听器
ctx.on('tools/pre-execute', async (exec, next) => {
  if (shouldBlock(exec)) return { kind: 'deny', reason: 'blocked' }
  return next()                     // ← 不调用就是短路，故意如此
})
```

事件监听器也是 effect：`ctx.on` 注册的监听器随插件卸载自动移除。

### 7.4 持久化事件 ≠ Cordis 事件

`turn/*`、`step/*`、`tool/call`、`tool/result`、`compaction/*` 是**持久化的会话事件类型**，不是同名 Cordis 事件。要观察它们：

```ts
// 注意签名是 (session, event)，不是只有 event
ctx.on('session/event', (session, event) => {
  if (event.type === 'tool/result') { /* ... */ }
})
```

而 `tools/result` 这类是真正的 Cordis 事件。**两者不要混用**。

### 7.5 工具执行流水线（策略插件的主战场）

```
tools/pre-execute   → 允许 / 拒绝 / 取消 / 询问（可扩展 waterfall）
      ↓
ctx.tools.guard()   → 单调同步守卫（后续监听器无法翻案）
      ↓
tools/execute       → 环绕分发：超时/重试/指标（只能改 exec.signal）
      ↓
[工具主体 execute]
      ↓
tools/post-execute  → 检查/替换结果/阻止/附加模型可见上下文
      ↓
finalizeContent     → 工具自己的最后一道内容变换
      ↓
tools/result        → 只观测，不可改（结果已冻结）
```

**参考实现（权限门禁）**：

```ts
export const inject = ['tools']

export function apply(ctx: Context, config: Config) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'bash') return next()
    const command = String((exec.arguments as { command?: unknown }).command ?? '')
    if (config.denyPatterns.some(p => new RegExp(p).test(command))) {
      return { kind: 'deny', reason: '命令被策略拒绝' }
    }
    return next()
  })
}
```

**职责边界**：

| 需求 | 用哪个 |
|---|---|
| 部署策略（可被用户扩展/调整） | `tools/pre-execute` |
| 不可翻案的硬拒绝 | `ctx.tools.guard()` |
| 超时/重试/埋点 | `tools/execute` |
| 脱敏/裁剪/附加提示 | `tools/post-execute` |
| 只读审计/上报 | `tools/result` |

不要把这些内建到工具本体里 —— 工具的职责是「执行」，策略是「部署选择」。

### 7.6 斜杠命令

`ctx.commands`（`CommandRuntime`）在基础组合包里默认挂载。

```ts
export const inject = ['commands']

export function apply(ctx: Context) {
  ctx.commands.register({
    name: 'hello',                                  // 小写、不带前导斜杠
    description: 'Say hello',                       // 发现列表里的摘要
    // 可选：输入提示、是否需要记录 rawInput
    input: { hint: '<name>' },
    async handler(invocation) {
      // invocation: { commandId, agent, rawInput, attachments, signal }
      if (invocation.signal.aborted) return { kind: 'error', text: 'cancelled' }
      return { kind: 'success', text: `Hello, ${invocation.rawInput.trim() || 'world'}!` }
    },
  })
}
```

要点：

- 属性名是 **`handler`**（不是 `run`），返回 `CommandResult` 联合：`{ kind: 'success', text? }` 或 `{ kind: 'error', text }`；
- 结果**由 UI 直接渲染**，不是工具结果，也不进模型上下文；
- 作用域：普通 context 注册的为全局；通过注入 agent context 的子上下文注册的会**遮蔽**该 agent 的全局同名命令；
- 需要附件时在 `input` 里写 `attachments: true`，由 handler 自己负责把它们送进模型；不声明时执行器会拒绝带附件的调用（客户端也会在提交前拒绝）。

### 7.7 让插件拥有自己的命令行标志

定义可运行应用的 bundle 可以挂一个普通提供方插件：

```yaml
- id: hello-startup
  name: 'dsh-hello-plugin/startup'
```

该插件 `inject = ['cmdlineArgs']`，用自己的 commander program 调 `parseCmdline`，在 action 里发布自己的服务；依赖它的行用 `!!js ctx.myStartup.port ?? 8080` 取值。启动器把 flag 之后的同一份不可变参数交给每个插件。

---

## 8. 后台任务

长任务不要阻塞工具调用：声明 `run_in_background` 参数，用 `ctx.jobs` 登记。

```ts
// 自定义 kind 先合并声明（否则 TS2322，见下）
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { scan: 'scan' }
}

const jobId = ctx.jobs.start({
  kind: 'scan',                                   // 决定 id 前缀与观感（如 scan-1）
  label: `scan ${args.target}`,                    // 一行、模型可见
  ...(exec.agent === undefined ? {} : { owner: exec.agent.id }),  // 归属会话；dispose 时取消并等待
  outputLimitBytes: 64 * 1024,                     // 单次模型可见输出上限
  run(job) {
    // job.append(chunk) 推送增量输出
    // 返回 hooks（取消/完成后清理），并用 job 自有的取消信号
    return { /* ... */ }
  },
})
return { kind: 'background', jobId }               // 规范句柄，PTC 程序可直接用
```

契约要点：

- `owner` 的类型是**会话 id**（`SessionId`），来源是 `exec.agent?.id`（`Agent.id` 就是 `SessionId`）；旧文档里 `owner: exec.agent` 的写法不要照抄。
- **`exactOptionalPropertyTypes` 下不能直接写 `owner: exec.agent?.id`**：`SessionId | undefined` 不能赋给 `owner?: SessionId`（`TS2379`）。用条件展开：

  ```ts
  ...(exec.agent === undefined ? {} : { owner: exec.agent.id }),
  ```

- **自定义 `kind` 必须先合并 `JobKindMap`**，否则 `kind: 'scan'` 报 `TS2322: Type '"scan"' is not assignable to type '"bash"'`：

  ```ts
  declare module '@deepseek-ai/dsh-jobs' {
    interface JobKindMap { scan: 'scan' }
  }
  ```

  `JobKind` 是 `JobKindMap` 的取值联合（`JobKindMap[keyof JobKindMap]`），`bash` 只是内置的唯一条目。
- registry 在进入 producer 主体前把**已预先中止**的调用判为失败；
- 运行时在 `run()` 前校验 owner 与任务控制器是否可用；
- 成功后返回**类型化规范句柄**（如 `{ kind: 'background', jobId }`），让 PTC 程序能直接拿 id，**不要靠解析 `started background job bash-1` 文本**；
- 发布 id 后请用**任务自有的取消信号**，而不是 `exec.signal`：之后取消外层调用只停止等待，不应杀掉已发布的工作；生命周期归 `job_kill`、owner dispose、服务 teardown；
- 前台工作仍与 `exec.signal` 耦合。

> 实现前务必读 `packages/jobs/jobs/README.zh.md` 与 `dsh-tool-bash` 的完整 producer 示例：`JobSpec.owner` 的类型在 rc 线有演进（`SessionId` 与 agent 归属的对应关系以该 README 为准）。

---

## 9. Web 客户端半边（浏览器插件）

### 9.1 它不是必需的

纯 Host 插件（工具、服务、策略）不需要客户端半边。只有当你需要**新 UI**（设置页、卡片、侧栏）时才写。

### 9.2 声明

`package.json`：

```jsonc
{
  "exports": {
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-settings"],  // 依赖的客户端包
      "external": ["react", "react/jsx-runtime"]          // 可选：额外 require 的模块
    }
  }
}
```

`dsh.client` 的三个字段（源码依据 `DshClientManifest`）：

| 字段 | 作用 |
|---|---|
| `platform` | 客户端平台标识；Web 消费者选 `web` |
| `inject` | **信息性**的包名依赖，不是 Cordis 服务注入 |
| `external` | 客户端模块表之外、需要额外暴露的模块请求（含 `<pkg>/client` 这类子路径）。类型导入会被擦除，不产生请求 |
| `immediately` | 启动第一阶段注册屏障；省略表示进入共享批 |

### 9.3 Bundle 格式（必须手写，官方未发布 preset）

客户端模块系统要求每个 `./client` 是 **lazy-CJS factory**：一段向页面模块加载器登记「包名 + factory(require)」的脚本。

```ts
// tsdown.client.config.ts —— 复刻官方 clientBundle 契约
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  outDir: 'lib',
  clean: false,            // ★ 必须在 host 构建之后跑，否则会删掉 lib/index.*
  sourcemap: true,
  dts: false,              // ★ 客户端声明交给 tsc -p tsconfig.client.json
  deps: {
    neverBundle: [
      'react',
      'react/jsx-runtime',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-slots',
    ],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-hello-plugin", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
```

规则：

- `banner` 里的 `id` **必须等于包名**；
- React 与 Cordis 一定走 `require`（外部化），否则会出现两份 React；
- 产物必须是单文件 `lib/client.js`（多资源用 combo URL，超出本指南范围）。

**实测结果（tsdown 0.22.14）**：产物开头是

```js
window.__ModuleLoader__.load({
	id: "dsh-hello-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
```

结尾是 `return module.exports;` + 两层闭合，`node --check lib/client.js` 通过。注意 rolldown 会**重排 footer**（缩进与换行变化），别用字符串精确匹配去断言产物。

**构建顺序是硬约束**：`tsdown`（host，`clean: true`）→ `tsdown -c tsdown.client.config.ts`（`clean: false`）→ `tsc -p tsconfig.client.json`。顺序反过来会把 host 产物清掉。

### 9.4 半边怎么被挂上（一个反直觉的约束）

Host 侧扫描已启用的 Loader 行，找出声明了 `dsh.client` 的包，把构建好的 `./client` 送到浏览器。**但它只给「说明符恰好等于包名」的那一行挂半边。**

推论：

- patch 行必须写**裸包名**（`name: dsh-hello-plugin`），不能写子路径（`dsh-hello-plugin/web`）；
- 一个包拆成多行时，半边留在**根行**；
- 需要「别的行关了它还活着」的 UI，**必须单独发包**。

### 9.5 客户端 `apply` 与服务

下面是一个**自包含、可编译**的最小客户端插件（完整带文案/多语言/目录结构的版本见案例 8）：

```tsx
import { createElement, type ReactElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

export const name = 'dsh-hello-plugin'
export const inject = ['slots', 'locale']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-hello-plugin': 'nav' | 'title'
  }
}

function HelloPage(): ReactElement {
  return createElement('section', null, createElement('h2', null, 'Hello'))
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('dsh-hello-plugin', {
    en: { nav: 'Hello', title: 'Hello plugin' },
    zh: { nav: '问候', title: '问候插件' },
  }), 'dsh-hello-plugin: dictionaries')

  const t = ctx.locale.bind('dsh-hello-plugin')

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: 'hello',
      order: 16,
      label: () => t('nav'),
      locale: 'dsh-hello-plugin',
    }, HelloPage))
}
```

要点：

- 客户端服务是另一套 `ctx`（`slots`、`locale`、`remote`、`configForms`…），与 Host 服务不共享；
- **Host 与 Client 不得复用同一个 `Context` key**（声明合并会同时看到两种类型）；
- **`ctx.slots` 的类型来自 `@deepseek-ai/dsh-client-ui-renderer/client`**：漏掉这行 `import type {}` 就报 `TS2339: Property 'slots' does not exist on type 'Context'`（实测）。`ctx.locale` 同理来自 `@deepseek-ai/dsh-client-locale/client`；
- 自己的样式自己注入，并挂 `data-plugin` 便于排查：

```ts
ctx.effect(() => {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-hello-plugin'
  style.textContent = STYLES
  document.head.appendChild(style)
  return () => style.remove()
}, 'styles')
```

### 9.6 设置卡（配置表单）

```ts
import type { Context, Volatile } from '@deepseek-ai/cordis'

export interface Config {
  endpoint: Volatile<string | undefined>
  retries: Volatile<number>
}
```

- 客户端通过 `ctx.configForms.get<Config>(包名)` 拿到 `form.state` 与 `form.mutate(operations, expectedRevision)`；
- Host 校验完整 Config 并通过 ConfigEditor 与 volatile HMR 应用；
- `role('secret')` 阻止值进入表单响应；凭据类值用凭据引用，不要自己存。

### 9.7 工具卡片

内置 Web Client 不消费 Host 的 `presentCall/presentResult`。要有专用卡片：

```ts
ctx.slots.inject('tool.call.toolview', () =>
  ctx.slots.register({ name: 'tool.call.toolview', key: 'my_tool', locale: NS }, MyCard))
```

props 从 `ToolCallBlock` 的参数、内容、错误、metadata、`parentCallId` 派生；**必须本地校验 wire 值**，坏输入回退通用行。

### 9.8 图标与文案

```json
// locale/en.json
{ "meta": { "title": "Hello plugin", "description": "Adds a greet tool." } }
```

```json
// package.json 顶层
"icon": "./icon.svg"
```

- 图标：SVG/PNG/JPEG/WebP，≤256 KiB，必须在包内，不得指向目录外；
- 标题回退链：`locale meta.title` → 包根插件 `package.json.name` → Cordis 插件名；
- 描述回退链：`locale meta.description` → `package.json.description` → 不显示；
- 详情文档 `meta.detail` 指向包内子目录下的 Markdown（根目录文档会被拒绝，因为旁边的图片发布不出去）。

---

## 10. 打包、发布、安装

### 10.1 三个分发通道

| 方式 | 用户命令 | 代价 | 推荐度 |
|---|---|---|---|
| **npm 发布**（`prepublishOnly` 里构建好 `lib/`） | `dsh plugin add dsh-hello-plugin` | 无 | ★★★ |
| **tarball** | `dsh plugin add ./dsh-hello-plugin-0.1.0.tgz` | 无 | ★★ |
| **Git 直装** | `dsh plugin add github:you/dsh-hello-plugin#<sha>` | 拉**源码**，需 `prepare` + 用户授权构建脚本 | ★ |

Git 安装的两个必要条件（官方文档警告很重）：

1. 作者提供**自包含** `prepare` 脚本（不能假设旁边有 monorepo checkout）；
2. 用户把 pnpm 打印的包键写进 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-hello-plugin: true
```

> 这项授权等于「允许该包的代码在安装时于你的机器上执行，且不在 agent 沙箱内」。只对可信源码授权，并锁 commit。

### 10.2 发布前检查清单

```sh
pnpm typecheck                     # 类型
pnpm build                         # 产物
pnpm pack --dry-run                # ← 关键：确认 files 里没有 src / map / tsconfig
npx publint@latest                 # exports 与产物一致性（可选但强烈建议）
```

必须确认：

- [ ] `lib/index.js` 与 `lib/index.d.ts` 都在包里
- [ ] `cordis.patch.yml` 在包里（`files` 漏了它就白搭）
- [ ] `dsh.bundle.patch` 路径与实物一致
- [ ] `engines.dsh` 范围覆盖你要支持的版本
- [ ] peer 版本固定到具体版本号
- [ ] `README.md` 是给用户看的（插件页会渲染它）
- [ ] `locale/*.json` + `icon.svg` 若声明了就必须在 `files` 里

### 10.3 安装与验证

```sh
# 1) 装进 profile（不传 --profile 时用默认 profile）
dsh plugin --profile demo add dsh-hello-plugin

# 2) 只看层，不启动 —— 这一步能验证 90% 的配置错误
dsh --profile demo --dump-config

# 3) 启动
dsh --profile demo
```

`--dump-config` 的输出里应出现你的层：

```yaml
# == dsh-hello-plugin
- id: hello-plugin
  name: dsh-hello-plugin
  config:
    greeting: Hello
```

安装后 `dsh plugin` 会自动把声明了 `dsh.bundle` 的依赖追加进 `dsh.profile.bundles`：

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-hello-plugin"] } },
  "dependencies": { "dsh-hello-plugin": "link:/path/to/dsh-hello-plugin" }
}
```

卸载：

```sh
dsh plugin --profile demo remove dsh-hello-plugin   # 同时删依赖与该层
```

### 10.4 Web UI 安装路径

侧栏 →「插件」：

- **添加插件**：输入包名（可带版本）/ Git 地址 / 压缩包 / 本地**绝对**路径；
- 自动探测 npm 官方源与 npmmirror，选先响应的；
- 安装完成后可选「立即启用」；
- 箭头菜单里的「让 Agent 创建插件」**仅在装了 `ui-agent-preset` 时出现**；
- 第三方 bundle 的升级路径是**卸载后重装**（官方按需插件才有「更新」按钮）。

### 10.5 发布到 npm 的最小流程

```sh
pnpm build
npm version patch          # 或 minor
pnpm publish --access public
```

发布后：

- 给仓库加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic（被发现的主要渠道）；
- 在 release note 里写清「适用于 DSH `>=0.2.1-rc.2 <0.3.0`」。

---

## 11. 调试与测试

### 11.1 本地开发三件套

```sh
# ① 源码形态 + overlay（最快）
mkdir -p scratch-plugin/src
cat > scratch-plugin/cordis.yml <<'YAML'
- insert:
    - id: hello
      name: '/ABS/PATH/scratch-plugin/src/my-plugin.ts'   # 必须绝对路径
YAML
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

```sh
# ② 安装形态（验证交付物）
dsh plugin --profile demo add /abs/path/to/dsh-hello-plugin
dsh --profile demo --dump-config
dsh --profile demo
```

```sh
# ③ 只看合成配置（最快的失败定位手段）
dsh --profile demo --dump-config
dsh --profile demo --dump-default-config
```

### 11.2 日志：一个实测反直觉的点

**实测（0.2.1-rc.3，本机 web 启动）**：插件里 `ctx.logger.info/warn/error` 的输出**没有**出现在终端；同一位置的 `console.log` 立即可见。

所以：

- 排查「插件到底加载了吗」→ 用 `console.log('[x] loaded')`；
- 产品代码仍用 `ctx.logger`（结构化、可路由到 exporter），但**不要指望它一定出现在 stdout**；
- 需要长期可观测性时，自己接 `ctx.on('tools/result', ...)` 等事件落日志。

### 11.3 常见故障对照表

| 现象 | 根因 | 修法 |
|---|---|---|
| 装完没反应，`dsh plugin` 给了 warning | `package.json` 没有 `dsh.bundle` | 补 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` |
| 启动报模块找不到 | 发布物里没有 `lib/`（尤其 Git 直装） | 补 `prepare`/构建产物，或改发 tarball |
| `Cannot find type definition file for 'node'` | 缺 `@types/node` | `pnpm add -D @types/node` |
| `additionalProperties` 相关编译错 | 显式对象节点没写 `additionalProperties` | 补 `true` 或 `false` |
| `TS2322: string \| undefined not assignable` | 对象属性没标 `required: true` | 逐属性补 `required` |
| `value.greeting` 类型是对的但校验失败 | 同上，编译期与运行期用了同一份声明 | 同上 |
| 改了 config 没生效 | patch 替换整行 config，不是深合并 | 重述所有键，或只用 schema 默认值 |
| 插件卡在 PENDING | `inject` 的服务没人提供 | 去掉该依赖 / `ctx.get()` / 换 `ctx.inject` |
| HMR 后行为诡异 | 模块顶层可变状态 | 状态移到实例内或 `ctx.effect` |
| 工具能被调用但结果变成 `INVALID_TOOL_OUTPUT` | 返回值不匹配 `output.schema` | 对齐 schema 与返回值 |
| 两套 React / `instanceof` 失效 | 打包时没外部化 | `neverBundle: true` / 客户端 `neverBundle` 加 React |
| Web 卡片不出现 | 只写了 Host `presentCall` | 写客户端 `tool.call.toolview` slot |
| 客户端半边整个不挂 | patch 行用了子路径说明符 | 改为裸包名 |
| 从 Git 装报 prepare 被拒 | pnpm ≥10 默认拒绝构建脚本 | 在 profile `pnpm-workspace.yaml` 加 `allowBuilds` |
| `ctx.on('loader/volatile-update')` 报 TS2345 | 事件声明在 loader 包里 | `import type {} from '@deepseek-ai/cordis-plugin-loader'` |
| `register(tool, { when })` 报「Expected 1 arguments」 | 该版本没有条件工具重载 | 见 §2.3，降级为无条件注册或升级宿主 |
| `TS5097: An import path can only end with a '.ts' extension...` | 源码写 `./x.ts`，而声明构建关了 `allowImportingTsExtensions` | 相对导入去掉扩展名，或改用 tsdown `dts: true`（§3.3） |
| `TS6142: Module ... was resolved ... but '--jsx' is not set` | host 的声明构建把 `src/client/*.tsx` 也 include 了 | client 单独 `tsconfig.client.json`，host 构建 exclude `src/client`（§3.3） |
| `TS2322: Type '"scan"' is not assignable to type '"bash"'` | 自定义 job kind 没合并 `JobKindMap` | `declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { scan: 'scan' } }`（§8） |
| `TS2379: ... 'owner' is incompatible ... 'undefined'` | `exactOptionalPropertyTypes` 下直接传 `owner: exec.agent?.id` | 条件展开 `...(agent ? { owner: agent.id } : {})`（§8） |
| tsdown 报 `For the "external". Invalid type ... received true` | tsdown `0.22.2` 不接受 `neverBundle: true` | 升到 `^0.22.14`，或写 `neverBundle: [/^@deepseek-ai\//]`（§3.4） |
| 客户端 `ctx.slots` / `ctx.locale` 报「Property does not exist」 | 缺客户端包的 Context 合并 | 加 `import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'`（以及 locale/settings 的 `/client`）（§9.5） |
| 工具返回的字面量联合报 `Type 'string' is not assignable` | `status: 'running'` 被拓宽成 `string` | 字面量加 `as const`，或给 `execute` 标注返回类型（案例 7） |
| `dsh plugin add ./xxx` 找不到包 | 启动脚本的 `cd` 吃掉了相对路径 | 给**绝对路径**（§10.3） |

### 11.4 单元测试建议

插件本质是「装配 + 纯函数」，把两者拆开就很好测：

- **纯函数优先**：schema 转换、渲染、参数归一化 → 直接单测，不需要 Cordis。
- **服务逻辑**：把 `ctx` 的依赖以接口形式注入构造函数，用假实现替身。
- **集成**：用 `--patch` 起一个最小 profile，跑真实调用（DSH 仓库自带 `dsh-tool-testkit`，见 `packages/test-support/tool-testkit`）。

```ts
// 纯函数测试示例
import { describe, expect, it } from 'vitest'
import { toPreview } from '../src/preview.ts'

describe('toPreview', () => {
  it('truncates and reports totals', () => {
    expect(toPreview('x'.repeat(100), 10)).toMatchObject({ truncated: true, total: 100 })
  })
})
```

### 11.5 类型合并导入：聚合编译会掩盖缺失（实测教训）

本指南在验证阶段踩到一个**只在隔离编译时才暴露**的坑：

- 案例 3（`read_head`）用了 `ctx.fs`，但没有 `import type {} from '@deepseek-ai/dsh-fs'`；
- 案例 4（`command_policy`）用了 `ctx.tools.guard()` 与 `tools/pre-execute`，但没有 `import type {} from '@deepseek-ai/dsh-tools'`。

在**同一个工程里聚合编译**时，只要**别的文件** import 过这些包，声明合并就进入了整个程序，这两处不会报错；一旦把单个文件放进空工程，立刻 `TS2339: Property 'fs' does not exist on type 'Context'`。

**纪律**：

1. 每个插件文件都必须**自己声明它需要的类型合并**，不要依赖同工程其他文件的副作用；
2. 验证时至少做一次**隔离编译**：把 `src/index.ts` 单独复制到空目录 + 同一份 tsconfig，跑 `tsc --noEmit`；
3. 常见需要显式导入的类型合并：`dsh-fs`（`ctx.fs`）、`dsh-jobs`（`ctx.jobs` + `JobKindMap`）、`dsh-commands`（`ctx.commands`）、`dsh-tools`（`ctx.tools` + `tools/*` 事件）、`cordis-plugin-loader`（`loader/volatile-update`）、客户端四件套（`ctx.slots`/`ctx.locale`/slot 类型）。

---

## 12. 规范化清单（提交前逐项打勾）

### 12.1 结构

- [ ] `package.json` 有 `dsh.bundle.patch`，路径与实物一致
- [ ] `engines.dsh` 与 `engines.node` 明确
- [ ] dsh 包同时出现在 `peerDependencies` 与 `devDependencies`，版本固定
- [ ] `files` 精确（`lib` + patch + README + 资源），不含 `src`/map/tsconfig
- [ ] `exports` 只暴露构建产物与 `package.json`
- [ ] 构建配置 `neverBundle` 生效，且 `lib/index.js` 头部仍是真实 `import`

### 12.2 代码

- [ ] `name` 与包名一致；`inject` 最小化
- [ ] 每个文件自己声明所需的类型合并（`ctx.fs`/`ctx.jobs`/`ctx.commands`/`ctx.slots`），并通过**隔离编译**（§11.5）
- [ ] 所有可调参数进 `Config`，有默认值，有校验
- [ ] 外部资源全部走 `ctx.effect`，带 label
- [ ] 无模块顶层可变状态（HMR 安全）
- [ ] 工具：描述/参数描述齐全，`required` 标注正确，`output.schema` 与返回值一致
- [ ] 工具：转发 `exec.signal`；声明 `timeoutMs` 则必须能停稳
- [ ] 错误抛异常，不吞掉
- [ ] 事件带自有命名空间前缀
- [ ] 自定义 UI 文案走 locale 字典

### 12.3 交付

- [ ] `pnpm pack --dry-run` 检查通过
- [ ] 在一个全新 profile 里 `add` → `--dump-config` → 启动，三步都过
- [ ] 卸载后不留残余（`remove` 后 `--dump-config` 无你的层）
- [ ] README 写清：安装命令、配置项、兼容版本、卸载方式

---

## 13. 反模式清单（看到就该拒绝）

| 反模式 | 为什么错 | 正确做法 |
|---|---|---|
| 在工具里内建「谁可以调用」的策略 | 部署策略属于部署 | `tools/pre-execute` |
| 用 `console.log` 当产品日志 | 无法路由/分级 | `ctx.logger`（排查时再用 console） |
| `process.env` 直读当配置 | 不受 profile 管理、不可复现 | `Config` schema |
| 把 `@deepseek-ai/*` 打进产物 | 双实例、`instanceof` 失效 | `neverBundle` |
| `try { ... } catch {}` 吞错 | 模型看不到失败 | 抛异常 |
| `execute` 里返回内容块 | 破坏契约、PTC 无法解析 | 返回规范值 + `render` |
| 在 `render`/`presentCall` 里读文件 | 回放时会崩/不一致 | 纯函数 + `presentationMeta` |
| 顶层 `export const cache = new Map()` | HMR 后残留脏状态 | 实例内状态或 `ctx.effect` |
| 覆盖别人的 patch 行只写改动的键 | config 被整行替换 | 重述全部键 |
| 忘记 `engines.dsh` | 用户装到不兼容版本上炸 | 声明 SemVer 范围 |

---

## 14. 速查索引

### 14.1 导入速查

```ts
import type { Context, Volatile } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
// 只有用到 loader/* 事件时才需要：
import type {} from '@deepseek-ai/cordis-plugin-loader'
// 只有用到 exec.deferContext / MessageSourceMap 时才需要：
import type {} from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools/presentation'
import Schema from '@deepseek-ai/schemastery'
```

### 14.2 命令速查

```sh
npx @deepseek-ai/dsh@next web                    # 最新版（latest 标签落后）
pnpm dsh web --patch ./scratch-plugin/cordis.yml # 源码态 + overlay
dsh plugin --profile demo add <pkg|git|tgz|path> # 安装
dsh plugin --profile demo remove <pkg>           # 卸载
dsh --profile demo --dump-config                 # 看合成后的配置层
dsh --profile demo --dump-default-config         # 看默认配置
dsh --profile demo --from-default-profile web    # 用模板重建 profile
```

### 14.3 官方文档索引

- 中文文档站：<https://deepseek-harness.github.io/deepseek-harness/>
- 仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 第一个插件：`docs/user/develop/basic/index.zh.md`
- 开发一个工具：`docs/user/develop/basic/tool.zh.md`
- 工具编写参考（契约最全）：`docs/cookbook/adding-a-tool.zh.md`
- 插件配置：`docs/user/develop/basic/config.zh.md`
- 打包与安装：`docs/user/develop/basic/publish.zh.md`
- 生命周期：`docs/user/develop/framework/index.zh.md`
- 服务与事件：`docs/user/develop/framework/service.zh.md`、`events.zh.md`
- 能力分层：`docs/user/develop/practice/index.zh.md`
- 工具子系统（schema DSL 全表）：`docs/subsystems/tools.zh.md`
- 工具注册表实现：`packages/core/tools/README.zh.md`
- 客户端模块系统：`docs/subsystems/client-modules.zh.md`
- CLI 行为参考：`apps/cli/reference/README.zh.md`

### 14.4 本指南的验证记录

| 验证项 | 方法 | 结果 |
|---|---|---|
| 骨架可编译 | `tsc --noEmit`（对**发布包** `@deepseek-ai/dsh-tools@0.2.1-rc.3`，不是主干） | ✅ |
| 骨架可构建 | `tsdown`（`dts: true`） | ✅ 产出 `lib/index.js` + `lib/index.d.ts` |
| 客户端半边可编译 | 同上 + `@deepseek-ai/dsh-client-ui-settings/client` 等合并 | ✅ |
| 客户端 bundle 可构建 | `tsdown -c tsdown.client.config.ts` | ✅ `lib/client.js`，`node --check` 语法通过，banner 正确 |
| 客户端声明可产出 | `tsc -p tsconfig.client.json` | ✅ `lib/types/client/*.d.ts` |
| 打包内容正确 | `npm pack --dry-run` | ✅ 13 个文件，无 `src` / `tsconfig` |
| bundle 可安装 | `dsh plugin --profile demo add /abs/path` | ✅ 自动写入 `link:` 与 `dsh.profile.bundles` |
| 层可合成 | `dsh --profile demo --dump-config` | ✅ 出现 `# == dsh-hello-plugin` 层 |
| 可卸载 | `dsh plugin --profile demo remove` | ✅ 依赖与 `bundles` 条目同时清空 |
| 插件可加载 | 启动 web profile，观察 `apply` 内探针 | ✅ 打印 `[dsh-hello-plugin] loaded probe Hello` |
| 配置默认值生效 | patch 未给的键用 schema 默认 | ✅ |
| 10 个完整模块（含 4 个 hello 变体）+ 4 个配方 + 客户端三件套 | **逐块隔离编译**（每块单独放进空工程） | ✅ 全部通过（发布包 rc.3） |
| `register(def, { when })` | 探针同一工程 | ❌ 发布包无此重载（主干有）→ §2.3/§6.10 |
| `neverBundle: true` | tsdown `0.22.2` vs `0.22.14` | ⚠️ 0.22.2 构建失败，0.22.14 正常 → §3.4 |
| `ctx.logger` 可见性 | 同时打 info/warn/error 与 `console.log` | ⚠️ 仅 `console.log` 出现在终端 |
| 多文件 `.ts` 导入 + tsc 声明构建 | 复刻旧 `tsconfig.build.json` | ❌ `TS5097` → §3.3 已改为扩展名无关方案 |

---

### 14.5 最小工具插件全文（可直接落地）

```ts
// src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-hello-plugin'
export const inject = ['tools']

export interface Config {
  greeting: string
  verbose: boolean
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config): void {
  const greet = defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
      loud: { type: 'boolean', description: 'Uppercase the greeting' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          greeting: { type: 'string', required: true },
          length: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.greeting }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 10_000,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const text = `${config.greeting}, ${args.name}!`
      return {
        greeting: args.loud === true ? text.toUpperCase() : text,
        length: args.name.length,
      }
    },
  })

  ctx.tools.register(greet)

  if (config.verbose) {
    ctx.on('tools/result', (exec, result) => {
      if (exec.name !== 'greet') return
      const text = result.content.map(b => (b.type === 'text' ? b.text : '')).join('')
      ctx.logger.info('[dsh-hello-plugin] greet → %s', text.slice(0, 80))
    })
  }
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: hello-plugin
      name: dsh-hello-plugin
      config:
        greeting: Hello
        verbose: false
```

---

### 14.6 术语中英对照

| 中文 | 英文 | 含义 |
|---|---|---|
| 插件 | plugin | 导出 `apply` 的模块 |
| 组合包 | bundle | 带 `dsh.bundle.patch` 的 npm 包 |
| 配置档案 | profile | `$DSH_HOME/profiles/<name>` |
| 补丁层 | patch | 按行 insert/覆盖的 YAML |
| 光纤 | fiber | 插件实例作用域 |
| 副作用/效果 | effect | 可回收的注册句柄 |
| 注入 | inject | 声明依赖服务 |
| 规范值 | canonical value | `execute` 返回的 JSON |
| 渲染意图 | render intent | 工具的卡片声明 |
| 协作式取消 | cooperative cancellation | 通过 signal 请求停止 |

---

# 第二部分：完整案例库

> **这一部分解决什么问题**：第一部分是规范与契约，读完知道「该怎么做」；这一部分是**可直接复制的完整工程**，每个案例给出全部文件内容，不留 `...`、不留「自行补充」。
>
> **验证基线**：所有 `src/*.ts(x)` 均在 `@deepseek-ai/dsh-tools@0.2.1-rc.3`（**npm 发布包**，不是仓库主干）+ TypeScript 6.0.3 下通过 `tsc --noEmit`，且**每个模块单独放进空工程也能编译**（这一点很重要，见 §11.5）；案例 1 的完整工程另经 `tsdown 0.22.14` 构建、`npm pack --dry-run` 检查、`dsh plugin add` + `--dump-config` + `remove` 全链路验证。
>
> **使用方式**：选一个最接近你需求的案例 → 整包复制 → 改 `name` 与业务逻辑 → 按「验收」小节跑一遍。不要从零拼装。

## 案例总览

| # | 案例 | 展示能力 | 必需服务 | 新增依赖 | 规模 |
|---|---|---|---|---|---|
| 1 | `hello` | 最小工程、配置、工具、审计监听 | `tools` | 无 | 6 文件 |
| 2 | `regex_extract` | 结构化输出、截断、渲染、并发、超时 | `tools` | 无 | 1 文件 |
| 3 | `read_head` | 消费宿主服务、错误语义、字节上限 | `fs`、`tools` | `dsh-fs` | 1 文件 |
| 4 | `command_policy` | 策略钩子：pre / guard / post / result | `tools` | 无 | 1 文件 |
| 5 | `text_stats` | 提供服务、声明合并、消费方 | `tools` | 无 | 1 文件 |
| 6 | `ping` | 斜杠命令、UI 渲染结果 | `commands` | `dsh-commands` | 1 文件 |
| 7 | `index_files` | 后台任务、JobKindMap、取消语义 | `fs`、`jobs`、`tools` | `dsh-fs`、`dsh-jobs` | 1 文件 |
| 8 | `hello-settings` | Web 客户端半边、slot、locale、bundle | `slots`、`locale` | 4 个客户端包 + react | 4 文件 |
| 9 | `testing` | vitest、纯函数测试、假 ctx | — | `vitest` | 2 文件 |

---

## 案例 1：`hello` —— 最小可运行工程（全文）

**目标**：装进 profile 后，模型能看到并调用 `greet` 工具；配置里的 `greeting` 决定问候语。

### 1.1 文件树

```
dsh-hello-plugin/
├── package.json
├── cordis.patch.yml
├── tsconfig.json
├── tsdown.config.ts
├── README.md
└── src/
    └── index.ts
```

### 1.2 `package.json`（全文）

```jsonc
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "description": "Adds a greet tool to DeepSeek Harness.",
  "type": "module",
  "license": "MIT",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "dsh": ">=0.2.1-rc.2 <0.3.0", "node": ">=24.9.0" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.3",
    "@deepseek-ai/schemastery": "~3.18.5"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.3",
    "@deepseek-ai/schemastery": "~3.18.5",
    "@types/node": "^24.0.0",
    "tsdown": "^0.22.14",
    "typescript": "^6.0.3"
  },
  "scripts": {
    "build": "tsdown",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

> **三处不能错**：`"type": "module"`、`exports` 指向 `lib/`、`dsh.bundle.patch` 指向真实存在的 patch 文件。缺 `dsh.bundle` 时包能装但**不会成为配置层**。

### 1.3 `cordis.patch.yml`（全文）

```yaml
- insert:
    - id: hello-plugin
      name: dsh-hello-plugin
      config:
        greeting: Hello
        verbose: false
```

### 1.4 `tsconfig.json`（全文）

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tsdown.config.ts"]
}
```

### 1.5 `tsdown.config.ts`（全文）

```ts
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'lib',
  clean: true,
  sourcemap: true,
  dts: true,
  fixedExtension: false,
  deps: { neverBundle: true },
})
```

### 1.6 `src/index.ts`（全文）

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-hello-plugin'
export const inject = ['tools']

export interface Config {
  /** Prefix used by every greeting. */
  greeting: string
  /** Log each settled greet call. */
  verbose: boolean
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello')
    .description('Prefix used by every greeting.'),
  verbose: Schema.boolean().default(false)
    .description('Log each settled greet call.'),
})

export function apply(ctx: Context, config: Config): void {
  const greet = defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
      loud: { type: 'boolean', description: 'Uppercase the greeting' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          greeting: { type: 'string', required: true },
          length: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.greeting }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 10_000,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const text = `${config.greeting}, ${args.name}!`
      return {
        greeting: args.loud === true ? text.toUpperCase() : text,
        length: args.name.length,
      }
    },
  })

  ctx.tools.register(greet)

  if (config.verbose) {
    ctx.on('tools/result', (exec, result) => {
      if (exec.name !== 'greet') return
      const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
      ctx.logger.info('[dsh-hello-plugin] greet → %s', text.slice(0, 80))
    })
  }
}
```

### 1.7 `README.md`（全文）

````md
# dsh-hello-plugin

Adds a `greet` tool to DeepSeek Harness.

## Install

```sh
dsh plugin add dsh-hello-plugin
```

## Config

| Key | Type | Default | Meaning |
|---|---|---|---|
| `greeting` | string | `Hello` | Prefix used by every greeting |
| `verbose` | boolean | `false` | Log each settled greet call |

## Compatibility

DSH `>=0.2.1-rc.2 <0.3.0`, Node.js `>=24.9.0`.

## Uninstall

```sh
dsh plugin remove dsh-hello-plugin
```
````

### 1.8 验收（5 条命令）

```sh
pnpm install
pnpm typecheck                              # 0 error
pnpm build                                  # 产出 lib/index.js + lib/index.d.ts
dsh plugin --profile demo add "$PWD"        # 绝对路径！
dsh --profile demo --dump-config | head -8  # 应出现 # == dsh-hello-plugin
```

预期 `lib/`：

```
lib/index.js
lib/index.js.map
lib/index.d.ts
lib/index.d.ts.map
```

**判据**：`--dump-config` 出现你的层，且 `apply` 里的探针（可临时加 `console.log`）在启动时打印。

### 1.9 为什么这样写

| 设计点 | 原因 |
|---|---|
| `inject = ['tools']` | 只声明真正用到的服务；缺失时插件停在 PENDING 而不是崩 |
| `output.schema` 里 `required: true` | 不写会推导成 `string \| undefined`，`render` 里赋值直接 `TS2322` |
| `isConcurrencySafe: () => true` | 纯函数、无共享状态，允许与兄弟调用并行 |
| `timeoutMs: 10_000` | 声明即承诺：`execute` 里必须观测 `exec.signal` |
| `exec.signal.throwIfAborted()` | 已取消的调用立即返回，不做无用功 |
| 配置默认值写在 schema | patch 只覆盖想改的键，其余自动兜底 |
| `verbose` 才注册监听 | 不用的能力不注册，减少运行时开销 |

---

## 案例 2：`regex_extract` —— 结构化输出工具（全文）

**目标**：从内联文本中抽取正则匹配，返回**规范值**（结构化 JSON），并演示截断、渲染、展示元数据。

### 2.1 与案例 1 的差异

| 项 | 变化 |
|---|---|
| `package.json` | **不变**（仍只用 `cordis`/`dsh-tools`/`schemastery`） |
| `cordis.patch.yml` | `config` 换成 `maxMatches` / `maxPreviewChars` |
| `src/index.ts` | 全文替换为下面内容 |

```yaml
- insert:
    - id: hello-plugin
      name: dsh-hello-plugin
      config:
        maxMatches: 50
        maxPreviewChars: 4000
```

### 2.2 `src/index.ts`（全文）

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-regex-extract'
export const inject = ['tools']

export interface Config {
  /** Hard ceiling on matches returned per call. */
  maxMatches: number
  /** Characters of rendered preview before clipping. */
  maxPreviewChars: number
}

export const Config: Schema<Config> = Schema.object({
  maxMatches: Schema.number().step(1).min(1).max(1000).default(50)
    .description('Hard ceiling on matches returned per call.'),
  maxPreviewChars: Schema.number().step(1).min(100).default(4000)
    .description('Characters of rendered preview before clipping.'),
})

interface ExtractedMatch {
  value: string
  line: number
  index: number
}

/** 1-based line number of a UTF-16 offset, counting `\n` only. */
function lineOf(text: string, index: number): number {
  let line = 1
  const end = Math.min(index, text.length)
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 0x0a) line++
  }
  return line
}

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'regex_extract',
    description: 'Extract matches of a JavaScript regular expression from inline text, with 1-based line numbers. '
      + 'Returns at most max_matches matches and reports the untruncated total.',
    parameters: {
      text: { type: 'string', required: true, description: 'Inline text to search. Use read_head first for files.' },
      pattern: { type: 'string', required: true, description: 'Regex source without slashes, e.g. "ERROR\\s+\\w+".' },
      flags: { type: 'string', description: 'Regex flags such as "gi". A global flag is added automatically.' },
      max_matches: { type: 'number', description: 'Per-call cap; defaults to the plugin config.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                value: { type: 'string', required: true },
                line: { type: 'integer', required: true },
                index: { type: 'integer', required: true },
              },
            },
          },
          total: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const rows = value.matches.map(m => `${m.line}:${m.index}  ${m.value}`).join('\n')
        const preview = rows.length > config.maxPreviewChars
          ? `${rows.slice(0, config.maxPreviewChars)}\n…(preview clipped)`
          : rows
        const summary = value.truncated
          ? `Showing ${value.matches.length} of ${value.total} matches.`
          : `${value.total} match(es).`
        return [{ type: 'text', text: `${summary}\n\n${preview || '(no matches)'}` }]
      },
      presentationMeta: (_args, value) => ({ total: value.total, truncated: value.truncated }),
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const flags = args.flags ?? 'g'
      const source = flags.includes('g') ? flags : `${flags}g`
      const re = new RegExp(args.pattern, source)
      const limit = Math.max(1, Math.min(args.max_matches ?? config.maxMatches, config.maxMatches))

      const matches: ExtractedMatch[] = []
      let total = 0
      for (const match of args.text.matchAll(re)) {
        exec.signal.throwIfAborted()
        total++
        if (matches.length >= limit) continue
        matches.push({ value: match[0], line: lineOf(args.text, match.index), index: match.index })
      }
      return { matches, total, truncated: total > matches.length }
    },
  }))
}
```

### 2.3 验收

```sh
pnpm typecheck && pnpm build
dsh plugin --profile demo add "$PWD" && dsh --profile demo
# 在会话里让模型调用：
#   regex_extract({ text: "a1\nb22\nc333", pattern: "\\d+" })
# 期望规范值：{ matches: [{value:"1",line:1,index:1}, ...], total: 3, truncated: false }
```

### 2.4 设计要点

| 设计点 | 原因 |
|---|---|
| `total` 与 `truncated` 分开 | 程序调用（PTC）需要知道「还有多少没返回」，不能靠解析文本 |
| 截断在 **execute** 里做，不在 render | render 是展示层，截断属于数据语义；否则规范值仍是全量，内存不受控 |
| `render` 只做字符串拼接 | 纯函数、无 IO，回放安全 |
| `presentationMeta` 返回 `{ total, truncated }` | UI 可回放的小结，不必重算 |
| `pattern` 非法时**不 catch** | `new RegExp` 抛错 → 执行器转成普通错误结果，模型能看到原因 |
| 默认值注解 `max_matches` 不写 `default` | 该字段是**注解**，不会补值；真正的兜底在 `execute` 里 `?? config.maxMatches` |
| `maxMatches` 双重钳制 | 调用方传再大的数也不超过部署配置，防止一次调用打爆内存 |

---

## 案例 3：`read_head` —— 消费宿主服务（全文）

**目标**：通过宿主的 `fs` 服务读取文件头部若干行，演示「服务注入 + 元数据探测 + 上限拒绝 + 错误语义」。

### 3.1 `package.json` 差异

```jsonc
{
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.3",
    "@deepseek-ai/dsh-fs": "0.2.1-rc.3",        // ← 新增
    "@deepseek-ai/schemastery": "~3.18.5"
  },
  "devDependencies": {
    "@deepseek-ai/dsh-fs": "0.2.1-rc.3"         // ← 新增
  }
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: read-head
      name: dsh-read-head
      config:
        maxLines: 200
        maxFileBytes: 2097152
```

### 3.2 `src/index.ts`（全文）

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'        // ← 拉入 ctx.fs 的 Context 合并
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-read-head'
export const inject = ['fs', 'tools']

export interface Config {
  /** Default line budget when the call does not ask for one. */
  maxLines: number
  /** Refuse files larger than this instead of buffering them. */
  maxFileBytes: number
}

export const Config: Schema<Config> = Schema.object({
  maxLines: Schema.number().step(1).min(1).max(10_000).default(200)
    .description('Default line budget when the call does not ask for one.'),
  maxFileBytes: Schema.number().step(1).min(1).default(2 * 1024 * 1024)
    .description('Refuse files larger than this instead of buffering them.'),
})

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'read_head',
    description: 'Read the first N lines of a UTF-8 text file through the harness filesystem service. '
      + 'Refuses directories and files above the configured byte cap.',
    parameters: {
      path: { type: 'string', required: true, description: 'File path; relative paths resolve against the agent workspace.' },
      lines: { type: 'number', description: 'Line budget for this call; defaults to the plugin config.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          lines: { type: 'array', required: true, items: { type: 'string' } },
          truncated: { type: 'boolean', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const body = value.lines.map((line, i) => `${String(i + 1).padStart(4)}\t${line}`).join('\n')
        const tail = value.truncated ? '\n…(more lines available)' : ''
        return [{ type: 'text', text: `${value.path} (${value.bytes} bytes)\n${body}${tail}` }]
      },
      presentationMeta: (_args, value) => ({ path: value.path, lines: value.lines.length }),
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const target = await ctx.fs.resolve(args.path, { signal: exec.signal })
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined) throw new Error(`no such file: ${args.path}`)
      if (info.type === 'directory') throw new Error(`is a directory: ${args.path}`)
      if (info.type !== 'file') throw new Error(`not a regular file: ${args.path}`)
      if (info.size !== undefined && info.size > config.maxFileBytes) {
        throw new Error(`file is ${info.size} bytes, above the ${config.maxFileBytes}-byte cap: ${args.path}`)
      }

      const text = await ctx.fs.readText(target, exec.signal)
      const all = text.split('\n')
      const budget = Math.max(1, Math.min(args.lines ?? config.maxLines, config.maxLines))
      const lines = all.slice(0, budget)
      return {
        path: args.path,
        lines,
        truncated: all.length > lines.length,
        bytes: info.size ?? Buffer.byteLength(text, 'utf8'),
      }
    },
  }))
}
```

### 3.3 `fs` 服务速查（本案例用到的四个方法）

| 方法 | 签名 | 说明 |
|---|---|---|
| `resolve` | `(path, opts?: { cwd?, signal? }) => Promise<FsTarget>` | 相对路径按后端默认基准解析；返回**稳定 target**，后续操作都用它 |
| `stat` | `(target, signal?) => Promise<FsInfo \| undefined>` | `FsInfo = { version, type: 'file'\|'directory'\|'other', size? }`；不存在返回 `undefined` |
| `readText` | `(target, signal?) => Promise<string>` | 整文件按 UTF-8 解码；非文本会由后端拒绝 |
| `writeText` | `(target, content, expected?, signal?) => Promise<FsWriteOutcome>` | 原子写；`expected` 可做版本/存在性守卫 |

> **为什么不用 `node:fs`**：`ctx.fs` 是**可替换后端**（本地、远端、虚拟工作区），并且统一处理取消、编码与大小上限。直接 `node:fs` 会绕过这些，插件在非本部署形态下就失效。

### 3.4 验收

```sh
pnpm typecheck && pnpm build
dsh plugin --profile demo add "$PWD" && dsh --profile demo
# 调用：read_head({ path: "package.json", lines: 5 })
# 期望：前 5 行 + truncated: true
# 错误路径：
#   read_head({ path: "/nonexistent" })  → "no such file: ..."
#   read_head({ path: "." })             → "is a directory: ."
```

### 3.5 设计要点

| 设计点 | 原因 |
|---|---|
| 先 `stat` 再 `readText` | 目录/超限文件在读之前就拒绝，避免无谓 IO 与内存放大 |
| `size` 可能为 `undefined` | 后端不保证能报告大小，用 `?? Buffer.byteLength(...)` 兜底 |
| `maxFileBytes` 是**配置**不是常量 | 不同部署的文件规模不同；这就是 §5.4「无硬编码可调参数」 |
| 业务错误用 `throw` | 走 `isError: true` 通道，模型能看到原因（§6.5） |
| `truncated` 进规范值 | 程序调用方要能区分「读完了」和「还有」 |

---

## 案例 4：`command_policy` —— 策略插件（全文）

**目标**：不写任何工具，只在工具执行流水线上做四件事：**前拒绝**、**硬守卫**、**结果脱敏**、**审计**。这是「部署策略」类插件的标准骨架。

### 4.1 `package.json` 差异

**必须**声明 `@deepseek-ai/dsh-tools`（类型来自它的事件与 `ctx.tools` 合并），另加 `@deepseek-ai/dsh-llm` 供 `ContentBlock` 类型使用：

```jsonc
{
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.3",
    "@deepseek-ai/schemastery": "~3.18.5"
  },
  "devDependencies": {
    "@deepseek-ai/dsh-llm": "0.2.1-rc.3"
  }
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: command-policy
      name: dsh-command-policy
      config:
        deny: ['\\brm\\s+-[a-z]*r[a-z]*f\\s+/\\b']
        ask: ['\\bgit\\s+push\\b']
        redact: ['sk-[A-Za-z0-9]{8,}']
        audit: true
```

### 4.2 `src/index.ts`（全文）

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'   // ← 拉入 ctx.tools 与 tools/* 事件
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-command-policy'
export const inject = ['tools']

export interface Config {
  /** Regex sources; a matching shell command is denied before dispatch. */
  deny: string[]
  /** Regex sources; a matching shell command requires one-time approval. */
  ask: string[]
  /** Regex sources redacted from every model-facing result. */
  redact: string[]
  /** Emit one audit line per settled call. */
  audit: boolean
}

export const Config: Schema<Config> = Schema.object({
  deny: Schema.array(Schema.string()).default(['\\brm\\s+-[a-z]*r[a-z]*f\\s+/\\b'])
    .description('Regex sources; a matching shell command is denied before dispatch.'),
  ask: Schema.array(Schema.string()).default(['\\bgit\\s+push\\b'])
    .description('Regex sources; a matching shell command requires one-time approval.'),
  redact: Schema.array(Schema.string()).default(['sk-[A-Za-z0-9]{8,}'])
    .description('Regex sources redacted from every model-facing result.'),
  audit: Schema.boolean().default(true).description('Emit one audit line per settled call.'),
})

/** Extract the shell command from a `bash` call, if it is one. */
function shellCommand(name: string, args: unknown): string | undefined {
  if (name !== 'bash') return undefined
  const command = (args as { command?: unknown } | null)?.command
  return typeof command === 'string' ? command : undefined
}

function compileAll(sources: readonly string[]): RegExp[] {
  return sources.map(source => new RegExp(source, 'i'))
}

function redactText(text: string, patterns: readonly RegExp[]): string {
  return patterns.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED]'), text)
}

function redactBlocks(blocks: readonly ContentBlock[], patterns: readonly RegExp[]): ContentBlock[] {
  return blocks.map(block => (block.type === 'text'
    ? { type: 'text', text: redactText(block.text, patterns) }
    : block))
}

export function apply(ctx: Context, config: Config): void {
  const deny = compileAll(config.deny)
  const ask = compileAll(config.ask)
  const redact = compileAll(config.redact)

  ctx.on('tools/pre-execute', async (exec, next) => {
    const command = shellCommand(exec.name, exec.arguments)
    if (command === undefined) return next()

    if (deny.some(pattern => pattern.test(command))) {
      return { kind: 'deny', reason: `command denied by deployment policy: ${command}` }
    }
    if (ask.some(pattern => pattern.test(command))) {
      return {
        kind: 'ask',
        reason: `approval required for: ${command}`,
        displayReason: { en: `Run this command? ${command}`, zh: `要执行这条命令吗？${command}` },
      }
    }
    return next()
  })

  // Monotonic guard: no later listener can turn this denial back into permission.
  ctx.tools.guard((exec) => {
    const command = shellCommand(exec.name, exec.arguments)
    if (command === undefined) return undefined
    const destructive = /(^|[;&|]\s*)(mkfs(\.\w+)?|shutdown|reboot)\b/i
    return destructive.test(command) ? 'destructive host command is never allowed' : undefined
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept' || 'value' in decision) return decision
    const content = decision.content ?? result.content
    return { kind: 'accept', content: redactBlocks(content, redact) }
  })

  if (config.audit) {
    ctx.on('tools/result', (exec, result) => {
      ctx.logger.info('[command-policy] %s %s', exec.name, result.isError ? 'failed' : 'ok')
    })
  }
}
```

### 4.3 四个钩子的职责边界（本案例的映射）

| 钩子 | 本案例做什么 | 为什么放这一层 |
|---|---|---|
| `tools/pre-execute` | 正则匹配 → `deny` / `ask` | 部署策略，可被用户配置调整；允许别的监听器扩展 |
| `ctx.tools.guard()` | 破坏性命令**永不允许** | 单调守卫：返回拒绝后，任何后续监听器都无法翻案 |
| `tools/post-execute` | 文本块脱敏 | 结果已产出，需要改写模型可见内容 |
| `tools/result` | 审计日志 | 只观测，结果已冻结，不能改 |

### 4.4 验收

```sh
pnpm typecheck && pnpm build
dsh plugin --profile demo add "$PWD" && dsh --profile demo
# 让模型调用 bash: "rm -rf /"        → 被 deny，模型看到 reason
# 让模型调用 bash: "git push origin" → 弹一次性审批
# 让模型调用 bash: "echo sk-ABCD1234"→ 结果里显示 [REDACTED]
```

### 4.5 设计要点

| 设计点 | 原因 |
|---|---|
| `if (command === undefined) return next()` | 只处理 `bash`，其他工具原样放行，不做无谓开销 |
| `await next()` 后再改结果 | 先让下游策略处理，最后再做脱敏，顺序符合流水线语义 |
| `'value' in decision` 分支 | `PostToolDecision` 有两种 `accept`：带 `content` 与带 `value`，后者不能替换内容 |
| 正则 `'i'` 编译一次 | 每个请求不重复编译；配置变化会重载插件，闭包自然重建 |
| 审计走 `ctx.logger` | 结构化、可路由到 exporter；排查时再加 `console.log`（见 §11.2） |
| 不把策略写进工具本体 | 工具负责「执行」，策略是「部署选择」（§13 反模式第 1 条） |

---

## 案例 5：`text_stats` —— 提供服务（全文）

**目标**：定义一个 `textStats` 服务供**其他插件**消费，同时自己注册一个工具作为首个消费者。演示 `Service` 基类、声明合并、实例状态。

### 5.1 `package.json` 差异

无新增依赖。

```yaml
# cordis.patch.yml
- insert:
    - id: text-stats
      name: dsh-text-stats
```

### 5.2 `src/index.ts`（全文）

```ts
import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-text-stats'
export const inject = ['tools']

/** Public shape of the `textStats` service. */
export interface TextStats {
  chars: number
  words: number
  lines: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    textStats: TextStatsService
  }
}

/**
 * Counts text metrics and memoizes recent inputs. State lives on the instance,
 * so an HMR reload starts clean.
 */
export class TextStatsService extends Service {
  private readonly cache = new Map<string, TextStats>()

  constructor(ctx: Context) {
    super(ctx, 'textStats')
  }

  /** @returns metrics for `text`, reusing a cached result when possible. */
  analyze(text: string): TextStats {
    const cached = this.cache.get(text)
    if (cached !== undefined) return cached

    const trimmed = text.trim()
    const stats: TextStats = {
      chars: text.length,
      words: trimmed === '' ? 0 : trimmed.split(/\s+/u).length,
      lines: text === '' ? 0 : text.split('\n').length,
    }
    if (this.cache.size >= 128) this.cache.clear()
    this.cache.set(text, stats)
    return stats
  }
}

export function apply(ctx: Context): void {
  // The service registers itself on construction and unregisters with this fiber.
  ctx.plugin(TextStatsService)

  ctx.tools.register(defineTool({
    name: 'text_stats',
    description: 'Count characters, whitespace-separated words, and lines in the given text.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to measure; empty string is allowed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chars: { type: 'integer', required: true },
          words: { type: 'integer', required: true },
          lines: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.chars} chars, ${value.words} words, ${value.lines} lines`,
      }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 5_000,
    async execute(args) {
      return ctx.textStats.analyze(args.text)
    },
  }))
}
```

### 5.3 另一个插件如何消费（片段）

```ts
// 片段：消费方必须依赖提供方的类型（下例假定提供方包名为 dsh-text-stats）
// 任意其他插件：src/consumer.ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-text-stats'      // ← 带入 ctx.textStats 的声明合并

export const name = 'dsh-text-stats-consumer'
export const inject = ['textStats']       // 缺失时停在 PENDING，不报错

export function apply(ctx: Context): void {
  ctx.logger.info('[consumer] words = %d', ctx.textStats.analyze('hello world').words)
}
```

> 如果提供方和消费方在**同一个包**里，直接 `import type {} from './index'` 或干脆不拆文件即可；跨包时必须把提供方列进消费方的 `dependencies`（或 `peerDependencies`），否则类型合并不会生效。

### 5.4 服务契约的三条规则

1. **`super(ctx, 'textStats')` 的第二参就是 `ctx.<key>`**，同时也是 `inject` 里写的名字；两者必须一致。
2. **声明合并是类型层的事**，运行期不会自动生成属性；漏了 `declare module '@deepseek-ai/cordis'` 就只有运行期能用、类型报错。
3. **服务随 Fiber 自动注销**：`ctx.plugin(TextStatsService)` 的子 Fiber 被卸载时，`ctx.textStats` 同时消失；消费方插件会被自动 dispose 并等待服务回来。

### 5.5 验收

```sh
pnpm typecheck && pnpm build
dsh plugin --profile demo add "$PWD" && dsh --profile demo
# 调用 text_stats({ text: "a b\nc" }) → 6 chars, 3 words, 2 lines
```

### 5.6 设计要点

| 设计点 | 原因 |
|---|---|
| 缓存放在**实例字段** | 模块顶层 `const cache` 会在 HMR 后残留脏数据（§4.5） |
| 缓存上限 128，满了 `clear()` | 不让「性能优化」变成内存泄漏；简单策略足够 |
| 服务类不声明 `static inject` | 它不依赖其他服务；有依赖时再加 |
| `ctx.plugin(TextStatsService)` 而非直接 `new` | 走 Cordis 生命周期，卸载可回收 |
| 同一个包里既提供服务又消费它 | 合法且常见；拆分只在需要独立演进时做（§1.5） |

---

## 案例 6：`ping` —— 斜杠命令（全文）

**目标**：注册 `/ping` 与 `/whoami` 两个命令。命令结果**由 UI 直接渲染**，不进模型上下文。

### 6.1 `package.json` 差异

```jsonc
{
  "peerDependencies": { "@deepseek-ai/dsh-commands": "0.2.1-rc.3" },   // ← 新增
  "devDependencies": { "@deepseek-ai/dsh-commands": "0.2.1-rc.3" }     // ← 新增
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: ping-command
      name: dsh-ping-command
      config:
        reply: pong
```

### 6.2 `src/index.ts`（全文）

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-ping-command'
export const inject = ['commands']

export interface Config {
  /** Text returned when the command is invoked without input. */
  reply: string
}

export const Config: Schema<Config> = Schema.object({
  reply: Schema.string().default('pong').description('Text returned when the command is invoked without input.'),
})

export function apply(ctx: Context, config: Config): void {
  ctx.commands.register({
    name: 'ping',
    description: 'Reply with a one-line liveness check.',
    input: { hint: '[text]' },
    handler(invocation) {
      // Commands are UI-rendered: the result never enters model context.
      if (invocation.signal.aborted) return { kind: 'error', text: 'cancelled' }
      const target = invocation.rawInput.trim()
      return { kind: 'success', text: target === '' ? config.reply : `${config.reply} ${target}` }
    },
  })

  ctx.commands.register({
    name: 'whoami',
    description: 'Show the current agent and command identity.',
    handler(invocation) {
      return { kind: 'success', text: `agent=${invocation.agent.id} command=${invocation.commandId}` }
    },
  })
}
```

### 6.3 `CommandDefinition` 全字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 小写、不带前导斜杠；正则要求 `[a-z][a-z0-9_-]*` |
| `description` | ✅ | 发现列表里的一行摘要 |
| `handler` | ✅ | `(invocation) => CommandResult \| Promise<CommandResult>`；属性名是 `handler`，**不是** `run` |
| `input.hint` | — | 输入框占位符 |
| `input.attachments` | — | 允许附件；不声明时执行器会拒绝带附件的调用 |
| `recordInput` | — | 是否把 `rawInput` 写进 `command/run` 事件，默认 `true` |
| `definitionId` | — | 需要客户端按 id 定制行为时提供 |

`CommandInvocation` 给你：`commandId`、`agent`、`rawInput`（含分隔空白的原文）、`attachments`、`signal`。

### 6.4 验收

```sh
pnpm typecheck && pnpm build
dsh plugin --profile demo add "$PWD" && dsh --profile demo
# 输入 /ping        → "pong"
# 输入 /ping 你好    → "pong 你好"
# 输入 /whoami      → "agent=<session-id> command=<id>"
```

### 6.5 设计要点

| 设计点 | 原因 |
|---|---|
| `import type {} from '@deepseek-ai/dsh-commands'` | `ctx.commands` 的类型来自该包的声明合并；不导入就 `TS2339` |
| `inject = ['commands']` | 服务缺失时插件等待，而不是崩 |
| 检查 `invocation.signal.aborted` | 用户可能已取消提交；UI 结果就别再渲染了 |
| `rawInput` 不 trim 就拼 | 保留用户原样输入（含前导空格）；需要干净值时自己 `trim()` |
| 命令结果不进模型上下文 | 这是命令与工具的根本区别；想让模型看见，请写工具 |

---

## 案例 7：`index_files` —— 后台任务（全文）

**目标**：扫描目录树统计文件数；前台直接返回，后台用 `ctx.jobs` 跑并支持 `job_output`/`job_kill`。演示 `JobKindMap`、取消信号归属、进度推送。

### 7.1 `package.json` 差异

```jsonc
{
  "peerDependencies": {
    "@deepseek-ai/dsh-fs": "0.2.1-rc.3",
    "@deepseek-ai/dsh-jobs": "0.2.1-rc.3"      // ← 新增
  },
  "devDependencies": {
    "@deepseek-ai/dsh-fs": "0.2.1-rc.3",
    "@deepseek-ai/dsh-jobs": "0.2.1-rc.3"      // ← 新增
  }
}
```

> 运行期还需要组合里挂了 **job controller**（`@deepseek-ai/dsh-tool-jobs`），否则 `ctx.jobs.start` 会抛 `background jobs unavailable: no job controller serves this agent`。

```yaml
# cordis.patch.yml
- insert:
    - id: index-files
      name: dsh-index-files
      config:
        maxEntries: 5000
```

### 7.2 `src/index.ts`（全文）

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-index-files'
export const inject = ['fs', 'jobs', 'tools']

// Job kinds are a closed, merge-extensible union: a new producer must register its own.
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    scan: 'scan'
  }
}

export interface Config {
  /** Directory entries visited before the scan stops early. */
  maxEntries: number
}

export const Config: Schema<Config> = Schema.object({
  maxEntries: Schema.number().step(1).min(1).default(5000)
    .description('Directory entries visited before the scan stops early.'),
})

interface ScanResult {
  files: number
  dirs: number
  truncated: boolean
}

/** Breadth-first directory walk that reports progress through a callback. */
async function scan(
  ctx: Context,
  root: FsTarget,
  budget: number,
  signal: AbortSignal,
  onProgress?: (line: string) => void,
): Promise<ScanResult> {
  const queue: FsTarget[] = [root]
  let files = 0
  let dirs = 0
  let visited = 0

  while (queue.length > 0) {
    signal.throwIfAborted()
    const dir = queue.shift()
    if (dir === undefined) break
    const entries = await ctx.fs.listDir(dir, signal)
    for (const entry of entries) {
      if (visited >= budget) return { files, dirs, truncated: true }
      visited++
      if (entry.type === 'directory') {
        dirs++
        queue.push(entry.target)
      } else if (entry.type === 'file') {
        files++
        onProgress?.(`${files} files in ${dirs} dirs`)
      }
    }
  }
  return { files, dirs, truncated: false }
}

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'index_files',
    description: 'Count files and directories under a path, in the foreground or as a background job. '
      + 'Pass run_in_background=true for large trees and read progress with job_output.',
    parameters: {
      root: { type: 'string', required: true, description: 'Directory to scan; relative paths resolve against the workspace.' },
      run_in_background: { type: 'boolean', description: 'Start a background job and return its id immediately.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['completed', 'running'] },
          job_id: { type: 'string' },
          files: { type: 'integer' },
          dirs: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => (value.status === 'running'
        ? [{ type: 'text', text: `Started background scan: ${value.job_id ?? '(no id)'}` }]
        : [{
            type: 'text',
            text: `${value.files ?? 0} files in ${value.dirs ?? 0} directories`
              + `${value.truncated === true ? ' (entry budget reached)' : ''}`,
          }]),
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const root = await ctx.fs.resolve(args.root, { signal: exec.signal })
      const info = await ctx.fs.stat(root, exec.signal)
      if (info === undefined) throw new Error(`no such path: ${args.root}`)
      if (info.type !== 'directory') throw new Error(`not a directory: ${args.root}`)

      if (args.run_in_background === true) {
        const jobId = ctx.jobs.start({
          kind: 'scan',
          label: `scan ${args.root}`,
          ...(exec.agent === undefined ? {} : { owner: exec.agent.id }),
          outputLimitBytes: 64 * 1024,
          run(job) {
            // The job owns its cancellation: exec.signal must not kill published work.
            const controller = new AbortController()
            const done = (async (): Promise<JobOutcome> => {
              try {
                const result = await scan(ctx, root, config.maxEntries, controller.signal,
                  line => job.updateProgress(line))
                job.append(`done: ${result.files} files, ${result.dirs} dirs\n`)
                return { status: 'completed', result: JSON.stringify(result) }
              } catch (error) {
                return { status: 'failed', detail: error instanceof Error ? error.message : String(error) }
              }
            })()
            return { cancel: (reason?: string) => controller.abort(reason), done }
          },
        })
        return { status: 'running' as const, job_id: jobId }
      }

      const result = await scan(ctx, root, config.maxEntries, exec.signal)
      return { status: 'completed' as const, files: result.files, dirs: result.dirs, truncated: result.truncated }
    },
  }))
}
```

### 7.3 三个必须记住的点

1. **`kind` 要先合并 `JobKindMap`**：`JobKind` 是 `JobKindMap[keyof JobKindMap]` 的联合，内置只有 `bash`；不合并就是 `TS2322`。
2. **`owner` 用条件展开**：`exactOptionalPropertyTypes` 下 `owner: exec.agent?.id` 报 `TS2379`。
3. **`status` 字面量要 `as const`**：否则被拓宽成 `string`，与 `enum: ['completed','running']` 推导出的联合不兼容。

### 7.4 取消语义（最容易写反的地方）

| 阶段 | 该用哪个信号 | 原因 |
|---|---|---|
| `run()` 之前（`resolve`/`stat`） | `exec.signal` | 前台准备阶段，调用方取消就该停 |
| `run()` 内部 | **job 自己的 `controller.signal`** | 任务已发布，`job_kill`/owner 处置才是它的生命周期 |
| 前台分支 | `exec.signal` | 没有 job，跟着调用方走 |

> 反例：在 `run()` 里用 `exec.signal`。调用方一旦不再等待（例如用户切走），已发布的工作会被误杀。

### 7.5 验收

```sh
pnpm typecheck && pnpm build
dsh plugin --profile demo add "$PWD" && dsh --profile demo
# 前台：index_files({ root: "." })                       → "N files in M directories"
# 后台：index_files({ root: ".", run_in_background: true }) → { status: "running", job_id: "scan-..." }
# 然后让模型调用 job_output / job_kill 操作该 id
```

### 7.6 设计要点

| 设计点 | 原因 |
|---|---|
| `job.append(...)` 只写摘要 | 输出环有字节上限；大结果用 `result` 字段而非流 |
| `job.updateProgress(...)` 每文件一次 | 进度行是覆盖式 UI 状态，不占输出字节 |
| `scan` 是独立纯逻辑函数 | 前台/后台共用，且可单独测试 |
| `truncated` 来自 entry 预算 | 防止一次扫描把大仓库走穿；上限是配置项 |
| 返回 `job_id` 而不是文本 | PTC 程序能直接拿 id，不用解析自然语言（§6.9） |

---

## 案例 8：`hello-settings` —— Web 客户端半边（全文）

**目标**：在设置页加一个「问候」分区。演示客户端 bundle 构建、slot 注册、locale 字典、以及 host/client 两套 Context 的隔离。

> 这个案例建立在案例 1 之上（同一个包加半边）。**只有需要新 UI 时才写客户端**，纯工具插件不要写。

### 8.1 `package.json` 差异（全文替换 `exports`/`dsh`/依赖）

```jsonc
{
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  },
  "scripts": {
    "build": "tsdown && tsdown -c tsdown.client.config.ts && tsc -p tsconfig.client.json",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

```jsonc
// devDependencies 追加（npm 发布包，注意别用 latest 标签）
{
  "@deepseek-ai/dsh-client-locale": "0.2.1-rc.3",
  "@deepseek-ai/dsh-client-ui-renderer": "0.2.1-rc.3",
  "@deepseek-ai/dsh-client-ui-settings": "0.2.1-rc.3",
  "@deepseek-ai/dsh-client-ui-slots": "0.2.1-rc.3",
  "@types/react": "^19.0.0",
  "react": "^19.0.0"
}
```

### 8.2 `tsconfig.client.json`（全文）

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "declarationMap": true,
    "emitDeclarationOnly": true,
    "outDir": "lib/types/client",
    "rootDir": "src/client",
    "noEmit": false
  },
  "include": ["src/client"]
}
```

> 根 `tsconfig.json` 必须加 `"jsx": "react-jsx"` 与 `"lib": ["ES2022", "DOM"]`，否则 `.tsx` 报 `TS6142`。

### 8.3 `src/client/locales.ts`（全文）

```ts
export const en = {
  nav: 'Hello',
  title: 'Hello plugin',
  body: 'This section is contributed by dsh-hello-plugin.',
}
export const zh = {
  nav: '问候',
  title: '问候插件',
  body: '本节由 dsh-hello-plugin 提供。',
}
export type HelloLocaleKey = keyof typeof en
```

### 8.4 `src/client/HelloSection.tsx`（全文）

```tsx
import { createElement, type ReactElement } from 'react'
import { en } from './locales'

export function HelloSection(): ReactElement {
  return createElement('section', { className: 'hello-section' },
    createElement('h2', null, en.title),
    createElement('p', null, en.body))
}
```

### 8.5 `src/client/index.tsx`（全文）

```tsx
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { HelloSection } from './HelloSection'
import { en, zh, type HelloLocaleKey } from './locales'

export const NS = 'dsh-hello-plugin'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-hello-plugin': HelloLocaleKey
  }
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-hello-plugin: dictionaries')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'hello',
    order: 16,
    label: () => t('nav'),
    locale: NS,
  }, HelloSection))
}
```

### 8.6 `tsdown.client.config.ts`（全文）

```ts
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  outDir: 'lib',
  clean: false,
  sourcemap: true,
  dts: false,
  deps: {
    neverBundle: [
      'react',
      'react/jsx-runtime',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-slots',
    ],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-hello-plugin", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
```

### 8.7 四个 `import type {}` 各自负责什么

| 导入 | 提供 | 漏了会怎样 |
|---|---|---|
| `dsh-client-ui-renderer/client` | `ctx.slots` 的 Context 合并 | `TS2339: Property 'slots' does not exist` |
| `dsh-client-locale/client` | `ctx.locale` | `TS2339: Property 'locale' does not exist` |
| `dsh-client-ui-settings/client` | `'settings.section'` 的 SlotMap 条目与 props | slot 名不在联合里，`register` 报类型错 |
| `dsh-client-ui-slots` | `LocaleNamespaceMap` 的合并目标 | 声明合并找不到模块 |

### 8.8 验收

```sh
pnpm typecheck            # host + client 一起过
pnpm build                # 三步：host → client → client d.ts
node --check lib/client.js
find lib -type f | sort
dsh plugin --profile demo add "$PWD" && dsh --profile demo
# 打开设置页，应出现「问候」分区，点进去看到标题与正文
```

预期产物：

```
lib/index.js
lib/index.js.map
lib/index.d.ts
lib/index.d.ts.map
lib/client.js
lib/client.js.map
lib/types/client/index.d.ts
lib/types/client/HelloSection.d.ts
lib/types/client/locales.d.ts
```

### 8.9 设计要点

| 设计点 | 原因 |
|---|---|
| `banner` 的 `id` = 包名 | 客户端模块表按包名登记；写错则半边挂不上 |
| patch 行写**裸包名** | Host 只给「说明符恰好等于包名」的行挂半边（§9.4） |
| `clean: false` + 固定顺序 | host 构建 `clean: true` 会删 `lib`，client 必须后跑 |
| 字典放进 `locale` 选项 | 组件拿到绑定的 `t`，文案随语言切换 |
| 组件不读全局状态 | slot 组件会被重渲染/回放，纯展示最稳 |

---

## 案例 9：`testing` —— 单元测试（全文）

**目标**：不启动 DSH，直接测插件的「装配 + 工具逻辑」。这是投入产出比最高的一层测试。

### 9.1 `package.json` 差异

```jsonc
{
  "devDependencies": {
    "vitest": "^3.2.7"
  },
  "scripts": {
    "test": "vitest run"
  }
}
```

> **实测坑**：测试里 `import { defineTool } from '@deepseek-ai/dsh-tools'` 会加载真实运行时，它的 peer 闭包必须装齐，否则报
> `Cannot find package '@deepseek-ai/dsh-scope' imported from .../dsh-tools/lib/index.js`。
> 需要：`dsh-scope`、`dsh-sandbox`、`dsh-ptc-runtime`、`dsh-system-prompt`、`dsh-user-approval`、`dsh-sandbox-policy`、`dsh-working-directory`、`dsh-util-values`（外加 `dsh-llm`/`dsh-agent`/`dsh-session`）。全部用 `0.2.1-rc.3`。

### 9.2 `vitest.config.ts`（全文）

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/**/*.spec.ts'] },
})
```

### 9.3 `tests/regex-extract.spec.ts`（全文，实测 2/2 通过）

```ts
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index'

/** Minimal stand-in for the parts of ctx this plugin touches. */
function fakeCtx(): { ctx: Context, registered: unknown[] } {
  const registered: unknown[] = []
  const ctx = {
    tools: {
      register: (definition: unknown) => { registered.push(definition); return () => {} },
    },
    on: () => () => {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }
  return { ctx: ctx as unknown as Context, registered }
}

const exec = { signal: new AbortController().signal }

describe('regex_extract', () => {
  it('reports matches with 1-based line numbers', async () => {
    const { ctx, registered } = fakeCtx()
    apply(ctx, { maxMatches: 10, maxPreviewChars: 4000 })
    expect(registered).toHaveLength(1)

    const tool = registered[0] as { execute: (a: unknown, e: unknown) => Promise<unknown> }
    const value = await tool.execute({ text: 'a1\nb22\nc333', pattern: '\\d+' }, exec)
    expect(value).toEqual({
      matches: [
        { value: '1', line: 1, index: 1 },
        { value: '22', line: 2, index: 4 },
        { value: '333', line: 3, index: 8 },
      ],
      total: 3,
      truncated: false,
    })
  })

  it('caps matches and reports the untruncated total', async () => {
    const { ctx, registered } = fakeCtx()
    apply(ctx, { maxMatches: 2, maxPreviewChars: 4000 })
    const tool = registered[0] as { execute: (a: unknown, e: unknown) => Promise<unknown> }
    const value = await tool.execute({ text: '1 2 3 4', pattern: '\\d' }, exec) as {
      matches: unknown[]; total: number; truncated: boolean
    }
    expect(value.matches).toHaveLength(2)
    expect(value.total).toBe(4)
    expect(value.truncated).toBe(true)
  })
})
```

### 9.4 测什么、不测什么

| 层次 | 建议 | 做法 |
|---|---|---|
| 纯函数（行号、截断、格式化） | ✅ 必测 | 直接 import 单测 |
| 工具 `execute` 的规范值 | ✅ 必测 | 假 `ctx` + 取出注册的 definition 调用 |
| 参数 schema 的接受/拒绝 | ⭕ 可选 | 传非法参数断言 reject |
| Cordis 生命周期（PENDING/卸载） | ❌ 别自己造 | 用真实 profile 启动验证 |
| 客户端 UI | ⭕ 组件测试 | 需要 jsdom + Testing Library，另配 |

### 9.5 `fakeCtx` 的边界

- 只实现**本插件真正调用**的成员（这里是 `tools.register`、`on`、`logger`）；
- 用 `as unknown as Context` 是**刻意的类型逃逸**，因为完整 Context 无法手造；测试文件名带 `.spec.ts` 便于评审识别；
- 一旦插件开始用 `ctx.fs` 等更复杂的服务，**优先抽纯函数**，而不是继续堆假实现。

---

# 第三部分：配方库

> 每个配方都是可独立编译的最小完整模块。放进 `src/` 任一路径即可用。

## 配方 1：写文件（`fs.writeText`）

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'      // ← 拉入 ctx.fs 的 Context 合并
import { defineTool } from '@deepseek-ai/dsh-tools'

export function registerWriteNote(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'write_note',
    description: 'Create or replace a UTF-8 text file with the given content.',
    parameters: {
      path: { type: 'string', required: true, description: 'Target path; relative paths resolve against the workspace.' },
      content: { type: 'string', required: true, description: 'Full new file content.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          operation: { type: 'string', required: true, enum: ['create', 'update'] },
          bytes: { type: 'integer', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: `${v.operation}d ${v.path} (${v.bytes} bytes)` }],
    },
    timeoutMs: 15_000,
    async execute(args, exec) {
      const target = await ctx.fs.resolve(args.path, { signal: exec.signal })
      const outcome = await ctx.fs.writeText(target, args.content, undefined, exec.signal)
      return { path: args.path, operation: outcome.operation, bytes: Buffer.byteLength(args.content, 'utf8') }
    },
  }))
}
```

## 配方 2：二选一参数（`oneOf`）

```ts
parameters: {
  target: {
    type: 'oneOf',
    required: true,
    description: 'Either { path } or { id }.',
    oneOf: [
      { type: 'object', additionalProperties: false,
        properties: { path: { type: 'string', required: true } } },
      { type: 'object', additionalProperties: false,
        properties: { id: { type: 'string', required: true } } },
    ],
  },
},
async execute(args) {
  const target = args.target
  return 'path' in target
    ? { kind: 'path' as const, value: target.path }
    : { kind: 'id' as const, value: target.id }
}
```

## 配方 3：自定义事件（声明合并 + emit/on）

```ts
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'recipe/heartbeat'(tick: number): void
  }
}

export function startHeartbeat(ctx: Context, intervalMs: number): void {
  ctx.effect(() => {
    let tick = 0
    const timer = setInterval(() => {
      tick++
      ctx.emit('recipe/heartbeat', tick)
    }, intervalMs)
    return () => clearInterval(timer)
  }, 'recipe: heartbeat timer')

  ctx.on('recipe/heartbeat', (tick) => {
    ctx.logger.debug('[recipe] heartbeat #%d', tick)
  })
}
```

命名空间前缀（`recipe/`）是你自己的，别占用 `tools/`、`agent/`、`session/` 等内置前缀。

## 配方 4：定时器与清理

见配方 3 的 `ctx.effect` 形态。三条纪律：

1. 任何 `setInterval`/`setTimeout`/socket/listener 都必须包在 `ctx.effect` 返回的 disposer 里；
2. disposer 要幂等（重复调用不抛）；
3. 有顺序依赖的清理放进**同一个** disposer 里串行 `await`（§1.3）。

## 配方 5：按代理限制工具（`tools.restrict`）

```ts
import type { Context } from '@deepseek-ai/cordis'

export function restrictBashPerAgent(ctx: Context): void {
  ctx.on('agent/created', ({ agent }) => {
    // agent.ctx 是 agent 作用域：只影响这一个代理，随其处置自动解除
    agent.ctx.effect(() => agent.ctx.tools.restrict({ deny: ['bash'] }), 'recipe: restrict bash')
  })
}
```

> `ctx.tools.restrict` 在**全局上下文**调用会抛错（会遮蔽所有代理），必须挂在 `agent.ctx` 上。`allow` 与 `deny` 至少给一个。

## 配方 6：复合工具（工具内调用另一个工具）

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export function registerCountHead(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'count_head_lines',
    description: 'Read the head of a file and count its lines via read_head.',
    parameters: {
      path: { type: 'string', required: true, description: 'File path.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          lines: { type: 'integer', required: true },
          preview: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: `${v.lines} lines\n${v.preview}` }],
    },
    async execute(args, exec) {
      const result = await ctx.tools.execute({
        callId: `nested-${exec.callId}` as ToolCallId,   // 必须换 id，不能复用
        name: 'read_head',
        arguments: { path: args.path, lines: 20 },
        ...(exec.agent === undefined ? {} : { agent: exec.agent }),
        signal: exec.signal,                              // 取消必须透传
      })
      if (result.isError) throw new Error(result.error.message)
      const value = result.value as { lines: string[] }
      return { lines: value.lines.length, preview: value.lines.slice(0, 3).join('\n') }
    },
  }))
}
```

要点：`tools.execute` 走**完整策略流水线**（pre/guard/post 都会生效），不是直接调函数；失败返回 `isError`，要自己转成异常或规范值。

---

# 附录 A：任务 → 案例对照

| 你要做的事 | 直接抄 |
|---|---|
| 加一个简单工具 | 案例 1 |
| 工具要返回结构化数据给程序用 | 案例 2 |
| 工具要读宿主文件 | 案例 3 |
| 要拦截/审计/脱敏工具调用 | 案例 4 |
| 想让别的插件复用你的能力 | 案例 5 |
| 要加 `/命令` | 案例 6 |
| 长任务、后台跑 | 案例 7 |
| 要改 Web UI | 案例 8 |
| 想写单测 | 案例 9 |
| 写文件 / 二选一参数 / 自定义事件 / 定时器 / 限制工具 / 调别的工具 | 配方 1–6 |

---

> **维护提示**：本指南绑定 `0.2.1-rc.3`。DSH 处于 preview 阶段（`alpha`/`rc` 交错发布），升级前先读 `docs/upgrade-guide/<version>/` 下对应条目 —— 那里是唯一权威的破坏性变更说明。
>
> **对 AI Agent 的使用提示**：本文件的「完整案例」可直接整段落盘；第一部分的「版本敏感」标记（§2.3、§6.10、§3.4）在动手前必须先用 `grep` 核对本机实际安装的类型，不要假设。
