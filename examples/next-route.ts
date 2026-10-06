/**
 * Next.js (App Router) route handlers for `useChat`, plus the matching client code.
 *
 *   app/api/chat/route.ts             → export { POST } from this file
 *   app/api/chat/[id]/stream/route.ts → export { GET }  (useChat's default resume URL)
 *
 * The handlers use only the Fetch API (`Request` / `Response`), so the same code works in any
 * Fetch-style server (Hono, Bun.serve, Remix, SvelteKit, …). `examples/next-route.demo.ts` drives
 * them offline with AI SDK's own chat client (`AbstractChat`, the class behind `useChat`).
 */
import { getToolName, isToolUIPart } from 'ai'
import { defineHarnessAgent, handleChatRequest, type InferHarnessUIMessage } from 'eharness'
import { classifyToolResult, filesystem } from 'eharness/filesystem'
import { memoryFs } from 'eharness/filesystem/memory'
import { exampleModel } from './shared/model.ts'

/** One file system for the whole demo app; real apps resolve one per user/project (`fs: (ctx) => …`). */
export const fs = memoryFs({
  '/drafts/old.md': 'An outdated draft.\n',
  '/drafts/plan.md': '# Plan\n\n- ship 0.1.0\n',
})

export const agent = defineHarnessAgent({
  // Offline this plays: read the draft → ask to delete it (approval) → answer.
  model: exampleModel([
    { toolCalls: [{ toolName: 'read_file', input: { path: '/drafts/old.md' } }] },
    { toolCalls: [{ toolName: 'delete_file', input: { path: '/drafts/old.md' } }] },
    { text: 'Deleted /drafts/old.md; /drafts/plan.md is still there.' },
  ]),
  contextWindow: 200_000,
  instructions: 'You help the user keep their drafts folder tidy.',
  plugins: [filesystem({ fs })],
  // Human in the loop: every delete waits for the user (spec 11 §3).
  approval: { policy: { delete_file: 'user-approval' } },
})

/** The exact message type of this agent, for `useChat<ChatMessage>()` on the client. */
export type ChatMessage = InferHarnessUIMessage<typeof agent>

/**
 * POST /api/chat — `useChat`'s default request body `{ id, messages, trigger, messageId }`.
 * `handleChatRequest` turns it into send / respond (approval answers) / regenerate / edit. With
 * `ifBusy: 'steer'`, a message sent while a turn runs is delivered into that turn at the next
 * step boundary instead of failing with `EH_SESSION_BUSY`.
 */
export async function POST(req: Request): Promise<Response> {
  const body = await req.json()
  // Authenticate here and check that the user owns chat `body.id`: eharness knows only the id.
  // Per-request identity goes into the turn's `runtime` (the cached session is shared by requests).
  const session = agent.session(body.id)
  const runtime = { userId: 'demo-user' }
  return handleChatRequest(session, body, {
    ifBusy: 'steer',
    runtime,
    // The browser may declare tools for this request (`body.clientTools`) and describe the page
    // (`body.pageContext`) — both untrusted, so both are opt-in: validated, size-capped, never able
    // to shadow a server tool, and still subject to `approval` (spec 11 §7.1). A closed tab times out.
    clientTools: { allow: ['get_location', 'open_dialog'], timeoutMs: 120_000 },
    pageContext: { maxChars: 4_000 },
  }).toResponse()
}

/** GET /api/chat/[id]/stream — resume a running turn after a reload (`useChat({ resume: true })`). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  // Same ownership check as POST: the replay contains the whole running turn.
  const run = agent.session(id).attach()
  return run ? run.toResponse() : new Response(null, { status: 204 })
}

/**
 * Render one part as plain text. A React component switches on the same `part.type` values; all
 * of them are typed by `ChatMessage` (the data part payloads come from the plugin schemas).
 */
export function describePart(part: ChatMessage['parts'][number]): string | null {
  if (part.type === 'text') return part.text
  // Input that reached the running turn (a steer, a `next-step` event, hook context): show it
  // where the model saw it, inside the assistant message (ADR-0011).
  if (part.type === 'data-eh.input') return `[${part.data.source}] ${part.data.text}`
  if (part.type === 'data-filesystem.change') return `(${part.data.action} ${part.data.path})`
  if (isToolUIPart(part)) {
    const name = getToolName(part)
    switch (part.state) {
      case 'approval-requested':
        return `${name}: waiting for your approval`
      case 'output-available':
        return `${name}: ${classifyToolResult(part.output)}`
      case 'output-denied':
        return `${name}: denied`
      case 'output-error':
        return `${name}: ${part.errorText}`
      default:
        return `${name}: running…`
    }
  }
  return null
}

/*
 * Client component (app/chat.tsx). Not compiled here: the repo has no React dependency.
 *
 * 'use client'
 * import { useChat } from '@ai-sdk/react'
 * import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai'
 * import type { ChatMessage } from './api/chat/route'
 *
 * export function Chat({ id }: { id: string }) {
 *   const { messages, sendMessage, addToolApprovalResponse } = useChat<ChatMessage>({
 *     id,
 *     resume: true,                                   // GET /api/chat/[id]/stream
 *     transport: new DefaultChatTransport({ api: '/api/chat' }),
 *     // send the approval answers as soon as every pending approval has one
 *     sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
 *   })
 *   return messages.map((m) => (
 *     <div key={m.id}>
 *       {m.parts.map((part, i) => {
 *         if (part.type === 'data-eh.input') return <blockquote key={i}>{part.data.text}</blockquote>
 *         if (isToolUIPart(part) && part.state === 'approval-requested')
 *           return (
 *             <span key={i}>
 *               {getToolName(part)}?
 *               <button onClick={() => addToolApprovalResponse({ id: part.approval.id, approved: true })}>Allow</button>
 *               <button onClick={() => addToolApprovalResponse({ id: part.approval.id, approved: false, reason: 'Not now' })}>Deny</button>
 *             </span>
 *           )
 *         return <span key={i}>{describePart(part)}</span>
 *       })}
 *     </div>
 *   ))
 * }
 *
 * Frontend tools and page context (sent in the request body, stable per page for the prompt cache):
 *   transport: new DefaultChatTransport({
 *     api: '/api/chat',
 *     body: () => ({
 *       clientTools: [{ name: 'get_location', description: 'Read the browser location.',
 *                       inputSchema: { type: 'object', properties: {} } }],
 *       pageContext: [{ description: 'current page', value: location.href }],
 *     }),
 *   }),
 *   sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
 *   onToolCall: async ({ toolCall }) => {
 *     if (toolCall.toolName === 'get_location')
 *       addToolOutput({ tool: 'get_location', toolCallId: toolCall.toolCallId, output: await readLocation() })
 *   },
 *
 * History for a page load comes from the server, never from the client:
 *   const initialMessages = await agent.session(id).messages()   // → useChat({ messages })
 */
