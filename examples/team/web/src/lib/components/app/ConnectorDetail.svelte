<script lang="ts">
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import CopyIcon from 'phosphor-svelte/lib/Copy';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import { api } from '#lib/api/index.js';
	import type { Capability, CapabilityMode, Connection } from '#lib/api/index.js';
	import ConnectFlowDialog from '#lib/components/app/ConnectFlowDialog.svelte';
	import ConfigCard from '#lib/components/app/config/ConfigCard.svelte';
	import EnvNotice from '#lib/components/app/config/EnvNotice.svelte';
	import StatusBadge from '#lib/components/app/config/StatusBadge.svelte';
	import TestButton from '#lib/components/app/config/TestButton.svelte';
	import TestResult from '#lib/components/app/config/TestResult.svelte';
	import ConnectorIcon from '#lib/components/app/ConnectorIcon.svelte';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { connectionStatus, runTest, type TestOutcome } from '#lib/config/status.js';
	import { capabilitiesOf, categoryLabel, MODE_LABEL, MODES } from '#lib/connectors/core.js';
	import { connectorsStore } from '#lib/connectors/connectors.svelte.js';
	import { alwaysAsks, KIND_LABEL, KIND_VARIANT, modeOf, OAUTH_CLIENT_NEEDS_SETUP, scopeLabel, splitMemory } from '#lib/connectors/view.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { cn } from '#lib/utils.js';

	/** One connector in a side sheet: what it can do, its connections, default permissions and actions. */
	let { open = $bindable(false), connectorId }: { open?: boolean; connectorId: string | null } = $props();

	const store = connectorsStore.state;
	const connector = $derived(store.connectors.find((c) => c.id === connectorId));
	const connections = $derived(connector ? store.connections.filter((c) => c.definitionId === connector.id) : []);
	const agentName = (id: string): string | undefined => agentsStore.state.agents.find((a) => a.id === id)?.name;
	const memory = $derived(connector?.id === 'memory' ? splitMemory(connections) : null);
	const needsSetup = $derived(connector ? OAUTH_CLIENT_NEEDS_SETUP(connector) : false);
	const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

	// --- connect flow -------------------------------------------------------------------------
	let flowOpen = $state(false);
	let flowConnectionId = $state<string | undefined>(undefined);
	let flowLabel = $state<string | undefined>(undefined);
	let makeDefault = $state(false);

	function startConnect(): void {
		flowConnectionId = undefined;
		flowLabel = undefined;
		flowOpen = true;
	}
	function reconnect(c: Connection): void {
		flowConnectionId = c.id;
		flowLabel = c.label;
		flowOpen = true;
	}
	const flowDone = (): void => void connectorsStore.load();

	// --- oauth client -------------------------------------------------------------------------
	let clientId = $state('');
	let clientSecret = $state('');
	let savingClient = $state(false);
	let copied = $state(false);

	async function copyUri(uri: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(uri);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			toast.error('Could not copy');
		}
	}
	async function saveClient(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (!connector || !clientId.trim()) return;
		savingClient = true;
		try {
			await connectorsStore.saveOAuthClient(connector.id, clientId.trim(), clientSecret.trim() || undefined);
			clientId = '';
			clientSecret = '';
			toast.success('OAuth app saved');
		} catch (err) {
			toast.error(message(err));
		} finally {
			savingClient = false;
		}
	}
	async function removeClient(): Promise<void> {
		if (!connector) return;
		try {
			await api.delete('/connectors/{id}/oauth-client', { params: { id: connector.id } });
			await connectorsStore.load();
			toast.success('OAuth app removed');
		} catch (err) {
			toast.error(message(err));
		}
	}

	// --- connection actions -------------------------------------------------------------------
	let results = $state<Record<string, TestOutcome>>({});
	async function test(c: Connection): Promise<void> {
		results[c.id] = { ok: false, busy: true };
		results[c.id] = await runTest(async () => {
			const r = await connectorsStore.test(c.id);
			return { ok: r.ok, message: r.message, tools: r.tools };
		});
	}

	let renaming = $state<string | null>(null);
	let renameValue = $state('');
	async function rename(c: Connection): Promise<void> {
		const label = renameValue.trim();
		renaming = null;
		if (!label || label === c.label) return;
		try {
			await connectorsStore.update(c.id, { label });
		} catch (err) {
			toast.error(message(err));
		}
	}

	async function setDefaultEnabled(c: Connection, on: boolean): Promise<void> {
		try {
			await connectorsStore.update(c.id, { defaultEnabled: on });
		} catch (err) {
			toast.error(message(err));
		}
	}

	async function setMode(c: Connection, cap: Capability, mode: CapabilityMode): Promise<void> {
		const next = Object.fromEntries(capabilitiesOf(connector, c).map((k) => [k.id, modeOf(c, k)])) as Record<string, CapabilityMode>;
		next[cap.id] = mode;
		try {
			await connectorsStore.update(c.id, { defaultModes: next });
		} catch (err) {
			toast.error(message(err));
		}
	}

	let confirmRemove = $state<Connection | null>(null);
	async function remove(): Promise<void> {
		const c = confirmRemove;
		confirmRemove = null;
		if (!c) return;
		try {
			await connectorsStore.remove(c.id);
			toast.success('Disconnected');
		} catch (err) {
			toast.error(message(err));
		}
	}
</script>

{#snippet capList(caps: Capability[])}
	<ul class="flex flex-col gap-2">
		{#each caps as cap (cap.id)}
			<li class="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2">
				<div class="min-w-0">
					<p class="text-sm font-medium">{cap.title}</p>
					{#if cap.description}<p class="text-xs text-muted-foreground">{cap.description}</p>{/if}
				</div>
				<Badge variant={KIND_VARIANT[cap.kind]}>{KIND_LABEL[cap.kind]}</Badge>
			</li>
		{/each}
	</ul>
{/snippet}

{#snippet connectionCard(c: Connection, title?: string, badge?: string)}
	{@const caps = capabilitiesOf(connector, c)}
	{@const res = results[c.id]}
	<ConfigCard class="gap-3 shadow-none">
		{#snippet title()}
			{#if renaming === c.id}
				<Input
					class="h-8 max-w-56"
					bind:value={renameValue}
					aria-label="Connection name"
					onkeydown={(e) => {
						if (e.key === 'Enter') void rename(c);
						if (e.key === 'Escape') renaming = null;
					}}
				/>
				<Button size="sm" onclick={() => rename(c)}>Save</Button>
				<Button size="sm" variant="ghost" onclick={() => (renaming = null)}>Cancel</Button>
			{:else}
				{title ?? c.label}
			{/if}
		{/snippet}
		{#snippet badges()}
			{#if badge}<Badge variant="brand">{badge}</Badge>{/if}
			<StatusBadge status={connectionStatus(c)} />
			{#if !c.builtin}<Badge variant="outline">{scopeLabel(c, agentName)}</Badge>{/if}
		{/snippet}
		{#snippet subtitle()}{#if c.accountLabel}Signed in as {c.accountLabel}{/if}{/snippet}
		{#if c.statusMessage && c.status !== 'connected'}<p class="text-xs text-destructive-text" role="alert">{c.statusMessage}</p>{/if}

		{#if c.scope === 'workspace' && !c.builtin}
			<label class="flex items-center justify-between gap-3 text-sm">
				<span>Available to all agents</span>
				<Switch checked={c.defaultEnabled} onCheckedChange={(v) => setDefaultEnabled(c, v)} aria-label="Available to all agents" />
			</label>
		{/if}

		{#if caps.length}
			<div class="flex flex-col gap-1.5">
				<h4 class="text-[13px] font-medium">Default permissions</h4>
				{#each caps as cap (cap.id)}
					{@const mode = modeOf(c, cap)}
					<div class="flex flex-col gap-1">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<span class="text-sm">{cap.title}</span>
							<div class="inline-flex rounded-lg border border-border bg-muted p-0.5" role="radiogroup" aria-label="{cap.title} permission">
								{#each MODES as m (m)}
									<button
										type="button"
										role="radio"
										aria-checked={mode === m}
										disabled={c.builtin}
										onclick={() => setMode(c, cap, m)}
										class={cn(
											'h-7 rounded-md px-2.5 text-xs font-medium transition-colors outline-none focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60',
											mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
										)}>{MODE_LABEL[m]}</button
									>
								{/each}
							</div>
						</div>
						{#if connector && alwaysAsks(connector, cap, mode)}
							<p class="text-xs text-muted-foreground">Always asks, even in Bypass mode</p>
						{/if}
					</div>
				{/each}
			</div>

			<Collapsible.Root>
				<Collapsible.Trigger class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
					<CaretDownIcon class="size-3" />Advanced
				</Collapsible.Trigger>
				<Collapsible.Content>
					<ul class="mt-2 flex flex-col gap-1.5">
						{#each caps as cap (cap.id)}
							<li class="text-xs">
								<span class="font-medium">{cap.title}</span>
								<p class="font-mono text-[11px] break-words text-muted-foreground">{cap.tools.join(', ') || 'no tools'}</p>
							</li>
						{/each}
					</ul>
				</Collapsible.Content>
			</Collapsible.Root>
		{/if}

		<TestResult result={res} />

		{#if !c.builtin}
			<div class="flex flex-wrap gap-2">
				<TestButton busy={res?.busy} onclick={() => test(c)} />
				<Button
					size="sm"
					variant="outline"
					onclick={() => {
						renaming = c.id;
						renameValue = c.label;
					}}>Rename</Button
				>
				<Button size="sm" variant={c.status === 'needs-auth' ? 'default' : 'outline'} onclick={() => reconnect(c)}>Reconnect</Button>
				<Button size="sm" variant="ghost" class="text-destructive-text" onclick={() => (confirmRemove = c)}>Disconnect</Button>
			</div>
		{/if}
	</ConfigCard>
{/snippet}

<Sheet.Root bind:open>
	<Sheet.Content class="w-full gap-0 overflow-y-auto sm:max-w-lg">
		{#if connector}
			<Sheet.Header class="border-b border-border">
				<div class="flex items-center gap-3">
					<ConnectorIcon icon={connector.icon} />
					<div class="min-w-0">
						<Sheet.Title>{connector.name}</Sheet.Title>
						<div class="mt-1 flex gap-1.5">
							<Badge variant="secondary">{categoryLabel(connector.category)}</Badge>
							{#if connector.builtin}<Badge variant="info">Included</Badge>{/if}
						</div>
					</div>
				</div>
				<Sheet.Description class="pt-2">{connector.description}</Sheet.Description>
			</Sheet.Header>

			<div class="flex flex-col gap-6 p-4">
				<section class="flex flex-col gap-2">
					<h3 class="text-sm font-medium">What it can do</h3>
					{@render capList(connector.capabilities)}
				</section>

				{#if connector.builtin}
					<p class="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">Included, nothing to connect.</p>
					{#if memory}
						<section class="flex flex-col gap-2">
							<h3 class="text-sm font-medium">Where memory lives</h3>
							{#each memory.workspace as c (c.id)}
								{@render connectionCard(c, 'Workspace memory — shared by the whole team', 'Whole team')}
							{/each}
							{#if memory.agents.length}
								<Collapsible.Root>
									<Collapsible.Trigger class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
										<CaretDownIcon class="size-3.5" />{memory.agents.length} agents have their own memory
									</Collapsible.Trigger>
									<Collapsible.Content class="mt-2 flex flex-col gap-2">
										{#each memory.agents as c (c.id)}
											{@render connectionCard(c, `This agent's memory — only this agent (${(c.scopeId && agentName(c.scopeId)) || 'agent'})`, 'Only this agent')}
										{/each}
									</Collapsible.Content>
								</Collapsible.Root>
							{/if}
						</section>
					{:else if connections.length}
						<section class="flex flex-col gap-2">
							{#each connections as c (c.id)}{@render connectionCard(c)}{/each}
						</section>
					{/if}
				{:else}
					{#if connections.length}
						<section class="flex flex-col gap-2">
							<h3 class="text-sm font-medium">Connections</h3>
							{#each connections as c (c.id)}{@render connectionCard(c)}{/each}
						</section>
					{/if}

					{#if needsSetup && connector.oauthClient}
						{@const oc = connector.oauthClient}
						<section class="flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-3">
							<h3 class="text-sm font-medium">Set up the {connector.name} OAuth app</h3>
							<p class="text-xs text-muted-foreground">
								Signing in with {connector.name} needs an OAuth app. Create one there and register this callback URL.
							</p>
							<div class="flex items-center gap-2">
								<code class="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs break-all">{oc.redirectUri}</code>
								<Button size="icon-sm" variant="outline" aria-label="Copy callback URL" onclick={() => copyUri(oc.redirectUri)}>
									{#if copied}<CheckIcon class="size-4" />{:else}<CopyIcon class="size-4" />{/if}
								</Button>
							</div>
							{#if oc.envVars.length}
								<p class="text-xs text-muted-foreground">
									Or set <span class="font-mono">{oc.envVars.join(' and ')}</span> on the server.
								</p>
							{/if}
							<form class="flex flex-col gap-2" onsubmit={saveClient}>
								<Field.Field>
									<Field.Label for="oc-id">Client ID</Field.Label>
									<Input id="oc-id" bind:value={clientId} autocomplete="off" />
								</Field.Field>
								<Field.Field>
									<Field.Label for="oc-secret">Client secret</Field.Label>
									<Input id="oc-secret" type="password" bind:value={clientSecret} autocomplete="off" />
								</Field.Field>
								<div class="flex flex-wrap gap-2">
									<Button type="submit" size="sm" disabled={savingClient || !clientId.trim()}>{savingClient ? 'Saving…' : 'Save OAuth app'}</Button>
									<Button type="button" size="sm" variant="outline" onclick={startConnect}>Use a personal access token instead</Button>
								</div>
							</form>
						</section>
					{:else if connector.oauthClient?.required && connector.oauthClient.configured}
						{#if connector.oauthClient.source === 'stored'}
							<p class="flex items-center gap-2 text-xs text-muted-foreground">
								OAuth app configured.
								<button type="button" class="underline underline-offset-2 hover:text-foreground" onclick={removeClient}>Remove</button>
							</p>
						{:else}
							<EnvNotice vars={connector.oauthClient.envVars} hint="Change it there." />
						{/if}
					{/if}

					<section class="flex flex-col gap-3">
						<label class="flex items-center justify-between gap-3 text-sm">
							<span>Make available to all agents</span>
							<Switch bind:checked={makeDefault} aria-label="Make available to all agents" />
						</label>
						{#if !needsSetup}
							<Button onclick={startConnect}>
								<PlusIcon class="size-4" />{connections.length ? 'Add another' : 'Connect'}
							</Button>
						{/if}
					</section>
				{/if}
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>

<ConnectFlowDialog
	bind:open={flowOpen}
	definitionId={flowConnectionId ? undefined : connector?.id}
	connectionId={flowConnectionId}
	scope="workspace"
	label={flowLabel}
	defaultEnabled={makeDefault}
	onDone={flowDone}
/>

<AlertDialog.Root open={confirmRemove !== null} onOpenChange={(o) => !o && (confirmRemove = null)}>
	<AlertDialog.Content elevation="floating">
		<AlertDialog.Header>
			<AlertDialog.Title>Disconnect {confirmRemove?.label}?</AlertDialog.Title>
			<AlertDialog.Description>Agents lose access to {connector?.name}. You can connect it again later.</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action variant="destructive" onclick={remove}>Disconnect</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
