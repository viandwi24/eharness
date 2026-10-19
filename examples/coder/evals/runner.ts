/**
 * The eval runner: runs the coder headless on each task of a suite and checks the result.
 *
 * A task is a directory under `evals/tasks/<id>/`:
 *
 *   task.json    { id, title, prompt, check, timeoutSec, maxCostUsd, setup?, settings? }
 *   fixture/     the project the agent starts from (copied to a temp dir; never edited in place)
 *   check/       optional hidden files, copied into the project as `check/` AFTER the agent ran
 *   script.json  optional recorded transcript: `scriptedModel` steps for `--scripted` runs
 *
 * `check` is a shell command run in the project after the agent finished; exit code 0 passes. It
 * sees `EVAL_TSC` (path of a `tsc` binary). `setup` is an optional shell command run in the copied
 * project before the agent starts (e.g. `git init`). Real-model runs read their key from the
 * environment like the CLI does; the runner never reads, logs or stores it.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const EVALS_DIR: string = import.meta.dir
export const TASKS_DIR: string = join(EVALS_DIR, 'tasks')
const MAIN = resolve(EVALS_DIR, '..', 'src', 'main.tsx')
const TSC = resolve(EVALS_DIR, '..', '..', '..', 'node_modules', '.bin', 'tsc')
const TAIL = 4_000

/** One task as written in `task.json`. */
export interface EvalTask {
  id: string
  title: string
  prompt: string
  check: string
  /** Wall-time cap of the agent run; the check has its own 60 s. */
  timeoutSec: number
  /** The run fails when the reported cost exceeds this (also passed as `--max-cost`). */
  maxCostUsd: number
  setup?: string
  /** User settings of the run (`<CODER_HOME>/settings.json`), e.g. `{ "code": { "enabled": true } }`. */
  settings?: Record<string, unknown>
  /** Absolute task directory (filled by {@link loadTasks}). */
  dir: string
}

/** What one task produced. */
export interface TaskResult {
  id: string
  title: string
  passed: boolean
  /** Why it failed: `check-failed`, `timeout`, `agent-error`, `over-budget`, `bad-output`. */
  reason?: string
  /** Stop reason of the turn (`complete`, `step-cap`, …) when the agent printed a summary. */
  stop?: string
  costUsd: number | null
  toolCalls: number
  inputTokens: number
  outputTokens: number
  wallMs: number
  /** Last lines of the check output when it failed. */
  checkTail?: string
}

/** Options of {@link runSuite}. */
export interface SuiteOptions {
  /** Model id for the real model; ignored with `scripted`. */
  model?: string
  provider?: string
  /** Replay each task's `script.json` offline instead of calling a model. */
  scripted?: boolean
  /** Only these task ids. */
  only?: string[]
  /** Run in parallel (default 1). */
  concurrency?: number
  /** Turn on the OS sandbox of the coder (`sandbox.enabled`) when the platform has one. */
  sandbox?: boolean
  tasksDir?: string
  /** Results are written under `<out>/<timestamp>/`. Omit to write nothing. */
  out?: string
  onResult?: (result: TaskResult) => void
}

/** The summary of a whole run. */
export interface SuiteReport {
  startedAt: string
  mode: 'scripted' | 'model'
  model?: string
  tasks: number
  passed: number
  passRate: number
  totalCostUsd: number | null
  totalToolCalls: number
  totalWallMs: number
  results: TaskResult[]
}

/** Read every task of a suite directory, sorted by id. */
export async function loadTasks(tasksDir: string = TASKS_DIR): Promise<EvalTask[]> {
  const tasks: EvalTask[] = []
  for (const name of (await readdir(tasksDir)).sort()) {
    const dir = join(tasksDir, name)
    if (!(await stat(dir)).isDirectory()) continue
    const raw = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8')) as Partial<EvalTask>
    for (const key of ['id', 'title', 'prompt', 'check'] as const) {
      if (typeof raw[key] !== 'string' || raw[key] === '') {
        throw new Error(`task ${name}: "${key}" must be a non-empty string`)
      }
    }
    if (raw.id !== name) {
      throw new Error(`task ${name}: id "${raw.id}" must equal the directory name`)
    }
    await stat(join(dir, 'fixture'))
    tasks.push({
      id: name,
      title: raw.title as string,
      prompt: raw.prompt as string,
      check: raw.check as string,
      timeoutSec: raw.timeoutSec ?? 120,
      maxCostUsd: raw.maxCostUsd ?? 0.5,
      ...(raw.setup !== undefined ? { setup: raw.setup } : {}),
      ...(raw.settings !== undefined ? { settings: raw.settings } : {}),
      dir,
    })
  }
  return tasks
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  )

const tail = (text: string): string => (text.length > TAIL ? `…${text.slice(-TAIL)}` : text)

interface Spawned {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

async function spawnCapture(
  cmd: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<Spawned> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, opts.timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { code: timedOut ? null : code, stdout, stderr, timedOut }
}

/** Run one task in a fresh temp copy of its fixture. */
export async function runTask(
  task: EvalTask,
  opts: SuiteOptions = {},
  logDir?: string,
): Promise<TaskResult> {
  const root = await mkdtemp(join(tmpdir(), `coder-eval-${task.id}-`))
  const ws = join(root, 'ws')
  const home = join(root, 'home')
  const started = Date.now()
  const base: TaskResult = {
    id: task.id,
    title: task.title,
    passed: false,
    costUsd: null,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    wallMs: 0,
  }
  const log = async (name: string, text: string): Promise<void> => {
    if (logDir === undefined) return
    await mkdir(logDir, { recursive: true })
    await writeFile(join(logDir, `${task.id}.${name}.log`), text)
  }
  try {
    await cp(join(task.dir, 'fixture'), ws, { recursive: true })
    await mkdir(home, { recursive: true })
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CODER_HOME: home,
      EVAL_TSC: process.env.EVAL_TSC ?? TSC,
    }
    delete env.CODER_SCRIPTED_MODEL
    delete env.CODER_MODEL
    const settings: Record<string, unknown> = {
      ...task.settings,
      ...(opts.sandbox === true ? { sandbox: { enabled: true } } : {}),
    }
    if (Object.keys(settings).length > 0) {
      await writeFile(join(home, 'settings.json'), JSON.stringify(settings))
    }
    if (task.setup !== undefined) {
      const setup = await spawnCapture(['sh', '-c', task.setup], {
        cwd: ws,
        env,
        timeoutMs: 60_000,
      })
      if (setup.code !== 0) {
        await log('setup', setup.stdout + setup.stderr)
        return { ...base, reason: 'setup-failed', wallMs: Date.now() - started }
      }
    }

    const args = [
      process.execPath,
      MAIN,
      '-p',
      task.prompt,
      '--output-format',
      'json',
      // unattended: nothing may stop to ask; the project is a throwaway copy
      '--permission-mode',
      'bypassPermissions',
      '--trust-project',
      '--max-cost',
      String(task.maxCostUsd),
      '--max-time',
      String(Math.max(1, Math.ceil(task.timeoutSec / 60))),
      '--cwd',
      ws,
    ]
    if (opts.scripted === true) {
      const script = join(task.dir, 'script.json')
      if (!(await exists(script))) {
        return { ...base, reason: 'no-script', wallMs: Date.now() - started }
      }
      env.CODER_SCRIPTED_MODEL = script
      env.CODER_OFFLINE = '1'
    } else {
      if (opts.model !== undefined) args.push('--model', opts.model)
      if (opts.provider !== undefined) args.push('--provider', opts.provider)
    }

    const run = await spawnCapture(args, { cwd: ws, env, timeoutMs: task.timeoutSec * 1000 })
    await log('stdout', run.stdout)
    await log('stderr', run.stderr)
    const toolCalls = (run.stderr.match(/^\[tool\] /gm) ?? []).length
    let summary:
      | {
          stop?: string
          costUsd?: number | null
          usage?: { inputTokens?: number; outputTokens?: number }
        }
      | undefined
    try {
      summary = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '')
    } catch {
      summary = undefined
    }
    const measured: TaskResult = {
      ...base,
      toolCalls,
      costUsd: summary?.costUsd ?? null,
      inputTokens: summary?.usage?.inputTokens ?? 0,
      outputTokens: summary?.usage?.outputTokens ?? 0,
      ...(summary?.stop !== undefined ? { stop: summary.stop } : {}),
    }
    const finish = (extra: Partial<TaskResult>): TaskResult => ({
      ...measured,
      ...extra,
      wallMs: Date.now() - started,
    })
    if (run.timedOut) return finish({ reason: 'timeout' })
    if (summary === undefined) return finish({ reason: 'bad-output', checkTail: tail(run.stderr) })
    if (task.maxCostUsd > 0 && (summary.costUsd ?? 0) > task.maxCostUsd) {
      return finish({ reason: 'over-budget' })
    }
    // a failed turn can still have fixed the project: the check decides, the reason is kept
    const checkDir = join(task.dir, 'check')
    if (await exists(checkDir)) await cp(checkDir, join(ws, 'check'), { recursive: true })
    const check = await spawnCapture(['sh', '-c', task.check], {
      cwd: ws,
      env,
      timeoutMs: 60_000,
    })
    await log('check', check.stdout + check.stderr)
    if (check.code === 0) return finish({ passed: true })
    return finish({
      reason:
        summary.stop !== undefined && summary.stop !== 'complete' ? 'agent-error' : 'check-failed',
      checkTail: tail(check.stdout + check.stderr),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/**
 * Check the suite itself: every task's `check` must FAIL on the pristine fixture (plus its hidden
 * check files), otherwise the task proves nothing. Returns the ids that already pass.
 */
export async function validateSuite(tasksDir: string = TASKS_DIR): Promise<string[]> {
  const bad: string[] = []
  for (const task of await loadTasks(tasksDir)) {
    const root = await mkdtemp(join(tmpdir(), `coder-eval-validate-${task.id}-`))
    try {
      await cp(join(task.dir, 'fixture'), root, { recursive: true })
      if (await exists(join(task.dir, 'check'))) {
        await cp(join(task.dir, 'check'), join(root, 'check'), { recursive: true })
      }
      const env = {
        ...(process.env as Record<string, string>),
        EVAL_TSC: process.env.EVAL_TSC ?? TSC,
      }
      if (task.setup !== undefined) {
        await spawnCapture(['sh', '-c', task.setup], { cwd: root, env, timeoutMs: 60_000 })
      }
      const check = await spawnCapture(['sh', '-c', task.check], {
        cwd: root,
        env,
        timeoutMs: 60_000,
      })
      if (check.code === 0) bad.push(task.id)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  return bad
}

/** Run the tasks of a suite and summarize. */
export async function runSuite(opts: SuiteOptions = {}): Promise<SuiteReport> {
  const startedAt = new Date().toISOString()
  const all = await loadTasks(opts.tasksDir)
  const tasks = opts.only?.length ? all.filter((t) => opts.only?.includes(t.id)) : all
  const missing = (opts.only ?? []).filter((id) => !all.some((t) => t.id === id))
  if (missing.length > 0) throw new Error(`unknown task ids: ${missing.join(', ')}`)
  const logDir =
    opts.out !== undefined ? join(opts.out, startedAt.replace(/[:.]/g, '-')) : undefined

  const results: TaskResult[] = new Array(tasks.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      const task = tasks[i]
      if (task === undefined) return
      const result = await runTask(task, opts, logDir)
      results[i] = result
      opts.onResult?.(result)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 1) }, worker))

  const costs = results.map((r) => r.costUsd).filter((c): c is number => c !== null)
  const passed = results.filter((r) => r.passed).length
  const report: SuiteReport = {
    startedAt,
    mode: opts.scripted === true ? 'scripted' : 'model',
    ...(opts.scripted !== true && opts.model !== undefined ? { model: opts.model } : {}),
    tasks: results.length,
    passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    totalCostUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
    totalToolCalls: results.reduce((a, r) => a + r.toolCalls, 0),
    totalWallMs: results.reduce((a, r) => a + r.wallMs, 0),
    results,
  }
  if (logDir !== undefined) {
    await mkdir(logDir, { recursive: true })
    await writeFile(join(logDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(join(logDir, 'report.md'), renderMarkdown(report))
  }
  return report
}

/** The report as a markdown table plus a summary line. */
export function renderMarkdown(report: SuiteReport): string {
  const cost = (c: number | null): string => (c === null ? 'n/a' : `$${c.toFixed(4)}`)
  const lines = [
    `# Coder eval (${report.mode}${report.model ? `, ${report.model}` : ''})`,
    '',
    `Started ${report.startedAt}. Passed **${report.passed}/${report.tasks}** (${(report.passRate * 100).toFixed(0)}%), cost ${cost(report.totalCostUsd)}, ${report.totalToolCalls} tool calls, ${(report.totalWallMs / 1000).toFixed(1)} s wall.`,
    '',
    '| task | result | tool calls | cost | tokens in/out | wall |',
    '|---|---|---|---|---|---|',
    ...report.results.map(
      (r) =>
        `| ${r.id} | ${r.passed ? 'pass' : `FAIL (${r.reason ?? '?'})`} | ${r.toolCalls} | ${cost(r.costUsd)} | ${r.inputTokens}/${r.outputTokens} | ${(r.wallMs / 1000).toFixed(1)} s |`,
    ),
  ]
  const failed = report.results.filter((r) => !r.passed && r.checkTail)
  for (const r of failed)
    lines.push('', `## ${r.id} output`, '', '```', r.checkTail as string, '```')
  return `${lines.join('\n')}\n`
}
