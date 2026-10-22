<script lang="ts">
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import { api } from '#lib/api/index.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { type ApiAgent, type ApiKeyView, costText, keyState, limitText, type ApiUsage } from '#lib/developers/model.js';
	import { timeAgo } from '#lib/time.js';
	import KeyDialog from './KeyDialog.svelte';
	import UsageChart from './UsageChart.svelte';

	let { keys, agents, usage, onChanged, onCreated }: { keys: ApiKeyView[]; agents: ApiAgent[]; usage: ApiUsage | null; onChanged: () => void; onCreated: (secret: string, view: ApiKeyView) => void } = $props();

	let open = $state(false);
	let editing = $state<ApiKeyView | undefined>(undefined);
	let revoking = $state<ApiKeyView | undefined>(undefined);
	let confirmRevoke = $state(false);
	const now = Date.now();

	const edit = (k: ApiKeyView | undefined): void => {
		editing = k;
		open = true;
	};
	async function revoke(): Promise<void> {
		const k = revoking;
		if (!k) return;
		try {
			await api.post('/developer/keys/{id}/revoke', { params: { id: k.id } });
			toast.success('Key revoked');
			onChanged();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not revoke the key');
		}
	}
</script>

<div class="flex flex-col gap-4" data-testid="api-keys">
	<div class="flex items-center justify-between gap-3">
		<p class="text-sm text-muted-foreground">A key is shown once when you create it. Only a SHA-256 of it is stored.</p>
		<Button size="sm" onclick={() => edit(undefined)} disabled={agents.length === 0} data-testid="new-key"><PlusIcon class="size-4" /> New key</Button>
	</div>

	{#if usage}
		<div class="rounded-xl border border-border bg-card p-3">
			<div class="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
				<span class="font-medium text-foreground">Last 14 days</span>
				<span>{usage.totals.requests.toLocaleString()} requests · {costText(usage.totals.costUsd)}</span>
			</div>
			<UsageChart days={usage.days} />
		</div>
	{/if}

	{#if keys.length === 0}
		<div class="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground" data-testid="keys-empty">{agents.length === 0 ? 'Create an API agent first, then make a key for it.' : 'No key yet.'}</div>
	{:else}
		<div class="overflow-x-auto rounded-lg border border-border">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Key</Table.Head>
						<Table.Head>Agents</Table.Head>
						<Table.Head>Limits</Table.Head>
						<Table.Head>Today</Table.Head>
						<Table.Head>30 days</Table.Head>
						<Table.Head>Last used</Table.Head>
						<Table.Head class="w-0"></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each keys as k (k.id)}
						{@const state = keyState(k, now)}
						<Table.Row data-testid="key-row">
							<Table.Cell>
								<div class="flex flex-col gap-0.5">
									<span class="flex items-center gap-2 font-medium">{k.name} <Badge variant={state.variant}>{state.label}</Badge></span>
									<span class="font-mono text-xs text-muted-foreground">{k.id}_…</span>
									{#if k.origins.length > 0}<span class="text-xs text-muted-foreground">{k.origins.join(', ')}</span>{/if}
								</div>
							</Table.Cell>
							<Table.Cell class="text-xs">{k.agents.join(', ')}</Table.Cell>
							<Table.Cell class="text-xs">{limitText(k)}</Table.Cell>
							<Table.Cell class="text-xs">{costText(k.today.costUsd)}</Table.Cell>
							<Table.Cell class="text-xs">{k.month.requests.toLocaleString()} req · {costText(k.month.costUsd)}</Table.Cell>
							<Table.Cell class="text-xs">{k.lastUsedAt ? `${timeAgo(k.lastUsedAt)} ago`.replace('now ago', 'just now') : 'never'}</Table.Cell>
							<Table.Cell>
								<div class="flex gap-1">
									<Button size="sm" variant="ghost" onclick={() => edit(k)} disabled={k.revokedAt !== null}>Edit</Button>
									<Button size="sm" variant="ghost" class="text-destructive-text" disabled={k.revokedAt !== null} onclick={() => ((revoking = k), (confirmRevoke = true))} data-testid="revoke-key">Revoke</Button>
								</div>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</div>

<KeyDialog bind:open key={editing} {agents} onSaved={onChanged} {onCreated} />
<ConfirmDialog bind:open={confirmRevoke} title="Revoke this key?" description="It stops working at once and cannot be restored. Anything that still uses it gets a 401." confirmLabel="Revoke" onConfirm={revoke} />
