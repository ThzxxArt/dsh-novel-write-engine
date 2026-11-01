/**
 * User-facing command reference shared by the panel tutorial and command help.
 * Keep this file free of Node-only imports: it is bundled into the browser half.
 */

export interface CommandSpec {
  readonly form: string
  readonly summary: string
}

export interface CommandGroup {
  readonly title: string
  readonly hint: string
  readonly items: readonly CommandSpec[]
}

/** The five registered command entry points, including the umbrella command. */
export const COMMAND_ENTRY: readonly CommandSpec[] = [
  {
    form: '/novel',
    summary: '状态总览；不带参数等价于 /novel status。所有子命令都从这里进入。',
  },
  {
    form: '/novel-next',
    summary: '等价于 /novel next：下一步工具与理由。',
  },
  {
    form: '/novel-stats',
    summary: '等价于 /novel stats：章节、总字数、均分、伏笔与规则包。',
  },
  {
    form: '/novel-export <kind>',
    summary: '等价于 /novel export <kind>；kind 为 md、txt、epub、outline、worldbook 或 proposal。',
  },
  {
    form: '/novel-admin [<op> <json>]',
    summary: '等价于 /novel admin；不带参数时列出全部隐藏/运维操作。',
  },
]

/**
 * Every named `/novel` form. The bare `/novel` default is listed in COMMAND_ENTRY,
 * so the total here is 25 rather than 26.
 */
export const COMMAND_GROUPS: readonly CommandGroup[] = [
  {
    title: '状态与内容',
    hint: '只读查询，随时可跑',
    items: [
      {
        form: '/novel status',
        summary: '进度、项目选择、轮次、字数、门控与下一步。',
      },
      {
        form: '/novel next',
        summary: '下一步该调哪个工具、为什么；卡住时先看它。',
      },
      {
        form: '/novel stats',
        summary: '章节数、总字数（归档 + 草稿）、均分、伏笔、覆盖率与规则包。',
      },
      {
        form: '/novel outline',
        summary: '蓝图、大纲覆盖率、当前章卡与世界观计数。',
      },
      {
        form: '/novel guide',
        summary: '六态引导与下一步；新项目、写作中、完结都能用。',
      },
      {
        form: '/novel report',
        summary: '全书报告：进度、质量、伏笔、节奏与警告。',
      },
      {
        form: '/novel doctor',
        summary: '项目体检：锁、备份、状态文档、正文与大纲漂移。',
      },
      {
        form: '/novel search <关键词>',
        summary: '搜索正文、摘要、大纲、世界观与台账；空关键词会报用法。',
      },
    ],
  },
  {
    title: '项目与会话',
    hint: '只改查看对象或登记，不动正文',
    items: [
      {
        form: '/novel projects',
        summary: '列出登记项目；* 当前会话，P 面板默认，! 缺失/待修复。',
      },
      {
        form: '/novel projects --prune',
        summary: '只预览失效登记（missing / not-project / unreadable），不写盘。',
      },
      {
        form: '/novel projects --prune --yes',
        summary: '删除失效登记行，不删项目目录；--yes 不能单独使用。',
      },
      {
        form: '/novel current',
        summary: '当前会话绑定、选择来源和失效状态。',
      },
      {
        form: '/novel use <路径|书名|.>',
        summary: '切换当前会话；不改变 active；点号按 cwd 规则选唯一项目。',
      },
      {
        form: '/novel unbind',
        summary: '只清当前会话绑定；项目、登记和正文都不动。',
      },
      {
        form: '/novel scan',
        summary: '只读扫描 cwd、cwd/novel 和直接子目录；不递归、不跟随符号链接。',
      },
      {
        form: '/novel scan --register',
        summary: '只登记健康项目；不选择、不改 active、不绑会话。',
      },
    ],
  },
  {
    title: '续写与导出',
    hint: 'resume 只读；export 写入 exports/',
    items: [
      {
        form: '/novel resume',
        summary: '输出可粘贴的续写指令；只读，与面板“复制续写指令”同源。',
      },
      {
        form: '/novel export md',
        summary: '正文 Markdown。',
      },
      {
        form: '/novel export txt',
        summary: '正文纯文本。',
      },
      {
        form: '/novel export epub',
        summary: '正文 EPUB 3。',
      },
      {
        form: '/novel export outline',
        summary: '大纲计划。',
      },
      {
        form: '/novel export worldbook',
        summary: '世界观设定集。',
      },
      {
        form: '/novel export proposal',
        summary: '书级提案。',
      },
    ],
  },
  {
    title: '隐藏与运维',
    hint: 'JSON 必须是对象',
    items: [
      {
        form: '/novel admin',
        summary: '列出全部 25 个隐藏/运维操作与示例。',
      },
      {
        form: '/novel admin <op> <json>',
        summary: '执行一个操作；参数同对应工具，JSON 外层的双引号要保留。',
      },
    ],
  },
]

/** Number of named `/novel` forms (the bare `/novel` default is separate). */
export const COMMAND_FORM_COUNT = COMMAND_GROUPS.reduce((total, group) => total + group.items.length, 0)

export interface AdminOperationSpec {
  readonly name: string
  readonly summary: string
}

export interface AdminOperationGroup {
  readonly title: string
  readonly hint: string
  readonly items: readonly AdminOperationSpec[]
}

/**
 * Operations reachable through `/novel admin <op> <json>`. This list must stay
 * byte-for-byte aligned with `src/commands/admin.ts`; tests enforce that.
 */
export const ADMIN_OPERATION_GROUPS: readonly AdminOperationGroup[] = [
  {
    title: '写作、状态与恢复',
    hint: '参数与同名工具一致',
    items: [
      { name: 'novel_plan_world', summary: '提交 P1 世界计划' },
      { name: 'novel_plan_chapter', summary: '提交 P2 章节计划' },
      { name: 'novel_word_count', summary: '统计纯文本或项目字数' },
      { name: 'novel_amend', summary: '修复状态文档' },
      { name: 'novel_rollback', summary: '回退阶段' },
      { name: 'novel_diff', summary: '对比文本或章稿' },
      { name: 'novel_audit', summary: '审计 journal' },
      { name: 'novel_pipeline', summary: '下一步建议' },
      { name: 'novel_state', summary: '读取原始状态、历史与备份' },
      { name: 'novel_reopen', summary: '重开已归档章' },
      { name: 'novel_restore', summary: '从备份事务恢复' },
    ],
  },
  {
    title: '规划、检索与诊断',
    hint: '书级写操作也在这里',
    items: [
      { name: 'novel_blueprint', summary: '写书级蓝图与卷' },
      { name: 'novel_outline', summary: '章卡与卷 upsert' },
      { name: 'novel_outline_import', summary: '导入 Markdown / YAML / JSON 大纲' },
      { name: 'novel_worldbook', summary: '按段更新世界观' },
      { name: 'novel_search', summary: '搜索正文、大纲与台账' },
      { name: 'novel_doctor', summary: '项目体检' },
      { name: 'novel_report', summary: '全书报告' },
      { name: 'novel_guide', summary: '引导与下一步' },
    ],
  },
  {
    title: '导出',
    hint: '六种 kind 同一入口',
    items: [{ name: 'novel_export', summary: '导出正文、大纲、世界观或提案' }],
  },
  {
    title: '登记与设定包',
    hint: '只走命令入口，不注册工具',
    items: [
      { name: 'novel_registry_list', summary: '列出登记项目' },
      { name: 'novel_registry_register', summary: '登记一个项目，传 root' },
      { name: 'novel_registry_activate', summary: '改面板默认 active，传 root' },
      { name: 'novel_registry_forget', summary: '删登记行，传 root' },
      { name: 'novel_import', summary: '导入设定包' },
    ],
  },
]

export const ADMIN_OPERATION_NAMES: readonly string[] = ADMIN_OPERATION_GROUPS.flatMap((group) =>
  group.items.map((operation) => operation.name),
)

export const ADMIN_OPERATION_COUNT = ADMIN_OPERATION_NAMES.length

export interface CommandCombination {
  readonly title: string
  readonly steps: readonly string[]
  readonly note: string
}

/** Copyable workflows; no hidden state changes beyond the listed commands. */
export const COMMAND_COMBINATIONS: readonly CommandCombination[] = [
  {
    title: '扫描、登记、切换',
    steps: [
      '/novel scan',
      '/novel scan --register',
      '/novel projects',
      '/novel use <路径|书名|.>',
      '/novel resume',
    ],
    note: 'scan 只发现，--register 只登记，use 才切换当前会话；resume 最后生成续写指令。',
  },
  {
    title: '清理失效登记',
    steps: ['/novel projects --prune', '/novel projects --prune --yes'],
    note: '第一条只预览；第二条才删除登记行，项目目录不会被删。',
  },
  {
    title: '接续当前这本书',
    steps: ['/novel current', '/novel status', '/novel resume'],
    note: 'current 确认绑定，status 确认阶段，resume 给 Agent 一段可粘贴的续写指令。',
  },
  {
    title: 'core 模式调用隐藏工具',
    steps: [
      '/novel admin',
      '/novel admin novel_state {"kind":"pipeline"}',
      '/novel admin novel_word_count {"text":"一段正文"}',
    ],
    note: 'JSON 必须是对象；命令里的双引号要保留。toolsMode=core 时，18 个非核心工具都走这里。',
  },
  {
    title: '导出与排错',
    steps: [
      '/novel export md',
      '/novel export outline',
      '/novel export worldbook',
      '/novel status',
      '/novel next',
      '/novel doctor',
    ],
    note: '导出只写 exports/；排错先看 status、next、doctor，再决定 amend、restore 或 rollback。',
  },
]
