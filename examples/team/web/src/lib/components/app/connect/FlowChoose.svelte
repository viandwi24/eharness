<script lang="ts">
	import FlowFooter from './FlowFooter.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import type { FlowView } from '#lib/api/index.js';
	import { chooseError, choosePayload, toggleSelected } from '#lib/connectors/flow-view.js';

	let {
		view,
		busy,
		canBack,
		onSubmit,
		onBack,
		onCancel
	}: {
		view: Extract<FlowView, { type: 'choose' }>;
		busy: boolean;
		canBack: boolean;
		onSubmit: (data: Record<string, unknown>) => void;
		onBack: () => void;
		onCancel: () => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	let selected = $state<string[]>([...view.selected]);
	let local = $state<string | undefined>();
	// a long list (an account with many chats) can be narrowed by typing
	let filter = $state('');
	const shown = $derived(filter.trim() === '' ? view.options : view.options.filter((o) => `${o.label} ${o.description ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase())));
	const error = $derived(local ?? view.errors?.selected ?? Object.values(view.errors ?? {})[0]);

	function submit(e: SubmitEvent): void {
		e.preventDefault();
		local = chooseError(view, selected);
		if (!local) onSubmit(choosePayload(selected));
	}
	function pick(value: string): void {
		selected = toggleSelected(selected, value, view.multiple);
		local = undefined;
	}
</script>

<form class="flex flex-col gap-4" onsubmit={submit}>
	<div class="flex flex-col gap-1">
		<h3 class="text-sm font-medium">{view.title}</h3>
		{#if view.description}<p class="text-sm text-muted-foreground">{view.description}</p>{/if}
	</div>
	{#if view.options.length > 8}
		<Input type="search" placeholder="Search {view.options.length} choices" aria-label="Search the choices" bind:value={filter} />
	{/if}
	{#if shown.length === 0}<p class="text-sm text-muted-foreground">Nothing matches “{filter}”.</p>{/if}
	<ul class="flex max-h-72 flex-col gap-1 overflow-y-auto" role={view.multiple ? 'group' : 'radiogroup'} aria-label={view.title}>
		{#each shown as o, i (o.value)}
			{@const on = selected.includes(o.value)}
			<li>
				<label class="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors hover:bg-muted/50 {on ? 'border-foreground/60 bg-muted/40' : 'border-border'}">
					{#if view.multiple}
						<Checkbox checked={on} onCheckedChange={() => pick(o.value)} disabled={busy} class="mt-0.5" />
					{:else}
						<input type="radio" name="cf-choose" class="mt-1 accent-[var(--primary)]" checked={on} onchange={() => pick(o.value)} disabled={busy} id="cf-choose-{i}" />
					{/if}
					<span class="flex min-w-0 flex-col">
						<span class="text-sm font-medium">{o.label}</span>
						{#if o.description}<span class="text-xs text-muted-foreground">{o.description}</span>{/if}
					</span>
				</label>
			</li>
		{/each}
	</ul>
	{#if view.multiple && view.options.length > 1}<p class="text-xs text-muted-foreground" role="status">{selected.length} of {view.options.length} chosen</p>{/if}
	{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
	{#if view.message}<p class="text-sm text-muted-foreground">{view.message}</p>{/if}
	<FlowFooter>
		<Button type="button" variant="ghost" onclick={onCancel} disabled={busy}>Cancel</Button>
		{#if canBack}<Button type="button" variant="outline" onclick={onBack} disabled={busy}>Back</Button>{/if}
		<Button type="submit" disabled={busy}>{#if busy}<Spinner class="size-4" />{/if}Continue</Button>
	</FlowFooter>
</form>
