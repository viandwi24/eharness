<script lang="ts">
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOut';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Badge, type BadgeVariant } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { PartView, SubagentProgress, SubagentRun } from './map.js';

	// Accepts either the merged `agent` tool view or a standalone `data-subagent.run` view.
	let {
		view,
		onOpenSession
	}: {
		view: Extract<PartView, { kind: 'tool' | 'subagentRun' }>;
		/** Open the child session (task drawer / transcript). */
		onOpenSession?: (sessionId: string) => void;
	} = $props();

	const run = $derived<SubagentRun | undefined>(view.kind === 'tool' ? view.run : view.run);
	const progress = $derived<SubagentProgress | undefined>(view.kind === 'tool' ? view.progress : undefined);
	const toolState = $derived(view.kind === 'tool' ? view.state : undefined);
	const input = $derived(view.kind === 'tool' && view.input && typeof view.input === 'object' ? (view.input as Record<string, unknown>) : {});

	const agent = $derived(run?.agent ?? progress?.agent ?? (typeof input.subagent_type === 'string' ? input.subagent_type : 'agent'));
	const label = $derived(run?.name ?? agent);
	const description = $derived(progress?.description ?? (typeof input.description === 'string' ? input.description : undefined));
	const sessionId = $derived(run?.sessionId ?? progress?.sessionId);

	// Status words are the task registry's; fall back to the tool state when only the tool part exists.
	const status = $derived.by((): SubagentRun['status'] => {
		if (run?.status) return run.status;
		if (progress?.status) return progress.status;
		if (toolState === 'output-error' || toolState === 'output-denied') return 'failed';
		if (toolState === 'output-available') return 'completed';
		return 'running';
	});
	const variants: Record<SubagentRun['status'], BadgeVariant> = {
		running: 'info',
		waiting: 'warning',
		completed: 'success',
		failed: 'destructive',
		stopped: 'outline'
	};
	const detail = $derived.by(() => {
		if (!progress) return undefined;
		const bits = [`${progress.steps} ${progress.steps === 1 ? 'step' : 'steps'}`];
		if (progress.lastTool) bits.push(progress.lastTool);
		return bits.join(' · ');
	});
	const latest = $derived(progress?.text?.trim().split('\n').filter(Boolean).at(-1));
</script>

<div class="flex w-full items-start gap-3 rounded-xl border border-border bg-card p-3 text-[13.5px]">
	<AgentAvatar seed={agent} size={28} label={label} />
	<div class="min-w-0 flex-1">
		<div class="flex flex-wrap items-center gap-2">
			<span class="font-medium">{label}</span>
			{#if label !== agent}<span class="text-xs text-muted-foreground">{agent}</span>{/if}
			<Badge shape="pill" variant={variants[status]}>{status}</Badge>
			{#if detail}<span class="font-mono text-[11.5px] text-muted-foreground">{detail}</span>{/if}
		</div>
		{#if description}<p class="mt-0.5 truncate text-muted-foreground">{description}</p>{/if}
		{#if latest && status === 'running'}<p class="mt-1 line-clamp-2 text-foreground-2">{latest}</p>{/if}
	</div>
	{#if sessionId && onOpenSession}
		<Button variant="ghost" size="icon-sm" aria-label="Open child session" onclick={() => onOpenSession(sessionId)}>
			<ArrowSquareOutIcon class="size-4" />
		</Button>
	{/if}
</div>
