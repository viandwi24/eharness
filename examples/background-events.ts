/**
 * Background events and heartbeats: the application's job runner injects events into a session
 * and wakes the agent; a heartbeat with nothing to do ends "silently" (no message for the user).
 *
 *   bun examples/background-events.ts
 *
 * - A job result is a custom message kind (`messageKinds`): stored as its own message, rendered
 *   by the UI from `data-jobResult`, projected to the model as text.
 * - `inject(kind, data, { wake: true })` starts a turn when the session is idle (or delivers the
 *   event into the running turn at its next step boundary).
 * - Silent OK: the agent calls `nothing_to_report`; a `step.end` hook stops the turn with
 *   `plugin:heartbeat:silent`, and the application does not notify the user.
 *
 * Scheduling (cron, a queue, a timer) is the application's: eharness only receives the event.
 */
import { tool } from 'ai'
import { defineHarnessAgent, defineMessageKind, definePlugin } from 'eharness'
import { z } from 'zod/v4'
import { exampleModel } from './shared/model.ts'

/** Silent OK: a tool that ends the turn without an answer for the user. */
const heartbeat = definePlugin({
  name: 'heartbeat',
  setup: () => ({
    instructions:
      'On a heartbeat event, check for work that needs the user. If there is none, call ' +
      'nothing_to_report and write nothing else.',
    tools: {
      nothing_to_report: tool({
        description: 'Call when a heartbeat finds nothing that needs the user.',
        inputSchema: z.object({}),
        execute: async () => 'OK',
      }),
    },
    hooks: {
      'step.end': (_ctx, e) =>
        e.toolCalls.some((call) => call.toolName === 'nothing_to_report')
          ? { stop: 'silent' } // → stop 'plugin:heartbeat:silent'
          : undefined,
    },
  }),
})

const agent = defineHarnessAgent({
  model: exampleModel([
    // wake turn 1: the export job finished
    { text: 'Your export is ready: 1 204 rows in exports/2026-10.csv.' },
    // wake turn 2: heartbeat, nothing to do
    { toolCalls: [{ toolName: 'nothing_to_report', input: {} }] },
  ]),
  contextWindow: 200_000,
  instructions: 'You are an operations assistant.',
  messageKinds: {
    // → part type `data-jobResult`; the model sees the projection, the UI renders the data
    jobResult: defineMessageKind({
      role: 'user',
      schema: z.object({ job: z.string(), status: z.enum(['ok', 'failed']), summary: z.string() }),
      model: (d) => `<job-result job="${d.job}" status="${d.status}">${d.summary}</job-result>`,
    }),
  },
  plugins: [heartbeat],
})

const session = agent.session('ops-chat')

/** What a job runner does when a job finishes (called from your queue worker). */
async function onJobFinished(job: string, summary: string): Promise<void> {
  const { run } = await session.inject('jobResult', { job, status: 'ok', summary }, { wake: true })
  const result = await run?.result // undefined when it was delivered into a running turn
  if (result?.stop === 'complete') {
    const reply = result.messages.find((m) => m.role === 'assistant')
    const text = reply?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    console.log(`notify user: ${text}`)
  }
}

/** What a scheduler does every N minutes for this session. */
async function onHeartbeat(): Promise<void> {
  const { run } = await session.inject(
    'eh.event',
    { name: 'heartbeat', text: 'Heartbeat: anything that needs the user?' },
    { wake: true },
  )
  const result = await run?.result
  if (result === undefined) return
  if (result.stop === 'plugin:heartbeat:silent') console.log('heartbeat: silent OK, nothing sent')
  else console.log(`heartbeat: ${result.stop}, notify the user`)
}

await onJobFinished('export', 'Exported 1 204 rows to exports/2026-10.csv.')
await onHeartbeat()

const stored = await session.messages()
const kinds = stored.map((m) => m.metadata?.eharness?.kind ?? m.role)
console.log(`stored: ${kinds.join(', ')}`)
await agent.close()
