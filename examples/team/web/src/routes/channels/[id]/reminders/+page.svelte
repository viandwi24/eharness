<script lang="ts">
	import BellIcon from 'phosphor-svelte/lib/Bell';
	import { api } from '#lib/api/index.js';
	import ChannelHeader from '#lib/components/app/channels/ChannelHeader.svelte';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import DataTable, { type Column } from '#lib/components/app/DataTable.svelte';
	import FilterChips from '#lib/components/app/FilterChips.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { useConnection } from '#lib/channels/connection.svelte.js';
	import { ServerTable } from '#lib/channels/table.svelte.js';
	import { tableQuery } from '#lib/channels/table-core.js';
	import { ago, channelHref, type ChannelReminder } from '#lib/channels/model.js';
	import { formatTime } from '#lib/format.js';

	// Reminders created from chats ("remind the group at 15:00"): where they post, when (absolute
	// time in the team timezone), whom they mention. They are posted as written, without a model call.
	const cs = useConnection();
	const id = cs.id();

	const table = new ServerTable<ChannelReminder>(
		(p) => api.get('/channels/connections/{id}/reminders/table', { params: { id }, query: tableQuery(p) as never }),
		{ sort: 'createdAt', order: 'desc', filters: { status: 'active' } }
	);

	let confirming = $state<ChannelReminder | null>(null);
	let confirmOpen = $state(false);

	async function cancel(r: ChannelReminder): Promise<void> {
		try {
			await api.delete('/channels/connections/{id}/reminders/{reminderId}', { params: { id, reminderId: r.id } });
			toast.success('Reminder cancelled');
			await table.load(true);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not cancel the reminder');
		}
	}

	const columns: Column<ChannelReminder>[] = [
		{ id: 'text', header: 'Reminder', sort: 'text', mobile: 'title', cell: textCell },
		{ id: 'status', header: 'Status', sort: 'status', cell: statusCell },
		{ id: 'when', header: 'When', cell: whenCell },
		{ id: 'place', header: 'Posts in', cell: placeCell },
		{ id: 'by', header: 'Set by', cell: byCell },
		{ id: 'lastFiredAt', header: 'Last posted', sort: 'lastFiredAt', firstOrder: 'desc', cell: firedCell },
		{ id: 'actions', header: '', cell: actionCell }
	];
</script>

{#snippet textCell(r: ChannelReminder)}
	<div class="flex min-w-0 items-start gap-2"><BellIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span class="min-w-0 break-words">{r.text}</span></div>
	{#if r.lastError}<div class="text-xs text-destructive-text">{r.lastError}</div>{/if}
{/snippet}
{#snippet statusCell(r: ChannelReminder)}<Badge variant={r.status === 'active' ? 'default' : 'secondary'}>{r.status === 'active' ? 'Active' : r.status === 'done' ? 'Done' : 'Cancelled'}</Badge>{/snippet}
{#snippet whenCell(r: ChannelReminder)}<span class="text-xs">{r.whenText}</span>{#if r.nextAt}<span class="block text-[11px] text-muted-foreground">next {formatTime(r.nextAt)}</span>{/if}{/snippet}
{#snippet placeCell(r: ChannelReminder)}
	<span class="text-xs">{r.chatTitle}</span>
	{#if r.mentions.length}<span class="block text-[11px] text-muted-foreground">mentions {r.mentions.join(', ')}</span>{/if}
{/snippet}
{#snippet byCell(r: ChannelReminder)}<span class="text-xs text-muted-foreground">{r.createdByName ?? '–'}{r.createdByRole ? ` (${r.createdByRole})` : ''}</span>{/snippet}
{#snippet firedCell(r: ChannelReminder)}<span class="text-xs text-muted-foreground">{r.lastFiredAt ? `${ago(r.lastFiredAt, Date.now())} · ${r.fireCount}×` : 'Never'}</span>{/snippet}
{#snippet actionCell(r: ChannelReminder)}
	{#if r.status === 'active'}<Button size="sm" variant="ghost" onclick={() => { confirming = r; confirmOpen = true; }} data-testid="cancel-reminder">Cancel reminder</Button>{/if}
{/snippet}

{#snippet filters()}
	<FilterChips label="Status" options={[{ value: 'active', label: 'Active' }, { value: 'done', label: 'Done' }, { value: 'cancelled', label: 'Cancelled' }, { value: '', label: 'All' }]} value={table.params.filters.status ?? ''} onChange={(v) => table.setFilter('status', v)} />
{/snippet}
{#snippet empty()}
	<p class="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground" data-testid="no-reminders">No reminders. Ask the agent in a chat: "remind the group tomorrow at 9:00 to send the report".</p>
{/snippet}

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<ChannelHeader section="reminders" description="Posts the agent makes later, set from a chat." />
	<PageBody size="wide" class="gap-3">
		<p class="text-xs text-muted-foreground">Owners and admins can set reminders for the group or for other people, members only for themselves. Cancel one here or in the chat. See also <a class="underline underline-offset-4" href="/routines">Routines</a> for everything the agents schedule.</p>
		<DataTable {table} {columns} rowKey={(r) => r.id} label="Reminders" {filters} {empty} searchPlaceholder="Search reminders" testid="reminders-table" />
	</PageBody>
</div>

<ConfirmDialog
	bind:open={confirmOpen}
	title="Cancel this reminder?"
	description={`"${confirming?.text ?? ''}" will not be posted. You cannot undo this.`}
	confirmLabel="Cancel reminder"
	onConfirm={() => (confirming ? cancel(confirming) : undefined)}
/>
