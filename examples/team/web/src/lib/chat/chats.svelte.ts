// One chat instance per agent, kept for the session so switching agents keeps streams and scroll state.
import { toast } from 'svelte-sonner';
import { agentsStore } from '../stores/agents.svelte.js';
import { live } from '../stores/live.svelte.js';
import { AgentChat } from './create-agent-chat.svelte.js';

const chats = new Map<string, AgentChat>();

// Turns the server starts in a DM (subagent reports, routines, agent messages, other tabs) stream
// into the open chat like the ones this tab sends.
live.onChatEvent((e) => {
	if (!e.agentId || !e.sessionId?.startsWith('dm:') || e.sessionId.split(':').length !== 2) return;
	const agent = agentsStore.find(e.agentId);
	for (const key of [e.agentId, agent?.slug, agent?.id]) {
		const c = key ? chats.get(key) : undefined;
		if (!c) continue;
		if (e.type === 'turn-started') void c.followServerTurn();
		else if (e.payload.role === 'assistant') void c.storedElsewhere();
		return;
	}
});

// After a reconnect (server restart, network): a turn may have run, ended or been recovered while the
// stream was down. Follow it if it still runs, else show what was stored.
live.onResync(() => {
	for (const c of new Set(chats.values())) if (c.loaded) void c.followServerTurn();
});
live.addBusyProbe(() => [...chats.values()].some((c) => c.busy));

/** The cached chat of an agent (created on first use). Pure: call `init()` from an effect, not from a derived. */
export function agentChat(agentId: string): AgentChat {
	let c = chats.get(agentId);
	if (!c) {
		c = new AgentChat({
			agentId,
			// the same message again replaces the toast instead of stacking another one
			notify: (level, text) => (level === 'error' ? toast.error(text, { id: text.slice(0, 80) }) : toast(text, { id: text.slice(0, 80) }))
		});
		chats.set(agentId, c);
	}
	return c;
}
