<script lang="ts">
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
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import { api } from '#lib/api/index.js';
	import { openEditAgent } from '#lib/stores/dialogs.svelte.js';
	import { startsAuthorRun } from '#lib/parts/map.js';
	import { onDestroy, tick } from 'svelte';
	import PendingCard from './PendingCard.svelte';
	import ApprovalsPopover from './ApprovalsPopover.svelte';
	import { toast } from 'svelte-sonner';
	import type { PromptInputMessage } from '#lib/components/ai/prompt-input/index.js';
	import { agentChat } from '#lib/chat/chats.svelte.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openTask, openSession } from '#lib/stores/drawer.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import MessageView from '#lib/parts/MessageView.svelte';
	import ChatComposer from './ChatComposer.svelte';

	let {
		agentId,
		panelOpen = true,
		onTogglePanel
	}: { agentId: string; panelOpen?: boolean; onTogglePanel: () => void } = $props();

	const agent = $derived(agentsStore.find(agentId));
	// One cached chat per agent (history, stream and pagination survive switching agents).
	const ac = $derived(agentChat(agentId));
	const chat = $derived(ac.chat);

	/**
	 * An inline tool approval. Plain approve / deny (with a reason) ride the chat stream; "Always
	 * allow" and notes only exist on `POST /approvals`, so those go there and the chat then follows
	 * the continuation the server runs.
	 */
	async function answerInline(a: { id: string; approved: boolean; reason?: string; note?: string; remember?: 'session' }): Promise<void> {
		const { id, ...body } = a;
		if (body.remember === undefined && body.note === undefined) return ac.approve(a);
		const item = live.state.approvals.find((x) => x.id === id);
		if (!item) return ac.approve(a);
		try {
			await live.answer(item, body);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not send the answer');
			return;
		}
		await followAfterAnswer();
	}

	async function send(m: PromptInputMessage): Promise<void> {
		const text = m.text.trim();
		if (!text && m.files.length === 0) return;
		let files;
		try {
			files = await Promise.all(m.files.map((f) => ac.upload(f)));
		} catch (e) {
			// Throwing keeps the text and attachments in the composer for a retry.
			toast.error(e instanceof Error ? e.message : 'Upload failed');
			throw e;
		}
		// Not awaited: the composer must clear now, not when the stream ends. Errors reach `onError`.
		void ac.send(text, files);
	}

	// Scroll-up pagination: load the next older page near the top and keep the viewport anchored.
	let root = $state<HTMLElement | null>(null);
	// Height of the floating dock (pending card + composer), used to pad the conversation.
	let dockHeight = $state(0);
	let busyOlder = false;
	async function maybeLoadOlder(): Promise<void> {
		const vp = root?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
		if (!vp || busyOlder || !ac.hasOlder || ac.loadingOlder) return;
		if (vp.scrollHeight > vp.clientHeight && vp.scrollTop > 160) return;
		busyOlder = true;
		const height = vp.scrollHeight;
		const top = vp.scrollTop;
		const added = await ac.loadOlder();
		await tick();
		if (added > 0) vp.scrollTop = top + (vp.scrollHeight - height);
		busyOlder = false;
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
		if (ac.loaded && ac.hasOlder && chat.messages.length) void tick().then(maybeLoadOlder);
	});
	// Opening the chat marks it read; the live store keeps it read while it stays visible.
	$effect(() => {
		live.setViewing(agentId);
	});
	onDestroy(() => live.setViewing(null));
	// Questions of this chat and approvals of the role agents it delegated to, answered inline.
	const inline = $derived(live.chatPending(agentId));
	let pendingIdx = $state(0);
	// After an inline answer the turn continues on the server: follow it into this chat.
	const followAfterAnswer = (): void => void ac.follow();
	$effect(() => {
		if (!agentsStore.find(agentId)) void agentsStore.get(agentId).catch(() => {});
	});

	let compacting = $state(false);
	/** Summarise the older part of the chat now (`POST /agents/{id}/compact`). */
	async function compact(): Promise<void> {
		if (!agent || compacting) return;
		compacting = true;
		try {
			const r = await api.post('/agents/{id}/compact', { params: { id: agent.id } });
			if (r.compacted) await ac.refetch(); // the divider in the chat is the confirmation
			else toast('Nothing to compact yet', { description: 'The conversation is still short; recent turns are always kept as they are.' });
		} catch (e) {
			const text = e instanceof Error ? e.message : '';
			toast.error('Could not compact the conversation', {
				description: /busy|running|locked/i.test(text) ? 'A turn is running. Try again when it has finished.' : text || undefined
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
	const busy = $derived(chat.status === 'submitted' || chat.status === 'streaming');
</script>

<Tooltip.Provider delayDuration={300}>
<section class="flex h-full min-h-0 min-w-0 flex-1 flex-col">
	<header class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
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
			<ApprovalsPopover />
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" size="icon-sm" aria-label="Agent actions" disabled={!agent}>
							<DotsThreeIcon class="size-4" weight="bold" />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-56">
					<DropdownMenu.Item onSelect={() => agent && openEditAgent(agent.id)}>
						<PencilSimpleIcon /> Agent settings
					</DropdownMenu.Item>
					<DropdownMenu.Item disabled={compacting || busy} onSelect={() => void compact()}>
						<ArrowsInLineVerticalIcon /> {compacting ? 'Compacting…' : 'Compact conversation'}
					</DropdownMenu.Item>
					<DropdownMenu.Separator />
					<DropdownMenu.Item onSelect={onTogglePanel}>
						<SidebarSimpleIcon /> {panelOpen ? 'Hide details' : 'Show details'}
						<DropdownMenu.Shortcut>⌘.</DropdownMenu.Shortcut>
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon-sm"
							aria-label={panelOpen ? 'Hide agent details' : 'Show agent details'}
							aria-pressed={panelOpen}
							onclick={onTogglePanel}
						>
							<SidebarSimpleIcon class="size-4" weight={panelOpen ? 'fill' : 'regular'} />
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>{panelOpen ? 'Hide details' : 'Show details'} <Kbd>⌘.</Kbd></Tooltip.Content>
			</Tooltip.Root>
		</div>
	</header>

	<!-- The conversation fills the pane to the bottom; the pending card and the composer float over
	     it (dock), and the content is padded by the dock's height so the last message stays visible. -->
	<div class="relative flex min-h-0 flex-1 flex-col">
		<div bind:this={root} class="flex min-h-0 flex-1 flex-col">
			{#key agentId}
				<Conversation class="min-h-0 flex-1">
					<ConversationContent class="mx-auto w-full max-w-3xl gap-5 px-4 pt-6" style={`padding-bottom: ${dockHeight + 24}px`}>
						{#if ac.loadingOlder}
							<div class="text-center text-xs text-muted-foreground" role="status">Loading earlier messages…</div>
						{/if}
						{#each chat.messages as m, i (m.id)}
							{@const head = startsAuthorRun(chat.messages, i)}
							<ConversationItem messageId={m.id} class={m.role !== 'user' && !head && i > 0 ? '-mt-2' : ''}>
								<MessageView
									message={m}
									agent={agent ? { id: agent.id, name: agent.name, color: agent.color } : undefined}
									showHeader={head}
									onApproval={(a) => void answerInline(a)}
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
			class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background from-60% to-transparent pt-6"
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
				{#if ac.notice}
					<div class="mb-2 text-center text-xs text-muted-foreground" role="status">{ac.notice}</div>
				{/if}
				<ChatComposer
					{agentId}
					onSend={send}
					onStop={() => void ac.stop()}
					status={chat.status}
					placeholder={agent ? `Message ${agent.name}` : 'Message the agent'}
				/>
			</div>
		</div>
	</div>
</section>
</Tooltip.Provider>
