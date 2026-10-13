import { z } from '@hono/zod-openapi'

const role = z.enum(['owner', 'admin', 'member', 'guest'])
const status = z.enum(['active', 'suspended', 'left'])

export const PersonIdParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
})
export const PersonAccountParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
  accountId: z.string().openapi({ param: { name: 'accountId', in: 'path' } }),
})

export const PersonListQuery = z.object({
  q: z.string().max(200).optional().openapi({
    description: 'Search: name, nickname, field values and platform ids.',
  }),
  page: z.coerce.number().int().min(1).default(1).openapi({ description: '1-based.' }),
  limit: z.coerce.number().int().min(1).max(100).default(25).openapi({ description: 'Page size.' }),
})

export const UnassignedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

const PersonItem = z.object({
  id: z.string(),
  displayName: z.string(),
  nickname: z.string().nullable(),
  status,
  role: role.nullable().openapi({ description: 'null: the connection or chat default applies.' }),
  divisions: z.array(z.object({ nodeId: z.string(), title: z.string() })),
  fields: z.record(z.string(), z.string()),
  accountCount: z.number().int(),
  accounts: z
    .array(
      z.object({
        platform: z.string(),
        label: z.string().nullable(),
        username: z.string().nullable(),
      }),
    )
    .openapi({ description: 'The first accounts (a preview).' }),
  updatedAt: z.number().int(),
})
export const PersonListItemSchema = PersonItem.openapi('PersonListItem')
export const PersonListSchema = z
  .object({
    items: z.array(PersonListItemSchema),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
  })
  .openapi('PersonList')

export const PersonAccountSchema = z
  .object({
    id: z.string(),
    platform: z.string(),
    nativeId: z.string().openapi({ description: "The platform's stable user id." }),
    label: z.string().nullable(),
    connectionId: z
      .string()
      .nullable()
      .openapi({ description: 'Where the account was seen; null if never.' }),
    name: z.string().nullable(),
    username: z.string().nullable(),
  })
  .openapi('PersonAccount')

export const PersonEventSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    actor: z.string().nullable(),
    detail: z.record(z.string(), z.unknown()),
    at: z.number().int(),
  })
  .openapi('PersonEvent')

export const PersonDetailSchema = PersonItem.extend({
  notes: z.string().openapi({ description: 'Staff notes; never shown to members.' }),
  memberId: z.string().nullable(),
  createdAt: z.number().int(),
  accountViews: z.array(PersonAccountSchema),
  events: z.array(PersonEventSchema).openapi({ description: 'The last 50, newest first.' }),
}).openapi('PersonDetail')

const fieldsPatch = z.record(z.string().min(1).max(60), z.string().max(500).nullable()).openapi({
  description: 'Merged into the fields; a `null` value removes the key.',
})

export const PersonCreateBodySchema = z
  .object({
    displayName: z.string().min(1).max(120),
    nickname: z.string().max(60).nullable().optional(),
    role: role.nullable().optional(),
    divisions: z.array(z.string()).optional(),
    fields: fieldsPatch.optional(),
    notes: z.string().max(4000).optional(),
  })
  .openapi('PersonCreateBody')

export const PersonPatchBodySchema = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    nickname: z.string().max(60).nullable().optional(),
    status: status.optional(),
    role: role.nullable().optional(),
    divisions: z.array(z.string()).optional(),
    fields: fieldsPatch.optional(),
    notes: z.string().max(4000).optional(),
  })
  .openapi('PersonPatchBody')

export const PersonLinkBodySchema = z
  .object({
    connectionId: z.string().min(1),
    peerId: z.string().min(1).openapi({ description: 'The platform user id of the account.' }),
    label: z.string().max(120).optional(),
  })
  .openapi('PersonLinkBody')

export const PersonLabelBodySchema = z
  .object({ label: z.string().max(120).nullable() })
  .openapi('PersonLabelBody')

export const PersonFromAccountBodySchema = z
  .object({ connectionId: z.string().min(1), peerId: z.string().min(1) })
  .openapi('PersonFromAccountBody')

export const PairingCodeSchema = z
  .object({
    code: z.string().openapi({ description: 'Shown once; stored hashed.' }),
    expiresAt: z.number().int(),
  })
  .openapi('PersonPairingCode')

export const UnassignedListSchema = z
  .object({
    items: z.array(
      z.object({
        connectionId: z.string(),
        platform: z.string(),
        peerId: z.string(),
        name: z.string().nullable(),
        username: z.string().nullable(),
      }),
    ),
  })
  .openapi('PersonUnassignedList')

export const PersonNodeListSchema = z
  .object({
    items: z.array(z.object({ id: z.string(), connectionId: z.string(), label: z.string() })),
  })
  .openapi('PersonNodeList')
