/**
 * Contract test for the AI SDK options eharness relies on that are still `experimental_` upstream
 * (docs/engineering/api-stability.md, "Experimental dependencies"). If a future `ai` release
 * renames or drops one, this fails in CI (the `compat` job runs it against `ai@latest`) instead of
 * silently turning the feature off.
 */
import { describe, expect, test } from 'bun:test'
import { isStepCount, streamText, tool } from 'ai'
import { z } from 'zod'
import { scriptedModel } from './testing'

describe('AI SDK experimental options', () => {
  test('experimental_refineToolInput rewrites the input before execute', async () => {
    const seen: unknown[] = []
    const model = scriptedModel([{ toolCalls: [{ toolName: 'echo', input: { value: 1 } }] }])
    const result = streamText({
      model,
      prompt: 'go',
      stopWhen: isStepCount(1),
      tools: {
        echo: tool({
          description: 'echo',
          inputSchema: z.object({ value: z.number() }),
          execute: (input) => {
            seen.push(input)
            return 'ok'
          },
        }),
      },
      experimental_refineToolInput: { echo: async () => ({ value: 2 }) },
    })
    await result.consumeStream()
    expect(seen).toEqual([{ value: 2 }])
  })

  test('experimental_toolApprovalSecret signs approval requests', async () => {
    const model = scriptedModel([{ toolCalls: [{ toolName: 'echo', input: { value: 1 } }] }])
    const result = streamText({
      model,
      prompt: 'go',
      stopWhen: isStepCount(1),
      tools: {
        echo: tool({
          description: 'echo',
          inputSchema: z.object({ value: z.number() }),
          execute: () => 'ok',
        }),
      },
      toolApproval: { echo: 'user-approval' },
      experimental_toolApprovalSecret: 'test-secret',
    })
    const requests: Array<{ signature?: string }> = []
    for await (const part of result.fullStream) {
      if (part.type === 'tool-approval-request') requests.push(part as { signature?: string })
    }
    expect(requests).toHaveLength(1)
    expect(typeof requests[0]?.signature).toBe('string')
  })
})
