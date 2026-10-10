<script lang="ts">
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOut';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import type { FlowView } from '#lib/api/index.js';
	import type { FlowSession } from '#lib/connectors/flow-core.js';
	import { countdownText, safeUrl } from '#lib/connectors/flow-view.js';
	import { usePolling, useNow } from './waiting.svelte.js';

	let { session, view, onCancel }: { session: FlowSession; view: Extract<FlowView, { type: 'oauth' }>; onCancel: () => void } = $props();

	// svelte-ignore state_referenced_locally
	usePolling(session, () => view);
	const clock = useNow();
	const ok = $derived(safeUrl(view.authorizeUrl));

	// only ever opened by a click, so popup blockers stay quiet; no popup: the plain link works
	function open(e: MouseEvent): void {
		if (!ok) return;
		const w = window.open(view.authorizeUrl, 'eh-authorize', 'popup,width=520,height=700,noopener,noreferrer');
		if (w) e.preventDefault();
	}
</script>

<div class="flex flex-col items-center gap-4 py-2 text-center">
	<h3 class="text-sm font-semibold">{view.title}</h3>
	<p class="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Spinner class="size-4" />Waiting for authorization…</p>
	{#if ok}
		<Button href={view.authorizeUrl} target="_blank" rel="noopener noreferrer" onclick={open}><ArrowSquareOutIcon class="size-4" />Open authorization page</Button>
		<p class="text-xs text-muted-foreground">
			Popup blocked? <a class="underline" href={view.authorizeUrl} target="_blank" rel="noopener noreferrer">Open the page in a new tab</a>.
		</p>
	{/if}
	<p class="text-xs text-muted-foreground">{countdownText(view.expiresAt, clock.value)}</p>
	<Button variant="ghost" onclick={onCancel}>Cancel</Button>
</div>
