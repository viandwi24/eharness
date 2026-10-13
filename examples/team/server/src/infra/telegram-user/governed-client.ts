/**
 * The MTProto client as the background jobs of a user account see it: history, admin-log and dialog
 * reads go through the connection's API governor (`../channels/governor.ts`), so a flood wait seen
 * by a backfill page parks sends and tool calls too, and a send's flood wait pauses the backfill.
 * The jobs are patient: they wait for the park and the buckets instead of failing. They are not
 * audited call by call (a backfill reads thousands of pages); the Activity log shows the parks.
 */
import type { Governor } from '../channels/governor.ts'
import type { TgUserClient } from './client.ts'
import { classifyError } from './errors.ts'

export function governJobClient(
  client: TgUserClient,
  governor: Governor,
  connectionId: string,
): TgUserClient {
  const classify = (error: unknown): { retryAfterMs: number } | undefined => {
    const k = classifyError(error)
    return k.kind === 'flood' ? { retryAfterMs: k.seconds * 1000 } : undefined
  }
  const job = <T>(cls: 'read' | 'admin', action: string, op: () => Promise<T>): Promise<T> =>
    governor.call({ connectionId, cls, action, patient: true, audit: false, classify }, op)
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown
      if (typeof value !== 'function') return value
      const fn = value as (...args: unknown[]) => Promise<unknown>
      switch (prop) {
        case 'history':
          return (...args: unknown[]) => job('read', 'history', () => fn.apply(target, args))
        case 'messagesById':
          return (...args: unknown[]) => job('read', 'messages', () => fn.apply(target, args))
        case 'forumTopics':
          return (...args: unknown[]) => job('read', 'forum_topics', () => fn.apply(target, args))
        case 'listChats':
          return (...args: unknown[]) => job('read', 'list_chats', () => fn.apply(target, args))
        case 'adminLog':
          return (...args: unknown[]) => job('admin', 'admin_log', () => fn.apply(target, args))
        default:
          return (...args: unknown[]) => fn.apply(target, args)
      }
    },
  })
}
