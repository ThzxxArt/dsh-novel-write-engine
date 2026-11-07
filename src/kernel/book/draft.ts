import { DraftSchema, type ChapterPlan, type Draft } from '../../contracts/artifacts.js'
import { StudioError, STUDIO_ERROR_CODES } from '../../contracts/errors.js'
import { countWordMetrics } from '../../domain/wordcount.js'

/**
 * Build the working draft produced by a human edit. The version pointers are
 * always rewritten to the artifact the editor actually saw; otherwise a later
 * revise/review would validate against a stale chain.
 */
export function buildHumanDraft(input: {
  existing: Draft | null
  chapter: number
  title: string
  content: string
  plan?: ChapterPlan
  baseArtifactId: string | null
  baseHash: string | null
}): Draft {
  if (input.content.trim() === '') {
    throw new StudioError(
      STUDIO_ERROR_CODES.ARTIFACT_INVALID,
      'draft content must not be empty',
      'write at least one sentence before saving',
    )
  }
  const metrics = countWordMetrics(input.content)
  return DraftSchema.parse({
    ...(input.existing ?? {
      schema_version: 2,
      kind: 'Draft',
      chapter: input.chapter,
      title: input.plan?.title ?? `第${input.chapter}章 未命名章节`,
      scene_type: input.plan?.scene_type ?? '日常过渡章',
      narrator: input.plan?.pov ?? '第三人称',
      content: '',
      summary: {
        events: ['手工编辑'],
        characters_appeared: input.plan?.cast ?? [],
        foreshadows: { planted: [], advanced: [], resolved: [] },
        new_elements: { locations: [], abilities: [], artifacts: [] },
        resource_changes: [],
        opening: input.content.slice(0, 20) || '手工编辑章节内容',
        continuity: { opens_from: '', ends_with: '' },
        hook_strength: 3,
        pleasure_points: [],
        plot_advancement: 'mid',
      },
      self_check: {
        word_count: 1,
        cjk_chars: 1,
        scene_contract: {
          goal: input.plan?.goal ?? '待定',
          conflict: input.plan?.conflict ?? '待定',
          turn: input.plan?.turn ?? '待定',
          outcome: input.plan?.outcome ?? '待定',
        },
      },
      citations: [],
      open_questions: [],
      base_artifact_id: null,
      expected_hash: null,
    }),
    title: input.title || input.existing?.title || input.plan?.title || `第${input.chapter}章 未命名章节`,
    content: input.content,
    self_check: {
      word_count: metrics.total_word_count,
      cjk_chars: metrics.cjk_chars,
      scene_contract: input.existing?.self_check.scene_contract ?? {
        goal: input.plan?.goal ?? '待定',
        conflict: input.plan?.conflict ?? '待定',
        turn: input.plan?.turn ?? '待定',
        outcome: input.plan?.outcome ?? '待定',
      },
    },
    base_artifact_id: input.baseArtifactId,
    expected_hash: input.baseHash,
  })
}
