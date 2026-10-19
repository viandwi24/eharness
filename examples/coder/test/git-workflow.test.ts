/** `/commit` and `/pr`: the prompts drive ordinary tools; every git/gh call goes through the permission engine. */
import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import type { ApprovalRequest, CoderController, QuestionRequest } from '../src/contracts.ts'
import { commitPrompt, prPrompt, runSlash } from '../src/ui/slash.ts'
import { gitInit, makeController, tempDir } from './helpers.ts'

const bash = (command: string) => ({ toolName: 'bash', input: { command } })
const ask = (question: string) => ({
  toolName: 'ask_user_question',
  input: {
    questions: [
      {
        question,
        header: 'Confirm',
        options: [{ label: 'Commit' }, { label: 'Cancel' }],
        multiSelect: false,
      },
    ],
  },
})

async function git(root: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim()
}

/** Run `text` as a turn; answer every approval and question with the given callbacks until it ends. */
async function drive(
  controller: CoderController,
  text: string,
  on: {
    approval(request: ApprovalRequest): { approved: boolean }
    question(request: QuestionRequest): string
  },
): Promise<{ approvals: string[]; questions: string[] }> {
  const approvals: string[] = []
  const questions: string[] = []
  let finished = false
  const turn = controller
    .run(text, {
      onRun(run) {
        void (async () => {
          const reader = (run.stream as ReadableStream).getReader()
          while (!(await reader.read()).done) {}
        })()
      },
    })
    .finally(() => {
      finished = true
    })
  const broker = controller.broker
  const deadline = Date.now() + 15_000
  while (!finished) {
    if (Date.now() > deadline) throw new Error('timed out')
    for (const request of broker.pending()) {
      approvals.push(request.title)
      broker.answer(request.id, on.approval(request))
    }
    for (const request of broker.pendingQuestions()) {
      questions.push(request.questions[0]?.question ?? '')
      broker.answerQuestion(request.id, {
        answers: [
          { question: request.questions[0]?.question ?? '', selected: [on.question(request)] },
        ],
      })
    }
    await new Promise((r) => setTimeout(r, 5))
  }
  await turn
  return { approvals, questions }
}

describe('/commit', () => {
  test('the command submits the commit prompt with the optional hint', async () => {
    const submitted: string[] = []
    await runSlash('/commit mention the parser', {
      submit: (p: string) => submitted.push(p),
    } as never)
    expect(submitted).toEqual([commitPrompt('mention the parser')])
    expect(commitPrompt('')).toContain('Never run `git add`')
    expect(commitPrompt('')).not.toContain('The user adds')
  })

  test('confirmed: the model commits only what is staged, through the permission engine', async () => {
    const model = scriptedModel([
      { toolCalls: [bash('git diff --cached --stat')] },
      { toolCalls: [ask('Commit "feat(app): add b"?')] },
      { toolCalls: [bash("git commit -m 'feat(app): add b'")] },
      { text: 'Committed.' },
    ])
    const { controller, root } = await makeController({ files: { 'a.txt': 'a\n' }, model })
    await gitInit(root)
    await writeFile(join(root, 'b.txt'), 'b\n')
    await writeFile(join(root, 'c.txt'), 'c\n')
    await git(root, 'add', 'b.txt')
    const seen = await drive(controller, commitPrompt(''), {
      approval: () => ({ approved: true }),
      question: () => 'Commit',
    })
    expect(seen.questions).toEqual(['Commit "feat(app): add b"?'])
    expect(seen.approvals.some((t) => t.includes('git commit'))).toBe(true)
    expect(await git(root, 'log', '-1', '--format=%s')).toBe('feat(app): add b')
    expect(await git(root, 'show', '--stat', '--format=', 'HEAD')).toContain('b.txt')
    // c.txt was never staged
    expect(await git(root, 'status', '--short')).toBe('?? c.txt')
  })

  test('a denied git commit leaves the repository untouched', async () => {
    const model = scriptedModel([
      { toolCalls: [bash("git commit -m 'feat: x'")] },
      { text: 'Understood, not committing.' },
    ])
    const { controller, root } = await makeController({ files: { 'a.txt': 'a\n' }, model })
    await gitInit(root)
    await writeFile(join(root, 'b.txt'), 'b\n')
    await git(root, 'add', 'b.txt')
    await drive(controller, commitPrompt(''), {
      approval: () => ({ approved: false }),
      question: () => 'Cancel',
    })
    expect(await git(root, 'rev-list', '--count', 'HEAD')).toBe('1')
    expect(await git(root, 'diff', '--cached', '--name-only')).toBe('b.txt')
  })
})

describe('/pr', () => {
  const oldPath = process.env.PATH
  afterEach(() => {
    process.env.PATH = oldPath
  })

  test('the command submits the pr prompt', async () => {
    const submitted: string[] = []
    await runSlash('/pr', { submit: (p: string) => submitted.push(p) } as never)
    expect(submitted).toEqual([prPrompt('')])
    expect(prPrompt('')).toContain('gh pr create')
    expect(prPrompt('')).toContain('is not installed')
  })

  test('gh pr create runs permission-gated, after the question', async () => {
    const bin = await tempDir('coder-gh-')
    const log = join(bin, 'gh.log')
    await mkdir(bin, { recursive: true })
    await writeFile(
      join(bin, 'gh'),
      `#!/bin/sh\necho "$@" >> '${log}'\n[ "$1" = "pr" ] && echo https://example.test/pr/1\nexit 0\n`,
    )
    await chmod(join(bin, 'gh'), 0o755)
    process.env.PATH = `${bin}${delimiter}${oldPath ?? ''}`
    const model = scriptedModel([
      { toolCalls: [bash('gh --version')] },
      { toolCalls: [ask('Create the pull request?')] },
      { toolCalls: [bash("gh pr create --base main --title 'feat: b' --body 'Adds b'")] },
      { text: 'Opened https://example.test/pr/1' },
    ])
    const { controller, root } = await makeController({ files: { 'a.txt': 'a\n' }, model })
    await gitInit(root)
    const seen = await drive(controller, prPrompt(''), {
      approval: () => ({ approved: true }),
      question: () => 'Commit',
    })
    expect(seen.questions).toEqual(['Create the pull request?'])
    expect(seen.approvals.some((t) => t.includes('gh pr create'))).toBe(true)
    expect(await readFile(log, 'utf8')).toContain('pr create --base main --title feat: b')
  })

  test('a denied gh pr create does not run gh', async () => {
    const bin = await tempDir('coder-gh-')
    const log = join(bin, 'gh.log')
    await writeFile(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> '${log}'\n`)
    await chmod(join(bin, 'gh'), 0o755)
    process.env.PATH = `${bin}${delimiter}${oldPath ?? ''}`
    const model = scriptedModel([
      { toolCalls: [bash("gh pr create --title 'x' --body 'y'")] },
      { text: 'ok' },
    ])
    const { controller, root } = await makeController({ files: { 'a.txt': 'a\n' }, model })
    await gitInit(root)
    await drive(controller, prPrompt(''), {
      approval: () => ({ approved: false }),
      question: () => 'Cancel',
    })
    expect(await readFile(log, 'utf8').catch(() => '')).toBe('')
  })
})
