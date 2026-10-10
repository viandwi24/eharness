<script lang="ts">
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import type { FlowView } from '#lib/api/index.js';
	import FlowFooter from './FlowFooter.svelte';

	let { view, accountLabel, onDone, onCancel }: { view: Extract<FlowView, { type: 'status' }>; accountLabel?: string; onDone: () => void; onCancel: () => void } = $props();
	const account = $derived(view.account ?? accountLabel);
</script>

{#if view.state === 'success'}
	<div class="flex flex-col items-center gap-3 pt-2 pb-3 text-center">
		<span class="flex size-12 items-center justify-center rounded-full bg-success-soft text-success-text"><CheckIcon class="size-6" weight="bold" /></span>
		<div class="flex flex-col gap-1">
			<h3 class="text-base font-semibold">Connected</h3>
			<p class="text-[13px] text-muted-foreground">{view.message}</p>
		</div>
		{#if account}<p class="rounded-full border border-border bg-muted/50 px-3 py-1 text-xs font-medium">{account}</p>{/if}
		<p class="max-w-xs text-xs text-muted-foreground">Next: choose what it may do on its own in the connector's permissions, or turn it on per agent in an agent's Connectors tab.</p>
	</div>
	<FlowFooter>
		<Button onclick={onDone}>Done</Button>
	</FlowFooter>
{:else}
	<div class="flex flex-col items-center gap-3 pt-2 pb-3 text-center">
		<span class="flex size-12 items-center justify-center rounded-full bg-muted"><Spinner class="size-5" /></span>
		<p class="text-[13px] text-muted-foreground" role="status">{view.message}</p>
	</div>
	<FlowFooter>
		<Button variant="ghost" onclick={onCancel}>Cancel</Button>
	</FlowFooter>
{/if}
