// Reads the text of an AI SDK UI message stream (the `/v1` message answer) for the Try it console.
// Pure over a `Response`: no DOM. The page shows the text as it arrives.

/** The `text-delta` of one SSE data line, `[DONE]` as null, anything else as undefined. */
export function deltaOfLine(line: string): string | null | undefined {
	if (!line.startsWith('data:')) return undefined;
	const data = line.slice(5).trim();
	if (data === '[DONE]') return null;
	try {
		const chunk = JSON.parse(data) as { type?: string; delta?: string; errorText?: string };
		if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') return chunk.delta;
		if (chunk.type === 'error') return `\n[error: ${chunk.errorText ?? 'the agent failed'}]`;
	} catch {
		// not JSON: ignore the line
	}
	return undefined;
}

/** Read the whole stream, calling `onText` with the text so far after every delta. */
export async function readStreamText(response: Response, onText: (text: string) => void): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return '';
	const decoder = new TextDecoder();
	let buffer = '';
	let text = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let nl: number;
		while ((nl = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, nl).replace(/\r$/, '');
			buffer = buffer.slice(nl + 1);
			const delta = deltaOfLine(line);
			if (typeof delta === 'string') {
				text += delta;
				onText(text);
			}
		}
	}
	return text;
}
