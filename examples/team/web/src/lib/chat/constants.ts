// Server endpoints the chat talks to, in one place so they can be adjusted (P32 §7.2).
const base = (import.meta.env?.PUBLIC_API_URL as string | undefined) ?? '';

export const chatPaths = {
	/** POST: send / regenerate / respond (spec 11 §7); returns a UI message stream. */
	chat: (agentId: string): string => `${base}/api/agents/${agentId}/chat`,
	/** GET: reconnect to the running turn, optional `?from=<chunk cursor>` (spec 04 §6). */
	stream: (agentId: string): string => `${base}/api/agents/${agentId}/chat/stream`,
	/** POST: abort the running turn (a reader disconnect never aborts). */
	abort: (agentId: string): string => `${base}/api/agents/${agentId}/chat/abort`,
	/** GET: stored messages for initial render and the refetch after a continuation. */
	messages: (agentId: string): string => `${base}/api/agents/${agentId}/messages`
} as const;
