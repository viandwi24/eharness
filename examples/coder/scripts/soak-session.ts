/**
 * Long-session soak, offline: one coder session driven through many turns by a scripted model that
 * produces large tool outputs, so summarization (`summarizeAt` 0.8), pruning and eviction (30 000
 * characters) trigger again and again. The process is killed mid-turn three times (twice while a
 * tool runs, once while the model streams) and resumed with `--continue`; `/retry` and `/rewind`
 * are used once each. Invariants are asserted on what is stored.
 *
 *   bun scripts/soak-session.ts                 36 turns (about a minute)
 *   bun scripts/soak-session.ts --turns 60      longer
 *   bun scripts/soak-session.ts --window 40000  smaller context window (default 60000)
 *
 * Exit code 0 when every invariant held. The same code runs in `test/soak.test.ts` (shorter).
 * A real two-hour run with a real model is a manual acceptance item (docs/plans/P30-coder-example.md).
 *
 * The script re-runs itself as `--worker <json>`: the worker is the "coder process" that gets
 * killed. It uses the same controller the CLI builds (`createController`), not a lookalike.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertStoredSessionInvariants,
  type ScriptedCallOptions,
  type ScriptedStep,
  scriptedModel,
} from 'eharness/testing'
import { loadConfig } from '../src/app/config.ts'
import { createController } from '../src/app/controller.ts'
import { createStorage } from '../src/app/sessions.ts'
import { createDenyingBroker } from '../src/permissions/index.ts'

type KillMode = 'tool' | 'stream'

/** What the parent tells one worker (one coder process) to do. */
interface WorkerPlan {
  dir: string
  home: string
  /** Where the scripted model keeps its cross-process state and call log. */
  stats: string
  continueLast: boolean
  /** Run `/retry` first (regenerates the interrupted reply). */
  retryFirst: boolean
  /** Turns to run, in order. */
  turns: number[]
  /** Kill target: the model announces it and the parent kills the process. */
  kill?: { turn: number; mode: KillMode }
  /** After this turn, rewind to the user message of `to` (conversation and files). */
  rewind?: { after: number; to: number }
}

/** Soak options. */
export interface SoakOptions {
  turns?: number
  /** Context window in tokens (default 60 000). */
  window?: number
  log?: (line: string) => void
}

/** The result of a soak run. */
export interface SoakReport {
  turns: number
  window: number
  segments: Array<{ name: string; wallMs: number; killed: boolean }>
  wallMs: number
  modelCalls: number
  summarizerCalls: number
  compactionMarkers: number
  interruptedToolResults: number
  evictedOutputs: number
  peakPromptTokens: number
  /** `peakPromptTokens` over the window. */
  peakFraction: number
  usageInputTokens: number
  messages: number
  finalSessionId: string
  /** Invariant violations; empty means the soak passed. */
  problems: string[]
}

const PROMPT_FILLER = 'Please keep going with the maintenance work on the repository. '.repeat(8)

// ─── the scripted model (runs inside the worker) ───

interface ModelState {
  turn: number
  step: number
  fired: number[]
  /** Monotonic tool call id source (the scripted default restarts at 0 in every process). */
  seq: number
}

const readState = (file: string): ModelState =>
  existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as ModelState)
    : { turn: 0, step: 0, fired: [], seq: 0 }

function promptText(prompt: unknown): string {
  return JSON.stringify(prompt)
}

/** The step plan of turn `k`: 4 or 5 tool steps (writes, medium output, huge output), then text. */
function stepsOf(k: number): number {
  return 4 + (k % 2)
}

function soakModel(plan: WorkerPlan) {
  const stateFile = join(plan.stats, 'model-state.json')
  const callLog = join(plan.stats, 'calls.jsonl')
  const step = (call: ScriptedCallOptions): ScriptedStep => {
    const text = promptText(call.prompt)
    const tokens = Math.ceil(text.length / 4)
    const summarizer = (call.tools ?? []).length === 0
    if (summarizer) {
      const last = [...text.matchAll(/SOAK turn (\d+)/g)].at(-1)?.[1] ?? '?'
      appendFileSync(callLog, `${JSON.stringify({ summarizer: true, tokens })}\n`)
      return {
        text: `Summary of the session so far. Work reached turn ${last}. ${'Notes about edited files and test runs. '.repeat(10)}`,
        usage: { inputTokens: tokens, outputTokens: 90 },
      }
    }
    // which turn is this? the last user prompt names it (it is never summarized away)
    const state = readState(stateFile)
    const found = [...text.matchAll(/SOAK turn (\d+):/g)].at(-1)?.[1]
    const turn = found === undefined ? state.turn : Number(found)
    if (turn !== state.turn) {
      state.turn = turn
      state.step = 0
    }
    const n = state.step
    state.step += 1
    state.seq += 1
    const id = `soak-${state.seq}`
    appendFileSync(callLog, `${JSON.stringify({ turn, step: n, tokens })}\n`)
    const usage = { inputTokens: tokens, outputTokens: 40 }

    const killing = plan.kill?.turn === turn && n === 2 && !state.fired.includes(turn)
    if (killing) state.fired.push(turn)
    writeFileSync(stateFile, JSON.stringify(state))
    if (killing && plan.kill) {
      process.stdout.write(`${JSON.stringify({ ev: 'kill-now', turn, mode: plan.kill.mode })}\n`)
      if (plan.kill.mode === 'stream')
        return { text: 'Streaming a long answer…', delayMs: 15_000, usage }
      return {
        toolCalls: [
          { toolName: 'bash', input: { command: 'sleep 6; echo finished' }, toolCallId: id },
        ],
        usage,
      }
    }
    if (n >= stepsOf(turn)) {
      return { text: `SOAK-DONE ${turn}. All steps of this turn are complete.`, usage }
    }
    switch (n) {
      case 0:
        return {
          toolCalls: [
            {
              toolName: 'write_file',
              input: { path: `/out/turn-${turn}.txt`, content: `result of turn ${turn}\n` },
              toolCallId: id,
            },
          ],
          usage,
        }
      case 1: // about 11 000 characters: a normal, large output (pruned once old)
        return {
          toolCalls: [{ toolName: 'bash', input: { command: 'seq 1 2200' }, toolCallId: id }],
          usage,
        }
      case 2: // about 45 000 characters: over the 30 000 limit, evicted
        return {
          toolCalls: [{ toolName: 'bash', input: { command: 'seq 1 9000' }, toolCallId: id }],
          usage,
        }
      default:
        return {
          toolCalls: [{ toolName: 'bash', input: { command: 'seq 1 3000' }, toolCallId: id }],
          usage,
        }
    }
  }
  // one scripted entry per possible model call: a soak never needs more than this
  return scriptedModel(
    Array.from({ length: 4_000 }, () => step),
    { modelId: 'soak-scripted' },
  )
}

// ─── the worker: a coder process ───

async function worker(plan: WorkerPlan): Promise<void> {
  process.env.CODER_HOME = plan.home
  process.env.CODER_OFFLINE = '1'
  const say = (event: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify(event)}\n`)
  }
  const config = await loadConfig({
    cwd: plan.dir,
    permissionMode: 'bypassPermissions',
    ...(plan.continueLast ? { continue: true } : {}),
  })
  const controller = await createController({
    config,
    model: soakModel(plan),
    broker: createDenyingBroker(),
  })
  const hooks = {
    onRun(run: { stream: unknown }): void {
      void (run.stream as ReadableStream).pipeTo(new WritableStream()).catch(() => {})
    },
  }
  say({ ev: 'start', sessionId: controller.sessionId, continued: plan.continueLast })
  if (plan.continueLast)
    say({ ev: 'recovered', interrupted: await controller.recoverInterrupted() })
  if (plan.retryFirst) {
    const t = Date.now()
    const r = await controller.retry(hooks)
    say({ ev: 'retry', stop: r.stop, ms: Date.now() - t })
  }
  for (const turn of plan.turns) {
    const t = Date.now()
    const r = await controller.run(`SOAK turn ${turn}: ${PROMPT_FILLER}`, hooks)
    say({ ev: 'turn', turn, stop: r.stop, ms: Date.now() - t })
    if (plan.rewind?.after === turn) {
      const point = (await controller.rewindPoints()).find((p) =>
        p.text.includes(`SOAK turn ${plan.rewind?.to}:`),
      )
      if (point === undefined) throw new Error(`no rewind point for turn ${plan.rewind.to}`)
      const result = await controller.rewind(point.messageId, 'both')
      say({
        ev: 'rewind',
        to: plan.rewind.to,
        restoredFiles: result.restoredFiles,
        sessionId: controller.sessionId,
      })
    }
  }
  say({ ev: 'done', sessionId: controller.sessionId })
  await controller.close()
}

// ─── the parent: kills, resumes and checks ───

interface WorkerRun {
  events: Array<Record<string, unknown>>
  killed: boolean
  wallMs: number
}

async function runWorker(plan: WorkerPlan, planFile: string): Promise<WorkerRun> {
  await writeFile(planFile, JSON.stringify(plan))
  const started = Date.now()
  const proc = Bun.spawn([process.execPath, import.meta.path, '--worker', planFile], {
    cwd: plan.dir,
    env: { ...(process.env as Record<string, string>), CODER_HOME: plan.home, CODER_OFFLINE: '1' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const events: Array<Record<string, unknown>> = []
  let killed = false
  const stderr = new Response(proc.stderr).text()
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
      try {
        const event = JSON.parse(line) as Record<string, unknown>
        events.push(event)
        if (event.ev === 'kill-now' && !killed) {
          killed = true
          // let the tool start (or the stream begin), then die without any chance to clean up
          setTimeout(() => proc.kill('SIGKILL'), 400)
        }
      } catch {
        // not an event line
      }
    }
  }
  const code = await proc.exited
  if (!killed && code !== 0) throw new Error(`worker failed (exit ${code}): ${await stderr}`)
  return { events, killed, wallMs: Date.now() - started }
}

interface Part {
  type: string
  text?: string
  state?: string
  toolCallId?: string
}
interface Msg {
  id: string
  role: string
  parts: Part[]
  metadata?: { eharness?: { kind?: string; stop?: string } }
}

const textOf = (m: Msg): string =>
  m.parts.map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('')

/** Run the soak. */
export async function runSoak(opts: SoakOptions = {}): Promise<SoakReport> {
  const turns = opts.turns ?? 36
  const window = opts.window ?? 60_000
  const log = opts.log ?? (() => {})
  if (turns < 18) throw new Error('--turns must be at least 18')
  const root = await mkdtemp(join(tmpdir(), 'coder-soak-'))
  const dir = join(root, 'project')
  const home = join(root, 'home')
  const stats = join(root, 'stats')
  for (const d of [dir, home, stats]) mkdirSync(d, { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# soak project\n')
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ contextWindow: window }))
  const planFile = join(root, 'plan.json')
  const previousHome = process.env.CODER_HOME
  const previousOffline = process.env.CODER_OFFLINE
  process.env.CODER_HOME = home
  process.env.CODER_OFFLINE = '1'

  const kA = Math.round(turns / 6)
  const kB = Math.round((turns * 5) / 12)
  const kC = Math.round((turns * 2) / 3)
  const rewindAfter = turns - 4
  const rewindTo = turns - 7
  const range = (a: number, b: number): number[] =>
    Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i)
  const base = { dir, home, stats }
  const segments: SoakReport['segments'] = []
  const problems: string[] = []
  const started = Date.now()
  let sessionId = ''
  const note = (name: string, run: WorkerRun): void => {
    segments.push({ name, wallMs: run.wallMs, killed: run.killed })
    for (const e of run.events) {
      if (e.ev === 'start' || e.ev === 'rewind' || e.ev === 'done') sessionId = String(e.sessionId)
    }
    log(`${name}: ${run.wallMs} ms${run.killed ? ' (killed)' : ''}`)
  }

  try {
    const config = await loadConfig({ cwd: dir })
    const storage = createStorage(config)
    const snapshot = async () => ({
      state: await storage.state.get(sessionId),
      messages: (await storage.messages.load({ sessionId })) as unknown as Msg[],
    })

    // 1. up to the first kill: a tool is running
    let run = await runWorker(
      {
        ...base,
        continueLast: false,
        retryFirst: false,
        turns: range(1, kA),
        kill: { turn: kA, mode: 'tool' },
      },
      planFile,
    )
    note(`turns 1..${kA}, killed in turn ${kA} (tool)`, run)
    if (!run.killed) problems.push('the first worker was not killed')
    {
      // dead process: a turn is still active and a tool call has no result yet
      const { state, messages } = await snapshot()
      await assertStoredSessionInvariants(state, messages as never).catch((e) =>
        problems.push(`after kill 1: ${String(e)}`),
      )
      if (state?.core.activeTurn == null) problems.push('after kill 1: no active turn stored')
    }

    // 2. resume, up to the second kill: the model is streaming
    run = await runWorker(
      {
        ...base,
        continueLast: true,
        retryFirst: false,
        turns: range(kA + 1, kB),
        kill: { turn: kB, mode: 'stream' },
      },
      planFile,
    )
    note(`turns ${kA + 1}..${kB}, killed in turn ${kB} (stream)`, run)
    if (!run.killed) problems.push('the second worker was not killed')
    if (!run.events.some((e) => e.ev === 'recovered' && e.interrupted === true)) {
      problems.push('resume 1: the interrupted turn was not detected')
    }

    // 3. resume, /retry the interrupted reply, up to the third kill (a tool again)
    run = await runWorker(
      {
        ...base,
        continueLast: true,
        retryFirst: true,
        turns: range(kB + 1, kC),
        kill: { turn: kC, mode: 'tool' },
      },
      planFile,
    )
    note(`retry turn ${kB}, turns ${kB + 1}..${kC}, killed in turn ${kC} (tool)`, run)
    if (!run.killed) problems.push('the third worker was not killed')
    if (!run.events.some((e) => e.ev === 'retry' && e.stop === 'complete')) {
      problems.push('resume 2: /retry did not complete')
    }

    // 4. resume, finish, with one rewind (conversation and files) in the middle
    run = await runWorker(
      {
        ...base,
        continueLast: true,
        retryFirst: false,
        turns: range(kC + 1, turns),
        rewind: { after: rewindAfter, to: rewindTo },
      },
      planFile,
    )
    note(`turns ${kC + 1}..${turns}, rewind to turn ${rewindTo} after turn ${rewindAfter}`, run)
    const rewind = run.events.find((e) => e.ev === 'rewind')
    if (rewind === undefined) problems.push('the rewind did not happen')
    for (const e of run.events) {
      if (e.ev === 'turn' && e.stop !== 'complete') problems.push(`turn ${e.turn} ended ${e.stop}`)
    }

    // ─── invariants of the final session ───
    const { state, messages } = await snapshot()
    await assertStoredSessionInvariants(state, messages as never, { quiescent: true }).catch((e) =>
      problems.push(`final session: ${String(e)}`),
    )

    // no lost or duplicated messages: the user prompts are exactly the expected turns, once, in order
    const expected = [...range(1, rewindTo - 1), ...range(rewindAfter + 1, turns)]
    const sent = messages
      .filter((m) => m.role === 'user' && m.metadata?.eharness?.kind === undefined)
      .map((m) => Number(/SOAK turn (\d+):/.exec(textOf(m))?.[1]))
    if (JSON.stringify(sent) !== JSON.stringify(expected)) {
      problems.push(
        `user prompts are ${JSON.stringify(sent)}, expected ${JSON.stringify(expected)}`,
      )
    }
    const assistantText = messages
      .filter((m) => m.role === 'assistant')
      .map(textOf)
      .join('\n')
    for (const k of expected) {
      const n = assistantText.split(`SOAK-DONE ${k}.`).length - 1
      const want = k === kA || k === kC ? 0 : 1
      if (n !== want) problems.push(`turn ${k}: final answer seen ${n} times, expected ${want}`)
    }
    // the rewound turns are gone, files included
    for (const k of range(rewindTo, rewindAfter)) {
      if (assistantText.includes(`SOAK-DONE ${k}.`) || sent.includes(k)) {
        problems.push(`rewound turn ${k} is still in the conversation`)
      }
      if (existsSync(join(dir, 'out', `turn-${k}.txt`))) {
        problems.push(`rewound turn ${k} left /out/turn-${k}.txt behind`)
      }
    }
    for (const k of expected) {
      if (k !== kA && k !== kC && !existsSync(join(dir, 'out', `turn-${k}.txt`))) {
        problems.push(`/out/turn-${k}.txt is missing`)
      }
    }

    // every tool call has a result; the killed turns are stored as interrupted, with a notice
    let interrupted = 0
    for (const m of messages) {
      for (const p of m.parts) {
        if (!(p.type.startsWith('tool-') || p.type === 'dynamic-tool')) continue
        if (p.state !== 'output-available' && p.state !== 'output-error') {
          problems.push(`tool call ${p.toolCallId} has no result (${p.state})`)
        }
        if (JSON.stringify(p).includes('Interrupted:')) interrupted += 1
      }
    }
    const stoppedMessages = messages.filter(
      (m) => m.role === 'assistant' && m.metadata?.eharness?.stop === 'interrupted',
    )
    // kills A and C stay visible; B was regenerated by /retry
    if (stoppedMessages.length < 2) {
      problems.push(
        `${stoppedMessages.length} interrupted replies stored, expected the 2 killed turns`,
      )
    }
    const notices = messages.filter((m) => m.metadata?.eharness?.kind === 'eh.notice').length
    if (notices < 2) problems.push(`${notices} interruption notices stored, expected at least 2`)

    // eviction: outputs over 30 000 characters went to the tool-outputs directory
    const evicted = await readdir(join(config.projectDataDir, 'tool-outputs'), { recursive: true })
      .then((names) => names.length)
      .catch(() => 0)
    if (evicted < 1) problems.push('no tool output was evicted to disk')

    // compaction happened repeatedly and left its markers
    const markers = messages.filter((m) => m.metadata?.eharness?.kind === 'eh.compaction')
    if (markers.length < 3)
      problems.push(`only ${markers.length} compaction summaries (expected at least 3)`)

    // the context stayed under the window on every model call
    const calls = readFileSync(join(stats, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { summarizer?: boolean; tokens: number })
    const peak = Math.max(...calls.map((c) => c.tokens))
    if (peak > window)
      problems.push(`a model call carried about ${peak} tokens, over the window ${window}`)
    const summarizerCalls = calls.filter((c) => c.summarizer).length
    if (summarizerCalls < 3)
      problems.push(`the summarizer ran ${summarizerCalls} times (expected at least 3)`)

    // cost tracking: token usage is recorded and grew (the scripted model has no price, so no USD)
    const usage = state?.core.usage as { inputTokens?: number; costUsd?: number } | undefined
    if (usage === undefined || (usage.inputTokens ?? 0) <= 0)
      problems.push('no token usage recorded in the session state')

    const report: SoakReport = {
      turns,
      window,
      segments,
      wallMs: Date.now() - started,
      modelCalls: calls.length,
      summarizerCalls,
      compactionMarkers: markers.length,
      interruptedToolResults: interrupted,
      evictedOutputs: evicted,
      peakPromptTokens: peak,
      peakFraction: Number((peak / window).toFixed(2)),
      usageInputTokens: usage?.inputTokens ?? 0,
      messages: messages.length,
      finalSessionId: sessionId,
      problems,
    }
    return report
  } finally {
    if (previousHome === undefined) delete process.env.CODER_HOME
    else process.env.CODER_HOME = previousHome
    if (previousOffline === undefined) delete process.env.CODER_OFFLINE
    else process.env.CODER_OFFLINE = previousOffline
    if (process.env.SOAK_KEEP === '1') log(`kept ${root}`)
    else await rm(root, { recursive: true, force: true })
  }
}

// ─── entry point ───

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === '--worker') {
    const plan = JSON.parse(await readFile(args[1] as string, 'utf8')) as WorkerPlan
    await worker(plan)
    process.exit(0)
  }
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const report = await runSoak({
    ...(flag('--turns') !== undefined ? { turns: Number(flag('--turns')) } : {}),
    ...(flag('--window') !== undefined ? { window: Number(flag('--window')) } : {}),
    log: (line) => process.stderr.write(`${line}\n`),
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.problems.length > 0) {
    process.stderr.write(`\nsoak FAILED:\n- ${report.problems.join('\n- ')}\n`)
    process.exit(1)
  }
  process.stderr.write('\nsoak passed: every invariant held\n')
}
