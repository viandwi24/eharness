/**
 * The scripted "brain" of the soak test: one scripted model per agent whose next step is decided
 * from what the call looks like (its tools and the tool results since the last user message), not
 * from a fixed sequence, so any number of agents and runs can share it concurrently and a retried
 * or recovered call still gets a sensible answer. Faults (429, 500, thrown errors, a timeout, a
 * stream error, a slow stream) are injected from a seeded random generator.
 */
import { APICallError } from 'ai'
import { type ScriptedStep, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import type { ModelConfig } from '../../server/src/infra/eh/provider.ts'

export interface BrainOptions {
  seed: number
  /** Probability that a model call fails or is slow (0 = never). */
  faultRate: number
  /** Probability that a program run escalates once (parks until the client decides). */
  escalateRate: number
}

export interface BrainStats {
  calls: number
  faults: Record<string, number>
  escalations: number
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Prompt = ReadonlyArray<{ role: string; content: unknown }>

/** Names of the tools whose result came after the last user message. */
function resultsSinceUser(prompt: Prompt): Set<string> {
  const names = new Set<string>()
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i]
    if (message === undefined || message.role === 'user') break
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue
    for (const part of message.content as Array<{ type?: string; toolName?: string }>) {
      if (part.type === 'tool-result' && part.toolName !== undefined) names.add(part.toolName)
    }
  }
  return names
}

let ids = 0
const uid = (): string => `${Date.now().toString(36)}-${(++ids).toString(36)}`
const call = (toolName: string, input: Record<string, unknown>): ScriptedStep => ({
  toolCalls: [{ toolName, input, toolCallId: `c-${toolName}-${uid()}` }],
})

/** An unbounded script: every index answers with `fn`. */
function endless(fn: (callOptions: never) => ScriptedStep): ScriptedStepInput[] {
  return new Proxy([] as ScriptedStepInput[], {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) return fn as ScriptedStepInput
      return Reflect.get(target, key, receiver)
    },
  })
}

export function soakModels(options: BrainOptions): { config: ModelConfig; stats: BrainStats } {
  const stats: BrainStats = { calls: 0, faults: {}, escalations: 0 }
  const rng = mulberry32(options.seed)
  const fault = (kind: string): void => {
    stats.faults[kind] = (stats.faults[kind] ?? 0) + 1
  }

  const brain = (slug: string) =>
    endless((raw): ScriptedStep => {
      const options_ = raw as { prompt: Prompt; tools?: Array<{ name: string }> }
      stats.calls++
      const tools = new Set((options_.tools ?? []).map((t) => t.name))
      const done = resultsSinceUser(options_.prompt)
      const usage = {
        inputTokens: 800 + Math.floor(rng() * 2000),
        outputTokens: 100 + Math.floor(rng() * 300),
      }

      // injected faults first: the caller retries, recovers or reports a failure
      if (rng() < options.faultRate) {
        const roll = rng()
        const url = 'https://soak.invalid/v1'
        if (roll < 0.25) {
          fault('429')
          return {
            throws: new APICallError({
              message: 'Too many requests',
              url,
              requestBodyValues: {},
              statusCode: 429,
              isRetryable: true,
            }),
          }
        }
        if (roll < 0.45) {
          fault('500')
          return {
            throws: new APICallError({
              message: 'Internal error',
              url,
              requestBodyValues: {},
              statusCode: 500,
              isRetryable: true,
            }),
          }
        }
        if (roll < 0.6) {
          fault('thrown')
          return { throws: new Error('soak: provider connection reset') }
        }
        if (roll < 0.7) {
          fault('timeout')
          return { throws: new DOMException('The operation timed out', 'TimeoutError') }
        }
        if (roll < 0.85) {
          fault('stream-error')
          return { text: 'partial', streamError: new Error('soak: stream broke'), usage }
        }
        fault('slow')
        // fall through with a slow stream
      }
      const slow = rng() < 0.05 ? { delayMs: 60 } : {}

      if (tools.has('team_status')) {
        // heartbeat
        if (!done.has('team_status')) return { ...call('team_status', {}), usage }
        const attention = rng() < 0.4
        return {
          ...call('final_answer', {
            status: attention ? 'attention' : 'ok',
            items: attention
              ? [
                  {
                    kind: 'soak.note',
                    title: `Soak note ${uid()}`,
                    detail: 'something the soak wants the client to see',
                    links: [],
                    urgent: rng() < 0.25,
                  },
                ]
              : [],
          }),
          usage,
          ...slow,
        }
      }
      if (tools.has('complete_task')) {
        // worker run: one task per session
        if (!done.has('write_file')) {
          return {
            ...call('write_file', {
              path: `/library/scripts/soak-${uid()}.md`,
              content: 'a script',
            }),
            usage,
            ...slow,
          }
        }
        if (!done.has('complete_task')) {
          return { ...call('complete_task', { summary: 'drafted', outputs: [] }), usage }
        }
        return {
          ...call('final_answer', { status: 'done', summary: 'drafted', outputs: [] }),
          usage,
        }
      }
      if (tools.has('final_answer')) {
        // an ordinary program run
        if (tools.has('escalate') && !done.has('escalate') && !done.has('write_file')) {
          if (rng() < options.escalateRate) {
            stats.escalations++
            return {
              ...call('escalate', {
                title: `Soak question ${uid()}`,
                question: 'Carry on?',
                options: ['yes', 'no'],
              }),
              usage,
            }
          }
        }
        if (!done.has('write_file') && !done.has('escalate')) {
          return {
            ...call('write_file', { path: `/library/reports/soak-${uid()}.md`, content: 'report' }),
            usage,
            ...slow,
          }
        }
        return {
          ...call('final_answer', { status: 'done', summary: `${slug} finished`, outputs: [] }),
          usage,
        }
      }
      return { text: 'ok', usage }
    })

  const models = new Map<string, ReturnType<typeof scriptedModel>>()
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    resolve: (id) => {
      const slug = (id ?? '').replace('m-', '')
      let model = models.get(slug)
      if (model === undefined) {
        model = scriptedModel(brain(slug), { provider: 'scripted' })
        models.set(slug, model)
      }
      return model
    },
  }
  return { config, stats }
}
