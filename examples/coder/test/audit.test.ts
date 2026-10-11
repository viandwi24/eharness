import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUDIT_MAX_BYTES, auditLog, clipInput } from '../src/permissions/audit.ts'

const decision = (input: unknown) =>
  ({ toolName: 'write', approved: true, by: 'user', reason: undefined, input }) as never

describe('audit log', () => {
  test('owner-only file, long inputs cut', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coder-audit-'))
    const file = join(dir, 'audit.jsonl')
    await auditLog(file)(decision({ path: '/a', content: 'x'.repeat(10_000) }))
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const line = JSON.parse((await readFile(file, 'utf8')).trim())
    expect(line.input.path).toBe('/a')
    expect(line.input.content.length).toBeLessThan(700)
  })

  test('rotates past the size limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coder-audit-'))
    const file = join(dir, 'audit.jsonl')
    await writeFile(file, 'y'.repeat(AUDIT_MAX_BYTES + 1))
    await auditLog(file)(decision({ a: 1 }))
    expect((await stat(`${file}.1`)).size).toBe(AUDIT_MAX_BYTES + 1)
    expect((await readFile(file, 'utf8')).split('\n').filter(Boolean)).toHaveLength(1)
  })

  test('clipInput keeps short values', () => {
    expect(clipInput({ a: ['b', 1, null] })).toEqual({ a: ['b', 1, null] })
  })
})
