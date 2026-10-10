// One chat instance per agent, kept for the session so switching agents keeps streams and scroll state.
import { toast } from 'svelte-sonner';
import { AgentChat } from './create-agent-chat.svelte.js';

const chats = new Map<string, AgentChat>();

export function agentChat(agentId: string): AgentChat {
	let c = chats.get(agentId);
	if (!c) {
		c = new AgentChat({
			agentId,
			notify: (level, text) => (level === 'error' ? toast.error(text) : toast(text))
		});
		chats.set(agentId, c);
	}
	void c.init();
	return c;
}
