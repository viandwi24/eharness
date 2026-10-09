import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { UIMessage } from 'ai'
import {
  assistantText,
  copyToClipboard,
  createSessionTools,
  exportText,
  osc52,
} from '../src/app/session-tools.ts'
import { createStorage, listSessions } from '../src/app/sessions.ts'
import { setup } from './helpers.ts'

const user = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
})

const conversation: UIMessage[] = [
  user('m1', 'fix the bug\nin parser.ts'),
  {
    id: 'm2',
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'secret thoughts', state: 'done' },
      { type: 'text', text: 'Let me look.' },
      {
        type: 'tool-read_file',
        toolCallId: 'c1',
        state: 'output-available',
        input: { path: '/parser.ts' },
        output: '1\tconst a = 1\n2\tconst b = 2',
      },
      {
        type: 'tool-bash',
        toolCallId: 'c2',
        state: 'output-error',
        input: { command: 'bun test' },
        errorText: 'exit 1',
      },
      { type: 'data-bashOutput', data: { chunk: 'x' } } as never,
      { type: 'text', text: 'Fixed it.' },
    ],
  },
  user('m3', 'thanks'),
  { id: 'm4', role: 'assistant', parts: [{ type: 'text', text: 'You are welcome.' }] },
]

describe('session tools', () => {
  test('exportText: quoted user text, assistant text, tool lines, no reasoning', () => {
    const text = exportText(conversation)
    expect(text).toBe(
      [
        '> fix the bug',
        '> in parser.ts',
        '',
        'Let me look.',
        '',
        '[read_file({"path":"/parser.ts"})] → 1\tconst a = 1',
        '',
        '[bash({"command":"bun test"})] → error: exit 1',
        '',
        'Fixed it.',
        '',
        '> thanks',
        '',
        'You are welcome.',
        '',
      ].join('\n'),
    )
    expect(text).not.toContain('secret thoughts')
    expect(exportText([])).toBe('')
  })

  test('assistantText: n-th latest assistant response, undefined past the start', () => {
    expect(assistantText(conversation)).toBe('You are welcome.')
    expect(assistantText(conversation, 2)).toBe('Let me look.\n\nFixed it.')
    expect(assistantText(conversation, 3)).toBeUndefined()
    expect(assistantText([], 1)).toBeUndefined()
  })

  test('nameBranch: the given name, else "<name> (branch)", nothing for an unnamed session', async () => {
    const { config } = await setup()
    const storage = createStorage(config)
    const tools = await createSessionTools({ config, storage, sessionId: () => 'old' })
    await tools.nameBranch('old', 'b1')
    expect(tools.names.nameOf('b1')).toBeUndefined()
    await tools.nameBranch('old', 'b2', 'experiment')
    expect(tools.names.nameOf('b2')).toBe('experiment')
    expect(tools.names.nameOf('old')).toBeUndefined()
    await tools.nameBranch('b2', 'b3')
    expect(tools.names.nameOf('b3')).toBe('experiment (branch)')
  })

  test('names persist in session-names.json, show in listSessions via withNames, empty removes', async () => {
    const { config } = await setup()
    const storage = createStorage(config)
    await storage.messages.save('s1', [user('a', 'hello')])
    await storage.messages.save('s2', [user('b', 'world')])
    let current = 's1'
    const tools = await createSessionTools({ config, storage, sessionId: () => current })
    expect(tools.sessionName()).toBeUndefined()
    await tools.rename('  My   session ')
    expect(tools.sessionName()).toBe('My session')
    current = 's2'
    expect(tools.sessionName()).toBeUndefined()
    const file = JSON.parse(
      await readFile(join(config.projectDataDir, 'session-names.json'), 'utf8'),
    )
    expect(file).toEqual({ s1: 'My session' })

    const listed = await tools.withNames(await listSessions(config))
    expect(listed.find((s) => s.id === 's1')?.name).toBe('My session')
    expect(listed.find((s) => s.id === 's2')?.name).toBeUndefined()

    // a new process sees the names
    const again = await createSessionTools({ config, storage, sessionId: () => 's1' })
    expect(again.sessionName()).toBe('My session')
    await again.rename('')
    expect(again.sessionName()).toBeUndefined()
  })

  test('writeExport: default file name in the root, or a given file', async () => {
    const { config, root } = await setup()
    const tools = await createSessionTools({
      config,
      storage: createStorage(config),
      sessionId: () => 's',
    })
    const text = exportText(conversation)
    const path = await tools.writeExport(text)
    expect(path.startsWith(join(root, 'coder-export-'))).toBe(true)
    expect(path).toMatch(/coder-export-\d{8}-\d{6}\.txt$/)
    expect(await readFile(path, 'utf8')).toBe(text)
    const named = await tools.writeExport(text, 'out/talk.txt')
    expect(named).toBe(join(root, 'out', 'talk.txt'))
    expect(await readFile(named, 'utf8')).toBe(text)
  })

  test('copyToClipboard: the first command that works, else an OSC 52 sequence', async () => {
    const tried: string[] = []
    const ok = await copyToClipboard('hello', {
      platform: 'linux',
      run: async (cmd, _args, input) => {
        tried.push(`${cmd}:${input}`)
        return cmd === 'xclip'
      },
    })
    expect(ok).toEqual({ copied: true, method: 'xclip' })
    expect(tried).toEqual(['wl-copy:hello', 'xclip:hello'])

    const mac = await copyToClipboard('x', { platform: 'darwin', run: async () => true })
    expect(mac.method).toBe('pbcopy')

    const fallback = await copyToClipboard('héllo', { platform: 'linux', run: async () => false })
    expect(fallback.copied).toBe(false)
    expect(fallback.method).toBe('osc52')
    expect(fallback.osc52).toBe(osc52('héllo'))
    expect(fallback.osc52).toBe(`\u001b]52;c;${Buffer.from('héllo').toString('base64')}\u0007`)
  })
})
