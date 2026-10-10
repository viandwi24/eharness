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
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { connectorsStore } from '#lib/connectors/connectors.svelte.js';
	import { MODES, MODE_LABEL } from '#lib/connectors/core.js';
	import { applyChoices, groupConnectors, originLabel, scopeBadge, withCapabilityMode, withEnabled, withToolMode } from '#lib/connectors/agent-view.js';
	import { connectorIcon } from '#lib/connectors/icons.js';
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

	const modeId = (c: AgentConnector, key: string) => `${c.connectionId}:${key}`;
</script>

{#snippet modeControl(label: string, mode: CapabilityMode, disabled: boolean, onPick: (m: CapabilityMode) => void, canReset: boolean, onReset: () => void)}
	<div class="flex items-center gap-1.5" role="group" aria-label={label}>
		<div class="inline-flex overflow-hidden rounded-md border border-border text-xs">
			{#each MODES as m (m)}
				<button
					type="button"
					{disabled}
					aria-pressed={mode === m}
					class="px-2 py-1 transition-colors disabled:opacity-50 {mode === m ? 'bg-brand-soft font-medium text-brand-text' : 'text-muted-foreground hover:bg-accent'}"
					onclick={() => mode !== m && onPick(m)}
				>
					{MODE_LABEL[m]}
				</button>
			{/each}
		</div>
		{#if canReset}
			<button type="button" {disabled} class="text-xs text-muted-foreground underline-offset-2 hover:underline" onclick={onReset}>Default</button>
		{/if}
	</div>
{/snippet}

{#snippet row(c: AgentConnector)}
	{@const Icon = connectorIcon(c.icon)}
	{@const busy = saving === c.connectionId}
	<li class="rounded-lg border border-border bg-card p-3">
		<div class="flex items-start gap-3">
			<span class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"><Icon class="size-4" /></span>
			<div class="min-w-0 flex-1">
				<div class="flex flex-wrap items-center gap-1.5">
					<span class="text-sm font-medium">{c.name}</span>
					<Badge variant={c.ownership === 'workspace' ? 'secondary' : 'brand'}>{scopeBadge(c)}</Badge>
					{#if c.status === 'needs-auth' || c.status === 'error'}<StatusBadge status={c.status} />{/if}
				</div>
				<p class="truncate text-xs text-muted-foreground">
					{c.label}{c.accountLabel ? ` · ${c.accountLabel}` : ''}{c.source === 'builtin' ? '' : ` · ${originLabel(c)}`}
				</p>
				{#if c.status === 'error' && c.statusMessage}<p class="mt-1 text-xs text-destructive-text">{c.statusMessage}</p>{/if}
				{#if c.status === 'needs-auth'}
					<Button
						size="sm"
						variant="outline"
						class="mt-2"
						onclick={() => {
							reconnectId = c.connectionId;
							reconnectOpen = true;
						}}
					>
						<ArrowClockwiseIcon class="size-3.5" /> Reconnect
					</Button>
				{/if}
			</div>
			<div class="flex shrink-0 flex-col items-end gap-1">
				<Switch
					size="sm"
					checked={c.enabled}
					disabled={busy}
					aria-label="{c.name} {c.label} on or off"
					onCheckedChange={(v) => v !== c.enabled && save(c, withEnabled(c, v))}
				/>
				{#if c.state !== 'inherit'}
					<button type="button" disabled={busy} class="text-xs text-muted-foreground underline-offset-2 hover:underline" onclick={() => save(c, null)}>Reset to default</button>
				{/if}
			</div>
		</div>

		{#if c.enabled}
			<ul class="mt-3 space-y-2 border-t border-border pt-3">
				{#each c.capabilities as cap (cap.id)}
					<li class="flex flex-wrap items-center justify-between gap-2">
						<div class="min-w-0">
							<p class="text-sm">{cap.title}</p>
							{#if cap.description}<p class="text-xs text-muted-foreground">{cap.description}</p>{/if}
							{#if cap.pinned && cap.mode === 'ask'}
								<p class="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"><LockIcon class="size-3" /> Always asks, even in Bypass mode</p>
							{/if}
						</div>
						{@render modeControl(
							`${cap.title}: ${MODE_LABEL[cap.mode]}`,
							cap.mode,
							busy,
							(m) => save(c, withCapabilityMode(c, cap.id, m)),
							cap.override !== undefined,
							() => save(c, withCapabilityMode(c, cap.id, null))
						)}
					</li>
				{/each}
			</ul>
			{#if c.capabilities.some((cap) => cap.toolModes.length)}
				<Collapsible.Root class="mt-3">
					<Collapsible.Trigger class="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
						<CaretDownIcon class="size-3 transition-transform group-data-[state=open]:rotate-180" /> Advanced · individual tools
					</Collapsible.Trigger>
					<Collapsible.Content>
						<ul class="mt-2 space-y-1.5">
							{#each c.capabilities as cap (cap.id)}
								{#each cap.toolModes as t (modeId(c, t.name))}
									<li class="flex flex-wrap items-center justify-between gap-2">
										<code class="font-mono text-xs">{t.name}</code>
										{@render modeControl(
											`${t.name}: ${MODE_LABEL[t.mode]}`,
											t.mode,
											busy,
											(m) => save(c, withToolMode(c, t.name, m)),
											t.override !== undefined,
											() => save(c, withToolMode(c, t.name, null))
										)}
									</li>
								{/each}
							{/each}
						</ul>
					</Collapsible.Content>
				</Collapsible.Root>
			{/if}
		{/if}
		{#if errors[c.connectionId]}<p class="mt-2 text-xs text-destructive-text" role="alert">{errors[c.connectionId]}</p>{/if}
	</li>
{/snippet}

<div class="space-y-4" class:text-sm={compact}>
	<div class="flex items-center justify-between gap-2">
		<p class="text-sm text-muted-foreground">What this agent can use, and how much it may do on its own.</p>
		<Button size="sm" variant="outline" onclick={() => (addOpen = true)}><PlusIcon class="size-3.5" /> Add connector</Button>
	</div>

	{#if loadError}
		<p class="text-sm text-destructive-text" role="alert">{loadError}</p>
	{:else if !loaded}
		<div class="flex items-center gap-2 text-sm text-muted-foreground"><Spinner class="size-4" /> Loading…</div>
	{:else}
		{#if groups.builtin.length}
			<section class="space-y-2">
				<h3 class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Built in</h3>
				<ul class="space-y-2">{#each groups.builtin as c (c.connectionId)}{@render row(c)}{/each}</ul>
			</section>
		{/if}
		<section class="space-y-2">
			<h3 class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Connected</h3>
			{#if groups.connected.length}
				<ul class="space-y-2">{#each groups.connected as c (c.connectionId)}{@render row(c)}{/each}</ul>
			{:else}
				<div class="rounded-lg border border-dashed border-border p-4 text-center">
					<p class="text-sm text-muted-foreground">No connected apps yet.</p>
					<Button size="sm" class="mt-2" onclick={() => (addOpen = true)}><PlusIcon class="size-3.5" /> Add connector</Button>
				</div>
			{/if}
		</section>
	{/if}
</div>

<AddConnectorDialog bind:open={addOpen} {agentId} connectors={list} onChange={(next) => (list = next)} onConnected={reload} />
<ConnectFlowDialog bind:open={reconnectOpen} connectionId={reconnectId} onDone={() => void reload()} />
