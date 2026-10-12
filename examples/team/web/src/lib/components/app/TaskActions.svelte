<script lang="ts">
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import ArrowUUpLeftIcon from 'phosphor-svelte/lib/ArrowUUpLeft';
	import PlayIcon from 'phosphor-svelte/lib/Play';
	import type { Task } from '#lib/api/client.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { inReview } from '#lib/board/board.js';
	import { acceptTask, cancelTask, sendBackTask, setHold, setPriority, startTask } from '#lib/tasks/actions.js';
	import { PRIORITIES, type Priority } from '#lib/tasks/queue.js';

	/**
	 * The actions of a task of the work queue: start / hold / cancel while it waits, Accept / Send back
	 * in Review, Try again after a failure. A footer of the task drawer (never inside the scrolling
	 * details), so the buttons are reachable at any window height.
	 */
	let { task }: { task: Task } = $props();

	const queued = $derived(task.status === 'queued');
	const review = $derived(inReview(task));
	/** A work item that ended without finishing: the client can send it again with a note. */
	const retry = $derived(task.createdBy !== null && ['failed', 'stopped', 'interrupted', 'timed_out'].includes(task.status));
	const held = $derived(task.hold || task.queue === 'hold');

	let sendingBack = $state(false);
	let note = $state('');
	let busy = $state(false);
	/** What the server said happens next after a send-back. */
	let sentHint = $state('');

	async function accept(): Promise<void> {
		busy = true;
		await acceptTask(task.id);
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
		}
		busy = false;
	}
	async function start(): Promise<void> {
		busy = true;
		await startTask(task.id);
		busy = false;
	}
</script>

{#if sentHint || queued || review || retry || task.acceptedAt !== null}
	<footer class="max-h-[50svh] shrink-0 overflow-y-auto border-t border-border bg-popover px-4 py-2.5 text-sm" aria-label="Task actions" data-testid="task-actions">
		<div class="mx-auto flex w-full max-w-3xl flex-col gap-2">
			{#if sentHint}
				<p class="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs" role="status" data-testid="send-back-hint">{sentHint}</p>
			{/if}
			{#if queued}
				<div class="flex flex-wrap items-center gap-2">
					<Button size="sm" disabled={busy} onclick={() => void start()}><PlayIcon /> Start now</Button>
					<Button size="sm" variant="outline" onclick={() => void setHold(task.id, !held)}>{held ? 'Release hold' : 'Hold'}</Button>
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
						<Textarea bind:value={note} rows={3} placeholder="What should change? The agent reads this with the brief and starts again." aria-label="Note for the agent" />
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
							<Button size="sm" disabled={busy || note.trim() === ''} onclick={() => void sendBack()}>Try again</Button>
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
	</footer>
{/if}
