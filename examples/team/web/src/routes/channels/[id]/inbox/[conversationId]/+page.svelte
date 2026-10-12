<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOut';
	import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwise';
	import { api } from '#lib/api/index.js';
	import ActivityTable from '#lib/components/app/channels/ActivityTable.svelte';
	import ChannelHeader from '#lib/components/app/channels/ChannelHeader.svelte';
	import ConversationLog from '#lib/components/app/channels/ConversationLog.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { useConnection } from '#lib/channels/connection.svelte.js';
	import { allowlistLabel, channelHref, inboxCounts, KIND_LABEL, threadHref, type InboxConversation, type LogMessage } from '#lib/channels/model.js';
	import { pollWhileVisible } from '#lib/hooks/poll.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	// One conversation: its stored log, newest page first, older pages on request, and the activity
	// of the conversation. The log is decrypted on the server for whoever holds the web token.
	const cs = useConnection();
	const id = cs.id();
	const conversationId = $derived(page.params.conversationId ?? '');
	const agentName = (a: string): string => agentsStore.state.agents.find((x) => x.id === a)?.name ?? a;

	let conversation = $state<InboxConversation | null>(null);
	let log = $state<LogMessage[]>([]);
	let older = $state<string | undefined>();
	let loaded = $state(false);
	let notFound = $state(false);
	let error = $state('');
	let busy = $state(false);

	/** Newest page (a poll keeps what was loaded further back), or an older page (`before`). */
	async function loadLog(before?: string): Promise<void> {
		busy = true;
		try {
			const r = await api.get('/channels/connections/{id}/inbox/messages', { params: { id }, query: { conversationId, limit: 40, ...(before === undefined ? {} : { before }) } });
			conversation = r.conversation;
			if (before !== undefined) {
				log = [...r.items, ...log];
				older = r.next;
			} else {
				const first = r.items[0]?.id;
				const kept = first === undefined || !loaded ? [] : log.filter((m) => m.id < first);
				log = [...kept, ...r.items];
				if (kept.length === 0) older = r.next;
			}
			notFound = false;
			error = '';
		} catch (e) {
			notFound = (e as { status?: number }).status === 404;
			error = e instanceof Error ? e.message : 'Could not load the messages';
		} finally {
			busy = false;
			loaded = true;
		}
	}
	onMount(() => {
		void loadLog();
		return pollWhileVisible(() => {
			if (!busy) void loadLog();
		});
	});

	const href = $derived(conversation ? threadHref(conversation) : undefined);
	const title = $derived(conversation ? (conversation.parentTitle ? `${conversation.parentTitle} / ${conversation.title}` : conversation.title) : 'Conversation');
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<ChannelHeader section="inbox" detail {title}>
		{#snippet actions()}
			<Button size="sm" variant="ghost" onclick={() => void loadLog()} disabled={busy}><ArrowsClockwiseIcon class="size-4" /> Refresh</Button>
			{#if href}<Button size="sm" variant="outline" {href} data-testid="open-thread"><ArrowSquareOutIcon class="size-4" /> Open in the agent's thread</Button>{/if}
		{/snippet}
	</ChannelHeader>
	<PageBody size="wide" class="gap-5">
		{#if notFound}
			<Empty.Root class="border border-dashed border-border" data-testid="conversation-not-found">
				<Empty.Header>
					<Empty.Title>No such conversation</Empty.Title>
					<Empty.Description>This channel has no stored messages or activity for it.</Empty.Description>
				</Empty.Header>
				<Button size="sm" href={channelHref(id, 'inbox')}>All conversations</Button>
			</Empty.Root>
		{:else if error && !loaded}
			<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void loadLog()}>Try again</button></p>
		{:else if !conversation}
			<div class="flex flex-col gap-2" aria-busy="true">{#each [0, 1, 2] as i (i)}<Skeleton class="h-16 w-full rounded-lg" />{/each}</div>
		{:else}
			<section class="flex flex-col gap-1.5 rounded-xl border border-border bg-card p-4" aria-label="About this conversation">
				<div class="flex min-w-0 flex-wrap items-center gap-2">
					<Badge variant="secondary">{KIND_LABEL[conversation.kind]}{conversation.topic ? ' · topic' : ''}</Badge>
					<Badge variant={conversation.allowed ? 'success' : 'warning'}>{allowlistLabel(conversation)}</Badge>
					{#if conversation.parentId}<a class="text-xs underline underline-offset-4" href={channelHref(id, 'chats', conversation.parentId)}>{conversation.parentTitle ?? 'Chat'}</a>{/if}
					{#if conversation.kind !== 'dm'}<a class="text-xs underline underline-offset-4" href={channelHref(id, 'chats', conversation.conversationId)}>Chat settings</a>{/if}
				</div>
				<p class="text-xs text-muted-foreground">Agent: {agentName(conversation.agentId)} · {inboxCounts(conversation)}{href ? '' : ' · the agent has no thread here yet'}</p>
			</section>

			<section class="flex flex-col gap-3" aria-label="Messages" data-testid="conversation-log">
				<h2 class="text-sm font-medium">Messages</h2>
				{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
				{#if older !== undefined}
					<div class="flex justify-center"><Button size="sm" variant="outline" onclick={() => void loadLog(older)} disabled={busy} data-testid="load-older">Load older messages</Button></div>
				{/if}
				{#if log.length === 0}
					<p class="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">Nothing stored for this conversation (the log is kept for a limited time, or messages were only counted).</p>
				{:else}
					<ConversationLog items={log} />
				{/if}
			</section>

			<section class="flex flex-col gap-3" aria-label="Activity of this conversation" data-testid="conversation-activity">
				<h2 class="text-sm font-medium">Activity</h2>
				<ActivityTable connectionId={id} conversationId={conversation.conversationId} url={false} />
			</section>
		{/if}
	</PageBody>
</div>
