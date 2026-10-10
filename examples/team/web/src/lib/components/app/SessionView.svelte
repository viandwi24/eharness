<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { UIMessage } from 'ai';
	import XIcon from 'phosphor-svelte/lib/X';
	import type { Approval, TaskDetail } from '#lib/api/client.js';
	import { api, apiBase, getToken } from '#lib/api/index.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { badgeFor } from '#lib/board/board.js';
	import { formatTime } from '#lib/format.js';
	import MessageView from '#lib/parts/MessageView.svelte';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openSession } from '#lib/stores/drawer.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { followTaskStream, isLive, mergeLive, pollDelay } from '#lib/tasks/follow.js';
	import PendingCard from './PendingCard.svelte';

	/**
	 * Watch (and steer) the session of a delegated task, like the coder's agent page: the full
	 * transcript with the same parts as the chat, live while a turn runs (the task's UI message
	 * stream, `GET /tasks/{id}/stream`), a message box and Stop.
	 */
	let { taskId, onClose }: { taskId: string; onClose?: () => void } = $props();

	let detail = $state<TaskDetail | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(false);
	/** Messages being streamed right now, laid over the stored ones by id. */
	let liveMessages = $state<Map<string, UIMessage>>(new Map());
	let streaming = $state(false);

	const task = $derived(detail?.task);
	const agent = $derived(task ? agentsStore.find(task.agentId) : undefined);
	const running = $derived(task?.status === 'running');
	const messages = $derived(mergeLive((detail?.messages ?? []) as unknown as UIMessage[], liveMessages));
	// Live approvals (events) win over the ones of the last read.
	const approvals = $derived.by((): Approval[] => {
		const fresh = live.state.approvals.filter((a) => a.taskId === taskId);
		const seen = new Set(fresh.map((a) => a.sessionId + a.id));
		return [...fresh, ...(detail?.approvals ?? []).filter((a) => !seen.has(a.sessionId + a.id))];
	});
	const stamp = $derived.by(() => {
		const t = live.state.tasks.find((x) => x.id === taskId);
		return `${t?.status}:${t?.lastActivityAt}:${live.state.approvals.filter((a) => a.taskId === taskId).length}`;
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

	// Read on open, and again when the board says the task changed (status, activity, approvals).
	$effect(() => {
		const id = taskId;
		void stamp;
		untrack(() => {
			if (detail && detail.task.id !== id) {
				detail = null;
				liveMessages = new Map();
			}
		});
		void load(id);
	});

	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

	// While the task runs: follow the stream; when it ends or nothing streams, re-read the stored
	// messages and poll (about 1 s) until the task stops running.
	let loopId = '';
	$effect(() => {
		const id = taskId;
		if (!running || loopId === id) return;
		loopId = id;
		const ctl = new AbortController();
		void (async () => {
			try {
				while (!ctl.signal.aborted) {
					const result = await followTaskStream({
						url: `${apiBase}/tasks/${id}/stream`,
						fetch: (url, init) => fetch(url, init),
						headers: getToken() ? { authorization: `Bearer ${getToken()}` } : {},
						signal: ctl.signal,
						onMessage: (m) => {
							streaming = true;
							liveMessages = new Map(liveMessages).set(m.id, structuredClone(m));
						}
					});
					if (ctl.signal.aborted) return;
					streaming = false;
					await load(id);
					liveMessages = new Map(); // the stored messages are the truth again
					if (!isLive(detail?.task.status)) return;
					await sleep(result === 'streamed' ? 250 : (pollDelay({ status: 'running', streaming: false, visible: document.visibilityState === 'visible' }) ?? 1000));
				}
			} finally {
				if (loopId === id) loopId = '';
				streaming = false;
			}
		})();
		return () => ctl.abort();
	});

	// Auto-follow: stay at the bottom while the user is there.
	let scroller = $state<HTMLDivElement | undefined>();
	let pinned = true;
	function onScroll(): void {
		if (!scroller) return;
		pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
	}
	$effect(() => {
		void messages;
		void approvals.length;
		if (pinned && scroller) void tick().then(() => scroller && (scroller.scrollTop = scroller.scrollHeight));
	});

	let note = $state('');
	let sending = $state(false);
	let aborting = $state(false);

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
			pinned = true;
			toast.success(running ? 'Sent to the running task' : 'Message queued');
			void load(task.id);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not send the message');
		} finally {
			sending = false;
		}
	}

	function answerFromPart(a: { id: string; approved: boolean; reason?: string }): void {
		const item = approvals.find((x) => x.id === a.id);
		if (item) void live.answer(item, { approved: a.approved, ...(a.reason ? { reason: a.reason } : {}) }).catch(() => {});
	}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<header class="flex items-center gap-3 border-b border-border p-4">
		{#if task}<AgentAvatar seed={task.agentId} color={agent?.color} size={32} label={agent?.name ?? task.agentId} />{/if}
		<div class="min-w-0 flex-1">
			<h2 class="truncate text-sm font-semibold">{task?.title ?? 'Task'}</h2>
			<p class="truncate text-xs text-muted-foreground">
				{agent?.name ?? task?.agentId ?? ''}{task ? ` · ${formatTime(task.lastActivityAt)}` : ''}{streaming ? ' · live' : ''}
			</p>
		</div>
		{#if task}{@const b = badgeFor(task.status)}<Badge variant={b.variant}>{b.label}</Badge>{/if}
		{#if running}
			<Button size="sm" variant="outline" disabled={aborting} onclick={abort}>{aborting ? 'Stopping…' : 'Stop'}</Button>
		{/if}
		{#if onClose}
			<Button size="icon-sm" variant="ghost" aria-label="Close" onclick={onClose}><XIcon class="size-4" /></Button>
		{/if}
	</header>

	<div bind:this={scroller} onscroll={onScroll} class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
		{#if error}
			<p class="text-sm text-destructive-text">{error}</p>
		{:else if loading}
			<p class="text-sm text-muted-foreground">Loading…</p>
		{:else if detail}
			{#each messages as m (m.id)}
				<MessageView
					message={m}
					agent={agent ? { id: agent.id, name: agent.name, color: agent.color } : undefined}
					onApproval={answerFromPart}
					onOpenSession={(sid) => void openSession(sid)}
				/>
			{:else}
				<p class="text-sm text-muted-foreground">No messages yet.</p>
			{/each}
			{#each approvals as a (a.sessionId + a.id)}
				<PendingCard approval={a} />
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
					if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
						e.preventDefault();
						e.currentTarget.form?.requestSubmit();
					}
				}}
			/>
			<Button type="submit" disabled={sending || !note.trim()} class="self-end">{sending ? 'Sending…' : 'Send'}</Button>
		</form>
	{/if}
</div>
