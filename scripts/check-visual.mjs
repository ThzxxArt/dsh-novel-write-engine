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

/** The panel needs a book with a draft; otherwise the style card never renders. */
const buildFixture = async () => {
  const { EngineService, loadRulepack } = await import(pathToFileURL(join(root, 'lib/index.js')).href)
  const stateDir = join(temporary, '.dsh', 'novel-write-engine')
  const projectRoot = join(temporary, 'books', '视觉验收之书')
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
    title: '视觉验收之书',
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
  await engine.getBrief({ stage: 'P3', root: projectRoot })
  await engine.submitDraft({
    chapter: 2,
    content: text,
    chapter_title: '第二封信从雨里来',
    scene_type: '日常过渡章',
    narrator: '他',
    summary: { ...summary, opening: paragraphs[0].slice(0, 14) },
    root: projectRoot,
  })
  await engine.dispose()
  return projectRoot
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

  await buildFixture()

  run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
  run(['plugin', '--profile', profile, 'add', packed])

  child = spawn(dsh, ['--profile', profile, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const url = await new Promise((resolve, reject) => {
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

  browser = await launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  const consoleErrors = []
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

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
  check(consoleErrors.length === 0, `the page logged errors: ${consoleErrors.slice(0, 3).join(' | ')}`)

  const written = [
    'panel-1280-overview.png',
    ...tabs.map((tab) => `panel-1280-${tab}.png`),
    'panel-390-quality.png',
    'style-card.png',
  ]
    .map((name) => join(shots, name))
    .filter((path) => existsSync(path))
  check(written.length === 10, `expected 10 screenshots, found ${written.length}`)
  for (const path of written) {
    const bytes = (await readFile(path)).byteLength
    check(bytes > 8_000, `${path} looks blank (${bytes} bytes)`)
  }

  if (failures.length === 0) {
    await writeFile(
      join(shots, 'report.json'),
      JSON.stringify({ url, screenshots: written, warnCount, overflow }, null, 1),
    )
    console.log(`visual gate passed: ${written.length} screenshots at ${url}`)
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
