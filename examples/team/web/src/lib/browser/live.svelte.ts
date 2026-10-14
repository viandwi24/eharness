import { api, apiBase } from '../api/index';
import { type Controller, type LiveInput, liveUrl, parseFrame } from './model';

export type LiveInfo = { width: number; height: number; liveView: string; liveUrl?: string };
export type LiveStatus = 'connecting' | 'open' | 'busy' | 'closed' | 'error';

/**
 * One live-view WebSocket (`GET /browser/profiles/{id}/live`): frames go to `onFrame`, the rest is
 * reactive state. Input is refused by the server unless this socket took over.
 */
export class LiveSession {
	status = $state<LiveStatus>('connecting');
	info = $state<LiveInfo | undefined>();
	controller = $state<Controller | undefined>();
	you = $state<{ id: string; name: string; canTakeOver: boolean } | undefined>();
	message = $state('');
	/** True after `takeOver` was acknowledged and until a hand back. */
	inControl = $derived(this.controller?.by === 'human' && this.controller.holder === this.you?.id);

	#ws: WebSocket | undefined;
	#seq = 0;
	#pending = new Map<string, (r: { ok: boolean; error?: string }) => void>();
	#ping: ReturnType<typeof setInterval> | undefined;
	#lastMove = 0;

	constructor(
		readonly profileId: string,
		private onFrame: (image: Blob, size: { width: number; height: number }) => void
	) {}

	connect(): void {
		this.close();
		this.status = 'connecting';
		this.message = '';
		const attempt = ++this.#attempt;
		// a browser WebSocket cannot send the bearer token: a one-time ticket from the API carries it
		void api
			.post('/browser/profiles/{id}/live-ticket', { params: { id: this.profileId } })
			.then(
				(t) => {
					if (attempt === this.#attempt) this.#open(t.ticket);
				},
				(e: unknown) => {
					if (attempt !== this.#attempt) return;
					this.status = 'error';
					this.message = e instanceof Error ? e.message : 'Could not open the live view.';
				}
			);
	}

	#attempt = 0;

	#open(ticket: string): void {
		const ws = new WebSocket(`${liveUrl(apiBase, this.profileId, location.origin)}?ticket=${encodeURIComponent(ticket)}`);
		ws.binaryType = 'arraybuffer';
		this.#ws = ws;
		ws.onmessage = (e) => {
			if (typeof e.data === 'string') this.#text(e.data);
			else {
				const f = parseFrame(e.data as ArrayBuffer);
				if (f) this.onFrame(new Blob([f.image as BlobPart], { type: f.header.mediaType }), { width: f.header.width, height: f.header.height });
			}
		};
		ws.onclose = (e) => {
			clearInterval(this.#ping);
			if (this.#ws !== ws) return;
			if (e.code === 4409) this.status = 'busy';
			else if (this.status !== 'error' && this.status !== 'busy') this.status = 'closed';
			this.controller = this.controller?.by === 'human' && this.inControl ? { by: 'agent', since: Date.now() } : this.controller;
			for (const done of this.#pending.values()) done({ ok: false, error: 'The connection closed' });
			this.#pending.clear();
		};
		ws.onerror = () => {
			if (this.status === 'connecting') {
				this.status = 'error';
				this.message = 'Could not open the live view.';
			}
		};
		this.#ping = setInterval(() => this.#send({ type: 'ping' }), 25_000);
	}

	#text(raw: string): void {
		let m: Record<string, unknown>;
		try {
			m = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return;
		}
		switch (m.type) {
			case 'hello':
				this.info = m.info as LiveInfo;
				this.controller = m.controller as Controller;
				this.you = m.you as LiveSession['you'];
				this.status = 'open';
				break;
			case 'controller':
				this.controller = m.controller as Controller;
				break;
			case 'ack': {
				const done = this.#pending.get(String(m.id));
				this.#pending.delete(String(m.id));
				done?.({ ok: m.ok === true, ...(typeof m.error === 'string' ? { error: m.error } : {}) });
				break;
			}
			case 'error': {
				const msg = String(m.message ?? 'Error');
				const done = typeof m.id === 'string' ? this.#pending.get(m.id) : undefined;
				if (done) {
					this.#pending.delete(String(m.id));
					done({ ok: false, error: msg });
				} else this.message = msg;
				if (m.fatal === true) this.status = this.status === 'busy' ? 'busy' : 'error';
				break;
			}
			case 'closed':
				this.message = String(m.reason ?? 'The browser was released.');
				this.status = 'closed';
				break;
		}
	}

	#send(msg: object): boolean {
		if (this.#ws?.readyState !== WebSocket.OPEN) return false;
		this.#ws.send(JSON.stringify(msg));
		return true;
	}

	#command(type: 'takeOver' | 'handBack' | 'input', extra: object = {}): Promise<{ ok: boolean; error?: string }> {
		const id = `c${++this.#seq}`;
		return new Promise((resolve) => {
			this.#pending.set(id, resolve);
			if (!this.#send({ type, id, ...extra })) {
				this.#pending.delete(id);
				resolve({ ok: false, error: 'Not connected' });
			}
		});
	}

	async takeOver(): Promise<string | undefined> {
		const r = await this.#command('takeOver');
		this.message = r.ok ? '' : (r.error ?? 'Could not take control');
		return r.ok ? undefined : this.message;
	}

	async handBack(): Promise<string | undefined> {
		const r = await this.#command('handBack');
		this.message = r.ok ? '' : (r.error ?? 'Could not give the browser back');
		return r.ok ? undefined : this.message;
	}

	/** Fire and forget (moves are throttled to ~30 per second); acknowledged inputs: `sendAck`. */
	input(event: LiveInput): void {
		if (!this.inControl) return;
		if (event.type === 'mouse' && event.event === 'move') {
			const now = performance.now();
			if (now - this.#lastMove < 33) return;
			this.#lastMove = now;
		}
		this.#send({ type: 'input', event });
	}

	async sendAck(event: LiveInput): Promise<string | undefined> {
		const r = await this.#command('input', { event });
		if (!r.ok) this.message = r.error ?? 'The browser refused the input';
		return r.ok ? undefined : r.error;
	}

	close(): void {
		this.#attempt++; // a ticket still on its way opens nothing
		clearInterval(this.#ping);
		const ws = this.#ws;
		this.#ws = undefined;
		if (ws) {
			ws.onclose = null;
			ws.close();
		}
	}
}
