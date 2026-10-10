<script lang="ts">
	import FlowFooter from './FlowFooter.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import type { FlowView } from '#lib/api/index.js';

	let {
		view,
		busy,
		canBack,
		onConfirm,
		onBack,
		onCancel
	}: { view: Extract<FlowView, { type: 'confirm' }>; busy: boolean; canBack: boolean; onConfirm: () => void; onBack: () => void; onCancel: () => void } = $props();
</script>

<div class="flex flex-col gap-4">
	<div class="flex flex-col gap-1">
		<h3 class="text-sm font-medium">{view.title}</h3>
		<p class="text-sm text-muted-foreground">{view.message}</p>
	</div>
	<FlowFooter>
		<Button variant="ghost" onclick={onCancel} disabled={busy}>{view.cancelLabel}</Button>
		{#if canBack}<Button variant="outline" onclick={onBack} disabled={busy}>Back</Button>{/if}
		<Button onclick={onConfirm} disabled={busy}>{#if busy}<Spinner class="size-4" />{/if}{view.confirmLabel}</Button>
	</FlowFooter>
</div>
