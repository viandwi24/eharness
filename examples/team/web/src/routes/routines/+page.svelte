<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import ClockIcon from 'phosphor-svelte/lib/Clock';
	import PauseIcon from 'phosphor-svelte/lib/Pause';
	import PlayIcon from 'phosphor-svelte/lib/Play';
	import LightningIcon from 'phosphor-svelte/lib/Lightning';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import { api } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import XIcon from 'phosphor-svelte/lib/X';
	import BellIcon from 'phosphor-svelte/lib/Bell';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { routineAction } from '#lib/routines/actions.js';
	import { KIND_OPTIONS, reminderBadge, reminderStatus, remindersFor, showsRoutines, type ReminderRow, type RoutineKind } from '#lib/routines/reminders.js';
	import { describeSpec, relativeTime, routineBadge } from '#lib/routines/schedule.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openEditRoutine, openNewRoutine } from '#lib/stores/dialogs.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';

	type Routine = components['schemas']['Routine'];

	let routines = $state<Routine[] | null>(null);
	// reminders made from chats (`sys:reminder:*`): active and recently finished ones
	let reminders = $state<ReminderRow[]>([]);
	let kind = $state<RoutineKind>('all');
	let error = $state('');
	// `?agentId=` preselects the filter (the agent chat's session panel links here).
	let agentFilter = $state(page.url.searchParams.get('agentId') ?? '');
	let busy = $state<string | null>(null);
	let seq = 0;

	const agentOf = (id: string) => agentsStore.state.agents.find((a) => a.id === id);
	const shown = $derived(showsRoutines(kind) ? (routines ?? []).filter((r) => !agentFilter || r.agentId === agentFilter) : []);
	const shownReminders = $derived(remindersFor(kind, reminders, agentFilter));

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/routines');
			if (mine !== seq) return;
			routines = r.routines;
			reminders = r.reminders;
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load routines';
		}
	}

	onMount(() => void agentsStore.load());
	$effect(() => {
		void live.state.revs.routines;
		void load();
	});

	async function cancelReminder(r: ReminderRow): Promise<void> {
		busy = r.id;
		try {
			await api.delete('/channels/connections/{id}/reminders/{reminderId}', { params: { id: r.connectionId, reminderId: r.id } });
			toast.success('Reminder cancelled');
			await load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not cancel the reminder');
		} finally {
			busy = null;
		}
	}

	async function act(r: Routine, action: 'pause' | 'resume' | 'run'): Promise<void> {
		busy = r.id;
		await routineAction(r, action);
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
		<PageHeader title="Routines" description="Scheduled prompts that run an agent at set times.">
			<NativeSelect bind:value={kind} aria-label="Show" class="w-48" data-testid="routine-kind">
				{#each KIND_OPTIONS as o (o.value)}<NativeSelectOption value={o.value}>{o.label}</NativeSelectOption>{/each}
			</NativeSelect>
			<NativeSelect bind:value={agentFilter} aria-label="Filter by agent" class="w-40">
				<NativeSelectOption value="">All agents</NativeSelectOption>
				{#each agentsStore.state.agents as a (a.id)}
					<NativeSelectOption value={a.id}>{a.name}</NativeSelectOption>
				{/each}
			</NativeSelect>
			<Button size="sm" onclick={() => openNewRoutine(agentFilter || null)}><PlusIcon class="size-4" /> New routine</Button>
		</PageHeader>

		<PageBody size="wide">
			{#if error}
				<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Retry</button></p>
			{:else if !routines}
				<div class="flex flex-col gap-2">
					{#each [0, 1, 2] as i (i)}<Skeleton class="h-12 w-full" />{/each}
				</div>
			{:else if !shown.length && !shownReminders.length}
				<Empty.Root class="border border-dashed border-border">
					<Empty.Header>
						<Empty.Media variant="icon"><ClockIcon /></Empty.Media>
						<Empty.Title>{routines.length ? 'No routines for this agent' : 'No routines yet'}</Empty.Title>
						<Empty.Description>Routines run an agent's prompt on a schedule, like a morning briefing.</Empty.Description>
					</Empty.Header>
					<Empty.Content>
						<Button onclick={() => openNewRoutine(agentFilter || null)}><PlusIcon class="size-4" /> New routine</Button>
					</Empty.Content>
				</Empty.Root>
			{:else}
				<Surface>
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Routine</Table.Head>
								<Table.Head class="hidden md:table-cell">Schedule</Table.Head>
								<Table.Head class="hidden lg:table-cell">Next run</Table.Head>
								<Table.Head class="hidden lg:table-cell">Last run</Table.Head>
								<Table.Head>Status</Table.Head>
								<Table.Head class="w-24 text-right"><span class="sr-only">Actions</span></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each shownReminders as m (m.id)}
								{@const a = agentOf(m.agentId)}
								{@const st = reminderStatus(m)}
								<Table.Row data-testid="reminder-row">
									<Table.Cell>
										<div class="flex items-center gap-2.5">
											{#if a}<span class="hidden sm:block"><AgentAvatar seed={a.id} color={a.color} size={28} label={a.name} /></span>{/if}
											<div class="min-w-0">
												<div class="flex min-w-0 items-center gap-1.5">
													<Badge variant="secondary" class="shrink-0"><BellIcon class="size-3" /> {reminderBadge(m)}</Badge>
												</div>
												<div class="max-w-28 truncate text-sm font-medium sm:max-w-56" title={m.text}>{m.text}</div>
												<div class="truncate text-xs text-muted-foreground">{a?.name ?? 'Unknown agent'}{#if m.createdByName} · set by {m.createdByName}{/if}<span class="md:hidden"> · {m.whenText}</span></div>
											</div>
										</div>
									</Table.Cell>
									<Table.Cell class="hidden text-muted-foreground md:table-cell">{m.whenText}</Table.Cell>
									<Table.Cell class="hidden text-muted-foreground lg:table-cell">{m.status === 'active' ? relativeTime(m.nextAt) : '—'}</Table.Cell>
									<Table.Cell class="hidden text-muted-foreground lg:table-cell">{m.lastFiredAt ? relativeTime(m.lastFiredAt) : 'Never'}</Table.Cell>
									<Table.Cell><Badge variant={st.variant}>{st.label}</Badge></Table.Cell>
									<Table.Cell>
										<div class="flex justify-end">
											{#if m.status === 'active'}{@render iconAction('Cancel reminder', busy === m.id, () => void cancelReminder(m), XIcon)}{/if}
										</div>
									</Table.Cell>
								</Table.Row>
							{/each}
							{#each shown as r (r.id)}
								{@const a = agentOf(r.agentId)}
								{@const b = routineBadge(r)}
								<Table.Row class="cursor-pointer" onclick={() => openEditRoutine(r.id)}>
									<Table.Cell>
										<div class="flex items-center gap-2.5">
											{#if a}<span class="hidden sm:block"><AgentAvatar seed={a.id} color={a.color} size={28} label={a.name} /></span>{/if}
											<div class="min-w-0">
												<button type="button" class="block max-w-28 truncate text-left font-medium outline-none focus-visible:underline sm:max-w-56" onclick={(e) => { e.stopPropagation(); openEditRoutine(r.id); }}>{r.name}</button>
												<div class="truncate text-xs text-muted-foreground">{a?.name ?? 'Unknown agent'}<span class="md:hidden"> · {describeSpec(r.schedule)}</span></div>
											</div>
										</div>
									</Table.Cell>
									<Table.Cell class="hidden text-muted-foreground md:table-cell">{describeSpec(r.schedule)}</Table.Cell>
									<Table.Cell class="hidden text-muted-foreground lg:table-cell">{r.status === 'active' ? relativeTime(r.nextFireAt) : '—'}</Table.Cell>
									<Table.Cell class="hidden text-muted-foreground lg:table-cell">
										{@const last = r.lastFireAt ? `${relativeTime(r.lastFireAt)}${r.lastStatus ? `, ${r.lastStatus.replace('_', ' ')}` : ''}` : 'Never'}
										<!-- a long failure text must not widen the table and push the actions off screen -->
										<div class="max-w-48 truncate" title={last}>{last}</div>
									</Table.Cell>
									<Table.Cell><Badge variant={b.variant}>{b.label}</Badge></Table.Cell>
									<Table.Cell>
										<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
										<div class="flex justify-end" onclick={(e) => e.stopPropagation()}>
											{#if r.status === 'active'}
												{@render iconAction('Pause', busy === r.id, () => void act(r, 'pause'), PauseIcon)}
											{:else}
												{@render iconAction('Resume', busy === r.id, () => void act(r, 'resume'), PlayIcon)}
											{/if}
											{@render iconAction('Run now', busy === r.id, () => void act(r, 'run'), LightningIcon)}
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
</Tooltip.Provider>
