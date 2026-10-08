import { describe, expect, test } from 'bun:test'
import { loadProjectMemory } from '../src/app/project-memory.ts'
import { projectInstructions } from '../src/app/prompt.ts'
import { tempDir, writeFiles } from './helpers.ts'

describe('loadProjectMemory', () => {
  test('empty project', async () => {
    const root = await tempDir()
    expect(await loadProjectMemory(root)).toEqual({ text: undefined, file: undefined, nested: [] })
  })

  test('AGENTS.md wins over CLAUDE.md', async () => {
    const root = await tempDir()
    await writeFiles(root, { 'AGENTS.md': 'agents rules', 'CLAUDE.md': 'claude rules' })
    const memory = await loadProjectMemory(root)
    expect(memory.file).toBe('AGENTS.md')
    expect(memory.text).toBe('agents rules')
  })

  test('CLAUDE.md is the fallback', async () => {
    const root = await tempDir()
    await writeFiles(root, { 'CLAUDE.md': 'claude rules' })
    const memory = await loadProjectMemory(root)
    expect(memory.file).toBe('CLAUDE.md')
    expect(memory.text).toBe('claude rules')
  })

  test('nested AGENTS.md are listed as virtual paths, sorted, ignoring node_modules and .git', async () => {
    const root = await tempDir()
    await writeFiles(root, {
      'AGENTS.md': 'root',
      'packages/b/AGENTS.md': 'b',
      'packages/a/AGENTS.md': 'a',
      'node_modules/x/AGENTS.md': 'no',
      '.git/AGENTS.md': 'no',
    })
    const memory = await loadProjectMemory(root)
    expect(memory.nested).toEqual(['/packages/a/AGENTS.md', '/packages/b/AGENTS.md'])
  })

  test('nested list is capped at 50', async () => {
    const root = await tempDir()
    const files: Record<string, string> = {}
    for (let i = 0; i < 60; i++) files[`d${String(i).padStart(2, '0')}/AGENTS.md`] = 'x'
    await writeFiles(root, files)
    const memory = await loadProjectMemory(root)
    expect(memory.nested).toHaveLength(50)
    expect(memory.nested[0]).toBe('/d00/AGENTS.md')
  })

  test('the root file is capped at 40000 characters with a notice', async () => {
    const root = await tempDir()
    await writeFiles(root, { 'AGENTS.md': 'a'.repeat(50_000) })
    const memory = await loadProjectMemory(root)
    expect(memory.text?.startsWith('a'.repeat(40_000))).toBe(true)
    expect(memory.text).toContain('[truncated: AGENTS.md')
    expect((memory.text ?? '').length).toBeLessThan(40_200)
  })

  test('projectInstructions frames the memory; undefined when empty', () => {
    expect(projectInstructions({ nested: [] })).toBeUndefined()
    const text = projectInstructions({
      text: 'Use tabs.',
      file: 'CLAUDE.md',
      nested: ['/x/AGENTS.md'],
    })
    expect(text).toContain('Project instructions (CLAUDE.md)')
    expect(text).toContain('Use tabs.')
    expect(text).toContain('- /x/AGENTS.md')
  })
})
