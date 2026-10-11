<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import { onMount } from 'svelte';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircle';
	import CircleNotchIcon from 'phosphor-svelte/lib/CircleNotch';
	import HandPalmIcon from 'phosphor-svelte/lib/HandPalm';
	import KanbanIcon from 'phosphor-svelte/lib/Kanban';
	import ListBulletsIcon from 'phosphor-svelte/lib/ListBullets';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import XIcon from 'phosphor-svelte/lib/X';
	import type { Task } from '#lib/api/client.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import PendingCard from '#lib/components/app/PendingCard.svelte';
	import TaskCard from '#lib/components/app/TaskCard.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as Kanban from '#lib/components/ui/kanban-column/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import { badgeFor, groupBoard, type Column } from '#lib/board/board.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openTask } from '#lib/stores/drawer.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { formatUsd, timeAgo } from '#lib/time.js';

	const PAGE = 10;
	const VIEW_KEY = 'team.tasks.view';

	let agentFilter = $state('');
	let query = $state('');
	let view = $state<'board' | 'list'>('board');
	let doneShown = $state(PAGE);

	const agentName = (id: string): string => agentsStore.find(id)?.name ?? id;
	const q = $derived(query.trim().toLowerCase());
	const filtering = $derived(!!agentFilter || !!q);
	const matches = (t: Task): boolean =>
		!q || t.title.toLowerCase().includes(q) || agentName(t.agentId).toLowerCase().includes(q) || (t.summary ?? '').toLowerCase().includes(q);

	const board = $derived(groupBoard(live.state.tasks.filter(matches), { agentId: agentFilter || null }));
	const approvals = $derived(live.state.approvals.filter((a) => (!agentFilter || a.agentId === agentFilter) && (!q || a.agentName.toLowerCase().includes(q) || a.toolName.toLowerCase().includes(q))));
	// Approvals of a task are shown on its card (inline); the rest (DM chats) get their own cards.
	const taskIds = $derived(new Set(live.state.tasks.map((t) => t.id)));
	const loose = $derived(approvals.filter((a) => !a.taskId || !taskIds.has(a.taskId)));
	const needsCount = $derived(board.needs.length + loose.length);
	const loaded = $derived(live.state.tasksLoaded);
	const total = $derived(board.needs.length + board.running.length + board.done.length + loose.length);

	const columns: { id: Column; title: string; icon: typeof HandPalmIcon; empty: string }[] = [
		{ id: 'needs', title: 'Needs action', icon: HandPalmIcon, empty: 'Nothing is waiting for you.' },
		{ id: 'running', title: 'Running', icon: CircleNotchIcon, empty: 'No task is running.' },
		{ id: 'done', title: 'Done', icon: CheckCircleIcon, empty: 'Finished tasks show up here.' }
	];

	const listRows = $derived([...board.needs, ...board.running, ...board.done]);

	onMount(() => {
		try {
			const v = localStorage.getItem(VIEW_KEY);
			if (v === 'board' || v === 'list') view = v;
		} catch {
			// storage unavailable: keep the default
		}
		void live.loadTasks();
		void live.loadApprovals();
		void agentsStore.load();
	});

	function setView(v: string | undefined): void {
		if (v !== 'board' && v !== 'list') return;
		view = v;
		try {
			localStorage.setItem(VIEW_KEY, v);
		} catch {
			// ignore
		}
	}
	function clear(): void {
		agentFilter = '';
		query = '';
	}
	const statusBadge = (t: Task): { label: string; variant: ReturnType<typeof badgeFor>['variant'] } =>
		t.status === 'needs_action' ? { label: t.pendingKind === 'question' ? 'question' : 'approval', variant: 'warning' } : badgeFor(t.status, t.summary);
</script>

{#snippet filters(cls: string)}
	<div class="flex items-center gap-2 {cls}">
		<InputGroup.Root class="h-8 min-w-0 flex-1 md:w-48 md:flex-none">
			<InputGroup.Addon><MagnifyingGlassIcon /></InputGroup.Addon>
			<InputGroup.Input bind:value={query} placeholder="Search tasks" aria-label="Search tasks" class="text-[13px]" />
			{#if query}
				<InputGroup.Addon align="inline-end">
					<InputGroup.Button size="icon-xs" aria-label="Clear search" onclick={() => (query = '')}><XIcon /></InputGroup.Button>
				</InputGroup.Addon>
			{/if}
		</InputGroup.Root>
		<NativeSelect bind:value={agentFilter} size="sm" aria-label="Filter by agent" class="min-w-0 max-w-40">
			<NativeSelectOption value="">All agents</NativeSelectOption>
			{#each agentsStore.state.agents as a (a.id)}<NativeSelectOption value={a.id}>{a.name}</NativeSelectOption>{/each}
		</NativeSelect>
		<ToggleGroup.Root type="single" value={view} onValueChange={setView} variant="outline" size="sm" spacing={0} aria-label="View" class="shrink-0">
			<ToggleGroup.Item value="board" aria-label="Board view"><KanbanIcon /></ToggleGroup.Item>
			<ToggleGroup.Item value="list" aria-label="List view"><ListBulletsIcon /></ToggleGroup.Item>
		</ToggleGroup.Root>
	</div>
{/snippet}

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader
		title="Tasks"
		description={loaded ? `${needsCount} need action · ${board.running.length} running · ${board.done.length} done` : undefined}
	>
		{#snippet actions()}{@render filters('hidden md:flex')}{/snippet}
	</PageHeader>
	<div class="border-b border-border px-3 py-2 md:hidden">{@render filters('')}</div>

	<div class="min-h-0 flex-1 overflow-y-auto p-3 md:p-4 {view === 'board' ? 'lg:overflow-hidden' : ''}">
		{#if loaded && filtering && total === 0}
			<Empty.Root class="h-full border">
				<Empty.Header>
					<Empty.Media variant="icon"><MagnifyingGlassIcon /></Empty.Media>
					<Empty.Title>No matching tasks</Empty.Title>
					<Empty.Description>Nothing matches the current search or agent filter.</Empty.Description>
				</Empty.Header>
				<Empty.Content><Button size="sm" variant="outline" onclick={clear}>Clear filters</Button></Empty.Content>
			</Empty.Root>
		{:else if view === 'board'}
			<div class="grid gap-3 lg:h-full lg:grid-cols-3 lg:gap-4">
				{#each columns as col (col.id)}
					{@const all = board[col.id]}
					{@const items = col.id === 'done' ? all.slice(0, doneShown) : all}
					{@const count = all.length + (col.id === 'needs' ? loose.length : 0)}
					<Kanban.Root
						title={col.title}
						meta={String(count)}
						aria-label="{col.title}, {count}"
						class="w-full lg:min-h-0 lg:overflow-y-auto {col.id === 'needs' && count > 0 ? 'border-[color-mix(in_srgb,var(--warning)_30%,var(--popover))]' : ''}"
					>
						{#if !loaded}
							{#each [0, 1] as n (n)}<Skeleton class="h-[72px] w-full rounded-xl" />{/each}
						{:else}
							{#if col.id === 'needs'}
								{#each loose as a (a.sessionId + a.id)}
									<PendingCard approval={a} onOpenTask={openTask} />
								{/each}
							{/if}
							{#each items as t (t.id)}
								{@const own = col.id === 'needs' ? approvals.filter((a) => a.taskId === t.id) : []}
								<TaskCard task={t} onOpen={openTask} highlight={col.id === 'needs'} />
								{#each own as a (a.sessionId + a.id)}
									<PendingCard approval={a} onOpenTask={openTask} />
								{/each}
							{/each}
							{#if col.id === 'done' && all.length > doneShown}
								<Button variant="ghost" size="sm" class="w-full text-muted-foreground" onclick={() => (doneShown += PAGE)}>
									Show more ({all.length - doneShown})
								</Button>
							{/if}
							{#if count === 0}
								<div class="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
									<col.icon class="size-4" />
									{filtering ? 'No matches.' : col.empty}
								</div>
							{/if}
						{/if}
					</Kanban.Root>
				{/each}
			</div>
		{:else}
			<div class="flex flex-col gap-3">
				{#each loose as a (a.sessionId + a.id)}
					<PendingCard approval={a} onOpenTask={openTask} />
				{/each}
				{#if !loaded}
					{#each [0, 1, 2, 3] as n (n)}<Skeleton class="h-10 w-full" />{/each}
				{:else if listRows.length === 0}
					<Empty.Root class="border">
						<Empty.Header>
							<Empty.Media variant="icon"><CheckCircleIcon /></Empty.Media>
							<Empty.Title>No tasks yet</Empty.Title>
							<Empty.Description>Tasks appear here when an agent delegates work or a routine runs.</Empty.Description>
						</Empty.Header>
					</Empty.Root>
				{:else}
					<Surface class="overflow-hidden">
						<Table.Root>
							<Table.Header>
								<Table.Row class="hover:bg-transparent">
									<Table.Head class="w-28">Status</Table.Head>
									<Table.Head>Task</Table.Head>
									<Table.Head class="hidden md:table-cell">Agent</Table.Head>
									<Table.Head class="hidden text-right sm:table-cell">Cost</Table.Head>
									<Table.Head class="text-right">Updated</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each listRows as t (t.id)}
									{@const b = statusBadge(t)}
									<Table.Row
										role="button"
										tabindex={0}
										class="cursor-pointer outline-none focus-visible:bg-accent"
										onclick={() => openTask(t.id)}
										onkeydown={(e: KeyboardEvent) => {
											if (e.key === 'Enter' || e.key === ' ') {
												e.preventDefault();
												openTask(t.id);
											}
										}}
									>
										<Table.Cell><Badge variant={b.variant} class="capitalize">{b.label}</Badge></Table.Cell>
										<Table.Cell class="max-w-0 w-full">
											<span class="line-clamp-1 font-medium">{t.title}</span>
										</Table.Cell>
										<Table.Cell class="hidden md:table-cell">
											<span class="flex items-center gap-2 whitespace-nowrap">
												<AgentAvatar seed={t.agentId} color={agentsStore.find(t.agentId)?.color} size={18} />{agentName(t.agentId)}
											</span>
										</Table.Cell>
										<Table.Cell class="hidden text-right font-mono text-xs text-muted-foreground sm:table-cell">{t.costUsd > 0 ? formatUsd(t.costUsd) : ''}</Table.Cell>
										<Table.Cell class="text-right text-xs whitespace-nowrap text-muted-foreground">{timeAgo(t.lastActivityAt)}</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</Surface>
				{/if}
			</div>
		{/if}
	</div>
</div>
