import { getContext, setContext } from 'svelte';
import { api } from '#lib/api/index.js';
import type { ChannelConnection } from './model';

/** The connection a Channels detail page shows, kept fresh by the layout (there is no push for transport state). */
export class ConnectionState {
	conn = $state<ChannelConnection | null>(null);
	error = $state('');
	notFound = $state(false);
	loaded = $state(false);
	#seq = 0;

	constructor(readonly id: () => string) {}

	async load(): Promise<void> {
		const mine = ++this.#seq;
		const id = this.id();
		try {
			const c = await api.get('/channels/connections/{id}', { params: { id } });
			if (mine !== this.#seq) return;
			this.conn = c;
			this.error = '';
			this.notFound = false;
		} catch (e) {
			if (mine !== this.#seq) return;
			const status = (e as { status?: number }).status;
			this.notFound = status === 404;
			this.error = e instanceof Error ? e.message : 'Could not load the channel';
		} finally {
			if (mine === this.#seq) this.loaded = true;
		}
	}

	reset(): void {
		this.#seq++;
		this.conn = null;
		this.loaded = false;
		this.error = '';
		this.notFound = false;
	}
}

const KEY = Symbol('channel-connection');
export const provideConnection = (c: ConnectionState): ConnectionState => setContext(KEY, c);
export const useConnection = (): ConnectionState => getContext<ConnectionState>(KEY);
