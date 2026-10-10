// Server-sent events parser. Pure: feed it decoded text chunks, it emits complete events.
// Why not `EventSource`: the server authenticates with an `Authorization` header, which EventSource
// cannot send, so the client reads the stream with `fetch` and parses it here.

export type SseMessage = { id?: string; event: string; data: string; retry?: number };

export function createSseParser(onMessage: (m: SseMessage) => void): { push(chunk: string): void; reset(): void } {
	let buffer = '';
	let id: string | undefined;
	let event = '';
	let data: string[] = [];
	let retry: number | undefined;
	let lastId: string | undefined;
	let skipLf = false;

	const dispatch = (): void => {
		if (id !== undefined) lastId = id;
		if (data.length > 0) {
			const m: SseMessage = { event: event || 'message', data: data.join('\n') };
			if (lastId !== undefined) m.id = lastId;
			if (retry !== undefined) m.retry = retry;
			onMessage(m);
		}
		id = undefined;
		event = '';
		data = [];
		retry = undefined;
	};

	const line = (l: string): void => {
		if (l === '') return dispatch();
		if (l.startsWith(':')) return; // comment / keep-alive
		const i = l.indexOf(':');
		const field = i < 0 ? l : l.slice(0, i);
		let value = i < 0 ? '' : l.slice(i + 1);
		if (value.startsWith(' ')) value = value.slice(1);
		if (field === 'data') data.push(value);
		else if (field === 'event') event = value;
		else if (field === 'id') {
			if (!value.includes('\0')) id = value;
		} else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
	};

	return {
		push(chunk: string): void {
			buffer += chunk;
			let start = 0;
			for (let i = 0; i < buffer.length; i++) {
				const c = buffer[i];
				if (skipLf && i === start) {
					skipLf = false;
					if (c === '\n') {
						start = i + 1;
						continue;
					}
				}
				if (c === '\n' || c === '\r') {
					line(buffer.slice(start, i));
					start = i + 1;
					if (c === '\r') {
						if (buffer[i + 1] === '\n') {
							i++;
							start = i + 1;
						} else if (i + 1 >= buffer.length) skipLf = true;
					}
				}
			}
			buffer = buffer.slice(start);
		},
		reset(): void {
			buffer = '';
			id = undefined;
			event = '';
			data = [];
			retry = undefined;
			skipLf = false;
		}
	};
}
