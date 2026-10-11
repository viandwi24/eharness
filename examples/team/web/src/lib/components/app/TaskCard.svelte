<script lang="ts">
	import CircleNotchIcon from 'phosphor-svelte/lib/CircleNotch';
	import type { Task } from '#lib/api/client.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Card } from '#lib/components/ui/card/index.js';
	import { badgeFor } from '#lib/board/board.js';
	import { formatUsd, timeAgo } from '#lib/time.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	let { task, onOpen, highlight = false }: { task: Task; onOpen: (id: string) => void; highlight?: boolean } = $props();

	const agent = $derived(agentsStore.find(task.agentId));
	const badge = $derived.by(() => {
		if (task.status === 'needs_action') {
			return { label: 'Waiting for you', variant: 'warning' as const };
		}
		const b = badgeFor(task.status, task.summary);
		return { label: b.label[0].toUpperCase() + b.label.slice(1), variant: b.variant };
	});
</script>

<Card
	size="sm"
	role="button"
	tabindex={0}
	aria-label="Open task: {task.title}"
	onclick={() => onOpen(task.id)}
	onkeydown={(e: KeyboardEvent) => {
		if (e.target !== e.currentTarget) return;
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onOpen(task.id);
		}
	}}
	class="cursor-pointer gap-2 px-3 py-2.5 transition-colors outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring {highlight
		? 'border-[color-mix(in_srgb,var(--warning)_35%,var(--popover))]'
		: ''}"
>
	<div class="flex items-start gap-2">
		<AgentAvatar seed={task.agentId} color={agent?.color} size={20} class="mt-px shrink-0" />
		<div class="line-clamp-2 min-w-0 flex-1 text-[13px] leading-[18px] font-medium">{task.title}</div>
	</div>
	<div class="flex items-center gap-2 text-[11px] text-muted-foreground">
		<Badge variant={badge.variant} class="h-5 px-1.5 text-[11px]">
			{#if task.status === 'running'}<CircleNotchIcon class="animate-spin" />{/if}{badge.label}
		</Badge>
		<span class="min-w-0 flex-1 truncate">{agent?.name ?? task.agentId}</span>
		{#if task.costUsd > 0}<span class="shrink-0 font-mono">{formatUsd(task.costUsd)}</span>{/if}
		<span class="shrink-0">{timeAgo(task.lastActivityAt)}</span>
	</div>
</Card>
