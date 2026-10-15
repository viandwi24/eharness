import { z } from '@hono/zod-openapi'

export const SessionToolsSchema = z
  .object({
    sessionId: z.string(),
    agentId: z.string(),
    configured: z
      .array(
        z.object({
          connectionId: z.string().nullable(),
          connectorId: z.string().openapi({ example: 'phone' }),
          name: z.string().openapi({ description: 'Connector name.' }),
          label: z.string().openapi({ description: 'Connection label.' }),
          tools: z.array(
            z.object({
              name: z.string(),
              mode: z.enum(['allow', 'ask', 'off']),
              chatOff: z
                .boolean()
                .openapi({ description: 'Switched off for this chat only (composer tools menu).' }),
            }),
          ),
        }),
      )
      .openapi({ description: "What the agent's current activation offers, per connection." }),
    lastCall: z
      .object({
        id: z.string().openapi({ description: 'Id of the call on the Logs page.' }),
        at: z.number().int().openapi({ description: 'Start of the call (epoch ms).' }),
        loaded: z.array(z.string()).openapi({ description: 'Tools sent with their schemas.' }),
        deferred: z
          .array(z.string())
          .openapi({ description: 'Tools listed as loadable with `tool_search`.' }),
      })
      .nullable()
      .openapi({
        description: 'Tools of the newest model call; null when unknown (see the note).',
      }),
    lastCallNote: z.string().nullable().openapi({ description: 'Why `lastCall` is null.' }),
    missing: z.array(z.string()).openapi({
      description:
        'Configured and allowed, yet neither loaded nor deferred in the last call: the red flag.',
    }),
    extra: z.array(z.string()).openapi({
      description:
        'Carried by the last call but not configured (plugin tools such as `tool_search`).',
    }),
  })
  .openapi('SessionTools')

export const ReloadResultSchema = z
  .object({
    sessions: z.number().int().openapi({ description: 'Open sessions the reload looked at.' }),
    closed: z.number().int().openapi({ description: 'Closed at once (they were idle).' }),
    pending: z.boolean().openapi({
      description: 'A session is busy: it is closed right after its running turn.',
    }),
    tools: z.array(z.string()).openapi({ description: 'Tools the agent is configured with now.' }),
  })
  .openapi('ReloadResult')
