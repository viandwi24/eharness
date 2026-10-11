<script lang="ts">
	import GavelIcon from 'phosphor-svelte/lib/Gavel';
	import { onMount } from 'svelte';
	import { api } from '#lib/api/index.js';
	import DecisionCard from '#lib/components/app/DecisionCard.svelte';
	import DecisionEditDialog from '#lib/components/app/DecisionEditDialog.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { type Decision, groupDecisions, KIND_INFO } from '#lib/decisions/model.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';

	let view = $state<'open' | 'decided'>('open');
	let agentFilter = $state('');
	let list = $state<Decision[] | null>(null);
	let error = $state('');
	let editing = $state<Extract<Decision, { kind: 'proposal' }> | null>(null);
	let seq = 0;

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/decisions', { query: { limit: 200, ...(view === 'open' ? { status: 'open' as const } : {}), ...(agentFilter ? { agentId: agentFilter } : {}) } });
			if (mine !== seq) return;
			list = view === 'open' ? r.decisions : r.decisions.filter((d) => d.status !== 'open');
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load decisions';
		}
	}

	onMount(() => void agentsStore.load());
	$effect(() => {
		void live.state.revs.decisions;
		void view;
		void agentFilter;
		void load();
	});

	const groups = $derived(view === 'open' ? groupDecisions(list ?? []) : []);
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Decisions" description="Plans to approve, questions from running work and requests for more authority.">
		<NativeSelect bind:value={agentFilter} aria-label="Filter by agent" class="w-40">
			<NativeSelectOption value="">All agents</NativeSelectOption>
			{#each agentsStore.state.agents as a (a.id)}
				<NativeSelectOption value={a.id}>{a.name}</NativeSelectOption>
			{/each}
		</NativeSelect>
		<div class="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="Show">
			<Button size="sm" variant={view === 'open' ? 'secondary' : 'ghost'} aria-pressed={view === 'open'} onclick={() => (view = 'open')}>
				Open{live.state.decisions.length ? ` (${live.state.decisions.length})` : ''}
			</Button>
			<Button size="sm" variant={view === 'decided' ? 'secondary' : 'ghost'} aria-pressed={view === 'decided'} onclick={() => (view = 'decided')}>Decided</Button>
		</div>
	</PageHeader>

	<PageBody size="narrow" class="gap-6">
		{#if error}
			<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Retry</button></p>
		{:else if !list}
			<div class="flex flex-col gap-2">{#each [0, 1, 2] as i (i)}<Skeleton class="h-28 w-full" />{/each}</div>
		{:else if !list.length}
			<Empty.Root class="border border-dashed border-border">
				<Empty.Header>
					<Empty.Media variant="icon"><GavelIcon /></Empty.Media>
					<Empty.Title>{view === 'open' ? 'Nothing needs your decision' : 'No decisions yet'}</Empty.Title>
					<Empty.Description>
						Agents propose plans here, and runs that hit a gate stop and ask here. You decide once; approved work runs to the end on its own. Tool approvals stay in the chat they come from.
					</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else if view === 'open'}
			{#each groups as g (g.kind)}
				<section class="flex flex-col gap-2.5" aria-label={KIND_INFO[g.kind].group}>
					<div>
						<h2 class="text-sm font-semibold">{KIND_INFO[g.kind].group} <span class="font-normal text-muted-foreground">· {g.items.length}</span></h2>
						<p class="text-xs text-muted-foreground">{KIND_INFO[g.kind].hint}</p>
					</div>
					{#each g.items as d (d.id)}
						<DecisionCard decision={d} onEdit={(p) => (editing = p)} />
					{/each}
				</section>
			{/each}
		{:else}
			<div class="flex flex-col gap-2.5">
				{#each list as d (d.id)}<DecisionCard decision={d} />{/each}
			</div>
		{/if}
	</PageBody>
</div>

<DecisionEditDialog bind:decision={editing} />
