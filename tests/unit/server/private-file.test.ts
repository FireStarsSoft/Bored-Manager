import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  backupFile,
  readPrivateJson,
  writeAtomicPrivateJson
} from '../../../server/services/private-file'
import { withTestTempDir } from '../../helpers/temp-dir'
import { isRecord } from '@shared/validation'

function document(value: unknown): { value: string } {
  if (!isRecord(value) || typeof value['value'] !== 'string') {
    throw new Error('fixture is invalid')
  }
  return { value: value['value'] }
}

describe('atomic private JSON files', () => {
  it('recovers a truncated primary from its valid backup', async () => {
    await withTestTempDir((root) => {
      const file = join(root, 'state.json')
      writeAtomicPrivateJson(file, { value: 'last-known-good' })
      writeFileSync(file, '{"value":', 'utf8')

      expect(readPrivateJson(file, document, 'fixture')).toEqual({
        kind: 'value',
        value: { value: 'last-known-good' },
        recovered: true
      })
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ value: 'last-known-good' })
      expect(JSON.parse(readFileSync(backupFile(file), 'utf8'))).toEqual({
        value: 'last-known-good'
      })
      expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
      if (process.platform !== 'win32') {
        expect(statSync(file).mode & 0o777).toBe(0o600)
      }
    }, 'atomic-recovery')
  })

  it('fails closed when neither primary nor backup validates', async () => {
    await withTestTempDir((root) => {
      const file = join(root, 'state.json')
      writeFileSync(file, '{', 'utf8')
      writeFileSync(backupFile(file), '[]', 'utf8')

      expect(() => readPrivateJson(file, document, 'fixture')).toThrow(
        /Cannot load fixture/
      )
    }, 'atomic-corrupt')
  })
})
