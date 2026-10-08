import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../src/app/config.ts'
import { runDoctor } from '../src/app/doctor.ts'
import type { ModelOption } from '../src/contracts.ts'
import { isolateHome, setup, tempDir, writeFiles } from './helpers.ts'

const model = (id: string): ModelOption => ({
  id,
  name: id,
  provider: 'openrouter',
  reasoning: false,
  tools: true,
})

const find = (checks: Awaited<ReturnType<typeof runDoctor>>, name: string) =>
  checks.find((c) => c.name === name)

describe('doctor', () => {
  test('all good', async () => {
    const { config } = await setup()
    const checks = await runDoctor({
      config: { ...config, provider: 'openrouter' },
      models: async () => [model(config.model)],
      env: {
        OPENROUTER_API_KEY: 'k',
        EDITOR: 'vim',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
      which: async (c) => `/usr/bin/${c}`,
      bunVersion: '1.4.2',
      osSandbox: () => ({ kind: 'seatbelt' }),
      terminal: { columns: 120, rows: 40, isTTY: true },
      platform: 'darwin',
    })
    expect(checks.every((c) => c.status === 'ok')).toBe(true)
    expect(checks.map((c) => c.name)).toEqual([
      'Runtime',
      'Provider key',
      'Model',
      'git',
      'ripgrep',
      'Editor',
      'Clipboard',
      'Sandbox',
      'Settings files',
      'Project trust',
      'MCP servers',
      'LSP',
      'Data directory',
      'Terminal',
    ])
    expect(find(checks, 'Terminal')?.detail).toBe('120x40, truecolor')
  })

  test('problems are reported with a status each', async () => {
    await isolateHome()
    const root = await tempDir()
    await writeFiles(root, {
      '.coder/settings.json': JSON.stringify({
        hooks: { Stop: [{ command: 'x' }] },
        mcpServers: { files: { type: 'stdio', command: 'x' } },
      }),
    })
    const config = await loadConfig({ cwd: root })
    // broken after startup (a hand edit), which is what the check is for
    await writeFiles(root, { '.coder/settings.local.json': '{ nope' })
    const checks = await runDoctor({
      config,
      settings: {
        sandbox: { enabled: true },
        lsp: { ts: { command: ['typescript-language-server', '--stdio'], extensions: ['.ts'] } },
      },
      models: async () => [model('other/model')],
      env: { TERM: 'dumb', NO_COLOR: '1' },
      which: async () => undefined,
      bunVersion: '1.1.0',
      osSandbox: () => ({ kind: 'none' }),
      terminal: { columns: 40, rows: 10, isTTY: false },
      platform: 'linux',
    })
    expect(find(checks, 'Runtime')?.status).toBe('warn')
    expect(find(checks, 'Provider key')?.status).toBe('error')
    expect(find(checks, 'Model')?.status).toBe('warn')
    expect(find(checks, 'git')?.status).toBe('warn')
    expect(find(checks, 'ripgrep')?.status).toBe('warn')
    expect(find(checks, 'Editor')?.status).toBe('warn')
    expect(find(checks, 'Clipboard')?.status).toBe('warn')
    expect(find(checks, 'Sandbox')).toMatchObject({ status: 'warn' })
    expect(find(checks, 'Sandbox')?.detail).toContain('bwrap')
    expect(find(checks, 'Settings files')?.status).toBe('error')
    expect(find(checks, 'Project trust')).toMatchObject({ status: 'warn' })
    expect(find(checks, 'Project trust')?.detail).toContain('hooks')
    expect(find(checks, 'MCP servers')?.detail).toBe('none configured')
    expect(find(checks, 'LSP')).toMatchObject({ status: 'warn' })
    expect(find(checks, 'LSP')?.detail).toContain('typescript-language-server')
    expect(find(checks, 'Terminal')?.status).toBe('warn')
  })

  test('catalog failure is a warning, never a crash', async () => {
    const { config } = await setup()
    const checks = await runDoctor({
      config,
      models: async () => {
        throw new Error('offline')
      },
      env: {},
      which: async () => undefined,
    })
    expect(find(checks, 'Model')?.status).toBe('warn')
    expect(find(checks, 'Data directory')?.status).toBe('ok')
  })
})
