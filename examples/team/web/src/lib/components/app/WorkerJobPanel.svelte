<script lang="ts">
	import StopIcon from 'phosphor-svelte/lib/Stop';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { formatUsd } from '#lib/context.js';
	import { relativeTime } from '#lib/routines/schedule.js';
	import type { TaskDetail } from '#lib/api/client.js';
	import type { TurnUsage } from '#lib/tasks/live-stream.js';
	import { jobStats } from '#lib/tasks/job.js';

	/**
	 * The long-run job of a background worker task: it runs as a chain of chunks (checkpoints in
	 * between) and survives restarts. Shows where it is and lets a person stop it.
	 */
	let {
		taskId,
		job,
		turn,
		onChange
	}: {
		taskId: string;
		job: NonNullable<TaskDetail['job']>;
		/** Steps and cost of the turn running now (the job row counts finished turns only). */
		turn?: TurnUsage;
		onChange?: () => void;
	} = $props();

	const stats = $derived(jobStats(job, turn));

	let stopping = $state(false);

	const label = $derived(
		job.status === 'running'
			? 'Running'
			: job.status === 'finished'
				? 'Finished'
				: job.stopReason === 'stopped' || job.stopReason === 'aborted'
					? 'Stopped'
					: `Stopped: ${reasonText(job.stopReason)}`
	);
	const variant = $derived(job.status === 'running' ? 'default' : job.status === 'finished' ? 'secondary' : 'destructive');

	function reasonText(reason: string | null): string {
		if (reason === 'cost') return 'cost limit reached';
		if (reason === 'duration') return 'time limit reached';
		if (reason === 'stuck') return 'it stopped making progress';
		return reason ?? 'unknown reason';
	}

	async function stop(): Promise<void> {
		stopping = true;
		try {
			await api.post('/tasks/{id}/stop', { params: { id: taskId } });
			toast.success('Stopping the job');
			onChange?.();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not stop the job');
		} finally {
			stopping = false;
		}
	}
</script>

<section class="shrink-0 border-b border-border bg-muted/30 px-3 py-2 text-xs" data-testid="worker-job" aria-label="Background job">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
		<Badge {variant} data-testid="worker-job-status">{label}</Badge>
		<span class="text-muted-foreground" data-testid="worker-job-chunk">Chunk {stats.chunk}</span>
		<span class="text-muted-foreground" data-testid="worker-job-steps">{stats.steps} {stats.steps === 1 ? 'step' : 'steps'}</span>
		<span class="text-muted-foreground" data-testid="worker-job-cost">{formatUsd(stats.costUsd)} so far</span>
		<span class="text-muted-foreground">started {relativeTime(job.startedAt)}</span>
		<span class="flex-1"></span>
		{#if job.status === 'running'}
			<Button size="sm" variant="outline" disabled={stopping} onclick={() => void stop()} data-testid="worker-job-stop">
				<StopIcon class="size-3.5" weight="fill" />
				Stop job
			</Button>
		{/if}
	</div>
	{#if job.checkpoint}
		<p class="mt-1.5 line-clamp-3 whitespace-pre-wrap text-muted-foreground" data-testid="worker-job-checkpoint">
			<span class="font-medium text-foreground">Last checkpoint ({relativeTime(job.updatedAt)}):</span>
			{job.checkpoint}
		</p>
	{/if}
</section>
