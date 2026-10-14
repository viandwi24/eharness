<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { UIMessage } from 'ai';
	import XIcon from 'phosphor-svelte/lib/X';
	import StopIcon from 'phosphor-svelte/lib/Stop';
	import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircle';
	import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircle';
	import { goto } from '$app/navigation';
	import { threadsStore } from '#lib/stores/threads.svelte.js';
	import { threadHref } from '#lib/threads/model.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { startsAuthorRun } from '#lib/parts/map.js';
	import type { Approval, TaskDetail } from '#lib/api/client.js';
	import { api, harness } from '#lib/api/index.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { badgeFor } from '#lib/board/board.js';
	import { relativeTime } from '#lib/routines/schedule.js';
	import MessageView from '#lib/parts/MessageView.svelte';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openSession } from '#lib/stores/drawer.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { followSessionStream } from 'eharness/client';
	import { isLive, mergeLive, pollDelay } from '#lib/tasks/follow.js';
	import {
		Conversation,
		ConversationContent,
			ConversationItem,
		ConversationScrollButton
	} from '#lib/components/ai/conversation/index.js';
	import type { PromptInputMessage } from '#lib/components/ai/prompt-input/index.js';
	import ChatComposer from './ChatComposer.svelte';
	import { CONTINUE_TEXT } from 'eharness/client';
	import PendingCard from './PendingCard.svelte';
	import ApprovalGroupCard from './ApprovalGroupCard.svelte';
	import { groupPending, entryKey } from '#lib/approval/group.js';
	import type { ApprovalStanding } from '#lib/approval/chip.js';
	import TaskInfo from './TaskInfo.svelte';
	import TaskActions from './TaskActions.svelte';
	import WorkerJobPanel from './WorkerJobPanel.svelte';

	/**
	 * Watch (and steer) the session of a delegated task, like the coder's agent page: the full
	 * transcript with the same parts as the chat, live while a turn runs (the task's UI message
	 * stream, `GET /sessions/{sessionId}/chat/stream`), a message box and Stop.
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
	const job = $derived(detail?.job ?? undefined);
	const messages = $derived(mergeLive((detail?.messages ?? []) as unknown as UIMessage[], liveMessages));
	// Live approvals (events) win over the ones of the last read.
	const approvals = $derived.by((): Approval[] => {
		const fresh = live.state.approvals.filter((a) => a.taskId === taskId);
		// once the live list is loaded it is the truth (an answered item must not come back from the stale read)
		if (live.state.approvalsLoaded) return fresh;
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

	// Turns the server starts in this task's session (a subagent report, a routine, a message from
	// another agent) arrive as live events: re-read at once so the stream loop below picks them up.
	onMount(() =>
		live.onChatEvent((e) => {
			if (e.sessionId && e.sessionId === detail?.task.sessionId) void load(taskId);
		})
	);

	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

	// While the task runs: follow the stream; when it ends or nothing streams, re-read the stored
	// messages and poll (about 1 s) until the task stops running.
	let loopId = '';
	// Each loop owns `streaming`: a late `finally` of an aborted loop (task changed) must not clobber the new one.
	let loopToken = 0;
	$effect(() => {
		const id = taskId;
		if (!running || loopId === id) return;
		const sessionId = untrack(() => detail?.task.sessionId);
		if (!sessionId) return; // the task row is not loaded yet; the effect runs again with it
		loopId = id;
		const mine = ++loopToken;
		const ctl = new AbortController();
		void (async () => {
			try {
				while (!ctl.signal.aborted) {
					const result = await followSessionStream(harness, sessionId, {
						signal: ctl.signal,
						onMessage: (m) => {
							if (ctl.signal.aborted || mine !== loopToken) return;
							streaming = true;
							liveMessages = new Map(liveMessages).set(m.id, structuredClone(m));
						}
					});
					if (ctl.signal.aborted || mine !== loopToken) return;
					streaming = false;
					await load(id);
					if (ctl.signal.aborted || mine !== loopToken) return;
					if (error === null) liveMessages = new Map(); // the stored messages are the truth again (a failed read keeps the live ones)
					if (!isLive(detail?.task.status)) return;
					await sleep(result === 'streamed' ? 250 : (pollDelay({ status: 'running', streaming: false, visible: document.visibilityState === 'visible' }) ?? 1000));
				}
			} finally {
				if (mine === loopToken) {
					if (loopId === id) loopId = '';
					streaming = false;
				}
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
			// a background worker is a long-run job: stopping it also keeps the next chunk from starting
			if (job?.status === 'running') {
				await api.post('/tasks/{id}/stop', { params: { id: task.id } });
				toast.success('Stopping the job');
				void load(task.id);
				return;
			}
			const r = await harness.sessions.interrupt(task.sessionId);
			toast.success(r.target === 'idle' ? 'Nothing was running' : 'Stopping the task');
			void load(task.id);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not stop the task');
		} finally {
			aborting = false;
		}
	}

	/** A task that stopped without finishing its work (its process died, it ran too long, it never started). */
	const resumable = $derived(task !== undefined && ['interrupted', 'timed_out', 'failed', 'stopped'].includes(task.status));
	async function continueTask(): Promise<void> {
		if (!task) return;
		try {
			await api.post('/tasks/{id}/messages', { params: { id: task.id }, body: { text: CONTINUE_TEXT } });
			toast.success('Continuing the task');
			void load(task.id);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not continue the task');
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

	const standing = (id: string): ApprovalStanding =>
		approvals.some((x) => x.id === id) ? 'open' : live.state.answeredHere[id] === 'approved' ? 'approved-here' : live.state.answeredHere[id] === 'declined' ? 'declined-here' : 'answered';
	const entries = $derived(groupPending(approvals));
	let dockEl = $state<HTMLElement | null>(null);
	function focusDock(): void {
		const card = dockEl?.querySelector<HTMLElement>('[data-testid="approval-card"],[data-testid="approval-group"],[data-testid="question-card"]');
		card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		card?.focus({ preventScroll: true });
	}
</script>

<Tooltip.Provider delayDuration={300}>
<div class="flex h-full min-h-0 min-w-0 flex-1 flex-col">
	<header class="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-3">
		{#if task}
			<AgentAvatar seed={task.agentId} color={agent?.color} size={32} label={agent?.name ?? task.agentId} />
		{:else}
			<Skeleton class="size-8 rounded-lg" />
		{/if}
		<div class="min-w-0 flex-1">
			<h2 class="truncate text-sm leading-tight font-medium">{task?.title ?? 'Task'}</h2>
			<p class="truncate text-xs leading-tight text-muted-foreground">
				{agent?.name ?? task?.agentId ?? ''}{task ? ` · ${relativeTime(task.lastActivityAt)}` : ''}{streaming ? ' · live' : ''}
			</p>
		</div>
		{#if task}{@const b = badgeFor(task.status, task.summary)}<Badge variant={b.variant}>{b.label}</Badge>{/if}
		<div class="flex shrink-0 items-center gap-0.5">
			{#if running}
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button {...props} size="icon-sm" variant="ghost" aria-label="Stop task" disabled={aborting} onclick={() => void abort()}>
								<StopIcon class="size-4" weight="fill" />
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>Stop task</Tooltip.Content>
				</Tooltip.Root>
			{/if}
			{#if task}
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								size="icon-sm"
								variant="ghost"
								aria-label="Discuss in chat"
								data-testid="discuss-run"
								onclick={async () => {
									// a NEW chat with the lead, seeded with this run; the run keeps its own session
									try {
										const t = await threadsStore.discuss({ kind: 'run', ref: task.id });
										onClose?.();
										void goto(threadHref(t.agentId, t.id));
									} catch (e) {
										toast.error(e instanceof Error ? e.message : 'Could not open a chat');
									}
								}}
							>
								<ChatCircleIcon class="size-4" />
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>Discuss in a new chat</Tooltip.Content>
				</Tooltip.Root>
			{/if}
			{#if onClose}
				<Button size="icon-sm" variant="ghost" aria-label="Close" onclick={onClose}><XIcon class="size-4" /></Button>
			{/if}
		</div>
	</header>
	{#if task && job}
		<WorkerJobPanel taskId={task.id} {job} onChange={() => void load(task.id)} />
	{/if}

	{#if task}<TaskInfo {task} />{/if}

	<!-- Same anatomy as ChatPane: scroller to the bottom, pending cards and composer float as a dock. -->
	<div class="relative flex min-h-0 flex-1 flex-col">
		<div class="flex min-h-0 flex-1 flex-col">
			<Conversation class="min-h-0 flex-1">
				<ConversationContent class="mx-auto w-full max-w-3xl gap-5 px-4 pt-6" style={`padding-bottom: ${dockHeight + 24}px`}>
					{#if error}
						<div class="flex items-center gap-2 rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive-text" role="alert">
							<WarningCircleIcon class="size-4 shrink-0" /><span class="min-w-0 flex-1">{error}</span>
							<Button size="xs" variant="ghost" onclick={() => void load(taskId)}>Retry</Button>
						</div>
					{:else if loading || !detail}
						<div class="flex flex-col gap-6 pt-2" aria-busy="true" aria-label="Loading task">
							<Skeleton class="ml-auto h-9 w-2/5 rounded-xl" />
							<div class="flex flex-col gap-2"><Skeleton class="h-3.5 w-1/3" /><Skeleton class="h-3.5 w-4/5" /><Skeleton class="h-3.5 w-3/5" /></div>
						</div>
					{:else}
						{#each messages as m, i (m.id)}
							{@const head = startsAuthorRun(messages, i)}
							<ConversationItem messageId={m.id} class={m.role !== 'user' && !head && i > 0 ? '-mt-2' : ''}>
								<MessageView
									message={m}
									agent={agent ? { id: agent.id, name: agent.name, color: agent.color } : undefined}
									showHeader={head}
									live={running && i === messages.length - 1}
									instruction={m.role === 'user' && i === 0}
									{standing}
									onFocusDock={focusDock}
									onOpenSession={(sid) => void openSession(sid)}
								/>
							</ConversationItem>
						{:else}
							<Empty.Root class="border-0 py-16">
								<Empty.Header>
									<Empty.Title>{task?.status === 'queued' ? 'Waiting in the queue' : 'No messages yet'}</Empty.Title>
									<!-- the reason it waits is in the status line above: not repeated here -->
									<Empty.Description>{task?.status === 'queued' ? 'Nothing has run yet.' : 'This task has not produced anything yet.'}</Empty.Description>
								</Empty.Header>
							</Empty.Root>
						{/each}
						{#if running && !streaming && messages.at(-1)?.role === 'user'}
							<div class="text-sm text-muted-foreground" role="status">Working…</div>
						{/if}
					{/if}
				</ConversationContent>
				<ConversationScrollButton style={`bottom: ${dockHeight + 12}px`} />
			</Conversation>
		</div>

		{#if task && task.status !== 'queued'}
			<div
				class="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-popover from-50% via-popover/80 to-transparent pt-12"
				bind:clientHeight={dockHeight}
			>
				<div class="pointer-events-auto mx-auto w-full max-w-3xl px-3 pb-3">
					{#if resumable && task}
						<div class="mb-2 flex items-center gap-2 rounded-lg border border-border bg-popover px-3 py-2 text-sm" role="status" data-testid="task-resumable">
							<WarningCircleIcon class="size-4 shrink-0 text-muted-foreground" />
							<span class="min-w-0 flex-1">{task.status === 'interrupted' ? 'This task was interrupted before it finished.' : task.status === 'timed_out' ? 'This task ran past its time limit.' : task.summary === 'Failed to start' ? 'This task did not start.' : 'This task stopped before it finished.'}</span>
							<Button size="xs" variant="outline" onclick={() => void continueTask()}>Continue</Button>
						</div>
					{/if}
					{#if approvals.length}
						<div class="mb-2 flex flex-col gap-2" role="region" aria-label="Waiting for your answer" bind:this={dockEl}>
							{#each entries as e (entryKey(e))}
								{#if e.kind === 'group'}<ApprovalGroupCard items={e.items} toolName={e.toolName} />{:else}<PendingCard approval={e.item} />{/if}
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

	{#if task}<TaskActions {task} />{/if}
</div>
</Tooltip.Provider>
