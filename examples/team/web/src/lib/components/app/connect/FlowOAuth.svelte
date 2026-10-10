<script lang="ts">
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOut';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import type { FlowView } from '#lib/api/index.js';
	import type { FlowSession } from '#lib/connectors/flow-core.js';
	import { countdownText, safeUrl } from '#lib/connectors/flow-view.js';
	import FlowFooter from './FlowFooter.svelte';
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

<div class="flex flex-col items-center gap-3 pt-2 pb-3 text-center">
	<span class="flex size-12 items-center justify-center rounded-full bg-muted"><Spinner class="size-5" /></span>
	<div class="flex flex-col gap-1">
		<h3 class="text-sm font-medium">{view.title}</h3>
		<p class="text-[13px] text-muted-foreground" role="status">Finish signing in in the window that opened. This page updates by itself.</p>
	</div>
	{#if ok}
		<Button variant="outline" href={view.authorizeUrl} target="_blank" rel="noopener noreferrer" onclick={open}><ArrowSquareOutIcon class="size-4" />Open the sign-in window</Button>
		<p class="text-xs text-muted-foreground">
			Nothing opened? <a class="underline underline-offset-2 hover:text-foreground" href={view.authorizeUrl} target="_blank" rel="noopener noreferrer">Open it in a new tab</a>.
		</p>
	{/if}
	<p class="text-xs text-muted-foreground">{countdownText(view.expiresAt, clock.value)}</p>
</div>
<FlowFooter>
	<Button variant="ghost" onclick={onCancel}>Cancel</Button>
</FlowFooter>
