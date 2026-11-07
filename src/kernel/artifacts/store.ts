import { randomUUID } from 'node:crypto'
import { diffLines, createTwoFilesPatch } from 'diff'
import { stableJson } from '../../domain/stable.js'
import { sha256Hex } from '../../domain/hash.js'
import {
  ARTIFACT_SCHEMAS,
  ArtifactKindSchema,
  type ArtifactKind,
  type ArtifactRecord,
  type ArtifactStatus,
  type RoleId,
} from '../../contracts/artifacts.js'
import { StudioError, STUDIO_ERROR_CODES } from '../../contracts/errors.js'
import type { StudioDb } from '../../storage/db.js'
import {
  findArtifactByTask,
  getArtifact,
  insertArtifact,
  latestArtifact,
  listArtifacts,
  setArtifactStatus,
  supersedeOlder,
  type ArtifactRow,
} from '../../storage/repositories/artifacts.js'
import { appendEvent } from '../../storage/repositories/runs.js'
import type { LoadedProject } from '../project/layout.js'
import { ARTIFACT_DIR } from '../project/layout.js'

export interface ProvenanceInput {
  runId: string
  taskId: string
  role: RoleId
  preset: string
  agentSessionId?: string
  model?: string
  promptHash?: string
}

export interface SubmitArtifactInput<T = unknown> {
  kind: ArtifactKind
  chapter: number | null
  content: T
  provenance: ProvenanceInput
  status?: ArtifactStatus
  baseArtifactId?: string | null
}

export interface StoredArtifact extends ArtifactRecord {
  taskId: string | null
}

const artifactPath = (kind: string, hash: string): string => {
  const hex = hash.startsWith('sha256:') ? hash.slice(7) : hash
  return `${ARTIFACT_DIR}/${kind}/${hex.slice(0, 2)}/${hex}.json`
}

/** Audit artifacts are append-only; only creative state can be restored. */
const RESTORABLE_KINDS = new Set<ArtifactKind>([
  'Draft',
  'ChapterPlan',
  'BiblePlan',
  'OutlinePlan',
  'VolumePlan',
  'WorldbookPatch',
  'MarketBrief',
])

/** Content-addressed artifact store; DB is the index, files are the bytes. */
export class ArtifactStore {
  readonly project: LoadedProject
  readonly db: StudioDb

  constructor(project: LoadedProject, db: StudioDb) {
    this.project = project
    this.db = db
  }

  contentHash(kind: ArtifactKind, content: unknown): string {
    return sha256Hex(stableJson({ kind, content }))
  }

  private hashOf(kind: ArtifactKind, content: unknown): string {
    return this.contentHash(kind, content)
  }

  async submit<T>(input: SubmitArtifactInput<T>): Promise<StoredArtifact> {
    const kind = ArtifactKindSchema.parse(input.kind)
    const existing = findArtifactByTask(this.db.orm, input.provenance.taskId)
    if (existing !== undefined) {
      if (existing.kind !== kind || existing.chapter !== input.chapter) {
        throw new StudioError(
          STUDIO_ERROR_CODES.ARTIFACT_CONFLICT,
          `task ${input.provenance.taskId} already owns ${existing.kind} for chapter ${existing.chapter ?? '—'}`,
          'one task produces exactly one artifact kind and chapter',
          { existingId: existing.id, existingKind: existing.kind, requestedKind: kind },
        )
      }
      // Idempotent retry must return the bytes, not an empty placeholder. A
      // retry that produced different bytes is not idempotent: silently
      // returning the old artifact would hide a second, unreviewed output.
      const parsedRetry = ARTIFACT_SCHEMAS[kind].safeParse(input.content)
      if (!parsedRetry.success || this.hashOf(kind, parsedRetry.data) !== existing.contentHash) {
        throw new StudioError(
          STUDIO_ERROR_CODES.ARTIFACT_CONFLICT,
          `task ${input.provenance.taskId} already produced a different ${kind}`,
          'one task owns one immutable artifact; create a new task or round instead of overwriting',
          { existingId: existing.id, existingHash: existing.contentHash },
        )
      }
      return (await this.read(existing.id))!
    }
    const schema = ARTIFACT_SCHEMAS[kind]
    const parsed = schema.safeParse(input.content)
    if (!parsed.success) {
      throw new StudioError(
        STUDIO_ERROR_CODES.ARTIFACT_INVALID,
        `${kind} does not match its schema`,
        'fix the structured output; one kind has exactly one schema',
        { issues: parsed.error.issues },
      )
    }
    const hash = this.hashOf(kind, parsed.data)
    const path = artifactPath(kind, hash)
    const body = `${stableJson({ kind, content: parsed.data })}\n`
    await this.project.store.writeText(path, body)
    const row = insertArtifact(this.db.orm, {
      projectId: this.project.config.id,
      kind,
      chapter: input.chapter,
      status: input.status ?? 'draft',
      path,
      contentHash: hash,
      schemaVersion: 2,
      baseArtifactId: input.baseArtifactId ?? null,
      provenance: {
        runId: input.provenance.runId,
        taskId: input.provenance.taskId,
        role: input.provenance.role,
        preset: input.provenance.preset,
        agentSessionId: input.provenance.agentSessionId ?? '',
        model: input.provenance.model ?? '',
        promptHash: input.provenance.promptHash ?? '',
        createdAt: new Date().toISOString(),
      },
    })
    appendEvent(this.db.orm, {
      projectId: this.project.config.id,
      runId: input.provenance.runId,
      taskId: input.provenance.taskId,
      type: 'artifact.submit',
      payload: { artifactId: row.id, kind, chapter: input.chapter, version: row.version, hash },
    })
    return (await this.read(row.id))!
  }

  async read(id: string): Promise<StoredArtifact | null> {
    const row = getArtifact(this.db.orm, id)
    if (row === undefined) return null
    const text = await this.project.store.readText(row.path)
    if (text === null) {
      throw new StudioError(
        STUDIO_ERROR_CODES.ARTIFACT_NOT_FOUND,
        `artifact ${id} is indexed but its blob is missing`,
        'restore .studio/artifacts from backup or re-run the producing task',
        { id, path: row.path },
      )
    }
    let parsed: { kind: ArtifactKind; content: unknown }
    try {
      parsed = JSON.parse(text) as { kind: ArtifactKind; content: unknown }
    } catch (error) {
      throw new StudioError(
        STUDIO_ERROR_CODES.ARTIFACT_INVALID,
        `artifact blob ${row.path} is not valid JSON`,
        undefined,
        { id },
        { cause: error },
      )
    }
    const expected = this.hashOf(parsed.kind, parsed.content)
    if (expected !== row.contentHash) {
      throw new StudioError(
        STUDIO_ERROR_CODES.ARTIFACT_HASH_MISMATCH,
        `artifact ${id} hash mismatch: index ${row.contentHash}, content ${expected}`,
        'do not archive a mutated artifact; restore the original blob or create a new version',
        { id, expected, actual: row.contentHash },
      )
    }
    return this.toStored(row, parsed.content)
  }

  async latest(kind: ArtifactKind, chapter: number | null): Promise<StoredArtifact | null> {
    const row = latestArtifact(this.db.orm, this.project.config.id, kind, chapter)
    return row === undefined ? null : this.read(row.id)
  }

  list(filter: { kind?: ArtifactKind; chapter?: number | null; limit?: number } = {}): ArtifactRow[] {
    return listArtifacts(this.db.orm, this.project.config.id, filter)
  }

  async approve(id: string): Promise<StoredArtifact> {
    const artifact = await this.read(id)
    if (artifact === null) throw new StudioError(STUDIO_ERROR_CODES.ARTIFACT_NOT_FOUND, `no artifact ${id}`)
    setArtifactStatus(this.db.orm, id, 'approved')
    supersedeOlder(this.db.orm, id)
    appendEvent(this.db.orm, {
      projectId: this.project.config.id,
      runId: artifact.provenance.runId,
      taskId: artifact.provenance.taskId,
      type: 'artifact.approve',
      payload: { artifactId: id, kind: artifact.kind, chapter: artifact.chapter },
    })
    return (await this.read(id))!
  }

  async saveHumanEdit(input: {
    kind: ArtifactKind
    chapter: number | null
    content: unknown
    baseHash: string | null
    actor: string
    runId?: string
  }): Promise<StoredArtifact> {
    const current = await this.latest(input.kind, input.chapter)
    if (current !== null && input.baseHash === null) {
      throw new StudioError(
        STUDIO_ERROR_CODES.ARTIFACT_CONFLICT,
        'human edit must include the base hash of the current version',
        'reload the artifact and pass its content hash; 0.3.0 never overwrites blindly',
        { current: current.contentHash },
      )
    }
    if (input.baseHash !== null && current === null) {
      throw new StudioError(
        STUDIO_ERROR_CODES.ARTIFACT_CONFLICT,
        'human edit declares a base version but no current artifact exists',
        'reload the editor; the base hash must refer to the current version',
        { received: input.baseHash },
      )
    }
    if (input.baseHash !== null && current !== null && current.contentHash !== input.baseHash) {
      throw new StudioError(
        STUDIO_ERROR_CODES.ARTIFACT_CONFLICT,
        `human edit is based on ${input.baseHash}, current version is ${current.contentHash}`,
        'reload the artifact and reapply the edit; 0.3.0 never silently overwrites',
        { expected: current.contentHash, received: input.baseHash },
      )
    }
    return this.submit({
      kind: input.kind,
      chapter: input.chapter,
      content: input.content,
      provenance: {
        runId: input.runId ?? 'human',
        taskId: `human:${randomUUID()}`,
        role: 'showrunner',
        preset: 'human-edit',
        model: 'human',
        agentSessionId: input.actor,
      },
      status: 'draft',
      baseArtifactId: current?.id ?? null,
    })
  }

  diff(leftId: string, rightId: string): string {
    const left = getArtifact(this.db.orm, leftId)
    const right = getArtifact(this.db.orm, rightId)
    if (left === undefined || right === undefined) {
      throw new StudioError(STUDIO_ERROR_CODES.ARTIFACT_NOT_FOUND, 'both artifacts must exist to diff')
    }
    return `${left.contentHash} -> ${right.contentHash}\n${left.path} -> ${right.path}`
  }

  async restore(id: string, actor: string, reason: string): Promise<StoredArtifact> {
    const source = await this.read(id)
    if (source === null) throw new StudioError(STUDIO_ERROR_CODES.ARTIFACT_NOT_FOUND, `no artifact ${id}`)
    // Restoring a Decision or Export would replay an audit record and could
    // forge an approval; those kinds are append-only.
    if (!RESTORABLE_KINDS.has(source.kind)) {
      throw new StudioError(
        STUDIO_ERROR_CODES.ARTIFACT_RESTORE_FORBIDDEN,
        `${source.kind} is append-only and cannot be restored`,
        'restore a Draft/plan/worldbook artifact instead; decisions and exports are audit records',
        { id, kind: source.kind },
      )
    }
    return this.submit({
      kind: source.kind,
      chapter: source.chapter,
      content: source.content,
      provenance: {
        runId: source.provenance.runId,
        taskId: `restore:${id}:${randomUUID()}`,
        role: source.provenance.role,
        preset: 'artifact-restore',
        agentSessionId: actor,
        model: 'human',
        promptHash: reason === '' ? 'restore' : `restore:${reason}`,
      },
      status: 'draft',
      baseArtifactId: source.id,
    })
  }

  async diffContent(leftId: string, rightId: string): Promise<string> {
    const left = await this.read(leftId)
    const right = await this.read(rightId)
    if (left === null || right === null)
      throw new StudioError(STUDIO_ERROR_CODES.ARTIFACT_NOT_FOUND, 'artifact missing')
    const leftText =
      'content' in left &&
      typeof left.content === 'object' &&
      left.content !== null &&
      'content' in left.content
        ? String((left.content as { content: unknown }).content)
        : stableJson(left.content)
    const rightText =
      'content' in right &&
      typeof right.content === 'object' &&
      right.content !== null &&
      'content' in right.content
        ? String((right.content as { content: unknown }).content)
        : stableJson(right.content)
    const changes = diffLines(leftText, rightText)
    return (
      createTwoFilesPatch(left.path, right.path, leftText, rightText, '', '') +
      (changes.length === 0 ? '\n(no textual change)' : '')
    )
  }

  private toStored(row: ArtifactRow, content?: unknown): StoredArtifact {
    const provenance = JSON.parse(row.provenanceJson) as ArtifactRecord['provenance']
    return {
      id: row.id,
      projectId: row.projectId,
      kind: row.kind as ArtifactKind,
      chapter: row.chapter,
      version: row.version,
      status: row.status as ArtifactStatus,
      path: row.path,
      contentHash: row.contentHash,
      schemaVersion: row.schemaVersion,
      baseArtifactId: row.baseArtifactId,
      provenance,
      content: (content ?? {}) as ArtifactRecord['content'],
      taskId: row.taskId,
    }
  }
}
