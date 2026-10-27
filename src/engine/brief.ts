import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { bundledDir, readTextAt, readTextIfExists } from '../assets.js'
import { ERROR_CODES, EngineFaultError, type BriefStage } from '../types.js'

/** One rendered task book. */
export interface BriefDocument {
  stage: BriefStage
  title: string
  content: string
  /** sha256 of the source file, so a task book change is visible to callers. */
  contentHash: string
}

const TITLES: Record<BriefStage, string> = {
  P1: 'P1 世界观约束',
  P2: 'P2 章节预检',
  P3: 'P3 初稿',
  P4: 'P4 评审',
  P5: 'P5 修订',
  P6: 'P6 一致性校验',
  P8: 'P8 终审',
}

/**
 * Task books live on disk (`briefs/*.md`), never in code: changing writing
 * guidance must not require a release.
 */
export class BriefLibrary {
  private readonly overrideDirectory: string | null
  private readonly bundledDirectory: string

  constructor(directory?: string) {
    this.overrideDirectory = directory === undefined || directory === '' ? null : directory
    this.bundledDirectory = bundledDir('briefs')
  }

  /** Absolute path of the override when configured, otherwise the bundled one. */
  pathFor(stage: BriefStage): string {
    return this.overrideDirectory === null
      ? join(this.bundledDirectory, `${stage}.md`)
      : join(this.overrideDirectory, `${stage}.md`)
  }

  load(stage: BriefStage): BriefDocument {
    const override = this.overrideDirectory === null ? null : this.pathFor(stage)
    const fromOverride = override === null ? null : readTextIfExists(override)
    const path = join(this.bundledDirectory, `${stage}.md`)
    let content: string
    try {
      content = fromOverride ?? readTextAt(path)
    } catch (error) {
      throw new EngineFaultError(
        ERROR_CODES.CONFIG_INVALID,
        `brief ${stage} is missing at ${override ?? path}`,
        'reinstall the plugin; briefs ship with the package',
        { cause: error },
      )
    }
    return { stage, title: TITLES[stage], content, contentHash: hash(content) }
  }

  /** Replace `{{name}}` placeholders; unknown placeholders are left visible. */
  render(stage: BriefStage, variables: Record<string, string | number>): BriefDocument {
    const brief = this.load(stage)
    const content = brief.content.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : match,
    )
    return { ...brief, content }
  }
}

const hash = (text: string): string => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
