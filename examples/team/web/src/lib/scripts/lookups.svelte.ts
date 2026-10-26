// Names the script editors offer in pickers: chat connections and their chats, tables, agents,
// programs. Loaded once per page visit; a failure leaves the list empty (typing still works).
import { api } from '../api/index.js';

export type Option = { value: string; label: string; hint?: string };

export function createLookups() {
	const state = $state({
		connections: [] as Option[],
		tables: [] as Option[],
		agents: [] as Option[],
		programs: [] as Option[],
		chats: {} as Record<string, Option[]>,
		loaded: false
	});
	const loadingChats = new Set<string>();

	async function load(): Promise<void> {
		const [conns, tables, agents, programs] = await Promise.allSettled([
			api.get('/channels/connections'),
			api.get('/tables'),
			api.get('/agents'),
			api.get('/programs')
		]);
		if (conns.status === 'fulfilled')
			state.connections = conns.value.items.map((c) => ({ value: c.id, label: c.label || c.accountLabel || c.id, hint: c.transport === 'user' ? 'Telegram account' : 'Telegram bot' }));
		if (tables.status === 'fulfilled') state.tables = tables.value.tables.map((t) => ({ value: t.name, label: t.name, hint: `${t.rowCount} rows` }));
		if (agents.status === 'fulfilled') state.agents = agents.value.agents.filter((a) => !a.archivedAt).map((a) => ({ value: a.slug, label: a.name, hint: a.slug }));
		if (programs.status === 'fulfilled') state.programs = programs.value.programs.map((p) => ({ value: p.name, label: p.name, hint: p.status }));
		state.loaded = true;
	}

	/** The chats of a connection (titles first: they read well in a manifest). */
	async function chatsOf(connection: string): Promise<void> {
		if (!connection || state.chats[connection] || loadingChats.has(connection)) return;
		loadingChats.add(connection);
		try {
			const r = await api.get('/channels/connections/{id}/chats', { params: { id: connection } });
			state.chats[connection] = r.items
				.filter((n) => n.state === 'active' && n.kind !== 'space')
				.map((n) => ({ value: n.title || n.nativeId, label: n.title || n.nativeId, hint: n.kind === 'thread' ? 'topic' : n.kind === 'direct' ? 'direct chat' : n.nativeId }));
		} catch {
			state.chats[connection] = [];
		} finally {
			loadingChats.delete(connection);
		}
	}

	/** Chats of every connection (a trigger without a connection may name any chat). */
	async function allChats(): Promise<void> {
		await Promise.all(state.connections.map((c) => chatsOf(c.value)));
	}

	return { state, load, chatsOf, allChats };
}

export type Lookups = ReturnType<typeof createLookups>;
