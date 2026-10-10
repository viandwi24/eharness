<script lang="ts">
	import type { TaskDetail } from '#lib/api/client.js';
	import { api } from '#lib/api/index.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { badgeFor } from '#lib/board/board.js';
	import { formatTime } from '#lib/format.js';
	import MessageView from '#lib/parts/MessageView.svelte';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { closeTask, drawer, openSession } from '#lib/stores/drawer.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import PendingCard from './PendingCard.svelte';

	let detail = $state<TaskDetail | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(false);

	const open = $derived(drawer.taskId !== null);
	const task = $derived(detail?.task);
	const agent = $derived(task ? agentsStore.find(task.agentId) : undefined);
	// Re-read when the board says this task changed (status / activity) or its approvals moved.
	const stamp = $derived.by(() => {
		const t = live.state.tasks.find((x) => x.id === drawer.taskId);
		return `${t?.status}:${t?.lastActivityAt}:${live.state.approvals.filter((a) => a.taskId === drawer.taskId).length}`;
	});

	let seq = 0;
	async function load(id: string): Promise<void> {
		const mine = ++seq;
		loading = detail?.task.id !== id;
		try {
			const d = await api.get('/tasks/{id}', { params: { id } });
			if (mine !== seq) return;
			detail = d;
			error = null;
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the task';
		} finally {
			if (mine === seq) loading = false;
		}
	}
	$effect(() => {
		const id = drawer.taskId;
		void stamp;
		if (id) void load(id);
		else {
			detail = null;
			error = null;
		}
	});

	let note = $state('');
	let sending = $state(false);
	let aborting = $state(false);
	// Steer joins the running turn; with nothing running the server queues a turn.
	const running = $derived(task?.status === 'running');

	async function abort(): Promise<void> {
		if (!task) return;
		aborting = true;
		try {
			const r = await api.post('/tasks/{id}/abort', { params: { id: task.id } });
			toast.success(r.target === 'idle' ? 'Nothing was running' : 'Stopping the task');
			void load(task.id);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not stop the task');
		} finally {
			aborting = false;
		}
	}

	async function sendNote(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		const text = note.trim();
		if (!task || !text) return;
		sending = true;
		try {
			await api.post('/tasks/{id}/messages', { params: { id: task.id }, body: { text } });
			note = '';
			toast.success(running ? 'Sent to the running task' : 'Message queued');
			void load(task.id);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not send the message');
		} finally {
			sending = false;
		}
	}

	function answerFromPart(a: { id: string; approved: boolean; reason?: string }): void {
		const item = detail?.approvals.find((x) => x.id === a.id);
		if (item) void live.answer(item, { approved: a.approved, ...(a.reason ? { reason: a.reason } : {}) }).catch(() => {});
	}
</script>

<Sheet.Root {open} onOpenChange={(o) => !o && closeTask()}>
	<Sheet.Content side="right" class="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
		<Sheet.Header class="border-b border-border p-4">
			<div class="flex items-center gap-3">
				{#if task}<AgentAvatar seed={task.agentId} color={agent?.color} size={32} label={agent?.name ?? task.agentId} />{/if}
				<div class="min-w-0 flex-1">
					<Sheet.Title class="truncate">{task?.title ?? 'Task'}</Sheet.Title>
					<Sheet.Description class="truncate">
						{agent?.name ?? task?.agentId ?? ''}{task ? ` · ${formatTime(task.lastActivityAt)}` : ''}
					</Sheet.Description>
				</div>
				{#if task}{@const b = badgeFor(task.status)}<Badge variant={b.variant}>{b.label}</Badge>{/if}
				{#if running}
					<Button size="sm" variant="outline" disabled={aborting} onclick={abort}>{aborting ? 'Stopping…' : 'Stop'}</Button>
				{/if}
			</div>
		</Sheet.Header>

		<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
			{#if error}
				<p class="text-sm text-destructive-text">{error}</p>
			{:else if loading}
				<p class="text-sm text-muted-foreground">Loading…</p>
			{:else if detail}
				{#each detail.approvals as a (a.sessionId + a.id)}
					<PendingCard approval={a} />
				{/each}
				{#each detail.messages as m (m.id)}
					<MessageView
						message={m as never}
						agent={agent ? { id: agent.id, name: agent.name, color: agent.color } : undefined}
						onApproval={answerFromPart}
						onOpenSession={(sid) => void openSession(sid)}
					/>
				{:else}
					<p class="text-sm text-muted-foreground">No messages yet.</p>
				{/each}
			{/if}
		</div>
		{#if task}
			<form class="flex gap-2 border-t border-border p-3" onsubmit={sendNote}>
				<Textarea
					bind:value={note}
					rows={2}
					class="min-h-0 flex-1"
					placeholder={running ? 'Message the running task…' : 'Send a follow-up to this task…'}
					aria-label="Message to the task"
					onkeydown={(e) => {
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
					}}
				/>
				<Button type="submit" disabled={sending || !note.trim()} class="self-end">{sending ? 'Sending…' : 'Send'}</Button>
			</form>
		{/if}
	</Sheet.Content>
</Sheet.Root>
