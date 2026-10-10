<script lang="ts">
	import FileTextIcon from 'phosphor-svelte/lib/FileText';
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
	import type { components } from '#lib/api/schema.js';
	import { basename, formatBytes } from '#lib/files/helpers.js';
	import MemoryEditor from './MemoryEditor.svelte';
	import RoutinesTab from './RoutinesTab.svelte';

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

	// Routines, latest files and agent memory come from one context read; reloaded on events.
	type Context = components['schemas']['AgentContext'];
	let context = $state<Context | null>(null);
	let contextError = $state<string | null>(null);
	let cseq = 0;
	async function loadContext(): Promise<void> {
		const id = agent?.id;
		if (!id) return;
		const mine = ++cseq;
		try {
			const c = await api.get('/agents/{id}/context', { params: { id } });
			if (mine !== cseq) return;
			context = c;
			contextError = null;
		} catch (e) {
			if (mine === cseq) contextError = e instanceof Error ? e.message : 'Could not load the agent context';
		}
	}
	let ctxAgent: string | undefined;
	$effect(() => {
		const id = agent?.id;
		void live.state.revs.files;
		void live.state.revs.routines;
		if (id !== ctxAgent) {
			ctxAgent = id;
			context = null;
		}
		void loadContext();
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
	<!-- The tab strip is the panel header: same height and single bottom border as the chat header;
	     triggers stretch over the border (-mb-px) so the active underline replaces it. -->
	<Tabs.List variant="line" class="h-14 shrink-0 items-stretch gap-4 border-b px-3">
		{#each [['routines', 'Routines'], ['files', 'Files'], ['tasks', 'Tasks'], ['settings', 'Settings']] as [v, label] (v)}
			<Tabs.Trigger value={v} class="items-center pb-0">{label}</Tabs.Trigger>
		{/each}
	</Tabs.List>
	<div class="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
		<Tabs.Content value="routines">
			{#if contextError}<p class="text-destructive-text">{contextError}</p>{/if}
			{#if agent && context}
				<RoutinesTab agentId={agent.id} routines={context.routines} onChange={() => void loadContext()} />
			{:else if !contextError}
				<p class="text-muted-foreground">Loading…</p>
			{/if}
		</Tabs.Content>
		<Tabs.Content value="files" class="flex flex-col gap-1">
			{#if contextError}<p class="text-destructive-text">{contextError}</p>{/if}
			{#each context?.files ?? [] as f (f.path)}
				<a href="/files?path={encodeURIComponent(f.path)}" class="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-accent">
					<FileTextIcon class="size-4 shrink-0 text-muted-foreground" />
					<span class="min-w-0 flex-1">
						<span class="block truncate font-mono text-xs" title={f.path}>{basename(f.path)}</span>
						<span class="block truncate text-xs text-muted-foreground">{f.path}</span>
					</span>
					<span class="text-xs text-muted-foreground">{formatBytes(f.size)} · {formatTime(f.updatedAt)}</span>
				</a>
			{/each}
			{#if context && !context.files.length}
				<p class="text-muted-foreground">No files from this agent yet.</p>
			{:else if !context && !contextError}
				<p class="text-muted-foreground">Loading…</p>
			{/if}
			<a href="/files" class="mt-2 inline-block text-xs text-info-text underline underline-offset-4">Open files</a>
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
			{#if delegated.length}<h3 class="{owned.length ? 'mt-2' : ''} text-xs font-medium text-muted-foreground">Delegated</h3>{/if}
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
				<h3 class="mt-5 mb-2 text-xs font-medium text-muted-foreground">Agent memory</h3>
				{#key agent.id}
					<MemoryEditor scope="agent" agentId={agent.id} compact />
				{/key}
			{:else}
				<p class="text-muted-foreground">Loading…</p>
			{/if}
		</Tabs.Content>
	</div>
</Tabs.Root>
