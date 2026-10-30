import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootstrapToDraft, harness, writeDraft } from './helpers.js'

describe('pipeline recovery', () => {
  it('reports a damaged pipeline and restores a valid backup transactionally', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await writeDraft({ root, engine })
      const state = (await engine.queryState({ kind: 'backups', root })) as unknown as {
        data: {
          backups: Array<{ name: string; files: string[] }>
        }
      }
      const backup = state.data.backups.find((entry) => entry.files.includes('state/pipeline.yaml'))
      expect(backup).toBeDefined()

      await writeFile(join(root, 'state/pipeline.yaml'), 'schema_version: [broken\n', 'utf8')
      const broken = await engine.getStatus({ root })
      expect(broken.data.state_errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'PIPELINE_UNREADABLE' })]),
      )
      const doctor = await engine.doctor({ root })
      expect(doctor.data.checks).toContainEqual(
        expect.objectContaining({
          id: 'state:state/pipeline.yaml',
          hint: expect.stringContaining('novel_restore'),
        }),
      )

      const restored = await engine.restoreBackup({
        txid: backup!.name,
        paths: ['state/pipeline.yaml'],
        root,
      })
      expect(restored.data.restored).toEqual(['state/pipeline.yaml'])
      const healthy = await engine.getStatus({ root })
      expect(healthy.data.state_errors ?? []).toEqual([])
    } finally {
      await cleanup()
    }
  })
})
