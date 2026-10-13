// Lazy mermaid (plan P45 R2/R4): the library is imported on the first diagram, so the chat bundle
// stays small. `securityLevel: 'strict'` makes mermaid sanitise labels and refuse click handlers.
type Mermaid = (typeof import('mermaid'))['default'];

let loaded: Promise<Mermaid> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;

const load = (): Promise<Mermaid> => (loaded ??= import('mermaid').then((m) => m.default));

/** Render `code` to an SVG string; rejects with mermaid's error text for a diagram that does not parse. */
export function renderMermaid(code: string, dark: boolean): Promise<string> {
	// mermaid keeps global state: renders run one after another
	const run = queue.then(async () => {
		const mermaid = await load();
		mermaid.initialize({
			startOnLoad: false,
			securityLevel: 'strict',
			theme: dark ? 'dark' : 'default',
			// labels as SVG text, not foreignObject, so the diagram also exports to PNG
			htmlLabels: false,
			flowchart: { htmlLabels: false },
			fontFamily: 'inherit'
		} as Parameters<Mermaid['initialize']>[0]);
		const id = `eh-mmd-${++seq}`;
		try {
			const { svg } = await mermaid.render(id, code);
			return svg;
		} finally {
			// a failed render can leave its scratch element in the page
			document.getElementById(`d${id}`)?.remove();
			document.getElementById(id)?.remove();
		}
	});
	queue = run.catch(() => undefined);
	return run;
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+$/, '');
