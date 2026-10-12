<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwise';
	import TelegramLogoIcon from 'phosphor-svelte/lib/TelegramLogo';
	import WarningIcon from 'phosphor-svelte/lib/Warning';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import ChannelReminders from '#lib/components/app/ChannelReminders.svelte';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import ConnectFlowDialog from '#lib/components/app/ConnectFlowDialog.svelte';
	import ChannelActivity from '#lib/components/app/ChannelActivity.svelte';
	import ChannelChatRow from '#lib/components/app/ChannelChatRow.svelte';
	import ChannelInbox from '#lib/components/app/ChannelInbox.svelte';
	import ChannelPeople from '#lib/components/app/ChannelPeople.svelte';
	import {
		agentChoices,
		breakerText,
		chatTree,
		outboxSummary,
		privacyWarning,
		STATE_LABEL,
		stateHint,
		stateTone,
		typeLabel,
		type ChannelChat,
		type ChannelConnection
	} from '#lib/channels/model.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	// One Telegram bot: its state, the agent it belongs to, the chats it may use, the employees
	// linked to it, and what is waiting to be sent.
	let { conn, onChange }: { conn: ChannelConnection; onChange: () => void } = $props();

	// a link from a notification (`?connection=<id>&tab=people`) opens the tab it names
	const TABS = ['chats', 'people', 'reminders', 'inbox', 'activity', 'delivery'];
	let tab = $state(
		untrack(() => {
			const t = page.url.searchParams.get('tab');
			const c = page.url.searchParams.get('connection');
			return t !== null && TABS.includes(t) && (c === null || c === conn.id) ? t : 'chats';
		})
	);
	let chats = $state<ChannelChat[]>([]);
	let agentId = $state(untrack(() => conn.binding?.agentId ?? ''));
	let busy = $state(false);
	let unbindOpen = $state(false);
	let reconnectOpen = $state(false);

	const agents = $derived(agentChoices(agentsStore.state.agents));
	const agentName = (id: string): string => agentsStore.state.agents.find((a) => a.id === id)?.name ?? id;
	const hint = $derived(stateHint(conn));
	const warning = $derived(privacyWarning(conn, chats));
	const breaker = $derived(breakerText(conn, Date.now()));
	const tree = $derived(chatTree(chats));
	const titleOf = (nodeId: string): string => chats.find((c) => c.id === nodeId)?.title ?? 'a chat';
	// chats (rooms), not their topics, are what the tab counts
	const chatCount = $derived(chats.filter((c) => c.kind !== 'thread').length);
	const bound = $derived(conn.binding !== null);
	const link = $derived(conn.bot ? `https://t.me/${conn.bot.username}` : undefined);

	async function loadDetail(): Promise<void> {
		try {
			chats = (await api.get('/channels/connections/{id}/chats', { params: { id: conn.id } })).items;
		} catch {
			// the connection card still shows; detail follows on the next refresh
		}
	}
	$effect(() => {
		void conn.counts.chats;
		void conn.runtime.state;
		void loadDetail();
	});
	// chats are discovered by the server as people write: look again while the card is open and visible
	$effect(() => {
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void loadDetail();
		}, 5000);
		return () => clearInterval(timer);
	});
	$effect(() => {
		// keep the chooser on the saved binding unless the person is changing it
		const saved = conn.binding?.agentId ?? '';
		untrack(() => {
			if (!agents.some((a) => a.id === agentId) || agentId === '') agentId = saved;
		});
	});

	const run = async (what: string, fn: () => Promise<unknown>, ok?: string): Promise<void> => {
		busy = true;
		try {
			await fn();
			if (ok) toast.success(ok);
			onChange();
			void loadDetail();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : `Could not ${what}`);
		} finally {
			busy = false;
		}
	};

	const bind = (): Promise<void> =>
		run('bind the bot', () => api.put('/channels/connections/{id}/binding', { params: { id: conn.id }, body: { agentId } }), bound ? 'Agent changed' : 'Bot bound: polling started');
	const unbind = (): Promise<void> => run('unbind', () => api.delete('/channels/connections/{id}/binding', { params: { id: conn.id } }), 'Bot unbound');
	const restart = (): Promise<void> => run('restart', () => api.post('/channels/connections/{id}/restart', { params: { id: conn.id } }), 'Restarted');
	const dropWebhook = (): Promise<void> => run('remove the webhook', () => api.post('/channels/connections/{id}/webhook/delete', { params: { id: conn.id } }), 'Webhook removed');
	const resetBreaker = (): Promise<void> => run('close the breaker', () => api.post('/channels/connections/{id}/breaker/reset', { params: { id: conn.id } }), 'Sending resumed');

</script>

<section class="flex flex-col gap-4 rounded-xl border border-border bg-card p-4" data-testid="channel-card" aria-label={conn.label}>
	<header class="flex flex-wrap items-start gap-3">
		<span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-info-soft text-info-text"><TelegramLogoIcon class="size-5" /></span>
		<div class="min-w-0 flex-1">
			<div class="flex min-w-0 flex-wrap items-center gap-2">
				<h2 class="truncate text-sm font-medium">{conn.label}</h2>
				{#if conn.bot}<span class="truncate text-xs text-muted-foreground">@{conn.bot.username}</span>{:else if conn.accountLabel}<span class="truncate text-xs text-muted-foreground">{conn.accountLabel}</span>{/if}
				{#if conn.label !== typeLabel(conn)}<Badge variant="secondary" data-testid="channel-type">{typeLabel(conn)}</Badge>{/if}
				<Badge variant={stateTone(conn.runtime.state)} data-testid="channel-state">{STATE_LABEL[conn.runtime.state]}</Badge>
			</div>
			{#if hint}<p class="mt-1 text-xs text-muted-foreground">{hint}</p>{/if}
		</div>
		<div class="flex flex-wrap items-center gap-2">
			{#if conn.runtime.state === 'webhook'}
				<Button size="sm" onclick={() => void dropWebhook()} disabled={busy}>Remove webhook and poll</Button>
			{/if}
			{#if conn.runtime.state === 'error'}
				<Button size="sm" variant="outline" onclick={() => void restart()} disabled={busy}><ArrowsClockwiseIcon class="size-4" /> Retry</Button>
			{/if}
			{#if conn.runtime.state === 'needs-auth'}
				<Button size="sm" variant="outline" onclick={() => (reconnectOpen = true)}>Reconnect with a new token</Button>
			{/if}
		</div>
	</header>

	<div class="flex flex-wrap items-end gap-2" data-testid="binding">
		<label class="flex min-w-48 flex-1 flex-col gap-1">
			<span class="text-xs font-medium">Agent that answers on this bot</span>
			<NativeSelect bind:value={agentId} aria-label="Agent" disabled={busy}>
				<NativeSelectOption value="" disabled>Choose an agent…</NativeSelectOption>
				{#each agents as a (a.id)}<NativeSelectOption value={a.id}>{a.name}</NativeSelectOption>{/each}
			</NativeSelect>
		</label>
		<Button size="sm" onclick={() => void bind()} disabled={busy || agentId === '' || agentId === conn.binding?.agentId} data-testid="bind">{bound ? 'Change agent' : 'Bind and start'}</Button>
		{#if bound}<Button size="sm" variant="ghost" onclick={() => (unbindOpen = true)} disabled={busy}>Unbind</Button>{/if}
	</div>
	{#if bound && conn.binding}
		<p class="-mt-2 text-xs text-muted-foreground">{agentName(conn.binding.agentId)} answers here. Group chats must be allowed one by one below; direct messages only work for people you link on the People tab.</p>
	{/if}

	{#if bound}
		<Tabs.Root bind:value={tab}>
			<Tabs.List class="max-w-full justify-start overflow-x-auto">
				<Tabs.Trigger value="chats">Chats {#if chatCount}<Badge shape="number" variant="secondary">{chatCount}</Badge>{/if}</Tabs.Trigger>
				<Tabs.Trigger value="people">People {#if conn.counts.unlinked}<Badge shape="number" variant="warning" title="Not linked yet">{conn.counts.unlinked}</Badge>{:else if conn.counts.linked}<Badge shape="number" variant="secondary">{conn.counts.linked}</Badge>{/if}</Tabs.Trigger>
				<Tabs.Trigger value="reminders">Reminders</Tabs.Trigger>
				<Tabs.Trigger value="inbox">Inbox</Tabs.Trigger>
				<Tabs.Trigger value="activity">Activity</Tabs.Trigger>
				<Tabs.Trigger value="delivery">Delivery</Tabs.Trigger>
			</Tabs.List>

			<Tabs.Content value="chats" class="flex flex-col gap-3 pt-3">
				{#if warning}
					<p class="flex gap-2 rounded-lg border border-border bg-warning-soft p-3 text-xs text-warning-text" role="note" data-testid="privacy-warning"><WarningIcon class="mt-0.5 size-4 shrink-0" /> {warning}</p>
				{/if}
				{#if conn.bot && !conn.bot.canReadAllGroupMessages}
					<p class="text-xs text-muted-foreground">{conn.bot.guidance}</p>
				{/if}
				{#if tree.length === 0}
					<div class="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
						No chats yet. Add the bot to a group (or as an admin to a channel) and write a message there; the chat shows up here and you choose whether the agent may use it.
						{#if link}<a class="underline underline-offset-4" href={link} target="_blank" rel="noreferrer">Open the bot in Telegram</a>.{/if}
					</div>
				{:else}
					<ul class="flex flex-col gap-2">
						{#each tree as b (b.chat.id)}<ChannelChatRow connectionId={conn.id} connectionLabel={conn.label} branch={b} {titleOf} onChange={() => { onChange(); void loadDetail(); }} />{/each}
					</ul>
				{/if}
			</Tabs.Content>

			<Tabs.Content value="people" class="pt-3"><ChannelPeople {conn} {onChange} /></Tabs.Content>

			<Tabs.Content value="reminders" class="pt-3"><ChannelReminders {conn} /></Tabs.Content>

			<Tabs.Content value="inbox" class="pt-3"><ChannelInbox {conn} /></Tabs.Content>

			<Tabs.Content value="activity" class="pt-3"><ChannelActivity {conn} /></Tabs.Content>

			<Tabs.Content value="delivery" class="flex flex-col gap-3 pt-3">
				<div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
					<div class="min-w-0 flex-1">
						<h3 class="text-sm font-medium">Outbox</h3>
						<p class="text-xs text-muted-foreground" data-testid="outbox-summary">{outboxSummary(conn)}</p>
					</div>
				</div>
				{#if breaker}
					<div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-warning-soft p-3 text-xs text-warning-text" role="alert">
						<span class="min-w-0 flex-1">{breaker}</span>
						<Button size="sm" variant="outline" onclick={() => void resetBreaker()} disabled={busy}>Resume sending</Button>
					</div>
				{:else}
					<p class="text-xs text-muted-foreground">Messages are queued, sent no faster than Telegram allows (about one per second per chat) and retried on errors. If sending keeps failing it pauses by itself and says so here.</p>
				{/if}
				<div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
					<p class="min-w-0 flex-1 text-xs text-muted-foreground">Something stuck? Restarting stops and starts polling. Queued messages and settings stay.</p>
					<Button size="sm" variant="outline" onclick={() => void restart()} disabled={busy}><ArrowsClockwiseIcon class="size-4" /> Restart the bot</Button>
				</div>
			</Tabs.Content>
		</Tabs.Root>
	{/if}
</section>

<ConnectFlowDialog bind:open={reconnectOpen} connectionId={conn.id} label={conn.label} next="The bot starts again by itself." onDone={() => onChange()} />
<ConfirmDialog bind:open={unbindOpen} title="Unbind this bot?" description="The agent stops answering on this bot and polling stops. Chats, linked accounts and stored messages stay." confirmLabel="Unbind" onConfirm={unbind} />
