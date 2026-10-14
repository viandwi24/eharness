import { z } from '@hono/zod-openapi'
import { ProviderFieldSchema } from './providers.ts'

export const BrowserCapabilitiesSchema = z
  .object({
    snapshot: z.boolean(),
    screenshot: z.boolean(),
    liveView: z.enum(['screencast', 'poll', 'external', 'none']).openapi({
      description:
        '`screencast`: smooth frames; `poll`: about 2 frames a second; `external`: only `liveUrl` (an iframe); `none`.',
    }),
    takeover: z.boolean().openapi({ description: 'A person can click and type remotely.' }),
    tabs: z.boolean(),
    persistentProfile: z
      .boolean()
      .openapi({ description: 'The engine keeps logins across leases.' }),
  })
  .openapi('BrowserCapabilities')

export const BrowserRuntimeSchema = z
  .object({
    adapter: z.string(),
    label: z.string(),
    state: z.enum(['missing', 'installing', 'ready', 'starting', 'running', 'stopping', 'error']),
    version: z.string().optional(),
    diskBytes: z.number().int().optional().openapi({ description: 'Disk used by the engine.' }),
    progress: z
      .object({ received: z.number(), total: z.number().optional() })
      .optional()
      .openapi({ description: 'Download progress while `installing`.' }),
    running: z.array(z.string()).openapi({ description: 'Ids of profiles with a running engine.' }),
    error: z.string().optional().openapi({ description: 'Why the last download or start failed.' }),
  })
  .openapi('BrowserRuntime')

export const BrowserSystemSchema = z
  .object({ totalBytes: z.number(), freeBytes: z.number() })
  .openapi('BrowserSystemMemory')

const BrowserFormSchema = z
  .object({
    fields: z.array(ProviderFieldSchema),
    jsonSchema: z.record(z.string(), z.unknown()),
  })
  .openapi('BrowserForm', {
    description: 'The settings form of one mode: render it like a provider form.',
  })

export const BrowserAdapterSchema = z
  .object({
    id: z.string().openapi({ example: 'chrome' }),
    label: z.string(),
    description: z.string().optional(),
    modes: z.array(z.enum(['manual', 'managed'])).openapi({
      description:
        '`manual`: connect to a browser someone else runs; `managed`: this server downloads and starts it. A mode that is not offered is missing here and explained in `unavailable`.',
    }),
    capabilities: z.object({
      manual: BrowserCapabilitiesSchema.optional(),
      managed: BrowserCapabilitiesSchema.optional(),
    }),
    forms: z.object({
      manual: BrowserFormSchema.optional(),
      managed: BrowserFormSchema.optional(),
    }),
    runtime: BrowserRuntimeSchema.nullable().openapi({
      description: 'The managed runtime (download, version, size); null without a managed mode.',
    }),
    unavailable: z
      .object({ manual: z.string().optional(), managed: z.string().optional() })
      .openapi({
        description: 'Why a mode is not offered ("Managed mode is off on this server").',
      }),
  })
  .openapi('BrowserAdapter')

export const BrowserOverviewSchema = z
  .object({
    driver: z.enum(['off', 'local']).openapi({ description: '`TEAM_BROWSER_DRIVER`.' }),
    max: z.number().int().openapi({ description: '`TEAM_BROWSER_MAX`: profiles running at once.' }),
    system: BrowserSystemSchema.nullable(),
    adapters: z.array(BrowserAdapterSchema),
  })
  .openapi('BrowserOverview')

export const BrowserInfoSchema = z
  .object({
    driver: z.enum(['off', 'local']),
    max: z.number().int(),
    xvfb: z.boolean().openapi({ description: '`TEAM_BROWSER_XVFB`.' }),
    system: BrowserSystemSchema.nullable(),
    runtimes: z.array(BrowserRuntimeSchema),
    running: z.number().int().openapi({ description: 'Profiles with a running engine.' }),
    label: z.string().openapi({ description: 'One line for people.' }),
  })
  .openapi('BrowserInfo')

const ControllerSchema = z.object({
  by: z.enum(['agent', 'human']),
  holder: z.string().optional().openapi({ description: 'Viewer id of the person who took over.' }),
  since: z.number().int(),
  reason: z.string().optional().openapi({ description: 'Why the agent asked for a person.' }),
})

export const BrowserProfileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    adapter: z.string(),
    mode: z.enum(['manual', 'managed']),
    settings: z.record(z.string(), z.unknown()).openapi({
      description:
        'The settings with every secret replaced by `{ set, hint? }` (headers: one per key).',
      example: { cdpUrl: { set: true, hint: '…9222' } },
    }),
    allowDomains: z.array(z.string()).optional().openapi({
      description: 'Only these hosts may be opened (`*.example.com`); absent: any public host.',
    }),
    trusted: z.boolean().optional().openapi({
      description: 'An admin trusts the profile: its agents click and type without asking.',
    }),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    capabilities: BrowserCapabilitiesSchema.nullable(),
    state: z
      .enum(['missing', 'installing', 'ready', 'running', 'in-use', 'controlled', 'error'])
      .openapi({
        description:
          '`missing`: the managed engine is not downloaded; `ready`; `running`: the engine runs, nobody holds it; `in-use`: an agent holds it; `controlled`: a person controls it.',
      }),
    runtime: z
      .object({ state: z.string(), version: z.string().optional(), error: z.string().optional() })
      .optional(),
    lease: z
      .object({
        holder: z.object({ kind: z.enum(['session', 'person']), id: z.string() }),
        heldBy: z.object({ agentId: z.string(), name: z.string() }).optional(),
        controller: ControllerSchema,
        viewers: z.number().int(),
        since: z.number().int(),
        page: z.object({ url: z.string(), title: z.string() }).optional(),
      })
      .optional()
      .openapi({ description: 'Set while an agent or a person holds the browser.' }),
    agents: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string() })).openapi({
      description: 'Agents whose Browser connection names this profile.',
    }),
    liveUrl: z.string().optional().openapi({
      description: "A hosted provider's own live view; show it in an iframe.",
    }),
  })
  .openapi('BrowserProfile')

export const BrowserProfileCreateSchema = z
  .object({
    name: z.string().min(1).max(80),
    adapter: z.string().min(1).openapi({ example: 'chrome' }),
    mode: z.enum(['manual', 'managed']),
    settings: z.record(z.string(), z.unknown()).optional().openapi({
      description:
        'Settings by the adapter form of the mode; secrets in plain text (stored sealed).',
    }),
    allowDomains: z.array(z.string()).max(100).optional(),
    trusted: z.boolean().optional(),
  })
  .openapi('BrowserProfileCreate')

export const BrowserProfilePatchSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    settings: z.record(z.string(), z.unknown()).optional().openapi({
      description:
        'Keep-secret semantics: a secret omitted, `""` or `{ "keep": true }` keeps the stored value; a new CDP URL drops the stored header secrets.',
    }),
    allowDomains: z
      .array(z.string())
      .max(100)
      .optional()
      .openapi({ description: '`[]` clears the list.' }),
    trusted: z.boolean().optional(),
  })
  .openapi('BrowserProfilePatch')

export const BrowserDraftSchema = z
  .object({
    adapter: z.string().min(1),
    mode: z.enum(['manual', 'managed']),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('BrowserDraft', { description: 'Settings that are not saved yet ("Test connection").' })

export const BrowserTestResultSchema = z
  .object({ ok: z.boolean(), version: z.string().optional(), error: z.string().optional() })
  .openapi('BrowserTestResult', {
    description:
      'Never an error status for an unreachable browser: `ok: false` carries the reason.',
  })

export const BrowserProfileIdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'id', in: 'path' }, description: 'Browser profile id.' }),
})

export const BrowserAdapterParam = z.object({
  adapter: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'adapter', in: 'path' },
      example: 'chrome',
      description: 'Adapter id.',
    }),
})

export const BrowserUsageSchema = z
  .object({
    profiles: z.array(
      z.object({
        profileId: z.string(),
        name: z.string(),
        adapter: z.string(),
        rssBytes: z
          .number()
          .optional()
          .openapi({ description: 'Memory of the engine process tree.' }),
        cpuPercent: z.number().optional(),
      }),
    ),
    totals: z.object({ rssBytes: z.number(), cpuPercent: z.number() }),
    system: BrowserSystemSchema.optional().openapi({ description: "The server's memory." }),
  })
  .openapi('BrowserUsage')

export const BrowserShotSchema = z
  .object({
    path: z.string(),
    mediaType: z.string().nullable(),
    size: z.number().int(),
    updatedAt: z.number().int(),
    agent: z.object({ id: z.string(), name: z.string() }).nullable(),
    url: z.string().openapi({ description: 'A signed URL of the image.' }),
    expiresAt: z.number().int(),
  })
  .openapi('BrowserShot')

export const BrowserShotsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
})
