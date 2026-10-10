<script lang="ts">
	import { onMount } from 'svelte';
	import CircleNotchIcon from 'phosphor-svelte/lib/CircleNotch';
	import HandPalmIcon from 'phosphor-svelte/lib/HandPalm';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircle';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import ApprovalCard from '#lib/components/app/ApprovalCard.svelte';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Kanban from '#lib/components/ui/kanban-column/index.js';
	import { badgeFor, groupBoard } from '#lib/board/board.js';
	import { formatTime } from '#lib/format.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openTask } from '#lib/stores/drawer.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';

	let agentFilter = $state('');
	const board = $derived(groupBoard(live.state.tasks, { agentId: agentFilter || null }));
	const approvals = $derived(live.state.approvals.filter((a) => !agentFilter || a.agentId === agentFilter));
	// Approvals of a task are shown on its card (inline); the rest (DM chats) get their own cards.
	const taskIds = $derived(new Set(live.state.tasks.map((t) => t.id)));
	const loose = $derived(approvals.filter((a) => !a.taskId || !taskIds.has(a.taskId)));
	const agentName = (id: string): string => agentsStore.find(id)?.name ?? id;

	onMount(() => {
		void live.loadTasks();
		void live.loadApprovals();
		void agentsStore.load();
	});

	const columns = [
		{ id: 'needs', title: 'Needs action', icon: HandPalmIcon },
		{ id: 'running', title: 'Running', icon: CircleNotchIcon },
		{ id: 'done', title: 'Done', icon: CheckCircleIcon }
	] as const;
</script>

<div class="flex min-w-0 flex-1 flex-col">
	<PageHeader title="Tasks">
		<select
			bind:value={agentFilter}
			aria-label="Filter by agent"
			class="h-8 rounded-md border border-input bg-background px-2 text-sm"
		>
			<option value="">All agents</option>
			{#each agentsStore.state.agents as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
		</select>
	</PageHeader>

	<div class="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-3">
		{#each columns as col (col.id)}
			{@const items = board[col.id]}
			<Kanban.Root title={col.title} meta={String(items.length + (col.id === 'needs' ? loose.length : 0))} class="w-full">
				{#if col.id === 'needs'}
					{#each loose as a (a.sessionId + a.id)}
						<ApprovalCard approval={a} onOpenTask={openTask} />
					{/each}
				{/if}
				{#each items as t (t.id)}
					{@const b = badgeFor(t.status)}
					{@const own = col.id === 'needs' ? approvals.filter((a) => a.taskId === t.id) : []}
					<Kanban.Item
						title={t.title}
						description="{agentName(t.agentId)} · {formatTime(t.lastActivityAt)}"
						role="button"
						tabindex={0}
						onclick={() => openTask(t.id)}
						onkeydown={(e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && openTask(t.id)}
						class="cursor-pointer"
					>
						{#snippet icon()}<AgentAvatar seed={t.agentId} color={agentsStore.find(t.agentId)?.color} size={20} />{/snippet}
						{#snippet action()}
							{#if col.id === 'done'}<Badge variant={b.variant}>{b.label}</Badge>{:else}<col.icon class="size-3.5" />{/if}
						{/snippet}
					</Kanban.Item>
					{#each own as a (a.sessionId + a.id)}
						<ApprovalCard approval={a} onOpenTask={openTask} />
					{/each}
				{/each}
				{#if items.length === 0 && !(col.id === 'needs' && loose.length)}
					<p class="px-1 py-3 text-xs text-muted-foreground">
						{live.state.tasksLoaded ? 'Nothing here.' : 'Loading…'}
					</p>
				{/if}
			</Kanban.Root>
		{/each}
	</div>
</div>
