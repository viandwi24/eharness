import { z } from '@hono/zod-openapi'
import { TEAM_MODES } from '../../app/catalog.ts'

const Mode = z.enum(TEAM_MODES)

export const ModeStateSchema = z
  .object({
    mode: Mode.openapi({
      description:
        'The mode the next tool call runs under. `manual`: risky tools ask a person. `auto`: rules first, then a classifier model allows or blocks (3 blocks in a row or 20 in total pause it and calls ask again). `bypass`: everything runs; deny rules and protected paths still apply.',
    }),
    source: z.enum(['chat', 'parent', 'agent', 'workspace']).openapi({
      description:
        "`chat`: picked for this chat. `agent`: the agent's own mode. `workspace`: the Settings default.",
    }),
    agentMode: z.enum(['inherit', ...TEAM_MODES]).openapi({
      description:
        "The agent's own mode (`inherit` = the workspace default). It is also the loosest mode its sessions may run in: an agent pinned to `manual` cannot be set to `auto` or `bypass`.",
    }),
    workspaceDefault: Mode,
    available: z.array(Mode).openapi({
      description:
        'Modes `PUT` accepts now (the agent ceiling and classifier availability applied).',
    }),
    autoAvailable: z.boolean().openapi({
      description:
        'False when the server has no classifier model (an offline scripted model): Auto is not offered.',
    }),
    auto: z
      .object({
        paused: z.boolean().openapi({
          description:
            'Auto was paused by repeated blocks: calls ask a person until one is approved (or Auto is picked again).',
        }),
        consecutive: z.number().int(),
        total: z.number().int(),
      })
      .openapi({ description: 'Block counters of the live session on this instance.' }),
  })
  .openapi('ModeState')

export const ModePutSchema = z.object({ mode: Mode }).openapi('ModePut')
