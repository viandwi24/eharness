<script lang="ts">
	import { untrack } from 'svelte';
	import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwise';
	import TelegramLogoIcon from 'phosphor-svelte/lib/TelegramLogo';
	import WarningIcon from 'phosphor-svelte/lib/Warning';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import ChannelActivity from '#lib/components/app/ChannelActivity.svelte';
	import ChannelChatRow from '#lib/components/app/ChannelChatRow.svelte';
	import ChannelInbox from '#lib/components/app/ChannelInbox.svelte';
	import ChannelPeople from '#lib/components/app/ChannelPeople.svelte';
	import {
		accountHint,
		ACCOUNT_WARNING,
		agentChoices,
		API_ID_URL,
		backfillText,
		KIND_LABEL,
		lastWindowDays,
		limitsBody,
		limitsFormOf,
		sortAccountChats,
		stateLabel,
		stateTone,
		TERMS_URL,
		typeLabel,
		usageText,
		type ChannelChat,
		type ChannelConnection,
		type LimitsForm
	} from '#lib/channels/model.js';
	import { formatTime } from '#lib/format.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	// One Telegram user account (MTProto): state, owner agent, the chat picker, history backfill,
	// admin log and send limits. See the warning box: this is a user account, not a bot.
	let { conn, onChange }: { conn: ChannelConnection; onChange: () => void } = $props();

	let tab = $state('chats');
	let chats = $state<ChannelChat[]>([]);
	let agentId = $state(untrack(() => conn.binding?.agentId ?? ''));
	let busy = $state(false);
	let unbindOpen = $state(false);
	let windows = $state<Record<string, string>>({});
	let limits = $state<LimitsForm>(untrack(() => (conn.account ? limitsFormOf(conn.account.limits) : { dmDailyMax: '', dailyMax: '', adminLogHours: '' })));
	let limitsDirty = $state(false);

	const account = $derived(conn.account);
	const agents = $derived(agentChoices(agentsStore.state.agents));
	const agentName = (id: string): string => agentsStore.state.agents.find((a) => a.id === id)?.name ?? id;
	const hint = $derived(accountHint(conn));
	const bound = $derived(conn.binding !== null);
	const running = $derived(conn.runtime.state === 'running');
	const picked = $derived(sortAccountChats(chats.filter((c) => c.account?.selected)));
	const others = $derived(sortAccountChats(chats.filter((c) => !c.account?.selected)));
	const adminChats = $derived(picked.filter((c) => c.account?.admin));

	async function loadDetail(): Promise<void> {
		try {
			chats = (await api.get('/channels/connections/{id}/chats', { params: { id: conn.id } })).items;
		} catch {
			// the card still shows; the next refresh retries
		}
	}
	$effect(() => {
		void conn.counts.chats;
		void conn.runtime.state;
		void loadDetail();
	});
	$effect(() => {
		const l = conn.account?.limits;
		untrack(() => {
			if (l && !limitsDirty) limits = limitsFormOf(l);
		});
	});

	const run = async (what: string, fn: () => Promise<unknown>, ok?: string): Promise<void> => {
		busy = true;
		try {
			await fn();
			if (ok) toast.success(ok);
			onChange();
			await loadDetail();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : `Could not ${what}`);
		} finally {
			busy = false;
		}
	};
	const id = (): { id: string } => ({ id: conn.id });
	const bind = (): Promise<void> =>
		run('bind the account', () => api.put('/channels/connections/{id}/binding', { params: id(), body: { agentId } }), bound ? 'Agent changed' : 'Account bound: starting');
	const unbind = (): Promise<void> => run('unbind', () => api.delete('/channels/connections/{id}/binding', { params: id() }), 'Account unbound');
	const restart = (): Promise<void> => run('restart', () => api.post('/channels/connections/{id}/restart', { params: id() }), 'Restarted');
	const refresh = (): Promise<void> => run('read the chats', () => api.post('/channels/connections/{id}/account/chats/refresh', { params: id() }), 'Chats refreshed');
	const select = (c: ChannelChat, selected: boolean): Promise<void> =>
		run('choose the chat', () => api.put('/channels/connections/{id}/account/chats/{chatId}/selected', { params: { id: conn.id, chatId: c.chatId }, body: { selected } }));
	function setBackfill(c: ChannelChat, clear: boolean): Promise<void> {
		const days = clear ? null : lastWindowDays(windows[c.chatId] ?? '');
		if (days === undefined || (days === null && !clear)) {
			toast.error('Days: a whole number, 1 to 3650');
			return Promise.resolve();
		}
		return run('set the window', () => api.put('/channels/connections/{id}/account/chats/{chatId}/backfill', { params: { id: conn.id, chatId: c.chatId }, body: { days } }), clear ? 'History reading stopped' : 'History window set');
	}
	const setAdminLog = (c: ChannelChat, enabled: boolean): Promise<void> =>
		run('change the admin log', () => api.put('/channels/connections/{id}/account/chats/{chatId}/admin-log', { params: { id: conn.id, chatId: c.chatId }, body: { enabled } }));
	const runAdminLog = (): Promise<void> => run('read the admin log', () => api.post('/channels/connections/{id}/account/admin-log/run', { params: id(), body: { force: true } as never }), 'Admin logs read');
	async function saveLimits(): Promise<void> {
		const r = limitsBody(limits);
		if ('error' in r) {
			toast.error(r.error);
			return;
		}
		await run('save the limits', () => api.put('/channels/connections/{id}/account/limits', { params: id(), body: r.body }), 'Limits saved');
		limitsDirty = false;
	}
</script>

<section class="flex flex-col gap-4 rounded-xl border border-border bg-card p-4" data-testid="channel-card" aria-label={conn.label}>
	<header class="flex flex-wrap items-start gap-3">
		<span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-info-soft text-info-text"><TelegramLogoIcon class="size-5" /></span>
		<div class="min-w-0 flex-1">
			<div class="flex min-w-0 flex-wrap items-center gap-2">
				<h2 class="truncate text-sm font-medium">{conn.label}</h2>
				{#if account?.username}<span class="truncate text-xs text-muted-foreground">@{account.username}</span>{:else if conn.accountLabel}<span class="truncate text-xs text-muted-foreground">{conn.accountLabel}</span>{/if}
				<Badge variant="secondary" data-testid="channel-type">{typeLabel(conn)}</Badge>
				<Badge variant={stateTone(conn.runtime.state)} data-testid="channel-state">{stateLabel(conn.runtime.state)}</Badge>
			</div>
			{#if hint}<p class="mt-1 text-xs text-muted-foreground">{hint}</p>{/if}
		</div>
		<div class="flex flex-wrap items-center gap-2">
			{#if conn.runtime.state === 'error' || conn.runtime.state === 'lease'}
				<Button size="sm" variant="outline" onclick={() => void restart()} disabled={busy}><ArrowsClockwiseIcon class="size-4" /> Retry</Button>
			{/if}
			{#if conn.runtime.state === 'needs-auth'}
				<Button size="sm" variant="outline" href="/connectors">Sign in again</Button>
			{/if}
		</div>
	</header>

	<div class="flex flex-col gap-2 rounded-lg border border-border bg-warning-soft p-3 text-xs text-warning-text" role="note" data-testid="account-warning">
		<p class="flex gap-2 font-medium"><WarningIcon class="mt-0.5 size-4 shrink-0" /> This is a user account, not a bot</p>
		<p>{ACCOUNT_WARNING}</p>
		<p class="flex flex-wrap gap-x-4 gap-y-1">
			<a class="underline underline-offset-4" href={TERMS_URL} target="_blank" rel="noreferrer">Telegram API terms</a>
			<a class="underline underline-offset-4" href={API_ID_URL} target="_blank" rel="noreferrer">Getting an api_id</a>
		</p>
	</div>

	<div class="flex flex-wrap items-end gap-2" data-testid="binding">
		<label class="flex min-w-48 flex-1 flex-col gap-1">
			<span class="text-xs font-medium">Agent that owns this account</span>
			<NativeSelect bind:value={agentId} aria-label="Agent" disabled={busy}>
				<NativeSelectOption value="" disabled>Choose an agent…</NativeSelectOption>
				{#each agents as a (a.id)}<NativeSelectOption value={a.id}>{a.name}</NativeSelectOption>{/each}
			</NativeSelect>
		</label>
		<Button size="sm" onclick={() => void bind()} disabled={busy || agentId === '' || agentId === conn.binding?.agentId} data-testid="bind">{bound ? 'Change agent' : 'Bind and start'}</Button>
		{#if bound}<Button size="sm" variant="ghost" onclick={() => (unbindOpen = true)} disabled={busy}>Unbind</Button>{/if}
	</div>
	{#if bound && conn.binding}
		<p class="-mt-2 text-xs text-muted-foreground">{agentName(conn.binding.agentId)} owns this account. Chats you choose are stored and observe-only; the agent answers only where you change a chat's policy to answer. Direct messages only reach it from people you link on the People tab.</p>
	{/if}

	{#if bound && account}
		{#if account.warnings.length > 0}
			<ul class="flex flex-col gap-1 text-xs text-warning-text" role="status">{#each account.warnings as w (w)}<li>{w}</li>{/each}</ul>
		{/if}
		<Tabs.Root bind:value={tab}>
			<Tabs.List class="max-w-full justify-start overflow-x-auto">
				<Tabs.Trigger value="chats">Chats {#if picked.length}<Badge shape="number" variant="secondary">{picked.length}</Badge>{/if}</Tabs.Trigger>
				<Tabs.Trigger value="people">People {#if conn.counts.unlinked}<Badge shape="number" variant="warning" title="Not linked yet">{conn.counts.unlinked}</Badge>{:else if conn.counts.linked}<Badge shape="number" variant="secondary">{conn.counts.linked}</Badge>{/if}</Tabs.Trigger>
				<Tabs.Trigger value="inbox">Inbox</Tabs.Trigger>
				<Tabs.Trigger value="activity">Activity</Tabs.Trigger>
				<Tabs.Trigger value="backfill">Backfill</Tabs.Trigger>
				<Tabs.Trigger value="adminlog">Admin log</Tabs.Trigger>
				<Tabs.Trigger value="limits">Limits</Tabs.Trigger>
			</Tabs.List>

			<Tabs.Content value="chats" class="flex flex-col gap-3 pt-3">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<p class="min-w-0 flex-1 text-xs text-muted-foreground">Pick the groups and channels to read. People (direct messages) are never listed. Live messages, edits and deletions are stored from the moment a chat is chosen.</p>
					<Button size="sm" variant="outline" onclick={() => void refresh()} disabled={busy || !running} data-testid="refresh-chats"><ArrowsClockwiseIcon class="size-4" /> Refresh chats</Button>
				</div>
				{#if !running}<p class="text-xs text-muted-foreground">The account has to be running to read its chats.</p>{/if}
				{#if picked.length > 0}
					<h3 class="text-xs font-medium">Chosen</h3>
					<ul class="flex flex-col gap-2">
						{#each picked as c (c.chatId)}
							<div class="flex flex-col gap-1">
								<ChannelChatRow connectionId={conn.id} chat={c} onChange={() => { onChange(); void loadDetail(); }} />
								<div class="flex justify-end"><Button size="sm" variant="ghost" onclick={() => void select(c, false)} disabled={busy}>Stop reading</Button></div>
							</div>
						{/each}
					</ul>
				{/if}
				<h3 class="text-xs font-medium">In the account</h3>
				{#if others.length === 0}
					<p class="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">{chats.length === 0 ? 'No chats yet. Press Refresh chats once the account is running.' : 'Every chat of the account is chosen.'}</p>
				{:else}
					<ul class="flex flex-col divide-y divide-border rounded-lg border border-border">
						{#each others as c (c.chatId)}
							<li class="flex items-center gap-3 p-3" data-testid="account-chat">
								<div class="min-w-0 flex-1">
									<div class="flex min-w-0 items-center gap-2"><span class="truncate text-sm">{c.title}</span><Badge variant="secondary">{KIND_LABEL[c.kind]}</Badge>{#if c.account?.admin}<Badge variant="secondary">Admin</Badge>{/if}</div>
								</div>
								<Switch checked={false} onCheckedChange={() => void select(c, true)} disabled={busy} aria-label="Read {c.title}" />
							</li>
						{/each}
					</ul>
				{/if}
			</Tabs.Content>

			<Tabs.Content value="people" class="pt-3"><ChannelPeople {conn} {onChange} /></Tabs.Content>

			<Tabs.Content value="inbox" class="pt-3"><ChannelInbox {conn} /></Tabs.Content>

			<Tabs.Content value="activity" class="pt-3"><ChannelActivity {conn} /></Tabs.Content>

			<Tabs.Content value="backfill" class="flex flex-col gap-3 pt-3">
				<p class="text-xs text-muted-foreground">Reads the history of a chosen chat, newest first, down to the number of days you set (one chat at a time, with pauses). It resumes after a restart and obeys Telegram's flood waits.</p>
				{#if picked.length === 0}<p class="text-sm text-muted-foreground">Choose a chat first.</p>{/if}
				<ul class="flex flex-col gap-2">
					{#each picked as c (c.chatId)}
						<li class="flex flex-col gap-2 rounded-lg border border-border p-3" data-testid="backfill-row">
							<span class="truncate text-sm font-medium">{c.title}</span>
							<p class="text-xs text-muted-foreground">{backfillText(c, Date.now())}</p>
							<div class="flex flex-wrap items-center gap-2">
								<Input class="w-28" inputmode="numeric" placeholder="Days" aria-label="History window in days for {c.title}" value={windows[c.chatId] ?? (c.account?.backfill.days === null || c.account?.backfill.days === undefined ? '' : String(c.account.backfill.days))} oninput={(e) => (windows[c.chatId] = e.currentTarget.value)} />
								<Button size="sm" variant="outline" onclick={() => void setBackfill(c, false)} disabled={busy}>Read history</Button>
								{#if c.account?.backfill.days !== null && c.account?.backfill.days !== undefined}<Button size="sm" variant="ghost" onclick={() => void setBackfill(c, true)} disabled={busy}>Stop</Button>{/if}
							</div>
						</li>
					{/each}
				</ul>
			</Tabs.Content>

			<Tabs.Content value="adminlog" class="flex flex-col gap-3 pt-3">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<p class="min-w-0 flex-1 text-xs text-muted-foreground">Telegram keeps a group's admin log (bans, deletions, setting changes) only for a short time. In chats where the account is an admin it is read every few hours and stored.</p>
					<Button size="sm" variant="outline" onclick={() => void runAdminLog()} disabled={busy || !running || adminChats.length === 0}>Read now</Button>
				</div>
				{#if adminChats.length === 0}<p class="text-sm text-muted-foreground">No chosen chat where the account is an admin.</p>{/if}
				<ul class="flex flex-col divide-y divide-border rounded-lg border border-border">
					{#each adminChats as c (c.chatId)}
						<li class="flex items-center gap-3 p-3" data-testid="adminlog-row">
							<div class="min-w-0 flex-1">
								<div class="truncate text-sm">{c.title}</div>
								<p class="text-xs text-muted-foreground">{c.account?.adminLog.enabled ? `${c.account.adminLog.count} entries${c.account.adminLog.lastAt ? ` · last read ${formatTime(c.account.adminLog.lastAt)}` : ' · not read yet'}` : 'Off'}{#if c.account?.adminLog.error} · {c.account.adminLog.error}{/if}</p>
							</div>
							<Switch checked={c.account?.adminLog.enabled ?? false} onCheckedChange={(v) => void setAdminLog(c, v)} disabled={busy} aria-label="Read the admin log of {c.title}" />
						</li>
					{/each}
				</ul>
			</Tabs.Content>

			<Tabs.Content value="limits" class="flex flex-col gap-3 pt-3">
				<p class="text-xs text-muted-foreground">A user account that sends like a robot gets limited. Sends are spaced out and capped per day; the defaults are strict on purpose. Raise them only when you must.</p>
				<p class="text-xs" data-testid="usage">{usageText(account)}{#if account.floods.parkedChats > 0} · {account.floods.parkedChats} chat{account.floods.parkedChats === 1 ? '' : 's'} paused by a flood wait{/if}{#if account.pausedUntil} · sending paused until {formatTime(account.pausedUntil)}{/if}</p>
				<div class="grid gap-3 sm:grid-cols-3">
					<label class="flex flex-col gap-1"><span class="text-xs font-medium">Direct messages a day</span><Input inputmode="numeric" bind:value={limits.dmDailyMax} oninput={() => (limitsDirty = true)} /></label>
					<label class="flex flex-col gap-1"><span class="text-xs font-medium">Messages a day (all)</span><Input inputmode="numeric" bind:value={limits.dailyMax} oninput={() => (limitsDirty = true)} /></label>
					<label class="flex flex-col gap-1"><span class="text-xs font-medium">Admin log every (hours)</span><Input inputmode="decimal" bind:value={limits.adminLogHours} oninput={() => (limitsDirty = true)} /></label>
				</div>
				<div class="flex flex-wrap justify-between gap-2">
					<Button size="sm" variant="outline" onclick={() => void restart()} disabled={busy}><ArrowsClockwiseIcon class="size-4" /> Restart the account</Button>
					<Button size="sm" onclick={() => void saveLimits()} disabled={busy || !limitsDirty} data-testid="save-limits">Save limits</Button>
				</div>
			</Tabs.Content>
		</Tabs.Root>
	{/if}
</section>

<ConfirmDialog bind:open={unbindOpen} title="Unbind this account?" description="The agent stops using the account and the session is closed. Chosen chats and stored messages stay." confirmLabel="Unbind" onConfirm={unbind} />
