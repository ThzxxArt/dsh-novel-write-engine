import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const project = {
  id: 'project-e2e',
  root: '/tmp/novel-e2e',
  title: 'E2E 旧铺',
  author: '作者',
  genre: {
    major: 'mystery',
    sub: 'mystery.detective',
    tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
    audience: 'general',
    platform: 'fanqie',
  },
  genre_path: '悬疑 / 推理',
  tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
  format_version: 2,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
}

const bootstrap = {
  version: 8,
  project,
  roles: [
    'showrunner',
    'architect',
    'worldsmith',
    'planner',
    'drafter',
    'critic-story',
    'critic-character',
    'critic-prose',
    'continuity',
    'polisher',
    'archivist',
    'radar',
  ].map((id) => ({ id, label: id, preset: `novel-role-${id}`, canWrite: [] })),
  capabilities: { subagents: true, sqlite: true, fts5: true, network: true },
  taxonomy: {
    majors: [{ id: 'fantasy', label: '幻想', subCount: 8 }],
    facets: ['world', 'prot', 'plot', 'tone', 'theme', 'set', 'struct', 'pov', 'emo', 'pace', 'market'],
    tagCount: 137,
  },
}

const status = {
  project,
  stage: 'awaiting_human',
  chapter: 1,
  words: 2480,
  score: 132,
  blocking: 0,
  run: { id: 'run-e2e', kind: 'chapter', status: 'awaiting_human', targetChapter: 1 },
  next: { action: 'human.approve', label: '等待人工批准', args: {} },
  counts: { chapters: 1, archived: 1, artifacts: 9, openFindings: 1 },
  cost_usd: 0.12,
}

const board = {
  runs: [
    {
      id: 'run-e2e',
      projectId: project.id,
      kind: 'chapter',
      status: 'awaiting_human',
      targetChapter: 1,
      error: null,
      createdAt: '',
      startedAt: '',
      endedAt: null,
    },
  ],
  tasks: [
    {
      id: 'task-1',
      runId: 'run-e2e',
      role: 'critic-story',
      kind: 'review.story',
      status: 'completed',
      dependsOn: [],
      priority: 1,
      attempt: 1,
      maxAttempts: 3,
      outputArtifactId: 'a1',
      leaseOwner: null,
      leaseUntil: null,
      error: null,
    },
    {
      id: 'task-2',
      runId: 'run-e2e',
      role: 'critic-prose',
      kind: 'review.prose',
      status: 'completed',
      dependsOn: [],
      priority: 1,
      attempt: 1,
      maxAttempts: 3,
      leaseOwner: null,
      leaseUntil: null,
      outputArtifactId: 'a2',
      error: null,
    },
    {
      id: 'task-3',
      runId: 'run-e2e',
      role: 'drafter',
      kind: 'approve',
      status: 'awaiting_human',
      dependsOn: [],
      priority: 1,
      attempt: 1,
      maxAttempts: 3,
      leaseOwner: null,
      leaseUntil: null,
      outputArtifactId: null,
      error: null,
    },
  ],
  assignments: [],
  gates: [
    {
      id: 'gate-1',
      gate: 'chapter',
      runId: 'run-e2e',
      taskId: 'task-3',
      chapter: 1,
      artifactId: 'a1',
      requestedAt: '',
    },
  ],
  artifacts: [{ id: 'a1', kind: 'Draft', chapter: 1, version: 2 }],
  seq: 12,
}

const findings = [
  {
    id: 'f1',
    role: 'critic-prose',
    dimension: 'R-W-07',
    severity: 'advisory',
    location: '第 2 段',
    evidence: '他把伞收在门边，抖落一层细小的水珠。',
    problem: '动作后紧跟解释，节奏偏平。',
    fix: '删掉解释，让下一句直接进入来客动作。',
    status: 'open',
  },
]

const reviews = {
  reports: [
    {
      id: 'r1',
      role: 'critic-prose',
      version: 1,
      total: 120,
      dimensions: [{ id: 'R-W-07', max: 15, deductions: [{ rule: 'R-W-07', delta: 3 }] }],
      findings,
    },
    {
      id: 'r2',
      role: 'critic-prose',
      version: 2,
      total: 132,
      dimensions: [{ id: 'R-W-07', max: 15, deductions: [{ rule: 'R-W-07', delta: 1 }] }],
      findings,
    },
  ],
  findings,
  gates: [{ id: 'g1', artifactId: 'a1', gate: 'PG-07', verdict: 'pass', detailsJson: '{"score":132}' }],
}

const outline = {
  book: { schema_version: 2, logline: '一叠契纸牵出旧案', acts: [], volumes: [], updated_at: '' },
  chapters: [
    {
      schema_version: 2,
      kind: 'ChapterPlan',
      chapter: 1,
      title: '第1章 风起云涌',
      scene_type: '日常过渡章',
      pov: '第三人称',
      cast: ['林砚'],
      goal: '查账',
      conflict: '来人不交底',
      turn: '落款被刮',
      outcome: '去城南',
      target_words: 2400,
      hook: '门外三声敲击',
      foreshadows: [],
      notes: [],
      citations: [],
      open_questions: [],
    },
  ],
  foreshadows: [
    {
      key: 'fs-1',
      title: '缺角的契纸',
      status: 'open',
      planted_chapter: 1,
      planned_chapter: 3,
    },
  ],
}

const bible = {
  bible: {
    premise: '一个替人查账的年轻人在城南旧铺发现一叠契纸。',
    themes: '成长',
    styleGuide: '短句。',
    fingerprint: {},
    world: { rules: ['契纸必须有落款'], factions: [], locations: ['城南旧铺'], glossary: {} },
    characters: [{ slug: 'lin-yan', name: '林砚', role: '主角' }],
  },
  canon: {
    relationships: [],
    timeline: [{ id: 't1', chapter: 1, title: '契纸入铺', time: '黄昏' }],
    foreshadows: [{ key: 'fs-1', title: '缺角的契纸', status: 'open', planned_chapter: 3 }],
  },
  backlinks: {
    林砚: { chapters: [1], foreshadows: ['缺角的契纸'], reviews: [] },
  },
  drafts: 2,
}

const fixtures: Record<string, unknown> = {
  '/api/novel-write-engine/v8/bootstrap': bootstrap,
  '/api/novel-write-engine/v8/status': status,
  '/api/novel-write-engine/v8/chapters': {
    rows: [
      {
        chapter: 1,
        title: '第1章 风起云涌',
        stage: 'approved',
        words: 2480,
        score: 132,
        blockers: 0,
        updated_at: '',
      },
    ],
  },
  '/api/novel-write-engine/v8/manuscript': {
    chapter: 1,
    title: '第1章 风起云涌',
    text: '门外传来三声敲击。\n\n林砚把伞收在门边。',
    draft: { id: 'a1', version: 2, status: 'approved', hash: 'sha256:x' },
  },
  '/api/novel-write-engine/v8/outline': outline,
  '/api/novel-write-engine/v8/bible': bible,
  '/api/novel-write-engine/v8/board': board,
  '/api/novel-write-engine/v8/reviews': reviews,
  '/api/novel-write-engine/v8/analytics': {
    chapters: [{ chapter: 1, words: 2480, score: 132, blockers: 0 }],
    cost: [
      {
        run: 'run-e2e',
        kind: 'chapter',
        status: 'completed',
        costUsd: 0.12,
        promptTokens: 100,
        completionTokens: 50,
      },
    ],
    totals: { chapters: 1, words: 2480, cost: 0.12 },
  },
  '/api/novel-write-engine/v8/settings': {
    project: {
      budgets: { per_chapter_usd: 0.6 },
      models: { drafter: { provider: 'deepseek', model: 'deepseek-chat' } },
    },
    taxonomy: {
      majors: [
        { id: 'fantasy', label: '幻想', subs: [{ id: 'fantasy.xianxia', label: '仙侠', audience: 'male' }] },
      ],
      tags: [{ id: 'tone.cold', label: '冷峻', facet: 'tone' }],
    },
  },
  '/api/novel-write-engine/v8/doctor': { ok: true, integrity: 'ok', artifacts: 9, orphaned: [] },
  '/api/novel-write-engine/v8/search': {
    hits: [
      {
        id: 'm1',
        kind: 'chapter',
        chapter: 1,
        sourcePath: 'manuscript/ch-0001.md',
        text: '林砚在城南旧铺查账。',
        score: 3.2,
        reasons: ['bm25:3.2', 'active-cast'],
      },
    ],
  },
  '/api/novel-write-engine/v8/projects': {
    projects: [{ root: project.root, title: project.title, projectId: project.id }],
  },
  '/api/novel-write-engine/v8/versions': {
    versions: [
      {
        id: 'a1',
        kind: 'Draft',
        version: 2,
        status: 'approved',
        createdAt: '',
        contentHash: 'sha256:x',
        taskId: 't',
      },
      {
        id: 'a0',
        kind: 'Draft',
        version: 1,
        status: 'superseded',
        createdAt: '',
        contentHash: 'sha256:y',
        taskId: 't',
      },
    ],
  },
  '/api/novel-write-engine/v8/comments': {
    comments: [
      {
        id: 'c1',
        chapter: 1,
        paragraph: 2,
        author: 'author',
        body: '这里换行太急。',
        status: 'open',
        createdAt: '',
      },
    ],
  },
  '/api/novel-write-engine/v8/diff': {
    diff: '- 旧句：林砚把伞收在门边。\n+ 新句：林砚把伞靠在门框上。',
  },
  '/api/novel-write-engine/v8/artifact': {
    id: 'a0',
    content: { content: '旧句：林砚把伞收在门边。' },
  },
  '/api/novel-write-engine/v8/foreshadows': {
    foreshadows: [{ key: 'fs-1', title: '缺角的契纸', status: 'open', planned_chapter: 3 }],
  },
  '/api/novel-write-engine/v8/publish': {
    exports: [
      {
        id: 'e1',
        format: 'publish',
        path: 'exports/publish-1',
        chapters: [1],
        content_hash: 'sha256:publish',
        checks: ['chapter 1: approved'],
      },
    ],
    chapters: [1],
    gates: [],
    profile: { title: project.title, author: project.author, platform: 'fanqie', audience: 'general' },
    exportsDir: 'exports',
  },
  '/api/novel-write-engine/v8/backups': {
    backups: [{ name: 'studio-2026-01-01.db', bytes: 40960, mtimeMs: 1767225600000 }],
  },
  '/api/novel-write-engine/v8/import-report': { text: null },
  '/api/novel-write-engine/v8/context': {
    stage: 'draft',
    query: '契纸',
    budgetTokens: 20000,
    usedTokens: 120,
    omitted: 1,
    items: [
      {
        id: 'ctx1',
        kind: 'canon',
        sourcePath: 'state/canon.yaml',
        sourceHash: 'sha256:canon',
        text: '契纸必须有落款。',
        score: 100,
        reason: ['world-rules'],
        protected: true,
        tokens: 120,
      },
    ],
  },
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/novel-write-engine/v8/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/events')) {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' })
      return
    }
    if (url.pathname.endsWith('/action')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, gateId: 'gate-1' }),
      })
      return
    }
    const fixture = fixtures[url.pathname]
    if (fixture === undefined) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'NOT_FOUND', message: url.pathname } }),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) })
  })
})

test('renders all ten workspaces and the command palette', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '总览' })).toBeVisible()

  const workspaces: Array<[string, string]> = [
    ['稿件', '稿件'],
    ['大纲', '大纲'],
    ['设定', '设定 / Codex'],
    ['创作室', '创作室'],
    ['评审', '评审中心'],
    ['记忆', '记忆 / 检索'],
    ['分析', '分析'],
    ['发布', '发布'],
    ['设置', '设置 / 健康'],
    ['总览', '总览'],
  ]
  for (const [nav, heading] of workspaces) {
    await page.getByRole('button', { name: new RegExp(`^${nav}`) }).click()
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
  }

  await page.getByRole('button', { name: '稿件', exact: true }).click()
  await expect(page.locator('.cm-editor')).toBeVisible()

  await page.keyboard.press('Control+k')
  await expect(page.getByText('命令面板')).toBeVisible()
})

test('workbench is accessible on the overview', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '总览' })).toBeVisible()
  const results = await new AxeBuilder({ page }).analyze()
  const serious = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  )
  expect(serious).toEqual([])
})

test('deep workbench surfaces render real controls', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '总览' })).toBeVisible()

  await page.getByRole('button', { name: /^稿件/ }).click()
  await expect(page.getByText('版本历史', { exact: true })).toBeVisible()
  await expect(page.getByText('段落评论', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '对比当前' }).first().click()
  await expect(page.getByLabel('版本差异')).toContainText('旧句')
  await expect(page.getByText('旧版本', { exact: true })).toBeVisible()
  await expect(page.getByText('当前版本', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: /^大纲/ }).click()
  await expect(page.getByText('伏笔板', { exact: true })).toBeVisible()
  await expect(page.getByText('缺角的契纸')).toBeVisible()

  await page.getByRole('button', { name: /^设定/ }).click()
  await expect(page.getByText('时间线', { exact: true })).toBeVisible()
  await expect(page.getByText('契纸入铺')).toBeVisible()
  await expect(page.getByText(/出场：第 1 章/)).toBeVisible()

  await page.getByRole('button', { name: /^评审/ }).click()
  await expect(page.getByText('轮次对比', { exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'R-W-07' })).toBeVisible()

  await page.getByRole('button', { name: /^记忆/ }).click()
  await expect(page.getByText('Context Inspector', { exact: true })).toBeVisible()
  await page.getByLabel('选择上下文任务').selectOption({ index: 1 })
  await expect(page.getByText('state/canon.yaml')).toBeVisible()
  await expect(page.getByText('protected', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: /^发布/ }).click()
  await expect(page.getByText('EPUB 预览', { exact: true })).toBeVisible()
  await expect(page.getByText('发布历史', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /CH01/ }).click()
  await expect(page.getByLabel('EPUB 章节预览')).toContainText('门外传来三声敲击')

  await page.getByRole('button', { name: /^设置/ }).click()
  await expect(page.getByText('角色路由', { exact: true })).toBeVisible()
  await expect(page.getByText('备份 / 恢复', { exact: true })).toBeVisible()
  await expect(page.getByText('studio-2026-01-01.db')).toBeVisible()
})

test('every workspace passes axe and mobile navigation stays usable', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '总览' })).toBeVisible()
  for (const [nav] of [
    ['稿件'],
    ['大纲'],
    ['设定'],
    ['创作室'],
    ['评审'],
    ['记忆'],
    ['分析'],
    ['发布'],
    ['设置'],
    ['总览'],
  ] as const) {
    await page.getByRole('button', { name: new RegExp(`^${nav}`) }).click()
    const results = await new AxeBuilder({ page }).analyze()
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    )
    expect(serious, `${nav} has serious axe violations`).toEqual([])
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '总览' })).toBeVisible()
  await page.getByRole('button', { name: /^稿件/ }).click()
  await expect(page.getByRole('heading', { name: '稿件' })).toBeVisible()
  await page.getByRole('button', { name: '切换检查器' }).click()
  await expect(page.getByRole('complementary', { name: '检查器' })).toBeVisible()
})
