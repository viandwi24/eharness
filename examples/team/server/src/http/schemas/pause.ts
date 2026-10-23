import { z } from '@hono/zod-openapi'
import { MAX_PAUSE_NOTE_CHARS } from '../../app/pause.ts'

export const PauseViewSchema = z
  .object({
    paused: z.boolean(),
    pausedAt: z
      .number()
      .nullable()
      .openapi({ description: 'When the pause began (ms); null = running.' }),
    pausedBy: z.string().nullable(),
    note: z.string().nullable(),
    holdChannels: z.boolean().openapi({
      description:
        'Inbound chat messages are kept but do not wake an agent (answered after Resume only with `answerHeldOnResume`).',
    }),
    answerHeldOnResume: z.boolean().openapi({
      description:
        'Resume answers the held chat messages that addressed the agent (at most 12 hours old), once per conversation.',
    }),
    held: z
      .object({
        programs: z.number().int(),
        routines: z.number().int(),
        reminders: z.number().int(),
        heartbeat: z.boolean(),
        digest: z.boolean(),
        queuedTasks: z.number().int(),
        runningTurns: z.number().int(),
      })
      .openapi({ description: 'What is active now and would fire if the workspace ran.' }),
    skippedWhilePaused: z.number().int().openapi({
      description: "Runs skipped with reason 'paused' since `pausedAt` (0 when not paused).",
    }),
  })
  .openapi('WorkspacePause')

export const PauseRequestSchema = z
  .object({
    note: z.string().max(MAX_PAUSE_NOTE_CHARS).optional(),
    holdChannels: z.boolean().optional().openapi({ description: 'Default true.' }),
    answerHeldOnResume: z.boolean().optional().openapi({
      description:
        'Answer the held chat messages after Resume (default false; pausing again keeps the choice).',
    }),
    stopRunning: z.boolean().optional().openapi({
      description: 'Stop agent runs that are running now (default false: they finish).',
    }),
  })
  .openapi('WorkspacePauseRequest')
