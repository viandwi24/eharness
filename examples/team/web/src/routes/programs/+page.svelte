<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import LightningIcon from 'phosphor-svelte/lib/Lightning';
	import PauseIcon from 'phosphor-svelte/lib/Pause';
	import PlayIcon from 'phosphor-svelte/lib/Play';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import StrategyIcon from 'phosphor-svelte/lib/Strategy';
	import { api } from '#lib/api/index.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { authoritySummary, budgetSummary, programBadge, type Program } from '#lib/programs/form.js';
	import { programAction } from '#lib/programs/actions.js';
	import { describeSpec, relativeTime } from '#lib/routines/schedule.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openEditProgram, openNewProgram } from '#lib/stores/dialogs.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';

	let programs = $state<Program[] | null>(null);
	let error = $state('');
	// `?agentId=` preselects the filter.
	let agentFilter = $state(page.url.searchParams.get('agentId') ?? '');
	let busy = $state<string | null>(null);
	let seq = 0;

	const agentOf = (id: string) => agentsStore.state.agents.find((a) => a.id === id);
	const shown = $derived((programs ?? []).filter((p) => !agentFilter || p.agentId === agentFilter));

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/programs');
			if (mine !== seq) return;
			programs = r.programs;
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load programs';
		}
	}

	onMount(() => void agentsStore.load());
	$effect(() => {
		void live.state.revs.programs;
		void live.state.revs.routines; // a schedule that paused itself
		void load();
	});

	async function act(p: Program, action: 'pause' | 'resume' | 'run'): Promise<void> {
		busy = p.id;
		await programAction(p, action);
		busy = null;
	}
</script>

{#snippet iconAction(label: string, disabled: boolean, onclick: () => void, icon: typeof PlayIcon)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<Button {...props} variant="ghost" size="icon-sm" aria-label={label} {disabled} {onclick}>
					{@const Icon = icon}
					<Icon class="size-4" />
				</Button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>{label}</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

<Tooltip.Provider>
	<div class="flex min-w-0 flex-1 flex-col overflow-y-auto">
		<PageHeader title="Programs">
			<NativeSelect bind:value={agentFilter} aria-label="Filter by agent" class="w-40">
				<NativeSelectOption value="">All agents</NativeSelectOption>
				{#each agentsStore.state.agents as a (a.id)}
					<NativeSelectOption value={a.id}>{a.name}</NativeSelectOption>
				{/each}
			</NativeSelect>
			<Button size="sm" onclick={() => openNewProgram(agentFilter || null)}><PlusIcon class="size-4" /> New program</Button>
		</PageHeader>

		<div class="p-3 sm:p-4">
			{#if error}
				<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Retry</button></p>
			{:else if !programs}
				<div class="flex flex-col gap-2">
					{#each [0, 1, 2] as i (i)}<Skeleton class="h-12 w-full" />{/each}
				</div>
			{:else if !shown.length}
				<Empty.Root class="border border-dashed border-border">
					<Empty.Header>
						<Empty.Media variant="icon"><StrategyIcon /></Empty.Media>
						<Empty.Title>{programs.length ? 'No programs for this agent' : 'No programs yet'}</Empty.Title>
						<Empty.Description>
							A program is a standing order: you say once what an agent may do, and it runs on its own, reporting what it did. Anything outside the authority you grant is refused.
						</Empty.Description>
					</Empty.Header>
					<Empty.Content>
						<Button onclick={() => openNewProgram(agentFilter || null)}><PlusIcon class="size-4" /> New program</Button>
					</Empty.Content>
				</Empty.Root>
			{:else}
				<Surface>
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Program</Table.Head>
								<Table.Head class="hidden md:table-cell">Runs</Table.Head>
								<Table.Head class="hidden lg:table-cell">Authority</Table.Head>
								<Table.Head class="hidden lg:table-cell">Budget</Table.Head>
								<Table.Head>Status</Table.Head>
								<Table.Head class="w-24 text-right"><span class="sr-only">Actions</span></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each shown as p (p.id)}
								{@const a = agentOf(p.agentId)}
								{@const b = programBadge(p)}
								<Table.Row class="cursor-pointer" onclick={() => openEditProgram(p.id)}>
									<Table.Cell>
										<div class="flex items-center gap-2.5">
											{#if a}<AgentAvatar seed={a.id} color={a.color} size={28} label={a.name} />{/if}
											<div class="min-w-0">
												<button type="button" class="block max-w-56 truncate text-left font-medium outline-none focus-visible:underline" onclick={(e) => { e.stopPropagation(); openEditProgram(p.id); }}>{p.name}</button>
												<div class="truncate text-xs text-muted-foreground">{a?.name ?? 'Unknown agent'}</div>
											</div>
										</div>
									</Table.Cell>
									<Table.Cell class="hidden text-muted-foreground md:table-cell">
										{#if p.trigger.kind === 'schedule'}
											<div>{describeSpec(p.trigger.spec)}</div>
											<div class="text-xs">{p.status === 'active' && p.triggerState?.status === 'active' ? `next ${relativeTime(p.triggerState.nextFireAt)}` : 'not scheduled'}{p.triggerState?.lastFireAt ? `, last ${relativeTime(p.triggerState.lastFireAt)}${p.triggerState.lastStatus ? ` (${p.triggerState.lastStatus.replace('_', ' ')})` : ''}` : ''}</div>
										{:else}
											When I run it
										{/if}
									</Table.Cell>
									<Table.Cell class="hidden text-muted-foreground lg:table-cell">{authoritySummary(p.authority)}</Table.Cell>
									<Table.Cell class="hidden text-muted-foreground lg:table-cell">{budgetSummary(p.budget)}</Table.Cell>
									<Table.Cell><Badge variant={b.variant}>{b.label}</Badge></Table.Cell>
									<Table.Cell>
										<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
										<div class="flex justify-end" onclick={(e) => e.stopPropagation()}>
											{#if p.status === 'active'}
												{@render iconAction('Pause', busy === p.id, () => void act(p, 'pause'), PauseIcon)}
											{:else}
												{@render iconAction('Resume', busy === p.id, () => void act(p, 'resume'), PlayIcon)}
											{/if}
											{@render iconAction('Run now', busy === p.id, () => void act(p, 'run'), LightningIcon)}
										</div>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</Surface>
			{/if}
		</div>
	</div>
</Tooltip.Provider>
