/**
 * Type-level tests of `eharness/client` generics (0.8), checked by `tsc --noEmit` (never executed).
 *
 * @see docs/engineering/testing.md#test-layers
 */
import type { ChatTransport, UIMessage } from 'ai'
import type { AttentionItemWire } from '../http/index.ts'
import type { parseActivityEvent } from './activity-feed.ts'
import {
  type ActivityRecord,
  type AttentionList,
  type AttentionState,
  type ChatInit,
  type ChatSession,
  createAttentionList,
  createChatSession,
  createHarnessClient,
  createHarnessTransport,
} from './index.ts'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const client = createHarnessClient({ baseUrl: '/api' })

// --- createAttentionList: item and answer types infer without casts ------------------------

// defaults: the wire item and the wire answers
const byDefault = createAttentionList({ client })
type _DefaultItem = Expect<Equal<typeof byDefault, AttentionList<AttentionItemWire>>>
type _DefaultState = Expect<
  Equal<ReturnType<typeof byDefault.get>, AttentionState<AttentionItemWire>>
>

interface TaskRow {
  id: string
  sessionId: string
  taskTitle: string
}
type MyAnswer = { kind: 'question'; answers: string[] | null }

// the row type is inferred from `list`, the answer type from the annotation of the result
const custom: AttentionList<TaskRow, MyAnswer> = createAttentionList({
  client,
  list: async (): Promise<TaskRow[]> => [],
})
type _CustomItems = Expect<Equal<ReturnType<typeof custom.get>['items'], readonly TaskRow[]>>
void custom.answer({ id: 'a', sessionId: 's', taskTitle: 't' }, { kind: 'question', answers: null })
void custom.answer(
  { id: 'a', sessionId: 's', taskTitle: 't' },
  // @ts-expect-error the answer must be a MyAnswer
  { kind: 'approval', approved: true },
)
// @ts-expect-error the item must be a TaskRow (taskTitle is missing)
void custom.answer({ id: 'a', sessionId: 's' }, { kind: 'question', answers: null })

// explicit type arguments
const explicit = createAttentionList<TaskRow, MyAnswer>({
  client,
  list: async () => [],
  sessionId: 's',
})
type _ExplicitAnswer = Expect<Equal<Parameters<typeof explicit.answer>[1], MyAnswer>>

// `list` rows must have an id and a sessionId
createAttentionList({
  client,
  // @ts-expect-error a row without sessionId is not an attention key
  list: async (): Promise<Array<{ id: string }>> => [],
})

// --- client.attention.answer<Answer> ---------------------------------------------------------

// the wire answers
void client.attention.answer('a', {
  sessionId: 's',
  answer: { kind: 'approval', approved: true, remember: 'session' },
})
void client.attention.answer('a', {
  sessionId: 's',
  answer: { kind: 'client-tool', output: { ok: true } },
})
// `Answer` is inferred from the call: an app-defined kind needs no type argument ...
void client.attention.answer('a', {
  sessionId: 's',
  answer: { kind: 'question', answers: null },
})
// ... and an explicit one pins the app kind next to the wire kinds
void client.attention.answer<MyAnswer>('a', {
  sessionId: 's',
  answer: { kind: 'question', answers: ['x'] },
})
void client.attention.answer<MyAnswer>('a', {
  sessionId: 's',
  answer: { kind: 'approval', approved: false },
})
void client.attention.answer<MyAnswer>('a', {
  sessionId: 's',
  // @ts-expect-error neither a wire nor an app kind
  answer: { kind: 'nope' },
})

// --- createChatSession / transport -----------------------------------------------------------

interface MyMessage extends UIMessage {
  metadata?: { note?: string }
}
const defaultSession = createChatSession({ client, sessionId: 's' })
type _DefaultSession = Expect<Equal<typeof defaultSession, ChatSession<UIMessage>>>

const typed = createChatSession<MyMessage>({ client, sessionId: 's', messages: [] })
type _TypedSession = Expect<Equal<typeof typed, ChatSession<MyMessage>>>
type _TypedInit = Expect<Equal<typeof typed.chatInit, ChatInit<MyMessage>>>
type _TypedTransport = Expect<Equal<typeof typed.chatInit.transport, ChatTransport<MyMessage>>>
// @ts-expect-error messages must be MyMessage[]
createChatSession<MyMessage>({ client, sessionId: 's', messages: [{ nope: 1 }] })

const transport = createHarnessTransport<MyMessage>({ client, ifBusy: 'steer' })
type _Transport = Expect<Equal<typeof transport, ChatTransport<MyMessage>>>
// @ts-expect-error `queue` is not a busy policy of the transport
createHarnessTransport({ client, ifBusy: 'queue' })

// --- activity records ---------------------------------------------------------------------------

declare const record: ActivityRecord
type _Seq = Expect<Equal<typeof record.seq, number>>
type _Type = Expect<Equal<typeof record.type, string>>
type _Ids = Expect<Equal<typeof record.sessionId, string | null>>
type _Payload = Expect<Equal<typeof record.payload, Record<string, unknown>>>
// the payload is untyped data: narrow it before use
const sessionOfPayload: string | undefined =
  typeof record.payload.sessionId === 'string' ? record.payload.sessionId : undefined
void sessionOfPayload
type _Parsed = Expect<Equal<ReturnType<typeof parseActivityEvent>, ActivityRecord | undefined>>
