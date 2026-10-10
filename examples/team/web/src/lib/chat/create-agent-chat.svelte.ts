// Per-agent chat on top of `@ai-sdk/svelte` `Chat` for eharness (P32 §7.2).
// Verified against @ai-sdk/svelte 5.0.137 / ai 7.0.x: `Chat` extends `AbstractChat` and takes `ChatInit`
// (id, messages, transport, sendAutomaticallyWhen, onError, ...). There is NO `resume` option on the
// Svelte class (that is a React `useChat` option), so resuming is an explicit `chat.resumeStream()`.
import { Chat } from '@ai-sdk/svelte';
import {
	DefaultChatTransport,
	type FileUIPart,
	lastAssistantMessageIsCompleteWithApprovalResponses,
	type UIMessage
} from 'ai';
import { getToken } from '../api/index';
import { chatPaths, UPLOAD_MAX_BYTES } from './constants.js';
import {
	buildChatRequest,
	ChatBusyError,
	classifyChatResponse,
	emptyStreamResponse,
	type MessagesPage,
	mergeOlder,
	replaceTail,
	shouldResume,
	type StatsLike,
	uploadErrorText
} from './http.js';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type Notify = (level: 'info' | 'error', text: string) => void;

export type CreateAgentChatOptions = {
	agentId: string;
	/** Initial messages, when the caller already has them. Otherwise `init()` loads them. */
	messages?: UIMessage[];
	/** Override endpoints (defaults to `chatPaths`). */
	paths?: Partial<typeof chatPaths>;
	fetch?: FetchFn;
	/** Toasts. */
	notify?: Notify;
	/** Page size of `GET /messages`. */
	pageSize?: number;
};

const PAGE = 50;

export class AgentChat {
	readonly chat: Chat<UIMessage>;
	readonly agentId: string;
	/** History loaded (first page). */
	loaded = $state(false);
	/** Older pages exist (`nextBefore` from the server). */
	hasOlder = $state(false);
	loadingOlder = $state(false);
	/** Transient banner, e.g. "Sent to the running turn". */
	notice = $state<string | null>(null);
	/** Reattached to a running turn / following a steered one. */
	following = $state(false);

	#nextBefore: string | null = null;
	#paths: typeof chatPaths;
	#fetch: FetchFn;
	#notify: Notify;
	#pageSize: number;
	#initPromise: Promise<void> | undefined;

	constructor(options: CreateAgentChatOptions) {
		this.agentId = options.agentId;
		this.#paths = { ...chatPaths, ...options.paths };
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#notify = options.notify ?? (() => {});
		this.#pageSize = options.pageSize ?? PAGE;
		const agentId = options.agentId;

		const transport = new DefaultChatTransport<UIMessage>({
			api: this.#paths.chat(agentId),
			fetch: ((input: RequestInfo | URL, init?: RequestInit) => this.#chatFetch(input, init)) as typeof fetch,
			// Spec 11 §7: the server reads only the last message (plus trigger / messageId); never ship history.
			prepareSendMessagesRequest: ({ id, messages, trigger, messageId }) =>
				buildChatRequest({ id, messages, trigger, messageId }),
			prepareReconnectToStreamRequest: () => ({ api: this.#paths.stream(agentId) })
		});

		this.chat = new Chat<UIMessage>({
			id: agentId,
			messages: options.messages,
			transport,
			sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
			onError: (e) => this.#onError(e),
			// After a respond() continuation ends the stored message is the truth: refetch it.
			onFinish: ({ message, isAbort, isError }) => {
				if (!this.following) this.notice = null;
				if (isAbort || isError) return;
				if (message.role === 'assistant' && message.parts.some((p) => 'approval' in p)) void this.refetch();
			}
		});
		if (options.messages) this.loaded = true;
	}

	/** Auth header on every request; the chat POST also gets the 202 / 409 handling. */
	#authed(init: RequestInit | undefined): RequestInit {
		const headers = new Headers(init?.headers);
		const token = getToken();
		if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
		return { ...init, headers };
	}

	async #chatFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const res = await this.#fetch(input, this.#authed(init));
		if (res.ok && res.status !== 202) return res;
		const body: unknown = await res.json().catch(() => undefined);
		const outcome = classifyChatResponse(res.status, body);
		if (outcome.kind === 'steered') {
			this.notice = 'Sent to the running turn';
			this.#steered = true;
			return emptyStreamResponse();
		}
		if (outcome.kind === 'busy') throw new ChatBusyError(outcome.message, outcome.code);
		throw new Error(outcome.kind === 'error' ? outcome.message : 'Request failed');
	}
	#steered = false;

	#onError(e: Error): void {
		if (e instanceof ChatBusyError) {
			// The optimistic user message was never accepted: drop it and restore the stored view.
			const last = this.chat.messages.at(-1);
			if (last?.role === 'user') this.chat.messages = this.chat.messages.slice(0, -1);
			this.chat.clearError();
			this.#notify('error', e.message);
			return;
		}
		this.#notify('error', e.message || 'Something went wrong');
	}

	async #getJson<T>(url: string): Promise<T | undefined> {
		try {
			const res = await this.#fetch(url, this.#authed(undefined));
			if (!res.ok) return undefined;
			return (await res.json()) as T;
		} catch {
			return undefined;
		}
	}

	async #page(before?: string): Promise<MessagesPage | undefined> {
		const q = new URLSearchParams({ limit: String(this.#pageSize) });
		if (before) q.set('before', before);
		return this.#getJson<MessagesPage>(`${this.#paths.messages(this.agentId)}?${q}`);
	}

	/** Load history, then reattach when a turn runs (here or on another instance). Idempotent. */
	init(): Promise<void> {
		this.#initPromise ??= this.#init();
		return this.#initPromise;
	}

	async #init(): Promise<void> {
		if (!this.loaded) {
			const page = await this.#page();
			if (page) {
				this.chat.messages = replaceTail(this.chat.messages, page.messages);
				this.#nextBefore = page.nextBefore;
				this.hasOlder = page.nextBefore !== null;
			} else {
				this.#notify('error', 'Could not load the conversation');
			}
			this.loaded = true;
		}
		const stats = await this.#getJson<StatsLike>(this.#paths.stats(this.agentId));
		if (shouldResume(stats)) await this.follow();
	}

	/** Attach to the running turn (replay then follow), then align with storage. */
	async follow(): Promise<void> {
		if (this.following) return;
		this.following = true;
		try {
			await this.chat.resumeStream();
		} catch (e) {
			this.#onError(e as Error);
		} finally {
			this.following = false;
		}
		await this.refetch();
		// A failed resume leaves the chat in `error`: storage is the truth now, so go back to ready.
		if (this.chat.status === 'error') this.chat.clearError();
	}

	/**
	 * A turn this tab did not start (a subagent report woke the agent, a routine, another agent's
	 * message, another tab): attach to its stream. The event can arrive a moment before the turn's
	 * stream is readable, so check a few times.
	 */
	async followServerTurn(): Promise<void> {
		if (!this.loaded || this.#busy()) return;
		for (let i = 0; i < 4; i++) {
			const stats = await this.#getJson<StatsLike>(this.#paths.stats(this.agentId));
			if (this.#busy()) return;
			if (shouldResume(stats)) return this.follow();
			await new Promise((r) => setTimeout(r, 250 * (i + 1)));
		}
		await this.refetch(); // it already ended: show what was stored
	}

	/** A message was stored in this chat by a turn this tab is not streaming: show it. */
	async storedElsewhere(): Promise<void> {
		if (!this.loaded || this.#busy()) return;
		await this.refetch();
	}

	#busy(): boolean {
		const s = this.chat.status;
		return this.following || s === 'submitted' || s === 'streaming';
	}

	/** Load the next older page (scroll-up pagination). Returns the number of messages added. */
	async loadOlder(): Promise<number> {
		if (this.loadingOlder || this.#nextBefore === null) return 0;
		this.loadingOlder = true;
		try {
			const page = await this.#page(this.#nextBefore);
			if (!page) {
				this.#notify('error', 'Could not load older messages');
				return 0;
			}
			const before = this.chat.messages.length;
			this.chat.messages = mergeOlder(this.chat.messages, page.messages);
			this.#nextBefore = page.nextBefore;
			this.hasOlder = page.nextBefore !== null;
			return this.chat.messages.length - before;
		} finally {
			this.loadingOlder = false;
		}
	}

	/** Reload the newest page (after a continuation or a steered turn); older pages stay. */
	async refetch(): Promise<void> {
		const page = await this.#page();
		if (!page) return;
		this.chat.messages = replaceTail(this.chat.messages, page.messages);
		if (this.#nextBefore === null && !this.hasOlder) this.hasOlder = page.nextBefore !== null;
		if (this.#nextBefore === null) this.#nextBefore = page.nextBefore;
		this.notice = null;
	}

	/** Answer a tool approval; the turn continues automatically once every approval has an answer. */
	async approve(answer: { id: string; approved: boolean; reason?: string }): Promise<void> {
		await this.chat.addToolApprovalResponse(answer);
	}

	/** Abort the server-side turn (separate endpoint), then stop reading locally. */
	async stop(): Promise<void> {
		try {
			await this.#fetch(this.#paths.abort(this.agentId), this.#authed({ method: 'POST' }));
		} catch {
			// network failure: still stop reading
		}
		await this.chat.stop();
	}

	/** Upload one file to the library and return the file part for the message. */
	async upload(file: { url: string; mediaType: string; filename?: string }): Promise<FileUIPart> {
		const name = file.filename ?? 'file';
		const blob = await (await fetch(file.url)).blob();
		if (blob.size > UPLOAD_MAX_BYTES) throw new Error(uploadErrorText(413, undefined, name));
		const form = new FormData();
		form.set('file', new File([blob], name, { type: file.mediaType || blob.type }));
		let res: Response;
		try {
			res = await this.#fetch(this.#paths.upload(), this.#authed({ method: 'POST', body: form }));
		} catch {
			throw new Error(`Could not upload ${name}: cannot reach the server`);
		}
		const body: unknown = await res.json().catch(() => undefined);
		if (!res.ok) throw new Error(uploadErrorText(res.status, body, name));
		const r = body as { url: string; mediaType: string; name: string };
		return { type: 'file', url: r.url, mediaType: r.mediaType || file.mediaType, filename: r.name || name };
	}

	/** Message while a turn runs here: the server steers it into the turn (the open stream shows it). */
	async #steer(text: string, files: FileUIPart[]): Promise<void> {
		const message = { id: crypto.randomUUID(), role: 'user', parts: [...files, { type: 'text', text }] };
		let res: Response;
		try {
			res = await this.#fetch(
				`${this.#paths.chat(this.agentId)}?ifBusy=steer`,
				this.#authed({
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(buildChatRequest({ id: this.agentId, messages: [message as UIMessage] }).body)
				})
			);
		} catch {
			this.#notify('error', 'Cannot reach the server');
			return;
		}
		if (res.ok && res.status !== 202) {
			// 200: the server streams the running turn to this request as well; ours is already open.
			void res.body?.cancel().catch(() => {});
			this.notice = 'Sent to the running turn';
			return;
		}
		const body: unknown = await res.json().catch(() => undefined);
		const outcome = classifyChatResponse(res.status, body);
		if (outcome.kind === 'steered') this.notice = 'Sent to the running turn';
		else this.#notify('error', outcome.kind === 'busy' || outcome.kind === 'error' ? outcome.message : 'Request failed');
	}

	/** Send a user message (with already uploaded file parts). While a turn runs it is steered into it. */
	async send(text: string, files: FileUIPart[] = []): Promise<void> {
		const status = this.chat.status;
		if (status === 'submitted' || status === 'streaming') return this.#steer(text, files);
		this.#steered = false;
		await this.chat.sendMessage(files.length ? { text, files } : { text });
		if (this.#steered) {
			this.#steered = false;
			// The turn runs on another instance: follow its stream, then refetch the stored messages.
			await this.follow();
		}
	}
}

export function createAgentChat(options: CreateAgentChatOptions): AgentChat {
	return new AgentChat(options);
}
