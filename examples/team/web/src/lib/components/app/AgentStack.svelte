<script lang="ts">
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import type { Agent } from '#lib/api/index.js';

	/** Overlapping avatars of the agents that use something (at most `max`, then "+n"). */
	let { agents, max = 3, size = 20 }: { agents: Agent[]; max?: number; size?: number } = $props();
	const shown = $derived(agents.slice(0, max));
</script>

{#if agents.length}
	<span class="inline-flex items-center" title={agents.map((a) => a.name).join(', ')}>
		{#each shown as a, i (a.id)}
			<span class="rounded-full bg-card ring-2 ring-card {i ? '-ml-1.5' : ''}"><AgentAvatar seed={a.id} color={a.color} {size} label={a.name} /></span>
		{/each}
		{#if agents.length > max}<span class="ml-1 text-[11px] text-muted-foreground">+{agents.length - max}</span>{/if}
	</span>
{/if}
