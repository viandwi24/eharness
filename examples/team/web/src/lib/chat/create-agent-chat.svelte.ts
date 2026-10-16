// Per-thread chat: `@ai-sdk/svelte` `Chat` plus `createChatSession` of `eharness/client` (history
// paging, re-attach to a running turn, steering, recovery), mirrored into Svelte state. The
// library owns the logic; this class adds reactivity and the library uploads.
// `Chat` has no `resume` option (that is React's `useChat`), so resuming is `session.follow()`.
import { Chat } from '@ai-sdk/svelte';
import type { FileUIPart, UIMessage } from 'ai';
import { type ChatSession, type ChatSessionState, createChatSession, interruptedTurn } from 'eharness/client';
import { loadFullOf } from './clip.js';
import { harness } from '../api/index';
import { UPLOAD_MAX_BYTES } from './constants.js';
import { uploadErrorText } from './http.js';
import { endingErrorNoticeId } from './messages.js';
import { shownChatStatus } from '../approval/offer.js';

export type Notify = (level: 'info' | 'error', text: string) => void;

export type CreateAgentChatOptions = {
	agentId: string;
	/** The chat thread's session (`dm:<agentId>` or `chat:<agentId>:<threadId>`). */
	sessionId: string;
	/** Initial messages, when the caller already has them. Otherwise `init()` loads them. */
	messages?: UIMessage[];
	/** Toasts. */
	notify?: Notify;
	/** Removes a toast by the id `notify` gave it (the first 80 characters of its text). */
	dismiss?: (id: string) => void;
	/** Page size of `GET /sessions/{id}/messages`. */
	pageSize?: number;
	/** The server clips tool outputs longer than this many characters in history pages. */
	clip?: number;
};

const INITIAL: ChatSessionState = { loaded: false, hasOlder: false, loadingOlder: false, following: false, notice: null, problem: null, activity: null, busy: false, stopping: false };

export class AgentChat {
	readonly chat: Chat<UIMessage>;
	readonly session: ChatSession<UIMessage>;
	readonly agentId: string;
	readonly sessionId: string;
	#s = $state.raw<ChatSessionState>(INITIAL);
	readonly #dismiss: ((id: string) => void) | undefined;
	/** Errors the library reported (toasts); `sendChecked` watches it for a request the server refused. */
	#errors = 0;
	#lastError = '';
	/** The error notice that already ended the chat before the request being sent: not this request's. */
	#noticeBefore: string | undefined;

	constructor(options: CreateAgentChatOptions) {
		this.agentId = options.agentId;
		this.sessionId = options.sessionId;
		this.#dismiss = options.dismiss;
		this.session = createChatSession<UIMessage>({
			client: harness,
			sessionId: options.sessionId, // the session of one chat thread
			...(options.messages ? { messages: options.messages } : {}),
			...(options.pageSize ? { pageSize: options.pageSize } : {}),
			...(options.clip ? { clip: options.clip } : {}), // clipped history pages (see ./clip.ts)
			transportOptions: { ifBusy: 'steer' }, // a message sent while a turn runs joins it
			notify: (level, text) => {
				if (level === 'error') {
					this.#errors++;
					this.#lastError = text;
				}
				options.notify?.(level, text);
				if (level === 'error') void this.#settleError(text);
			}
		});
		// Every approval and question is answered through `POST /attention/{id}/answer` (see the live
		// store), never by posting the assistant message back: no `sendAutomaticallyWhen`.
		this.chat = new Chat<UIMessage>({ ...this.session.chatInit });
		this.session.bind(this.chat);
		this.session.subscribe((s) => (this.#s = s));
	}

	/**
	 * A failed turn is shown once. The core stores an error notice for it (a row in the chat), so when
	 * that row is there the toast is dropped; a failure with no stored notice (a request that never
	 * started a turn) keeps its toast and nothing else. The chat's own error state is never shown.
	 */
	async #settleError(text: string): Promise<void> {
		this.chat.clearError();
		try {
			await this.session.refetch();
		} catch {
			this.chat.clearError();
			return;
		}
		// `Chat` calls `onError` BEFORE it sets its status to `error`, so the clear above is a no-op;
		// by now the status is `error` and the composer would stay red until the next send.
		this.chat.clearError();
		// only a notice this request produced replaces the toast; an older one at the end of the chat
		// must not swallow the message of a request the server refused
		const id = endingErrorNoticeId(this.chat.messages);
		if (id !== undefined && id !== this.#noticeBefore) this.#dismiss?.(text.slice(0, 80));
	}

	/** The chat status for the UI: a failed request is idle again (its failure is a notice and a toast). */
	get status(): ReturnType<typeof shownChatStatus<Chat<UIMessage>['status']>> {
		return shownChatStatus(this.chat.status);
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
	/** Fetch one message in full and replace it in place (a clipped tool output); undefined when the client cannot. */
	get loadFull(): ((messageId: string) => Promise<unknown>) | undefined {
		return loadFullOf(this.session);
	}
	loadOlder = (): Promise<number> => this.session.loadOlder();
	refetch = (): Promise<void> => this.session.refetch();
	stop = (): Promise<void> => this.session.stop();
	continueTurn = (): Promise<void> => this.session.continueTurn();
	retryTurn = (): Promise<void> => this.session.retryTurn();
	retry = (): Promise<void> => this.session.retry();
	dismissProblem = (): void => this.session.dismissProblem();
	/** Send a user message (with already uploaded file parts). While a turn runs it is steered into it. */
	send = (text: string, files: FileUIPart[] = []): Promise<void> => this.session.send(text, files);

	/**
	 * Like `send`, but settles when the request was accepted (the reply started streaming, or the
	 * message joined the running turn) and rejects with the server's message when it was refused: the
	 * composer then keeps the draft and attachments. A failure while the reply streams is not a
	 * refusal (the message is stored; the error shows in the chat).
	 */
	async sendChecked(text: string, files: FileUIPart[] = []): Promise<void> {
		const before = this.#errors;
		// a message sent into a turn that is already streaming (steering) has no stream of its own to wait for
		const status = (): string => this.chat.status;
		const steering = status() === 'streaming' || this.#s.following;
		this.#noticeBefore = endingErrorNoticeId(this.chat.messages);
		const t0 = Date.now();
		let settled = false;
		const done = this.send(text, files).then(
			() => void (settled = true),
			() => void (settled = true)
		);
		while (!settled && (steering ? Date.now() - t0 < 5000 : status() !== 'streaming') && this.#errors === before) await new Promise((r) => setTimeout(r, 25));
		await Promise.resolve();
		if (this.#errors !== before && (steering || status() !== 'streaming')) throw new Error(this.#lastError || 'The message was not sent');
		void done;
	}

	/**
	 * Answer the reply `messageId` again (spec 05 `regenerate`: the reply and what follows are hidden by
	 * a rewind marker). The library session wraps `send` and `retryTurn` only, so this goes through the
	 * chat directly and then resyncs with storage.
	 */
	async regenerate(messageId: string): Promise<void> {
		if (this.busy) return;
		try {
			await this.chat.regenerate({ messageId });
		} finally {
			await this.#resync();
		}
	}

	/** Replace the stored user message `messageId` and answer it (spec 05 `edit`: later messages are hidden). */
	async edit(messageId: string, text: string, files: FileUIPart[] = []): Promise<void> {
		if (this.busy) return;
		try {
			await this.chat.sendMessage({ text, ...(files.length > 0 ? { files } : {}), messageId });
		} finally {
			await this.#resync();
		}
	}

	async #resync(): Promise<void> {
		try {
			await this.session.refetch();
		} catch {
			// the next event or reload shows what is stored
		}
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
