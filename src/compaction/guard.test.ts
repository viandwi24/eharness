import { describe, expect, test } from 'bun:test'
import { APICallError, type ModelMessage, RetryError, StreamProviderError } from 'ai'
import { applyHardCap, MIN_TRUNCATED_OUTPUT_CHARS } from './guard.ts'
import { isContextOverflow, reportedTokenCount } from './overflow.ts'
import { defaultCountTokens, wireTokens } from './tokens.ts'
import { truncateMiddle } from './truncate.ts'

describe('truncateMiddle', () => {
  test('keeps 70% head and 30% tail around the TOOL_OUTPUT_TRUNCATED marker', () => {
    const text = `${'a'.repeat(100)}${'b'.repeat(100)}`
    expect(truncateMiddle(text, 200)).toBe(text)
    const out = truncateMiddle(text, 100)
    expect(out).toBe(`${'a'.repeat(70)}…[truncated 100 chars]…${'b'.repeat(30)}`)
    expect(truncateMiddle('abcdef', 0)).toBe('…[truncated 6 chars]…')
  })
})

describe('overflow detection', () => {
  const apiError = (statusCode: number, message: string, responseBody?: string) =>
    new APICallError({
      message,
      url: 'https://x',
      requestBodyValues: {},
      statusCode,
      ...(responseBody === undefined ? {} : { responseBody }),
      isRetryable: false,
    })

  test('status 400/413 plus a known message or body pattern', () => {
    expect(
      isContextOverflow(apiError(400, 'prompt is too long: 215000 tokens > 200000 maximum')),
    ).toBe(true)
    expect(
      isContextOverflow(
        apiError(400, 'Bad Request', '{"error":{"code":"context_length_exceeded"}}'),
      ),
    ).toBe(true)
    expect(isContextOverflow(apiError(413, 'request_too_large'))).toBe(true)
    expect(isContextOverflow(apiError(429, 'too many tokens per minute'))).toBe(false)
    expect(isContextOverflow(apiError(400, 'invalid tool schema'))).toBe(false)
    expect(isContextOverflow(new Error('prompt is too long'))).toBe(false)
    expect(isContextOverflow(apiError(400, 'Input exceeds the context window of this model'))).toBe(
      true,
    )
    expect(isContextOverflow(apiError(400, 'context length exceeded'))).toBe(true)
  })

  test('other 400s that merely mention the context are not overflows', () => {
    for (const message of [
      'Invalid value for context length: must be a positive integer',
      'The context window parameter is not supported',
      'Unknown field `context_window` in request',
    ]) {
      expect(isContextOverflow(apiError(400, message))).toBe(false)
    }
  })

  test('walks the cause chain (gateway errors); plain objects with `status` work too', () => {
    const wrapped = new Error('gateway failed', {
      cause: { status: 400, message: "This model's maximum context length is 128000 tokens" },
    })
    expect(isContextOverflow(wrapped)).toBe(true)
    const cyclic: { message: string; cause?: unknown } = { message: 'x' }
    cyclic.cause = cyclic
    expect(isContextOverflow(cyclic)).toBe(false)
  })

  test('a RetryError wrapping a non-retryable overflow (429 then 400) is an overflow', () => {
    const overflow = apiError(400, 'prompt is too long: 215000 tokens > 200000 maximum')
    const retry = new RetryError({
      message: 'Failed after 2 attempts with non-retryable error',
      reason: 'errorNotRetryable',
      errors: [apiError(429, 'rate limited'), overflow],
    })
    expect(isContextOverflow(retry)).toBe(true)
    expect(reportedTokenCount(retry)).toBe(215_000)
    const onlyRateLimit = new RetryError({
      message: 'Failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [apiError(429, 'too many tokens per minute')],
    })
    expect(isContextOverflow(onlyRateLimit)).toBe(false)
  })

  test("many retries: lastError's cause chain is walked before older attempts", () => {
    const overflow = apiError(400, 'prompt is too long: 215000 tokens > 200000 maximum')
    const last = new Error('gateway failed', { cause: new Error('proxy', { cause: overflow }) })
    const retry = new RetryError({
      message: 'Failed after 8 attempts',
      reason: 'errorNotRetryable',
      errors: [...Array.from({ length: 7 }, () => apiError(429, 'rate limited')), last],
    })
    expect(isContextOverflow(retry)).toBe(true)
    expect(reportedTokenCount(retry)).toBe(215_000)
  })

  test('StreamProviderError with status 400 and an overflow payload is an overflow', () => {
    const streamed = new StreamProviderError({
      message: 'Invalid request',
      type: 'invalid_request_error',
      statusCode: 400,
      data: { error: { message: 'input is too long for requested model' } },
    })
    expect(isContextOverflow(streamed)).toBe(true)
    expect(
      isContextOverflow(
        new StreamProviderError({ message: 'prompt is too long', type: 'overloaded_error' }),
      ),
    ).toBe(false)
    const retry = new RetryError({
      message: 'x',
      reason: 'errorNotRetryable',
      errors: [new StreamProviderError({ message: 'prompt is too long', statusCode: 400 })],
    })
    expect(isContextOverflow(retry)).toBe(true)
  })

  test('config.isContextOverflow extends detection; a throwing callback is false', () => {
    const error = new Error('custom provider: CTX_FULL')
    expect(isContextOverflow(error, (e) => (e as Error).message.includes('CTX_FULL'))).toBe(true)
    expect(
      isContextOverflow(error, () => {
        throw new Error('bug')
      }),
    ).toBe(false)
  })

  test('reported token counts', () => {
    expect(
      reportedTokenCount(apiError(400, 'prompt is too long: 215000 tokens > 200000 maximum')),
    ).toBe(215_000)
    expect(
      reportedTokenCount(
        apiError(
          400,
          "This model's maximum context length is 128000 tokens. However, your messages resulted in 130,512 tokens.",
        ),
      ),
    ).toBe(130_512)
    expect(reportedTokenCount(apiError(400, 'context_length_exceeded'))).toBeUndefined()
  })
})

/** Output of the first tool result of a tool message. */
function outputOf(message: ModelMessage | undefined): { value: unknown } {
  const content = (message?.content ?? []) as Array<{ output?: { value: unknown } }>
  return content[0]?.output ?? { value: undefined }
}

describe('hard cap', () => {
  const measure = (m: readonly ModelMessage[]) => wireTokens(m, defaultCountTokens)
  const turn = (n: number, size = 400): ModelMessage[] => [
    { role: 'user', content: `q${n} ${'x'.repeat(size)}` },
    { role: 'assistant', content: `a${n}` },
  ]
  const toolTurn = (size: number): ModelMessage[] => [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: {} }],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'read',
          output: { type: 'text', value: 'y'.repeat(size) },
        },
      ],
    },
  ]
  const head: ModelMessage[] = [
    { role: 'user', content: '<conversation-summary>s</conversation-summary>' },
  ]

  test('under the limit: unchanged', () => {
    const r = applyHardCap({
      head,
      turns: [turn(1), turn(2)],
      current: turn(3),
      fixedTokens: 10,
      limit: 10_000,
      measure,
    })
    expect(r.messages).toEqual([...head, ...turn(1), ...turn(2), ...turn(3)])
    expect(r.turnStart).toBe(5)
    expect(r.droppedTurns).toBe(0)
    expect(r.over).toBe(false)
  })

  test('drops the oldest completed turns first; the head is never dropped', () => {
    const turns = [turn(1), turn(2), turn(3)]
    const limit = 10 + measure(head) + measure(turn(3)) + measure(turn(4))
    const r = applyHardCap({ head, turns, current: turn(4), fixedTokens: 10, limit, measure })
    expect(r.droppedTurns).toBe(2)
    expect(r.messages).toEqual([...head, ...turn(3), ...turn(4)])
    expect(r.turnStart).toBe(3)
    expect(r.over).toBe(false)
    expect(turns).toHaveLength(3) // inputs untouched
  })

  test('then truncates the largest tool outputs of the current turn (head + tail)', () => {
    const current = toolTurn(20_000)
    const r = applyHardCap({
      head: [],
      turns: [turn(1)],
      current,
      fixedTokens: 0,
      limit: 3_000,
      measure,
    })
    expect(r.droppedTurns).toBe(1)
    expect(r.truncatedOutputs).toBe(1)
    expect(r.over).toBe(false)
    const output = outputOf(r.messages.at(-1)) as { value: string }
    expect(output?.value).toContain('…[truncated ')
    expect(output?.value.startsWith('yyy')).toBe(true)
    expect(outputOf(current[2]).value).toHaveLength(20_000)
  })

  test('json outputs become a truncated preview; still over → over: true (never loops)', () => {
    const current: ModelMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'q', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'q',
            output: { type: 'json', value: { rows: 'z'.repeat(9_000) } },
          },
        ],
      },
    ]
    const r = applyHardCap({ head: [], turns: [], current, fixedTokens: 0, limit: 50, measure })
    expect(r.over).toBe(true)
    const output = outputOf(r.messages[1]).value as {
      truncated: boolean
      preview: string
      originalChars: number
    }
    expect(output.truncated).toBe(true)
    expect(output.originalChars).toBe(9_000 + '{"rows":""}'.length)
    expect(output.preview.length).toBeLessThan(MIN_TRUNCATED_OUTPUT_CHARS + 40)
  })
})
