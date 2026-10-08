import { describe, expect, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { loadConfig, mergeSettings, readSettingsLayers } from '../src/app/config.ts'
import { loadPreferences } from '../src/app/preferences.ts'
import { createSettingsManager } from '../src/app/settings.ts'
import { isolateHome, setup, tempDir, writeFiles } from './helpers.ts'

const json = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(file, 'utf8'))

describe('settings manager', () => {
  test('lists every key with value and source', async () => {
    const { config, home } = await setup({
      '.coder/settings.json': JSON.stringify({ theme: 'light', sandbox: { enabled: true } }),
      '.coder/settings.local.json': JSON.stringify({ editorMode: 'vim' }),
    })
    await writeFile(`${home}/settings.json`, JSON.stringify({ notifications: 'desktop' }))
    const manager = createSettingsManager({ config: await loadConfig({ cwd: config.root }) })
    const views = await manager.settings()
    expect(views.map((v) => v.key)).toEqual([
      'model',
      'provider',
      'thinking',
      'permissions.defaultMode',
      'theme',
      'outputStyle',
      'notifications',
      'askUserQuestionTimeout',
      'promptSuggestions',
      'editorMode',
      'sandbox.enabled',
      'sandbox.network',
      'statusLine.command',
    ])
    const by = (k: string) => views.find((v) => v.key === k)
    expect(by('theme')).toMatchObject({ value: 'light', source: 'project', type: 'enum' })
    expect(by('notifications')).toMatchObject({ value: 'desktop', source: 'user' })
    expect(by('editorMode')).toMatchObject({ value: 'vim', source: 'local' })
    expect(by('sandbox.enabled')).toMatchObject({ value: true, source: 'project' })
    expect(by('promptSuggestions')).toMatchObject({
      value: false,
      source: 'default',
      type: 'boolean',
    })
    expect(by('askUserQuestionTimeout')).toMatchObject({ value: 0, type: 'number' })
    expect(by('model')?.value).toBe(config.model)
  })

  test('update writes the right file, keeps other keys, validates, notifies', async () => {
    const { config, root, home } = await setup({
      '.coder/settings.local.json': JSON.stringify({
        permissions: { allow: ['Bash(ls)'] },
        custom: { keep: 1 },
      }),
    })
    const loaded = await loadConfig({ cwd: root })
    const applied: Array<[string, unknown]> = []
    const changes: string[] = []
    const manager = createSettingsManager({
      config: loaded,
      apply: (k, v) => void applied.push([k, v]),
    })
    manager.onChange((k, v, scope) => changes.push(`${k}=${String(v)}@${scope}`))

    await manager.updateSetting('permissions.defaultMode', 'plan', 'local')
    await manager.updateSetting('sandbox.network', 'true', 'local')
    await manager.updateSetting('theme', 'light', 'user')
    await manager.updateSetting('askUserQuestionTimeout', '45', 'user')
    expect(await json(config.settingsFiles.local)).toEqual({
      permissions: { allow: ['Bash(ls)'], defaultMode: 'plan' },
      custom: { keep: 1 },
      sandbox: { network: true },
    })
    expect(await json(`${home}/settings.json`)).toEqual({
      theme: 'light',
      askUserQuestionTimeout: 45,
    })
    expect(manager.setting('theme')).toBe('light')
    expect(manager.setting('sandbox')).toEqual({ network: true })
    expect(applied).toContainEqual(['permissions.defaultMode', 'plan'])
    expect(changes).toContain('theme=light@user')

    await expect(manager.updateSetting('theme', 'neon', 'user')).rejects.toThrow(
      /Invalid value for theme/,
    )
    await expect(manager.updateSetting('askUserQuestionTimeout', -1, 'user')).rejects.toThrow()
    await expect(manager.updateSetting('nope', 1, 'user')).rejects.toThrow(/Unknown setting/)
    await expect(manager.updateSetting('promptSuggestions', 'maybe', 'user')).rejects.toThrow()
    // a rejected update changes nothing
    expect((await json(`${home}/settings.json`)).theme).toBe('light')

    // the merged value is visible through the views, with its source
    const views = await manager.settings()
    expect(views.find((v) => v.key === 'permissions.defaultMode')).toMatchObject({
      value: 'plan',
      source: 'local',
    })
  })

  test('statusLine.command: set and clear removes the object', async () => {
    const { config } = await setup()
    const manager = createSettingsManager({ config })
    await manager.updateSetting('statusLine.command', ' echo hi ', 'user')
    expect((await json(config.settingsFiles.user)).statusLine).toEqual({ command: 'echo hi' })
    expect(manager.setting('statusLine')).toEqual({ command: 'echo hi' })
    await manager.updateSetting('statusLine.command', '', 'user')
    expect(await json(config.settingsFiles.user)).toEqual({})
    expect(manager.setting('statusLine')).toBeUndefined()
  })

  test('refuses to overwrite a file that is not valid JSON', async () => {
    const { config } = await setup()
    await writeFiles(config.root, { '.coder/settings.local.json': '{ broken' })
    const manager = createSettingsManager({ config })
    await expect(manager.updateSetting('theme', 'light', 'local')).rejects.toThrow(/not valid JSON/)
    expect(await readFile(config.settingsFiles.local, 'utf8')).toBe('{ broken')
  })

  test('model, provider and thinking go to the preferences file and through apply', async () => {
    const { config } = await setup()
    const applied: Array<[string, unknown]> = []
    const manager = createSettingsManager({
      config,
      apply: (k, v) => void applied.push([k, v]),
      current: () => ({ provider: 'openrouter', model: 'a/b', thinking: 'high' }),
    })
    await manager.updateSetting('model', 'x/y', 'user')
    await manager.updateSetting('thinking', 'low', 'user')
    await manager.updateSetting('provider', 'gateway', 'local')
    expect(await loadPreferences(config.projectDataDir)).toEqual({
      model: 'x/y',
      thinking: 'low',
      provider: 'gateway',
    })
    expect(applied).toEqual([
      ['model', 'x/y'],
      ['thinking', 'low'],
      ['provider', 'gateway'],
    ])
    const views = await manager.settings()
    expect(views.find((v) => v.key === 'thinking')).toMatchObject({
      value: 'high',
      source: 'local',
    })
    await expect(manager.updateSetting('thinking', 'extreme', 'user')).rejects.toThrow()
  })

  test('output style options come from the callback', async () => {
    const { config } = await setup()
    const manager = createSettingsManager({
      config,
      outputStyleNames: async () => ['default', 'pirate'],
    })
    const view = (await manager.settings()).find((v) => v.key === 'outputStyle')
    expect(view?.options).toEqual(['default', 'pirate'])
  })
})

describe('mergeSettings and layers', () => {
  test('hooks concatenate, sandbox and lsp merge, scalars override', () => {
    const merged = mergeSettings([
      {
        theme: 'dark',
        hooks: { Stop: [{ command: 'a' }] },
        sandbox: { enabled: true, allowWrite: ['/a'] },
      },
      {
        theme: 'light',
        hooks: { Stop: [{ command: 'b' }], PreToolUse: [{ command: 'c' }] },
        sandbox: { network: false, allowWrite: ['/a', '/b'] },
        lsp: { ts: { command: ['tsserver'], extensions: ['.ts'] } },
      },
    ])
    expect(merged.theme).toBe('light')
    expect(merged.hooks?.Stop?.map((h) => h.command)).toEqual(['a', 'b'])
    expect(merged.hooks?.PreToolUse).toHaveLength(1)
    expect(merged.sandbox).toEqual({ enabled: true, network: false, allowWrite: ['/a', '/b'] })
    expect(Object.keys(merged.lsp ?? {})).toEqual(['ts'])
  })

  test('readSettingsLayers reports scope and applies trust', async () => {
    await isolateHome()
    const root = await tempDir()
    await writeFiles(root, {
      '.coder/settings.json': JSON.stringify({
        theme: 'light',
        hooks: { Stop: [{ command: 'x' }] },
      }),
    })
    const config = await loadConfig({ cwd: root })
    const layers = await readSettingsLayers(config)
    expect(layers.map((l) => l.scope)).toEqual(['project'])
    expect(layers[0]?.settings).toEqual({ theme: 'light' })
  })
})
