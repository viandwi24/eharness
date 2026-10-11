<script lang="ts">
	import ShellHeader from './ShellHeader.svelte';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Shimmer } from '#lib/components/ai/shimmer/index.js';
	import SidebarToggle from './SidebarToggle.svelte';
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeft';
	import SidebarSimpleIcon from 'phosphor-svelte/lib/SidebarSimple';
	import DotsThreeIcon from 'phosphor-svelte/lib/DotsThree';
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimple';
	import ArrowsInLineVerticalIcon from 'phosphor-svelte/lib/ArrowsInLineVertical';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircle';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import {
		Conversation,
		ConversationContent,
		ConversationItem,
		ConversationScrollButton
	} from '#lib/components/ai/conversation/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import SessionContext from './SessionContext.svelte';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import { api } from '#lib/api/index.js';
	import { openEditAgent } from '#lib/stores/dialogs.svelte.js';
	import { startsAuthorRun } from '#lib/parts/map.js';
	import { uniqueById, withoutEmptyAssistant } from '#lib/chat/messages.js';
	import { goto } from '$app/navigation';
	import ThreadBar from './ThreadBar.svelte';
	import { threadsStore } from '#lib/stores/threads.svelte.js';
	import { pickThread, threadHref } from '#lib/threads/model.js';
	import { tick } from 'svelte';
	import PendingCard from './PendingCard.svelte';
	import { toast } from 'svelte-sonner';
	import { answerFailureText } from '#lib/approval/outcome.js';
	import { errorHint, lastTurnErrorCode, requestFailureText } from '#lib/chat/errors.js';
	import type { PromptInputMessage } from '#lib/components/ai/prompt-input/index.js';
	import { agentChat } from '#lib/chat/chats.svelte.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openTask, openSession } from '#lib/stores/drawer.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import MessageView from '#lib/parts/MessageView.svelte';
	import ChatComposer from './ChatComposer.svelte';

	/**
	 * `panelOpen`: whether the session panel is shown (a column when `wide`, a popover below lg).
	 * `popoverOpen` is the popover's state (bound by the page, which owns the shortcut).
	 */
	let {
		agentId,
		threadParam = null,
		panelOpen = true,
		wide = true,
		popoverOpen = $bindable(false),
		onTogglePanel
	}: { agentId: string; threadParam?: string | null; panelOpen?: boolean; wide?: boolean; popoverOpen?: boolean; onTogglePanel: () => void } = $props();

	const agent = $derived(agentsStore.find(agentId));
	// The thread shown: the one the link names (`?t=`, by id or session id), else the newest. All threads
	// of an agent are equal; the list lives in the thread bar.
	const allThreads = $derived(threadsStore.threadsOf(agentId));
	const open = $derived(allThreads.filter((t) => t.archivedAt === null));
	const thread = $derived(pickThread(threadParam ? allThreads : open, threadParam));
	// a link without a thread settles on the one it resolved to, so new activity elsewhere does not switch the chat
	$effect(() => {
		if (!threadParam && thread) void goto(threadHref(agentId, thread.id), { replaceState: true });
	});
	const sessionId = $derived(thread?.sessionId ?? '');
	// One cached chat per thread (history, stream and pagination survive switching). Creating it is
	// pure; the network load starts in the effect below.
	const ac = $derived(thread ? agentChat(agentId, thread.sessionId) : undefined);
	$effect(() => {
		void ac?.init();
	});
	const chat = $derived(ac?.chat);
	// One entry per id at the render boundary: a duplicate key would crash the whole page. An empty
	// assistant message (a provider failure stores one on purpose, next to the notice) is not shown.
	const messages = $derived(
		withoutEmptyAssistant(
			uniqueById(chat?.messages ?? [], (id) => {
				if (import.meta.env.DEV) console.warn(`[chat] duplicate message id ${id} in the chat list; keeping the newest copy`);
			})
		)
	);

	/**
	 * An inline tool approval of this agent's own message. Every answer goes through
	 * `POST /approvals` (the server records it and runs the continuation), never through the chat
	 * stream: one path, so an approval decided elsewhere cannot be answered twice. An approval the
	 * server no longer lists was decided already: refresh quietly, no error.
	 */
	async function answerInline(a: { id: string; approved: boolean; reason?: string; note?: string; remember?: 'session' }): Promise<void> {
		const { id, ...body } = a;
		const item = live.ownApproval(agentId, id, sessionId);
		if (!item) {
			void live.loadApprovals();
			void ac?.refetch();
			return;
		}
		try {
			await live.answer(item, body);
		} catch (e) {
			const text = answerFailureText(e);
			if (text) toast.error(text);
			else void ac?.refetch();
			return;
		}
		await followAfterAnswer();
	}
	/** An inline approval is offered only while the server lists it as waiting. */
	const canAnswer = (approvalId: string): boolean => !live.state.approvalsLoaded || live.ownApproval(agentId, approvalId, sessionId) !== undefined;

	async function send(m: PromptInputMessage): Promise<void> {
		const text = m.text.trim();
		if (!text && m.files.length === 0) return;
		let files;
		try {
			files = await Promise.all(m.files.map((f) => ac!.upload(f)));
		} catch (e) {
			// Throwing keeps the text and attachments in the composer for a retry.
			toast.error(e instanceof Error ? e.message : 'Upload failed');
			throw e;
		}
		// Not awaited: the composer must clear now, not when the stream ends. Errors reach `onError`.
		void ac?.send(text, files);
	}

	// Scroll-up pagination: load the next older page near the top and keep the viewport anchored.
	let root = $state<HTMLElement | null>(null);
	// Height of the floating dock (pending card + composer), used to pad the conversation.
	let dockHeight = $state(0);
	let busyOlder = false;
	async function maybeLoadOlder(): Promise<void> {
		const vp = root?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
		if (!ac || !vp || busyOlder || !ac.hasOlder || ac.loadingOlder) return;
		if (vp.scrollHeight > vp.clientHeight && vp.scrollTop > 160) return;
		busyOlder = true;
		try {
			const height = vp.scrollHeight;
			const top = vp.scrollTop;
			const added = await ac.loadOlder();
			await tick();
			if (added > 0) vp.scrollTop = top + (vp.scrollHeight - height);
		} catch {
			// a failed page leaves the chat as it is; the next scroll retries
		} finally {
			busyOlder = false;
		}
	}
	$effect(() => {
		const vp = root?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
		if (!vp) return;
		const onScroll = (): void => void maybeLoadOlder();
		vp.addEventListener('scroll', onScroll, { passive: true });
		return () => vp.removeEventListener('scroll', onScroll);
	});
	// Short history that does not fill the viewport: keep loading until it does (or there is no more).
	$effect(() => {
		if (ac?.loaded && ac.hasOlder && chat?.messages.length) void tick().then(maybeLoadOlder);
	});
	// Opening the chat marks it read; the live store keeps it read while it stays visible.
	$effect(() => {
		const id = agentId;
		live.setViewing(id);
		// cleanup (agent switch or unmount): only clear what this pane set, never a newer pane's
		return () => {
			if (live.state.viewing === id) live.setViewing(null);
		};
	});
	// Questions of this chat and approvals of the role agents it delegated to, answered inline.
	const inline = $derived(live.chatPending(agentId, sessionId || undefined));
	let pendingIdx = $state(0);
	// After an inline answer the turn continues on the server: follow it into this chat.
	const followAfterAnswer = (): void => void ac?.follow();
	$effect(() => {
		if (!agentsStore.find(agentId)) void agentsStore.get(agentId).catch(() => {});
	});

	let compacting = $state(false);
	/** Summarise the older part of the chat now (`POST /agents/{id}/compact`). */
	async function compact(): Promise<void> {
		if (!agent || !thread || compacting) return;
		compacting = true;
		try {
			const r = await api.post('/agents/{id}/compact', { params: { id: agent.id }, query: { thread: thread.id } });
			if (r.compacted) await ac?.refetch(); // the divider in the chat is the confirmation
			else toast('Nothing to compact yet', { description: 'The conversation is still short; recent turns are always kept as they are.' });
		} catch (e) {
			const busyCode = (e as { code?: unknown } | null)?.code === 'EH_SESSION_BUSY';
			toast.error('Could not compact the conversation', {
				description: busyCode ? 'A turn is running. Try again when it has finished.' : requestFailureText(e, '') || undefined
			});
		} finally {
			compacting = false;
		}
	}

	// Starter prompts for an empty chat: two generic ones plus one drawn from the agent's description.
	const suggestions = $derived.by((): string[] => {
		const out = ['What can you help me with?', 'Summarize your recent work'];
		const first = agent?.description.split(/[.\n]/)[0]?.trim();
		if (first && first.length >= 6 && first.length <= 64) out.push(`Help me with: ${first.charAt(0).toLowerCase()}${first.slice(1)}`);
		return out;
	});
	// the stored error code of the last turn (`TurnResult.error.code`): a hint for the ones with a fix
	const turnErrorHint = $derived(errorHint(lastTurnErrorCode(chat?.messages ?? [])));
	const busy = $derived(chat?.status === 'submitted' || chat?.status === 'streaming');
	// A turn the server no longer runs (it was killed, the connection went silent): resync.
	$effect(() => {
		// `stopping` too: a stop the server has not confirmed is settled by `checkStalled`
		if (!ac || (!busy && !ac.following && !ac.stopping)) return;
		const timer = setInterval(() => void ac.checkStalled(), 4000);
		return () => clearInterval(timer);
	});
</script>

{#snippet panelToggle(triggerProps: Record<string, unknown>)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					{...triggerProps}
					variant="ghost"
					size="icon-sm"
					aria-label={panelOpen ? 'Hide session panel' : 'Show session panel'}
					aria-pressed={panelOpen}
					onclick={wide ? onTogglePanel : (triggerProps.onclick as (() => void) | undefined)}
				>
					<SidebarSimpleIcon class="size-4" weight={panelOpen ? 'fill' : 'regular'} />
				</Button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>{panelOpen ? 'Hide session panel' : 'Show session panel'} <Kbd>⌘.</Kbd></Tooltip.Content>
	</Tooltip.Root>
{/snippet}

<Tooltip.Provider delayDuration={300}>
<section class="flex h-full min-h-0 min-w-0 flex-1 flex-col">
	<ShellHeader>
	<header class="flex h-14 shrink-0 items-center gap-2 px-3">
			<Button href="/" variant="ghost" size="icon-sm" class="md:hidden" aria-label="Back to agents">
				<CaretLeftIcon class="size-4" />
			</Button>
			<SidebarToggle whenCollapsed />
			{#if agent}
				<button
					type="button"
					class="-mx-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1 py-1 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
					aria-label="Edit {agent.name}"
					onclick={() => openEditAgent(agent.id)}
				>
					<AgentAvatar seed={agent.id} color={agent.color} size={32} label={agent.name} />
					<span class="min-w-0">
						<span class="block truncate text-sm leading-tight font-medium">{agent.name}</span>
						{#if agent.description}<span class="block truncate text-xs leading-tight text-muted-foreground">{agent.description}</span>{/if}
					</span>
				</button>
			{:else}
				<div class="flex flex-1 items-center gap-2.5">
					<Skeleton class="size-8 rounded-lg" />
					<div class="flex flex-col gap-1.5"><Skeleton class="h-3 w-28" /><Skeleton class="h-2.5 w-44" /></div>
				</div>
			{/if}
			<div class="flex shrink-0 items-center gap-0.5">
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button {...props} variant="ghost" size="icon-sm" aria-label="Agent actions" disabled={!agent}>
								<DotsThreeIcon class="size-4" weight="bold" />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content elevation="floating" align="end" class="w-56">
						<DropdownMenu.Item onSelect={() => agent && openEditAgent(agent.id)}>
							<PencilSimpleIcon /> Agent settings
						</DropdownMenu.Item>
						<DropdownMenu.Item disabled={compacting || busy} onSelect={() => void compact()}>
							<ArrowsInLineVerticalIcon /> {compacting ? 'Compacting…' : 'Compact conversation'}
						</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.Item onSelect={onTogglePanel}>
							<SidebarSimpleIcon /> {panelOpen ? 'Hide session panel' : 'Show session panel'}
							<DropdownMenu.Shortcut>⌘.</DropdownMenu.Shortcut>
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
				{#if wide}
					{@render panelToggle({})}
				{:else}
					<Popover.Root bind:open={popoverOpen}>
						<Popover.Trigger>
							{#snippet child({ props })}
								{@render panelToggle(props)}
							{/snippet}
						</Popover.Trigger>
						<Popover.Content elevation="floating" align="end" class="max-h-[min(80svh,40rem)] w-[min(92vw,22rem)] overflow-y-auto p-0" aria-label="Agent session">
							{#if thread}<SessionContext {agentId} {thread} elevation="flat" class="max-w-none border-0 shadow-none" onClose={() => (popoverOpen = false)} />{/if}
						</Popover.Content>
					</Popover.Root>
				{/if}
			</div>
		</header>
</ShellHeader>
	<ThreadBar {agentId} current={thread} />

	<!-- The conversation fills the pane to the bottom; the pending card and the composer float over
	     it (dock), and the content is padded by the dock's height so the last message stays visible. -->
	<div class="flex min-h-0 flex-1">
	{#if ac && chat && thread}
	<div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
		<div bind:this={root} class="flex min-h-0 flex-1 flex-col">
			{#key sessionId}
				<Conversation class="min-h-0 flex-1">
					<ConversationContent class="mx-auto w-full max-w-3xl gap-5 px-4 pt-6" style={`padding-bottom: ${dockHeight + 24}px`}>
						{#if ac.loadingOlder}
							<div class="text-center text-xs text-muted-foreground" role="status">Loading earlier messages…</div>
						{/if}
						{#each messages as m, i (m.id)}
							{@const head = startsAuthorRun(messages, i)}
							<ConversationItem messageId={m.id} class={m.role !== 'user' && !head && i > 0 ? '-mt-2' : ''}>
								<MessageView
									message={m}
									agent={agent ? { id: agent.id, name: agent.name, color: agent.color } : undefined}
									showHeader={head}
									onApproval={(a) => void answerInline(a)}
									{canAnswer}
									onOpenSession={(sid) => void openSession(sid)}
								/>
							</ConversationItem>
						{:else}
							{#if !ac.loaded}
								<div class="flex flex-col gap-6 pt-2" aria-busy="true" aria-label="Loading conversation">
									<Skeleton class="ml-auto h-9 w-2/5 rounded-xl" />
									<div class="flex flex-col gap-2"><Skeleton class="h-3.5 w-1/3" /><Skeleton class="h-3.5 w-4/5" /><Skeleton class="h-3.5 w-3/5" /></div>
								</div>
							{:else}
								<Empty.Root class="border-0 py-16">
									<Empty.Header>
										{#if agent}<div class="mb-2"><AgentAvatar seed={agent.id} color={agent.color} size={48} label={agent.name} /></div>{/if}
										<Empty.Title>{agent ? `Chat with ${agent.name}` : 'No messages yet'}</Empty.Title>
										<Empty.Description>{agent?.description || 'Send a message to get started.'}</Empty.Description>
									</Empty.Header>
									{#if agent}
										<Empty.Content class="max-w-md flex-row flex-wrap justify-center gap-2">
											{#each suggestions as text (text)}
												<Button variant="outline" size="sm" disabled={busy} onclick={() => void ac.send(text)}>
													{text}
												</Button>
											{/each}
										</Empty.Content>
									{/if}
								</Empty.Root>
							{/if}
						{/each}
						{#if compacting || ac.activity === 'compacting'}
							<div class="flex items-center gap-3 text-xs text-muted-foreground" role="status" aria-live="polite">
								<span class="h-px flex-1 bg-border"></span>
								<Spinner class="size-3.5" />
								<Shimmer as="span" duration={1.2}>Compacting conversation…</Shimmer>
								<span class="h-px flex-1 bg-border"></span>
							</div>
						{/if}
						{#if chat.status === 'submitted'}
							<div class="text-sm text-muted-foreground" role="status">Thinking…</div>
						{/if}
						{#if ac.interrupted && !busy}
							<div class="flex flex-col gap-2 rounded-lg border border-border bg-popover px-3 py-2.5 text-sm" role="status" data-testid="chat-interrupted">
								<div class="flex items-start gap-2">
									<WarningCircleIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
									<span class="min-w-0 flex-1">This reply was interrupted: the server stopped before it finished.</span>
								</div>
								<div class="flex items-center gap-1.5 pl-6">
									<Button size="xs" variant="outline" onclick={() => void ac.continueTurn()}>Continue</Button>
									<Button size="xs" variant="ghost" onclick={() => void ac.retryTurn()}>Retry</Button>
								</div>
							</div>
						{/if}
						{#if ac.problem}
							<div class="flex items-start gap-2 rounded-lg border border-border bg-destructive-soft px-3 py-2 text-sm text-destructive-text" role="alert" data-testid="chat-problem">
								<WarningCircleIcon class="mt-0.5 size-4 shrink-0" />
								<span class="min-w-0 flex-1 break-words">{ac.problem.message}</span>
								{#if ac.problem.retry}<Button size="xs" variant="ghost" onclick={() => void ac.retry()}>Retry</Button>{/if}
								<Button size="xs" variant="ghost" onclick={() => ac.dismissProblem()}>Dismiss</Button>
							</div>
						{/if}
						{#if turnErrorHint && !chat.error && !busy}
							<div class="flex items-start gap-2 rounded-lg border border-border bg-destructive-soft px-3 py-2 text-sm text-destructive-text" role="alert" data-testid="chat-turn-error">
								<WarningCircleIcon class="mt-0.5 size-4 shrink-0" />
								<span class="min-w-0 flex-1 break-words">{turnErrorHint}</span>
							</div>
						{/if}
						{#if chat.error}
							<div class="flex items-center gap-2 rounded-lg border border-border bg-destructive-soft px-3 py-2 text-sm text-destructive-text" role="alert">
								<WarningCircleIcon class="size-4 shrink-0" />
								<span class="min-w-0 flex-1 truncate">{chat.error.message || 'Something went wrong'}</span>
								<Button size="xs" variant="ghost" onclick={() => chat.clearError()}>Dismiss</Button>
							</div>
						{/if}
					</ConversationContent>
					<ConversationScrollButton style={`bottom: ${dockHeight + 12}px`} />
				</Conversation>
			{/key}
		</div>

		<div
			class="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-card from-50% via-card/80 to-transparent pt-12"
			bind:clientHeight={dockHeight}
		>
			<div class="pointer-events-auto mx-auto w-full max-w-3xl px-3 pb-3">
				{#if inline.length}
					{@const at = Math.min(pendingIdx, inline.length - 1)}
					{@const cur = inline[at]}
					<div class="mb-2 flex flex-col gap-1.5" role="region" aria-label="Waiting for your answer">
						{#if inline.length > 1}
							<div class="flex items-center justify-end gap-0.5 text-xs text-muted-foreground" data-testid="pending-pager">
								<Button variant="ghost" size="icon-xs" aria-label="Previous request" disabled={at <= 0} onclick={() => (pendingIdx = Math.max(0, at - 1))}>
									<CaretLeftIcon />
								</Button>
								<span class="tabular-nums">{at + 1} of {inline.length}</span>
								<Button variant="ghost" size="icon-xs" aria-label="Next request" disabled={at >= inline.length - 1} onclick={() => (pendingIdx = Math.min(inline.length - 1, at + 1))}>
									<CaretRightIcon />
								</Button>
							</div>
						{/if}
						{#if cur}
							{#key cur.sessionId + cur.id}
								<PendingCard approval={cur} onOpenTask={(id) => openTask(id)} onAnswered={followAfterAnswer} />
							{/key}
						{/if}
					</div>
				{/if}
				{#if ac.stopping}
					<div class="mb-2 text-center text-xs text-muted-foreground" role="status" data-testid="chat-stopping">Stopping…</div>
				{:else if ac.notice}
					<div class="mb-2 text-center text-xs text-muted-foreground" role="status">{ac.notice}</div>
				{/if}
				{#if thread.archivedAt !== null}
					<div class="flex items-center justify-between gap-2 rounded-lg border border-border bg-popover px-3 py-2 text-sm" role="status" data-testid="thread-archived">
						<span>This chat is archived.</span>
						<Button size="xs" variant="outline" onclick={() => void threadsStore.restore(agentId, thread.id)}>Restore</Button>
					</div>
				{:else}
				<ChatComposer
					{agentId}
					threadId={thread.id}
					onSend={send}
					onStop={() => void ac.stop()}
					status={chat.status}
					stopping={ac.stopping}
					placeholder={agent ? `Message ${agent.name}` : 'Message the agent'}
				/>
				{/if}
			</div>
		</div>
	</div>
	{:else}
		<div class="flex min-w-0 flex-1 flex-col gap-6 px-4 pt-8" aria-busy="true" aria-label="Loading chats">
			<Skeleton class="ml-auto h-9 w-2/5 rounded-xl" />
			<div class="flex flex-col gap-2"><Skeleton class="h-3.5 w-1/3" /><Skeleton class="h-3.5 w-4/5" /></div>
		</div>
	{/if}
	{#if wide && panelOpen && thread}
		<!-- Second column of the same surface: the floating session card scrolls on its own. -->
		<aside class="hidden w-[352px] shrink-0 overflow-y-auto p-3 lg:block" aria-label="Agent session">
			<SessionContext {agentId} {thread} elevation="flat" class="border-border bg-background shadow-sm" onClose={onTogglePanel} />
		</aside>
	{/if}
	</div>
</section>
</Tooltip.Provider>
