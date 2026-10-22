<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import ClockIcon from 'phosphor-svelte/lib/Clock';
	import { api } from '#lib/api/index.js';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import XIcon from 'phosphor-svelte/lib/X';
	import BellIcon from 'phosphor-svelte/lib/Bell';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { FILTER_OPTIONS, reminderBadge, reminderStatus, remindersFor, type ReminderFilter, type ReminderRow } from '#lib/routines/reminders.js';
	import { relativeTime } from '#lib/routines/schedule.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';

	// reminders made from chats (`sys:reminder:*`): active and recently finished ones; null = loading
	let reminders = $state<ReminderRow[] | null>(null);
	let filter = $state<ReminderFilter>('active');
	let error = $state('');
	// `?agentId=` preselects the filter (the agent chat's session panel links here).
	let agentFilter = $state(page.url.searchParams.get('agentId') ?? '');
	let busy = $state<string | null>(null);
	let cancelling = $state<ReminderRow | null>(null);
	let seq = 0;

	const agentOf = (id: string) => agentsStore.state.agents.find((a) => a.id === id);
	const shownReminders = $derived(remindersFor(filter, reminders ?? [], agentFilter));

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/routines');
			if (mine !== seq) return;
			reminders = r.reminders;
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load reminders';
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
</script>

{#snippet iconAction(label: string, disabled: boolean, onclick: () => void, icon: typeof XIcon)}
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
		<PageHeader title="Reminders" description="Reminders your agents posted for you, from chats. Programs keep their own schedule.">
			<NativeSelect bind:value={filter} aria-label="Show" class="w-full min-w-0 sm:w-48" data-testid="routine-kind">
				{#each FILTER_OPTIONS as o (o.value)}<NativeSelectOption value={o.value}>{o.label}</NativeSelectOption>{/each}
			</NativeSelect>
			<NativeSelect bind:value={agentFilter} aria-label="Filter by agent" class="w-full min-w-0 sm:w-40">
				<NativeSelectOption value="">All agents</NativeSelectOption>
				{#each agentsStore.state.agents as a (a.id)}
					<NativeSelectOption value={a.id}>{a.name}</NativeSelectOption>
				{/each}
			</NativeSelect>
		</PageHeader>

		<PageBody size="wide">
			{#if error}
				<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Retry</button></p>
			{:else if !reminders}
				<div class="flex flex-col gap-2">
					{#each [0, 1, 2] as i (i)}<Skeleton class="h-12 w-full" />{/each}
				</div>
			{:else if !shownReminders.length}
				<Empty.Root class="border border-dashed border-border">
					<Empty.Header>
						<Empty.Media variant="icon"><ClockIcon /></Empty.Media>
						<Empty.Title>{reminders.length ? 'No reminders match this filter' : 'No reminders yet'}</Empty.Title>
						<Empty.Description>Ask an agent in a chat to remind you or a group of something, and it shows up here.</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else}
				<Surface>
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Reminder</Table.Head>
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
									<Table.Cell class="whitespace-normal">
										<div class="flex items-center gap-2.5">
											{#if a}<span class="hidden sm:block"><AgentAvatar seed={a.id} color={a.color} size={28} label={a.name} /></span>{/if}
											<div class="min-w-0">
												<div class="flex min-w-0 items-center gap-1.5">
													<Badge variant="secondary" class="shrink-0"><BellIcon class="size-3" /> {reminderBadge(m)}</Badge>
												</div>
												<div class="line-clamp-2 max-w-72 text-sm font-medium break-words" title={m.text}>{m.text}</div>
												<div class="text-xs break-words text-muted-foreground">{a?.name ?? 'Unknown agent'}{#if m.createdByName} · set by {m.createdByName}{/if}<span class="md:hidden"> · {m.whenText}</span></div>
											</div>
										</div>
									</Table.Cell>
									<Table.Cell class="hidden max-w-64 whitespace-normal text-muted-foreground md:table-cell">{m.whenText}</Table.Cell>
									<Table.Cell class="hidden text-muted-foreground lg:table-cell">{m.status === 'active' ? relativeTime(m.nextAt) : '—'}</Table.Cell>
									<Table.Cell class="hidden text-muted-foreground lg:table-cell">{m.lastFiredAt ? relativeTime(m.lastFiredAt) : 'Never'}</Table.Cell>
									<Table.Cell><Badge variant={st.variant}>{st.label}</Badge></Table.Cell>
									<Table.Cell>
										<div class="flex justify-end">
											{#if m.status === 'active'}{@render iconAction('Cancel reminder', busy === m.id, () => (cancelling = m), XIcon)}{/if}
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

{#if cancelling}
	<ConfirmDialog
		open={true}
		title="Cancel this reminder?"
		description={`"${cancelling.text}" will not be posted. You cannot undo this.`}
		confirmLabel="Cancel reminder"
		onConfirm={() => {
			const r = cancelling;
			cancelling = null;
			if (r) void cancelReminder(r);
		}}
	/>
{/if}
