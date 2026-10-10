<script lang="ts">
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeft';
	import SidebarSimpleIcon from 'phosphor-svelte/lib/SidebarSimple';
	import DotsThreeIcon from 'phosphor-svelte/lib/DotsThree';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import {
		Conversation,
		ConversationContent,
		ConversationEmptyState,
		ConversationItem,
		ConversationScrollButton
	} from '#lib/components/ai/conversation/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { onDestroy, tick } from 'svelte';
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
		onTogglePanel
	}: { agentId: string; onTogglePanel: () => void } = $props();

	const agent = $derived(agentsStore.find(agentId));
	// One cached chat per agent (history, stream and pagination survive switching agents).
	const ac = $derived(agentChat(agentId));
	const chat = $derived(ac.chat);

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
	// Approvals in child sessions of this agent's delegations (lead hint).
	const waiting = $derived(live.childApprovals(agentId));
	$effect(() => {
		if (!agentsStore.find(agentId)) void agentsStore.get(agentId).catch(() => {});
	});
</script>

<section class="flex h-full min-h-0 min-w-0 flex-1 flex-col">
	<header class="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3">
		<Button href="/" variant="ghost" size="icon-sm" class="md:hidden" aria-label="Back to agents">
			<CaretLeftIcon class="size-4" />
		</Button>
		{#if agent}
			<AgentAvatar seed={agent.id} color={agent.color} size={32} label={agent.name} />
			<div class="min-w-0 flex-1">
				<div class="truncate text-sm font-medium">{agent.name}</div>
				<div class="truncate text-xs text-muted-foreground">{agent.description}</div>
			</div>
		{:else}
			<div class="flex-1 text-sm text-muted-foreground">Unknown agent</div>
		{/if}
		<ApprovalsPopover />
		<Button variant="ghost" size="icon-sm" aria-label="Agent actions"><DotsThreeIcon class="size-4" /></Button>
		<Button variant="ghost" size="icon-sm" aria-label="Toggle context panel" onclick={onTogglePanel}>
			<SidebarSimpleIcon class="size-4" />
		</Button>
	</header>

	<div bind:this={root} class="flex min-h-0 flex-1 flex-col">
		{#key agentId}
			<Conversation class="min-h-0 flex-1">
				<ConversationContent class="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
					{#if ac.loadingOlder}
						<div class="text-center text-xs text-muted-foreground">Loading earlier messages...</div>
					{/if}
					{#each chat.messages as m (m.id)}
						<ConversationItem messageId={m.id}>
							<MessageView
								message={m}
								agent={agent ? { id: agent.id, name: agent.name, color: agent.color } : undefined}
								onApproval={(a) => void ac.approve(a)}
								onOpenSession={(sid) => void openSession(sid)}
							/>
						</ConversationItem>
					{:else}
						{#if ac.loaded}
							<ConversationEmptyState
								title={agent ? `Start a conversation with ${agent.name}` : 'No messages yet'}
								description={agent?.description || 'Send a message to get started.'}
							>
								{#snippet icon()}
									{#if agent}<AgentAvatar seed={agent.id} color={agent.color} size={48} label={agent.name} />{/if}
								{/snippet}
							</ConversationEmptyState>
						{/if}
					{/each}
					{#if chat.status === 'submitted'}
						<div class="text-sm text-muted-foreground">Thinking...</div>
					{/if}
				</ConversationContent>
				<ConversationScrollButton />
			</Conversation>
		{/key}
	</div>

	<div class="mx-auto w-full max-w-3xl shrink-0 p-3">
		{#if waiting.length}
			<div class="mb-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg border border-border bg-warning-soft px-3 py-1.5 text-xs text-warning-text" role="status">
				{#each waiting as w, i (w.sessionId + w.id)}
					<span>
						Waiting for approval in <strong>{w.agentName}</strong>
						{#if w.taskId}
							<button class="underline underline-offset-4" onclick={() => openTask(w.taskId!)}>Review</button>
						{/if}{i < waiting.length - 1 ? ',' : ''}
					</span>
				{/each}
			</div>
		{/if}
		{#if ac.notice}
			<div class="mb-2 text-center text-xs text-muted-foreground" role="status">{ac.notice}</div>
		{/if}
		<ChatComposer
			onSend={send}
			onStop={() => void ac.stop()}
			status={chat.status}
			placeholder={agent ? `Message ${agent.name}` : 'Message the agent'}
		/>
	</div>
</section>
