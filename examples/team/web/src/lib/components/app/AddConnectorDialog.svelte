<script lang="ts">
	import type { AgentConnector } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { connectorsStore } from '#lib/connectors/connectors.svelte.js';
	import { availableToAdd, originLabel, withEnabled } from '#lib/connectors/agent-view.js';
	import { connectorIcon } from '#lib/connectors/icons.js';
	import ConnectFlowDialog from './ConnectFlowDialog.svelte';

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

	let busy = $state<string | null>(null);
	let error = $state('');
	let flowOpen = $state(false);
	let flowDefinition = $state<string | undefined>(undefined);

	const available = $derived(availableToAdd(connectors));
	const connectable = $derived(connectorsStore.state.connectors.filter((c) => !c.builtin && c.scopes.includes('agent')));

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

	function connect(definitionId: string): void {
		flowDefinition = definitionId;
		flowOpen = true;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[85svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>Add connector</Dialog.Title>
			<Dialog.Description>Use a connection from your workspace, or connect a new one for this agent only.</Dialog.Description>
		</Dialog.Header>
		<div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
			<section class="space-y-2">
				<h3 class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Available from your workspace</h3>
				{#if available.length}
					<ul class="space-y-2">
						{#each available as c (c.connectionId)}
							{@const Icon = connectorIcon(c.icon)}
							<li class="flex items-center gap-3 rounded-lg border border-border p-2.5">
								<span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"><Icon class="size-4" /></span>
								<div class="min-w-0 flex-1">
									<p class="truncate text-sm font-medium">{c.name}</p>
									<p class="truncate text-xs text-muted-foreground">{c.label}</p>
								</div>
								<Badge variant="secondary">{originLabel(c)}</Badge>
								<Button size="sm" variant="outline" disabled={busy === c.connectionId} onclick={() => add(c)}>Add</Button>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-muted-foreground">Everything in your workspace is already on for this agent.</p>
				{/if}
			</section>

			<section class="space-y-2">
				<h3 class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Connect a new one for this agent</h3>
				{#if connectable.length}
					<ul class="grid gap-2 sm:grid-cols-2">
						{#each connectable as c (c.id)}
							{@const Icon = connectorIcon(c.icon)}
							<li>
								<button type="button" class="flex w-full items-start gap-3 rounded-lg border border-border p-2.5 text-left transition-colors hover:bg-accent" onclick={() => connect(c.id)}>
									<span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"><Icon class="size-4" /></span>
									<span class="min-w-0">
										<span class="block truncate text-sm font-medium">{c.name}</span>
										<span class="line-clamp-2 text-xs text-muted-foreground">{c.description}</span>
										{#if c.oauthClient?.required && !c.oauthClient.configured}
											<span class="mt-1 block text-xs text-muted-foreground">Ask an admin to set it up on the Connectors page</span>
										{/if}
									</span>
								</button>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-muted-foreground">No connectors can be added to a single agent.</p>
				{/if}
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
