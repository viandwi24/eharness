<script lang="ts">
	import { goto } from '$app/navigation';
	import { api } from '#lib/api/index.js';
	import ChannelHeader from '#lib/components/app/channels/ChannelHeader.svelte';
	import DataTable, { type Column } from '#lib/components/app/DataTable.svelte';
	import FilterChips from '#lib/components/app/FilterChips.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { useConnection } from '#lib/channels/connection.svelte.js';
	import { ServerTable } from '#lib/channels/table.svelte.js';
	import { tableQuery } from '#lib/channels/table-core.js';
	import { channelHref, type ChannelChat } from '#lib/channels/model.js';
	import { formatTime } from '#lib/format.js';

	// The admin log of the chats where the account is an admin: Telegram keeps it only briefly, so
	// it is read every few hours and stored.
	const cs = useConnection();
	const id = cs.id();
	const conn = $derived(cs.conn!);
	const running = $derived(conn.runtime.state === 'running');

	const table = new ServerTable<ChannelChat>(
		(p) => api.get('/channels/connections/{id}/chats/table', { params: { id }, query: tableQuery(p, { allowed: 'yes', admin: 'yes' }) as never }),
		{ sort: 'title', order: 'asc', filters: { adminLog: '' } }
	);
	let busy = $state(false);

	async function setAdminLog(c: ChannelChat, enabled: boolean): Promise<void> {
		busy = true;
		try {
			await api.put('/channels/connections/{id}/account/chats/{chatId}/admin-log', { params: { id, chatId: c.id }, body: { enabled } });
			await table.load(true);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not change the admin log');
		} finally {
			busy = false;
		}
	}
	async function runNow(): Promise<void> {
		busy = true;
		try {
			await api.post('/channels/connections/{id}/account/admin-log/run', { params: { id }, body: { force: true } as never });
			toast.success('Admin logs read');
			await table.load(true);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not read the admin log');
		} finally {
			busy = false;
		}
	}

	const columns: Column<ChannelChat>[] = [
		{ id: 'title', header: 'Chat', sort: 'title', mobile: 'title', cell: nameCell },
		{ id: 'on', header: 'Read the admin log', cell: switchCell },
		{ id: 'entries', header: 'Entries stored', numeric: true, cell: countCell },
		{ id: 'last', header: 'Last read', cell: lastCell }
	];
</script>

{#snippet nameCell(c: ChannelChat)}<a href={channelHref(id, 'chats', c.id)} class="font-medium hover:underline focus-visible:underline focus-visible:outline-none">{c.title}</a>{/snippet}
{#snippet switchCell(c: ChannelChat)}<Switch checked={c.account?.adminLog.enabled ?? false} onCheckedChange={(v) => void setAdminLog(c, v)} disabled={busy} aria-label="Read the admin log of {c.title}" />{/snippet}
{#snippet countCell(c: ChannelChat)}{c.account?.adminLog.count ?? 0}{/snippet}
{#snippet lastCell(c: ChannelChat)}<span class="text-xs text-muted-foreground">{c.account?.adminLog.enabled ? (c.account.adminLog.lastAt ? formatTime(c.account.adminLog.lastAt) : 'Not read yet') : 'Off'}{#if c.account?.adminLog.error} · {c.account.adminLog.error}{/if}</span>{/snippet}

{#snippet filters()}
	<FilterChips label="Admin log" options={[{ value: '', label: 'All' }, { value: 'yes', label: 'On' }, { value: 'no', label: 'Off' }]} value={table.params.filters.adminLog ?? ''} onChange={(v) => table.setFilter('adminLog', v)} />
{/snippet}
{#snippet actions()}<Button size="sm" variant="outline" onclick={() => void runNow()} disabled={busy || !running}>Read now</Button>{/snippet}
{#snippet empty()}
	<p class="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground" data-testid="adminlog-empty">No chosen chat where the account is an admin.</p>
{/snippet}

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<ChannelHeader section="admin-log" description="Bans, deletions and setting changes of the chats the account administers." />
	<PageBody size="wide" class="gap-3">
		<p class="text-xs text-muted-foreground">Telegram keeps a group's admin log (bans, deletions, setting changes) only for a short time. In chats where the account is an admin it is read every few hours and stored.</p>
		<DataTable {table} {columns} rowKey={(c) => c.id} label="Admin log" onRowClick={(c) => void goto(channelHref(id, 'chats', c.id))} {filters} {actions} {empty} searchPlaceholder="Search chats" testid="adminlog-table" />
	</PageBody>
</div>
