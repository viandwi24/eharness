import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent, definePlugin } from '../index.ts'
import { memoryMessages, memoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { filesystem, loadProjectInstructions, projectInstructions } from './index.ts'
import { memoryFs } from './memory.ts'
import type { ProjectInstructionsInfo } from './project-instructions.ts'

describe('loadProjectInstructions', () => {
  test('none', async () => {
    const info = await loadProjectInstructions(memoryFs({ '/a.txt': 'x' }))
    expect(info).toEqual({ nested: [], nestedOmitted: 0 })
  })

  test('only AGENTS.md', async () => {
    const info = await loadProjectInstructions(memoryFs({ '/AGENTS.md': 'agents' }))
    expect(info.root).toMatchObject({ name: 'AGENTS.md', content: 'agents', ignored: [] })
  })

  test('only CLAUDE.md', async () => {
    const info = await loadProjectInstructions(memoryFs({ '/CLAUDE.md': 'claude' }))
    expect(info.root?.name).toBe('CLAUDE.md')
  })

  test('both: CLAUDE.md wins and AGENTS.md is reported as ignored', async () => {
    const info = await loadProjectInstructions(
      memoryFs({ '/CLAUDE.md': 'claude', '/AGENTS.md': 'agents' }),
    )
    expect(info.root).toMatchObject({
      name: 'CLAUDE.md',
      content: 'claude',
      ignored: ['AGENTS.md'],
    })
  })

  test('custom order', async () => {
    const info = await loadProjectInstructions(
      memoryFs({ '/CLAUDE.md': 'claude', '/AGENTS.md': 'agents' }),
      { files: ['AGENTS.md', 'CLAUDE.md'] },
    )
    expect(info.root?.name).toBe('AGENTS.md')
  })

  test('nested: per-directory preference, sorted, skips node_modules/.git, capped', async () => {
    const fs = memoryFs({
      '/CLAUDE.md': 'root',
      '/packages/b/AGENTS.md': 'b',
      '/packages/a/AGENTS.md': 'a',
      '/packages/a/CLAUDE.md': 'a2',
      '/node_modules/x/AGENTS.md': 'no',
      '/.git/AGENTS.md': 'no',
    })
    const info = await loadProjectInstructions(fs)
    expect(info.nested).toEqual([
      { path: '/packages/a/CLAUDE.md', name: 'CLAUDE.md', ignored: ['AGENTS.md'] },
      { path: '/packages/b/AGENTS.md', name: 'AGENTS.md', ignored: [] },
    ])
    const capped = await loadProjectInstructions(fs, { maxNested: 1 })
    expect(capped.nested).toHaveLength(1)
    expect(capped.nestedOmitted).toBe(1)
    expect((await loadProjectInstructions(fs, { nested: false })).nested).toEqual([])
    expect(
      (await loadProjectInstructions(fs, { exclude: ['/packages/a'] })).nested.map((n) => n.path),
    ).toEqual(['/packages/b/AGENTS.md'])
  })

  test('truncation adds a notice', async () => {
    const info = await loadProjectInstructions(memoryFs({ '/AGENTS.md': 'a'.repeat(500) }), {
      maxChars: 100,
    })
    expect(info.root?.truncated).toBe(true)
    expect(info.root?.chars).toBe(500)
    expect(info.root?.content).toContain('[truncated: AGENTS.md is longer than 100 characters]')
  })

  test('invalid options throw', () => {
    expect(() => projectInstructions({ files: [] })).toThrow()
    expect(() => projectInstructions({ files: ['a/b.md'] })).toThrow()
  })
})

describe('projectInstructions plugin', () => {
  test('static instruction (CLAUDE.md wins), nested list, service', async () => {
    const model = scriptedModel([{ text: 'ok' }])
    let seen: ProjectInstructionsInfo | undefined
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      storage: { messages: memoryMessages(), state: memoryState() },
      plugins: [
        filesystem({
          fs: memoryFs({ '/CLAUDE.md': 'USE-TABS', '/AGENTS.md': 'NOPE', '/x/AGENTS.md': 'n' }),
        }),
        projectInstructions(),
        definePlugin({
          name: 'probe',
          requires: ['projectInstructions'],
          session(ctx) {
            seen = ctx.services.projectInstructions
            return {}
          },
        }),
      ],
    })
    await agent.session('s').send('go').result
    const system = JSON.stringify(model.calls[0]?.prompt)
    expect(system).toContain('USE-TABS')
    expect(system).not.toContain('NOPE')
    expect(system).toContain('/x/AGENTS.md')
    expect(seen?.root?.ignored).toEqual(['AGENTS.md'])
  })

  test('frame option', async () => {
    const model = scriptedModel([{ text: 'ok' }])
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      storage: { messages: memoryMessages(), state: memoryState() },
      plugins: [
        filesystem({ fs: memoryFs({ '/AGENTS.md': 'rules' }) }),
        projectInstructions({ frame: (f) => `FRAMED ${f.name}: ${f.content}` }),
      ],
    })
    await agent.session('s').send('go').result
    expect(JSON.stringify(model.calls[0]?.prompt)).toContain('FRAMED AGENTS.md: rules')
  })
})
