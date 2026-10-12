import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import type { Deps } from '../../app/ports.ts'
import {
  ChannelActivityPageSchema,
  ChannelActivityQuery,
  ChannelAdminLogBodySchema,
  ChannelAdminLogRunSchema,
  ChannelBackfillBodySchema,
  ChannelBindBodySchema,
  ChannelChatListSchema,
  ChannelChatParam,
  ChannelChatSchema,
  ChannelConnectionListSchema,
  ChannelConnectionSchema,
  ChannelConversationLogSchema,
  ChannelIdParam,
  ChannelIgnoreBodySchema,
  ChannelInboxPageSchema,
  ChannelInboxQuery,
  ChannelLimitsBodySchema,
  ChannelLinkBodySchema,
  ChannelLinkListSchema,
  ChannelLinkParam,
  ChannelLinkSchema,
  ChannelMemberListSchema,
  ChannelMessagesQuery,
  ChannelPolicyBodySchema,
  ChannelSelectBodySchema,
  ChannelTopicQuery,
  ChannelUnlinkedListSchema,
  ChannelUnlinkedQuery,
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
  description: 'Platform accounts linked to team members.',
  security,
  request: { params: ChannelIdParam },
  responses: {
    200: { description: 'Links', content: content(ChannelLinkListSchema) },
    404: jsonError('Unknown connection'),
    ...errorResponses,
  },
})
const members = createRoute({
  method: 'get',
  path: '/channels/connections/{id}/members',
  tags,
  summary: 'Team members an account can be linked to',
  security,
  request: { params: ChannelIdParam },
  responses: {
    200: { description: 'Members', content: content(ChannelMemberListSchema) },
    404: jsonError('Unknown connection'),
    ...errorResponses,
  },
})
const unlinkedList = createRoute({
  method: 'get',
  path: '/channels/connections/{id}/unlinked',
  tags,
  summary: 'People who wrote and are not linked yet',
  description:
    'Every direct message from somebody who is not linked is recorded here (who and how often, never what they wrote) and gets no answer unless the connection replies to unknown people. Link them to a team member or ignore them.',
  security,
  request: { params: ChannelIdParam, query: ChannelUnlinkedQuery },
  responses: {
    200: { description: 'People', content: content(ChannelUnlinkedListSchema) },
    404: jsonError('Unknown connection'),
    ...errorResponses,
  },
})
const linkCreate = createRoute({
  method: 'post',
  path: '/channels/connections/{id}/links',
  tags,
  summary: 'Link an account to a team member',
  description:
    'Links a platform user id to a team member (the person from "Not linked yet", or an id you know). Only linked people reach the agent by direct message.',
  security,
  request: {
    params: ChannelIdParam,
    body: { required: true, content: content(ChannelLinkBodySchema) },
  },
  responses: {
    200: { description: 'The link', content: content(ChannelLinkSchema) },
    404: jsonError('Unknown connection'),
    ...errorResponses,
  },
})
const ignoreSet = createRoute({
  method: 'put',
  path: '/channels/connections/{id}/unlinked/{peerId}/ignored',
  tags,
  summary: 'Ignore (or stop ignoring) an unlinked person',
  description: 'An ignored person is hidden from "Not linked yet" and still gets no answers.',
  security,
  request: {
    params: ChannelLinkParam,
    body: { required: true, content: content(ChannelIgnoreBodySchema) },
  },
  responses: {
    204: { description: 'Done' },
    404: jsonError('Unknown person'),
    ...errorResponses,
  },
})
const inboxList = createRoute({
  method: 'get',
  path: '/channels/connections/{id}/inbox',
  tags,
  summary: 'Conversations of a connection',
  description:
    'Groups, topics and direct messages the connection has seen, most recently active first: title, kind, the agent, a preview of the last stored message, counters (woke / observed / dropped) and the allowlist state.',
  security,
  request: { params: ChannelIdParam, query: ChannelInboxQuery },
  responses: {
    200: { description: 'Conversations', content: content(ChannelInboxPageSchema) },
    404: jsonError('Unknown connection'),
    ...errorResponses,
  },
})
const inboxMessages = createRoute({
  method: 'get',
  path: '/channels/connections/{id}/inbox/messages',
  tags,
  summary: 'The channel log of a conversation',
  description:
    'The stored messages of a conversation (incoming ones including observe-only, the replies of the agent, approval requests with their outcome, edits and deletions marked), oldest first within a page, newest page first. The log is sealed at rest and decrypted here for the holder of the web token.',
  security,
  request: { params: ChannelIdParam, query: ChannelMessagesQuery },
  responses: {
    200: { description: 'A page of the log', content: content(ChannelConversationLogSchema) },
    404: jsonError('Unknown connection or conversation'),
    ...errorResponses,
  },
})
const activityList = createRoute({
  method: 'get',
  path: '/channels/connections/{id}/activity',
  tags,
  summary: 'Activity of a connection',
  description:
    'Events newest first: messages received (woke the agent, observed, dropped with a reason), replies queued, sent, retried or failed, approvals posted and answered, the outbound breaker, needs-auth. Metadata only: no message text. Filter by type or conversation; page with `before`.',
  security,
  request: { params: ChannelIdParam, query: ChannelActivityQuery },
  responses: {
    200: { description: 'Events', content: content(ChannelActivityPageSchema) },
    404: jsonError('Unknown connection'),
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
  const inbox = deps.channelInbox
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
    .openapi(members, async (c) =>
      c.json({ items: await inbox.members(c.req.valid('param').id) }, 200),
    )
    .openapi(unlinkedList, async (c) =>
      c.json(
        {
          items: await inbox.unlinked(c.req.valid('param').id, {
            includeIgnored: c.req.valid('query').includeIgnored === 'true',
          }),
        },
        200,
      ),
    )
    .openapi(linkCreate, async (c) => {
      const { name, ...rest } = c.req.valid('json')
      return c.json(
        await inbox.link(c.req.valid('param').id, {
          ...rest,
          ...(name === undefined ? {} : { name }),
        }),
        200,
      )
    })
    .openapi(ignoreSet, async (c) => {
      const { id, peerId } = c.req.valid('param')
      await inbox.ignore(id, peerId, c.req.valid('json').ignored)
      return c.body(null, 204)
    })
    .openapi(inboxList, async (c) => {
      const { limit, cursor } = c.req.valid('query')
      return c.json(
        await inbox.inbox(c.req.valid('param').id, {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        }),
        200,
      )
    })
    .openapi(inboxMessages, async (c) => {
      const { conversationId, limit, before } = c.req.valid('query')
      return c.json(
        await inbox.conversation(c.req.valid('param').id, conversationId, {
          limit,
          ...(before === undefined ? {} : { before }),
        }),
        200,
      )
    })
    .openapi(activityList, async (c) => {
      const { type, conversationId, before, limit } = c.req.valid('query')
      return c.json(
        await inbox.activity(c.req.valid('param').id, {
          limit,
          ...(type === undefined ? {} : { type }),
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(before === undefined ? {} : { before }),
        }),
        200,
      )
    })
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
