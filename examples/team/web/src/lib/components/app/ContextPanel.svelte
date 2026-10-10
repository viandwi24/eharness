<script lang="ts">
	import FileTextIcon from 'phosphor-svelte/lib/FileText';
	import ClockIcon from 'phosphor-svelte/lib/Clock';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import AgentEditor from './AgentEditor.svelte';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { api } from '#lib/api/index.js';
	import type { AgentSessions, Task } from '#lib/api/client.js';
	import { badgeFor } from '#lib/board/board.js';
	import { formatTime } from '#lib/format.js';
	import { openTask } from '#lib/stores/drawer.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	// MOCK: routines and files are not served by the API yet.
	import { files, routines } from '#lib/mock.js';

	let { agentId }: { agentId: string } = $props();
	const agent = $derived(agentsStore.find(agentId));

	let sessions = $state<AgentSessions | null>(null);
	let sessionsError = $state<string | null>(null);
	// Reload on agent change and whenever the board moves (task-changed events refresh `live.state.tasks`).
	const stamp = $derived(live.state.tasks.map((t) => `${t.id}:${t.status}`).join('|'));
	let seq = 0;
	$effect(() => {
		const id = agent?.id;
		void stamp;
		if (!id) return;
		const mine = ++seq;
		api.get('/agents/{id}/sessions', { params: { id } }).then(
			(r) => {
				if (mine !== seq) return;
				sessions = r;
				sessionsError = null;
			},
			(e) => {
				if (mine === seq) sessionsError = e instanceof Error ? e.message : 'Could not load tasks';
			}
		);
	});
	const owned = $derived<Task[]>(sessions?.tasks ?? []);
	const delegated = $derived<Task[]>(sessions?.delegated ?? []);
</script>

{#snippet taskRow(t: Task)}
	{@const b = badgeFor(t.status)}
	<button
		class="flex w-full items-start gap-2 rounded-lg border border-border bg-card p-3 text-left hover:bg-accent"
		onclick={() => openTask(t.id)}
	>
		<span class="min-w-0 flex-1">
			<span class="block truncate font-medium">{t.title}</span>
			<span class="text-xs text-muted-foreground">{formatTime(t.lastActivityAt)}</span>
		</span>
		<Badge variant={b.variant}>{b.label}</Badge>
	</button>
{/snippet}

<Tabs.Root value="routines" class="flex h-full min-h-0 flex-col">
	<div class="border-b border-border p-2">
		<Tabs.List variant="line" class="gap-4 border-b-0">
			<Tabs.Trigger value="routines">Routines</Tabs.Trigger>
			<Tabs.Trigger value="files">Files</Tabs.Trigger>
			<Tabs.Trigger value="tasks">Tasks</Tabs.Trigger>
			<Tabs.Trigger value="settings">Settings</Tabs.Trigger>
		</Tabs.List>
	</div>
	<div class="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
		<Tabs.Content value="routines" class="flex flex-col gap-2">
			{#each routines as r (r.id)}
				<div class="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
					<ClockIcon class="size-4 text-muted-foreground" />
					<div class="min-w-0 flex-1">
						<div class="truncate font-medium">{r.name}</div>
						<div class="text-xs text-muted-foreground">{r.schedule}</div>
					</div>
					<Badge variant={r.status === 'active' ? 'default' : 'secondary'}>{r.status}</Badge>
				</div>
			{/each}
		</Tabs.Content>
		<Tabs.Content value="files" class="flex flex-col gap-1">
			{#each files as f (f.path)}
				<a href="/library" class="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-accent">
					<FileTextIcon class="size-4 text-muted-foreground" />
					<span class="min-w-0 flex-1 truncate font-mono text-xs">{f.path}</span>
					<span class="text-xs text-muted-foreground">{f.by}</span>
				</a>
			{/each}
		</Tabs.Content>
		<Tabs.Content value="tasks" class="flex flex-col gap-2">
			{#if sessions && sessions.dm.pending > 0}
				<p class="rounded-lg border border-border bg-warning-soft p-2 text-xs text-warning-text">
					{sessions.dm.pending} waiting for your answer in this chat.
				</p>
			{/if}
			{#if sessionsError}<p class="text-destructive-text">{sessionsError}</p>{/if}
			{#if owned.length}<h3 class="text-xs font-medium text-muted-foreground">Runs</h3>{/if}
			{#each owned as t (t.id)}{@render taskRow(t)}{/each}
			{#if delegated.length}<h3 class="mt-2 text-xs font-medium text-muted-foreground">Delegated</h3>{/if}
			{#each delegated as t (t.id)}{@render taskRow(t)}{/each}
			{#if sessions && !owned.length && !delegated.length}
				<p class="text-muted-foreground">No tasks for this agent.</p>
			{:else if !sessions && !sessionsError}
				<p class="text-muted-foreground">Loading…</p>
			{/if}
		</Tabs.Content>
		<Tabs.Content value="settings">
			{#if agent}
				{#key `${agent.id}:${agent.version}`}
					<AgentEditor {agent} compact />
				{/key}
				<a href="/a/{agent.id}/settings" class="mt-3 inline-block text-xs text-info-text underline underline-offset-4">Open full editor</a>
			{:else}
				<p class="text-muted-foreground">Loading…</p>
			{/if}
		</Tabs.Content>
	</div>
</Tabs.Root>
