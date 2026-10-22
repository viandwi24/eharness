<script lang="ts">
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import ApiAgentDialog from './ApiAgentDialog.svelte';
	import type { ApiAgent } from '#lib/developers/model.js';

	let { agents, onChanged }: { agents: ApiAgent[]; onChanged: () => void } = $props();

	let open = $state(false);
	let editing = $state<ApiAgent | undefined>(undefined);
	const edit = (a: ApiAgent | undefined): void => {
		editing = a;
		open = true;
	};
</script>

<div class="flex flex-col gap-3" data-testid="api-agents">
	<div class="flex items-center justify-between gap-3">
		<p class="text-sm text-muted-foreground">Isolated agents other applications call. They are not part of your team: no chats, channels or team tools.</p>
		<Button size="sm" onclick={() => edit(undefined)} data-testid="new-api-agent"><PlusIcon class="size-4" /> New API agent</Button>
	</div>
	{#if agents.length === 0}
		<div class="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground" data-testid="api-agents-empty">No API agent yet. Create one, then make a key for it.</div>
	{:else}
		<ul class="flex flex-col gap-2">
			{#each agents as a (a.id)}
				<li>
					<button type="button" class="flex w-full flex-col gap-1.5 rounded-xl border border-border bg-card p-3 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring" onclick={() => edit(a)} data-testid="api-agent-row">
						<div class="flex flex-wrap items-center gap-2">
							<span class="text-sm font-medium">{a.name}</span>
							<span class="font-mono text-xs text-muted-foreground">{a.slug}</span>
							{#if a.readFolders.length === 0 && !a.writeFolder && !a.webSearch}<Badge variant="outline">No tools</Badge>{/if}
							{#if a.readFolders.length > 0}<Badge variant="secondary">Reads {a.readFolders.length} folder{a.readFolders.length === 1 ? '' : 's'}</Badge>{/if}
							{#if a.writeFolder}<Badge variant="warning">Writes {a.writeFolder}</Badge>{/if}
							{#if a.webSearch}<Badge variant="info">Web search</Badge>{/if}
						</div>
						{#if a.description}<span class="text-xs text-muted-foreground">{a.description}</span>{/if}
						<span class="text-xs text-muted-foreground">Model: {a.model ?? 'workspace default'} · conversations kept {a.retentionDays} days</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<ApiAgentDialog bind:open agent={editing} onSaved={onChanged} />
