<script lang="ts">
	import { api } from '#lib/api/index.js';
	import DataTable, { type Column } from '#lib/components/app/DataTable.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { ServerTable } from '#lib/channels/table.svelte.js';
	import { tableQuery } from '#lib/channels/table-core.js';
	import { ago, EVENT_LABEL, EVENT_TYPES, eventText, eventTone, type ActivityType, type ChannelActivity } from '#lib/channels/model.js';
	import { formatTime } from '#lib/format.js';

	// Activity of a connection, newest first: what was received and what happened to it (woke the
	// agent, observed, dropped and why), replies, approvals, the breaker. Metadata only, never text.
	// `peerId` or `conversationId` narrow it to one person or one conversation.
	let { connectionId, peerId, conversationId, url = true }: { connectionId: string; peerId?: string; conversationId?: string; url?: boolean } = $props();

	// the filters and the URL setting are fixed for the life of the table
	// svelte-ignore state_referenced_locally
	const table = new ServerTable<ChannelActivity>(
		(p) =>
			api.get('/channels/connections/{id}/activity/table', {
				params: { id: connectionId },
				query: tableQuery(p, { peerId, conversationId }) as never
			}),
		{ sort: undefined, order: undefined, filters: { type: '' } },
		{ url }
	);

	const columns: Column<ChannelActivity>[] = [
		{ id: 'type', header: 'Event', mobile: 'title', cell: typeCell },
		{ id: 'what', header: 'Details', cell: whatCell },
		{ id: 'at', header: 'When', numeric: false, cell: whenCell }
	];
</script>

{#snippet typeCell(e: ChannelActivity)}<Badge variant={eventTone(e.type)}>{EVENT_LABEL[e.type]}</Badge>{/snippet}
{#snippet whatCell(e: ChannelActivity)}<span class="text-xs break-words text-muted-foreground">{eventText(e) || '–'}</span>{/snippet}
{#snippet whenCell(e: ChannelActivity)}<span class="text-xs whitespace-nowrap text-muted-foreground" title={formatTime(e.at)}>{ago(e.at, Date.now())}</span>{/snippet}
{#snippet filters()}
	<NativeSelect size="sm" value={table.params.filters.type ?? ''} onchange={(e) => table.setFilter('type', (e.currentTarget as HTMLSelectElement).value)} aria-label="Filter by event type" data-testid="activity-type">
		<NativeSelectOption value="">All events</NativeSelectOption>
		{#each EVENT_TYPES as t (t as ActivityType)}<NativeSelectOption value={t}>{EVENT_LABEL[t]}</NativeSelectOption>{/each}
	</NativeSelect>
{/snippet}
{#snippet empty()}
	<p class="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground" data-testid="activity-empty">Nothing yet. Events appear when somebody writes to this channel or the agent sends something.</p>
{/snippet}

<DataTable {table} {columns} rowKey={(e) => e.id} label="Activity" {filters} {empty} searchPlaceholder="Search reasons, names, chats" testid="activity-table" />
