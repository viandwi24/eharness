<script lang="ts">
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwise';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { formatTokens } from '#lib/context.js';
	import { type ApiAgent, type ApiKeyView, type ApiRequestRow, costText, statusLabel, statusVariant } from '#lib/developers/model.js';
	import { formatDateTime } from '#lib/logs/logs.js';

	let { keys, agents, version }: { keys: ApiKeyView[]; agents: ApiAgent[]; version: number } = $props();

	let rows = $state<ApiRequestRow[] | null>(null);
	let keyId = $state('');
	let error = $state('');
	let loading = $state(false);

	const agentName = (id: string): string => agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);
	const keyName = (id: string): string => keys.find((k) => k.id === id)?.name ?? id;

	async function load(): Promise<void> {
		loading = true;
		try {
			const r = await api.get('/developer/requests', { query: { limit: 100, ...(keyId ? { keyId } : {}) } });
			rows = r.requests;
			error = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load the requests';
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void keyId;
		void version;
		void load();
	});
</script>

<div class="flex flex-col gap-3" data-testid="api-requests">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<p class="text-sm text-muted-foreground">Metadata only: the input and the answer are never logged.</p>
		<div class="flex items-center gap-2">
			<NativeSelect bind:value={keyId} aria-label="Filter by key" class="w-44">
				<NativeSelectOption value="">All keys</NativeSelectOption>
				{#each keys as k (k.id)}<NativeSelectOption value={k.id}>{k.name}</NativeSelectOption>{/each}
			</NativeSelect>
			<Button size="sm" variant="outline" onclick={() => void load()} disabled={loading}><ArrowClockwiseIcon class="size-4" /> Refresh</Button>
		</div>
	</div>
	{#if error}
		<p class="text-sm text-destructive-text" role="alert">{error}</p>
	{:else if rows === null}
		<p class="text-sm text-muted-foreground">Loading…</p>
	{:else if rows.length === 0}
		<div class="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground" data-testid="requests-empty">No request yet.</div>
	{:else}
		<div class="overflow-x-auto rounded-lg border border-border">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Time</Table.Head>
						<Table.Head>Key</Table.Head>
						<Table.Head>Agent</Table.Head>
						<Table.Head>Mode</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head class="text-right">Tokens</Table.Head>
						<Table.Head class="text-right">Cost</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each rows as r (r.id)}
						<Table.Row data-testid="request-row">
							<Table.Cell class="whitespace-nowrap text-xs">{formatDateTime(r.at)}</Table.Cell>
							<Table.Cell class="text-xs">{keyName(r.keyId)}</Table.Cell>
							<Table.Cell class="text-xs">{agentName(r.agentId)}</Table.Cell>
							<Table.Cell class="text-xs">{r.mode === 'run' ? 'One-shot' : 'Conversation'}</Table.Cell>
							<Table.Cell><Badge variant={statusVariant(r.status)} title={r.errorCode ?? ''}>{statusLabel(r.status)}{r.errorCode ? ` ${r.errorCode}` : ''}</Badge></Table.Cell>
							<Table.Cell class="text-right text-xs">{formatTokens(r.inputTokens)} in · {formatTokens(r.outputTokens)} out</Table.Cell>
							<Table.Cell class="text-right text-xs">{costText(r.costUsd)}</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</div>
