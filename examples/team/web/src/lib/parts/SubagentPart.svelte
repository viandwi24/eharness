<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOut';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Badge, type BadgeVariant } from '#lib/components/ui/badge/index.js';
	import CircleNotchIcon from 'phosphor-svelte/lib/CircleNotch';
	import { live } from '#lib/stores/live.svelte.js';
	import type { PartView, SubagentProgress, SubagentRun, SubagentStatus } from './map.js';
	import { canContinue, childSessionOf, resolveStatus, STATUS_LABEL, taskOfCall } from './subagent.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { api, harness } from '#lib/api/index.js';
	import { toast } from 'svelte-sonner';
	import { CONTINUE_TEXT } from 'eharness/client';

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
	// The marker is stored for every call; a background start also names the child in its result.
	const known = $derived(childSessionOf(run, view.kind === 'tool' ? view.output : undefined) ?? progress?.sessionId);
	const toolCallId = $derived(view.kind === 'tool' ? view.toolCallId : view.run.toolCallId);
	// Later status lives in the task row of the child session (kept current by the live events).
	const task = $derived(taskOfCall(live.state.tasks, known, toolCallId));
	const sessionId = $derived(known ?? task?.sessionId);

	// The task row is the truth (the child keeps running after a cancelled call, and a failed run can
	// be followed up); the stored marker and the tool state only cover calls without a task row.
	const status = $derived<SubagentStatus>(resolveStatus({ task, run, progress, toolState, tasksLoaded: live.state.tasksLoaded, background: view.kind === 'tool' && typeof view.output === 'string' && view.output.startsWith('Started background subagent') }));
	const variants: Record<SubagentStatus, BadgeVariant> = {
		running: 'info',
		waiting: 'warning',
		completed: 'success',
		failed: 'destructive',
		stopped: 'outline',
		interrupted: 'warning',
		timed_out: 'warning',
		not_started: 'destructive'
	};
	let acting = $state(false);
	/** Continue the child where it stopped (a message into its session) or stop it. */
	async function act(kind: 'continue' | 'stop'): Promise<void> {
		if (!task || acting) return;
		acting = true;
		try {
			if (kind === 'continue') {
				await api.post('/tasks/{id}/messages', { params: { id: task.id }, body: { text: CONTINUE_TEXT } });
				toast.success('Continuing the task');
			} else {
				const r = await harness.sessions.interrupt(task.sessionId);
				toast.success(r.target === 'idle' ? 'Nothing was running' : 'Stopping the task');
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not do that');
		} finally {
			acting = false;
		}
	}
	const detail = $derived.by(() => {
		if (!progress) return undefined;
		const bits = [`${progress.steps} ${progress.steps === 1 ? 'step' : 'steps'}`];
		if (progress.lastTool) bits.push(progress.lastTool);
		return bits.join(' · ');
	});
	const latest = $derived(progress?.text?.trim().split('\n').filter(Boolean).at(-1));
</script>

{#snippet body()}
	<AgentAvatar seed={agent} size={28} label={label} />
	<div class="min-w-0 flex-1">
		<div class="flex flex-wrap items-center gap-2">
			<span class="font-medium">{label}</span>
			{#if label !== agent}<span class="text-xs text-muted-foreground">{agent}</span>{/if}
			<Badge shape="pill" variant={variants[status]}>{STATUS_LABEL[status] ?? status}</Badge>
			{#if status === 'running'}<CircleNotchIcon class="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />{/if}
			{#if detail}<span class="font-mono text-[11.5px] text-muted-foreground">{detail}</span>{/if}
		</div>
		{#if description}<p class="mt-0.5 truncate text-muted-foreground">{description}</p>{/if}
		{#if latest && status === 'running'}<p class="mt-1 line-clamp-2 text-foreground-2">{latest}</p>{/if}
	</div>
	{#if sessionId && onOpenSession}<ArrowSquareOutIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />{/if}
{/snippet}

<div class="flex w-full max-w-lg flex-col gap-1.5">
{#if sessionId && onOpenSession}
	<Surface
		as="button"
		type="button"
		aria-label={`Open ${label} session`}
		class="flex w-full max-w-lg cursor-pointer items-start gap-3 p-3 text-left text-[13.5px] transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
		onclick={() => onOpenSession(sessionId)}
	>
		{@render body()}
	</Surface>
{:else}
	<Surface class="flex w-full max-w-lg items-start gap-3 p-3 text-[13.5px]">
		{@render body()}
	</Surface>
{/if}
{#if task && (status === 'running' || canContinue(status))}
	<div class="flex items-center gap-1.5 px-1" data-testid="subagent-actions">
		{#if status === 'running'}
			<Button size="xs" variant="ghost" disabled={acting} onclick={() => void act('stop')}>Stop</Button>
		{:else if status !== 'completed'}
			<Button size="xs" variant="outline" disabled={acting} onclick={() => void act('continue')}>Continue</Button>
		{/if}
	</div>
{/if}
</div>
