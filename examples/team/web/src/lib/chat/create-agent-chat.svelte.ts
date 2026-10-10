// Thin wrapper over `@ai-sdk/svelte` `Chat` for eharness (P32 §7.2).
// Verified against @ai-sdk/svelte 5.0.137 / ai 7.0.x: `Chat` extends `AbstractChat` and takes `ChatInit`
// (id, messages, transport, sendAutomaticallyWhen, onError, onData, ...). There is NO `resume` option on the
// Svelte class (that is a React `useChat` option), so resuming is an explicit `chat.resumeStream()`.
import { Chat } from '@ai-sdk/svelte';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai';
import { chatPaths } from './constants.js';

export type CreateAgentChatOptions = {
	agentId: string;
	/** Initial messages (from `GET /agents/{id}/messages`). */
	messages?: UIMessage[];
	/** Reconnect to a turn that is still running on mount. Default true. */
	resume?: boolean;
	/** Chunk cursor to replay from. useChat expects a stream from 0, so leave unset unless you hold the earlier chunks. */
	from?: number;
	/** Override endpoints (defaults to `chatPaths`). */
	paths?: Partial<Pick<typeof chatPaths, 'chat' | 'stream' | 'abort' | 'messages'>>;
	fetch?: typeof globalThis.fetch;
	onError?: (error: Error) => void;
};

export type AgentChat = {
	readonly chat: Chat<UIMessage>;
	readonly agentId: string;
	/** Answer a tool approval; the turn continues automatically once every approval has an answer. */
	approve(answer: { id: string; approved: boolean; reason?: string }): Promise<void>;
	/** Abort the server-side turn (separate endpoint), then stop reading locally. */
	stop(): Promise<void>;
	/** Reload stored messages (after a `respond()` continuation, spec 11 §7 resume caveat). */
	refetch(): Promise<void>;
	send(text: string): Promise<void>;
};

export function createAgentChat(options: CreateAgentChatOptions): AgentChat {
	const { agentId } = options;
	const paths = { ...chatPaths, ...options.paths };

	const transport = new DefaultChatTransport<UIMessage>({
		api: paths.chat(agentId),
		fetch: options.fetch,
		// Spec 11 §7: the server reads only the last message (plus trigger / messageId); never ship history.
		prepareSendMessagesRequest: ({ id, messages, trigger, messageId }) => ({
			body: { id, messages: messages.slice(-1), trigger, messageId }
		}),
		prepareReconnectToStreamRequest: () => ({
			api: options.from ? `${paths.stream(agentId)}?from=${options.from}` : paths.stream(agentId)
		})
	});

	const chat = new Chat<UIMessage>({
		id: agentId,
		messages: options.messages,
		transport,
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
		onError: options.onError,
		// After a respond() continuation ends the stored message is the truth: refetch it.
		onFinish: ({ message }) => {
			if (message.role === 'assistant' && message.parts.some((p) => 'approval' in p)) void api.refetch();
		}
	});

	const api: AgentChat = {
		chat,
		agentId,
		approve: async (answer) => {
			await chat.addToolApprovalResponse(answer);
		},
		stop: async () => {
			try {
				await (options.fetch ?? fetch)(paths.abort(agentId), { method: 'POST' });
			} finally {
				await chat.stop();
			}
		},
		refetch: async () => {
			const res = await (options.fetch ?? fetch)(paths.messages(agentId));
			if (!res.ok) return;
			const body = (await res.json()) as UIMessage[] | { messages: UIMessage[] };
			chat.messages = Array.isArray(body) ? body : body.messages;
		},
		send: async (text) => {
			await chat.sendMessage({ text });
		}
	};

	if (options.resume !== false) void chat.resumeStream().catch((e: unknown) => options.onError?.(e as Error));
	return api;
}
