import { z } from '@hono/zod-openapi'

export const SecretStatusSchema = z
  .object({
    set: z.boolean().openapi({ description: 'A value is stored.' }),
    hint: z.string().optional().openapi({
      description: 'A short tail of the value (`…1234`) so a person can tell keys apart.',
    }),
  })
  .openapi('SecretStatus')

const FieldOption = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
  label: z.string(),
})

export const ProviderFieldSchema = z
  .object({
    path: z.string().openapi({ description: 'Dotted path in the settings object.' }),
    kind: z.enum(['string', 'number', 'integer', 'boolean', 'enum', 'record', 'array', 'json']),
    widget: z
      .enum(['password', 'textarea', 'keyvalue', 'radio', 'select'])
      .optional()
      .openapi({ description: 'Suggested input; absent = the default of the kind.' }),
    label: z.string(),
    description: z.string().optional(),
    required: z.boolean(),
    secret: z.boolean().openapi({
      description:
        'The value is a secret: shown as `{ set, hint }`, kept when an edit omits it, sent as plain text only when changed.',
    }),
    secretValues: z.boolean().openapi({
      description: 'A `keyvalue` field whose values are secrets (header values).',
    }),
    options: z.array(FieldOption).optional(),
    default: z.unknown().optional(),
    group: z.enum(['auth', 'endpoint', 'advanced']).openapi({
      description: 'Where the field goes in the form; `advanced` is collapsed by default.',
    }),
    showWhen: z
      .object({
        field: z.string(),
        equals: z.unknown().optional(),
        in: z.array(z.unknown()).optional(),
      })
      .optional()
      .openapi({ description: 'Show the field only while another field has this value.' }),
    placeholder: z.string().optional(),
    envHint: z
      .string()
      .optional()
      .openapi({ description: 'Environment variable that can supply it.' }),
    format: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .openapi('ProviderField')

export const ProviderDefinitionSchema = z
  .object({
    id: z.string().openapi({ example: 'openrouter' }),
    label: z.string().openapi({ example: 'OpenRouter' }),
    doc: z.string().optional().openapi({ description: 'Documentation URL.' }),
    defaultModel: z.string().optional(),
    fields: z.array(ProviderFieldSchema).openapi({
      description: 'The settings form, in display order. Render it with any form component.',
    }),
    jsonSchema: z.record(z.string(), z.unknown()).openapi({
      description: 'JSON Schema of the settings (input shape) the fields were derived from.',
    }),
    envMap: z.record(z.string(), z.string()).openapi({
      description: 'Settings field -> environment variable that creates a read-only `env` profile.',
    }),
    canListModels: z.boolean(),
  })
  .openapi('ProviderDefinition')

const ProfileModels = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    extra: z
      .array(z.object({ id: z.string(), name: z.string().optional() }).passthrough())
      .optional(),
  })
  .openapi('ProfileModels', {
    description:
      'Model policy of a profile. `allow` / `deny` entries may use `*`; `extra` adds models by hand (with `contextWindow`, `pricing`).',
  })

export const ProfileSchema = z
  .object({
    id: z.string().openapi({ example: 'openrouter-2' }),
    definitionId: z
      .string()
      .openapi({ description: 'The provider definition (`GET /providers`).' }),
    label: z.string(),
    enabled: z.boolean(),
    source: z.enum(['env', 'store']).openapi({
      description:
        '`env`: created from environment variables, read-only. `store`: saved in the database, secrets encrypted.',
    }),
    settings: z.record(z.string(), z.unknown()).openapi({
      description:
        'The settings with every secret replaced by `{ set, hint? }` (headers: one per key).',
      example: { apiKey: { set: true, hint: '…a1b2' } },
    }),
    models: ProfileModels.optional(),
    updatedAt: z.number().int(),
    isDefault: z.boolean().openapi({
      description: 'The profile agents without their own pick use.',
    }),
    defaultModel: z.string().optional().openapi({
      description:
        'The model an agent on this profile uses when it names none (`TEAM_MODEL` on the env default profile, else the provider default).',
    }),
  })
  .openapi('ProviderProfile')

export const ProvidersSchema = z
  .object({
    providers: z.array(ProviderDefinitionSchema),
    profiles: z.array(ProfileSchema),
  })
  .openapi('Providers')

export const ProfileCreateSchema = z
  .object({
    providerId: z.string().min(1).openapi({ description: 'A definition id of `GET /providers`.' }),
    id: z.string().min(1).max(64).optional().openapi({
      description:
        'Profile id: letters, digits, `.`, `_`, `-`; no `:`. Default: the provider id, then `-2`, `-3`, ...',
    }),
    label: z.string().min(1).max(80).optional(),
    settings: z.record(z.string(), z.unknown()).optional().openapi({
      description: 'Settings by the definition fields; secrets in plain text (stored encrypted).',
    }),
    enabled: z.boolean().optional(),
  })
  .openapi('ProviderProfileCreate')

export const ProfilePatchSchema = z
  .object({
    label: z.string().min(1).max(80).optional(),
    settings: z.record(z.string(), z.unknown()).optional().openapi({
      description:
        'A patch: omitted fields keep their value. A secret given as `""` or `{ "keep": true }` keeps the stored one; `null` removes a field; a header key sent as `""` / `{ keep: true }` keeps its stored value and keys left out are dropped.',
    }),
    enabled: z.boolean().optional(),
    models: ProfileModels.nullable()
      .optional()
      .openapi({ description: '`null` clears the policy.' }),
  })
  .openapi('ProviderProfilePatch')

export const ModelSchema = z
  .object({
    id: z.string().openapi({ example: 'anthropic/claude-sonnet-5.5' }),
    name: z.string(),
    description: z.string().optional(),
    contextWindow: z.number().optional().openapi({ description: 'Tokens.' }),
    maxOutputTokens: z.number().optional(),
    pricing: z
      .object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number().optional(),
        cacheWrite: z.number().optional(),
      })
      .optional()
      .openapi({ description: 'USD per 1M tokens.' }),
    reasoning: z.boolean().optional(),
    tools: z.boolean().optional().openapi({ description: 'Supports tool calling.' }),
    source: z.enum(['extra', 'live', 'catalog']).openapi({
      description:
        'Where the entry comes from: added by hand, the provider API, or the public catalog.',
    }),
    enabled: z.boolean().optional().openapi({
      description:
        "Only with `all=true`: false when the profile's `models.allow` / `models.deny` hides the model (agents cannot pick it).",
    }),
  })
  .openapi('ProviderModel')

export const ModelListSchema = z
  .object({ models: z.array(ModelSchema) })
  .openapi('ProviderModelList')

export const TestResultSchema = z
  .object({
    ok: z.boolean(),
    message: z.string().optional().openapi({ description: 'Never contains a secret.' }),
    latencyMs: z.number().optional(),
  })
  .openapi('ProviderTestResult')

export const ProfileIdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'id', in: 'path' },
      example: 'openrouter',
      description: 'Provider profile id.',
    }),
})

export const ModelsQuery = z.object({
  refresh: z
    .enum(['true', 'false'])
    .optional()
    .openapi({ description: 'Ask the provider again instead of using the 5 minute cached list.' }),
  all: z.enum(['true', 'false']).optional().openapi({
    description:
      "`true` also lists the models the profile's allow / deny hides, each with `enabled` (for the model toggles). Default: only the models agents can pick.",
  }),
})
