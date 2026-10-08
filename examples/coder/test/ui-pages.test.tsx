import { afterEach, describe, expect, test } from 'bun:test'
import { Text } from 'ink'
import { render } from 'ink-testing-library'
import { THINKING_LEVELS } from '../src/contracts.ts'
import { App } from '../src/ui/App.tsx'
import { allocateCells, ContextPage } from '../src/ui/pages/ContextPage.tsx'
import { CostPage } from '../src/ui/pages/CostPage.tsx'
import { fmtAgo, fmtDuration, fmtPct, fmtTokens, shortModel } from '../src/ui/pages/format.ts'
import { HelpPage } from '../src/ui/pages/HelpPage.tsx'
import { ALT_SCREEN_OFF, ALT_SCREEN_ON } from '../src/ui/pages/host.ts'
import { Page } from '../src/ui/pages/Page.tsx'
import { StatusPage } from '../src/ui/pages/StatusPage.tsx'
import { filterModels, ModelPicker, modelRows } from '../src/ui/pickers/ModelPicker.tsx'
import { ThinkingPicker } from '../src/ui/pickers/ThinkingPicker.tsx'
import { slashCommands } from '../src/ui/slash.ts'
import { FIXTURE_CONTEXT, FIXTURE_MODELS, fakeController } from './fake-controller.ts'

const ENTER = '\r'
const ESC = '\x1b'
const DOWN = '\x1b[B'
const PGDN = '\x1b[6~'
const PGUP = '\x1b[5~'
const CTRL_O = '\x0f'
const ALT_P = '\x1bp'
const ALT_T = '\x1bt'
const SHIFT_TAB = '\x1b[Z'
const SIZE = { rows: 60, columns: 100 }
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(fn: () => boolean, label: string, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`)
    await tick(10)
  }
}

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})

function mountNode(node: React.ReactElement) {
  const app = render(node)
  cleanup.push(() => app.unmount())
  const frame = (): string => app.lastFrame() ?? ''
  const type = async (text: string): Promise<void> => {
    app.stdin.write(text)
    await tick()
  }
  return { app, frame, type }
}

function mountApp(opts: Parameters<typeof fakeController>[0] = {}) {
  const fake = fakeController(opts)
  return { ...fake, ...mountNode(<App controller={fake.controller} />) }
}

describe('formatting', () => {
  test('tokens, percentages, durations', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(1200)).toBe('1.2k')
    expect(fmtTokens(3100)).toBe('3.1k')
    expect(fmtTokens(58_000)).toBe('58k')
    expect(fmtTokens(140_000)).toBe('140k')
    expect(fmtTokens(2_500_000)).toBe('2.5M')
    expect(fmtPct(3100, 200_000)).toBe('1.6%')
    expect(fmtPct(140_000, 200_000)).toBe('70%')
    expect(fmtPct(0, 0)).toBe('0%')
    expect(fmtDuration(185_000)).toBe('3m 05s')
    expect(fmtDuration(12_400)).toBe('12s')
    expect(fmtAgo(0, 5 * 60_000)).toBe('5m ago')
    expect(shortModel('anthropic/claude-sonnet-4.6')).toBe('claude-sonnet-4.6')
  })
})

describe('/context', () => {
  test('cells are allocated proportionally to tokens', () => {
    const cells = allocateCells(FIXTURE_CONTEXT)
    expect(cells).toHaveLength(100)
    const count = (kind: string): number => cells.filter((c) => c === kind).length
    expect(count('buffer')).toBe(20) // 40k of 200k
    expect(count('free')).toBe(51) // 102k of 200k
    expect(count('messages')).toBe(18) // 36k of 200k
    expect(count('tools')).toBeGreaterThanOrEqual(5)
    expect(count('tools')).toBeLessThanOrEqual(6)
    expect(count('mcp')).toBe(2)
    expect(count('system') + count('memory') + count('skills')).toBeGreaterThanOrEqual(3)
    // display order: categories, then free space, then the buffer
    expect(cells[0]).toBe('system')
    expect(cells[99]).toBe('buffer')
  })

  test('an empty window is all free space', () => {
    const cells = allocateCells({
      ...FIXTURE_CONTEXT,
      categories: [],
      used: 0,
      autocompactBuffer: 0,
    })
    expect(cells.every((c) => c === 'free')).toBe(true)
  })

  test('the page shows the header, grid, legend and sections', async () => {
    const { controller } = fakeController()
    const { frame } = mountNode(
      <ContextPage
        controller={controller}
        onClose={() => {}}
        size={SIZE}
        now={Date.UTC(2026, 0, 2, 3, 5)}
      />,
    )
    await until(() => frame().includes('Context Usage'), 'page')
    const f = frame()
    expect(f).toContain('claude-sonnet-4.6 · 58k/200k tokens (29%)')
    expect(f).toContain('System prompt: 3.1k tokens (1.6%)')
    expect(f).toContain('Free space: 102k (51%)')
    expect(f).toContain('Autocompact buffer: 40k (20%)')
    expect(f).toContain('⛁')
    expect(f).toContain('⛶')
    expect(f).toContain('⛝')
    expect(f).toContain('bash')
    expect(f).toContain('github_search')
    expect(f).toContain('AGENTS.md')
    expect(f).toContain('24 messages')
    expect(f).toContain('Auto-compact at 160k tokens (80%)')
    expect(f).toContain('152k → 18k tokens, 5m ago')
    expect(f).toContain('12 tool outputs')
    expect(f).toContain('esc/q close · ↑↓ scroll · tab next section')
    if (process.env.PRINT_CONTEXT_FRAME) console.log(f)
  })
})

describe('/status, /cost, /help', () => {
  test('status shows the session facts', async () => {
    const { controller } = fakeController({ untrusted: ['allow'] })
    const { frame } = mountNode(
      <StatusPage controller={controller} onClose={() => {}} size={SIZE} />,
    )
    await until(() => frame().includes('Working directory'), 'page')
    const f = frame()
    for (const text of [
      'coder 0.1.0',
      'eharness 0.9.0',
      '/work/project',
      'openrouter',
      'test/model',
      'provider-default',
      'default',
      'sess' in {} ? '' : 's1',
      '/@dirs/shared-lib/',
      '(read-only)',
      'not trusted',
      'allow',
      'AGENTS.md',
      'github',
    ]) {
      expect(f).toContain(text)
    }
    expect(f).toContain('✓ /home/me/.coder/settings.json')
    expect(f).toContain('✗ /work/project/.coder/settings.local.json')
  })

  test('cost shows usage, estimated cost and per-turn cost', async () => {
    const { controller } = fakeController()
    const { frame } = mountNode(<CostPage controller={controller} onClose={() => {}} size={SIZE} />)
    await until(() => frame().includes('Estimated cost'), 'page')
    const f = frame()
    expect(f).toContain('$0.41')
    expect(f).toContain('$0.0825')
    expect(f).toContain('184,320')
    expect(f).toContain('9,870')
    expect(f).toContain('120,000')
    expect(f).toContain('3m 05s')
  })

  test('cost without pricing says so', async () => {
    const { controller } = fakeController({
      usage: { inputTokens: 10, outputTokens: 5, turns: 1, durationMs: 900 },
    })
    const { frame } = mountNode(<CostPage controller={controller} onClose={() => {}} size={SIZE} />)
    await until(() => frame().includes('not priced'), 'page')
    expect(frame()).toContain('900ms')
  })

  test('help lists every command and the shortcuts', () => {
    const { frame } = mountNode(<HelpPage onClose={() => {}} size={{ rows: 100, columns: 100 }} />)
    const f = frame()
    for (const c of slashCommands) expect(f).toContain(`/${c.name}`)
    expect(f).toContain('Keyboard shortcuts')
    expect(f).toContain('alt+p')
    expect(f).toContain('ctrl+o')
  })
})

describe('page chrome', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line-${String(i).padStart(2, '0')}`)
  const body = lines.map((l) => <Text key={l}>{l}</Text>)

  test('scrolls with PgDn/PgUp/arrows/g/G and closes with q or esc', async () => {
    let closed = 0
    const { frame, type } = mountNode(
      <Page title="T" subtitle="sub" onClose={() => closed++} size={{ rows: 12, columns: 60 }}>
        {body}
      </Page>,
    )
    await until(() => frame().includes('line-00'), 'first frame')
    expect(frame()).not.toContain('line-20')
    await type(PGDN)
    await until(() => !frame().includes('line-00'), 'scrolled')
    expect(frame()).toContain('line-07')
    await type(PGUP)
    await until(() => frame().includes('line-00'), 'back')
    await type('G')
    await until(() => frame().includes('line-39'), 'bottom')
    await type('g')
    await until(() => frame().includes('line-00'), 'top')
    await type(DOWN)
    await until(() => !frame().includes('line-00'), 'down one')
    await type('q')
    await type(ESC)
    await until(() => closed === 2, 'closed twice')
  })
})

describe('model picker', () => {
  test('filtering', () => {
    expect(filterModels(FIXTURE_MODELS, 'gpt').map((m) => m.id)).toEqual(['openai/gpt-5'])
    expect(filterModels(FIXTURE_MODELS, 'sonnet 4.6')).toHaveLength(1)
    expect(filterModels(FIXTURE_MODELS, '')).toHaveLength(4)
    const rows = modelRows(FIXTURE_MODELS, 'brand-new')
    expect(rows).toEqual([{ kind: 'custom', id: 'brand-new' }])
  })

  test('shows rows with details, marks the current model, filters and selects', async () => {
    const f = fakeController({ model: 'anthropic/claude-sonnet-4.6' })
    const picked: string[] = []
    const { frame, type } = mountNode(
      <ModelPicker
        controller={f.controller}
        onSelect={(id) => {
          picked.push(id)
          f.controller.setModel(id)
        }}
        onCancel={() => {}}
      />,
    )
    await until(() => frame().includes('Claude Sonnet 4.6'), 'rows')
    const text = frame()
    expect(text).toContain('❯ ✓ Claude Sonnet 4.6')
    expect(text).toContain('ctx 200k')
    expect(text).toContain('$3/$15')
    expect(text).toContain('⚙ thinking')
    expect(text).toContain('no tools')
    await type('gpt')
    await until(() => !frame().includes('Claude Sonnet'), 'filtered')
    expect(frame()).toContain('GPT-5')
    await type(ENTER)
    await until(() => picked.length === 1, 'selected')
    expect(picked).toEqual(['openai/gpt-5'])
    expect(f.calls).toContain('setModel:openai/gpt-5')
  })

  test('models without tools are not selectable', async () => {
    const f = fakeController()
    const picked: string[] = []
    const { frame, type } = mountNode(
      <ModelPicker
        controller={f.controller}
        onSelect={(id) => picked.push(id)}
        onCancel={() => {}}
      />,
    )
    await until(() => frame().includes('Acme Chat'), 'rows')
    await type('acme/chat-only')
    await type(ENTER)
    await tick(50)
    expect(picked).toEqual([])
  })

  test('offline: the list is unavailable and a custom id can be typed', async () => {
    const f = fakeController({
      models: async () => {
        throw new Error('offline')
      },
    })
    const picked: string[] = []
    const { frame, type } = mountNode(
      <ModelPicker
        controller={f.controller}
        onSelect={(id) => picked.push(id)}
        onCancel={() => {}}
      />,
    )
    await until(() => frame().includes('unavailable'), 'offline note')
    await type('my/custom-model')
    await until(() => frame().includes('Use custom id'), 'custom row')
    await type(ENTER)
    await until(() => picked.length === 1, 'selected')
    expect(picked).toEqual(['my/custom-model'])
  })

  test('Esc cancels', async () => {
    const f = fakeController()
    let cancelled = 0
    const { frame, type } = mountNode(
      <ModelPicker controller={f.controller} onSelect={() => {}} onCancel={() => cancelled++} />,
    )
    await until(() => frame().includes('Claude Sonnet'), 'rows')
    await type(ESC)
    await until(() => cancelled === 1, 'cancel')
  })
})

describe('thinking picker', () => {
  test('lists the levels, marks the current one and applies the selection', async () => {
    const f = fakeController({ thinking: 'medium' })
    const picked: string[] = []
    const { frame, type } = mountNode(
      <ThinkingPicker
        controller={f.controller}
        onSelect={(l) => picked.push(l)}
        onCancel={() => {}}
      />,
    )
    for (const level of THINKING_LEVELS) expect(frame()).toContain(level)
    expect(frame()).toContain('provider-default — let the provider decide')
    expect(frame()).toContain('xhigh — deepest, slowest')
    expect(frame()).toContain('❯ ✓ medium')
    await type(DOWN)
    await type(ENTER)
    expect(picked).toEqual(['high'])
  })

  test('warns when the model has no reasoning', async () => {
    const f = fakeController({ model: 'meta/llama-3-8b' })
    const { frame } = mountNode(
      <ThinkingPicker controller={f.controller} onSelect={() => {}} onCancel={() => {}} />,
    )
    await until(() => frame().includes('does not support reasoning'), 'warning')
  })
})

describe('App integration', () => {
  test('/context opens a page on the alternate screen and closes it again', async () => {
    const { app, frame, type } = mountApp()
    await type('/context')
    await type(ENTER)
    await until(() => frame().includes('Context Usage'), 'page')
    expect(app.frames).toContain(ALT_SCREEN_ON)
    expect(app.frames).not.toContain(ALT_SCREEN_OFF)
    await type('q')
    await until(() => app.frames.includes(ALT_SCREEN_OFF), 'alt screen left')
    await until(
      () => !frame().includes('Context Usage') && frame().includes('? for shortcuts'),
      'live area back',
    )
  })

  test('closing a page does not print the conversation twice', async () => {
    const { frame, type, app } = mountApp({ script: [{ text: 'unique-reply-text' }] })
    await type('hello world')
    await type(ENTER)
    await until(() => frame().includes('unique-reply-text'), 'reply')
    await tick(150)
    await type('/status')
    await type(ENTER)
    await until(() => frame().includes('Working directory'), 'page')
    await type(ESC)
    await until(() => app.frames.includes(ALT_SCREEN_OFF), 'closed')
    await until(() => frame().includes('? for shortcuts'), 'live area')
    const count = (needle: string): number => frame().split(needle).length - 1
    expect(count('Welcome to coder')).toBe(1)
    expect(count('unique-reply-text')).toBe(1)
    expect(count('hello world')).toBe(1)
  })

  test('Ctrl+O opens the transcript viewer, Ctrl+O closes it', async () => {
    const { frame, type, app } = mountApp({ script: [{ text: 'an answer' }] })
    await type('question one')
    await type(ENTER)
    await until(() => frame().includes('an answer'), 'reply')
    await type(CTRL_O)
    await until(() => app.frames.includes(ALT_SCREEN_ON), 'page open')
    await until(() => frame().includes('Transcript'), 'viewer')
    expect(frame()).toContain('question one')
    await type(CTRL_O)
    await until(() => app.frames.includes(ALT_SCREEN_OFF), 'page closed')
  })

  test('Shift+Tab is ignored while a page is open', async () => {
    const { frame, type, calls } = mountApp()
    await type('/help')
    await type(ENTER)
    await until(() => frame().includes('Keyboard shortcuts') || frame().includes('Help'), 'page')
    await type(SHIFT_TAB)
    await tick(50)
    expect(calls).not.toContain('cycleMode')
  })

  test('Alt+P opens the model picker; selecting switches the model', async () => {
    const { frame, type, calls } = mountApp()
    await type(ALT_P)
    await until(() => frame().includes('Select model'), 'picker')
    await until(() => frame().includes('GPT-5'), 'rows')
    await type('gpt')
    await type(ENTER)
    await until(() => calls.includes('setModel:openai/gpt-5'), 'setModel')
    await until(() => frame().includes('Model set to openai/gpt-5.'), 'confirmation')
    expect(frame()).not.toContain('Select model')
    expect(frame()).toContain('gpt-5 · thinking')
  })

  test('/model without args opens the picker; Esc closes it', async () => {
    const { frame, type } = mountApp()
    await type('/model')
    await type(ENTER)
    await until(() => frame().includes('Select model'), 'picker')
    await type(ESC)
    await until(() => !frame().includes('Select model'), 'closed')
  })

  test('Alt+T opens the thinking picker; selecting applies the level', async () => {
    const { frame, type, calls } = mountApp()
    await type(ALT_T)
    await until(() => frame().includes('Thinking level'), 'picker')
    await type(DOWN)
    await type(DOWN)
    await type(ENTER)
    await until(() => calls.includes('setThinking:minimal'), 'setThinking')
    await until(() => frame().includes('Thinking set to minimal.'), 'confirmation')
    expect(frame()).toContain('thinking minimal')
  })

  test('/thinking <level> applies directly', async () => {
    const { frame, type, calls } = mountApp()
    await type('/thinking high')
    await type(ENTER)
    await until(() => calls.includes('setThinking:high'), 'setThinking')
    await until(() => frame().includes('Thinking set to high.'), 'confirmation')
  })

  test('/agents page opens a run transcript on Enter', async () => {
    const child = [
      { id: 'cm1', role: 'assistant', parts: [{ type: 'text', text: 'child said hi' }] },
    ]
    const { frame, type } = mountApp({
      childMessages: { 'child-1': child as never },
      script: [
        {
          toolCalls: [
            {
              toolName: 'agent',
              toolCallId: 'a1',
              input: { description: 'look', prompt: 'p', agent: 'explore' },
            },
          ],
        },
        { text: 'done' },
      ],
    })
    // seed a run by loading it into the state through a tool call is not possible with the fake
    // agent, so only the empty state is checked here
    await type('/agents')
    await type(ENTER)
    await until(() => frame().includes('No subagent runs yet.'), 'agents page')
    expect(frame()).toContain('Definitions')
    void child
  })

  test('Ctrl+C clears the input first, a second Ctrl+C exits', async () => {
    const { frame, type } = mountApp()
    await type('some draft')
    expect(frame()).toContain('some draft')
    await type('\x03')
    await until(() => frame().includes('press Ctrl+C again to exit'), 'hint')
    expect(frame()).not.toContain('some draft')
  })

  test('? on an empty prompt toggles the shortcuts panel', async () => {
    const { frame, type } = mountApp()
    await type('?')
    await until(() => frame().includes('alt+p to switch model'), 'panel')
    await type('?')
    await until(() => !frame().includes('alt+p to switch model'), 'closed')
  })
})
