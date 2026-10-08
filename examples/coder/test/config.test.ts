import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig } from '../src/app/config.ts'
import { isolateHome, setup, tempDir, writeFiles } from './helpers.ts'

describe('loadConfig', () => {
  test('defaults', async () => {
    const { root, home, config } = await setup()
    expect(config.root).toBe(root)
    expect(config.userDir).toBe(home)
    expect(config.model).toBe('anthropic/claude-sonnet-4.6')
    expect(config.mode).toBe('default')
    expect(config.contextWindow).toBe(200_000)
    expect(config.maxSteps).toBe(200)
    expect(config.maxAgentDepth).toBe(2)
    expect(config.rules).toEqual({ allow: [], ask: [], deny: [] })
    expect(config.warnings).toEqual([])
  })

  test('CODER_MODEL is the default model; settings and flags beat it', async () => {
    await isolateHome()
    const root = await tempDir()
    process.env.CODER_MODEL = 'openai/gpt-x'
    try {
      expect((await loadConfig({ cwd: root })).model).toBe('openai/gpt-x')
      expect((await loadConfig({ cwd: root, model: 'a/b' })).model).toBe('a/b')
      await writeFiles(root, { '.coder/settings.json': '{"model":"from/settings"}' })
      expect((await loadConfig({ cwd: root })).model).toBe('from/settings')
    } finally {
      delete process.env.CODER_MODEL
    }
  })

  test('merge order user -> project -> local -> flags; arrays concatenated and deduped', async () => {
    const home = await isolateHome()
    const root = await tempDir()
    await writeFile(
      join(home, 'settings.json'),
      JSON.stringify({
        model: 'user/m',
        contextWindow: 1000,
        permissions: {
          allow: ['Read', 'Bash(ls)'],
          defaultMode: 'acceptEdits',
          deny: ['Bash(rm *)'],
        },
      }),
    )
    await writeFiles(root, {
      '.coder/settings.json': JSON.stringify({
        model: 'project/m',
        permissions: { allow: ['Bash(ls)', 'Bash(git *)'], ask: ['Edit(src/**)'] },
      }),
      '.coder/settings.local.json': JSON.stringify({
        model: 'local/m',
        permissions: { defaultMode: 'plan', deny: ['Bash(rm *)', 'Read(.env)'] },
      }),
    })
    const config = await loadConfig({ cwd: root, allowedTools: ['Bash(git *)', 'Bash(bun *)'] })
    expect(config.model).toBe('local/m')
    expect(config.contextWindow).toBe(1000)
    expect(config.mode).toBe('plan')
    expect(config.rules.allow).toEqual(['Read', 'Bash(ls)', 'Bash(git *)', 'Bash(bun *)'])
    expect(config.rules.ask).toEqual(['Edit(src/**)'])
    expect(config.rules.deny).toEqual(['Bash(rm *)', 'Read(.env)'])

    const flagged = await loadConfig({
      cwd: root,
      model: 'flag/m',
      permissionMode: 'dontAsk',
      disallowedTools: ['Bash(sudo *)'],
    })
    expect(flagged.model).toBe('flag/m')
    expect(flagged.mode).toBe('dontAsk')
    expect(flagged.rules.deny).toEqual(['Bash(rm *)', 'Read(.env)', 'Bash(sudo *)'])
    expect(config.settingsFiles.project).toBe(join(root, '.coder', 'settings.json'))
  })

  test('an invalid settings file errors and names the file', async () => {
    await isolateHome()
    const root = await tempDir()
    await writeFiles(root, { '.coder/settings.json': '{ nope' })
    await expect(loadConfig({ cwd: root })).rejects.toThrow(/settings\.json/)
    await writeFiles(root, { '.coder/settings.json': '{"contextWindow":"big"}' })
    await expect(loadConfig({ cwd: root })).rejects.toThrow(
      new RegExp(
        `${join(root, '.coder', 'settings.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*contextWindow`,
      ),
    )
    await writeFiles(root, { '.coder/settings.json': '{"permissions":{"defaultMode":"wild"}}' })
    await expect(loadConfig({ cwd: root })).rejects.toThrow(/settings\.json/)
  })

  test('an invalid permission mode flag errors with the valid modes', async () => {
    await isolateHome()
    const root = await tempDir()
    const error = await loadConfig({ cwd: root, permissionMode: 'yolo' }).catch((e) => e as Error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('yolo')
    expect((error as Error).message).toContain('bypassPermissions')
  })

  test('--agents JSON is parsed; bad JSON and bad shape error', async () => {
    await isolateHome()
    const root = await tempDir()
    const agents = JSON.stringify({
      reviewer: { description: 'Reviews', prompt: 'Be strict', tools: ['Read'] },
    })
    const config = await loadConfig({ cwd: root, agents })
    expect(config.cliAgents.reviewer).toEqual({
      description: 'Reviews',
      prompt: 'Be strict',
      tools: ['Read'],
    })
    await expect(loadConfig({ cwd: root, agents: '{' })).rejects.toThrow(/--agents/)
    await expect(loadConfig({ cwd: root, agents: '{"x":{"description":"d"}}' })).rejects.toThrow(
      /--agents/,
    )
  })

  test('additionalDirectories resolve (relative to root), dedupe, and warn when missing', async () => {
    await isolateHome()
    const root = await tempDir()
    const shared = await tempDir('coder-shared-')
    await writeFiles(root, {
      '.coder/settings.json': JSON.stringify({
        permissions: { additionalDirectories: [shared, './nope', '.'] },
      }),
    })
    await mkdir(join(root, 'lib'))
    const config = await loadConfig({ cwd: root, addDir: ['lib', shared, '/does/not/exist'] })
    expect(config.additionalDirectories).toEqual([shared, join(root, 'lib')])
    expect(config.warnings).toHaveLength(2)
    expect(config.warnings.some((w) => w.includes('nope'))).toBe(true)
    expect(
      config.warnings.some((w) => w.includes('/does/not/exist') && w.includes('--add-dir')),
    ).toBe(true)
  })

  test('projectDataDir is a stable hash of the root and gets its subdirectories', async () => {
    const { root, home, config } = await setup()
    const hash = createHash('sha256').update(root).digest('hex').slice(0, 16)
    expect(config.projectDataDir).toBe(join(home, 'projects', hash))
    const again = await loadConfig({ cwd: root })
    expect(again.projectDataDir).toBe(config.projectDataDir)
    const other = await tempDir()
    expect((await loadConfig({ cwd: other })).projectDataDir).not.toBe(config.projectDataDir)
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(config.projectDataDir)).sort()).toEqual(['sessions', 'tool-outputs'])
  })

  test('print options and output format validation', async () => {
    await isolateHome()
    const root = await tempDir()
    expect((await loadConfig({ cwd: root, print: 'hi' })).print).toEqual({
      prompt: 'hi',
      format: 'text',
    })
    expect((await loadConfig({ cwd: root, print: 'hi', outputFormat: 'json' })).print?.format).toBe(
      'json',
    )
    await expect(loadConfig({ cwd: root, print: 'hi', outputFormat: 'xml' })).rejects.toThrow(
      /output-format/,
    )
  })
})
