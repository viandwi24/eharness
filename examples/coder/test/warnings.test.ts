import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installWarningSinks } from '../src/app/warnings.ts'

let restore: (() => void) | undefined
afterEach(() => restore?.())

test('AI SDK and process warnings go to warnings.log, not stderr', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coder-warn-'))
  restore = installWarningSinks(dir)
  const log = (globalThis as { AI_SDK_LOG_WARNINGS?: (o: unknown) => void }).AI_SDK_LOG_WARNINGS
  expect(typeof log).toBe('function')
  log?.({ warnings: [{ type: 'other', message: 'hello sdk' }] })
  process.emitWarning('process thing', { type: 'DeprecationWarning' })
  await new Promise((r) => setTimeout(r, 150))
  const text = await readFile(join(dir, 'warnings.log'), 'utf8')
  expect(text).toContain('hello sdk')
  expect(text).toContain('DeprecationWarning: process thing')
})
