<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { api } from '#lib/api/index.js';
	import ChannelHeader from '#lib/components/app/channels/ChannelHeader.svelte';
	import ChatSettingsForm from '#lib/components/app/channels/ChatSettingsForm.svelte';
	import ChatsTable from '#lib/components/app/channels/ChatsTable.svelte';
	import ConversationLog from '#lib/components/app/channels/ConversationLog.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { useConnection } from '#lib/channels/connection.svelte.js';
	import { backfillText, botGone, cannotPost, channelHref, connectionText, KIND_LABEL, memberLabel, type ChannelChat, type LogMessage } from '#lib/channels/model.js';
	import { pollWhileVisible } from '#lib/hooks/poll.js';
	import { formatTime } from '#lib/format.js';

	// One chat or topic: what the agent does here (the settings, with where each value comes from),
	// its topics when it is a forum, and the last messages stored.
	const cs = useConnection();
	const id = cs.id();
	const nodeId = $derived(page.params.nodeId ?? '');
	const conn = $derived(cs.conn!);
	const account = $derived(conn.transport === 'user');

	let chat = $state<ChannelChat | null>(null);
	let parent = $state<ChannelChat | null>(null);
	let notFound = $state(false);
	let error = $state('');
	let messages = $state<LogMessage[] | null>(null);
	let seq = 0;

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const c = await api.get('/channels/connections/{id}/chats/{chatId}', { params: { id, chatId: nodeId } });
			if (mine !== seq) return;
			chat = c;
			notFound = false;
			error = '';
			if (c.parentId && parent?.id !== c.parentId) parent = await api.get('/channels/connections/{id}/chats/{chatId}', { params: { id, chatId: c.parentId } }).catch(() => null);
		} catch (e) {
			if (mine !== seq) return;
			notFound = (e as { status?: number }).status === 404;
			error = e instanceof Error ? e.message : 'Could not load the chat';
		}
	}
	async function loadMessages(): Promise<void> {
		try {
			messages = (await api.get('/channels/connections/{id}/inbox/messages', { params: { id }, query: { conversationId: nodeId, limit: 8 } })).items;
		} catch {
			// a forum parent or a place without messages has none: the section says so
			messages = [];
		}
	}
	onMount(() => {
		void load();
		void loadMessages();
		return pollWhileVisible(() => {
			void load();
			void loadMessages();
		});
	});

	const titleOf = (n: string): string => (parent && n === parent.id ? parent.title : n === chat?.id ? chat.title : 'the chat above');
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<ChannelHeader section="chats" detail title={chat?.title ?? 'Chat'} />
	<PageBody size="wide" class="gap-5">
		{#if notFound}
			<Empty.Root class="border border-dashed border-border" data-testid="chat-not-found">
				<Empty.Header>
					<Empty.Title>This chat does not exist</Empty.Title>
					<Empty.Description>It may belong to another channel, or it was removed.</Empty.Description>
				</Empty.Header>
				<Button size="sm" href={channelHref(id, 'chats')}>All chats</Button>
			</Empty.Root>
		{:else if error && !chat}
			<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Try again</button></p>
		{:else if !chat}
			<div class="flex flex-col gap-3" aria-busy="true">{#each [0, 1, 2] as i (i)}<Skeleton class="h-20 w-full rounded-xl" />{/each}</div>
		{:else}
			<section class="flex flex-col gap-2 rounded-xl border border-border bg-card p-4" aria-label="About this chat" data-testid="chat-facts">
				<div class="flex min-w-0 flex-wrap items-center gap-2">
					<Badge variant="secondary">{chat.kind === 'thread' ? 'Topic' : KIND_LABEL[chat.chatKind]}</Badge>
					<Badge variant={chat.effective.allowed ? 'success' : 'secondary'}>{chat.effective.allowed ? 'Agent may be used' : 'Not allowed'}</Badge>
					{#if chat.state === 'closed' || chat.state === 'archived'}<Badge variant="secondary">{chat.state === 'closed' ? 'Closed' : 'Archived'}</Badge>{/if}
					{#if botGone(chat)}<Badge variant="destructive">Not in this chat</Badge>{/if}
				</div>
				<dl class="grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
					<div><dt class="inline">Connection: </dt><dd class="inline text-foreground">{connectionText(conn.label, chat.member)}</dd></div>
					{#if chat.username}<div><dt class="inline">Username: </dt><dd class="inline text-foreground">@{chat.username}</dd></div>{/if}
					{#if parent}<div><dt class="inline">Topic of: </dt><dd class="inline"><a class="text-foreground underline underline-offset-4" href={channelHref(id, 'chats', parent.id)}>{parent.title}</a></dd></div>{/if}
					<div><dt class="inline">Last heard: </dt><dd class="inline text-foreground">{formatTime(chat.lastSeen)}</dd></div>
					<div><dt class="inline">Platform id: </dt><dd class="inline font-mono text-foreground">{chat.nativeId}</dd></div>
					{#if chat.member}<div><dt class="inline">Role there: </dt><dd class="inline text-foreground">{memberLabel(chat.member)}</dd></div>{/if}
				</dl>
				{#if cannotPost(chat)}<p class="text-xs text-warning-text">The connection cannot post here (no rights). It can read, but replies will fail until it is allowed to send messages.</p>{/if}
				{#if account && chat.account}
					<p class="text-xs text-muted-foreground" data-testid="account-state">
						{chat.account.selected ? 'The account reads this chat.' : 'The account does not read this chat.'}
						{#if chat.account.selected}{backfillText(chat, Date.now())}{/if}
						<a class="underline underline-offset-4" href={channelHref(id, 'history')}>History</a>
					</p>
				{/if}
			</section>

			<section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="Settings of this chat" data-testid="chat-settings-card">
				<div>
					<h2 class="text-sm font-medium">Settings</h2>
					<p class="text-xs text-muted-foreground">{chat.container ? 'Settings set here apply to every topic below unless a topic sets its own. ' : ''}Owners and admins are set on the People page. Anybody without a role is a guest, unless this chat is a trusted group.</p>
				</div>
				<ChatSettingsForm connectionId={id} connectionLabel={conn.label} {chat} {titleOf} onChange={(c) => { chat = c; void cs.load(); }} />
			</section>

			{#if chat.container}
				<section class="flex flex-col gap-3" aria-label="Topics" data-testid="chat-topics">
					<h2 class="text-sm font-medium">Topics</h2>
					<ChatsTable parentId={chat.id} onChange={() => void cs.load()} />
				</section>
			{/if}

			{#if chat.postable}
				<section class="flex flex-col gap-3" aria-label="Recent messages" data-testid="chat-messages">
					<div class="flex items-center justify-between gap-2">
						<h2 class="text-sm font-medium">Recent messages</h2>
						<Button size="sm" variant="ghost" href={channelHref(id, 'inbox', chat.id)}>Open the conversation</Button>
					</div>
					{#if messages === null}
						<Skeleton class="h-16 w-full rounded-lg" />
					{:else if messages.length === 0}
						<p class="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">Nothing stored for this chat yet (the log is kept for a limited time, or nobody wrote here).</p>
					{:else}
						<ConversationLog items={messages} />
					{/if}
				</section>
			{/if}
		{/if}
	</PageBody>
</div>
