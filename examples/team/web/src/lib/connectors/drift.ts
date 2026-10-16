// Remote MCP tools that changed on the server after chats pinned them: the texts of the Connectors page.

export interface ConnectionDrift {
	tools: number;
	sessions: number;
}

/** "3 tools changed on the server since 2 chats pinned them". */
export function driftText(d: ConnectionDrift): string {
	const tools = `${d.tools} ${d.tools === 1 ? 'tool' : 'tools'}`;
	const chats = d.sessions === 1 ? 'a chat' : `${d.sessions} chats`;
	return `${tools} changed on the server since ${chats} pinned ${d.tools === 1 ? 'it' : 'them'}`;
}

/** The toast after "Accept new definitions in all chats". */
export function acceptedText(r: { pinsCleared: number; agents: number; pending: boolean }): string {
	const head =
		r.pinsCleared === 0
			? 'Nothing was pinned: the chats will see the current definitions anyway.'
			: `Accepted the server's current definitions (${r.pinsCleared} ${r.pinsCleared === 1 ? 'chat' : 'chats'}).`;
	return r.pending ? `${head} Busy chats reload right after their turn.` : head;
}
