<script lang="ts">
	import { formatDateTime } from '#lib/time.js';
	import { goto } from '$app/navigation';
	import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwise';
	import { api } from '#lib/api/index.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import DataTable, { type Column } from '#lib/components/app/DataTable.svelte';
	import FilterChips from '#lib/components/app/FilterChips.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { useConnection } from '#lib/channels/connection.svelte.js';
	import { ServerTable } from '#lib/channels/table.svelte.js';
	import { tableQuery } from '#lib/channels/table-core.js';
	import { ago, botGone, channelHref, KIND_LABEL, wakeLabel, YES_NO_ALL, type ChannelChat } from '#lib/channels/model.js';

	// The chats of a connection (or the topics of one chat) as a server-side table. A bot lists the
	// places it has seen and whether the agent may be used there; a user account lists its dialogs
	// and lets you choose which ones it reads.
	let { parentId, onChange }: { parentId?: string; onChange?: () => void } = $props();

	const cs = useConnection();
	const conn = $derived(cs.conn!);
	const id = cs.id();
	const account = $derived(conn.transport === 'user');
	// a table is for chats or for the topics of one chat for its whole life
	// svelte-ignore state_referenced_locally
	const topics = parentId !== undefined;
	const running = $derived(conn.runtime.state === 'running');

	const table = new ServerTable<ChannelChat>(
		(p) =>
			api.get('/channels/connections/{id}/chats/table', {
				params: { id },
				query: tableQuery(p, topics ? { level: 'topic', parentId } : {}) as never
			}),
		{ sort: 'lastSeen', order: 'desc', filters: { allowed: '', kind: '', admin: '' } },
		{ url: !topics }
	);

	let busy = $state(false);
	let stopping = $state<ChannelChat | null>(null);
	let stopOpen = $state(false);

	async function select(c: ChannelChat, selected: boolean): Promise<void> {
		busy = true;
		try {
			await api.put('/channels/connections/{id}/account/chats/{chatId}/selected', { params: { id, chatId: c.id }, body: { selected } });
			await table.load(true);
			onChange?.();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not choose the chat');
		} finally {
			busy = false;
		}
	}
	async function refresh(): Promise<void> {
		busy = true;
		try {
			await api.post('/channels/connections/{id}/account/chats/refresh', { params: { id } });
			toast.success('Chats refreshed');
			await table.load(true);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not read the chats');
		} finally {
			busy = false;
		}
	}

	const open = (c: ChannelChat): void => void goto(channelHref(id, 'chats', c.id));

	const columns: Column<ChannelChat>[] = $derived([
		{ id: 'title', header: topics ? 'Topic' : 'Chat', sort: 'title', mobile: 'title', cell: nameCell },
		...(topics ? [] : [{ id: 'kind', header: 'Type', sort: 'kind', cell: kindCell } satisfies Column<ChannelChat>]),
		...(account && !topics ? [{ id: 'reading', header: 'Read by the account', sort: 'allowed', firstOrder: 'desc', cell: readCell } satisfies Column<ChannelChat>] : [{ id: 'allowed', header: 'Agent may be used', sort: 'allowed', firstOrder: 'desc', cell: allowedCell } satisfies Column<ChannelChat>]),
		{ id: 'wake', header: 'Answers when', cell: wakeCell },
		{ id: 'lastSeen', header: 'Last heard', sort: 'lastSeen', firstOrder: 'desc', cell: heardCell }
	]);
</script>

{#snippet nameCell(c: ChannelChat)}
	<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
		<a href={channelHref(id, 'chats', c.id)} class="truncate font-medium hover:underline focus-visible:underline focus-visible:outline-none" data-testid="chat-link">{c.title}</a>
		{#if c.container && c.topics}<Badge variant="secondary">{c.topics} topic{c.topics === 1 ? '' : 's'}</Badge>{/if}
		{#if c.state === 'closed' || c.state === 'archived'}<Badge variant="secondary">{c.state === 'closed' ? 'Closed' : 'Archived'}</Badge>{/if}
		{#if botGone(c)}<Badge variant="destructive">Not in this chat</Badge>{/if}
		{#if c.username}<span class="text-xs text-muted-foreground">@{c.username}</span>{/if}
	</div>
{/snippet}
{#snippet kindCell(c: ChannelChat)}{KIND_LABEL[c.chatKind]}{/snippet}
{#snippet allowedCell(c: ChannelChat)}
	<Badge variant={c.effective.allowed ? 'success' : 'secondary'}>{c.effective.allowed ? 'Allowed' : 'Not allowed'}</Badge>
{/snippet}
{#snippet readCell(c: ChannelChat)}
	<div class="flex items-center gap-2">
		<Switch
			checked={c.account?.selected ?? false}
			onCheckedChange={(v) => (v ? void select(c, true) : ((stopping = c), (stopOpen = true)))}
			disabled={busy || !running}
			aria-label="Read {c.title}"
		/>
		{#if c.account?.admin}<Badge variant="secondary">Admin</Badge>{/if}
	</div>
{/snippet}
{#snippet wakeCell(c: ChannelChat)}
	{#if !c.effective.allowed}<span class="text-muted-foreground">Ignored</span>{:else if c.container && !c.postable}<span class="text-muted-foreground">In its topics</span>{:else}{wakeLabel(c.effective.wake)}{/if}
{/snippet}
{#snippet heardCell(c: ChannelChat)}<span class="text-muted-foreground" title={formatDateTime(c.lastSeen)}>{ago(c.lastSeen, Date.now())}</span>{/snippet}

{#snippet filters()}
	{#if !topics}
		<FilterChips label={account ? 'Read by the account' : 'Agent may be used'} options={account ? YES_NO_ALL('Being read', 'Not read') : YES_NO_ALL('Allowed', 'Not allowed')} value={table.params.filters.allowed ?? ''} onChange={(v) => table.setFilter('allowed', v)} />
		<FilterChips label="Type" options={[{ value: '', label: 'Any type' }, { value: 'group', label: 'Groups' }, { value: 'channel', label: 'Channels' }]} value={table.params.filters.kind ?? ''} onChange={(v) => table.setFilter('kind', v)} />
	{:else}
		<FilterChips label="Agent may be used" options={YES_NO_ALL('Allowed', 'Not allowed')} value={table.params.filters.allowed ?? ''} onChange={(v) => table.setFilter('allowed', v)} />
	{/if}
{/snippet}
{#snippet actions()}
	{#if account && !topics}<Button size="sm" variant="outline" onclick={() => void refresh()} disabled={busy || !running} data-testid="refresh-chats"><ArrowsClockwiseIcon class="size-4" /> Refresh chats</Button>{/if}
{/snippet}
{#snippet empty()}
	<div class="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground" data-testid="chats-empty">
		{#if topics}
			This forum has no topics yet.
		{:else if account}
			No chats yet. Press Refresh chats once the account is running; the groups and channels it is in show up here, and you choose which ones it reads.
		{:else}
			No chats yet. Add the bot to a group (or as an admin to a channel) and write a message there; the chat shows up here and you choose whether the agent may use it.
			{#if conn.bot}<a class="underline underline-offset-4" href="https://t.me/{conn.bot.username}" target="_blank" rel="noreferrer">Open the bot in Telegram</a>.{/if}
		{/if}
	</div>
{/snippet}

<DataTable
	{table}
	{columns}
	rowKey={(c) => c.id}
	label={topics ? 'Topics' : 'Chats'}
	onRowClick={open}
	{filters}
	{actions}
	{empty}
	searchPlaceholder={topics ? 'Search topics' : 'Search chats'}
	testid={topics ? 'topics-table' : 'chats-table'}
/>

<ConfirmDialog
	bind:open={stopOpen}
	title={`Stop reading ${stopping?.title ?? 'this chat'}?`}
	description="New messages from this chat are no longer stored, and its history reading stops. What is already stored stays."
	confirmLabel="Stop reading"
	onConfirm={() => (stopping ? select(stopping, false) : undefined)}
/>
