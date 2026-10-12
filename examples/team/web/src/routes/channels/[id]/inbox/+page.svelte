<script lang="ts">
	import { goto } from '$app/navigation';
	import { api } from '#lib/api/index.js';
	import ChannelHeader from '#lib/components/app/channels/ChannelHeader.svelte';
	import DataTable, { type Column } from '#lib/components/app/DataTable.svelte';
	import FilterChips from '#lib/components/app/FilterChips.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { useConnection } from '#lib/channels/connection.svelte.js';
	import { ServerTable } from '#lib/channels/table.svelte.js';
	import { tableQuery } from '#lib/channels/table-core.js';
	import { ago, allowlistLabel, channelHref, inboxCounts, KIND_LABEL, previewLine, type InboxConversation } from '#lib/channels/model.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	const cs = useConnection();
	const id = cs.id();
	const agentName = (a: string): string => agentsStore.state.agents.find((x) => x.id === a)?.name ?? a;

	const table = new ServerTable<InboxConversation>(
		(p) => api.get('/channels/connections/{id}/inbox/table', { params: { id }, query: tableQuery(p) as never }),
		{ sort: 'lastAt', order: 'desc', filters: { kind: '' } }
	);

	const columns: Column<InboxConversation>[] = [
		{ id: 'title', header: 'Conversation', sort: 'title', mobile: 'title', cell: titleCell },
		{ id: 'allowed', header: 'Allowlist', cell: allowedCell },
		{ id: 'counts', header: 'Messages', cell: countsCell },
		{ id: 'preview', header: 'Last message', cell: previewCell },
		{ id: 'lastAt', header: 'Last active', sort: 'lastAt', firstOrder: 'desc', cell: lastCell }
	];
</script>

{#snippet titleCell(c: InboxConversation)}
	<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
		<a href={channelHref(id, 'inbox', c.conversationId)} class="truncate font-medium hover:underline focus-visible:underline focus-visible:outline-none" data-testid="inbox-link">{c.parentTitle ? `${c.parentTitle} / ${c.title}` : c.title}</a>
		<Badge variant="secondary">{KIND_LABEL[c.kind]}{c.topic ? ' · topic' : ''}</Badge>
	</div>
{/snippet}
{#snippet allowedCell(c: InboxConversation)}<Badge variant={c.allowed ? 'success' : 'warning'}>{allowlistLabel(c)}</Badge>{/snippet}
{#snippet countsCell(c: InboxConversation)}<span class="text-xs text-muted-foreground">{inboxCounts(c)}</span>{/snippet}
{#snippet previewCell(c: InboxConversation)}<span class="line-clamp-2 text-xs break-words text-muted-foreground">{previewLine(c)}</span><span class="block text-[11px] text-muted-foreground">Agent: {agentName(c.agentId)}</span>{/snippet}
{#snippet lastCell(c: InboxConversation)}<span class="text-muted-foreground" title={new Date(c.lastAt).toLocaleString()}>{ago(c.lastAt, Date.now())}</span>{/snippet}

{#snippet filters()}
	<FilterChips label="Type" options={[{ value: '', label: 'All' }, { value: 'group', label: 'Groups' }, { value: 'channel', label: 'Channels' }, { value: 'topic', label: 'Topics' }, { value: 'dm', label: 'Direct' }]} value={table.params.filters.kind ?? ''} onChange={(v) => table.setFilter('kind', v)} />
{/snippet}
{#snippet empty()}
	<p class="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground" data-testid="inbox-empty">No conversations yet. They appear when somebody writes in a chat this channel is in.</p>
{/snippet}

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<ChannelHeader section="inbox" description="Every conversation this channel has seen." />
	<PageBody size="wide" class="gap-3">
		<p class="text-xs text-muted-foreground">Groups, topics and direct messages, most recently active first: what woke the agent, what was only read, and what was dropped. Open one to read its log.</p>
		<DataTable {table} {columns} rowKey={(c) => c.conversationId} label="Conversations" onRowClick={(c) => void goto(channelHref(id, 'inbox', c.conversationId))} {filters} {empty} searchPlaceholder="Search conversations" testid="inbox-table" />
	</PageBody>
</div>
