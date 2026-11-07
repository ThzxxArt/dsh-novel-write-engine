import { describe, expect, it } from 'vitest'
import {
  assertRunTransition,
  assertTaskTransition,
  AssignmentStatusSchema,
  canTransitionRun,
  canTransitionTask,
  chapterStageOf,
  HumanGateSchema,
  RunKindSchema,
  RunStatusSchema,
  TaskStatusSchema,
} from '../src/contracts/stages.js'
import { ROLES, RoleDefinitionSchema, roleOfPreset, CHAPTER_ROLES } from '../src/contracts/roles.js'
import { STUDIO_ERROR_CODES, StudioError, StudioInputError } from '../src/contracts/errors.js'

describe('studio contracts', () => {
  it('accepts legal run/task transitions and rejects illegal ones', () => {
    expect(canTransitionRun('queued', 'running')).toBe(true)
    expect(canTransitionRun('completed', 'running')).toBe(false)
    expect(canTransitionTask('ready', 'leased')).toBe(true)
    expect(canTransitionTask('completed', 'running')).toBe(false)
    expect(() => assertRunTransition('queued', 'running')).not.toThrow()
    expect(() => assertRunTransition('queued', 'completed')).toThrow(/illegal run transition/)
    expect(() => assertTaskTransition('leased', 'running')).not.toThrow()
    expect(() => assertTaskTransition('leased', 'completed')).toThrow(/illegal task transition/)
    expect(RunKindSchema.parse('chapter')).toBe('chapter')
    expect(RunStatusSchema.parse('running')).toBe('running')
    expect(TaskStatusSchema.parse('leased')).toBe('leased')
    expect(AssignmentStatusSchema.parse('completed')).toBe('completed')
    expect(HumanGateSchema.parse('chapter')).toBe('chapter')
  })

  it('projects chapter stages from completed task kinds', () => {
    expect(chapterStageOf([])).toBe('planned')
    expect(chapterStageOf(['plan'])).toBe('planned')
    expect(chapterStageOf(['plan', 'draft'])).toBe('drafted')
    expect(chapterStageOf(['draft', 'review.merge'])).toBe('reviewed')
    expect(chapterStageOf(['revise'])).toBe('revised')
    expect(chapterStageOf(['continuity.final'])).toBe('continuity')
    expect(chapterStageOf(['polish'])).toBe('polished')
    expect(chapterStageOf(['approve'])).toBe('approved')
    expect(chapterStageOf(['archive'])).toBe('archived')
  })

  it('defines 12 roles and 11 pipeline roles', () => {
    expect(Object.keys(ROLES)).toHaveLength(12)
    expect(CHAPTER_ROLES).toHaveLength(11)
    expect(CHAPTER_ROLES).not.toContain('radar')
    expect(roleOfPreset('novel-role-drafter')?.id).toBe('drafter')
    expect(roleOfPreset(undefined)).toBeUndefined()
    for (const role of Object.values(ROLES)) {
      expect(RoleDefinitionSchema.parse(role)).toMatchObject({ id: role.id })
    }
  })

  it('carries stable error codes and classes', () => {
    const error = new StudioError(STUDIO_ERROR_CODES.ARTIFACT_INVALID, 'bad', 'fix', { id: 'a' })
    expect(error.code).toBe('STUDIO_ARTIFACT_INVALID')
    expect(error.hint).toBe('fix')
    expect(error.details).toEqual({ id: 'a' })
    expect(new StudioInputError('X', 'x')).toBeInstanceOf(StudioError)
  })
})
