<script lang="ts">
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import ConnectorIcon from '#lib/components/app/ConnectorIcon.svelte';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { accountName, accountsOfAgent } from '#lib/connectors/access.js';
	import { connectorsStore } from '#lib/connectors/connectors.svelte.js';
	import { initialsOf } from '#lib/connectors/custom.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openEditAgent } from '#lib/stores/dialogs.svelte.js';
	import type { Connection } from '#lib/api/index.js';

	let { onOpenAccount }: { onOpenAccount: (c: Connection) => void } = $props();

	const store = connectorsStore.state;
	const agents = $derived(agentsStore.state.agents);
	const nameOf = (c: Connection): string => accountName(c, store.connectors.find((x) => x.id === c.definitionId)?.name);
	const iconOf = (c: Connection): string | undefined => store.connectors.find((x) => x.id === c.definitionId)?.icon;
</script>

{#if !agentsStore.state.loaded}
	<div class="flex flex-col gap-2">{#each [0, 1, 2] as n (n)}<Skeleton class="h-14 rounded-xl" />{/each}</div>
{:else}
	<ul class="divide-y divide-border rounded-xl border border-border" data-testid="by-agent">
		{#each agents as a (a.id)}
			{@const accounts = accountsOfAgent(a.id, store.connections)}
			<li class="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-3">
				<div class="flex min-w-0 items-center gap-2.5 sm:w-52 sm:shrink-0">
					<AgentAvatar seed={a.id} color={a.color} size={32} label={a.name} />
					<span class="truncate text-sm font-medium">{a.name}</span>
				</div>
				<div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
					{#each accounts as c (c.id)}
						<button type="button" onclick={() => onOpenAccount(c)} class="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-background pr-2.5 pl-1 text-xs outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" title="Manage {nameOf(c)}">
							{#if c.custom}
								<span aria-hidden="true" class="flex size-5 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">{initialsOf(c.label)}</span>
							{:else}
								<ConnectorIcon icon={iconOf(c)} class="size-5 rounded-full" />
							{/if}
							<span class="truncate">{nameOf(c)}</span>
						</button>
					{:else}
						<span class="text-xs text-muted-foreground">No connectors</span>
					{/each}
				</div>
				<button type="button" onclick={() => openEditAgent(a.id, 'connectors')} class="self-start text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:self-center">Edit</button>
			</li>
		{:else}
			<li class="p-4 text-sm text-muted-foreground">No agents yet.</li>
		{/each}
	</ul>
{/if}
