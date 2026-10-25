<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import { goto } from '$app/navigation';
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
	import ProgramFilesDialog from '#lib/components/app/ProgramFilesDialog.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { authoritySummary, budgetSummary, lastStatusText, offersResume, programBadge, type Program } from '#lib/programs/form.js';
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
	let moveOpen = $state(false);
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
	<div class="flex min-h-0 min-w-0 flex-1 flex-col">
		<PageHeader title="Programs" description="Standing orders your agents carry out on their own, within the authority you grant.">
			<NativeSelect bind:value={agentFilter} aria-label="Filter by agent" class="w-40">
				<NativeSelectOption value="">All agents</NativeSelectOption>
				{#each agentsStore.state.agents as a (a.id)}
					<NativeSelectOption value={a.id}>{a.name}</NativeSelectOption>
				{/each}
			</NativeSelect>
			{#if programs?.some((p) => !p.briefPath)}
				<Button size="sm" variant="outline" onclick={() => (moveOpen = true)}>Move all briefs to the library</Button>
			{/if}
			<Button size="sm" onclick={() => openNewProgram(agentFilter || null)}><PlusIcon class="size-4" /> New program</Button>
		</PageHeader>

		<PageBody size="wide">
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
								<Table.Head class="w-24 text-right sm:w-auto"><span class="sr-only">Actions</span></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each shown as p (p.id)}
								{@const a = agentOf(p.agentId)}
								{@const b = programBadge(p)}
								<Table.Row class="cursor-pointer" onclick={() => openEditProgram(p.id)}>
									<Table.Cell class="whitespace-normal">
										<div class="flex items-center gap-2.5">
											{#if a}<span class="hidden sm:block"><AgentAvatar seed={a.id} color={a.color} size={28} label={a.name} /></span>{/if}
											<div class="min-w-0">
												<button type="button" class="line-clamp-2 block max-w-72 text-left font-medium break-words outline-none focus-visible:underline" onclick={(e) => { e.stopPropagation(); openEditProgram(p.id); }}>{p.name}</button>
												<div class="text-xs break-words text-muted-foreground">{a?.name ?? 'Unknown agent'}</div>
											</div>
										</div>
									</Table.Cell>
									<Table.Cell class="hidden text-muted-foreground md:table-cell">
										{#if p.trigger.kind === 'schedule'}
											<div>{describeSpec(p.trigger.spec)}</div>
											{@const when = `${p.status === 'active' && p.triggerState?.status === 'active' ? `next ${relativeTime(p.triggerState.nextFireAt)}` : 'not scheduled'}${p.triggerState?.lastFireAt ? `, last ${relativeTime(p.triggerState.lastFireAt)}${p.triggerState.lastStatus ? ` (${lastStatusText(p.triggerState.lastStatus)})` : ''}` : ''}`}
											<div class="max-w-56 truncate text-xs" title={when}>{when}</div>
										{:else}
											When I run it
										{/if}
									</Table.Cell>
									<Table.Cell class="hidden text-muted-foreground lg:table-cell">{authoritySummary(p.authority)}</Table.Cell>
									<Table.Cell class="hidden text-muted-foreground lg:table-cell">{budgetSummary(p.budget)}</Table.Cell>
									<Table.Cell><Badge variant={b.variant}>{b.label}</Badge></Table.Cell>
									<Table.Cell>
										<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
										<div class="flex flex-wrap items-center justify-end gap-x-0.5 gap-y-1 max-sm:max-w-28" onclick={(e) => e.stopPropagation()}>
											{#if offersResume(p)}
												{@render iconAction('Resume', busy === p.id, () => void act(p, 'resume'), PlayIcon)}
											{:else}
												{@render iconAction('Pause', busy === p.id, () => void act(p, 'pause'), PauseIcon)}
											{/if}
											{@render iconAction('Run now', busy === p.id, () => void act(p, 'run'), LightningIcon)}
											<Button size="xs" variant="ghost" onclick={() => openEditProgram(p.id)}>Edit</Button>
											<Button size="xs" variant="outline" onclick={() => void goto(`/programs/${p.id}`)}>Details</Button>
										</div>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</Surface>
			{/if}
		</PageBody>
	</div>
<ProgramFilesDialog bind:open={moveOpen} />
</Tooltip.Provider>
