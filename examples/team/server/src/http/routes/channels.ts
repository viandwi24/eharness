import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import type { Deps } from '../../app/ports.ts'
import {
  ChannelAdminLogBodySchema,
  ChannelAdminLogRunSchema,
  ChannelBackfillBodySchema,
  ChannelBindBodySchema,
  ChannelChatListSchema,
  ChannelChatParam,
  ChannelChatSchema,
  ChannelConnectionListSchema,
  ChannelConnectionSchema,
  ChannelIdParam,
  ChannelLimitsBodySchema,
  ChannelLinkListSchema,
  ChannelLinkParam,
  ChannelPairingSchema,
  ChannelPolicyBodySchema,
  ChannelSelectBodySchema,
  ChannelTopicQuery,
  PairingBodySchema,
} from '../schemas/channels.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'

const security = [{ Bearer: [] }]
const content = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const tags = ['channels']

const connectionOk = { description: 'The connection', content: content(ChannelConnectionSchema) }

const list = createRoute({
  method: 'get',
  path: '/channels/connections',
  tags,
  summary: 'Channel connections',
  description:
    'Telegram bot connections (connect the bot on the Connectors page) with the state of the transport, the bound agent, counts and the outbound breaker. The bot token is never part of a view.',
  security,
  responses: {
    200: { description: 'Connections', content: content(ChannelConnectionListSchema) },
    ...errorResponses,
  },
})
const get = createRoute({
  method: 'get',
  path: '/channels/connections/{id}',
  tags,
  summary: 'One channel connection',
  security,
  request: { params: ChannelIdParam },
  responses: { 200: connectionOk, 404: jsonError('Unknown connection'), ...errorResponses },
})
const bind = createRoute({
  method: 'put',
  path: '/channels/connections/{id}/binding',
  tags,
  summary: 'Bind a connection to an agent',
  description:
    'Sets the agent that answers on this connection and its defaults (DM pairing, allowlist, wake and delivery defaults). Starts polling. Chats are allowed one by one (`PATCH .../chats/{chatId}/policy`) unless `groupPolicy` is `open`.',
  security,
  request: {
    params: ChannelIdParam,
    body: { required: true, content: content(ChannelBindBodySchema) },
  },
  responses: {
    200: connectionOk,
    404: jsonError('Unknown connection'),
    ...errorResponses,
  },
})
const unbind = createRoute({
  method: 'delete',
  path: '/channels/connections/{id}/binding',
  tags,
  summary: 'Remove the binding',
  description: 'Stops the transport. The connector connection and the chat history stay.',
  security,
  request: { params: ChannelIdParam },
  responses: { 200: connectionOk, 404: jsonError('Unknown connection'), ...errorResponses },
})
const chats = createRoute({
  method: 'get',
  path: '/channels/connections/{id}/chats',
  tags,
  summary: 'Known chats',
  description:
    'Groups, supergroups and channels the bot has seen (any update, or being added or removed), with the policy that applies. Discovery starts when the connection is bound and the bot is in a chat.',
  security,
  request: { params: ChannelIdParam },
  responses: {
    200: { description: 'Chats', content: content(ChannelChatListSchema) },
    404: jsonError('Unknown connection'),
    ...errorResponses,
  },
})
const policy = createRoute({
  method: 'patch',
  path: '/channels/connections/{id}/chats/{chatId}/policy',
  tags,
  summary: 'Allow a chat and set its policy',
  description:
    'Creates or changes the entry of a known chat in the allowlist: `wake` (`mention`, `always`, `never` = observe only), `delivery`, `retentionDays`, an `agentId` override. With `?topic=` the policy is of a forum topic. A `null` field clears the override.',
  security,
  request: {
    params: ChannelChatParam,
    query: ChannelTopicQuery,
    body: { required: true, content: content(ChannelPolicyBodySchema) },
  },
  responses: {
    200: { description: 'The chat', content: content(ChannelChatSchema) },
    404: jsonError('Unknown connection, chat or topic'),
    409: jsonError('The connection is not bound to an agent'),
    ...errorResponses,
  },
})
const policyRemove = createRoute({
  method: 'delete',
  path: '/channels/connections/{id}/chats/{chatId}/policy',
  tags,
  summary: 'Take a chat out of the allowlist',
  security,
  request: { params: ChannelChatParam, query: ChannelTopicQuery },
  responses: {
    200: { description: 'The chat', content: content(ChannelChatSchema) },
    404: jsonError('Unknown connection, chat or topic'),
    409: jsonError('The connection is not bound to an agent'),
    ...errorResponses,
  },
})
const links = createRoute({
  method: 'get',
  path: '/channels/connections/{id}/links',
  tags,
  summary: 'Linked accounts',
  description:
    'Telegram accounts paired with team members (employees who opened their /start link).',
  security,
  request: { params: ChannelIdParam },
  responses: {
    200: { description: 'Links', content: content(ChannelLinkListSchema) },
    404: jsonError('Unknown connection'),
    ...errorResponses,
  },
})
const pair = createRoute({
  method: 'post',
  path: '/channels/connections/{id}/pairing',
  tags,
  summary: 'Issue a pairing link for a team member',
  description:
    'A one-time `/start` deep link (valid 24 hours). The person opens it in Telegram and the account is linked; only linked accounts reach the agent by DM. The link is shown once.',
  security,
  request: {
    params: ChannelIdParam,
    body: { required: true, content: content(PairingBodySchema) },
  },
  responses: {
    200: { description: 'The link', content: content(ChannelPairingSchema) },
    404: jsonError('Unknown connection'),
    409: jsonError('Not bound, or the bot is not running'),
    ...errorResponses,
  },
})
const unlink = createRoute({
  method: 'delete',
  path: '/channels/connections/{id}/links/{peerId}',
  tags,
  summary: 'Revoke a linked account',
  security,
  request: { params: ChannelLinkParam },
  responses: { 204: { description: 'Revoked' }, 404: jsonError('Unknown link'), ...errorResponses },
})
const webhookDelete = createRoute({
  method: 'post',
  path: '/channels/connections/{id}/webhook/delete',
  tags,
  summary: 'Remove the webhook of the bot',
  description:
    'Polling refuses to start while a webhook is set. This removes it and starts polling.',
  security,
  request: { params: ChannelIdParam },
  responses: { 200: connectionOk, 404: jsonError('Unknown connection'), ...errorResponses },
})
const restart = createRoute({
  method: 'post',
  path: '/channels/connections/{id}/restart',
  tags,
  summary: 'Restart the transport',
  security,
  request: { params: ChannelIdParam },
  responses: { 200: connectionOk, 404: jsonError('Unknown connection'), ...errorResponses },
})
const breakerReset = createRoute({
  method: 'post',
  path: '/channels/connections/{id}/breaker/reset',
  tags,
  summary: 'Close the outbound breaker',
  description: 'After errors that paused sending, once the cause is fixed.',
  security,
  request: { params: ChannelIdParam },
  responses: { 200: connectionOk, 404: jsonError('Unknown connection'), ...errorResponses },
})

const chatOk = { description: 'The chat', content: content(ChannelChatSchema) }
const accountNotRunning = jsonError('The account is not running, or the chat is not chosen')
const refresh = createRoute({
  method: 'post',
  path: '/channels/connections/{id}/account/chats/refresh',
  tags,
  summary: 'Read the dialogs of a Telegram account',
  description:
    'User accounts: asks Telegram for the groups and channels the account is in and adds them to the picker (people are not listed). Needs a running connection.',
  security,
  request: { params: ChannelIdParam },
  responses: {
    200: { description: 'Chats', content: content(ChannelChatListSchema) },
    404: jsonError('Unknown connection'),
    409: accountNotRunning,
    ...errorResponses,
  },
})
const select = createRoute({
  method: 'put',
  path: '/channels/connections/{id}/account/chats/{chatId}/selected',
  tags,
  summary: 'Choose or stop ingesting a chat',
  description:
    'A chosen chat is stored and starts observe-only (`wake: never`): the agent never answers there until you change its policy.',
  security,
  request: {
    params: ChannelChatParam,
    body: { required: true, content: content(ChannelSelectBodySchema) },
  },
  responses: {
    200: chatOk,
    404: jsonError('Unknown chat'),
    409: accountNotRunning,
    ...errorResponses,
  },
})
const backfill = createRoute({
  method: 'put',
  path: '/channels/connections/{id}/account/chats/{chatId}/backfill',
  tags,
  summary: 'Set the history window of a chat',
  description:
    'Reads the history newest first down to this many days (100 messages a page, with pauses; one chat at a time). Progress is on the chat view.',
  security,
  request: {
    params: ChannelChatParam,
    body: { required: true, content: content(ChannelBackfillBodySchema) },
  },
  responses: {
    200: chatOk,
    404: jsonError('Unknown chat'),
    409: accountNotRunning,
    ...errorResponses,
  },
})
const adminLogSet = createRoute({
  method: 'put',
  path: '/channels/connections/{id}/account/chats/{chatId}/admin-log',
  tags,
  summary: 'Poll the admin log of a chat',
  description:
    'Only for chats where the account is an admin. Telegram keeps the log briefly, so it is read every few hours and stored.',
  security,
  request: {
    params: ChannelChatParam,
    body: { required: true, content: content(ChannelAdminLogBodySchema) },
  },
  responses: {
    200: chatOk,
    404: jsonError('Unknown chat'),
    409: accountNotRunning,
    ...errorResponses,
  },
})
const adminLogRun = createRoute({
  method: 'post',
  path: '/channels/connections/{id}/account/admin-log/run',
  tags,
  summary: 'Read the due admin logs now',
  security,
  request: {
    params: ChannelIdParam,
    body: { required: false, content: content(ChannelAdminLogRunSchema) },
  },
  responses: { 200: connectionOk, 404: jsonError('Unknown connection'), ...errorResponses },
})
const limitsSet = createRoute({
  method: 'put',
  path: '/channels/connections/{id}/account/limits',
  tags,
  summary: 'Outbound limits of a Telegram account',
  description:
    'Daily caps (direct messages, all messages), the admin-log interval and the per-chat and per-account send rate. Defaults are strict on purpose: a user account that sends like a robot gets limited.',
  security,
  request: {
    params: ChannelIdParam,
    body: { required: true, content: content(ChannelLimitsBodySchema) },
  },
  responses: { 200: connectionOk, 404: jsonError('Unknown connection'), ...errorResponses },
})

export function channelRoutes(deps: Deps) {
  const ch = deps.channels
  const acc = deps.channelAccounts
  return new OpenAPIHono()
    .openapi(refresh, async (c) =>
      c.json({ items: await acc.refreshChats(c.req.valid('param').id) }, 200),
    )
    .openapi(select, async (c) => {
      const { id, chatId } = c.req.valid('param')
      return c.json(await acc.selectChat(id, chatId, c.req.valid('json').selected), 200)
    })
    .openapi(backfill, async (c) => {
      const { id, chatId } = c.req.valid('param')
      return c.json(await acc.setBackfill(id, chatId, c.req.valid('json').days), 200)
    })
    .openapi(adminLogSet, async (c) => {
      const { id, chatId } = c.req.valid('param')
      return c.json(await acc.setAdminLog(id, chatId, c.req.valid('json').enabled), 200)
    })
    .openapi(adminLogRun, async (c) =>
      c.json(
        await acc.runAdminLog(c.req.valid('param').id, c.req.valid('json')?.force === true),
        200,
      ),
    )
    .openapi(limitsSet, async (c) =>
      c.json(await acc.setLimits(c.req.valid('param').id, c.req.valid('json')), 200),
    )
    .openapi(list, async (c) => c.json({ items: await ch.connections() }, 200))
    .openapi(get, async (c) => c.json(await ch.connection(c.req.valid('param').id), 200))
    .openapi(bind, async (c) =>
      c.json(await ch.bind(c.req.valid('param').id, c.req.valid('json') as never), 200),
    )
    .openapi(unbind, async (c) => c.json(await ch.unbind(c.req.valid('param').id), 200))
    .openapi(chats, async (c) => c.json({ items: await ch.chats(c.req.valid('param').id) }, 200))
    .openapi(policy, async (c) => {
      const { id, chatId } = c.req.valid('param')
      return c.json(
        await ch.setChatPolicy(
          id,
          chatId,
          c.req.valid('json') as never,
          c.req.valid('query').topic,
        ),
        200,
      )
    })
    .openapi(policyRemove, async (c) => {
      const { id, chatId } = c.req.valid('param')
      return c.json(await ch.setChatPolicy(id, chatId, null, c.req.valid('query').topic), 200)
    })
    .openapi(links, async (c) => c.json({ items: await ch.links(c.req.valid('param').id) }, 200))
    .openapi(pair, async (c) =>
      c.json(await ch.issuePairing(c.req.valid('param').id, c.req.valid('json').memberId), 200),
    )
    .openapi(unlink, async (c) => {
      const { id, peerId } = c.req.valid('param')
      await ch.revokeLink(id, peerId)
      return c.body(null, 204)
    })
    .openapi(webhookDelete, async (c) =>
      c.json(await ch.deleteWebhook(c.req.valid('param').id), 200),
    )
    .openapi(restart, async (c) => c.json(await ch.restart(c.req.valid('param').id), 200))
    .openapi(breakerReset, async (c) => c.json(await ch.resetBreaker(c.req.valid('param').id), 200))
}
