<script lang="ts">
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircle';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import type { FlowView } from '#lib/api/index.js';

	let { view, accountLabel, onDone, onCancel }: { view: Extract<FlowView, { type: 'status' }>; accountLabel?: string; onDone: () => void; onCancel: () => void } = $props();
	const account = $derived(view.account ?? accountLabel);
</script>

{#if view.state === 'success'}
	<div class="flex flex-col items-center gap-3 py-2 text-center">
		<CheckCircleIcon class="size-10 text-success-text" weight="fill" />
		<h3 class="text-base font-semibold">Connected</h3>
		<p class="text-sm text-muted-foreground">{view.message}</p>
		{#if account}<p class="text-sm font-medium">{account}</p>{/if}
		<Button onclick={onDone}>Done</Button>
	</div>
{:else}
	<div class="flex flex-col items-center gap-3 py-2 text-center">
		<Spinner class="size-6" />
		<p class="text-sm text-muted-foreground" role="status">{view.message}</p>
		<Button variant="ghost" onclick={onCancel}>Cancel</Button>
	</div>
{/if}
