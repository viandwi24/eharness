<script lang="ts">
	import { goto } from '$app/navigation';
	import { api } from '#lib/api/index.js';
	import ChannelHeader from '#lib/components/app/channels/ChannelHeader.svelte';
	import DataTable, { type Column } from '#lib/components/app/DataTable.svelte';
	import FilterChips from '#lib/components/app/FilterChips.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { useConnection } from '#lib/channels/connection.svelte.js';
	import { ServerTable } from '#lib/channels/table.svelte.js';
	import { tableQuery } from '#lib/channels/table-core.js';
	import { BACKFILL_STATE_LABEL, channelHref, lastWindowDays, type ChannelChat } from '#lib/channels/model.js';

	// History of the chats an account reads: newest first, down to a number of days, one chat at a
	// time with pauses; it resumes after a restart and obeys Telegram's flood waits.
	const cs = useConnection();
	const id = cs.id();
	const conn = $derived(cs.conn!);

	// only the chats the account reads have a history to read
	const table = new ServerTable<ChannelChat>(
		(p) => api.get('/channels/connections/{id}/chats/table', { params: { id }, query: tableQuery(p, { allowed: 'yes' }) as never }),
		{ sort: 'backfill', order: 'desc', filters: { history: '' } }
	);
	let windows = $state<Record<string, string>>({});
	let busy = $state(false);

	async function setBackfill(c: ChannelChat, clear: boolean): Promise<void> {
		const days = clear ? null : lastWindowDays(windows[c.id] ?? '');
		if (days === undefined || (days === null && !clear)) {
			toast.error('Days: a whole number, 1 to 3650');
			return;
		}
		busy = true;
		try {
			await api.put('/channels/connections/{id}/account/chats/{chatId}/backfill', { params: { id, chatId: c.id }, body: { days } });
			toast.success(clear ? 'History reading stopped' : 'History window set');
			await table.load(true);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not set the window');
		} finally {
			busy = false;
		}
	}

	const columns: Column<ChannelChat>[] = [
		{ id: 'title', header: 'Chat', sort: 'title', mobile: 'title', cell: nameCell },
		{ id: 'state', header: 'History', sort: 'backfill', cell: stateCell },
		{ id: 'messages', header: 'Messages stored', sort: 'messages', firstOrder: 'desc', numeric: true, cell: countCell },
		{ id: 'window', header: 'Window (days)', cell: windowCell }
	];
</script>

{#snippet nameCell(c: ChannelChat)}<a href={channelHref(id, 'chats', c.id)} class="font-medium hover:underline focus-visible:underline focus-visible:outline-none">{c.title}</a>{/snippet}
{#snippet stateCell(c: ChannelChat)}
	{@const b = c.account?.backfill}
	{#if !b || b.days === null}<span class="text-muted-foreground">Not read</span>{:else}
		<div class="flex flex-col gap-0.5">
			<Badge variant={b.state === 'error' ? 'destructive' : b.state === 'done' ? 'success' : 'secondary'}>{BACKFILL_STATE_LABEL[b.state] ?? b.state}</Badge>
			<span class="text-xs text-muted-foreground">{b.days} day{b.days === 1 ? '' : 's'}{b.oldestAt !== undefined ? ` · back to ${new Date(b.oldestAt).toISOString().slice(0, 10)}` : ''}{b.state === 'parked' && b.parkedUntil !== undefined ? ` · resumes in about ${Math.max(1, Math.ceil((b.parkedUntil - Date.now()) / 60_000))} min` : ''}</span>
			{#if b.error}<span class="text-xs text-destructive-text">{b.error}</span>{/if}
		</div>
	{/if}
{/snippet}
{#snippet countCell(c: ChannelChat)}{c.account?.backfill.count ?? 0}{/snippet}
{#snippet windowCell(c: ChannelChat)}
	<div class="flex flex-wrap items-center gap-2">
		<Input class="w-20" inputmode="numeric" placeholder="Days" aria-label="History window in days for {c.title}" value={windows[c.id] ?? (c.account?.backfill.days == null ? '' : String(c.account.backfill.days))} oninput={(e) => (windows[c.id] = e.currentTarget.value)} />
		<Button size="sm" variant="outline" onclick={() => void setBackfill(c, false)} disabled={busy}>Read history</Button>
		{#if c.account?.backfill.days != null}<Button size="sm" variant="ghost" onclick={() => void setBackfill(c, true)} disabled={busy}>Stop</Button>{/if}
	</div>
{/snippet}

{#snippet filters()}
	<FilterChips label="History" options={[{ value: '', label: 'All' }, { value: 'yes', label: 'Being read' }, { value: 'no', label: 'No window' }]} value={table.params.filters.history ?? ''} onChange={(v) => table.setFilter('history', v)} />
{/snippet}
{#snippet empty()}
	<p class="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground" data-testid="history-empty">The account reads no chat yet. Choose chats on the <a class="underline underline-offset-4" href={channelHref(id, 'chats')}>Chats</a> page first.</p>
{/snippet}

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<ChannelHeader section="history" description="Read older messages of the chats the account reads." />
	<PageBody size="wide" class="gap-3">
		<p class="text-xs text-muted-foreground">Reads the history of a chosen chat, newest first, down to the number of days you set (one chat at a time, with pauses). It resumes after a restart and obeys Telegram's flood waits.{conn.runtime.state === 'running' ? '' : ' The account has to be running to read.'}</p>
		<DataTable {table} {columns} rowKey={(c) => c.id} label="History" onRowClick={(c) => void goto(channelHref(id, 'chats', c.id))} {filters} {empty} searchPlaceholder="Search chats" testid="history-table" />
	</PageBody>
</div>
