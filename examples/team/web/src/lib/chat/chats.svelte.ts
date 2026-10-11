// One chat instance per thread session, kept for the page so switching threads or agents keeps streams and scroll state.
import { toast } from 'svelte-sonner';
import { live } from '../stores/live.svelte.js';
import { chatSessionAgent } from '../threads/model.js';
import { AgentChat } from './create-agent-chat.svelte.js';

const chats = new Map<string, AgentChat>();

// Turns the server starts in a thread (subagent reports, routines, agent messages, other tabs) stream
// into the open chat like the ones this tab sends. Child sessions of delegations are not chats.
live.onChatEvent((e) => {
	if (!e.agentId || !e.sessionId || !chatSessionAgent(e.sessionId)) return;
	const c = chats.get(e.sessionId);
	if (!c) return;
	if (e.type === 'turn-started') void c.followServerTurn();
	else if (e.payload.role === 'assistant') void c.storedElsewhere();
});

// After a reconnect (server restart, network): a turn may have run, ended or been recovered while the
// stream was down. Follow it if it still runs, else show what was stored.
live.onResync(() => {
	for (const c of chats.values()) if (c.loaded) void c.followServerTurn();
});
live.addBusyProbe(() => [...chats.values()].some((c) => c.busy));

/** The cached chat of a thread (created on first use). Pure: call `init()` from an effect, not from a derived. */
export function agentChat(agentId: string, sessionId: string): AgentChat {
	let c = chats.get(sessionId);
	if (!c) {
		c = new AgentChat({
			agentId,
			sessionId,
			// the same message again replaces the toast instead of stacking another one
			notify: (level, text) => (level === 'error' ? toast.error(text, { id: text.slice(0, 80) }) : toast(text, { id: text.slice(0, 80) }))
		});
		chats.set(sessionId, c);
	}
	return c;
}
