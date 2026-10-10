<script lang="ts">
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimple';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import XIcon from 'phosphor-svelte/lib/X';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import type { Agent, Connection } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { ACCESS_LABEL, accessOf, excludedOf, matchAgents, putFor, toggleAgent, usersOf } from '#lib/connectors/access.js';
	import { connectorsStore } from '#lib/connectors/connectors.svelte.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { cn } from '#lib/utils.js';

	/** Who uses this account: All agents, or Selected agents. Saves at once (optimistic, toast on error). */
	let { connection, compact = false }: { connection: Connection; compact?: boolean } = $props();

	const agents = $derived(agentsStore.state.agents);
	const access = $derived(accessOf(connection));
	const users = $derived(usersOf(connection, agents));
	const excluded = $derived(excludedOf(connection, agents));
	let query = $state('');
	let open = $state(false);
	const shown = $derived(matchAgents(agents, query));

	async function save(mode: 'all' | 'selected', agentIds: string[], excludedAgentIds?: string[]): Promise<void> {
		try {
			await connectorsStore.setAccess(connection.id, { ...putFor(mode, agentIds), ...(excludedAgentIds ? { excludedAgentIds } : {}) }, agents.map((a) => a.id));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not change who uses it');
		}
	}
	const setMode = (mode: 'all' | 'selected'): void => {
		if (mode !== access.mode) void save(mode, access.mode === 'selected' ? access.agentIds : []);
	};
	const toggle = (a: Agent): void => void save('selected', toggleAgent(access.agentIds, a.id));
	const turnBackOn = (a: Agent): void => void save('all', [], access.excludedAgentIds.filter((id) => id !== a.id));
</script>

{#snippet chip(a: Agent, onRemove?: () => void, label?: string)}
	<span class="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-background pr-2.5 pl-1 text-xs">
		<AgentAvatar seed={a.id} color={a.color} size={20} />
		<span class="truncate">{a.name}</span>
		{#if onRemove}
			<button type="button" class="-mr-1 rounded-full p-0.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" aria-label={label ?? `Remove ${a.name}`} onclick={onRemove}><XIcon class="size-3" /></button>
		{/if}
	</span>
{/snippet}

<div class="flex flex-col gap-2.5 border-t border-border px-3.5 py-3" data-testid="access-control">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<span class="text-sm font-medium">Access</span>
		<div role="radiogroup" aria-label="Who uses this account" class="inline-flex rounded-lg border border-border p-0.5">
			{#each ['all', 'selected'] as const as m (m)}
				<button
					type="button"
					role="radio"
					aria-checked={access.mode === m}
					onclick={() => setMode(m)}
					class={cn('h-6 rounded-md px-2.5 text-xs font-medium transition-colors outline-none focus-visible:outline-2 focus-visible:outline-ring', access.mode === m ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>{ACCESS_LABEL[m]}</button
				>
			{/each}
		</div>
	</div>

	{#if access.mode === 'all'}
		<p class="text-xs text-muted-foreground">Every agent can use it. Each agent can still turn it off in its own Connectors tab.</p>
		{#if excluded.length}
			<div class="flex flex-wrap items-center gap-1.5">
				<span class="text-xs text-muted-foreground">Except:</span>
				{#each excluded as a (a.id)}{@render chip(a, () => turnBackOn(a), `Turn it back on for ${a.name}`)}{/each}
			</div>
		{/if}
	{:else}
		<div class="flex flex-wrap items-center gap-1.5">
			{#each users as a (a.id)}{@render chip(a, () => toggle(a))}{/each}
			{#if users.length === 0}<span class="text-xs text-muted-foreground">Not used by any agent yet</span>{/if}
			<Popover.Root bind:open onOpenChange={(o) => o && (query = '')}>
				<Popover.Trigger>
					{#snippet child({ props })}
						<Button {...props} size="xs" variant="outline" class="h-7 rounded-full">
							{#if users.length}<PencilSimpleIcon class="size-3" />Edit{:else}<PlusIcon class="size-3" />Choose agents{/if}
						</Button>
					{/snippet}
				</Popover.Trigger>
				<Popover.Content elevation="floating" align="start" class="flex max-h-[min(60svh,22rem)] w-[min(92vw,20rem)] flex-col gap-2 p-2">
					<Input bind:value={query} placeholder="Search agents" aria-label="Search agents" class="h-8" />
					<ul class="flex min-h-0 flex-1 flex-col overflow-y-auto" role="listbox" aria-multiselectable="true" aria-label="Agents">
						{#each shown as a (a.id)}
							{@const on = access.agentIds.includes(a.id)}
							<li>
								<button type="button" role="option" aria-selected={on} onclick={() => toggle(a)} class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent">
									<AgentAvatar seed={a.id} color={a.color} size={24} />
									<span class="min-w-0 flex-1 truncate">{a.name}</span>
									{#if on}<CheckIcon class="size-4 shrink-0" />{/if}
								</button>
							</li>
						{:else}
							<li class="px-2 py-3 text-center text-xs text-muted-foreground">No agent matches.</li>
						{/each}
					</ul>
				</Popover.Content>
			</Popover.Root>
		</div>
		{#if connection.scope === 'agent'}<p class="text-xs text-muted-foreground">Now only one agent has it. Choose more agents to share it.</p>{/if}
	{/if}
</div>
