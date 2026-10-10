// Server endpoints the chat talks to, in one place so they can be adjusted (P32 §7.2).
// Same base as `$lib/api` (`PUBLIC_API_URL`, else the `/api` dev proxy).
declare const __PUBLIC_API_URL__: string | undefined;
const base = typeof __PUBLIC_API_URL__ === 'string' && __PUBLIC_API_URL__ ? __PUBLIC_API_URL__.replace(/\/+$/, '') : '/api';

export const chatPaths = {
	/** POST: send / regenerate / respond (spec 11 §7); returns a UI message stream. */
	chat: (agentId: string): string => `${base}/agents/${agentId}/chat`,
	/** GET: reconnect to the running turn, optional `?from=<chunk cursor>` (spec 04 §6). */
	stream: (agentId: string): string => `${base}/agents/${agentId}/chat/stream`,
	/** POST: abort the running turn (a reader disconnect never aborts). */
	abort: (agentId: string): string => `${base}/agents/${agentId}/chat/abort`,
	/** GET: stored messages (`?before=&limit=`), `{ messages, nextBefore }`. */
	messages: (agentId: string): string => `${base}/agents/${agentId}/messages`,
	/** GET: stats (`running`, `activeTurn`, `pending`, usage). */
	stats: (agentId: string): string => `${base}/agents/${agentId}/stats`,
	/** POST multipart: upload into the library; the result's `url` goes into a file part. */
	upload: (): string => `${base}/library/files`
} as const;

/** Uploads: what the server accepts (images, PDF, text, Markdown, CSV, JSON), 10 MB. */
export const UPLOAD_ACCEPT = 'image/*,application/pdf,text/*,application/json,.md,.csv,.json,.txt';
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
