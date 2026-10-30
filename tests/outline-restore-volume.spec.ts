import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import { FsStore } from '../src/store/fs.js'
import { BACKUP_MARKER } from '../src/store/backup.js'
import {
  archiveDelta,
  bootstrapToDraft,
  cleanText,
  harness,
  sampleReview,
  sampleSemantic,
  sampleSummary,
  writeDraft,
} from './helpers.js'

describe('outline restore volume guard', () => {
  it('refuses a backup that leaves an archived chapter outside every volume', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await engine.submitOutline({
        volumes: [
          {
            title: '第一卷',
            start_chapter: 1,
            end_chapter: 10,
            goal: '守住商铺',
            arc: '开端',
            climax: '第一次冲突',
            status: 'planned',
          },
        ],
        chapters: [
          {
            num: 1,
            volume: 1,
            title: '开端之雨',
            scene_type: '日常过渡章',
            goal: '收信',
            conflict: '拆不拆',
            hook: '日期',
            cast: [],
            target_words: [80, 400],
            notes: '',
          },
        ],
        root,
      })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({ chapter: 1, semantic: sampleSemantic(text), root })
      await engine.getBrief({ stage: 'P8', root })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })

      const outlineText = await readFile(join(root, 'outline/outline.yaml'), 'utf8')
      const broken = parse(outlineText) as Record<string, unknown>
      broken.volumes = []
      const txid = 'dddddddd-5555-4555-8555-555555555555'
      const store = new FsStore(root)
      await store.writeText(`backups/${txid}/${BACKUP_MARKER}`, '1')
      await store.writeText(
        `backups/${txid}/manifest.json`,
        JSON.stringify({
          schema_version: 1,
          txid,
          op: 'test',
          chapter: 1,
          revision: 1,
          at: '2026-01-01T00:00:00.000Z',
          files: ['outline/outline.yaml'],
        }),
      )
      await store.writeText(`backups/${txid}/outline/outline.yaml`, stringify(broken))
      await expect(
        engine.restoreBackup({ txid, paths: ['outline/outline.yaml'], root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })
})
