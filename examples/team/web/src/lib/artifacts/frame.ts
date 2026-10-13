// The sandboxed frame protocol (plan P45 R1/A-11). Artifact HTML runs in an iframe with
// `sandbox="allow-scripts allow-popups allow-forms allow-modals"`, never `allow-same-origin`, so the
// page cannot reach the app. The bridge script inside it (injected by the server for stored
// artifacts, by `withBridge` for previews) tells us when it is ready, how tall it is and when it threw.

export const FRAME_SANDBOX = 'allow-scripts allow-popups allow-forms allow-modals';

export type FrameEvent = { event: 'ready' } | { event: 'resize'; height: number } | { event: 'error'; message: string };

/** A message from a frame, or `undefined` for anything that is not one of ours. */
export function parseFrameMessage(data: unknown): FrameEvent | undefined {
	if (typeof data !== 'object' || data === null) return undefined;
	const d = data as Record<string, unknown>;
	const raw = typeof d.event === 'string' ? d.event : typeof d.type === 'string' ? d.type : '';
	const name = raw.replace(/^(?:eh-)?artifact[:.-]/i, '').toLowerCase();
	if (name === 'ready' || name === 'load') return { event: 'ready' };
	if (name === 'resize') {
		const h = Number(d.height);
		return Number.isFinite(h) && h > 0 ? { event: 'resize', height: Math.min(Math.ceil(h), 20_000) } : undefined;
	}
	if (name === 'error') {
		const m = typeof d.message === 'string' ? d.message : typeof d.error === 'string' ? d.error : '';
		return { event: 'error', message: m.slice(0, 2000) || 'Unknown error' };
	}
	return undefined;
}

const BRIDGE = `<script>(function(){var p=function(m){try{parent.postMessage(m,'*')}catch(e){}};
addEventListener('error',function(e){p({source:'eh-artifact',type:'error',message:(e.message||'Error')+(e.lineno?' (line '+e.lineno+')':'')})});
addEventListener('unhandledrejection',function(e){p({source:'eh-artifact',type:'error',message:String(e.reason&&e.reason.message||e.reason)})});
var h=function(){p({source:'eh-artifact',type:'resize',height:document.documentElement.scrollHeight})};
addEventListener('load',function(){p({source:'eh-artifact',type:'ready'});h();if(window.ResizeObserver)new ResizeObserver(h).observe(document.documentElement)});
})();</script>`;

/** The bridge appended to a preview page (before `</body>` when there is one). */
export function withBridge(html: string): string {
	const at = html.search(/<\/body\s*>/i);
	return at >= 0 ? `${html.slice(0, at)}${BRIDGE}${html.slice(at)}` : `${html}${BRIDGE}`;
}

/** A page that shows one SVG, scaled to fit, on a light ground. It runs no script. */
export function svgDocument(svg: string): string {
	return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#fff}body{display:flex;align-items:center;justify-content:center}svg{max-width:100%;max-height:100%;height:auto}</style>${svg}`;
}
