/**
 * Drives the route handlers of `examples/next-route.ts` offline with AI SDK's own chat client
 * (`AbstractChat` is the class `useChat` wraps), over `DefaultChatTransport` — the same request
 * bodies and SSE responses a browser would exchange with a Next.js app.
 *
 *   bun examples/next-route.demo.ts
 *
 * Flow: the user asks to clean up → the agent reads a draft and wants to delete it → the turn stops
 * with `tool-pending` → the "user" approves → `sendAutomaticallyWhen` posts the answer →
 * `respond()` continues the SAME assistant message: the delete runs, then the model answers.
 */
import {
  AbstractChat,
  type ChatInit,
  type ChatState,
  DefaultChatTransport,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from 'ai'
import { agent, type ChatMessage, describePart, fs, GET, POST } from './next-route.ts'

/** A framework-free `useChat`: plain array state, resolves `finished()` on every onFinish. */
class HeadlessChat<M extends UIMessage> extends AbstractChat<M> {
  #waiters: Array<() => void> = []

  constructor(init: Omit<ChatInit<M>, 'onFinish'>) {
    const state: ChatState<M> = {
      status: 'ready',
      error: undefined,
      messages: [],
      pushMessage(message) {
        this.messages = [...this.messages, message]
      },
      popMessage() {
        this.messages = this.messages.slice(0, -1)
      },
      replaceMessage(index, message) {
        this.messages = this.messages.map((m, i) => (i === index ? message : m))
      },
      snapshot: (value) => structuredClone(value),
    }
    super({ ...init, state, onFinish: () => this.#waiters.shift()?.() })
  }

  /** Resolves when the next response has finished streaming. */
  finished(): Promise<void> {
    return new Promise((resolve) => this.#waiters.push(resolve))
  }
}

/** Route requests to the handlers like Next.js would. */
const appFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(new URL(String(input), 'http://localhost'), init)
  const url = new URL(req.url)
  if (req.method === 'POST' && url.pathname === '/api/chat') return POST(req)
  const resume = url.pathname.match(/^\/api\/chat\/([^/]+)\/stream$/)
  if (req.method === 'GET' && resume?.[1] !== undefined) {
    return GET(req, { params: Promise.resolve({ id: decodeURIComponent(resume[1]) }) })
  }
  return new Response('not found', { status: 404 })
}) as typeof fetch

const chat = new HeadlessChat<ChatMessage>({
  id: 'chat-1',
  transport: new DefaultChatTransport({ api: '/api/chat', fetch: appFetch }),
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
})

const print = (title: string) => {
  console.log(`\n# ${title}`)
  for (const message of chat.messages) {
    const lines = message.parts.map(describePart).filter((line) => line !== null)
    console.log(`${message.role}: ${lines.join(' | ')}`)
  }
}

// 1. Send a message; the turn ends waiting for approval.
let done = chat.finished()
await chat.sendMessage({ text: 'Please clean up my drafts folder.' })
await done
print('after the first request')

// 2. Approve every pending call, like the Allow button would. sendAutomaticallyWhen posts it.
done = chat.finished()
for (const part of chat.lastMessage?.parts ?? []) {
  if (isToolUIPart(part) && part.state === 'approval-requested') {
    await chat.addToolApprovalResponse({ id: part.approval.id, approved: true })
  }
}
await done
print('after approving')

// 3. Resume after the turn ended: the GET route answers 204 and the chat stays as it is.
await chat.resumeStream()

// 4. The server owns history: same assistant message id, one continued message.
const stored = await agent.session('chat-1').messages()
const [clientAssistant, storedAssistant] = [chat.lastMessage, stored.at(-1)]
console.log(`\nstored messages: ${stored.length} (client: ${chat.messages.length})`)
console.log(
  `same assistant id on client and server: ${clientAssistant?.id === storedAssistant?.id}`,
)
console.log(`stop: ${storedAssistant?.metadata?.eharness?.stop}`)
console.log(`/drafts/old.md exists: ${(await fs.read('/drafts/old.md')) !== null}`)
await agent.close()
