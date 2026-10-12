<script lang="ts">
	import type { Task } from '#lib/api/client.js';
	import { MessageResponse } from '#lib/components/ai/message/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { REPORT_LABELS } from '#lib/programs/form.js';
	import { recheckDeliverables } from '#lib/tasks/actions.js';
	import { dueLabel, priorityLabel, queueStatus } from '#lib/tasks/queue.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	/** What a task of the work queue is: brief, inputs, outputs, report. The actions are in TaskActions (a footer that is always reachable). */
	let { task }: { task: Task } = $props();

	const queued = $derived(task.status === 'queued');
	const waitingFor = $derived(queueStatus(task));
	const due = $derived(dueLabel(task.dueAt));
	const creator = $derived(task.createdBy === null ? '' : task.createdBy === 'client' ? 'you' : (agentsStore.find(task.createdBy)?.name ?? task.createdBy));
	const hasBody = $derived(task.createdBy !== null || task.report !== null || task.deliverables !== null);

	async function recheck(): Promise<void> {
		busy = true;
		await recheckDeliverables(task.id);
		busy = false;
	}
	let busy = $state(false);
</script>

{#if hasBody}
	<!-- capped and scrollable: a long brief or report never pushes the conversation or the actions out of the drawer -->
	<section class="max-h-[38svh] shrink-0 overflow-y-auto border-b border-border bg-muted/30 px-4 py-3 text-sm" aria-label="Task details" data-testid="task-info">
		<div class="mx-auto flex w-full max-w-3xl flex-col gap-3">
			<div class="flex flex-wrap items-center gap-1.5 text-xs">
				{#if task.createdBy !== null}
					<Badge variant={task.priority === 'urgent' || task.priority === 'high' ? 'warning' : 'secondary'}>{priorityLabel(task.priority)} priority</Badge>
					{#if due}<Badge variant={due.late && queued ? 'destructive' : 'outline'}>{due.text}</Badge>{/if}
					{#if task.round > 1}<Badge variant="outline">round {task.round}</Badge>{/if}
					<span class="text-muted-foreground">{task.review ? 'assigned' : 'assigned (no review)'} by {creator}</span>
					{#if task.grants}<Badge variant="outline" title="Pre-approved for this task">extra permissions</Badge>{/if}
				{/if}
				{#if task.report}<Badge variant={REPORT_LABELS[task.report.status].variant}>{REPORT_LABELS[task.report.status].label}</Badge>{/if}
			</div>

			{#if waitingFor}
				<p class="rounded-md border border-border bg-popover px-3 py-2 text-xs" role="status" data-testid="queue-status">{waitingFor.detail}</p>
			{/if}
			{#if task.brief}
				<details open={queued} class="group">
					<summary class="cursor-pointer text-xs font-medium text-muted-foreground">Brief</summary>
					<div class="mt-1.5 max-h-56 overflow-y-auto rounded-md border border-border bg-popover px-3 py-2"><MessageResponse content={task.brief} class="text-[13px]" /></div>
				</details>
			{/if}
			{#if task.inputs.length}
				<div class="flex flex-col gap-1">
					<span class="text-xs font-medium text-muted-foreground">Inputs</span>
					<ul class="flex flex-wrap gap-1.5">{#each task.inputs as path (path)}<li class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{path}</li>{/each}</ul>
				</div>
			{/if}
			{#if task.report}
				<div class="flex flex-col gap-1" data-testid="task-report">
					<span class="text-xs font-medium text-muted-foreground">Report</span>
					<p>{task.report.summary}</p>
					{#if task.report.notes}<p class="text-xs text-muted-foreground">{task.report.notes}</p>{/if}
					{#if task.report.outputs.length}
						<ul class="flex flex-wrap gap-1.5" aria-label="Outputs">{#each task.report.outputs as path (path)}<li class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{path}</li>{/each}</ul>
					{/if}
				</div>
			{/if}

			{#if task.deliverables}
				<div class="flex flex-col gap-1.5" data-testid="task-deliverables">
					<div class="flex flex-wrap items-center gap-2">
						<span class="text-xs font-medium text-muted-foreground">Deliverables</span>
						<Badge variant={task.deliverables.status === 'pass' ? 'success' : 'destructive'}>{task.deliverables.status === 'pass' ? 'all met' : 'not met'}</Badge>
						{#if task.deliverables.attempts > 1}<span class="text-xs text-muted-foreground">after a fix-up turn</span>{/if}
						{#if task.deliverables.status === 'fail'}
							<Button size="sm" variant="outline" class="ml-auto" disabled={busy} onclick={() => void recheck()}>Check again</Button>
						{/if}
					</div>
					<ul class="flex flex-col gap-1">
						{#each task.deliverables.checks as check (check.path)}
							<li class="text-xs" data-ok={check.ok}>
								<span class="mr-1.5 font-medium {check.ok ? 'text-success-text' : 'text-destructive-text'}">{check.ok ? 'Pass' : 'Fail'}</span><span class="font-mono">{check.path}</span>
								{#if !check.ok}
									<ul class="ml-4 list-disc text-muted-foreground">{#each check.problems as problem (problem)}<li>{problem}</li>{/each}</ul>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/if}

		</div>
	</section>
{/if}
