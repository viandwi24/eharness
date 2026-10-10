<script lang="ts">
	import type { AgentConnector } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { connectorsStore } from '#lib/connectors/connectors.svelte.js';
	import { availableToAdd, withEnabled } from '#lib/connectors/agent-view.js';
		import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import { accountName, usageText } from '#lib/connectors/access.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import ConnectorIcon from './ConnectorIcon.svelte';
	import { Input } from '#lib/components/ui/input/index.js';
	import ConnectFlowDialog from './ConnectFlowDialog.svelte';
	import AddCustomConnectorDialog from './AddCustomConnectorDialog.svelte';

	let {
		open = $bindable(false),
		agentId,
		connectors,
		onChange,
		onConnected
	}: {
		open?: boolean;
		agentId: string;
		/** The agent's current view. */
		connectors: AgentConnector[];
		/** The server's new view after enabling a connection. */
		onChange: (next: AgentConnector[]) => void;
		/** A new connection was created for this agent. */
		onConnected: () => void;
	} = $props();

	let query = $state('');
	const q = $derived(query.trim().toLowerCase());
	let busy = $state<string | null>(null);
	let error = $state('');
	let flowOpen = $state(false);
	let flowDefinition = $state<string | undefined>(undefined);

	const matching = $derived(availableToAdd(connectors).filter((c) => !q || `${c.name} ${c.label}`.toLowerCase().includes(q)));
	const available = $derived(matching.filter((c) => c.source !== 'builtin'));
	const builtinOff = $derived(matching.filter((c) => c.source === 'builtin'));
	const connectable = $derived(connectorsStore.state.connectors.filter((c) => !c.builtin && c.source !== 'custom' && c.scopes.includes('agent') && (!q || `${c.name} ${c.description}`.toLowerCase().includes(q))));

	/** "GitHub · work" and who uses it: "used by Writer". */
	const accountOf = (c: AgentConnector) => connectorsStore.state.connections.find((x) => x.id === c.connectionId);
	const titleOf = (c: AgentConnector): string => {
		const conn = accountOf(c);
		return conn ? accountName(conn, c.source === 'custom' ? undefined : c.name) : c.name;
	};
	const usedBy = (c: AgentConnector): string => {
		const conn = accountOf(c);
		if (!conn) return '';
		const text = usageText(conn, agentsStore.state.agents);
		return text === 'Not used by any agent yet' ? text : text.startsWith('All agents') ? text : `used by ${text}`;
	};

	async function add(c: AgentConnector): Promise<void> {
		busy = c.connectionId;
		error = '';
		try {
			onChange(await connectorsStore.setAgentConnectors(agentId, { [c.connectionId]: withEnabled(c, true) }));
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not add it';
		} finally {
			busy = null;
		}
	}

	let customOpen = $state(false);
	let signInFlow = $state<string | undefined>(undefined);
	let signInOpen = $state(false);

	function connect(definitionId: string): void {
		flowDefinition = definitionId;
		flowOpen = true;
	}
</script>

<Dialog.Root bind:open onOpenChange={(o) => o && (query = '')}>
	<Dialog.Content elevation="floating" class="flex max-h-[85svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
		<Dialog.Header class="gap-1 border-b border-border px-5 py-4 pr-12">
			<Dialog.Title>Add connector</Dialog.Title>
			<Dialog.Description>Add an account you already registered, or connect another one.</Dialog.Description>
			<div class="relative mt-2">
				<MagnifyingGlassIcon class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input bind:value={query} placeholder="Search connectors" aria-label="Search connectors" class="pl-8" />
			</div>
		</Dialog.Header>
		<div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
			<section class="space-y-2">
				<h3 class="text-xs font-medium text-muted-foreground">Registered accounts</h3>
				{#if available.length}
					<ul class="space-y-1.5">
						{#each available as c (c.connectionId)}
							<li class="flex items-center gap-3 rounded-xl border border-border p-2.5">
								<ConnectorIcon icon={c.icon} size="sm" />
								<div class="min-w-0 flex-1">
									<p class="truncate text-sm font-medium">{titleOf(c)}</p>
									<p class="truncate text-xs text-muted-foreground">{[c.status === 'needs-auth' ? 'Sign in needed' : '', usedBy(c)].filter(Boolean).join(' · ')}</p>
								</div>
								<Button size="sm" variant="outline" disabled={busy === c.connectionId} onclick={() => add(c)}>Add</Button>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-muted-foreground">{q ? 'No match in your workspace.' : 'Every registered account is already on for this agent.'}</p>
				{/if}
			</section>

			{#if builtinOff.length}
				<section class="space-y-2">
					<h3 class="text-xs font-medium text-muted-foreground">Built in</h3>
					<ul class="space-y-1.5">
						{#each builtinOff as c (c.connectionId)}
							<li class="flex items-center gap-3 rounded-xl border border-border p-2.5">
								<ConnectorIcon icon={c.icon} size="sm" />
								<div class="min-w-0 flex-1">
									<p class="truncate text-sm font-medium">{c.name}</p>
									<p class="truncate text-xs text-muted-foreground">Built in</p>
								</div>
								<Button size="sm" variant="outline" disabled={busy === c.connectionId} onclick={() => add(c)}>Add</Button>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			<section class="space-y-2">
				<h3 class="text-xs font-medium text-muted-foreground">Connect another account</h3>
				{#if connectable.length}
					<ul class="space-y-1.5">
						{#each connectable as c (c.id)}
							{@const blocked = c.oauthClient?.required && !c.oauthClient.configured}
							<li class="flex items-center gap-3 rounded-xl border border-border p-2.5">
								<ConnectorIcon icon={c.icon} size="sm" />
								<div class="min-w-0 flex-1">
									<p class="truncate text-sm font-medium">{c.name}</p>
									<p class="truncate text-xs text-muted-foreground">{blocked ? 'An admin sets it up on the Connectors page first' : `New account for this agent only`}</p>
								</div>
								<Button size="sm" variant="outline" disabled={blocked} onclick={() => connect(c.id)}>Connect</Button>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-muted-foreground">{q ? 'Nothing matches your search.' : 'No connectors can be added to a single agent.'}</p>
				{/if}
				<Button size="sm" variant="outline" onclick={() => (customOpen = true)}>Add custom connector</Button>
			</section>
			{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
		</div>
		<Dialog.Footer class="items-center justify-between border-t border-border px-5 py-3 sm:justify-between">
			<a href="/connectors" class="text-sm text-muted-foreground underline-offset-2 hover:underline">Browse all connectors</a>
			<Button type="button" variant="ghost" onclick={() => (open = false)}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConnectFlowDialog
	bind:open={flowOpen}
	definitionId={flowDefinition}
	scope="agent"
	scopeId={agentId}
	onDone={() => {
		open = false;
		onConnected();
	}}
/>

<AddCustomConnectorDialog
	bind:open={customOpen}
	{agentId}
	onAdded={(_c, flow) => {
		open = false;
		onConnected();
		if (flow) {
			signInFlow = flow.id;
			signInOpen = true;
		}
	}}
/>
<ConnectFlowDialog bind:open={signInOpen} flowId={signInFlow} onDone={onConnected} />
