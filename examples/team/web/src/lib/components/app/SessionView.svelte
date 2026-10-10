<script lang="ts">
	import { untrack } from 'svelte';
	import type { UIMessage } from 'ai';
	import XIcon from 'phosphor-svelte/lib/X';
	import type { Approval, TaskDetail } from '#lib/api/client.js';
	import { api, apiBase, getToken } from '#lib/api/index.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { badgeFor } from '#lib/board/board.js';
	import { formatTime } from '#lib/format.js';
	import MessageView from '#lib/parts/MessageView.svelte';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openSession } from '#lib/stores/drawer.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { followTaskStream, isLive, mergeLive, pollDelay } from '#lib/tasks/follow.js';
	import {
		Conversation,
		ConversationContent,
		ConversationEmptyState,
		ConversationItem,
		ConversationScrollButton
	} from '#lib/components/ai/conversation/index.js';
	import type { PromptInputMessage } from '#lib/components/ai/prompt-input/index.js';
	import ChatComposer from './ChatComposer.svelte';
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

	let dockHeight = $state(0);
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

	async function sendNote(m: PromptInputMessage): Promise<void> {
		const text = m.text.trim();
		if (!task || !text) return;
		try {
			await api.post('/tasks/{id}/messages', { params: { id: task.id }, body: { text } });
			toast.success(running ? 'Sent to the running task' : 'Message queued');
			void load(task.id);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not send the message');
			throw err; // keeps the text in the composer
		}
	}

	function answerFromPart(a: { id: string } & Parameters<typeof live.answer>[1]): void {
		const { id, ...body } = a;
		const item = approvals.find((x) => x.id === id);
		if (item) void live.answer(item, body).catch(() => {});
	}
</script>

<div class="flex h-full min-h-0 min-w-0 flex-1 flex-col">
	<header class="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3">
		{#if task}<AgentAvatar seed={task.agentId} color={agent?.color} size={32} label={agent?.name ?? task.agentId} />{/if}
		<div class="min-w-0 flex-1">
			<h2 class="truncate text-sm font-medium">{task?.title ?? 'Task'}</h2>
			<p class="truncate text-xs text-muted-foreground">
				{agent?.name ?? task?.agentId ?? ''}{task ? ` · ${formatTime(task.lastActivityAt)}` : ''}{streaming ? ' · live' : ''}
			</p>
		</div>
		{#if task}{@const b = badgeFor(task.status)}<Badge variant={b.variant}>{b.label}</Badge>{/if}
		{#if onClose}
			<Button size="icon-sm" variant="ghost" aria-label="Close" onclick={onClose}><XIcon class="size-4" /></Button>
		{/if}
	</header>

	<!-- Same anatomy as ChatPane: scroller to the bottom, pending cards and composer float as a dock. -->
	<div class="relative flex min-h-0 flex-1 flex-col">
		<div class="flex min-h-0 flex-1 flex-col">
			<Conversation class="min-h-0 flex-1">
				<ConversationContent class="mx-auto w-full max-w-3xl gap-6 px-4 pt-6" style={`padding-bottom: ${dockHeight + 24}px`}>
					{#if error}
						<p class="text-sm text-destructive-text">{error}</p>
					{:else if loading}
						<p class="text-sm text-muted-foreground">Loading…</p>
					{:else if detail}
						{#each messages as m (m.id)}
							<ConversationItem messageId={m.id}>
								<MessageView
									message={m}
									agent={agent ? { id: agent.id, name: agent.name, color: agent.color } : undefined}
									onApproval={answerFromPart}
									onOpenSession={(sid) => void openSession(sid)}
								/>
							</ConversationItem>
						{:else}
							<ConversationEmptyState title="No messages yet" description="This task has not produced anything yet." />
						{/each}
					{/if}
				</ConversationContent>
				<ConversationScrollButton style={`bottom: ${dockHeight + 12}px`} />
			</Conversation>
		</div>

		{#if task}
			<div
				class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background from-60% to-transparent pt-6"
				bind:clientHeight={dockHeight}
			>
				<div class="pointer-events-auto mx-auto w-full max-w-3xl p-3">
					{#if approvals.length}
						<div class="mb-2 flex flex-col gap-2" role="region" aria-label="Waiting for your answer">
							{#each approvals as a (a.sessionId + a.id)}
								<PendingCard approval={a} />
							{/each}
						</div>
					{/if}
					<ChatComposer
						onSend={sendNote}
						onStop={() => void abort()}
						status={running ? 'streaming' : 'ready'}
						placeholder={running ? 'Message the running task…' : 'Send a follow-up to this task…'}
					/>
				</div>
			</div>
		{/if}
	</div>
</div>
