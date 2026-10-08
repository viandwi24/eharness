import { afterEach, describe, expect, test } from 'bun:test'
import { Box } from 'ink'
import { render } from 'ink-testing-library'
import type { ApprovalAnswer, ApprovalBroker, ApprovalRequest } from '../src/contracts.ts'
import { TOOL } from '../src/contracts.ts'
import { DiffView } from '../src/ui/DiffView.tsx'
import { Footer, modeIndicator, ShortcutsPanel, shortModel } from '../src/ui/Footer.tsx'
import { UserMessage } from '../src/ui/MessageView.tsx'
import { Markdown, parseInline, parseMarkdown } from '../src/ui/markdown.tsx'
import { dialogQuestion, optionsFor, PermissionPrompt } from '../src/ui/PermissionPrompt.tsx'
import { PromptInput } from '../src/ui/PromptInput.tsx'
import { formatTokens, ThinkingIndicator, VERBS } from '../src/ui/Spinner.tsx'
import { SubagentTree } from '../src/ui/SubagentTree.tsx'
import { TodoList } from '../src/ui/TodoPanel.tsx'
import { ToolCard } from '../src/ui/ToolCard.tsx'
import type { ToolView } from '../src/ui/tool-summary.ts'
import { shortenHome, truncateMiddle, WelcomeBox } from '../src/ui/WelcomeBox.tsx'

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const ANSI = /\u001b\[[0-9;]*m/g
const plain = (frame: string | undefined): string => (frame ?? '').replace(ANSI, '')
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})
function show(node: React.ReactElement): ReturnType<typeof render> & { text(): string } {
  const app = render(node)
  cleanup.push(() => app.unmount())
  return Object.assign(app, { text: () => plain(app.lastFrame()) })
}

const view = (toolName: string, input: unknown, over: Partial<ToolView> = {}): ToolView => ({
  toolName,
  toolCallId: 'c',
  state: 'output-available',
  input,
  output: 'ok',
  ...over,
})
const card = (v: ToolView, expanded = false, context = {}): string =>
  show(<ToolCard view={v} context={context} expanded={expanded} />).text()

describe('WelcomeBox', () => {
  test('title, hints and cwd with the home directory shortened', () => {
    const home = process.env.HOME ?? '/home/x'
    const { text } = show(
      <WelcomeBox
        cwd={`${home}/Projects/app`}
        model="anthropic/claude-sonnet-4.6"
        provider="openrouter"
        thinking="medium"
        version="1.2.3"
      />,
    )
    const out = text()
    expect(out).toContain('✻ Welcome to coder')
    expect(out).toContain('/help for help, /status for your current setup')
    expect(out).toContain('cwd: ~/Projects/app')
    expect(out).toContain('claude-sonnet-4.6')
    expect(out).toContain('╭')
    expect(shortenHome('/a/b', '/a')).toBe('~/b')
    expect(shortenHome('/other', '/a')).toBe('/other')
  })
})

describe('WelcomeBox long paths', () => {
  test('truncateMiddle keeps the head and the tail', () => {
    expect(truncateMiddle('/a/b', 20)).toBe('/a/b')
    expect(truncateMiddle('/private/tmp/claude/x/scratchpad/pty/proj', 35)).toBe(
      '/private/tmp/…/scratchpad/pty/proj',
    )
    expect(
      truncateMiddle('/private/tmp/claude/x/scratchpad/pty/proj', 24).length,
    ).toBeLessThanOrEqual(24)
  })
  test('a long cwd stays on one line and the lines share one indent', () => {
    const long = `/private/tmp/claude-501/${'some-long-session-id/'.repeat(5)}scratchpad/pty/proj`
    const out = show(<WelcomeBox cwd={long} model="m" provider="openrouter" />).text()
    const lines = out.split('\n')
    const cwdLines = lines.filter((l) => l.includes('cwd:') || l.includes('proj'))
    expect(cwdLines.length).toBe(1)
    expect(cwdLines[0]).toContain('…')
    const indent = (needle: string): number => {
      const l = lines.find((x) => x.includes(needle)) ?? ''
      return l.indexOf(needle)
    }
    expect(indent('model:')).toBe(indent('cwd:'))
    expect(indent('/help')).toBe(indent('cwd:'))
  })
})

describe('markdown', () => {
  test('parseInline: bold, italic, code, link', () => {
    expect(parseInline('a **b** *c* `d` [e](http://x)')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' ' },
      { text: 'c', italic: true },
      { text: ' ' },
      { text: 'd', code: true },
      { text: ' ' },
      { text: 'e', url: 'http://x' },
    ])
  })

  test('parseMarkdown: blocks and gaps; an unterminated fence runs to the end', () => {
    const blocks = parseMarkdown('# T\n\npara\nmore\n\n- a\n  - b\n1. c\n```ts\nx\n')
    expect(blocks.map((b) => b.kind)).toEqual([
      'heading',
      'paragraph',
      'item',
      'item',
      'item',
      'code',
    ])
    expect(blocks[1]).toMatchObject({ gap: true, text: 'para\nmore' })
    expect(blocks[3]).toMatchObject({ indent: 1, marker: '•' })
    expect(blocks[4]).toMatchObject({ marker: '1.' })
    expect(blocks[5]).toMatchObject({ lang: 'ts', lines: ['x', ''] })
  })

  test('renders heading, lists, code block with language, link url', () => {
    const { text } = show(
      <Markdown
        text={
          '# Title\n\nSome **bold** and `code` here.\n\n- first item\n- second item\n1. one\n\n```ts\nconst x = 1\n```\n\nSee [docs](https://example.com).'
        }
      />,
    )
    const out = text()
    expect(out).toContain('Title')
    expect(out).toContain('Some bold and code here.')
    expect(out).toContain('• first item')
    expect(out).toContain('1. one')
    expect(out).toContain('ts')
    expect(out).toContain('const x = 1')
    expect(out).toContain('╭')
    expect(out).toContain('docs (https://example.com)')
    expect(out).not.toContain('**')
  })

  test('list items wrap with a hanging indent', () => {
    const long = 'word '.repeat(30).trim()
    const app = render(
      <Box width={40}>
        <Markdown text={`- ${long}`} />
      </Box>,
    )
    cleanup.push(() => app.unmount())
    const lines = plain(app.lastFrame()).split('\n')
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[0]).toStartWith('• word')
    expect(lines[1]).toStartWith('  word')
  })
})

describe('UserMessage', () => {
  test('prompt and shell forms', () => {
    expect(show(<UserMessage text="hello there" />).text()).toContain('> hello there')
    expect(show(<UserMessage text="!ls -la" />).text()).toContain('! ls -la')
  })
})

describe('ToolCard summaries', () => {
  test('Read', () => {
    const out = card(view(TOOL.read, { path: '/src/app.ts' }, { output: 'a\nb\nc' }))
    expect(out).toContain('⏺ Read(src/app.ts)')
    expect(out).toContain('⎿  Read 3 lines')
  })

  test('Update with a numbered diff and counts', () => {
    const out = card(
      view(TOOL.edit, { path: '/src/app.ts', old_string: 'a\nb\nc\n', new_string: 'a\nB\nC\nc\n' }),
    )
    expect(out).toContain('⏺ Update(src/app.ts)')
    expect(out).toContain('Updated src/app.ts with 2 additions and 1 removal')
    expect(out).toMatch(/\d+ -\s+b/)
    expect(out).toMatch(/\d+ \+\s+B/)
  })

  test('long diffs truncate with +N lines (ctrl+o to expand), expanded shows all', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const input = { path: '/big.ts', old_string: '', new_string: `${lines.join('\n')}\n` }
    const collapsed = card(view(TOOL.edit, input))
    expect(collapsed).toMatch(/… \+\d+ lines \(ctrl\+o to expand\)/)
    expect(collapsed).not.toContain('line 39')
    expect(card(view(TOOL.edit, input), true)).toContain('line 39')
  })

  test('Write, Delete, Glob, List, Search', () => {
    expect(card(view(TOOL.write, { path: '/n.ts', content: 'a\nb' }))).toContain('⏺ Write(n.ts)')
    expect(card(view(TOOL.delete, { path: '/old.ts' }))).toContain('Deleted old.ts')
    expect(card(view(TOOL.glob, { pattern: '**/*.ts' }, { output: 'a\nb' }))).toContain(
      'Glob(**/*.ts)',
    )
    expect(card(view(TOOL.list, { prefix: '/src' }, { output: 'a\nb\nc' }))).toContain(
      'Found 3 files',
    )
    const search = card(view(TOOL.grep, { pattern: 'foo', path: '/src' }, { output: 'a:1' }))
    expect(search).toContain('Search(pattern: "foo", path: "src")')
    expect(search).toContain('Found 1 match')
  })

  test('Bash: first 4 lines, +N lines, exit and timing', () => {
    const output = `${Array.from({ length: 10 }, (_, i) => `out${i}`).join('\n')}\nExit code 0 · 2.5s`
    const out = card(view(TOOL.bash, { command: 'bun test' }, { output }))
    expect(out).toContain('⏺ Bash(bun test)')
    expect(out).toContain('out0')
    expect(out).toContain('out3')
    expect(out).not.toContain('out4')
    expect(out).toContain('… +6 lines (ctrl+o to expand)')
    expect(out).toContain('exit 0 · 2.5s')
    expect(card(view(TOOL.bash, { command: 'bun test' }, { output }), true)).toContain('out9')
  })

  test('errors and denials', () => {
    expect(card(view(TOOL.read, { path: '/a' }, { output: 'ERROR: not found' }))).toContain(
      '⎿  Error: not found',
    )
    expect(card(view(TOOL.bash, { command: 'rm x' }, { state: 'output-denied' }))).toContain(
      'Denied by user',
    )
    expect(card(view(TOOL.bash, { command: 'x' }, { output: 'Exit code 2 · 0.1s' }))).toContain(
      'exit 2 · 0.1s',
    )
  })

  test('todo checklist', () => {
    const out = card(
      view(TOOL.todo, {
        todos: [
          { content: 'done thing', status: 'completed' },
          { content: 'doing thing', status: 'in_progress', activeForm: 'Doing the thing' },
          { content: 'later thing', status: 'pending' },
        ],
      }),
    )
    expect(out).toContain('⏺ Update Todos')
    expect(out).toContain('☒ done thing')
    expect(out).toContain('◼ Doing the thing')
    expect(out).toContain('☐ later thing')
  })

  test('Task with subagent progress and result, Plan, MCP', () => {
    const progress = {
      status: 'running',
      agent: 'explore',
      description: 'find it',
      sessionId: 's',
      steps: 3,
      lastTool: 'grep',
      text: 'looking around',
    }
    const running = card(
      view(
        TOOL.agent,
        { description: 'find it', subagent_type: 'explore' },
        { output: progress, preliminary: true },
      ),
    )
    expect(running).toContain('⏺ Task(find it) explore')
    expect(running).toContain('↳ grep (3 steps)')
    expect(running).toContain('looking around')
    const done = card(view(TOOL.agent, { description: 'find it' }, { output: 'The answer is 42' }))
    expect(done).toContain('⎿  The answer is 42')
    expect(card(view(TOOL.exitPlan, {}))).toContain('⏺ Plan')
    expect(card(view('github_search', { q: 'bug' }))).toContain('github - search (MCP)(q: "bug")')
  })

  test('SubagentTree final states', () => {
    const base = { agent: 'x', description: 'd', sessionId: 's', steps: 1, text: '' }
    expect(show(<SubagentTree progress={{ ...base, status: 'done' }} />).text()).toContain(
      'Done (1 step)',
    )
    expect(show(<SubagentTree progress={{ ...base, status: 'failed' }} />).text()).toContain(
      'Failed (1 step)',
    )
  })
})

describe('DiffView', () => {
  test('line numbers, signs and hunk gaps', () => {
    const oldText = `${Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n')}\n`
    const newText = oldText.replace('l2\n', 'L2\n').replace('l25\n', 'L25\n')
    const out = show(<DiffView oldText={oldText} newText={newText} maxLines={50} />).text()
    expect(out).toMatch(/3 -\s+l2/)
    expect(out).toMatch(/3 \+\s+L2/)
    expect(out).toContain('⋯')
    expect(out).toContain('L25')
  })
})

describe('TodoList', () => {
  test('marks per status', () => {
    const out = show(
      <TodoList
        todos={[
          { content: 'a', status: 'pending' },
          { content: 'b', status: 'in_progress' },
          { content: 'c', status: 'completed' },
        ]}
      />,
    ).text()
    expect(out).toContain('☐ a')
    expect(out).toContain('◼ b')
    expect(out).toContain('☒ c')
  })
})

function fakeBroker(request: ApprovalRequest): ApprovalBroker & { answers: ApprovalAnswer[] } {
  const answers: ApprovalAnswer[] = []
  return {
    answers,
    ask: () => new Promise(() => {}),
    pending: () => [request],
    answer: (_id, answer) => {
      answers.push(answer)
    },
    question: () => new Promise(() => {}),
    pendingQuestions: () => [],
    answerQuestion: () => {},
    subscribe: () => () => {},
  }
}

describe('PermissionPrompt', () => {
  const bash: ApprovalRequest = {
    id: 'a1',
    toolName: TOOL.bash,
    input: { command: 'bun test' },
    title: 'Bash: bun test',
    detail: 'bun test',
    suggestedRule: 'Bash(bun test *)',
    agent: 'reviewer',
  }

  test('bash dialog with all options', () => {
    const out = show(<PermissionPrompt broker={fakeBroker(bash)} />).text()
    expect(out).toContain('Bash command')
    expect(out).toContain('(from reviewer)')
    expect(out).toContain('bun test')
    expect(out).toContain('Do you want to proceed?')
    expect(out).toContain('❯ 1. Yes')
    expect(out).toContain("2. Yes, and don't ask again for Bash(bun test *)")
    expect(out).toContain('3. Yes, always for this project')
    expect(out).toContain('4. No, and tell coder what to do differently (esc)')
  })

  test('edit dialog: diff preview and file question; options without a rule', () => {
    const edit: ApprovalRequest = {
      id: 'a2',
      toolName: TOOL.edit,
      input: { path: '/src/app.ts' },
      title: 'Edit src/app.ts',
      detail: '--- a\n+++ b\n@@ -1,1 +1,1 @@\n-old line\n+new line',
    }
    const out = show(<PermissionPrompt broker={fakeBroker(edit)} />).text()
    expect(out).toContain('Edit file')
    expect(out).toContain('Do you want to make this edit to src/app.ts?')
    expect(out).toContain('old line')
    expect(out).toContain('new line')
    expect(out).toContain('2. No, and tell coder what to do differently (esc)')
    expect(optionsFor(edit)).toHaveLength(2)
    expect(dialogQuestion({ ...edit, toolName: TOOL.bash })).toBe('Do you want to proceed?')
  })

  test('keys: number answers, esc denies', async () => {
    const broker = fakeBroker(bash)
    const app = show(<PermissionPrompt broker={broker} />)
    app.stdin.write('2')
    await tick()
    app.stdin.write('\x1b')
    await tick(80)
    expect(broker.answers[0]).toEqual({ approved: true, remember: 'session' })
    expect(broker.answers[1]).toEqual({ approved: false })
  })
})

describe('Footer', () => {
  const base = { model: 'anthropic/claude-sonnet-4.6', thinking: 'high' } as const
  test('default mode and right side', () => {
    const out = show(<Footer mode="default" {...base} />).text()
    expect(out).toContain('? for shortcuts')
    expect(out).toContain('claude-sonnet-4.6 · thinking high')
    expect(shortModel('a/b/c')).toBe('c')
  })
  test('each mode indicator', () => {
    expect(show(<Footer mode="acceptEdits" {...base} />).text()).toContain(
      '⏵⏵ accept edits on (shift+tab to cycle)',
    )
    expect(show(<Footer mode="plan" {...base} />).text()).toContain(
      '⏸ plan mode on (shift+tab to cycle)',
    )
    expect(show(<Footer mode="bypassPermissions" {...base} />).text()).toContain(
      '⏵⏵ bypass permissions on',
    )
    expect(modeIndicator('dontAsk').text).toContain("don't ask")
  })
  test('context warning only at 20% or less; hint replaces the mode text', () => {
    expect(show(<Footer mode="default" {...base} contextLeftPct={50} />).text()).not.toContain(
      'auto-compact',
    )
    expect(show(<Footer mode="default" {...base} contextLeftPct={12} />).text()).toContain(
      'Context left until auto-compact: 12%',
    )
    const hinted = show(<Footer mode="plan" {...base} hint="Press Ctrl+C again to exit" />).text()
    expect(hinted).toContain('Press Ctrl+C again to exit')
    expect(hinted).not.toContain('plan mode on')
  })
  test('shortcuts panel', () => {
    const out = show(<ShortcutsPanel />).text()
    for (const s of [
      '! for bash mode',
      '/ for commands',
      '@ for file paths',
      '\\⏎ / ctrl+j for newline',
      'shift+tab to cycle modes',
      'alt+p to switch model',
      'alt+t to change thinking',
      'ctrl+o for transcript',
      'esc to interrupt',
      'ctrl+c to exit',
    ]) {
      expect(out).toContain(s)
    }
  })
})

describe('ThinkingIndicator', () => {
  test('verb, elapsed seconds, tokens and hint', () => {
    const out = show(<ThinkingIndicator startedAt={Date.now() - 12_000} tokens={1234} />).text()
    expect(VERBS.some((v) => out.includes(`${v}…`))).toBe(true)
    expect(out).toContain('(12s · ↓ 1.2k tokens · esc to interrupt)')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(15_000)).toBe('15k')
  })
  test('status replaces the verb', () => {
    const out = show(<ThinkingIndicator startedAt={Date.now()} status="Running bash" />).text()
    expect(out).toContain('Running bash…')
  })
})

describe('PromptInput', () => {
  const props = { running: false, history: [], onSubmit: () => {}, onBusy: () => {} }
  test('Enter inside one input chunk submits (hi\\r)', async () => {
    const sent: string[] = []
    const app = show(<PromptInput {...props} onSubmit={(t) => sent.push(t)} />)
    app.stdin.write('hi\r')
    await tick()
    expect(sent).toEqual(['hi'])
    expect(app.text()).not.toContain('> hi')
  })
  test('LF in a chunk submits; text after the Enter becomes the next draft', async () => {
    const sent: string[] = []
    const app = show(<PromptInput {...props} onSubmit={(t) => sent.push(t)} />)
    app.stdin.write('one\ntwo')
    await tick()
    expect(sent).toEqual(['one'])
    expect(app.text()).toContain('two')
  })
  test('backslash then Enter in one chunk inserts a newline', async () => {
    const sent: string[] = []
    const app = show(<PromptInput {...props} onSubmit={(t) => sent.push(t)} />)
    app.stdin.write('hi\\\r')
    await tick()
    expect(sent).toEqual([])
    app.stdin.write('\r')
    await tick()
    expect(sent).toEqual(['hi\n'.trim()])
  })
  test('bracketed paste keeps newlines as text', async () => {
    const sent: string[] = []
    const app = show(<PromptInput {...props} onSubmit={(t) => sent.push(t)} />)
    app.stdin.write('\u001b[200~a\nb\u001b[201~')
    await tick(60)
    expect(sent).toEqual([])
    app.stdin.write('\r')
    await tick()
    expect(sent).toEqual(['a\nb'])
  })
  test('placeholder, rounded box, prompt prefix', () => {
    const out = show(<PromptInput {...props} />).text()
    expect(out).toContain('Try "explain this codebase"')
    expect(out).toContain('╭')
    expect(out).toContain('> ')
  })
  test('slash completions render below the box with descriptions', async () => {
    const app = show(<PromptInput {...props} />)
    app.stdin.write('/he')
    await tick()
    const lines = app.text().split('\n')
    const boxEnd = lines.findIndex((l) => l.includes('╰'))
    const help = lines.findIndex((l) => l.includes('/help'))
    expect(help).toBeGreaterThan(boxEnd)
  })
  test('shell mode shows ! and the shell hint; ? opens shortcuts when wired', async () => {
    let opened = 0
    const app = show(<PromptInput {...props} onShortcuts={() => opened++} />)
    app.stdin.write('?')
    await tick()
    expect(opened).toBe(1)
    app.stdin.write('!')
    await tick()
    expect(app.text()).toContain('shell mode')
  })
})
