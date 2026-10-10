<script lang="ts">
	import { untrack } from 'svelte';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import LockIcon from 'phosphor-svelte/lib/Lock';
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwise';
	import type { AgentConnector, CapabilityMode, ConnectionChoices } from '#lib/api/index.js';
	import StatusBadge from '#lib/components/app/config/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import ModeControl from '#lib/components/app/config/ModeControl.svelte';
	import ConnectorIcon from '#lib/components/app/ConnectorIcon.svelte';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { connectorsStore } from '#lib/connectors/connectors.svelte.js';
	import { MODE_LABEL } from '#lib/connectors/core.js';
	import { applyChoices, groupConnectors, originLabel, scopeBadge, withCapabilityMode, withEnabled, withToolMode } from '#lib/connectors/agent-view.js';
	import { live } from '#lib/stores/live.svelte.js';
	import AddConnectorDialog from './AddConnectorDialog.svelte';
	import ConnectFlowDialog from './ConnectFlowDialog.svelte';

	let { agentId, compact = false }: { agentId: string; compact?: boolean } = $props();

	let list = $state<AgentConnector[]>([]);
	let loaded = $state(false);
	let loadError = $state('');
	let saving = $state<string | null>(null);
	let errors = $state<Record<string, string>>({});
	let addOpen = $state(false);
	let reconnectOpen = $state(false);
	let reconnectId = $state<string | undefined>(undefined);

	const groups = $derived(groupConnectors(list));

	async function reload(): Promise<void> {
		try {
			list = await connectorsStore.agentConnectors(agentId);
			loadError = '';
		} catch (e) {
			loadError = e instanceof Error ? e.message : String(e);
		}
		loaded = true;
	}

	$effect(() => {
		void agentId;
		untrack(() => {
			loaded = false;
			void connectorsStore.load();
			void reload();
		});
	});

	// another tab or instance changed a connection or an enablement: refetch quietly (no spinner)
	let seenRev = live.state.revs.connectors;
	$effect(() => {
		const rev = live.state.revs.connectors;
		untrack(() => {
			if (rev === seenRev) return;
			seenRev = rev;
			if (saving !== null) return; // our own save answers with the fresh list
			void connectorsStore.load();
			void reload();
		});
	});

	/** Optimistic update of one connection, rolled back with an inline error when the PUT fails. */
	async function save(c: AgentConnector, choices: ConnectionChoices | null): Promise<void> {
		const id = c.connectionId;
		const before = list;
		list = list.map((x) => (x.connectionId === id ? applyChoices(x, choices) : x));
		saving = id;
		errors = { ...errors, [id]: '' };
		try {
			list = await connectorsStore.setAgentConnectors(agentId, { [id]: choices });
		} catch (e) {
			list = before;
			errors = { ...errors, [id]: e instanceof Error ? e.message : 'Could not save the change' };
		} finally {
			saving = null;
		}
	}

	let expanded = $state<Record<string, boolean>>({});
	const summary = (c: AgentConnector): string => {
		const asks = c.capabilities.filter((x) => x.mode === 'ask').length;
		const off = c.capabilities.filter((x) => x.mode === 'off').length;
		return [`${c.capabilities.length} ${c.capabilities.length === 1 ? 'capability' : 'capabilities'}`, asks ? `${asks} ask first` : '', off ? `${off} off` : ''].filter(Boolean).join(' · ');
	};

	const modeId = (c: AgentConnector, key: string) => `${c.connectionId}:${key}`;
</script>

{#snippet row(c: AgentConnector)}
	{@const busy = saving === c.connectionId}
	{@const open = expanded[c.connectionId] ?? false}
	<li class="rounded-xl border border-border bg-card {c.enabled ? '' : 'opacity-80'}">
		<div class="flex items-center gap-3 p-3">
			<ConnectorIcon icon={c.icon} size="sm" />
			<div class="min-w-0 flex-1">
				<div class="flex flex-wrap items-center gap-1.5">
					<span class="text-sm font-medium">{c.name}</span>
					<Badge variant={c.ownership === 'workspace' ? 'secondary' : 'brand'}>{scopeBadge(c)}</Badge>
					{#if c.status === 'needs-auth' || c.status === 'error'}<StatusBadge status={c.status} />{/if}
				</div>
				<p class="truncate text-xs text-muted-foreground">
					{[c.label !== c.name ? c.label : '', c.accountLabel ?? ''].filter(Boolean).join(' · ') || (c.source === 'builtin' ? 'Included' : 'Connected')}
				</p>
			</div>
			{#if c.status === 'needs-auth'}
				<Button
					size="sm"
					variant="outline"
					onclick={() => {
						reconnectId = c.connectionId;
						reconnectOpen = true;
					}}><ArrowClockwiseIcon class="size-3.5" />Reconnect</Button
				>
			{/if}
			<Switch size="sm" checked={c.enabled} disabled={busy} aria-label="{c.name} {c.label} on or off" onCheckedChange={(v) => v !== c.enabled && save(c, withEnabled(c, v))} />
		</div>
		{#if c.status === 'error' && c.statusMessage}<p class="px-3 pb-2 text-xs text-destructive-text">{c.statusMessage}</p>{/if}

		<div class="flex items-center justify-between gap-2 border-t border-border px-3 py-1.5">
			{#if c.enabled && c.capabilities.length}
				<button
					type="button"
					aria-expanded={open}
					class="group flex items-center gap-1.5 rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
					onclick={() => (expanded[c.connectionId] = !open)}
				>
					<CaretDownIcon class="size-3 transition-transform {open ? 'rotate-180' : ''}" />{summary(c)}
				</button>
			{:else}
				<span class="text-xs text-muted-foreground">{c.enabled ? 'No capabilities' : 'Off for this agent'}</span>
			{/if}
			<span class="flex items-center gap-2 text-xs text-muted-foreground">
				{#if c.state === 'inherit'}
					{c.ownership === 'workspace' ? 'Follows workspace default' : 'Default'}
				{:else}
					Customized
					<button type="button" disabled={busy} class="underline underline-offset-2 hover:text-foreground" onclick={() => save(c, null)}>Reset to default</button>
				{/if}
			</span>
		</div>

		{#if c.enabled && open}
			<div class="border-t border-border px-3 pb-3">
				<ul class="divide-y divide-border">
					{#each c.capabilities as cap (cap.id)}
						<li class="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
							<div class="min-w-0">
								<p class="text-sm">{cap.title}</p>
								{#if cap.description}<p class="text-xs text-muted-foreground">{cap.description}</p>{/if}
								{#if cap.pinned && cap.mode === 'ask'}
									<p class="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"><LockIcon class="size-3" /> Always asks, even in Bypass mode</p>
								{/if}
							</div>
							<div class="flex items-center gap-2">
								{#if cap.override !== undefined}
									<button type="button" disabled={busy} class="text-xs text-muted-foreground underline-offset-2 hover:underline" onclick={() => save(c, withCapabilityMode(c, cap.id, null))}>Default</button>
								{/if}
								<ModeControl mode={cap.mode} label="{cap.title}: {MODE_LABEL[cap.mode]}" disabled={busy} onPick={(m) => save(c, withCapabilityMode(c, cap.id, m))} />
							</div>
						</li>
					{/each}
				</ul>
				{#if c.capabilities.some((cap) => cap.toolModes.length)}
					<Collapsible.Root class="mt-1">
						<Collapsible.Trigger class="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
							<CaretDownIcon class="size-3 transition-transform group-data-[state=open]:rotate-180" /> Advanced · individual tools
						</Collapsible.Trigger>
						<Collapsible.Content>
							<ul class="mt-2 space-y-1.5">
								{#each c.capabilities as cap (cap.id)}
									{#each cap.toolModes as t (modeId(c, t.name))}
										<li class="flex flex-wrap items-center justify-between gap-2">
											<code class="font-mono text-xs">{t.name}</code>
											<div class="flex items-center gap-2">
												{#if t.override !== undefined}
													<button type="button" disabled={busy} class="text-xs text-muted-foreground underline-offset-2 hover:underline" onclick={() => save(c, withToolMode(c, t.name, null))}>Default</button>
												{/if}
												<ModeControl mode={t.mode} label="{t.name}: {MODE_LABEL[t.mode]}" disabled={busy} onPick={(m) => save(c, withToolMode(c, t.name, m))} />
											</div>
										</li>
									{/each}
								{/each}
							</ul>
						</Collapsible.Content>
					</Collapsible.Root>
				{/if}
			</div>
		{/if}
		{#if errors[c.connectionId]}<p class="border-t border-border px-3 py-2 text-xs text-destructive-text" role="alert">{errors[c.connectionId]}</p>{/if}
	</li>
{/snippet}

<div class="space-y-5" class:text-sm={compact}>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<p class="text-sm text-muted-foreground">What this agent can use, and how much it may do on its own. Defaults come from the workspace.</p>
		{#if groups.connected.length}<Button size="sm" onclick={() => (addOpen = true)}><PlusIcon class="size-3.5" /> Add connector</Button>{/if}
	</div>

	{#if loadError}
		<p class="text-sm text-destructive-text" role="alert">{loadError}</p>
	{:else if !loaded}
		<div class="space-y-2"><Skeleton class="h-16 rounded-xl" /><Skeleton class="h-16 rounded-xl" /></div>
	{:else}
		<section class="space-y-2">
			<h3 class="text-sm font-medium">Connected apps</h3>
			{#if groups.connected.length}
				<ul class="space-y-2">{#each groups.connected as c (c.connectionId)}{@render row(c)}{/each}</ul>
			{:else}
				<div class="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-6 text-center">
					<p class="text-sm font-medium">No apps connected</p>
					<p class="max-w-sm text-xs text-muted-foreground">Add a connection from your workspace, or connect a new account just for this agent.</p>
					<Button size="sm" variant="outline" onclick={() => (addOpen = true)}><PlusIcon class="size-3.5" /> Add connector</Button>
				</div>
			{/if}
		</section>
		{#if groups.builtin.length}
			<section class="space-y-2">
				<h3 class="text-sm font-medium">Built in</h3>
				<ul class="space-y-2">{#each groups.builtin as c (c.connectionId)}{@render row(c)}{/each}</ul>
			</section>
		{/if}
	{/if}
</div>

<AddConnectorDialog bind:open={addOpen} {agentId} connectors={list} onChange={(next) => (list = next)} onConnected={reload} />
<ConnectFlowDialog bind:open={reconnectOpen} connectionId={reconnectId} onDone={() => void reload()} />
