<script lang="ts">
	import FileTextIcon from 'phosphor-svelte/lib/FileText';
	import ClockIcon from 'phosphor-svelte/lib/Clock';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import AgentEditor from './AgentEditor.svelte';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	// MOCK: routines, files and tasks are not served by the API yet.
	import { files, routines, tasks } from '#lib/mock.js';

	let { agentId }: { agentId: string } = $props();
	const agent = $derived(agentsStore.find(agentId));
	const agentTasks = $derived(tasks.filter((t) => t.agentId === agent?.slug)); // MOCK ids are slugs
</script>

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
			{#each agentTasks as t (t.id)}
				<div class="rounded-lg border border-border bg-card p-3">
					<div class="font-medium">{t.title}</div>
					<div class="mt-1 text-xs text-muted-foreground">{t.column}</div>
				</div>
			{:else}
				<p class="text-muted-foreground">No tasks for this agent.</p>
			{/each}
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
