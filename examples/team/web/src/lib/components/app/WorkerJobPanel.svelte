<script lang="ts">
	import StopIcon from 'phosphor-svelte/lib/Stop';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { formatUsd } from '#lib/context.js';
	import { relativeTime } from '#lib/routines/schedule.js';
	import type { TaskDetail } from '#lib/api/client.js';

	/**
	 * The long-run job of a background worker task: it runs as a chain of chunks (checkpoints in
	 * between) and survives restarts. Shows where it is and lets a person stop it.
	 */
	let { taskId, job, onChange }: { taskId: string; job: NonNullable<TaskDetail['job']>; onChange?: () => void } = $props();

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
		<span class="text-muted-foreground">Chunk {job.chunk}</span>
		<span class="text-muted-foreground">{job.steps} steps</span>
		<span class="text-muted-foreground">{formatUsd(job.costUsd)} so far</span>
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
