import { describe, expect, test } from 'bun:test'
import { NoObjectGeneratedError, NoOutputGeneratedError, tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import { FINAL_ANSWER_RECORDED, MAX_STEPS_WRAP_UP, OUTPUT_INSTRUCTION } from '../messages/texts.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { checkNative, outputRetryText } from '../output/turn.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import { type ScriptedCallOptions, scriptedModel } from '../testing/scripted-model.ts'
import { spyMessages, spyState } from './int-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>) {
  const messages = spyMessages()
  const state = spyState()
  const warnings: HarnessWarning[] = []
  const agent = defineHarnessAgent({
    contextWindow: 100_000,
    storage: { messages, state },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    ...config,
  })
  return { agent, messages, state, warnings }
}

const ticket = z.object({ label: z.enum(['bug', 'question']), confidence: z.number() })
const valid = { label: 'bug' as const, confidence: 0.9 }

const toolNames = (call: ScriptedCallOptions | undefined): string[] =>
  (call?.tools ?? []).map((t) => t.name)
const promptText = (call: ScriptedCallOptions | undefined): string => JSON.stringify(call?.prompt)

function assistantOf(messages: readonly HarnessUIMessage[], id: string | undefined) {
  const message = messages.find((m) => m.id === id)
  if (message === undefined) throw new Error('assistant message not found')
  return message
}

const outputPart = (message: HarnessUIMessage) =>
  message.parts.find((p) => p.type === 'data-eh.output') as
    | {
        type: 'data-eh.output'
        id?: string
        data: { value: unknown; mode: string; attempts: number }
      }
    | undefined

describe('structured output: tool mode', () => {
  test('a valid final_answer ends the turn complete; output stored as data-eh.output', async () => {
    const model = scriptedModel([{ toolCalls: [{ toolName: 'final_answer', input: valid }] }])
    const look = tool({ inputSchema: z.object({}), execute: async () => 'ok' })
    const { agent, messages } = setup({ model, tools: { look } })
    const session = agent.session('s1')
    const result = await session.send('classify', { output: { schema: ticket } }).result
    expect(result.stop).toBe('complete')
    expect(result.output).toEqual(valid)
    expect(result.steps).toBe(1)
    expect(model.calls).toHaveLength(1)
    // final_answer is appended last; the instruction is in the turn reminder
    expect(toolNames(model.calls[0])).toEqual(['look', 'final_answer'])
    expect(promptText(model.calls[0])).toContain(
      JSON.stringify(OUTPUT_INSTRUCTION.replace('{tool}', 'final_answer')).slice(1, -1),
    )
    const stored = assistantOf(
      (await messages.load({ sessionId: 's1' })) as HarnessUIMessage[],
      result.messageId,
    )
    expect(outputPart(stored)).toEqual({
      type: 'data-eh.output',
      id: 'output',
      data: { value: valid, mode: 'tool', attempts: 1 },
    })
    expect(stored.metadata?.eharness?.output).toEqual({ ok: true, attempts: 1 })
    const call = stored.parts.find((p) => p.type === 'tool-final_answer') as { output?: unknown }
    expect(call.output).toBe(FINAL_ANSWER_RECORDED)
  })

  test('invalid final_answer input is an attempt; the model corrects itself', async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'final_answer', input: { label: 'nope', confidence: 1 } }] },
      { toolCalls: [{ toolName: 'final_answer', input: valid }] },
    ])
    const { agent } = setup({ model })
    const result = await agent.session('s1').send('go', { output: { schema: ticket } }).result
    expect(result.stop).toBe('complete')
    expect(result.output).toEqual(valid)
    const stored = assistantOf(result.messages as HarnessUIMessage[], result.messageId)
    expect(outputPart(stored)?.data.attempts).toBe(2)
    expect(stored.metadata?.eharness?.output).toEqual({ ok: true, attempts: 2 })
  })

  test('a text answer without final_answer is retried with a forced tool choice', async () => {
    const model = scriptedModel([
      { text: 'It is a bug.' },
      { toolCalls: [{ toolName: 'final_answer', input: valid }] },
    ])
    const { agent } = setup({ model })
    const result = await agent.session('s1').send('go', { output: { schema: ticket } }).result
    expect(result.stop).toBe('complete')
    expect(result.output).toEqual(valid)
    expect(model.calls[0]?.toolChoice).toEqual({ type: 'auto' })
    expect(model.calls[1]?.toolChoice).toEqual({ type: 'tool', toolName: 'final_answer' })
    const retry = outputRetryText('the `final_answer` tool was not called.')
    expect(promptText(model.calls[1])).toContain(JSON.stringify(retry).slice(1, -1))
    const stored = assistantOf(result.messages as HarnessUIMessage[], result.messageId)
    const input = stored.parts.find((p) => p.type === 'data-eh.input') as {
      data: { source: string; text: string }
    }
    expect(input.data).toEqual({ source: 'plugin:eh.output', text: retry })
    expect(outputPart(stored)?.data.attempts).toBe(2)
  })

  test("never valid: 'output-invalid' after maxRetries, W_OUTPUT_INVALID", async () => {
    const model = scriptedModel([
      { text: 'a' },
      { toolCalls: [{ toolName: 'final_answer', input: { label: 'nope' } }] },
      { text: 'never' },
    ])
    const { agent, warnings } = setup({ model })
    const result = await agent
      .session('s1')
      .send('go', { output: { schema: ticket, maxRetries: 1 } }).result
    expect(result.stop).toBe('output-invalid')
    expect(result.output).toBeUndefined()
    expect(model.calls).toHaveLength(2)
    const warning = warnings.find((w) => w.code === 'W_OUTPUT_INVALID')
    expect(warning?.details?.attempts).toBe(2)
    expect(String(warning?.details?.lastError)).toContain('final_answer')
    const stored = assistantOf(result.messages as HarnessUIMessage[], result.messageId)
    expect(stored.metadata?.eharness?.stop).toBe('output-invalid')
    expect(stored.metadata?.eharness?.output).toEqual({ ok: false, attempts: 2 })
    expect(outputPart(stored)).toBeUndefined()
  })

  test('text answers only: the retry limit is reached without a forced call', async () => {
    const model = scriptedModel([{ text: 'a' }])
    const { agent, warnings } = setup({ model })
    const result = await agent
      .session('s1')
      .send('go', { output: { schema: ticket, maxRetries: 0 } }).result
    expect(result.stop).toBe('output-invalid')
    expect(warnings.find((w) => w.code === 'W_OUTPUT_INVALID')?.details).toEqual({
      attempts: 1,
      lastError: 'the `final_answer` tool was not called.',
    })
  })

  test('a model that ignores the forced tool choice fails the step (AI SDK ToolChoiceViolationError)', async () => {
    const model = scriptedModel([{ text: 'a' }, { text: 'b' }])
    const { agent } = setup({ model })
    const result = await agent.session('s1').send('go', { output: { schema: ticket } }).result
    expect(result.stop).toBe('error')
    expect(result.output).toBeUndefined()
  })

  test('invalid tool calls use up the retries too', async () => {
    const bad = { toolName: 'final_answer', input: { label: 1 } }
    const model = scriptedModel([{ toolCalls: [bad] }, { toolCalls: [bad] }, { text: 'never' }])
    const { agent } = setup({ model })
    const result = await agent
      .session('s1')
      .send('go', { output: { schema: ticket, maxRetries: 1 } }).result
    expect(result.stop).toBe('output-invalid')
    expect(model.calls).toHaveLength(2)
  })

  test('the next turn without output has the unchanged tool list and no instruction', async () => {
    const look = tool({ inputSchema: z.object({}), execute: async () => 'ok' })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'final_answer', input: valid }] },
      { text: 'hi' },
    ])
    const { agent } = setup({ model, tools: { look } })
    const session = agent.session('s1')
    await session.send('one', { output: { schema: ticket } }).result
    const second = await session.send('two').result
    expect(second.stop).toBe('complete')
    expect(second.output).toBeUndefined()
    expect(toolNames(model.calls[1])).toEqual(['look'])
    const instruction = OUTPUT_INSTRUCTION.replace('{tool}', 'final_answer')
    expect(promptText(model.calls[1])).not.toContain(JSON.stringify(instruction).slice(1, -1))
  })

  test('a custom toolName and description', async () => {
    const model = scriptedModel([{ toolCalls: [{ toolName: 'submit', input: valid }] }])
    const { agent } = setup({ model })
    const result = await agent
      .session('s1')
      .send('go', { output: { schema: ticket, toolName: 'submit', description: 'Submit it.' } })
      .result
    expect(result.output).toEqual(valid)
    const submit = model.calls[0]?.tools?.find((t) => t.name === 'submit') as {
      description?: string
    }
    expect(submit.description).toBe('Submit it.')
  })

  test('final_answer stays active when turn.prepare restricts activeTools', async () => {
    const look = tool({ inputSchema: z.object({}), execute: async () => 'ok' })
    const other = tool({ inputSchema: z.object({}), execute: async () => 'ok' })
    const plugin = definePlugin({
      name: 'only',
      setup: () => ({ hooks: { 'turn.prepare': () => ({ activeTools: ['look'] }) } }),
    })
    const model = scriptedModel([{ toolCalls: [{ toolName: 'final_answer', input: valid }] }])
    const { agent } = setup({ model, tools: { look, other }, plugins: [plugin] })
    const result = await agent.session('s1').send('go', { output: { schema: ticket } }).result
    expect(result.output).toEqual(valid)
    expect(toolNames(model.calls[0])).toEqual(['look', 'final_answer'])
  })

  test('the approval policy never asks for final_answer', async () => {
    const model = scriptedModel([{ toolCalls: [{ toolName: 'final_answer', input: valid }] }])
    const { agent } = setup({ model, approval: { policy: () => 'user-approval' } })
    const result = await agent.session('s1').send('go', { output: { schema: ticket } }).result
    expect(result.stop).toBe('complete')
    expect(result.output).toEqual(valid)
  })
})

describe('structured output: native mode', () => {
  test('JSON text is parsed and validated by AI SDK Output.object', async () => {
    const model = scriptedModel([{ text: JSON.stringify(valid) }])
    const { agent } = setup({ model })
    const result = await agent
      .session('s1')
      .send('go', { output: { schema: ticket, mode: 'native' } }).result
    expect(result.stop).toBe('complete')
    expect(result.output).toEqual(valid)
    expect(model.calls[0]?.responseFormat).toMatchObject({ type: 'json' })
    expect(toolNames(model.calls[0])).not.toContain('final_answer')
    const stored = assistantOf(result.messages as HarnessUIMessage[], result.messageId)
    expect(outputPart(stored)?.data).toEqual({ value: valid, mode: 'native', attempts: 1 })
  })

  test('invalid JSON is retried (NoObjectGeneratedError)', async () => {
    const model = scriptedModel([{ text: 'not json' }, { text: JSON.stringify(valid) }])
    const { agent } = setup({ model })
    const result = await agent
      .session('s1')
      .send('go', { output: { schema: ticket, mode: 'native' } }).result
    expect(result.output).toEqual(valid)
    expect(model.calls[1]?.toolChoice).not.toEqual({ type: 'tool', toolName: 'final_answer' })
    expect(promptText(model.calls[1])).toContain('No object generated')
    const stored = assistantOf(result.messages as HarnessUIMessage[], result.messageId)
    expect(outputPart(stored)?.data.attempts).toBe(2)
  })

  test('a schema mismatch is retried; an empty answer too', async () => {
    const model = scriptedModel([
      { text: JSON.stringify({ label: 'other' }) },
      { text: '', finishReason: 'other' },
      { text: JSON.stringify(valid) },
    ])
    const { agent } = setup({ model, loop: { maxIdleContinues: 5 } })
    const result = await agent
      .session('s1')
      .send('go', { output: { schema: ticket, mode: 'native', maxRetries: 3 } }).result
    expect(result.output).toEqual(valid)
    expect(result.messages.length).toBeGreaterThan(0)
    const stored = assistantOf(result.messages as HarnessUIMessage[], result.messageId)
    expect(outputPart(stored)?.data.attempts).toBe(3)
  })

  test('checkNative maps NoOutputGeneratedError / NoObjectGeneratedError to failed attempts', async () => {
    const noOutput = await checkNative(
      Promise.reject(new NoOutputGeneratedError({ message: 'No output generated.' })),
    )
    expect(noOutput).toEqual({ ok: false, error: 'No output generated.' })
    const noObject = await checkNative(
      Promise.reject(
        new NoObjectGeneratedError({
          message: 'No object generated: could not parse the response.',
          cause: new Error('Unexpected token'),
          text: 'x',
          response: { id: 'r', timestamp: new Date(0), modelId: 'm' },
          usage: {} as never,
          finishReason: 'stop',
        }),
      ),
    )
    expect(noObject).toEqual({
      ok: false,
      error: 'No object generated: could not parse the response. Unexpected token',
    })
    expect(await checkNative(Promise.resolve(1))).toEqual({ ok: true, value: 1 })
  })
})

describe('structured output: spec validation', () => {
  test('a Standard Schema without JSON Schema support → EH_INVALID_INPUT run error', async () => {
    const standard = {
      '~standard': {
        version: 1 as const,
        vendor: 'custom',
        validate: (value: unknown) => ({ value }),
      },
    }
    const model = scriptedModel([])
    const { agent, messages } = setup({ model })
    const result = await agent.session('s1').send('go', { output: { schema: standard } }).result
    expect(result.stop).toBe('error')
    expect(result.error?.code).toBe('EH_INVALID_INPUT')
    expect(result.error?.details).toEqual({ reason: 'output-schema' })
    expect(messages.saves).toHaveLength(0)
    expect(model.calls).toHaveLength(0)
  })

  test('a tool name collision → EH_INVALID_INPUT', async () => {
    const final_answer = tool({ inputSchema: z.object({}), execute: async () => 'mine' })
    const model = scriptedModel([])
    const { agent } = setup({ model, tools: { final_answer } })
    const result = await agent.session('s1').send('go', { output: { schema: ticket } }).result
    expect(result.stop).toBe('error')
    expect(result.error?.code).toBe('EH_INVALID_INPUT')
    expect(result.error?.details).toEqual({ reason: 'output-tool-name' })
  })

  test('native mode ignores a colliding tool name (no tool is added)', async () => {
    const final_answer = tool({ inputSchema: z.object({}), execute: async () => 'mine' })
    const model = scriptedModel([{ text: JSON.stringify(valid) }])
    const { agent } = setup({ model, tools: { final_answer } })
    const result = await agent
      .session('s1')
      .send('go', { output: { schema: ticket, mode: 'native' } }).result
    expect(result.output).toEqual(valid)
  })

  test('maxRetries must be a non-negative integer', async () => {
    const { agent } = setup({ model: scriptedModel([]) })
    const result = await agent
      .session('s1')
      .send('go', { output: { schema: ticket, maxRetries: -1 } }).result
    expect(result.error?.details).toEqual({ reason: 'output-spec' })
  })
})

describe('structured output: bounds', () => {
  test('maxSteps reached during a retry keeps max-steps (no wrap-up)', async () => {
    const model = scriptedModel([{ text: 'a' }, { text: 'wrap' }])
    const { agent } = setup({ model })
    const result = await agent.session('s1').send('go', { maxSteps: 1, output: { schema: ticket } })
      .result
    expect(result.stop).toBe('max-steps')
    expect(result.output).toBeUndefined()
    expect(model.calls).toHaveLength(1)
  })

  test('max-steps from a tool step keeps the unchanged wrap-up step', async () => {
    const look = tool({ inputSchema: z.object({}), execute: async () => 'ok' })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'look', input: {} }] },
      { text: 'summary' },
    ])
    const { agent } = setup({ model, tools: { look } })
    const result = await agent
      .session('s1')
      .send('go', { maxSteps: 1, output: { schema: ticket, mode: 'native' } }).result
    expect(result.stop).toBe('max-steps')
    expect(result.output).toBeUndefined()
    expect(model.calls[1]?.toolChoice).toEqual({ type: 'none' })
    expect(model.calls[1]?.responseFormat).toBeUndefined()
    expect(promptText(model.calls[1])).toContain(MAX_STEPS_WRAP_UP.slice(0, 40))
  })

  test('maxContinues refuses the retry: output-invalid', async () => {
    const model = scriptedModel([{ text: 'a' }, { text: 'b' }])
    const { agent, warnings } = setup({ model, loop: { maxContinues: 0 } })
    const result = await agent.session('s1').send('go', { output: { schema: ticket } }).result
    expect(result.stop).toBe('output-invalid')
    expect(model.calls).toHaveLength(1)
    expect(warnings.find((w) => w.code === 'W_CONTINUE_LIMIT')?.details).toMatchObject({
      owner: 'eh.output',
      reason: 'max',
    })
  })

  test('a used-up budget during a retry stops with cost-cap', async () => {
    const model = scriptedModel([{ text: 'a', usage: { inputTokens: 1_000_000 } }, { text: 'b' }])
    const { agent } = setup({
      model,
      models: () => ({ pricing: { input: 1, output: 1 } }), // USD per 1M tokens
      budget: { maxTurnUsd: 0.5 },
    })
    const result = await agent.session('s1').send('go', { output: { schema: ticket } }).result
    expect(result.stop).toBe('cost-cap')
    expect(result.output).toBeUndefined()
    expect(model.calls).toHaveLength(1)
  })

  test('an abort during a retry keeps aborted', async () => {
    const model = scriptedModel([{ text: 'a' }, { text: 'b', delayMs: 50 }])
    const { agent } = setup({ model })
    const session = agent.session('s1')
    const run = session.send('go', { output: { schema: ticket } })
    const timer = setInterval(() => {
      if (model.calls.length >= 2) {
        clearInterval(timer)
        run.abort()
      }
    }, 2)
    const result = await run.result
    clearInterval(timer)
    expect(result.stop).toBe('aborted')
    expect(result.output).toBeUndefined()
  })

  test('a plugin turn.beforeEnd continuation runs before the output check', async () => {
    let asked = 0
    const plugin = definePlugin({
      name: 'nag',
      setup: () => ({
        hooks: {
          'turn.beforeEnd': () =>
            asked++ === 0 ? { continue: { reason: 'check again' } } : undefined,
        },
      }),
    })
    const model = scriptedModel([
      { text: 'draft' },
      { toolCalls: [{ toolName: 'final_answer', input: valid }] },
    ])
    const { agent } = setup({ model, plugins: [plugin] })
    const result = await agent.session('s1').send('go', { output: { schema: ticket } }).result
    expect(result.stop).toBe('complete')
    expect(result.output).toEqual(valid)
    expect(promptText(model.calls[1])).toContain('check again')
    expect(promptText(model.calls[1])).not.toContain('is missing or invalid')
    expect(model.calls[1]?.toolChoice).toEqual({ type: 'auto' })
    const stored = assistantOf(result.messages as HarnessUIMessage[], result.messageId)
    expect(outputPart(stored)?.data.attempts).toBe(1)
  })
})

describe('structured output: respond()', () => {
  test('the output spec is not carried over a tool-pending stop; respond() takes it again', async () => {
    const risky = tool({ inputSchema: z.object({}), execute: async () => 'done' })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'risky', input: {} }] },
      { toolCalls: [{ toolName: 'final_answer', input: valid }] },
    ])
    const { agent } = setup({
      model,
      tools: { risky },
      approval: { policy: { risky: 'user-approval' } },
    })
    const session = agent.session('s1')
    const first = await session.send('go', { output: { schema: ticket } }).result
    expect(first.stop).toBe('tool-pending')
    expect(first.output).toBeUndefined()
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const second = await session.respond(
      { approvals: [{ id: approvalId, approved: true }] },
      { output: { schema: ticket } },
    ).result
    expect(second.stop).toBe('complete')
    expect(second.output).toEqual(valid)
    expect(toolNames(model.calls[1])).toEqual(['risky', 'final_answer'])
  })
})
