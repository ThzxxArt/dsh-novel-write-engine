#!/usr/bin/env node
/**
 * Visual release gate: install the packed tarball into a disposable DSH profile,
 * boot the real Web host on a real port, open the panel in a real browser and
 * assert what a human actually sees.
 *
 * Why this exists: every earlier round verified the panel by rendering React to
 * a static string. That proves the component tree, not the shipped page — it
 * cannot catch a CSS rule that clips a value, a grid that overflows at 390px, or
 * a section the client never fetches. This gate looks at pixels.
 *
 * Usage:
 *   pnpm check:visual
 *   PLAYWRIGHT_MODULE=/path/to/playwright pnpm check:visual
 *   NWE_VISUAL_DIR=/tmp/shots pnpm check:visual     # keep the PNGs
 *
 * Requires Playwright + Chromium. Missing browser tooling exits 2 rather than
 * printing a pass: a visual gate that silently skips is worse than none.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
if (process.platform === 'win32') {
  console.error('check:visual is POSIX-only; use the platform-build job on Windows')
  process.exit(2)
}
const dsh = process.env.DSH_BIN ?? 'dsh'
const shots = process.env.NWE_VISUAL_DIR ?? join(tmpdir(), `nwe-visual-${process.pid}`)

/** Resolve Playwright without adding it to the package's runtime dependencies. */
const loadPlaywright = async () => {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    join(homedir(), '.cache', 'nwe-playwright', 'node_modules', 'playwright'),
  ].filter((value) => typeof value === 'string' && value !== '')
  // A bare directory path is not an ESM specifier: resolve it to its entry file
  // first, or `import('/path/to/playwright')` fails with ERR_UNSUPPORTED_DIR_IMPORT.
  const require = createRequire(import.meta.url)
  for (const candidate of candidates) {
    try {
      const loaded = await import(pathToFileURL(require.resolve(candidate)).href)
      // Playwright is CommonJS: the namespace hides the API under `default`.
      const api = loaded?.default?.chromium === undefined ? loaded : loaded.default
      if (api?.chromium?.launch === undefined) continue
      return api
    } catch {
      continue
    }
  }
  console.error(
    'playwright is not installed. The visual gate needs a real browser:\n' +
      '  npm i -g playwright && npx playwright install chromium\n' +
      '  # or: PLAYWRIGHT_MODULE=/path/to/node_modules/playwright pnpm check:visual',
  )
  process.exit(2)
}

const pw = await loadPlaywright()
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM ?? undefined
const launch = async () =>
  pw.chromium.launch({
    ...(chromiumPath === undefined ? {} : { executablePath: chromiumPath }),
    args: ['--no-sandbox'],
  })

try {
  execFileSync(dsh, ['--version'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
} catch (error) {
  console.error(`cannot run ${dsh}: ${error instanceof Error ? error.message : String(error)}`)
  console.error('set DSH_BIN to a DSH CLI binary with Web support')
  process.exit(2)
}

const temporary = await mkdtemp(join(tmpdir(), 'nwe-visual-home-'))
const env = {
  ...process.env,
  DSH_HOME: temporary,
  HOME: temporary,
  USERPROFILE: temporary,
  NO_COLOR: '1',
  DSH_TELEMETRY_DISABLED: '1',
}
const profile = `nwe-visual-${process.pid}`
let packed
let child
let browser
const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

const run = (args) =>
  execFileSync(dsh, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  })

const stop = async () => {
  if (child === undefined || child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(undefined)
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
}

/** Boot the disposable profile and return the panel URL the host prints. */
const bootHost = async () => {
  child = spawn(dsh, ['--profile', profile, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  return await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(`host did not print a URL\n${buffer}${stderr}`)), 60_000)
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      const match = /dsh web:\s+(http:\/\/\S+)/.exec(buffer)
      if (match !== null) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
  })
}

/** Open the panel: dismiss the welcome dialog, then click the sidebar entry. */
const openPanel = async (page, url) => {
  await page.goto(url, { waitUntil: 'load', timeout: 90_000 })
  await page.waitForTimeout(2500)
  for (const label of ['Continue', '继续']) {
    const button = page.getByRole('button', { name: label })
    if ((await button.count()) > 0) {
      await button.first().click()
      break
    }
  }
  await page.waitForTimeout(600)
  const entry = page.getByText('网文工坊', { exact: true })
  check((await entry.count()) > 0, 'the sidebar has no 网文工坊 entry: the client bundle did not mount')
  if ((await entry.count()) > 0) await entry.first().click()
  await page.waitForTimeout(2500)
}

/**
 * Build one book up to a completed check, so both the style card and the 0.2.19
 * checklist card render.
 *
 * `failRow` makes exactly one checklist row fail. The clean variant differs only
 * in that answer, so any difference between the two screenshots comes from the
 * checklist card itself, not from a different book. The function returns the
 * persisted summary: the gate asserts the panel against the document rather than
 * against a number copied into this script.
 */
const seedBook = async ({ title, failRow, activate = false }) => {
  const { EngineService, loadRulepack } = await import(pathToFileURL(join(root, 'lib/index.js')).href)
  const stateDir = join(temporary, '.dsh', 'novel-write-engine')
  const projectRoot = join(temporary, 'books', title)
  const engine = new EngineService(
    {
      projectRoot,
      stateDir,
      tools: { mode: 'all' },
      quality: { minScore: 120 },
      briefs: { overrides: '' },
      storage: { backupRetention: 5 },
    },
    () => loadRulepack(),
  )
  const paragraphs = [
    '风从窗缝里挤进来，把桌上的纸吹得翻了一页。他伸手压住，指腹沾了一点灰。',
    '走廊尽头传来脚步声，不快不慢，在门口停了两秒。他没有抬头，只把笔帽扣紧。',
    '门被推开时带进一股凉气，来人把一只旧信封放在桌角，指尖敲了两下。',
    '信封没有署名，封口处压着一枚暗红的蜡印，边缘已经磨得发白。',
    '他盯着那枚蜡印看了很久，最后把信封翻过去，背面写着一行很小的字。',
    '窗外天色暗下来，楼下的路灯一盏接一盏亮起，照见窗台上薄薄一层灰。',
  ]
  const text = paragraphs.join('\n\n')
  const summary = {
    events: ['收到无名信封'],
    characters_appeared: ['他'],
    foreshadows: { planted: [], advanced: [], resolved: [] },
    new_elements: { locations: [], abilities: [], artifacts: [] },
    resource_changes: [],
    opening: paragraphs[0].slice(0, 14),
    continuity: { opens_from: '上一章结尾', ends_with: '信封' },
    hook_strength: 4,
    pleasure_points: ['新线索'],
    plot_advancement: 'mid',
  }
  const dimensions = [
    ['R-W-01', 15],
    ['R-W-02', 10],
    ['R-W-03', 10],
    ['R-W-04', 20],
    ['R-W-05', 15],
    ['R-W-12', 20],
    ['R-W-11', 10],
    ['R-W-13', 15],
    ['R-W-14', 10],
    ['R-W-15', 10],
    ['R-W-06', 4],
    ['R-W-07', 4],
    ['R-W-08', 4],
    ['R-W-09', 2],
    ['R-W-10', 1],
  ]
  const sentences = paragraphs
    .flatMap((line) => line.split(/(?<=[。！？])/u))
    .map((line) => line.trim())
    .filter((line) => Array.from(line).length >= 8)
  const quotes = sentences.slice(0, 5)

  await engine.initProject({
    title,
    genre: '悬疑推理',
    platform: 'fanqie',
    style: 'cold-suspense',
    root: projectRoot,
    total_chapters: 12,
    words_per_chapter: [80, 400],
  })
  await engine.getBrief({ stage: 'P1', root: projectRoot })
  await engine.submitWorldPlan({
    chapter: 0,
    objective: '让主角收到一封无名信',
    constraints: [],
    characters: [{ name: '沈砚', role: '主角', current_state: '在旧书店值夜' }],
    locations: [{ name: '旧书店', layout: '临街两层', capacity: 6 }],
    continuity_notes: [],
    root: projectRoot,
  })
  await engine.getBrief({ stage: 'P2', root: projectRoot })
  await engine.submitChapterPlan({
    chapter: 0,
    title: '开端之雨',
    scene_type: '日常过渡章',
    narrator: '他',
    beats: ['风起', '信到', '拆封', '读信', '决定'],
    opening: '风从窗缝里挤进来',
    ending: '蜡印',
    target_words: [80, 400],
    root: projectRoot,
  })
  await engine.getBrief({ stage: 'P3', root: projectRoot })
  await engine.submitDraft({
    chapter: 1,
    content: text,
    chapter_title: '开端之雨',
    scene_type: '日常过渡章',
    narrator: '他',
    summary,
    root: projectRoot,
  })
  await engine.getBrief({ stage: 'P4', root: projectRoot })
  await engine.submitReview({
    chapter: 1,
    dimensions: dimensions.map(([id, max], index) => ({
      id,
      max,
      deductions:
        index === 0 ? [{ rule: 'NO_MOTIVE', location: '第 2 段', delta: 5, note: '动作缺少动机' }] : [],
    })),
    issues: [],
    total: 145,
    proof: {
      opening: { paragraph: 1, quote: paragraphs[0].slice(0, 14) },
      middle: { paragraph: 3, quote: paragraphs[2].slice(0, 14) },
      ending: { paragraph: 6, quote: paragraphs[5].slice(0, 14) },
    },
    root: projectRoot,
  })
  await engine.getBrief({ stage: 'P6', root: projectRoot })
  await engine.runCheck({
    chapter: 1,
    semantic: ['L2-SCENE-ANCHOR', 'L2-CHARACTER-STATE', 'L2-CAUSALITY', 'L2-VOICE', 'L2-POV'].map(
      (id, index) => ({ id, verdict: 'pass', evidence: quotes[index], note: '已核对' }),
    ),
    root: projectRoot,
  })
  await engine.getBrief({ stage: 'P8', root: projectRoot })
  await engine.archiveChapter({
    chapter: 1,
    state_delta: {
      characters: { 他: { action: 'created', role: 'protagonist' } },
      foreshadows: {},
      timeline: { 0: { action: 'created', description: '收到无名信封' } },
      world: {},
      relationships: {},
    },
    root: projectRoot,
  })
  // A second chapter left at P3 so the panel shows a draft alongside an archive.
  await engine.getBrief({ stage: 'P1', root: projectRoot })
  await engine.submitWorldPlan({
    chapter: 1,
    objective: '追查蜡印的来处',
    constraints: [],
    characters: [],
    locations: [],
    continuity_notes: [],
    root: projectRoot,
  })
  await engine.getBrief({ stage: 'P2', root: projectRoot })
  await engine.submitChapterPlan({
    chapter: 1,
    title: '第二封信从雨里来',
    scene_type: '日常过渡章',
    narrator: '他',
    beats: ['追查', '线索', '对峙', '脱身', '决意'],
    opening: '雨还没停',
    ending: '第二封信',
    target_words: [80, 400],
    root: projectRoot,
  })
  // Chapter 2 needs its own prose: reusing chapter 1's paragraphs is a PG-10
  // duplicate, and the check that renders the checklist would never run.
  const second = [
    '雨停在半途，屋檐还在滴水，他数到第七声才起身。',
    '柜台上的账本翻开着，墨迹被潮气洇成一团模糊的灰。',
    '来客没有坐下，只把伞尖抵在门槛上，鞋底沾着半干的泥。',
    '蜡印在灯下显出一道细缝，边缘被谁用指甲轻轻挑过。',
    '他把信封举到灯前，光透过纸背，照出几行被水泡开的字。',
    '楼上的钟敲了九下，声音闷在墙里，震得灯罩轻响。',
  ]
  const secondText = second.join('\n\n')
  const secondQuotes = second
    .flatMap((line) => line.split(/(?<=[。！？])/u))
    .map((line) => line.trim())
    .filter((line) => Array.from(line).length >= 8)
    .slice(0, 5)
  await engine.getBrief({ stage: 'P3', root: projectRoot })
  await engine.submitDraft({
    chapter: 2,
    content: secondText,
    chapter_title: '第二封信从雨里来',
    scene_type: '日常过渡章',
    narrator: '他',
    summary: { ...summary, events: ['追查蜡印的来处'], opening: second[0].slice(0, 14) },
    root: projectRoot,
  })
  // 0.2.19: chapter 2 leaves the draft stage so the quality tab renders the
  // checklist card. Without a completed check there are no thirteen rows.
  await engine.getBrief({ stage: 'P4', root: projectRoot })
  await engine.submitReview({
    chapter: 2,
    dimensions: dimensions.map(([id, max], index) => ({
      id,
      max,
      deductions:
        index === 0 ? [{ rule: 'NO_MOTIVE', location: '第 2 段', delta: 5, note: '动作缺少动机' }] : [],
    })),
    issues: [],
    total: 145,
    proof: {
      opening: { paragraph: 1, quote: second[0].slice(0, 14) },
      middle: { paragraph: 3, quote: second[2].slice(0, 14) },
      ending: { paragraph: 6, quote: second[5].slice(0, 14) },
    },
    root: projectRoot,
  })
  await engine.getBrief({ stage: 'P6', root: projectRoot })
  // The eight rows a model owns. Machine rows are answered by the engine; sending
  // them would be rejected, so the fixture speaks the same contract a model does.
  const modelRows = [
    'SC-METAPHOR',
    'SC-CONCRETE',
    'SC-FORMULA',
    'SC-PARALLEL',
    'SC-LIST',
    'SC-DIALOGUE-BEAT',
    'SC-QUOTE',
    'SC-CHAPTER-BREAK',
  ]
  const checked = await engine.runCheck({
    chapter: 2,
    semantic: ['L2-SCENE-ANCHOR', 'L2-CHARACTER-STATE', 'L2-CAUSALITY', 'L2-VOICE', 'L2-POV'].map(
      (id, index) => ({ id, verdict: 'pass', evidence: secondQuotes[index], note: '已核对' }),
    ),
    self_check: modelRows.map((id) => ({
      id,
      verdict: id === failRow ? 'fail' : 'pass',
      note: id === failRow ? '蜡印描写停在名词上，读者想不出画面' : '逐段核对通过',
    })),
    root: projectRoot,
  })
  // Two books share one state directory, so the second boot must be told which
  // one is active; the registry's "only project" fallback does not apply.
  if (activate) await engine.setActiveProject({ root: projectRoot })
  await engine.dispose()
  return { projectRoot, summary: checked.data.self_check.summary }
}

try {
  await mkdir(shots, { recursive: true })

  execFileSync('npm', ['run', 'build'], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const raw = execFileSync('npm', ['pack', '--json'], { cwd: root, encoding: 'utf8' })
  const parsed = JSON.parse(raw)
  packed = join(root, (Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]).filename)

  // Two books, one difference: book A has one failing checklist row, book B has
  // none. Both need a completed check, or the 0.2.19 card never renders.
  const bookA = await seedBook({ title: '视觉验收之书', failRow: 'SC-CONCRETE' })

  run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
  run(['plugin', '--profile', profile, 'add', packed])

  const url = await bootHost()

  browser = await launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  const consoleErrors = []
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await openPanel(page, url)

  await page.screenshot({ path: join(shots, 'panel-1280-overview.png'), fullPage: false })

  const bookTitle = await page.evaluate(() => document.querySelector('.nwe-root')?.innerText ?? '')
  check(bookTitle.includes('视觉验收之书'), 'panel header did not render the project title')
  check(!bookTitle.includes('第一卷'), 'panel claims a volume for a book whose outline defines none')

  const tabs = ['概览', '章节', '人物', '线索', '设定', '质量', '健康']
  for (const tab of tabs) {
    const roleTab = page.getByRole('tab', { name: tab })
    const target = (await roleTab.count()) > 0 ? roleTab : page.getByText(tab, { exact: true })
    check((await target.count()) > 0, `tab ${tab} is missing`)
    if ((await target.count()) === 0) continue
    await target.first().click()
    await page.waitForTimeout(700)
    await page.screenshot({ path: join(shots, `panel-1280-${tab}.png`) })
  }

  // The style card is the 0.2.17 surface: nine readings with their targets.
  await page.getByRole('tab', { name: '质量' }).click()
  await page.waitForTimeout(700)
  const styleText = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.nwe-root *')].filter((node) =>
      /文风 · /.test(node.textContent ?? ''),
    )
    // The header chip also matches "文风 · "; the card is the longest match.
    const card = nodes.sort((a, b) => (b.textContent ?? '').length - (a.textContent ?? '').length)[0]
    return card?.textContent ?? ''
  })
  check(styleText.includes('文风 · 冷峻悬疑'), 'the style card did not render the bound pack name')
  for (const label of [
    '短句',
    '中句',
    '长句',
    '对白占比',
    '抽象情绪',
    '比喻标记',
    '爽点空窗',
    '情绪线索',
    '句长变异',
  ]) {
    check(styleText.includes(label), `the style card is missing the ${label} row`)
  }
  check(
    !/\d\.\d{3,}/.test(styleText),
    `the style card renders raw float precision: ${styleText.slice(0, 200)}`,
  )
  // A full-page shot at 1280 cuts the card off below the fold; capture the
  // element itself so the release record shows what the reader sees.
  const styleCard = page.locator('.nwe-subsection').filter({ hasText: '文风 · ' }).first()
  if ((await styleCard.count()) > 0) {
    await styleCard.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await styleCard.screenshot({ path: join(shots, 'style-card.png') })
  } else {
    check(false, 'the style card section was not found in the DOM')
  }

  const warnCount = await page.evaluate(() => document.querySelectorAll('.nwe-root .nwe-style-warn').length)
  check(warnCount > 0, 'no deviating metric was marked, so the warn styling never ran')

  // 0.2.19: the submission checklist card. The expected marks come from the
  // document the engine persisted (`bookA.summary`), not from numbers typed into
  // this gate: the panel must agree with the ledger, not with the script author.
  const selfCheckSection = page.locator('.nwe-selfcheck').first()
  check(
    (await selfCheckSection.count()) > 0,
    'the quality tab has no checklist card, but the active chapter carries a check',
  )
  const cardRows = await page.locator('.nwe-selfcheck-row').count()
  const failedRows = await page.locator('.nwe-selfcheck-row.is-fail').count()
  const naRows = await page.locator('.nwe-selfcheck-row.is-na').count()
  const cardHeader = await page
    .locator('.nwe-selfcheck > header span')
    .first()
    .innerText()
    .catch(() => '')
  check(cardRows === 13, `the checklist card rendered ${cardRows} rows, expected 13`)
  check(
    cardHeader === `√ ${bookA.summary.pass} · × ${bookA.summary.fail} · — ${bookA.summary.na}`,
    `the checklist header ${JSON.stringify(cardHeader)} disagrees with the document ${JSON.stringify(bookA.summary)}`,
  )
  check(
    failedRows === bookA.summary.fail,
    `the card paints ${failedRows} failing rows, the document records ${bookA.summary.fail}`,
  )
  check(
    naRows === bookA.summary.na,
    `the card paints ${naRows} not-applicable rows, the document records ${bookA.summary.na}`,
  )
  if ((await selfCheckSection.count()) > 0) {
    await selfCheckSection.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await selfCheckSection.screenshot({ path: join(shots, 'selfcheck-card.png') })
  }

  // Mobile must not scroll sideways: the panel is a full-bleed surface.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(900)
  await page.screenshot({ path: join(shots, 'panel-390-quality.png') })
  const overflow = await page.evaluate(() => {
    const rootNode = document.querySelector('.nwe-root')
    const offenders = [...document.querySelectorAll('.nwe-root *')].filter((node) => {
      const box = node.getBoundingClientRect()
      return box.width > 0 && box.right > window.innerWidth + 1
    })
    return {
      scrollWidth: rootNode?.scrollWidth ?? 0,
      clientWidth: rootNode?.clientWidth ?? 0,
      body: document.body.scrollWidth,
      offenders: offenders.slice(0, 5).map((node) => String(node.className).slice(0, 40)),
    }
  })
  check(
    overflow.body <= 390 && overflow.scrollWidth <= overflow.clientWidth + 1,
    `the panel overflows at 390px: ${JSON.stringify(overflow)}`,
  )
  check(
    overflow.offenders.length === 0,
    `elements cross the right edge at 390px: ${overflow.offenders.join(', ')}`,
  )
  // The card is thirteen rows with no folding, so 390px is where it can break.
  const mobileCard = page.locator('.nwe-selfcheck').first()
  if ((await mobileCard.count()) > 0) {
    const mobileCardBox = await mobileCard.boundingBox()
    check(
      mobileCardBox !== null && mobileCardBox.x >= 0 && mobileCardBox.x + mobileCardBox.width <= 390,
      `the checklist card crosses the viewport at 390px: ${JSON.stringify(mobileCardBox)}`,
    )
    await mobileCard.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await mobileCard.screenshot({ path: join(shots, 'selfcheck-card-390.png') })
  }
  check(consoleErrors.length === 0, `the page logged errors: ${consoleErrors.slice(0, 3).join(' | ')}`)

  // The zero-hit state cannot be shown on the same project: the card renders the
  // active chapter's checklist, and one chapter has one check. Boot a second book
  // whose answers are all pass instead of faking the state in the DOM.
  //
  // The first page is closed before the host stops, and the second one opens in a
  // fresh browser context: a page left pointing at a dead port floods the console
  // with WebSocket errors that have nothing to do with this plugin.
  await page.goto('about:blank')
  await page.close()
  await stop()
  const cleanSummary = (await seedBook({ title: '零中弹之书', failRow: null, activate: true })).summary
  const cleanUrl = await bootHost()
  const cleanPage = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  const cleanErrors = []
  cleanPage.on('pageerror', (error) => cleanErrors.push(error.message))
  cleanPage.on('console', (message) => {
    if (message.type() === 'error') cleanErrors.push(message.text())
  })
  await openPanel(cleanPage, cleanUrl)
  const qualityTab = cleanPage.getByRole('tab', { name: '质量' })
  if ((await qualityTab.count()) > 0) await qualityTab.first().click()
  await cleanPage.waitForTimeout(900)
  const cleanRows = await cleanPage.locator('.nwe-selfcheck-row').count()
  const cleanFails = await cleanPage.locator('.nwe-selfcheck-row.is-fail').count()
  const cleanHeader = await cleanPage
    .locator('.nwe-selfcheck > header span')
    .first()
    .innerText()
    .catch(() => '')
  check(cleanRows === 13, `the clean card rendered ${cleanRows} rows, expected 13`)
  check(cleanFails === 0, `the clean card paints ${cleanFails} failing rows, expected 0`)
  check(
    cleanHeader === `√ ${cleanSummary.pass} · × ${cleanSummary.fail} · — ${cleanSummary.na}`,
    `the clean card header ${JSON.stringify(cleanHeader)} disagrees with the document ${JSON.stringify(cleanSummary)}`,
  )
  const cleanCard = cleanPage.locator('.nwe-selfcheck').first()
  if ((await cleanCard.count()) > 0) {
    await cleanCard.scrollIntoViewIfNeeded()
    await cleanPage.waitForTimeout(300)
    await cleanCard.screenshot({ path: join(shots, 'selfcheck-clean.png') })
  } else {
    check(false, 'the clean book rendered no checklist card')
  }
  check(cleanErrors.length === 0, `the second page logged errors: ${cleanErrors.slice(0, 3).join(' | ')}`)

  const written = [
    'panel-1280-overview.png',
    ...tabs.map((tab) => `panel-1280-${tab}.png`),
    'panel-390-quality.png',
    'style-card.png',
    'selfcheck-card.png',
    'selfcheck-card-390.png',
    'selfcheck-clean.png',
  ]
    .map((name) => join(shots, name))
    .filter((path) => existsSync(path))
  check(written.length === 13, `expected 13 screenshots, found ${written.length}`)
  for (const path of written) {
    const bytes = (await readFile(path)).byteLength
    check(bytes > 8_000, `${path} looks blank (${bytes} bytes)`)
  }

  if (failures.length === 0) {
    await writeFile(
      join(shots, 'report.json'),
      JSON.stringify(
        {
          url,
          cleanUrl,
          screenshots: written,
          warnCount,
          overflow,
          checklist: { bookA: bookA.summary, clean: cleanSummary },
        },
        null,
        1,
      ),
    )
    console.log(`visual gate passed: ${written.length} screenshots`)
    console.log(`screenshots: ${shots}`)
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
} finally {
  if (browser !== undefined) await browser.close()
  await stop()
  if (process.env.NWE_KEEP_VISUAL === '1') {
    console.error(`kept visual home: ${temporary}`)
  } else {
    await rm(temporary, { recursive: true, force: true })
  }
  if (packed !== undefined && process.env.NWE_KEEP_VISUAL !== '1') await rm(packed, { force: true })
}

if (failures.length > 0) {
  console.error('visual gate failed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
}
