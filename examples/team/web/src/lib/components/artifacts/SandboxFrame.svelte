<script lang="ts">
	import { FRAME_SANDBOX, parseFrameMessage } from '#lib/artifacts/frame.js';
	import { cn } from '#lib/utils.js';

	/**
	 * The one place artifact HTML and SVG run: a sandboxed iframe that is never `allow-same-origin`.
	 * `locked` drops every permission (an SVG needs none). Messages count only from this frame's own
	 * window (`event.source`), so another frame or tab cannot fake an error or a size.
	 */
	let {
		src,
		srcdoc,
		title,
		locked = false,
		fit = false,
		onerror,
		onready,
		class: className
	}: {
		src?: string;
		srcdoc?: string;
		title: string;
		locked?: boolean;
		/** Grow to the page's reported height instead of filling the parent. */
		fit?: boolean;
		onerror?: (message: string) => void;
		onready?: () => void;
		class?: string;
	} = $props();

	let frame = $state<HTMLIFrameElement>();
	let height = $state<number>();

	$effect(() => {
		const on = (e: MessageEvent): void => {
			if (!frame || e.source !== frame.contentWindow) return;
			const m = parseFrameMessage(e.data);
			if (!m) return;
			if (m.event === 'resize') height = m.height;
			else if (m.event === 'error') onerror?.(m.message);
			else onready?.();
		};
		window.addEventListener('message', on);
		return () => window.removeEventListener('message', on);
	});
</script>

<iframe
	bind:this={frame}
	{src}
	{srcdoc}
	{title}
	sandbox={locked ? '' : FRAME_SANDBOX}
	referrerpolicy="no-referrer"
	class={cn('block w-full border-0 bg-white', fit ? '' : 'h-full', className)}
	style:height={fit && height ? `${height}px` : undefined}
></iframe>
