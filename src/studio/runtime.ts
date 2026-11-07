import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { openStudioDb, type StudioDb } from '../storage/db.js'
import { openGlobalRegistry, type GlobalRegistry } from '../storage/global.js'
import { findAssignmentByAgent, listRuns } from '../storage/repositories/runs.js'
import {
  DB_FILE,
  initProjectV2,
  loadProjectV2,
  type InitProjectInput,
  type LoadedProject,
} from '../kernel/project/layout.js'
import { ArtifactStore } from '../kernel/artifacts/store.js'
import { StudioDirector } from './director.js'
import { StudioScheduler } from './scheduler.js'
import { DshAgentBridge, type AgentBridge, type BridgeContext } from './agent-bridge.js'
import { StudioError, STUDIO_ERROR_CODES } from '../contracts/errors.js'

export interface StudioHandle {
  project: LoadedProject
  db: StudioDb
  artifacts: ArtifactStore
  director: StudioDirector
  scheduler: StudioScheduler
  close(): void
}

export interface StudioRuntimeOptions {
  projectRoot: string
  context?: BridgeContext
  bridge?: AgentBridge
  agents?: { get(id: string): Agent | undefined }
  directorSessionId?: string
  stateDir?: string
  globalRegistry?: GlobalRegistry
}

class UnavailableBridge implements AgentBridge {
  readonly name = 'unavailable'
  available(): boolean {
    return false
  }
  async start(): Promise<never> {
    throw new StudioError(
      STUDIO_ERROR_CODES.AGENT_PROVIDER_UNSUPPORTED,
      'no subagent provider is mounted',
      'novel-studio 0.3.0 requires DSH 0.2.2 spawn provider and the 12 role presets',
    )
  }
}

/** Owns project handles and the shared SQLite connection per project root. */
export class StudioRuntime {
  readonly projectRoot: string
  private readonly context: BridgeContext | undefined
  private readonly injectedBridge: AgentBridge | undefined
  private readonly agents: { get(id: string): Agent | undefined } | undefined
  private directorSessionId: string | undefined
  private readonly global: GlobalRegistry | undefined
  private readonly ownsGlobal: boolean
  private readonly handles = new Map<string, StudioHandle>()
  private readonly opening = new Map<string, Promise<StudioHandle>>()
  private closed = false

  constructor(options: StudioRuntimeOptions) {
    this.projectRoot = options.projectRoot
    this.context = options.context
    this.injectedBridge = options.bridge
    this.agents = options.agents
    this.directorSessionId = options.directorSessionId
    this.global =
      options.globalRegistry ??
      (options.stateDir === undefined ? undefined : openGlobalRegistry(options.stateDir))
    this.ownsGlobal = options.globalRegistry === undefined && options.stateDir !== undefined
  }

  /** The persistent session agent used by background/UI runs. */
  directorAgent(): Agent | undefined {
    if (this.directorSessionId === undefined || this.agents === undefined) return undefined
    return this.agents.get(this.directorSessionId)
  }

  /** Host hook: adopt the first non-role session as the workbench driver. */
  adoptDirectorSession(agentSessionId: string): void {
    if (this.directorSessionId === undefined || this.agents?.get(this.directorSessionId) === undefined) {
      this.directorSessionId = agentSessionId
    }
  }

  resolveRoot(root?: string): string {
    return resolve(root === undefined || root.trim() === '' ? this.projectRoot : root)
  }

  async open(root?: string): Promise<StudioHandle> {
    const requested = root === undefined || root.trim() === '' ? this.global?.recent()?.root : root
    const absolute = this.resolveRoot(requested)
    const cached = this.handles.get(absolute)
    if (cached !== undefined) return cached
    const inFlight = this.opening.get(absolute)
    if (inFlight !== undefined) return inFlight
    const opening = (async (): Promise<StudioHandle> => {
      if (this.closed) {
        throw new StudioError(STUDIO_ERROR_CODES.DB_INVALID, 'studio runtime is disposed')
      }
      const project = await loadProjectV2(absolute)
      if (this.closed) {
        throw new StudioError(STUDIO_ERROR_CODES.DB_INVALID, 'studio runtime is disposed')
      }
      this.global?.register({ root: absolute, projectId: project.config.id, title: project.config.title })
      const db = openStudioDb(resolve(absolute, DB_FILE))
      const artifacts = new ArtifactStore(project, db)
      const director = new StudioDirector(project, db, artifacts)
      const bridge =
        this.injectedBridge ??
        (this.context === undefined ? new UnavailableBridge() : new DshAgentBridge(this.context))
      const scheduler = new StudioScheduler({ project, db, artifacts, director, bridge })
      const handle: StudioHandle = {
        project,
        db,
        artifacts,
        director,
        scheduler,
        close: () => {
          db.close()
          this.handles.delete(absolute)
        },
      }
      const raced = this.handles.get(absolute)
      if (raced !== undefined) {
        // Another caller won a cross-tick race; keep one connection per root.
        db.close()
        return raced
      }
      this.handles.set(absolute, handle)
      return handle
    })()
    this.opening.set(absolute, opening)
    try {
      return await opening
    } finally {
      this.opening.delete(absolute)
    }
  }

  async init(input: Omit<InitProjectInput, 'root'> & { root?: string }): Promise<StudioHandle> {
    const root = this.resolveRoot(input.root)
    const initialized = await initProjectV2({ ...input, root })
    this.global?.register({ root, projectId: initialized.config.id, title: initialized.config.title })
    return this.open(root)
  }

  projects(): Array<{ root: string; title: string; projectId: string }> {
    return (
      this.global?.list().map((row) => ({ root: row.root, title: row.title, projectId: row.projectId })) ?? []
    )
  }

  /** Resolve the project handle owning one role agent session. */
  async openForAgent(agentSessionId: string): Promise<StudioHandle | undefined> {
    for (const handle of this.handles.values()) {
      if (findAssignmentByAgent(handle.db.orm, agentSessionId) !== undefined) return handle
    }
    for (const project of this.projects()) {
      try {
        const handle = await this.open(project.root)
        if (findAssignmentByAgent(handle.db.orm, agentSessionId) !== undefined) return handle
      } catch {
        // One corrupt project must not hide a live assignment in another project.
      }
    }
    return undefined
  }

  bind(sessionId: string, root: string): void {
    this.global?.bind(sessionId, root)
  }

  binding(sessionId: string): string | undefined {
    return this.global?.binding(sessionId)
  }

  /**
   * Restore one DB backup after closing the live handle. Files remain the
   * truth, so only orchestration/index/audit rows are rolled back.
   */
  async restoreBackup(
    root: string,
    name: string,
  ): Promise<{ restored: string; bytes: number; safetyBackup: string }> {
    if (!/^[A-Za-z0-9._-]+\.db$/u.test(name)) {
      throw new StudioError(STUDIO_ERROR_CODES.DB_INVALID, `invalid backup name ${name}`)
    }
    const absolute = this.resolveRoot(root)
    const handle = await this.open(absolute)
    const store = handle.project.store
    const activeRun = listRuns(handle.db.orm, handle.project.config.id, 100).find((run) =>
      ['queued', 'running', 'awaiting_human', 'paused'].includes(run.status),
    )
    if (activeRun !== undefined) {
      throw new StudioError(
        STUDIO_ERROR_CODES.DB_INVALID,
        `cannot restore a backup while run ${activeRun.id} is ${activeRun.status}`,
        'finish, pause and cancel the run, or complete the human gate first',
        { runId: activeRun.id },
      )
    }
    const bytes = await store.readBytes(`.studio/backups/${name}`)
    if (bytes === null) throw new StudioError(STUDIO_ERROR_CODES.DB_INVALID, `backup ${name} is missing`)
    await store.ensureDir('.studio/backups')
    const safety = `pre-restore-${new Date().toISOString().replace(/[:.]/gu, '-')}-${Math.random().toString(36).slice(2, 8)}.db`
    handle.db.backupTo(store.path(`.studio/backups/${safety}`))
    handle.db.checkpoint()
    handle.close()
    await store.writeBytes('.studio/studio.db', bytes)
    await store.remove('.studio/studio.db-wal')
    await store.remove('.studio/studio.db-shm')
    await this.open(absolute)
    return { restored: name, bytes: bytes.byteLength, safetyBackup: safety }
  }

  /** Send a host/model message to a live role child by durable session id. */
  async sendRoleMessage(sender: Agent, targetId: string, text: string, signal: AbortSignal): Promise<void> {
    const service = this.context?.subagents
    if (service?.sendMessage === undefined) {
      throw new StudioError(
        STUDIO_ERROR_CODES.AGENT_PROVIDER_UNSUPPORTED,
        'the mounted subagent provider does not accept continuation messages',
        'use a continuable spawn provider, or interrupt/cancel the run instead',
      )
    }
    await service.sendMessage(sender, targetId, [{ type: 'text', text }], { signal })
  }

  close(): void {
    this.closed = true
    for (const handle of this.handles.values()) handle.db.close()
    this.handles.clear()
    if (this.ownsGlobal) this.global?.close()
  }
}
