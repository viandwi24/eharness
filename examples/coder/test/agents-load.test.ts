import { describe, expect, test } from 'bun:test'
import { BUILTIN_AGENTS, expandToolNames, loadAgentDefinitions } from '../src/agents/index.ts'
import { isolateHome, tempDir, writeFiles } from './helpers.ts'

const md = (front: string, body = 'Do the thing.'): string => `---\n${front}\n---\n${body}\n`

async function load(
  project: Record<string, string> = {},
  user: Record<string, string> = {},
  cliAgents = {},
) {
  const home = await isolateHome()
  const root = await tempDir()
  await writeFiles(root, project)
  await writeFiles(home, user)
  const result = await loadAgentDefinitions({ root, userDir: home, cliAgents })
  return { ...result, root, home, byName: new Map(result.definitions.map((d) => [d.name, d])) }
}

describe('expandToolNames', () => {
  test('aliases expand, real names pass through, dedupe, Agent(x) loses the restriction', () => {
    expect(expandToolNames(['Read', 'Grep'])).toEqual(['read_file', 'list_files', 'grep'])
    expect(expandToolNames(['Edit'])).toEqual(['edit_file', 'write_file', 'delete_file'])
    expect(expandToolNames(['read_file', 'Read'])).toEqual(['read_file', 'list_files'])
    expect(expandToolNames(['Task', 'Agent(explore)', ' '])).toEqual(['agent'])
    expect(expandToolNames(['mcp__x__y'])).toEqual(['mcp__x__y'])
  })
})

describe('loadAgentDefinitions', () => {
  test('only the built-ins by default', async () => {
    const { definitions, warnings } = await load()
    expect(definitions.map((d) => d.name)).toEqual(BUILTIN_AGENTS.map((d) => d.name))
    expect(definitions.map((d) => d.name)).toEqual(['general-purpose', 'explore', 'plan'])
    expect(warnings).toEqual([])
  })

  test('built-in explore is read-only', async () => {
    const { byName } = await load()
    const explore = byName.get('explore')
    expect(explore?.tools).not.toContain('edit_file')
    expect(explore?.tools).not.toContain('write_file')
    expect(explore?.disallowedTools).toEqual(
      expect.arrayContaining(['edit_file', 'write_file', 'delete_file', 'agent']),
    )
  })

  test('frontmatter parsing: description, tools list (comma string and array), model, limits', async () => {
    const { byName, root } = await load({
      '.coder/agents/reviewer.md': md(
        'name: reviewer\ndescription: Reviews code\ntools: Read, Grep, Bash\ndisallowedTools: [Edit]\nmodel: anthropic/claude-haiku\npermissionMode: plan\nmaxTurns: 7\nomitProjectMemory: true',
        'Review strictly.\n\nSecond paragraph.',
      ),
    })
    const def = byName.get('reviewer')
    expect(def).toBeDefined()
    expect(def?.source).toBe('project')
    expect(def?.file).toBe(`${root}/.coder/agents/reviewer.md`)
    expect(def?.description).toBe('Reviews code')
    expect(def?.prompt).toBe('Review strictly.\n\nSecond paragraph.')
    expect(def?.tools).toEqual(['read_file', 'list_files', 'grep', 'bash'])
    expect(def?.disallowedTools).toEqual(['edit_file', 'write_file', 'delete_file'])
    expect(def?.model).toBe('anthropic/claude-haiku')
    expect(def?.permissionMode).toBe('plan')
    expect(def?.maxTurns).toBe(7)
    expect(def?.omitProjectMemory).toBe(true)
  })

  test('priority cli > project > user > builtin on a name collision', async () => {
    const project = {
      '.coder/agents/explore.md': md('name: explore\ndescription: project explore'),
    }
    const user = {
      'agents/explore.md': md('name: explore\ndescription: user explore'),
      'agents/plan.md': md('name: plan\ndescription: user plan'),
      'agents/only-user.md': md('name: only-user\ndescription: u'),
    }
    const a = await load(project, user)
    expect(a.byName.get('explore')?.source).toBe('project')
    expect(a.byName.get('plan')?.source).toBe('user')
    expect(a.byName.get('only-user')?.source).toBe('user')
    expect(a.byName.get('general-purpose')?.source).toBe('builtin')
    expect(a.definitions.filter((d) => d.name === 'explore')).toHaveLength(1)

    const b = await load(project, user, {
      explore: { description: 'cli explore', prompt: 'cli prompt', tools: ['Read'] },
    })
    const explore = b.byName.get('explore')
    expect(explore?.source).toBe('cli')
    expect(explore?.description).toBe('cli explore')
    expect(explore?.tools).toEqual(['read_file', 'list_files'])
  })

  test('invalid files produce warnings naming the file; valid ones still load', async () => {
    const { byName, warnings, root } = await load({
      '.coder/agents/no-frontmatter.md': 'just text',
      '.coder/agents/bad-name.md': md('name: Bad_Name\ndescription: x'),
      '.coder/agents/no-prompt.md': md('name: no-prompt\ndescription: x', ''),
      '.coder/agents/bad-mode.md': md('name: bad-mode\ndescription: x\npermissionMode: wild'),
      '.coder/agents/bad-turns.md': md('name: bad-turns\ndescription: x\nmaxTurns: 0'),
      '.coder/agents/no-description.md': md('name: no-description'),
      '.coder/agents/notes.txt': 'ignored, not markdown',
      '.coder/agents/good.md': md('name: good\ndescription: fine'),
    })
    expect(byName.has('good')).toBe(true)
    for (const name of [
      'bad-name',
      'no-prompt',
      'bad-mode',
      'bad-turns',
      'no-description',
      'no-frontmatter',
    ]) {
      expect(byName.has(name)).toBe(false)
      expect(warnings.some((w) => w.includes(`${root}/.coder/agents/${name}.md`))).toBe(true)
    }
    expect(warnings).toHaveLength(6)
  })

  test('invalid --agents entries are skipped with a warning', async () => {
    const { byName, warnings } = await load(
      {},
      {},
      {
        'Bad Name': { description: 'd', prompt: 'p' },
        empty: { description: ' ', prompt: 'p' },
        noprompt: { description: 'd', prompt: '' },
        ok: { description: 'd', prompt: 'p' },
      },
    )
    expect(byName.has('ok')).toBe(true)
    expect(byName.size).toBe(4) // 3 built-ins + ok
    expect(warnings).toHaveLength(3)
    expect(warnings.some((w) => w.includes('Bad Name'))).toBe(true)
  })
})
