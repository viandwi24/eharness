/**
 * A subagent as a tool: the tool runs a child session of another agent, streams the child's
 * progress into the parent message as preliminary tool results, and reports the child's usage to
 * the parent turn (`ctx.turn.addUsage`) so cost caps and budgets see it.
 *
 *   bun examples/subagent-tool.ts
 *
 * A ready-made `subagent()` plugin is on the roadmap; the core pieces are all here.
 */
import { type LanguageModelUsage, readUIMessageStream, tool } from 'ai'
import { defineHarnessAgent } from 'eharness'
import { z } from 'zod/v4'
import { exampleModel } from './shared/model.ts'

const researcher = defineHarnessAgent({
  id: 'researcher',
  model: exampleModel([{ text: 'Finding: UUIDv7 ids sort by creation time.' }]),
  contextWindow: 200_000,
  instructions: 'You research one question and answer with short findings.',
})

const usageOf = (u: { inputTokens: number; outputTokens: number }): LanguageModelUsage => ({
  inputTokens: u.inputTokens,
  inputTokenDetails: {
    noCacheTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  },
  outputTokens: u.outputTokens,
  outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  totalTokens: u.inputTokens + u.outputTokens,
})

const agent = defineHarnessAgent({
  id: 'lead',
  model: exampleModel([
    { toolCalls: [{ toolName: 'research', input: { question: 'How do eharness ids sort?' } }] },
    { text: 'They sort by creation time (UUIDv7), per the research.' },
  ]),
  contextWindow: 200_000,
  tools: {
    // A function input receives the session context once per session (spec 01 §4).
    research: (ctx) =>
      tool({
        description: 'Delegate one research question to a researcher subagent.',
        inputSchema: z.object({ question: z.string() }),
        // An async generator streams preliminary results; the last value is the final output.
        async *execute({ question }, { toolCallId, abortSignal }) {
          const turn = ctx.turn
          if (turn === undefined) {
            // expected failure: an error string the model can read, never a throw
            yield { status: 'failed', text: 'ERROR: research runs only inside a turn.' }
            return
          }
          const child = researcher.session(`${ctx.session.id}:research:${toolCallId}`, {
            parent: {
              sessionId: ctx.session.id,
              turnId: turn.id,
              toolCallId,
              depth: (ctx.session.parent?.depth ?? 0) + 1,
            },
          })
          const run = child.send(question, { abortSignal })
          let text = ''
          for await (const message of readUIMessageStream({ stream: run.stream })) {
            const next = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
            if (next === text) continue
            text = next
            yield { status: 'working' as const, text } // shown live in the parent's tool part
          }
          const result = await run.result // never rejects
          // The child's tokens (and its cost, when the researcher has `models` pricing) count
          // toward this turn's usage, `loop.maxTurnOutputTokens` and `budget`.
          turn.addUsage(usageOf(result.usage), {
            costUsd: result.usage.costUsd,
            source: 'subagent:researcher',
          })
          await researcher.closeSession(child.id)
          yield {
            status: result.stop === 'complete' ? ('done' as const) : ('failed' as const),
            text,
          }
        },
      }),
  },
})

const run = agent.session('lead-1').send('How do eharness message ids sort?')
for await (const chunk of run.stream) {
  if (chunk.type === 'tool-output-available') {
    const kind = chunk.preliminary === true ? 'preliminary' : 'final'
    console.log(`${kind}: ${JSON.stringify(chunk.output)}`)
  }
  if (chunk.type === 'text-delta') process.stdout.write(chunk.delta)
}
const result = await run.result
console.log(`\n${result.stop}; output tokens incl. the subagent: ${result.usage.outputTokens}`)
await agent.close()
await researcher.close()
