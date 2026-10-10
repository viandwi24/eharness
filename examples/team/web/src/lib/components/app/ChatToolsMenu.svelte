<script lang="ts">
	import { untrack } from 'svelte';
	import GlobeIcon from 'phosphor-svelte/lib/Globe';
	import PlugsConnectedIcon from 'phosphor-svelte/lib/PlugsConnected';
	import { toast } from 'svelte-sonner';
	import { api } from '#lib/api/index.js';
	import ConnectorIcon from '#lib/components/app/ConnectorIcon.svelte';
	import ToolAccessControl from '#lib/components/app/ToolAccessControl.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { applySwitch, menuRows, offBadge, subtitle, withSwitch, type ChatToolConnector, type ChatTools } from '#lib/chat/tools.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openEditAgent } from '#lib/stores/dialogs.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';

	/**
	 * The connectors of this chat (Claude-style): the agent's enabled connectors with a switch each.
	 * A switch applies to THIS chat only; the tools of a switched-off connector are not offered to the
	 * model from the next step on. Pinned asks and permissions do not change.
	 */
	let { agentId }: { agentId: string } = $props();

	let tools = $state<ChatTools | undefined>(undefined);
	let open = $state(false);
	let error = $state('');
	let busy = $state(false);

	async function load(): Promise<void> {
		try {
			tools = await api.get('/agents/{id}/chat/tools', { params: { id: agentId } });
			error = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load the connectors';
		}
	}

	$effect(() => {
		void agentId;
		void live.state.revs.connectors; // a connection or an enablement changed
		untrack(() => void load());
	});

	const rows = $derived(tools ? menuRows(tools) : { web: [], others: [] });
	const badge = $derived(offBadge(tools));

	async function flip(c: ChatToolConnector, on: boolean): Promise<void> {
		if (!tools || busy) return;
		const before = tools;
		const off = withSwitch(before, c.connectionId, on);
		tools = applySwitch(before, c.connectionId, on); // optimistic
		busy = true;
		try {
			tools = await api.put('/agents/{id}/chat/tools', { params: { id: agentId }, body: { off } });
		} catch (e) {
			tools = before;
			toast.error(e instanceof Error ? e.message : 'Could not change the connectors of this chat');
		} finally {
			busy = false;
		}
	}

	function manage(): void {
		open = false;
		openEditAgent(agentsStore.find(agentId)?.id ?? agentId, 'connectors');
	}
</script>

{#snippet row(c: ChatToolConnector)}
	{@const sub = subtitle(c)}
	{@const usable = c.status === 'connected'}
	<li class="flex items-center gap-3 px-3 py-2" data-testid="chat-tool-row" data-connector={c.connectorId} data-on={c.on}>
		{#if c.connectorId === 'web'}
			<span aria-hidden="true" class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/12 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300"><GlobeIcon class="size-4" /></span>
		{:else}
			<ConnectorIcon icon={c.icon} size="sm" />
		{/if}
		<div class="min-w-0 flex-1">
			<p class="truncate text-sm font-medium">{c.connectorId === 'web' ? 'Web search' : c.name}</p>
			<p class="truncate text-xs {usable ? 'text-muted-foreground' : 'text-warning-text'}">
				{#if c.connectorId === 'web'}Search the web and read pages{:else if sub}{sub}{:else}{c.tools} {c.tools === 1 ? 'tool' : 'tools'}{/if}
			</p>
		</div>
		<Switch size="sm" checked={c.on && usable} disabled={!usable || busy} onCheckedChange={(v) => void flip(c, v)} aria-label="{c.on ? 'Turn off' : 'Turn on'} {c.name} in this chat" />
	</li>
{/snippet}

{#if tools}
	<Popover.Root bind:open>
		<Popover.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					type="button"
					class="relative inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-muted data-[state=open]:text-foreground"
					aria-label={badge ? `Connectors in this chat, ${badge} off` : 'Connectors in this chat'}
					title="Connectors in this chat"
					data-testid="chat-tools-button"
				>
					<PlugsConnectedIcon class="size-4" />
					{#if badge}
						<span class="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning-soft px-1 text-[10px] leading-none font-semibold text-warning-text tabular-nums" data-testid="chat-tools-badge">{badge}</span>
					{/if}
				</button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content elevation="floating" side="top" align="start" collisionPadding={12} class="w-[min(22rem,calc(100vw-2rem))] gap-0 p-0" data-testid="chat-tools-menu">
			<div class="border-b border-border px-3 py-2.5">
				<p class="text-sm font-medium">Connectors</p>
				<p class="text-xs text-muted-foreground">Choose what this chat can use. It applies to this chat only.</p>
			</div>
			{#if rows.web.length + rows.others.length === 0}
				<p class="px-3 py-5 text-center text-sm text-muted-foreground">No connectors are enabled for this agent yet.</p>
			{:else}
				<ul class="max-h-[min(20rem,50svh)] divide-y divide-border overflow-y-auto">
					{#each rows.web as c (c.connectionId)}{@render row(c)}{/each}
					{#each rows.others as c (c.connectionId)}{@render row(c)}{/each}
				</ul>
			{/if}
			<ToolAccessControl {agentId} variant="menu" />
			<div class="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
				<span class="text-xs text-muted-foreground">{tools.offCount > 0 ? `${tools.offCount} off in this chat` : 'All on'}</span>
				<Button type="button" variant="ghost" size="xs" onclick={manage}>Manage connectors</Button>
			</div>
		</Popover.Content>
	</Popover.Root>
{:else if error}
	<span class="sr-only" role="status">{error}</span>
{/if}
