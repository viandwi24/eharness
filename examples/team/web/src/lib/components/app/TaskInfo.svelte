<script lang="ts">
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import ArrowUUpLeftIcon from 'phosphor-svelte/lib/ArrowUUpLeft';
	import type { Task } from '#lib/api/client.js';
	import { MessageResponse } from '#lib/components/ai/message/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { inReview } from '#lib/board/board.js';
	import { REPORT_LABELS } from '#lib/programs/form.js';
	import { api } from '#lib/api/index.js';
	import { programAction } from '#lib/programs/actions.js';
	import { manualWorker } from '#lib/tasks/sendback.js';
	import { acceptTask, cancelTask, recheckDeliverables, sendBackTask, setPriority } from '#lib/tasks/actions.js';
	import { dueLabel, PRIORITIES, priorityLabel, type Priority } from '#lib/tasks/queue.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	/** What a task of the work queue is: brief, inputs, outputs, report and the Review actions. */
	let { task }: { task: Task } = $props();

	const queued = $derived(task.status === 'queued');
	const review = $derived(inReview(task));
	/** A work item that ended without finishing: the client can queue it again with a note. */
	const retry = $derived(task.createdBy !== null && ['failed', 'stopped', 'interrupted', 'timed_out'].includes(task.status));
	const due = $derived(dueLabel(task.dueAt));
	const creator = $derived(task.createdBy === null ? '' : task.createdBy === 'client' ? 'you' : (agentsStore.find(task.createdBy)?.name ?? task.createdBy));
	const hasBody = $derived(task.createdBy !== null || task.report !== null || task.deliverables !== null);

	let sendingBack = $state(false);
	let note = $state('');
	let busy = $state(false);
	/** What the server said happens next after a send-back, and the manual worker to run now. */
	let sentHint = $state('');
	let worker = $state<Program | null>(null);
	type Program = import('#lib/api/schema.js').components['schemas']['Program'];

	async function accept(): Promise<void> {
		busy = true;
		await acceptTask(task.id);
		busy = false;
	}
	async function recheck(): Promise<void> {
		busy = true;
		await recheckDeliverables(task.id);
		busy = false;
	}
	async function sendBack(): Promise<void> {
		if (note.trim() === '') return;
		busy = true;
		const sent = await sendBackTask(task.id, note.trim());
		if (sent !== null) {
			note = '';
			sendingBack = false;
			sentHint = sent.hint;
			try {
				worker = manualWorker(task, (await api.get('/programs')).programs);
			} catch {
				worker = null;
			}
		}
		busy = false;
	}
	async function runWorker(): Promise<void> {
		if (worker === null) return;
		busy = true;
		if (await programAction(worker, 'run')) worker = null;
		busy = false;
	}
</script>

{#if hasBody}
	<section class="shrink-0 border-b border-border bg-muted/30 px-4 py-3 text-sm" aria-label="Task details" data-testid="task-info">
		<div class="mx-auto flex w-full max-w-3xl flex-col gap-3">
			<div class="flex flex-wrap items-center gap-1.5 text-xs">
				{#if task.createdBy !== null}
					<Badge variant={task.priority === 'urgent' || task.priority === 'high' ? 'warning' : 'secondary'}>{priorityLabel(task.priority)} priority</Badge>
					{#if due}<Badge variant={due.late && queued ? 'destructive' : 'outline'}>{due.text}</Badge>{/if}
					{#if task.round > 1}<Badge variant="outline">round {task.round}</Badge>{/if}
					<span class="text-muted-foreground">queued by {creator}</span>
				{/if}
				{#if task.report}<Badge variant={REPORT_LABELS[task.report.status].variant}>{REPORT_LABELS[task.report.status].label}</Badge>{/if}
			</div>

			{#if task.brief}
				<details open={queued || review} class="group">
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

			{#if sentHint}
				<div class="flex flex-wrap items-center gap-2 rounded-md border border-border bg-popover px-3 py-2 text-xs" role="status" data-testid="send-back-hint">
					<span class="min-w-0 flex-1">{sentHint}</span>
					{#if worker}<Button size="sm" variant="outline" disabled={busy} onclick={() => void runWorker()}>Run now</Button>{/if}
				</div>
			{/if}

			{#if queued}
				<div class="flex flex-wrap items-center gap-2">
					<label class="flex items-center gap-2 text-xs text-muted-foreground">
						Priority
						<NativeSelect value={task.priority} size="sm" aria-label="Priority" onchange={(e: Event) => void setPriority(task.id, (e.currentTarget as HTMLSelectElement).value as Priority)}>
							{#each PRIORITIES as p (p.value)}<NativeSelectOption value={p.value}>{p.label}</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
					<span class="flex-1"></span>
					<Button size="sm" variant="outline" onclick={() => void cancelTask(task.id)}>Cancel task</Button>
				</div>
			{:else if review}
				{#if sendingBack}
					<div class="flex flex-col gap-2">
						<Textarea bind:value={note} rows={3} placeholder="What should change? The agent reads this with the brief." aria-label="Note for the agent" />
						<div class="flex gap-2">
							<Button size="sm" disabled={busy || note.trim() === ''} onclick={() => void sendBack()}><ArrowUUpLeftIcon /> Send back</Button>
							<Button size="sm" variant="ghost" onclick={() => (sendingBack = false)}>Cancel</Button>
						</div>
					</div>
				{:else}
					<div class="flex gap-2">
						<Button size="sm" disabled={busy} onclick={() => void accept()}><CheckIcon /> Accept</Button>
						<Button size="sm" variant="outline" onclick={() => (sendingBack = true)}><ArrowUUpLeftIcon /> Send back with a note</Button>
					</div>
				{/if}
			{:else if retry}
				{#if sendingBack}
					<div class="flex flex-col gap-2">
						<Textarea bind:value={note} rows={2} placeholder="Anything the agent should know before it tries again?" aria-label="Note for the agent" />
						<div class="flex gap-2">
							<Button size="sm" disabled={busy || note.trim() === ''} onclick={() => void sendBack()}>Queue again</Button>
							<Button size="sm" variant="ghost" onclick={() => (sendingBack = false)}>Cancel</Button>
						</div>
					</div>
				{:else}
					<Button size="sm" variant="outline" class="self-start" onclick={() => (sendingBack = true)}><ArrowUUpLeftIcon /> Try again</Button>
				{/if}
			{:else if task.acceptedAt !== null}
				<p class="text-xs text-muted-foreground">Accepted.</p>
			{/if}
		</div>
	</section>
{/if}
