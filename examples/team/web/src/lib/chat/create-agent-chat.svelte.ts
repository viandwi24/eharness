// Per-thread chat: `@ai-sdk/svelte` `Chat` plus `createChatSession` of `eharness/client` (history
// paging, re-attach to a running turn, steering, recovery), mirrored into Svelte state. The
// library owns the logic; this class adds reactivity and the library uploads.
// `Chat` has no `resume` option (that is React's `useChat`), so resuming is `session.follow()`.
import { Chat } from '@ai-sdk/svelte';
import type { FileUIPart, UIMessage } from 'ai';
import { type ChatSession, type ChatSessionState, createChatSession, interruptedTurn } from 'eharness/client';
import { harness } from '../api/index';
import { UPLOAD_MAX_BYTES } from './constants.js';
import { uploadErrorText } from './http.js';

export type Notify = (level: 'info' | 'error', text: string) => void;

export type CreateAgentChatOptions = {
	agentId: string;
	/** The chat thread's session (`dm:<agentId>` or `chat:<agentId>:<threadId>`). */
	sessionId: string;
	/** Initial messages, when the caller already has them. Otherwise `init()` loads them. */
	messages?: UIMessage[];
	/** Toasts. */
	notify?: Notify;
	/** Page size of `GET /sessions/{id}/messages`. */
	pageSize?: number;
};

const INITIAL: ChatSessionState = { loaded: false, hasOlder: false, loadingOlder: false, following: false, notice: null, problem: null, activity: null, busy: false, stopping: false };

export class AgentChat {
	readonly chat: Chat<UIMessage>;
	readonly session: ChatSession<UIMessage>;
	readonly agentId: string;
	readonly sessionId: string;
	#s = $state.raw<ChatSessionState>(INITIAL);

	constructor(options: CreateAgentChatOptions) {
		this.agentId = options.agentId;
		this.sessionId = options.sessionId;
		this.session = createChatSession<UIMessage>({
			client: harness,
			sessionId: options.sessionId, // the session of one chat thread
			...(options.messages ? { messages: options.messages } : {}),
			...(options.pageSize ? { pageSize: options.pageSize } : {}),
			transportOptions: { ifBusy: 'steer' }, // a message sent while a turn runs joins it
			...(options.notify ? { notify: options.notify } : {})
		});
		// Every approval and question is answered through `POST /attention/{id}/answer` (see the live
		// store), never by posting the assistant message back: no `sendAutomaticallyWhen`.
		this.chat = new Chat<UIMessage>({ ...this.session.chatInit });
		this.session.bind(this.chat);
		this.session.subscribe((s) => (this.#s = s));
	}

	/** History loaded (first page). */
	get loaded(): boolean {
		return this.#s.loaded;
	}
	/** Older pages exist. */
	get hasOlder(): boolean {
		return this.#s.hasOlder;
	}
	get loadingOlder(): boolean {
		return this.#s.loadingOlder;
	}
	/** Transient banner, e.g. "Sent to the running turn". */
	get notice(): string | null {
		return this.#s.notice;
	}
	/** Reattached to a running turn / following a steered one. */
	get following(): boolean {
		return this.#s.following;
	}
	/** A failure of a turn this tab follows but did not start: shown inline, with Retry when it helps. */
	get problem(): ChatSessionState['problem'] {
		return this.#s.problem;
	}
	/** Live state of the streamed turn (`data-eh.status`, transient): e.g. `compacting`. */
	get activity(): ChatSessionState['activity'] {
		return this.#s.activity;
	}
	/** The reply this chat ended on was cut short by a dead process: Continue / Retry are offered. */
	get interrupted(): boolean {
		return interruptedTurn(this.chat.messages) !== undefined;
	}
	/**
	 * `stop()` has not been confirmed by the server yet (it may still be reachable only later): the
	 * stop button is disabled and "Stopping…" shows until it is.
	 */
	get stopping(): boolean {
		return this.#s.stopping;
	}
	/** A turn is running or being followed in this chat. */
	get busy(): boolean {
		return this.#s.following || this.chat.status === 'submitted' || this.chat.status === 'streaming';
	}

	init = (): Promise<void> => this.session.init();
	follow = (): Promise<void> => this.session.follow();
	followServerTurn = (): Promise<void> => this.session.followServerTurn();
	storedElsewhere = (): Promise<void> => this.session.storedElsewhere();
	checkStalled = (): Promise<void> => this.session.checkStalled();
	loadOlder = (): Promise<number> => this.session.loadOlder();
	refetch = (): Promise<void> => this.session.refetch();
	stop = (): Promise<void> => this.session.stop();
	continueTurn = (): Promise<void> => this.session.continueTurn();
	retryTurn = (): Promise<void> => this.session.retryTurn();
	retry = (): Promise<void> => this.session.retry();
	dismissProblem = (): void => this.session.dismissProblem();
	/** Send a user message (with already uploaded file parts). While a turn runs it is steered into it. */
	send = (text: string, files: FileUIPart[] = []): Promise<void> => this.session.send(text, files);

	/** Upload one file to the library and return the file part for the message. */
	async upload(file: { url: string; mediaType: string; filename?: string }): Promise<FileUIPart> {
		const name = file.filename ?? 'file';
		const blob = await (await fetch(file.url)).blob();
		if (blob.size > UPLOAD_MAX_BYTES) throw new Error(uploadErrorText(413, undefined, name));
		const form = new FormData();
		form.set('file', new File([blob], name, { type: file.mediaType || blob.type }));
		let res: Response;
		try {
			res = await harness.request(harness.url('/library/files'), { method: 'POST', body: form });
		} catch {
			throw new Error(`Could not upload ${name}: cannot reach the server`);
		}
		const body: unknown = await res.json().catch(() => undefined);
		if (!res.ok) throw new Error(uploadErrorText(res.status, body, name));
		const r = body as { url: string; mediaType: string };
		// show the name the person picked, not the stored `<id>-<name>` (the model gets the path next to it)
		return { type: 'file', url: r.url, mediaType: r.mediaType || file.mediaType, filename: name };
	}
}

export function createAgentChat(options: CreateAgentChatOptions): AgentChat {
	return new AgentChat(options);
}
