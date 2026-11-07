import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { Command } from 'cmdk'
import * as Tabs from '@radix-ui/react-tabs'
import { Toaster, toast } from 'sonner'
import { EditorState, StateEffect, StateField, type Range } from '@codemirror/state'
import { Decoration, EditorView, drawSelection, lineNumbers, type DecorationSet } from '@codemirror/view'
import { Background, ReactFlow, type Edge, type Node } from '@xyflow/react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Command as CommandIcon,
  FileText,
  LayoutDashboard,
  ListTree,
  PanelRight,
  Play,
  RefreshCw,
  Save,
  Search,
  Settings,
  Upload,
  X,
} from 'lucide-react'
import { STUDIO_CSS } from './styles.js'
import {
  api,
  postAction,
  type Board,
  type Bootstrap,
  type ChapterRow,
  type Finding,
  type ReviewPayload,
  type Status,
} from './api.js'
import { useStudio, WORKSPACES, type Workspace } from './store.js'
import { studioTranslate, type StudioTranslator } from './locale.js'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 4000, refetchOnWindowFocus: false } },
})

const LocaleContext = createContext<StudioTranslator>(studioTranslate)
const useT = (): StudioTranslator => useContext(LocaleContext)

const WORKSPACE_META: Record<Workspace, { label: string; icon: typeof LayoutDashboard }> = {
  overview: { label: '总览', icon: LayoutDashboard },
  manuscript: { label: '稿件', icon: FileText },
  outline: { label: '大纲', icon: ListTree },
  bible: { label: '设定', icon: BookOpen },
  studio: { label: '创作室', icon: Play },
  review: { label: '评审', icon: ClipboardCheck },
  memory: { label: '记忆', icon: Search },
  analytics: { label: '分析', icon: BarChart3 },
  publish: { label: '发布', icon: Upload },
  settings: { label: '设置', icon: Settings },
}

const fmt = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : Math.round(value).toLocaleString('zh-CN')

const statusTone = (status: string): string =>
  status === 'completed'
    ? 'is-ok'
    : status === 'failed'
      ? 'is-bad'
      : status === 'awaiting_human' || status === 'paused'
        ? 'is-warn'
        : 'is-run'

const STATUS_LABEL: Record<string, string> = {
  queued: '排队',
  leased: '已领取',
  running: '运行中',
  validating: '校验中',
  awaiting_human: '待人工',
  retry_wait: '待重试',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  paused: '已暂停',
  pending: '待调度',
  ready: '就绪',
  planned: '已规划',
  drafted: '已起草',
  reviewed: '已评审',
  revised: '已修订',
  continuity: '连贯性检查',
  polished: '已润色',
  approved: '已批准',
  archived: '已归档',
  intake: '立项',
  bible: '设定',
  outline: '大纲',
  volume_plan: '卷规划',
  writing: '写作中',
  production: '制作中',
  published: '已发布',
}

const statusLabel = (status: string | undefined): string =>
  status === undefined ? 'idle' : (STATUS_LABEL[status] ?? status)

function WorkspaceTitle({ id }: { id: Workspace }) {
  const t = useT()
  return <h1 className="nwe-h1">{t(`title.${id}`)}</h1>
}

function Topbar({
  bootstrap,
  status,
  onPalette,
  search,
  onToggleInspector,
  projects,
  onSwitchProject,
}: {
  bootstrap: Bootstrap
  status?: Status
  onPalette: () => void
  search: string
  onToggleInspector: () => void
  projects: Array<{ root: string; title: string; projectId: string }>
  onSwitchProject: (root: string) => void
}) {
  const setWorkspace = useStudio((state) => state.setWorkspace)
  const setSearch = useStudio((state) => state.setInspector)
  const project = bootstrap.project
  return (
    <header className="nwe-topbar">
      <div className="nwe-brand">
        <div className="nwe-brand-mark">
          <BookOpen size={16} />
        </div>
        <div>
          <div className="nwe-brand-title">{project?.title ?? '网文工坊 · 创作室'}</div>
          <div className="nwe-brand-sub">{project?.genre_path ?? '选择或创建一个项目'}</div>
        </div>
      </div>
      <select
        className="nwe-select nwe-project-switch"
        aria-label="切换项目"
        value={project?.root ?? ''}
        onChange={(event) => onSwitchProject(event.target.value)}
      >
        {(projects.length === 0
          ? [{ root: project?.root ?? '', title: project?.title ?? '当前项目' }]
          : projects
        ).map((item) => (
          <option key={item.root} value={item.root}>
            {item.title}
          </option>
        ))}
      </select>
      <div className="nwe-row nwe-wrap">
        {status?.run !== undefined && status.run !== null ? (
          <span className={`nwe-pill ${statusTone(status.run.status)}`}>
            {status.run.kind} · {statusLabel(status.run.status)}
          </span>
        ) : (
          <span className="nwe-pill">idle</span>
        )}
        {status !== undefined && status.blocking > 0 ? (
          <span className="nwe-pill is-bad">
            <AlertTriangle size={12} /> {status.blocking} blocking
          </span>
        ) : (
          <span className="nwe-pill is-ok">
            <CheckCircle2 size={12} /> 无 blocker
          </span>
        )}
      </div>
      <div className="nwe-topbar-spacer" />
      <div className="nwe-search">
        <Search size={14} />
        <input
          aria-label="全局搜索"
          placeholder="搜索稿件、设定、评审…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setWorkspace('memory')
          }}
        />
      </div>
      <button
        className="nwe-btn is-ghost nwe-inspector-toggle"
        onClick={onToggleInspector}
        title="切换检查器"
        aria-label="切换检查器"
      >
        <PanelRight size={15} />
      </button>
      <button className="nwe-btn is-ghost" onClick={onPalette} title="命令面板 (Cmd/Ctrl+K)">
        <CommandIcon size={15} /> K
      </button>
    </header>
  )
}

function LeftRail({ pending }: { pending: number }) {
  const workspace = useStudio((state) => state.workspace)
  const setWorkspace = useStudio((state) => state.setWorkspace)
  const t = useT()
  return (
    <nav className="nwe-leftrail" aria-label={t('rail.workspaces')}>
      <div className="nwe-rail-label">{t('rail.workspaces')}</div>
      {WORKSPACES.map((id) => {
        const meta = WORKSPACE_META[id]
        const Icon = meta.icon
        return (
          <button
            key={id}
            className={`nwe-nav-item${workspace === id ? ' is-active' : ''}`}
            onClick={() => setWorkspace(id)}
            aria-current={workspace === id ? 'page' : undefined}
            aria-label={id === 'studio' && pending > 0 ? `${t(`nav.${id}`)} ${pending}` : t(`nav.${id}`)}
          >
            <Icon size={16} />
            <span>{t(`nav.${id}`)}</span>
            {id === 'studio' && pending > 0 ? <span className="nwe-nav-badge">{pending}</span> : null}
          </button>
        )
      })}
      <div className="nwe-rail-label">{t('rail.actions')}</div>
      <div className="nwe-pill" style={{ margin: '4px 11px' }}>
        API v8
      </div>
    </nav>
  )
}

function Statusbar({
  status,
  bootstrap,
  sseConnected,
}: {
  status?: Status
  bootstrap: Bootstrap
  sseConnected: boolean
}) {
  return (
    <footer className="nwe-statusbar">
      <span>字数 {fmt(status?.words)}</span>
      <span>评分 {fmt(status?.score)}</span>
      <span>Blocking {fmt(status?.blocking)}</span>
      <span>Run {statusLabel(status?.run?.status)}</span>
      <span>成本 ${(status?.cost_usd ?? 0).toFixed(2)}</span>
      <span className="nwe-row">
        <i className={`nwe-dot ${sseConnected ? 'is-ok' : 'is-bad'}`} /> SSE{' '}
        {sseConnected ? 'online' : 'offline'}
      </span>
      <span>v{bootstrap.version}</span>
      <span className="nwe-mono">taxonomy {bootstrap.taxonomy.tagCount}</span>
    </footer>
  )
}

function RightInspector({ status, findings }: { status?: Status; findings: Finding[] }) {
  const selectedId = useStudio((state) => state.selectedFindingId)
  const selected = findings.find((finding) => finding.id === selectedId)
  return (
    <aside className="nwe-rightrail" aria-label="检查器">
      <div className="nwe-inspector-label">Inspector</div>
      {selected !== undefined ? (
        <div className="nwe-col">
          <div className="nwe-row">
            <span className={`nwe-sev is-${selected.severity}`}>{selected.severity}</span>
            <span className="nwe-sub">{selected.role}</span>
          </div>
          <div className="nwe-h2">{selected.dimension}</div>
          <div className="nwe-sub">{selected.location}</div>
          <div className="nwe-evidence">{selected.evidence}</div>
          <div>
            <b>问题</b>
            <div className="nwe-sub">{selected.problem}</div>
          </div>
          <div>
            <b>修复</b>
            <div className="nwe-sub">{selected.fix}</div>
          </div>
          <div>
            <b>状态</b>
            <div className="nwe-sub">{selected.status}</div>
          </div>
        </div>
      ) : (
        <div className="nwe-col">
          <dl className="nwe-kv">
            <dt>章节</dt>
            <dd>{status?.chapter ?? '—'}</dd>
            <dt>阶段</dt>
            <dd>{statusLabel(status?.stage)}</dd>
            <dt>稿件</dt>
            <dd>{status?.counts.chapters ?? 0}</dd>
            <dt>已归档</dt>
            <dd>{status?.counts.archived ?? 0}</dd>
            <dt>Artifacts</dt>
            <dd>{status?.counts.artifacts ?? 0}</dd>
            <dt>开放问题</dt>
            <dd>{status?.counts.openFindings ?? 0}</dd>
          </dl>
          <div className="nwe-inspector-label">Next</div>
          <div className="nwe-card">
            <div className="nwe-card-title">{status?.next.action ?? '—'}</div>
            <div style={{ marginTop: 6 }}>{status?.next.label ?? '等待项目状态'}</div>
          </div>
          <div className="nwe-inspector-label">Gate</div>
          {status?.next.action === 'human.approve' || status?.run?.status === 'awaiting_human' ? (
            <div className="nwe-pill is-warn">
              <AlertTriangle size={12} /> 等待人工门
            </div>
          ) : status?.blocking !== undefined && status.blocking > 0 ? (
            <div className="nwe-pill is-bad">
              <AlertTriangle size={12} /> 需要人工处理
            </div>
          ) : (
            <div className="nwe-pill is-ok">
              <CheckCircle2 size={12} /> 可以继续
            </div>
          )}
        </div>
      )}
    </aside>
  )
}

function EmptyProject({ bootstrap }: { bootstrap: Bootstrap }) {
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  const [major, setMajor] = useState(bootstrap.taxonomy.majors[0]?.id ?? 'fantasy')
  const [sub, setSub] = useState('')
  const [tags, setTags] = useState<string[]>(['tone.hot_blooded', 'theme.growth', 'pace.fast'])
  const [audience, setAudience] = useState('male')
  const [platform, setPlatform] = useState('fanqie')
  const taxonomy = useQuery({
    queryKey: ['taxonomy-full'],
    queryFn: () =>
      api.getJson<{
        majors: Array<{ id: string; label: string; subs: Array<{ id: string; label: string }> }>
        tags: Array<{
          id: string
          label: string
          facet: string
          conflicts?: string[]
          requires?: string[]
          profile?: Record<string, unknown>
        }>
      }>('/taxonomy'),
  })
  const majors = taxonomy.data?.majors ?? bootstrap.taxonomy.majors.map((item) => ({ ...item, subs: [] }))
  const current = majors.find((item) => item.id === major)
  const subs = current?.subs ?? []
  useEffect(() => {
    if (sub === '' && subs.length > 0) setSub(subs[0]!.id)
  }, [sub, subs])
  const tagsByFacet = useMemo(() => {
    const map = new Map<string, Array<{ id: string; label: string }>>()
    for (const tag of taxonomy.data?.tags ?? []) {
      const rows = map.get(tag.facet) ?? []
      rows.push(tag)
      map.set(tag.facet, rows)
    }
    return [...map.entries()]
  }, [taxonomy.data?.tags])
  const selectionIssues = useMemo(() => {
    const rows = taxonomy.data?.tags ?? []
    const byId = new Map(rows.map((tag) => [tag.id, tag]))
    const conflicts: Array<[string, string]> = []
    const missing: string[] = []
    for (const id of tags) {
      const tag = byId.get(id)
      for (const conflict of tag?.conflicts ?? []) {
        if (tags.includes(conflict) && id < conflict) conflicts.push([id, conflict])
      }
      for (const required of tag?.requires ?? []) {
        if (!tags.includes(required)) missing.push(required)
      }
    }
    return { conflicts, missing: [...new Set(missing)] }
  }, [tags, taxonomy.data?.tags])
  const submit = async (): Promise<void> => {
    try {
      await postAction({
        action: 'project.init',
        title,
        author: '',
        genre: { major, sub, tags },
        audience,
        platform,
      })
      toast.success('项目已创建')
      await queryClient.invalidateQueries()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <div className="nwe-root">
      <style>{STUDIO_CSS}</style>
      <div className="nwe-center" style={{ maxWidth: 920, margin: '0 auto', width: '100%' }}>
        <div className="nwe-heading">
          <div>
            <h1 className="nwe-h1">创建第一本书</h1>
            <div className="nwe-sub">0.3.0 使用大类 / 小类 / 标签三级体系；受众与平台独立选择。</div>
          </div>
        </div>
        <div className="nwe-grid cols-2">
          <div className="nwe-card nwe-col">
            <label>
              书名
              <input
                className="nwe-input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例如：城南旧铺"
              />
            </label>
            <label>
              大类
              <select
                className="nwe-select"
                value={major}
                onChange={(event) => {
                  setMajor(event.target.value)
                  setSub('')
                }}
              >
                {majors.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              小类
              <select className="nwe-select" value={sub} onChange={(event) => setSub(event.target.value)}>
                {subs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="nwe-row">
              <label style={{ flex: 1 }}>
                受众
                <select
                  className="nwe-select"
                  value={audience}
                  onChange={(event) => setAudience(event.target.value)}
                >
                  <option value="male">男频</option>
                  <option value="female">女频</option>
                  <option value="general">通用</option>
                  <option value="teen">青少年</option>
                  <option value="adult">成人</option>
                </select>
              </label>
              <label style={{ flex: 1 }}>
                平台
                <select
                  className="nwe-select"
                  value={platform}
                  onChange={(event) => setPlatform(event.target.value)}
                >
                  <option value="fanqie">番茄</option>
                  <option value="qidian">起点</option>
                  <option value="qimao">七猫</option>
                  <option value="jinjiang">晋江</option>
                </select>
              </label>
            </div>
            {selectionIssues.conflicts.length > 0 ? (
              <div className="nwe-pill is-bad" role="alert">
                标签冲突：{selectionIssues.conflicts.map(([left, right]) => `${left} × ${right}`).join('；')}
              </div>
            ) : null}
            {selectionIssues.missing.length > 0 ? (
              <div className="nwe-pill is-warn" role="status">
                缺少依赖：{selectionIssues.missing.join('、')}
              </div>
            ) : null}
            <button
              className="nwe-btn is-primary"
              disabled={
                title.trim() === '' ||
                sub === '' ||
                tags.length < 3 ||
                selectionIssues.conflicts.length > 0 ||
                selectionIssues.missing.length > 0
              }
              onClick={() => void submit()}
            >
              创建项目
            </button>
          </div>
          <div className="nwe-card">
            <div className="nwe-h2">标签（3–12 个）</div>
            <div className="nwe-col" style={{ maxHeight: 440, overflow: 'auto' }}>
              {tagsByFacet.map(([facet, rows]) => (
                <div key={facet}>
                  <div className="nwe-card-title">{facet}</div>
                  <div className="nwe-row nwe-wrap" style={{ marginTop: 6 }}>
                    {rows.slice(0, 30).map((tag) => {
                      const active = tags.includes(tag.id)
                      return (
                        <button
                          key={tag.id}
                          className={`nwe-pill${active ? ' is-ok' : ''}`}
                          onClick={() =>
                            setTags((currentTags) =>
                              active
                                ? currentTags.filter((id) => id !== tag.id)
                                : currentTags.length >= 12
                                  ? currentTags
                                  : [...currentTags, tag.id],
                            )
                          }
                        >
                          {tag.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <Toaster richColors position="bottom-right" />
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="nwe-empty">
      <div>
        <AlertTriangle size={22} />
        <div style={{ marginTop: 8 }}>{message}</div>
        <button className="nwe-btn" style={{ marginTop: 10 }} onClick={onRetry}>
          <RefreshCw size={14} /> 重试
        </button>
      </div>
    </div>
  )
}

function Overview({ status, board }: { status?: Status; board?: Board }) {
  const queryClient = useQueryClient()
  const setWorkspace = useStudio((state) => state.setWorkspace)
  const action = async (body: Record<string, unknown>, success: string): Promise<void> => {
    try {
      await postAction(body)
      toast.success(success)
      await queryClient.invalidateQueries()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <div className="nwe-col" style={{ gap: 16 }}>
      <div className="nwe-heading">
        <div>
          <WorkspaceTitle id="overview" />
          <div className="nwe-sub">当前 Run、下一步、人工门、健康与成本。</div>
        </div>
        <div className="nwe-row">
          <button
            className="nwe-btn is-primary"
            disabled={
              status?.run !== undefined &&
              status.run !== null &&
              ['queued', 'running', 'awaiting_human', 'paused'].includes(status.run.status)
            }
            onClick={() =>
              void action(
                { action: 'run.start', kind: 'chapter', chapter: status?.chapter ?? 1 },
                'Run 已创建',
              )
            }
          >
            <Play size={14} /> 启动章节
          </button>
          <button
            className="nwe-btn"
            disabled={
              status?.run === undefined ||
              status.run === null ||
              status.next.action === 'human.approve' ||
              (status.run.status !== 'running' && status.run.status !== 'queued')
            }
            onClick={() => void action({ action: 'run.tick', runId: status?.run?.id }, 'Run 已推进')}
          >
            <RefreshCw size={14} /> 推进
          </button>
        </div>
      </div>
      <div className="nwe-grid cols-4">
        <div className="nwe-card">
          <div className="nwe-card-title">当前 Run</div>
          <div className="nwe-stat is-text">{statusLabel(status?.run?.status)}</div>
          <div className="nwe-sub">
            {status?.run?.kind ?? '—'} · 第 {status?.run?.targetChapter ?? status?.chapter ?? 1} 章
          </div>
        </div>
        <div className="nwe-card">
          <div className="nwe-card-title">字数</div>
          <div className="nwe-stat">
            {fmt(status?.words)}
            <span className="nwe-stat-unit"> 字</span>
          </div>
          <div className="nwe-sub">已归档 {status?.counts.archived ?? 0} 章</div>
        </div>
        <div className="nwe-card">
          <div className="nwe-card-title">评分</div>
          <div className="nwe-stat">
            {fmt(status?.score)}
            <span className="nwe-stat-unit"> / 150</span>
          </div>
          <div className="nwe-sub">最低 {status?.min_score ?? 120}</div>
        </div>
        <div className="nwe-card">
          <div className="nwe-card-title">成本</div>
          <div className="nwe-stat">${(status?.cost_usd ?? 0).toFixed(2)}</div>
          <div className="nwe-sub">本次 Run</div>
        </div>
      </div>
      <div className="nwe-grid cols-2">
        <section className="nwe-card">
          <div className="nwe-h2">下一步</div>
          <div className="nwe-row">
            <span className="nwe-pill is-warn">{status?.next.action ?? '—'}</span>
            <span>{status?.next.label ?? '等待状态'}</span>
          </div>
          <div className="nwe-inspector-label">人工门</div>
          {board?.gates.length === 0 ? (
            <div className="nwe-sub">没有等待中的门。</div>
          ) : (
            board?.gates.map((gate) => (
              <div className="nwe-row" key={gate.id}>
                <span className="nwe-sev is-advisory">{gate.gate}</span>
                <span className="nwe-sub">第 {gate.chapter ?? '—'} 章</span>
                <button
                  className="nwe-btn"
                  onClick={() =>
                    void action(
                      {
                        action: 'human.approve',
                        gateId: gate.id,
                        decision: 'approve',
                        actor: 'author',
                        reason: 'workbench approve',
                      },
                      '已批准',
                    )
                  }
                >
                  批准
                </button>
                <button
                  className="nwe-btn is-ghost"
                  onClick={() =>
                    void action(
                      {
                        action: 'human.approve',
                        gateId: gate.id,
                        decision: 'reject',
                        actor: 'author',
                        reason: 'workbench reject',
                      },
                      '已驳回',
                    )
                  }
                >
                  驳回
                </button>
              </div>
            ))
          )}
        </section>
        <section className="nwe-card">
          <div className="nwe-h2">最近 Run</div>
          <div className="nwe-list">
            {board?.runs.slice(0, 6).map((run) => (
              <button
                className="nwe-list-row"
                key={run.id}
                style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto', border: 0 }}
                onClick={() => setWorkspace('studio')}
              >
                <span className="nwe-truncate">
                  {run.kind} · 第 {run.targetChapter ?? '—'} 章
                </span>
                <span className={`nwe-pill ${statusTone(run.status)}`}>{statusLabel(run.status)}</span>
                <span className="nwe-mono">{run.id.slice(-6)}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

const setReviewEvidence = StateEffect.define<readonly string[]>()

const buildEvidenceDecorations = (text: string, evidence: readonly string[]): DecorationSet => {
  const ranges: Array<{ from: number; to: number }> = []
  for (const quote of evidence) {
    const needle = quote.trim()
    if (needle.length < 4) continue
    let from = text.indexOf(needle)
    while (from !== -1) {
      ranges.push({ from, to: from + needle.length })
      from = text.indexOf(needle, from + needle.length)
    }
  }
  ranges.sort((left, right) => left.from - right.from)
  const marks: Array<Range<Decoration>> = []
  let lastTo = -1
  for (const range of ranges) {
    if (range.from < lastTo) continue
    marks.push(Decoration.mark({ class: 'nwe-review-mark' }).range(range.from, range.to))
    lastTo = range.to
  }
  return Decoration.set(marks)
}

const evidenceField = StateField.define<{ evidence: readonly string[]; decorations: DecorationSet }>({
  create: () => ({ evidence: [], decorations: Decoration.none }),
  update(value, transaction) {
    let evidence = value.evidence
    let changed = transaction.docChanged
    for (const effect of transaction.effects) {
      if (effect.is(setReviewEvidence)) {
        evidence = effect.value
        changed = true
      }
    }
    if (!changed) return value
    return {
      evidence,
      decorations: buildEvidenceDecorations(transaction.newDoc.toString(), evidence),
    }
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

function CodeEditor({
  value,
  onChange,
  evidence = [],
}: {
  value: string
  onChange: (value: string) => void
  evidence?: readonly string[]
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(onChange)
  latest.current = onChange
  useEffect(() => {
    if (host.current === null) return
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          drawSelection(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': '正文编辑器' }),
          evidenceField,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current(update.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
    // The editor is created once; value changes are applied below.
  }, [])
  useEffect(() => {
    const editor = view.current
    if (editor === null) return
    if (editor.state.doc.toString() === value) return
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
  }, [value])
  useEffect(() => {
    view.current?.dispatch({ effects: setReviewEvidence.of([...evidence]) })
  }, [evidence])
  return <div className="nwe-editor" ref={host} />
}

function Manuscript({ status, evidence }: { status?: Status; evidence: Finding[] }) {
  const chapter = useStudio((state) => state.chapter)
  const setChapter = useStudio((state) => state.setChapter)
  const queryClient = useQueryClient()
  const t = useT()
  const chapters = useQuery({
    queryKey: ['chapters'],
    queryFn: () => api.getJson<{ rows: ChapterRow[] }>('/chapters'),
  })
  const manuscript = useQuery({
    queryKey: ['manuscript', chapter],
    queryFn: () =>
      api.getJson<{
        chapter: number
        title: string
        text: string
        archived: boolean
        draft: { id: string; version: number; status: string; hash: string } | null
      }>('/manuscript', { chapter }),
  })
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const loadedChapter = useRef<number | null>(null)
  const reviewEvidence = useMemo(() => evidence.map((finding) => finding.evidence), [evidence])
  const [commentBody, setCommentBody] = useState('')
  const [paragraph, setParagraph] = useState('1')
  const [diff, setDiff] = useState<{ left: string; right: string; unified: string } | null>(null)
  const versions = useQuery({
    queryKey: ['versions', chapter],
    queryFn: () =>
      api.getJson<{
        versions: Array<{
          id: string
          kind: string
          version: number
          status: string
          createdAt: string
          contentHash: string
          taskId: string | null
        }>
      }>('/versions', { chapter }),
  })
  const comments = useQuery({
    queryKey: ['comments', chapter],
    queryFn: () =>
      api.getJson<{
        comments: Array<{
          id: string
          chapter: number | null
          paragraph: number | null
          author: string
          body: string
          status: string
          createdAt: string
        }>
      }>('/comments', { chapter }),
  })
  useEffect(() => {
    if (manuscript.data === undefined) return
    if (loadedChapter.current !== manuscript.data.chapter || !dirty) {
      setText(manuscript.data.text)
      loadedChapter.current = manuscript.data.chapter
      setDirty(false)
    }
  }, [manuscript.data, dirty])
  const save = async (): Promise<void> => {
    try {
      await postAction({
        action: 'chapter.save',
        chapter,
        content: text,
        baseHash: manuscript.data?.draft?.hash ?? null,
        actor: 'author',
      })
      setDirty(false)
      toast.success('已保存新版本')
      await queryClient.invalidateQueries()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  useEffect(() => {
    const handler = (): void => {
      void save()
    }
    window.addEventListener('nwe:save', handler)
    return () => window.removeEventListener('nwe:save', handler)
  }, [save])
  const restoreVersion = async (id: string): Promise<void> => {
    if (!window.confirm('把该版本恢复为新的 Draft？历史版本不会删除。')) return
    try {
      await postAction({ action: 'artifact.restore', id, actor: 'author', reason: 'version restore' })
      setDirty(false)
      toast.success('已恢复为新版本')
      await queryClient.invalidateQueries()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const exportChapter = async (kind: 'markdown' | 'txt'): Promise<void> => {
    try {
      const response = await postAction<{ result: { path: string; bytes: number } }>({
        action: 'export.run',
        kind,
        chapter,
      })
      toast.success(`已导出 ${response.result.path}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const compare = async (id: string): Promise<void> => {
    const current = manuscript.data?.draft?.id
    if (current === undefined) {
      toast.error('当前章没有可对比的版本')
      return
    }
    try {
      const [oldVersion, newVersion, unified] = await Promise.all([
        api.getJson<{ content: unknown }>('/artifact', { id }),
        api.getJson<{ content: unknown }>('/artifact', { id: current }),
        api.getJson<{ diff: string }>('/diff', { left: id, right: current }),
      ])
      const textOfArtifact = (value: unknown): string => {
        if (typeof value === 'string') return value
        if (typeof value === 'object' && value !== null && 'content' in value)
          return String((value as { content: unknown }).content)
        return JSON.stringify(value, null, 2)
      }
      setDiff({
        left: textOfArtifact(oldVersion.content),
        right: textOfArtifact(newVersion.content),
        unified: unified.diff,
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const addComment = async (): Promise<void> => {
    if (commentBody.trim() === '') return
    try {
      await postAction({
        action: 'comment.create',
        chapter,
        paragraph: Number(paragraph),
        body: commentBody,
        actor: 'author',
      })
      setCommentBody('')
      toast.success('评论已添加')
      await queryClient.invalidateQueries({ queryKey: ['comments', chapter] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const setCommentStatus = async (id: string, status: 'open' | 'resolved'): Promise<void> => {
    try {
      await postAction({ action: 'comment.resolve', id, status })
      await queryClient.invalidateQueries({ queryKey: ['comments', chapter] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <div className="nwe-col" style={{ gap: 14 }}>
      <div className="nwe-heading">
        <div>
          <WorkspaceTitle id="manuscript" />
          <div className="nwe-sub">正文是唯一真实来源；保存会生成新的 Draft 版本。</div>
        </div>
        <div className="nwe-row">
          <button className="nwe-btn is-primary" onClick={() => void save()}>
            <Save size={14} /> {t('action.save')}
          </button>
          <button className="nwe-btn" onClick={() => void exportChapter('markdown')}>
            MD
          </button>
          <button className="nwe-btn" onClick={() => void exportChapter('txt')}>
            TXT
          </button>
          <button
            className="nwe-btn"
            aria-label={t('action.refresh')}
            onClick={() => void queryClient.invalidateQueries()}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      <div className="nwe-grid nwe-manuscript-grid">
        <div className="nwe-card" style={{ maxHeight: 'calc(100vh - 220px)', overflow: 'auto' }}>
          <div className="nwe-card-title">章节</div>
          <div className="nwe-list">
            {chapters.data?.rows.map((row) => (
              <button
                key={row.chapter}
                className={`nwe-list-row${row.chapter === chapter ? ' is-active' : ''}`}
                style={{ gridTemplateColumns: '48px 1fr', padding: '7px 8px' }}
                onClick={() => setChapter(row.chapter)}
              >
                <span className="nwe-mono">CH{String(row.chapter).padStart(2, '0')}</span>
                <span className="nwe-truncate">{row.title || '未命名'}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="nwe-col">
          <div className="nwe-row">
            <span className="nwe-pill">{manuscript.data?.title || `第 ${chapter} 章`}</span>
            <span className="nwe-pill">{manuscript.data?.draft?.status ?? '无草稿'}</span>
            <span className="nwe-pill">v{manuscript.data?.draft?.version ?? '—'}</span>
            {manuscript.data?.archived ? <span className="nwe-pill is-ok">已归档</span> : null}
            {dirty ? <span className="nwe-pill is-warn">未保存</span> : null}
            <span className={`nwe-pill ${(status?.blocking ?? 0) > 0 ? 'is-bad' : 'is-ok'}`}>
              blocking {status?.blocking ?? 0}
            </span>
            <span className="nwe-sub" style={{ whiteSpace: 'nowrap' }}>
              {text.length} 字符
            </span>
          </div>
          <div className="nwe-editor-wrap">
            <CodeEditor
              value={text}
              onChange={(value) => {
                setText(value)
                setDirty(value !== (manuscript.data?.text ?? ''))
              }}
              evidence={reviewEvidence}
            />
          </div>
          <div className="nwe-sub">
            {dirty
              ? '有未保存修改；保存后生成新 Draft，不消耗评审轮次。'
              : '评审证据会在正文中高亮；评论与轮次在评审/稿件工作区处理。'}
          </div>
        </div>
      </div>
      <div className="nwe-grid cols-2">
        <div className="nwe-card">
          <div className="nwe-h2">{t('card.versions')}</div>
          <div className="nwe-sub">保存手工编辑会生成新版本；选择旧版本查看与当前草稿的 diff。</div>
          <div className="nwe-list" style={{ marginTop: 8 }}>
            {versions.data?.versions
              .filter((version) => version.kind === 'Draft')
              .map((version) => (
                <div className="nwe-row" key={version.id}>
                  <span className="nwe-pill">v{version.version}</span>
                  <span className="nwe-sub">{version.kind}</span>
                  <span className="nwe-pill">{version.status}</span>
                  <button className="nwe-btn is-ghost" onClick={() => void compare(version.id)}>
                    {t('action.compare')}
                  </button>
                  <button className="nwe-btn is-ghost" onClick={() => void restoreVersion(version.id)}>
                    {t('action.restore')}
                  </button>
                </div>
              ))}
            {(versions.data?.versions.length ?? 0) === 0 ? (
              <div className="nwe-sub">还没有版本记录。</div>
            ) : null}
          </div>
          {diff !== null ? (
            <div className="nwe-grid cols-2" style={{ marginTop: 10 }}>
              <div>
                <div className="nwe-inspector-label">旧版本</div>
                <pre className="nwe-diff" aria-label="旧版本正文">
                  {diff.left}
                </pre>
              </div>
              <div>
                <div className="nwe-inspector-label">当前版本</div>
                <pre className="nwe-diff" aria-label="当前版本正文">
                  {diff.right}
                </pre>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <div className="nwe-inspector-label">Unified diff</div>
                <pre className="nwe-diff" aria-label="版本差异">
                  {diff.unified}
                </pre>
              </div>
            </div>
          ) : null}
        </div>
        <div className="nwe-card">
          <div className="nwe-h2">{t('card.comments')}</div>
          <div className="nwe-row">
            <input
              className="nwe-input"
              style={{ maxWidth: 90 }}
              value={paragraph}
              onChange={(event) => setParagraph(event.target.value)}
              aria-label="段落号"
            />
            <input
              className="nwe-input"
              value={commentBody}
              onChange={(event) => setCommentBody(event.target.value)}
              placeholder="针对这一段写评论…"
            />
            <button className="nwe-btn is-primary" onClick={() => void addComment()}>
              {t('action.add')}
            </button>
          </div>
          <div className="nwe-list" style={{ marginTop: 8 }}>
            {comments.data?.comments.map((comment) => (
              <div className="nwe-card" key={comment.id}>
                <div className="nwe-row">
                  <span className="nwe-pill">第 {comment.paragraph ?? '—'} 段</span>
                  <span className="nwe-sub">{comment.author}</span>
                  <span className={`nwe-pill ${comment.status === 'resolved' ? 'is-ok' : ''}`}>
                    {comment.status}
                  </span>
                </div>
                <div style={{ marginTop: 6 }}>{comment.body}</div>
                <button
                  className="nwe-btn is-ghost"
                  onClick={() =>
                    void setCommentStatus(comment.id, comment.status === 'resolved' ? 'open' : 'resolved')
                  }
                >
                  {comment.status === 'resolved' ? '重开' : '解决'}
                </button>
              </div>
            ))}
            {(comments.data?.comments.length ?? 0) === 0 ? <div className="nwe-sub">没有评论。</div> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function Outline() {
  const chapter = useStudio((state) => state.chapter)
  const setChapter = useStudio((state) => state.setChapter)
  const setWorkspace = useStudio((state) => state.setWorkspace)
  const queryClient = useQueryClient()
  const t = useT()
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const outline = useQuery({
    queryKey: ['outline'],
    queryFn: () =>
      api.getJson<{
        book: Record<string, unknown>
        chapters: Array<Record<string, unknown>>
        foreshadows: Array<Record<string, unknown>>
      }>('/outline'),
  })
  const chapters = outline.data?.chapters ?? []
  const foreshadows = outline.data?.foreshadows ?? []
  const book = outline.data?.book as
    | {
        logline?: string
        acts?: Array<{ id: string; title: string; summary: string }>
        volumes?: Array<{
          id: string
          title: string
          start_chapter: number
          end_chapter: number
          arc: string
        }>
      }
    | undefined
  const move = async (to: number): Promise<void> => {
    if (dragFrom === null || dragFrom === to) return
    try {
      await postAction({ action: 'outline.move', from: dragFrom, to })
      toast.success(`已将第 ${dragFrom} 章移到第 ${to} 章位置`)
      await queryClient.invalidateQueries()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setDragFrom(null)
    }
  }
  const advance = async (key: string, status: 'open' | 'advanced' | 'resolved'): Promise<void> => {
    const anchor =
      status === 'resolved'
        ? (window.prompt('回收锚点：粘贴正文里真正闭合伏笔的那句话') ?? undefined)
        : undefined
    if (status === 'resolved' && anchor === undefined) return
    try {
      await postAction({ action: 'foreshadow.status', key, status, anchor })
      toast.success('伏笔状态已更新')
      await queryClient.invalidateQueries()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const columns: Array<{ id: 'open' | 'advanced' | 'resolved'; label: string }> = [
    { id: 'open', label: 'Planted / 已埋' },
    { id: 'advanced', label: 'Advanced / 推进' },
    { id: 'resolved', label: 'Resolved / 回收' },
  ]
  return (
    <div className="nwe-col" style={{ gap: 14 }}>
      <div className="nwe-heading">
        <div>
          <WorkspaceTitle id="outline" />
          <div className="nwe-sub">书 → 卷/幕 → 弧 → 章卡；拖拽章卡排序，拖拽伏笔推进状态。</div>
        </div>
      </div>
      <div className="nwe-grid cols-2">
        <div className="nwe-card">
          <div className="nwe-h2">书 / 卷 / 幕</div>
          <div className="nwe-sub">{book?.logline || '还没有 logline。'}</div>
          <div className="nwe-list" style={{ marginTop: 8 }}>
            {(book?.volumes ?? []).map((volume) => (
              <div className="nwe-row" key={volume.id}>
                <span className="nwe-pill">卷</span>
                <span>{volume.title}</span>
                <span className="nwe-sub">
                  第 {volume.start_chapter}–{volume.end_chapter} 章
                </span>
                <span className="nwe-sub">{volume.arc}</span>
              </div>
            ))}
            {(book?.volumes ?? []).length === 0 ? <div className="nwe-sub">暂无卷结构。</div> : null}
          </div>
        </div>
        <div className="nwe-card">
          <div className="nwe-h2">幕</div>
          <div className="nwe-list" style={{ marginTop: 8 }}>
            {(book?.acts ?? []).map((act) => (
              <div className="nwe-col" key={act.id} style={{ gap: 2 }}>
                <div className="nwe-row">
                  <span className="nwe-pill">{act.id}</span>
                  <span>{act.title}</span>
                </div>
                <div className="nwe-sub">{act.summary}</div>
              </div>
            ))}
            {(book?.acts ?? []).length === 0 ? <div className="nwe-sub">暂无三幕结构。</div> : null}
          </div>
        </div>
      </div>
      <div className="nwe-grid cols-3">
        {chapters.length === 0 ? (
          <div className="nwe-empty" style={{ gridColumn: '1 / -1' }}>
            还没有章卡：启动 BookRun 或让架构师提议 OutlinePlan。
          </div>
        ) : (
          chapters.map((card) => (
            <div
              className={`nwe-card${Number(card.chapter) === chapter ? ' is-selected' : ''}`}
              key={String(card.chapter)}
              onClick={() => {
                setChapter(Number(card.chapter))
                setWorkspace('manuscript')
              }}
              role="button"
              tabIndex={0}
              draggable
              onDragStart={() => setDragFrom(Number(card.chapter))}
              onDragEnd={() => setDragFrom(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => void move(Number(card.chapter))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  setChapter(Number(card.chapter))
                  setWorkspace('manuscript')
                }
              }}
            >
              <div className="nwe-row">
                <span className="nwe-pill">CH {String(card.chapter).padStart(2, '0')}</span>
                <span className="nwe-pill">{String(card.scene_type ?? '')}</span>
              </div>
              <div className="nwe-h2" style={{ marginTop: 8 }}>
                {String(card.title ?? '未命名')}
              </div>
              <div className="nwe-sub">{String(card.goal ?? card.notes ?? '')}</div>
              <div className="nwe-inspector-label">Hook</div>
              <div className="nwe-sub">{String(card.hook ?? '—')}</div>
            </div>
          ))
        )}
      </div>
      <div className="nwe-card">
        <div className="nwe-h2">{t('card.foreshadowBoard')}</div>
        <div className="nwe-sub">状态来自 canon.yaml；回收必须有正文锚点，不能只改状态。</div>
        <div
          className="nwe-kanban nwe-kanban-3"
          tabIndex={0}
          aria-label="伏笔状态看板"
          style={{ marginTop: 10 }}
        >
          {columns.map((column) => {
            const rows = foreshadows.filter((row) => {
              const status = String(row.status ?? 'open')
              return column.id === 'open' ? status === 'open' || status === 'planted' : status === column.id
            })
            return (
              <div
                className="nwe-kanban-col"
                key={column.id}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  const key = event.dataTransfer.getData('text/plain')
                  if (key !== '') void advance(key, column.id)
                }}
              >
                <div className="nwe-kanban-head">
                  <span>{column.label}</span>
                  <span>{rows.length}</span>
                </div>
                {rows.map((row) => {
                  const key = String(row.key ?? row.id ?? row.title ?? '')
                  return (
                    <div
                      className="nwe-card"
                      key={key}
                      draggable
                      onDragStart={(event) => event.dataTransfer.setData('text/plain', key)}
                      style={{ marginBottom: 8 }}
                    >
                      <div style={{ fontWeight: 600 }}>{String(row.title ?? key)}</div>
                      <div className="nwe-sub">
                        计划回收第 {String(row.planned_chapter ?? row.resolve_by ?? '—')} 章 · 已出现第{' '}
                        {String(row.planted_chapter ?? row.planted_at ?? '—')} 章
                      </div>
                      {row.resolved_anchor === undefined ? null : (
                        <div className="nwe-evidence">{String(row.resolved_anchor)}</div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Bible() {
  const bible = useQuery({
    queryKey: ['bible'],
    queryFn: () =>
      api.getJson<{
        bible: {
          premise: string
          themes: string
          styleGuide: string
          world: {
            rules: string[]
            factions: string[]
            locations: string[]
            glossary: Record<string, string>
          }
          characters: Array<Record<string, unknown>>
          codex?: Array<Record<string, unknown>>
        }
        canon: {
          relationships: Array<Record<string, unknown>>
          timeline: Array<Record<string, unknown>>
          foreshadows: Array<Record<string, unknown>>
        }
        backlinks: Record<
          string,
          {
            chapters: number[]
            foreshadows: string[]
            reviews: Array<{ chapter: number | null; role: string }>
          }
        >
      }>('/bible'),
  })
  const data = bible.data
  const nodes: Node[] = useMemo(
    () =>
      (data?.bible.characters ?? []).map((character, index) => ({
        id: String(character.slug ?? index),
        position: { x: (index % 4) * 190, y: Math.floor(index / 4) * 120 },
        data: { label: String(character.name ?? character.slug ?? '角色') },
        className: 'nwe-flow-node',
      })),
    [data],
  )
  const edges: Edge[] = useMemo(
    () =>
      (data?.canon.relationships ?? [])
        .map((relation, index) => ({
          id: `r${index}`,
          source: String(relation.from ?? ''),
          target: String(relation.to ?? ''),
          label: String(relation.type_code ?? ''),
        }))
        .filter(
          (edge) =>
            nodes.some((node) => node.id === edge.source) && nodes.some((node) => node.id === edge.target),
        ),
    [data, nodes],
  )
  return (
    <div className="nwe-col" style={{ gap: 14 }}>
      <div className="nwe-heading">
        <div>
          <WorkspaceTitle id="bible" />
          <div className="nwe-sub">实体、canon facts、关系、时间线与反链。</div>
        </div>
      </div>
      <div className="nwe-grid cols-2">
        <div className="nwe-card">
          <div className="nwe-h2">前提</div>
          <div className="nwe-sub" style={{ whiteSpace: 'pre-wrap' }}>
            {data?.bible.premise || '（待填写）'}
          </div>
          <div className="nwe-inspector-label">主题</div>
          <div className="nwe-sub" style={{ whiteSpace: 'pre-wrap' }}>
            {data?.bible.themes || '（待填写）'}
          </div>
        </div>
        <div className="nwe-card">
          <div className="nwe-h2">世界规则</div>
          {data?.bible.world.rules.length === 0 ? (
            <div className="nwe-sub">暂无</div>
          ) : (
            <ul>
              {data?.bible.world.rules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          )}
          <div className="nwe-inspector-label">地点 / 势力</div>
          <div className="nwe-sub">
            {[...(data?.bible.world.locations ?? []), ...(data?.bible.world.factions ?? [])].join(' · ') ||
              '暂无'}
          </div>
          {(data?.bible.codex ?? []).length > 0 ? (
            <>
              <div className="nwe-inspector-label">Codex 条目</div>
              <div className="nwe-list">
                {(data?.bible.codex ?? []).map((entry, index) => (
                  <div className="nwe-row" key={String(entry.key ?? entry.name ?? index)}>
                    <span className="nwe-pill">{String(entry.entity_kind ?? '条目')}</span>
                    <span>{String(entry.name ?? entry.key ?? '')}</span>
                    <span className="nwe-sub">{String(entry.summary ?? '')}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
      <div className="nwe-grid cols-2">
        <div className="nwe-card">
          <div className="nwe-h2">角色</div>
          <div className="nwe-list">
            {data?.bible.characters.map((character, index) => (
              <div className="nwe-col" key={String(character.slug ?? index)} style={{ gap: 2 }}>
                <div className="nwe-row">
                  <span className="nwe-pill">{String(character.role ?? '角色')}</span>
                  <span>{String(character.name ?? character.slug ?? '')}</span>
                </div>
                <div className="nwe-sub">
                  出场：第{' '}
                  {(data.backlinks[String(character.name ?? character.slug ?? '')]?.chapters ?? []).join(
                    '、',
                  ) || '—'}{' '}
                  章 · 伏笔{' '}
                  {(data.backlinks[String(character.name ?? character.slug ?? '')]?.foreshadows ?? []).join(
                    '、',
                  ) || '—'}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="nwe-card">
          <div className="nwe-h2">关系图</div>
          {nodes.length === 0 ? (
            <div className="nwe-sub">暂无角色关系。</div>
          ) : (
            <div className="nwe-flow">
              <ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.3 }}>
                <Background />
              </ReactFlow>
            </div>
          )}
        </div>
      </div>
      <div className="nwe-grid cols-2">
        <div className="nwe-card">
          <div className="nwe-h2">时间线</div>
          {data?.canon.timeline.length === 0 ? (
            <div className="nwe-sub">暂无 canon 时间线事件。</div>
          ) : (
            <div className="nwe-list">
              {data?.canon.timeline.map((event, index) => (
                <div className="nwe-row" key={String(event.id ?? index)}>
                  <span className="nwe-pill">CH {String(event.chapter ?? '—')}</span>
                  <span>{String(event.title ?? event.event ?? event.summary ?? '事件')}</span>
                  <span className="nwe-sub">{String(event.time ?? event.date ?? '')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="nwe-card">
          <div className="nwe-h2">伏笔反链</div>
          {data?.canon.foreshadows.length === 0 ? (
            <div className="nwe-sub">暂无伏笔。</div>
          ) : (
            <div className="nwe-list">
              {data?.canon.foreshadows.map((row, index) => (
                <div className="nwe-col" key={String(row.key ?? row.id ?? index)} style={{ gap: 2 }}>
                  <div className="nwe-row">
                    <span className="nwe-pill">{String(row.status ?? 'open')}</span>
                    <span>{String(row.title ?? row.key ?? '伏笔')}</span>
                  </div>
                  <div className="nwe-sub">
                    计划回收第 {String(row.planned_chapter ?? row.resolve_by ?? '—')} 章
                    {row.resolved_anchor === undefined ? '' : ` · ${String(row.resolved_anchor)}`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Studio({ board, roles }: { board?: Board; roles: Bootstrap['roles'] }) {
  const queryClient = useQueryClient()
  const chapter = useStudio((state) => state.chapter)
  const action = async (body: Record<string, unknown>, success: string): Promise<void> => {
    try {
      await postAction(body)
      toast.success(success)
      await queryClient.invalidateQueries()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const columns = ['queued', 'leased', 'running', 'awaiting_human', 'retry_wait', 'completed', 'failed']
  const columnTasks = (column: string) =>
    tasks.filter((task) =>
      column === 'running'
        ? task.status === 'running' || task.status === 'validating'
        : task.status === column,
    )
  const tasks = board?.tasks ?? []
  const visibleTasks = tasks.slice(0, 60)
  const nodes: Node[] = visibleTasks.map((task, index) => ({
    id: task.id,
    position: { x: (index % 6) * 180, y: Math.floor(index / 6) * 100 },
    data: { label: `${task.role} · ${task.kind}`, status: task.status },
    className: 'nwe-flow-node',
  }))
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges: Edge[] = visibleTasks.flatMap((task) =>
    (task.dependsOn ?? [])
      .filter((dependency) => nodeIds.has(dependency))
      .map((dependency) => ({
        id: `${dependency}->${task.id}`,
        source: dependency,
        target: task.id,
      })),
  )
  const assignments = new Map((board?.assignments ?? []).map((row) => [row.taskId, row]))
  const activeRun =
    board?.runs.find((run) => ['queued', 'running', 'awaiting_human', 'paused'].includes(run.status)) ??
    board?.runs[0]
  const runId = activeRun?.id
  const running =
    activeRun !== undefined && ['queued', 'running', 'awaiting_human'].includes(activeRun.status)
  const advanceable = activeRun?.status === 'queued' || activeRun?.status === 'running'
  const pausable = activeRun?.status === 'running'
  const paused = activeRun?.status === 'paused'
  return (
    <div className="nwe-col" style={{ gap: 14 }}>
      <div className="nwe-heading">
        <div>
          <WorkspaceTitle id="studio" />
          <div className="nwe-sub">Run Board、DAG、角色、人工门与实时事件。</div>
        </div>
        <div className="nwe-row">
          <button
            className="nwe-btn is-primary"
            onClick={() =>
              void action({ action: 'run.start', kind: 'chapter', chapter }, `第 ${chapter} 章 Run 已创建`)
            }
          >
            <Play size={14} /> 启动
          </button>
          <button
            className="nwe-btn"
            disabled={!advanceable}
            onClick={() => void action({ action: 'run.tick', runId }, '已推进')}
          >
            推进
          </button>
          <button
            className="nwe-btn"
            disabled={!pausable}
            onClick={() => void action({ action: 'run.pause', runId }, '已暂停')}
          >
            暂停
          </button>
          <button
            className="nwe-btn"
            disabled={!paused}
            onClick={() => void action({ action: 'run.resume', runId }, '已恢复')}
          >
            恢复
          </button>
          <button
            className="nwe-btn is-danger"
            disabled={!running && !paused}
            onClick={() => void action({ action: 'run.cancel', runId }, '已取消')}
          >
            取消
          </button>
        </div>
      </div>
      <div className="nwe-kanban" tabIndex={0} aria-label="Run 看板">
        {columns.map((column) => (
          <div className="nwe-kanban-col" key={column}>
            <div className="nwe-kanban-head">
              <span>{statusLabel(column)}</span>
              <span>{columnTasks(column).length}</span>
            </div>
            {columnTasks(column).map((task) => {
              const assignment = assignments.get(task.id)
              const usage = assignment?.usage ?? undefined
              return (
                <div className="nwe-task" key={task.id}>
                  <div className="nwe-task-title">
                    <b>{task.role}</b>
                    <span className={`nwe-pill ${statusTone(task.status)}`}>{statusLabel(task.status)}</span>
                  </div>
                  <div className="nwe-task-meta">
                    {task.kind} · attempt {task.attempt}/{task.maxAttempts}
                  </div>
                  {assignment === undefined ? null : (
                    <div className="nwe-task-meta">
                      {assignment.model ?? assignment.preset ?? assignment.provider ?? 'inherit'} ·{' '}
                      {assignment.status}
                      {typeof usage?.promptTokens === 'number'
                        ? ` · ${usage.promptTokens + Number(usage.completionTokens ?? 0)} tok`
                        : ''}
                    </div>
                  )}
                  {task.error !== null ? <div className="nwe-sub">{task.error}</div> : null}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <div className="nwe-grid cols-2">
        <div className="nwe-card">
          <div className="nwe-h2">DAG</div>
          <div className="nwe-flow">
            <ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.3 }}>
              <Background />
            </ReactFlow>
          </div>
        </div>
        <div className="nwe-card">
          <div className="nwe-h2">人工门 Inbox</div>
          {board?.gates.length === 0 ? (
            <div className="nwe-sub">没有等待中的门。</div>
          ) : (
            board?.gates.map((gate) => (
              <div className="nwe-row" key={`${gate.runId}:${gate.gate}`}>
                <span className="nwe-sev is-advisory">{gate.gate}</span>
                <span className="nwe-sub">第 {gate.chapter ?? '—'} 章</span>
                <button
                  className="nwe-btn"
                  onClick={() =>
                    void action(
                      {
                        action: 'human.approve',
                        gateId: gate.id,
                        decision: 'approve',
                        actor: 'author',
                        reason: 'workbench approve',
                      },
                      '已批准',
                    )
                  }
                >
                  批准
                </button>
                <button
                  className="nwe-btn is-danger"
                  onClick={() =>
                    void action(
                      {
                        action: 'human.approve',
                        gateId: gate.id,
                        decision: 'reject',
                        actor: 'author',
                        reason: 'workbench reject',
                      },
                      '已拒绝',
                    )
                  }
                >
                  拒绝
                </button>
              </div>
            ))
          )}
        </div>
      </div>
      <div className="nwe-card">
        <div className="nwe-h2">Agent Roster</div>
        <div className="nwe-sub">12 个角色 preset；重申：主会话没有角色私有写工具。</div>
        <div className="nwe-table-wrap">
          <table className="nwe-table">
            <thead>
              <tr>
                <th>角色</th>
                <th>Preset</th>
                <th>可写</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <tr key={role.id}>
                  <td>{role.label}</td>
                  <td className="nwe-mono">{role.preset}</td>
                  <td className="nwe-sub">{role.canWrite.join(', ') || '只读'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function Review({ findings, reports }: { findings: Finding[]; reports: ReviewPayload['reports'] }) {
  const chapter = useStudio((state) => state.chapter)
  const selected = useStudio((state) => state.selectedFindingId)
  const select = useStudio((state) => state.selectFinding)
  const setWorkspace = useStudio((state) => state.setWorkspace)
  const queryClient = useQueryClient()
  const t = useT()
  const [role, setRole] = useState('all')
  const [leftId, setLeftId] = useState('')
  const [rightId, setRightId] = useState('')
  const filtered = findings.filter((finding) => role === 'all' || finding.role === role)
  useEffect(() => {
    if (reports.length === 0) {
      setLeftId('')
      setRightId('')
      return
    }
    const ordered = [...reports].sort((left, right) => (left.version ?? 0) - (right.version ?? 0))
    const first = String(ordered[0]?.id ?? '')
    const last = String(ordered[ordered.length - 1]?.id ?? '')
    setLeftId((current) => (ordered.some((report) => report.id === current) ? current : first))
    setRightId((current) => (ordered.some((report) => report.id === current) ? current : last))
  }, [reports])
  const orderedReports = [...reports].sort((left, right) => (left.version ?? 0) - (right.version ?? 0))
  const resolve = async (finding: Finding, status: 'fixed' | 'waived'): Promise<void> => {
    let resolution: string | undefined
    if (status === 'fixed' && finding.severity === 'blocker') {
      const quoted = window.prompt('修复 blocker 必须引用当前正文里真正解决它的句子（至少 8 字）')
      if (quoted === null) return
      resolution = quoted.trim()
      if (Array.from(resolution).length < 8) {
        toast.error('证据至少 8 个字，且必须出现在当前正文里')
        return
      }
    }
    try {
      await postAction({ action: 'finding.resolve', id: finding.id, status, resolution })
      toast.success('已更新')
      await queryClient.invalidateQueries({ queryKey: ['reviews'] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const bulkResolve = async (): Promise<void> => {
    const ids = filtered
      .filter((finding) => finding.status === 'open' && finding.severity === 'advisory')
      .map((finding) => finding.id)
    if (ids.length === 0) {
      toast.info('没有可批量处理的 advisory')
      return
    }
    try {
      const response = await postAction<{ changed: number }>({
        action: 'finding.bulk',
        ids,
        status: 'fixed',
      })
      toast.success(`已批量标记 ${response.changed} 条`)
      await queryClient.invalidateQueries({ queryKey: ['reviews'] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const requestRevision = async (): Promise<void> => {
    try {
      const response = await postAction<{ runId?: string }>({ action: 'revision.request', chapter })
      toast.success(
        response.runId === undefined ? '已创建修订 Run' : `已创建修订 Run ${response.runId.slice(-6)}`,
      )
      await queryClient.invalidateQueries()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const left = reports.find((report) => report.id === leftId)
  const right = reports.find((report) => report.id === rightId)
  const dimensionRows = (left?.dimensions ?? []).map((dimension) => {
    const leftScore = dimension.max - dimension.deductions.reduce((sum, row) => sum + row.delta, 0)
    const match = (right?.dimensions ?? []).find((candidate) => candidate.id === dimension.id)
    const rightScore =
      match === undefined ? null : match.max - match.deductions.reduce((sum, row) => sum + row.delta, 0)
    return { id: dimension.id, leftScore, rightScore }
  })
  return (
    <div className="nwe-col" style={{ gap: 14 }}>
      <div className="nwe-heading">
        <div>
          <WorkspaceTitle id="review" />
          <div className="nwe-sub">第 {chapter} 章 · 三审 + 连续性 · 点击 finding 查看原文证据。</div>
        </div>
        <div className="nwe-row">
          <button className="nwe-btn" onClick={() => void bulkResolve()}>
            批量标记已修
          </button>
          <button className="nwe-btn is-primary" onClick={() => void requestRevision()}>
            {t('action.revise')}
          </button>
        </div>
      </div>
      <div className="nwe-card">
        <div className="nwe-h2">{t('card.roundCompare')}</div>
        {reports.length < 2 ? (
          <div className="nwe-sub">至少需要两个评审版本才能对比；当前 {reports.length} 个。</div>
        ) : (
          <>
            <div className="nwe-row nwe-wrap">
              <select
                className="nwe-input"
                aria-label="左侧评审版本"
                value={leftId}
                onChange={(event) => setLeftId(event.target.value)}
              >
                {orderedReports.map((report) => (
                  <option key={report.id} value={report.id}>
                    {report.role} · v{String(report.version ?? '')}
                  </option>
                ))}
              </select>
              <span className="nwe-sub">→</span>
              <select
                className="nwe-input"
                aria-label="右侧评审版本"
                value={rightId}
                onChange={(event) => setRightId(event.target.value)}
              >
                {orderedReports.map((report) => (
                  <option key={report.id} value={report.id}>
                    {report.role} · v{String(report.version ?? '')}
                  </option>
                ))}
              </select>
              <span className="nwe-pill">
                总分 {String(left?.total ?? '—')} → {String(right?.total ?? '—')}
              </span>
              <span className="nwe-pill">
                findings {left?.findings.length ?? 0} → {right?.findings.length ?? 0}
              </span>
            </div>
            <table className="nwe-table">
              <thead>
                <tr>
                  <th>维度</th>
                  <th>左</th>
                  <th>右</th>
                  <th>变化</th>
                </tr>
              </thead>
              <tbody>
                {dimensionRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.id}</td>
                    <td>{row.leftScore}</td>
                    <td>{row.rightScore ?? '—'}</td>
                    <td>
                      {row.rightScore === null
                        ? '—'
                        : row.rightScore - row.leftScore >= 0
                          ? `+${row.rightScore - row.leftScore}`
                          : String(row.rightScore - row.leftScore)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
      <Tabs.Root value={role} onValueChange={setRole}>
        <Tabs.List className="nwe-tabs">
          {['all', 'critic-story', 'critic-character', 'critic-prose', 'continuity'].map((id) => (
            <Tabs.Trigger key={id} value={id} className={`nwe-tab${role === id ? ' is-active' : ''}`}>
              {id === 'all' ? '全部' : id}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value={role}>
          {filtered.length === 0 ? (
            <div className="nwe-empty">没有 finding。</div>
          ) : (
            <div className="nwe-grid cols-2">
              {filtered.map((finding) => (
                <div
                  className={`nwe-finding${selected === finding.id ? ' is-selected' : ''}`}
                  key={finding.id}
                  onClick={() => select(finding.id)}
                >
                  <div className="nwe-row">
                    <span className={`nwe-sev is-${finding.severity}`}>{finding.severity}</span>
                    <span className="nwe-pill">{finding.role}</span>
                    <span className="nwe-sub">{finding.dimension}</span>
                    <span className="nwe-pill">{finding.status}</span>
                  </div>
                  <div style={{ marginTop: 8 }}>{finding.problem}</div>
                  <div className="nwe-evidence">{finding.evidence}</div>
                  <div className="nwe-sub">
                    {finding.location} · {finding.fix}
                  </div>
                  <div className="nwe-row" style={{ marginTop: 8 }}>
                    <button
                      className="nwe-btn"
                      onClick={(event) => {
                        event.stopPropagation()
                        select(finding.id)
                        setWorkspace('manuscript')
                      }}
                    >
                      跳转正文
                    </button>
                    <button
                      className="nwe-btn"
                      onClick={(event) => {
                        event.stopPropagation()
                        void resolve(finding, 'fixed')
                      }}
                    >
                      标记已修
                    </button>
                    {finding.severity === 'advisory' ? (
                      <button
                        className="nwe-btn is-ghost"
                        onClick={(event) => {
                          event.stopPropagation()
                          void resolve(finding, 'waived')
                        }}
                      >
                        Waive
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}

function Memory() {
  const search = useStudio((state) => state.inspector)
  const setSearch = useStudio((state) => state.setInspector)
  const setChapter = useStudio((state) => state.setChapter)
  const setWorkspace = useStudio((state) => state.setWorkspace)
  const queryClient = useQueryClient()
  const t = useT()
  const [submitted, setSubmitted] = useState('')
  const [selectedTask, setSelectedTask] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => {
      if (search.trim() !== '') setSubmitted(search.trim())
    }, 300)
    return () => clearTimeout(timer)
  }, [search])
  const board = useQuery({
    queryKey: ['board'],
    queryFn: () => api.getJson<Board>('/board'),
  })
  const contextTasks = (board.data?.tasks ?? []).filter(
    (task) => task.status === 'completed' || task.outputArtifactId !== null,
  )
  const [runId, taskId] = selectedTask === '' ? ['', ''] : selectedTask.split(':')
  const context = useQuery({
    queryKey: ['context', runId, taskId],
    queryFn: () =>
      api.getJson<{
        stage: string
        query: string
        budgetTokens: number
        usedTokens: number
        omitted: number
        items: Array<{
          id: string
          kind: string
          sourcePath: string
          sourceHash: string
          text: string
          score: number
          reason: string[]
          protected: boolean
          tokens: number
        }>
      }>('/context', { runId, taskId }),
    enabled: runId !== '' && taskId !== '',
  })
  const result = useQuery({
    queryKey: ['search', submitted],
    queryFn: () =>
      api.getJson<{
        hits: Array<{
          id: string
          kind: string
          chapter: number | null
          sourcePath: string
          text: string
          score: number
          reasons: string[]
        }>
      }>('/search', { q: submitted }),
    enabled: submitted !== '',
  })
  const reindex = async (): Promise<void> => {
    try {
      await postAction({ action: 'memory.reindex' })
      toast.success('索引已重建')
      await queryClient.invalidateQueries()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <div className="nwe-col" style={{ gap: 14 }}>
      <div className="nwe-heading">
        <div>
          <WorkspaceTitle id="memory" />
          <div className="nwe-sub">FTS5 + 实体图；每条结果带分数拆解和来源。</div>
        </div>
        <button className="nwe-btn" onClick={() => void reindex()}>
          <RefreshCw size={14} /> 重建索引
        </button>
      </div>
      <form
        className="nwe-row"
        onSubmit={(event) => {
          event.preventDefault()
          setSubmitted(search)
        }}
      >
        <input
          className="nwe-input"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索稿件、设定、评审…"
        />
        <button className="nwe-btn is-primary" type="submit">
          搜索
        </button>
      </form>
      {submitted === '' ? (
        <div className="nwe-empty">输入关键词开始检索。</div>
      ) : result.isLoading ? (
        <div className="nwe-skeleton" style={{ height: 120 }} />
      ) : result.data?.hits.length === 0 ? (
        <div className="nwe-empty">没有命中。</div>
      ) : (
        <div className="nwe-col">
          {result.data?.hits.map((hit) => (
            <div
              className="nwe-card"
              key={hit.id}
              role="button"
              tabIndex={0}
              onClick={() => {
                if (hit.chapter !== null) {
                  setChapter(hit.chapter)
                  setWorkspace('manuscript')
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && hit.chapter !== null) {
                  setChapter(hit.chapter)
                  setWorkspace('manuscript')
                }
              }}
            >
              <div className="nwe-row">
                <span className="nwe-pill">{hit.kind}</span>
                <span className="nwe-sub">第 {hit.chapter ?? '—'} 章</span>
                <span className="nwe-mono">{hit.sourcePath}</span>
                <span className="nwe-pill">score {hit.score.toFixed(2)}</span>
              </div>
              <div style={{ marginTop: 8 }}>{hit.text}</div>
              <div className="nwe-sub">{hit.reasons.join(' · ')}</div>
            </div>
          ))}
        </div>
      )}
      <div className="nwe-card">
        <div className="nwe-h2">{t('card.contextInspector')}</div>
        <div className="nwe-sub">
          选择任务，查看真正送入角色的 context 条目、score、reason、protected 与 token 占比。
        </div>
        <select
          className="nwe-input"
          style={{ marginTop: 8 }}
          aria-label="选择上下文任务"
          value={selectedTask}
          onChange={(event) => setSelectedTask(event.target.value)}
        >
          <option value="">选择已完成任务…</option>
          {contextTasks.map((task) => (
            <option key={`${task.runId}:${task.id}`} value={`${task.runId}:${task.id}`}>
              {task.role} · {task.kind} · {task.runId.slice(0, 8)}
            </option>
          ))}
        </select>
        {selectedTask === '' ? null : context.isLoading ? (
          <div className="nwe-skeleton" style={{ height: 80, marginTop: 8 }} />
        ) : context.isError ? (
          <div className="nwe-sub" style={{ marginTop: 8 }}>
            该任务没有持久化 context pack（旧任务或未运行）。
          </div>
        ) : context.data === undefined ? null : (
          <div style={{ marginTop: 8 }}>
            <div className="nwe-row nwe-wrap">
              <span className="nwe-pill">{context.data.stage}</span>
              <span className="nwe-pill">
                {context.data.usedTokens}/{context.data.budgetTokens} tokens
              </span>
              <span className="nwe-pill">省略 {context.data.omitted}</span>
              <span className="nwe-sub">query: {context.data.query || '—'}</span>
            </div>
            <div className="nwe-list" style={{ marginTop: 8 }}>
              {context.data.items.map((item) => (
                <div className="nwe-card" key={item.id}>
                  <div className="nwe-row nwe-wrap">
                    <span className="nwe-pill">{item.kind}</span>
                    {item.protected ? <span className="nwe-pill is-ok">protected</span> : null}
                    <span className="nwe-mono">{item.sourcePath}</span>
                    <span className="nwe-pill">score {item.score.toFixed(2)}</span>
                    <span className="nwe-pill">
                      {Math.round((item.tokens / Math.max(1, context.data.usedTokens)) * 100)}%
                    </span>
                  </div>
                  <div className="nwe-sub">{item.reason.join(' · ')}</div>
                  <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
                    {item.text.length > 400 ? `${item.text.slice(0, 400)}…` : item.text}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Analytics() {
  const analytics = useQuery({
    queryKey: ['analytics'],
    queryFn: () =>
      api.getJson<{
        chapters: Array<{ chapter: number; words: number; score: number | null; blockers: number }>
        cost: Array<{
          run: string
          kind: string
          status: string
          costUsd: number
          promptTokens: number
          completionTokens: number
        }>
        totals: { chapters: number; words: number; cost: number }
      }>('/analytics'),
  })
  return (
    <div className="nwe-col" style={{ gap: 14 }}>
      <div className="nwe-heading">
        <div>
          <WorkspaceTitle id="analytics" />
          <div className="nwe-sub">进度、质量、节奏与成本。</div>
        </div>
      </div>
      <div className="nwe-grid cols-3">
        <div className="nwe-card">
          <div className="nwe-card-title">章节</div>
          <div className="nwe-stat">{analytics.data?.totals.chapters ?? 0}</div>
        </div>
        <div className="nwe-card">
          <div className="nwe-card-title">总字数</div>
          <div className="nwe-stat">{fmt(analytics.data?.totals.words)}</div>
        </div>
        <div className="nwe-card">
          <div className="nwe-card-title">总成本</div>
          <div className="nwe-stat">${(analytics.data?.totals.cost ?? 0).toFixed(2)}</div>
        </div>
      </div>
      <div className="nwe-grid cols-2">
        <div className="nwe-card">
          <div className="nwe-h2">字数 / 评分</div>
          <div
            className="nwe-chart"
            role="img"
            aria-label={`字数与评分趋势：共 ${analytics.data?.chapters.length ?? 0} 章`}
          >
            <ResponsiveContainer>
              <LineChart data={analytics.data?.chapters ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--nwe-border)" />
                <XAxis dataKey="chapter" tick={{ fill: 'var(--nwe-muted)', fontSize: 11 }} />
                <YAxis yAxisId="left" tick={{ fill: 'var(--nwe-muted)', fontSize: 11 }} />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fill: 'var(--nwe-muted)', fontSize: 11 }}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--nwe-raised)',
                    border: '1px solid var(--nwe-border)',
                    color: 'var(--nwe-ink)',
                  }}
                />
                <Line yAxisId="left" type="monotone" dataKey="words" stroke="var(--nwe-blue)" dot={false} />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="score"
                  stroke="var(--nwe-accent)"
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="nwe-card">
          <div className="nwe-h2">Run 成本</div>
          <div
            className="nwe-chart"
            role="img"
            aria-label={`Run 成本柱状图：共 ${analytics.data?.cost.length ?? 0} 个 Run`}
          >
            <ResponsiveContainer>
              <BarChart data={analytics.data?.cost ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--nwe-border)" />
                <XAxis dataKey="kind" tick={{ fill: 'var(--nwe-muted)', fontSize: 11 }} />
                <YAxis tick={{ fill: 'var(--nwe-muted)', fontSize: 11 }} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--nwe-raised)',
                    border: '1px solid var(--nwe-border)',
                    color: 'var(--nwe-ink)',
                  }}
                />
                <Bar dataKey="costUsd" fill="var(--nwe-green)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  )
}

function Publish() {
  const queryClient = useQueryClient()
  const t = useT()
  const [result, setResult] = useState<string>('')
  const [tab, setTab] = useState<'preview' | 'history'>('preview')
  const [preview, setPreview] = useState<number | null>(null)
  const [blurb, setBlurb] = useState('')
  const [authorNote, setAuthorNote] = useState('')
  const [profileTags, setProfileTags] = useState('')
  const [titleRule, setTitleRule] = useState('')
  const [coverPath, setCoverPath] = useState('')
  const publish = useQuery({
    queryKey: ['publish'],
    queryFn: () =>
      api.getJson<{
        exports: Array<Record<string, unknown> & { id: string }>
        chapters: number[]
        gates: Array<{ id: string; gate: string; chapter: number | null }>
        profile: {
          title?: string
          author?: string
          platform?: string
          audience?: string
          export_profile?: {
            author_note: string
            blurb: string
            tags: string[]
            cover_path: string | null
            title_rule: string
          } | null
        }
        exportsDir: string
      }>('/publish'),
  })
  const manuscript = useQuery({
    queryKey: ['manuscript', preview],
    queryFn: () =>
      api.getJson<{ chapter: number; title: string; text: string }>('/manuscript', {
        chapter: preview ?? 1,
      }),
    enabled: preview !== null,
  })
  const doctor = useQuery({
    queryKey: ['doctor'],
    queryFn: () =>
      api.getJson<{ ok: boolean; integrity: string; artifacts: number; orphaned: string[] }>('/doctor'),
  })
  useEffect(() => {
    const profile = publish.data?.profile.export_profile
    if (profile === undefined || profile === null) {
      setBlurb('')
      setAuthorNote('')
      setProfileTags('')
      setTitleRule('')
      setCoverPath('')
      return
    }
    setBlurb(profile.blurb)
    setAuthorNote(profile.author_note)
    setProfileTags(profile.tags.join(', '))
    setTitleRule(profile.title_rule)
    setCoverPath(profile.cover_path ?? '')
  }, [publish.data?.profile.export_profile])
  const saveProfile = async (): Promise<void> => {
    try {
      await postAction({
        action: 'settings.save',
        export_profile: {
          author_note: authorNote,
          blurb,
          tags: profileTags
            .split(/[,，\s]+/u)
            .map((tag) => tag.trim())
            .filter(Boolean),
          cover_path: coverPath.trim() === '' ? null : coverPath.trim(),
          title_rule: titleRule,
        },
      })
      toast.success('发布 profile 已保存')
      await queryClient.invalidateQueries({ queryKey: ['publish'] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const run = async (kind: string): Promise<void> => {
    try {
      const response = await postAction<{
        result?: { path: string; bytes: number }
        gateId?: string
        next?: string
      }>({ action: 'export.run', kind })
      if (response.result !== undefined) {
        setResult(`${response.result.path} · ${response.result.bytes} bytes`)
        toast.success('导出完成')
      } else {
        setResult(`发布包待人工门 ${response.gateId ?? ''}：${response.next ?? ''}`)
        toast.success('已创建发布门')
      }
      await queryClient.invalidateQueries()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <div className="nwe-col" style={{ gap: 14 }}>
      <div className="nwe-heading">
        <div>
          <WorkspaceTitle id="publish" />
          <div className="nwe-sub">
            导出前强制 ExportGate：章节 approved/archived、canon 一致、无 blocker。
          </div>
        </div>
        <button className="nwe-btn is-primary" onClick={() => void run('publish')}>
          <Upload size={14} /> {t('action.publish')}
        </button>
      </div>
      <div className="nwe-card">
        <div className="nwe-row nwe-wrap">
          {['markdown', 'txt', 'epub', 'outline', 'worldbook', 'proposal'].map((kind) => (
            <button className="nwe-btn" key={kind} onClick={() => void run(kind)}>
              <Upload size={14} /> {kind}
            </button>
          ))}
        </div>
        {result !== '' ? (
          <div className="nwe-sub" style={{ marginTop: 10 }}>
            {result}
          </div>
        ) : null}
      </div>
      <Tabs.Root value={tab} onValueChange={(value) => setTab(value as 'preview' | 'history')}>
        <Tabs.List className="nwe-tabs">
          <Tabs.Trigger value="preview" className={`nwe-tab${tab === 'preview' ? ' is-active' : ''}`}>
            {t('card.epubPreview')}
          </Tabs.Trigger>
          <Tabs.Trigger value="history" className={`nwe-tab${tab === 'history' ? ' is-active' : ''}`}>
            {t('card.publishHistory')}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="preview">
          <div className="nwe-card" style={{ marginBottom: 14 }}>
            <div className="nwe-h2">平台元数据 / ExportProfile</div>
            <div className="nwe-grid cols-2">
              <label>
                简介
                <textarea
                  className="nwe-textarea"
                  value={blurb}
                  onChange={(event) => setBlurb(event.target.value)}
                />
              </label>
              <label>
                作者的话
                <textarea
                  className="nwe-textarea"
                  value={authorNote}
                  onChange={(event) => setAuthorNote(event.target.value)}
                />
              </label>
              <label>
                标签（逗号分隔）
                <input
                  className="nwe-input"
                  value={profileTags}
                  onChange={(event) => setProfileTags(event.target.value)}
                />
              </label>
              <label>
                章节标题规则
                <input
                  className="nwe-input"
                  value={titleRule}
                  onChange={(event) => setTitleRule(event.target.value)}
                  placeholder="例：第{n}章 标题"
                />
              </label>
              <label>
                封面路径（项目内）
                <input
                  className="nwe-input"
                  value={coverPath}
                  onChange={(event) => setCoverPath(event.target.value)}
                  placeholder="assets/cover.jpg"
                />
              </label>
            </div>
            <button className="nwe-btn" style={{ marginTop: 10 }} onClick={() => void saveProfile()}>
              保存发布 profile
            </button>
          </div>
          <div className="nwe-grid cols-2">
            <div className="nwe-card">
              <div className="nwe-h2">目录 / 元数据</div>
              <div className="nwe-sub">
                {String(publish.data?.profile.title ?? '')} · {String(publish.data?.profile.author ?? '')} ·{' '}
                {String(publish.data?.profile.platform ?? '')} ·{' '}
                {String(publish.data?.profile.audience ?? '')}
              </div>
              <div className="nwe-list" style={{ marginTop: 8 }}>
                {(publish.data?.chapters ?? []).map((chapter) => (
                  <button
                    className={`nwe-list-row${preview === chapter ? ' is-active' : ''}`}
                    key={chapter}
                    style={{ gridTemplateColumns: '48px 1fr', padding: '7px 8px' }}
                    onClick={() => setPreview(chapter)}
                  >
                    <span className="nwe-mono">CH{String(chapter).padStart(2, '0')}</span>
                    <span>第 {chapter} 章</span>
                  </button>
                ))}
                {(publish.data?.chapters.length ?? 0) === 0 ? (
                  <div className="nwe-sub">还没有已归档正文，不能预览或发布。</div>
                ) : null}
              </div>
              <div className="nwe-inspector-label">封面</div>
              <div className="nwe-sub">封面在发布 profile 中配置；EPUB 生成时写入 book.epub。</div>
            </div>
            <div className="nwe-card">
              <div className="nwe-h2">正文预览</div>
              {preview === null ? (
                <div className="nwe-sub">从左侧目录选择一章。</div>
              ) : (
                <>
                  <div className="nwe-row">
                    <span className="nwe-pill">{manuscript.data?.title ?? `第 ${preview} 章`}</span>
                    <span className="nwe-sub">字体/行距按阅读器默认</span>
                  </div>
                  <div className="nwe-preview" aria-label="EPUB 章节预览">
                    {manuscript.data?.text ?? '加载中…'}
                  </div>
                </>
              )}
            </div>
          </div>
        </Tabs.Content>
        <Tabs.Content value="history">
          <div className="nwe-card">
            <div className="nwe-h2">导出记录</div>
            <div className="nwe-sub">
              发布包写入 {publish.data?.exportsDir ?? 'exports'}；历史来自 Export artifact。
            </div>
            <div className="nwe-list" style={{ marginTop: 8 }}>
              {(publish.data?.exports ?? []).map((entry) => (
                <div className="nwe-card" key={entry.id}>
                  <div className="nwe-row nwe-wrap">
                    <span className="nwe-pill">{String(entry.format ?? '')}</span>
                    <span className="nwe-mono">{String(entry.path ?? '')}</span>
                    <span className="nwe-sub">
                      {Array.isArray(entry.chapters) ? entry.chapters.length : 0} 章
                    </span>
                  </div>
                  <div className="nwe-sub">hash {String(entry.content_hash ?? '')}</div>
                  {Array.isArray(entry.checks) ? (
                    <div className="nwe-sub">{entry.checks.map(String).join(' · ')}</div>
                  ) : null}
                </div>
              ))}
              {(publish.data?.exports.length ?? 0) === 0 ? (
                <div className="nwe-sub">还没有导出记录。</div>
              ) : null}
            </div>
            {(publish.data?.gates.length ?? 0) > 0 ? (
              <div className="nwe-sub" style={{ marginTop: 8 }}>
                待批发布门：{publish.data?.gates.map((gate) => gate.id).join(', ')}
              </div>
            ) : null}
          </div>
        </Tabs.Content>
      </Tabs.Root>
      <div className="nwe-card">
        <div className="nwe-h2">发布检查</div>
        <div className="nwe-row">
          <span className={`nwe-pill ${doctor.data?.ok ? 'is-ok' : 'is-bad'}`}>
            {doctor.data?.ok ? 'health ok' : '需要处理'}
          </span>
          <span className="nwe-sub">
            DB {doctor.data?.integrity ?? '—'} · artifacts {doctor.data?.artifacts ?? 0}
          </span>
        </div>
        {doctor.data?.orphaned.length !== 0 ? (
          <div className="nwe-sub">orphan: {doctor.data?.orphaned.join(', ')}</div>
        ) : null}
      </div>
    </div>
  )
}

function SettingsPanel({ roles }: { roles: Bootstrap['roles'] }) {
  const t = useT()
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () =>
      api.getJson<{
        project: Record<string, unknown>
        taxonomy: {
          majors: Array<{
            id: string
            label: string
            subs: Array<{ id: string; label: string; audience: string }>
          }>
          tags: Array<{ id: string; label: string; facet: string }>
        }
      }>('/settings'),
  })
  const [budgets, setBudgets] = useState('')
  const [models, setModels] = useState('')
  const [targets, setTargets] = useState('')
  const [quality, setQuality] = useState('')
  const [restoring, setRestoring] = useState('')
  const queryClient = useQueryClient()
  const backups = useQuery({
    queryKey: ['backups'],
    queryFn: () =>
      api.getJson<{ backups: Array<{ name: string; bytes: number; mtimeMs: number }> }>('/backups'),
  })
  const importReport = useQuery({
    queryKey: ['import-report'],
    queryFn: () => api.getJson<{ text: string | null }>('/import-report'),
  })
  const doctor = useQuery({
    queryKey: ['doctor'],
    queryFn: () =>
      api.getJson<{ ok: boolean; integrity: string; artifacts: number; orphaned: string[] }>('/doctor'),
  })
  const repair = async (): Promise<void> => {
    try {
      await postAction({ action: 'memory.reindex' })
      toast.success('索引已重建')
      await queryClient.invalidateQueries()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const backup = async (): Promise<void> => {
    try {
      await postAction({ action: 'backup.create' })
      toast.success('数据库备份已创建')
      await queryClient.invalidateQueries({ queryKey: ['backups'] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const restore = async (name: string): Promise<void> => {
    if (!window.confirm(`恢复备份 ${name}？当前 DB 编排记录会被覆盖，正文文件不变。`)) return
    setRestoring(name)
    try {
      await postAction({ action: 'backup.restore', name })
      toast.success('备份已恢复')
      await queryClient.invalidateQueries()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setRestoring('')
    }
  }
  useEffect(() => {
    if (settings.data === undefined) return
    setBudgets(JSON.stringify(settings.data.project.budgets ?? {}, null, 2))
    setModels(JSON.stringify(settings.data.project.models ?? {}, null, 2))
    setTargets(JSON.stringify(settings.data.project.targets ?? {}, null, 2))
    setQuality(JSON.stringify(settings.data.project.quality ?? {}, null, 2))
  }, [settings.data])
  const save = async (): Promise<void> => {
    try {
      await postAction({
        action: 'settings.save',
        budgets: JSON.parse(budgets),
        models: JSON.parse(models),
        targets: JSON.parse(targets),
        quality: JSON.parse(quality),
      })
      toast.success('设置已保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <div className="nwe-col" style={{ gap: 14 }}>
      <div className="nwe-heading">
        <div>
          <WorkspaceTitle id="settings" />
          <div className="nwe-sub">模型路由、预算、项目与 Doctor。</div>
        </div>
        <button className="nwe-btn is-primary" onClick={() => void save()}>
          保存
        </button>
      </div>
      <div className="nwe-grid cols-2">
        <label className="nwe-card">
          预算
          <textarea
            className="nwe-textarea nwe-mono"
            value={budgets}
            onChange={(event) => setBudgets(event.target.value)}
          />
        </label>
        <label className="nwe-card">
          模型路由
          <textarea
            className="nwe-textarea nwe-mono"
            value={models}
            onChange={(event) => setModels(event.target.value)}
          />
        </label>
        <label className="nwe-card">
          项目目标
          <textarea
            className="nwe-textarea nwe-mono"
            value={targets}
            onChange={(event) => setTargets(event.target.value)}
          />
        </label>
        <label className="nwe-card">
          质量阈值
          <textarea
            className="nwe-textarea nwe-mono"
            value={quality}
            onChange={(event) => setQuality(event.target.value)}
          />
        </label>
      </div>
      <div className="nwe-card">
        <div className="nwe-h2">类型体系</div>
        <div className="nwe-sub">
          {settings.data?.taxonomy.majors.length ?? 0} 大类 · {settings.data?.taxonomy.tags.length ?? 0} 标签
        </div>
        <div className="nwe-row nwe-wrap" style={{ marginTop: 8 }}>
          {settings.data?.taxonomy.majors.map((major) => (
            <span className="nwe-pill" key={major.id}>
              {major.label} · {major.subs.length}
            </span>
          ))}
        </div>
      </div>
      <div className="nwe-card">
        <div className="nwe-h2">{t('card.roles')}</div>
        <div className="nwe-sub">
          12 个 preset 由宿主的 agentPresets 解析；模型写在 project.yaml 的 models。
        </div>
        <table className="nwe-table">
          <thead>
            <tr>
              <th>角色</th>
              <th>Preset</th>
              <th>可写 artifact</th>
              <th>模型</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => {
              const modelsValue = (settings.data?.project.models ?? {}) as Record<
                string,
                { provider?: string; model?: string } | undefined
              >
              const route = modelsValue[role.id]
              return (
                <tr key={role.id}>
                  <td>{role.label}</td>
                  <td className="nwe-mono">{role.preset}</td>
                  <td className="nwe-sub">{role.canWrite.join(', ')}</td>
                  <td className="nwe-mono">
                    {route === undefined ? '继承宿主默认' : `${route.provider ?? ''}/${route.model ?? ''}`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="nwe-card">
        <div className="nwe-row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div className="nwe-h2">{t('card.backups')}</div>
            <div className="nwe-sub">VACUUM INTO `.studio/backups`；恢复只覆盖 SQLite 编排与索引。</div>
          </div>
          <button className="nwe-btn" onClick={() => void backup()}>
            {t('action.backup')}
          </button>
        </div>
        <div className="nwe-list" style={{ marginTop: 8 }}>
          {(backups.data?.backups ?? []).map((entry) => (
            <div className="nwe-row" key={entry.name}>
              <span className="nwe-mono">{entry.name}</span>
              <span className="nwe-sub">{Math.round(entry.bytes / 1024)} KB</span>
              <span className="nwe-sub">{new Date(entry.mtimeMs).toLocaleString('zh-CN')}</span>
              <button
                className="nwe-btn is-ghost"
                disabled={restoring !== ''}
                onClick={() => void restore(entry.name)}
              >
                {restoring === entry.name ? '恢复中…' : t('action.restore')}
              </button>
            </div>
          ))}
          {(backups.data?.backups.length ?? 0) === 0 ? <div className="nwe-sub">还没有备份。</div> : null}
        </div>
      </div>
      <div className="nwe-card">
        <div className="nwe-h2">旧项目导入报告</div>
        <div className="nwe-sub">`novel import` 会写 IMPORT_REPORT.md；本面板只读展示，不双读旧项目。</div>
        {importReport.data?.text === null || importReport.data?.text === undefined ? (
          <div className="nwe-sub" style={{ marginTop: 8 }}>
            当前项目没有导入报告。
          </div>
        ) : (
          <pre className="nwe-diff" style={{ marginTop: 8 }} aria-label="旧项目导入报告">
            {importReport.data.text}
          </pre>
        )}
      </div>
      <div className="nwe-card">
        <div className="nwe-h2">Doctor</div>
        <div className="nwe-row nwe-wrap">
          <span className={`nwe-pill ${doctor.data?.ok ? 'is-ok' : 'is-bad'}`}>
            {doctor.data?.ok ? 'integrity ok' : '需要处理'}
          </span>
          <span className="nwe-sub">
            DB {doctor.data?.integrity ?? '—'} · artifacts {doctor.data?.artifacts ?? 0} · orphan{' '}
            {doctor.data?.orphaned.length ?? 0}
          </span>
          <button className="nwe-btn" onClick={() => void repair()}>
            重建索引
          </button>
        </div>
      </div>
    </div>
  )
}

function Shell() {
  const workspace = useStudio((state) => state.workspace)
  const chapter = useStudio((state) => state.chapter)
  const root = useStudio((state) => state.root)
  const setRoot = useStudio((state) => state.setRoot)
  const paletteOpen = useStudio((state) => state.paletteOpen)
  const setPaletteOpen = useStudio((state) => state.setPaletteOpen)
  const search = useStudio((state) => state.inspector)
  const sseConnected = useStudio((state) => state.sseConnected)
  const setSse = useStudio((state) => state.setSse)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const queryClient = useQueryClient()
  const t = useT()
  const bootstrap = useQuery({
    queryKey: ['bootstrap', root],
    queryFn: () => api.getJson<Bootstrap>('/bootstrap', { root }),
  })
  const status = useQuery({
    queryKey: ['status', root, chapter],
    queryFn: () => api.getJson<Status>('/status', { root, chapter }),
    enabled: Boolean(bootstrap.data?.project),
  })
  const board = useQuery({
    queryKey: ['board', root],
    queryFn: () => api.getJson<Board>('/board', { root }),
    enabled: Boolean(bootstrap.data?.project),
  })
  const reviews = useQuery({
    queryKey: ['reviews', root, chapter],
    queryFn: () => api.getJson<ReviewPayload>('/reviews', { root, chapter }),
    enabled: Boolean(bootstrap.data?.project),
  })
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () =>
      api.getJson<{ projects: Array<{ root: string; title: string; projectId: string }> }>('/projects'),
  })
  useEffect(() => {
    if (bootstrap.data?.project !== null && bootstrap.data?.project !== undefined && root === '')
      setRoot(bootstrap.data.project.root)
  }, [bootstrap.data, root, setRoot])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(true)
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('nwe:save'))
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        const gate = board.data?.gates[0]
        const runId = status.data?.run?.id
        if (event.shiftKey) {
          if (gate === undefined) {
            toast.error('没有等待中的人工门')
            return
          }
          void postAction({ action: 'human.approve', gateId: gate.id, decision: 'approve', actor: 'author' })
            .then(() => {
              toast.success('已批准')
              return queryClient.invalidateQueries()
            })
            .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
          return
        }
        if (runId === undefined) {
          toast.error('没有可推进的 Run')
          return
        }
        void postAction({ action: 'run.tick', runId })
          .then(() => {
            toast.success('已推进')
            return queryClient.invalidateQueries()
          })
          .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
        return
      }
      if (typing) return
      if (useStudio.getState().paletteOpen) return
      if (event.key.toLowerCase() === 'j') {
        useStudio.getState().setChapter(Math.max(1, useStudio.getState().chapter - 1))
      } else if (event.key.toLowerCase() === 'k') {
        useStudio.getState().setChapter(useStudio.getState().chapter + 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [board.data?.gates, queryClient, setPaletteOpen, status.data?.run?.id])
  useEffect(() => {
    if (bootstrap.data?.project === null || bootstrap.data?.project === undefined) return
    const source = new EventSource(
      `/api/novel-write-engine/v8/events?root=${encodeURIComponent(bootstrap.data.project.root)}`,
    )
    source.onopen = () => setSse(true)
    source.onerror = () => setSse(false)
    source.onmessage = () => {
      setSse(true)
      void queryClient.invalidateQueries({
        predicate: (query) =>
          [
            'status',
            'board',
            'reviews',
            'chapters',
            'manuscript',
            'artifact',
            'versions',
            'comments',
            'backups',
            'analytics',
          ].includes(String(query.queryKey[0])),
      })
    }
    return () => source.close()
  }, [bootstrap.data?.project, queryClient, setSse])
  if (bootstrap.isLoading)
    return (
      <div className="nwe-root">
        <div className="nwe-center">
          <div className="nwe-skeleton" style={{ height: 200 }} />
        </div>
      </div>
    )
  if (bootstrap.isError)
    return (
      <div className="nwe-root">
        <div className="nwe-center">
          <ErrorState
            message={bootstrap.error instanceof Error ? bootstrap.error.message : '无法加载工作台'}
            onRetry={() => void bootstrap.refetch()}
          />
        </div>
      </div>
    )
  if (bootstrap.data?.project === null || bootstrap.data?.project === undefined)
    return <EmptyProject bootstrap={bootstrap.data!} />
  const data = bootstrap.data
  const content =
    workspace === 'overview' ? (
      <Overview status={status.data} board={board.data} />
    ) : workspace === 'manuscript' ? (
      <Manuscript status={status.data} evidence={reviews.data?.findings ?? []} />
    ) : workspace === 'outline' ? (
      <Outline />
    ) : workspace === 'bible' ? (
      <Bible />
    ) : workspace === 'studio' ? (
      <Studio board={board.data} roles={data.roles} />
    ) : workspace === 'review' ? (
      <Review findings={reviews.data?.findings ?? []} reports={reviews.data?.reports ?? []} />
    ) : workspace === 'memory' ? (
      <Memory />
    ) : workspace === 'analytics' ? (
      <Analytics />
    ) : workspace === 'publish' ? (
      <Publish />
    ) : (
      <SettingsPanel roles={data.roles} />
    )
  return (
    <div className={`nwe-root${inspectorOpen ? ' is-inspector-open' : ''}`}>
      <style>{STUDIO_CSS}</style>
      <Topbar
        bootstrap={data}
        status={status.data}
        onPalette={() => setPaletteOpen(true)}
        onToggleInspector={() => setInspectorOpen((open) => !open)}
        projects={projects.data?.projects ?? []}
        onSwitchProject={(nextRoot) => {
          setRoot(nextRoot)
          setInspectorOpen(false)
        }}
        search={search}
      />
      <div className="nwe-main">
        <LeftRail pending={board.data?.gates.length ?? 0} />
        <main className="nwe-center">{content}</main>
        <RightInspector status={status.data} findings={reviews.data?.findings ?? []} />
      </div>
      <Statusbar status={status.data} bootstrap={data} sseConnected={sseConnected} />
      <Command.Dialog open={paletteOpen} onOpenChange={setPaletteOpen} label="命令面板">
        <div className="nwe-dialog-content">
          <Command.Input placeholder="输入命令或搜索…" className="nwe-input" autoFocus />
          <Command.List style={{ marginTop: 10 }}>
            <Command.Empty className="nwe-sub">没有匹配的命令。</Command.Empty>
            <Command.Group heading="工作区">
              {WORKSPACES.map((id) => (
                <Command.Item
                  key={id}
                  className="nwe-cmd-item"
                  onSelect={() => {
                    useStudio.getState().setWorkspace(id)
                    setPaletteOpen(false)
                  }}
                >
                  <ChevronRight size={14} /> {t(`nav.${id}`)}
                </Command.Item>
              ))}
            </Command.Group>
            <Command.Group heading="动作">
              <Command.Item
                className="nwe-cmd-item"
                onSelect={() => {
                  useStudio.getState().setWorkspace('studio')
                  setPaletteOpen(false)
                }}
              >
                <Play size={14} /> {t('palette.studio')}
              </Command.Item>
              <Command.Item
                className="nwe-cmd-item"
                onSelect={() => {
                  useStudio.getState().setWorkspace('review')
                  setPaletteOpen(false)
                }}
              >
                <ClipboardCheck size={14} /> {t('palette.review')}
              </Command.Item>
              <Command.Item
                className="nwe-cmd-item"
                onSelect={() => {
                  useStudio.getState().setWorkspace('publish')
                  setPaletteOpen(false)
                }}
              >
                <Upload size={14} /> {t('palette.publish')}
              </Command.Item>
              <Command.Item
                className="nwe-cmd-item"
                onSelect={() => {
                  window.dispatchEvent(new CustomEvent('nwe:save'))
                  setPaletteOpen(false)
                }}
              >
                <Save size={14} /> 保存当前章
              </Command.Item>
              <Command.Item
                className="nwe-cmd-item"
                onSelect={() => {
                  const runId = status.data?.run?.id
                  if (runId === undefined) {
                    toast.error('没有可推进的 Run')
                    return
                  }
                  void postAction({ action: 'run.tick', runId })
                    .then(() => {
                      toast.success('已推进')
                      return queryClient.invalidateQueries()
                    })
                    .catch((error: unknown) =>
                      toast.error(error instanceof Error ? error.message : String(error)),
                    )
                  setPaletteOpen(false)
                }}
              >
                <RefreshCw size={14} /> 推进当前 Run
              </Command.Item>
              <Command.Item
                className="nwe-cmd-item"
                onSelect={() => {
                  const gate = board.data?.gates[0]
                  if (gate === undefined) {
                    toast.error('没有等待中的人工门')
                    return
                  }
                  void postAction({
                    action: 'human.approve',
                    gateId: gate.id,
                    decision: 'approve',
                    actor: 'author',
                  })
                    .then(() => {
                      toast.success('已批准')
                      return queryClient.invalidateQueries()
                    })
                    .catch((error: unknown) =>
                      toast.error(error instanceof Error ? error.message : String(error)),
                    )
                  setPaletteOpen(false)
                }}
              >
                <CheckCircle2 size={14} /> 批准第一个人工门
              </Command.Item>
            </Command.Group>
          </Command.List>
        </div>
      </Command.Dialog>
      <Toaster richColors position="bottom-right" />
    </div>
  )
}

export function StudioApp({
  t = studioTranslate,
  client = queryClient,
}: { t?: StudioTranslator; client?: QueryClient } = {}) {
  return (
    <LocaleContext.Provider value={t}>
      <QueryClientProvider client={client}>
        <Shell />
      </QueryClientProvider>
    </LocaleContext.Provider>
  )
}

export { X }
