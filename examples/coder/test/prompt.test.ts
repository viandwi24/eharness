import { describe, expect, test } from 'bun:test'
import { STATIC_INSTRUCTIONS, subagentInstructions, turnReminder } from '../src/app/prompt.ts'
import type { PermissionMode } from '../src/contracts.ts'
import { gitInit, tempDir, writeFiles } from './helpers.ts'

const remind = async (
  root: string,
  mode: PermissionMode = 'default',
  extraDirs: string[] = [],
): Promise<string> =>
  turnReminder({ root, mode: () => mode, extraDirs: () => extraDirs })({} as never)

describe('turnReminder', () => {
  test('contains date, mode and the git branch of a temp repo', async () => {
    const root = await tempDir()
    await writeFiles(root, { 'a.txt': 'a' })
    await gitInit(root, 'feature-x')
    const text = await remind(root, 'plan')
    expect(text).toContain(`Today's date: ${new Date().toISOString().slice(0, 10)}`)
    expect(text).toContain('Plan mode is ON')
    expect(text).toContain('Git branch: feature-x (working tree clean)')
  })

  test('lists changed files in the git status', async () => {
    const root = await tempDir()
    await writeFiles(root, { 'a.txt': 'a' })
    await gitInit(root)
    await writeFiles(root, { 'b.txt': 'new' })
    const text = await remind(root)
    expect(text).toContain('Git status (short):')
    expect(text).toContain('b.txt')
  })

  test('a non-git directory is handled', async () => {
    const root = await tempDir()
    const text = await remind(root, 'acceptEdits', ['/@dirs/lib (/real/lib)'])
    expect(text).toContain('Git: not a git repository.')
    expect(text).toContain('acceptEdits')
    expect(text).toContain('Extra directories mounted: /@dirs/lib (/real/lib)')
  })

  test('the mode is read on every call', async () => {
    const root = await tempDir()
    let mode: PermissionMode = 'default'
    const fn = turnReminder({ root, mode: () => mode, extraDirs: () => [] })
    expect(await fn({} as never)).toContain('default:')
    mode = 'bypassPermissions'
    expect(await fn({} as never)).toContain('bypassPermissions:')
  })
})

describe('static prompts', () => {
  test('static instructions carry no volatile data', () => {
    expect(STATIC_INSTRUCTIONS).not.toContain(new Date().toISOString().slice(0, 10))
    expect(STATIC_INSTRUCTIONS).toContain('exit_plan_mode')
  })

  test('subagent instructions end with the definition prompt', () => {
    const text = subagentInstructions({ prompt: 'Review things.' })
    expect(text.endsWith('Review things.')).toBe(true)
    expect(text).toContain('subagent')
  })
})
