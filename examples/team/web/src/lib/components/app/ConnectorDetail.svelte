<script lang="ts">
	import type { Snippet } from 'svelte';
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOut';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import DotsThreeIcon from 'phosphor-svelte/lib/DotsThree';
	import LockIcon from 'phosphor-svelte/lib/Lock';
	import ShieldCheckIcon from 'phosphor-svelte/lib/ShieldCheck';
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
	import ModeControl from '#lib/components/app/config/ModeControl.svelte';
	import AccessControl from '#lib/components/app/AccessControl.svelte';
	import ConnectorIcon from '#lib/components/app/ConnectorIcon.svelte';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { connectionStatus, runTest, visibleStatusMessage, type TestOutcome } from '#lib/config/status.js';
	import { capabilitiesOf, categoryLabel, MODE_LABEL } from '#lib/connectors/core.js';
	import { connectorsStore } from '#lib/connectors/connectors.svelte.js';
	import { acceptedText, driftText, type ConnectionDrift } from '#lib/connectors/drift.js';
	import { authLabel, customState, hostOf, initialsOf, toolCount } from '#lib/connectors/custom.js';
	import { alwaysAsks, KIND_LABEL, KIND_VARIANT, modeOf, OAUTH_CLIENT_NEEDS_SETUP, splitMemory } from '#lib/connectors/view.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { copyText } from '#lib/clipboard.js';
	
	/** One connector in a wide dialog: what it can do, its connections, default permissions and actions. */
	let {
		open = $bindable(false),
		connectorId,
		connectionId = null
	}: {
		open?: boolean;
		connectorId: string | null;
		/** A custom connector: show this one connection as the connector it is (its own name and page). */
		connectionId?: string | null;
	} = $props();

	const store = connectorsStore.state;
	const connector = $derived(store.connectors.find((c) => c.id === connectorId));
	const single = $derived(connectionId ? store.connections.find((c) => c.id === connectionId) : undefined);
	const connections = $derived(single ? [single] : connector ? store.connections.filter((c) => c.definitionId === connector.id) : []);
	const isCustom = $derived(single?.custom === true);
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
		if (!(await copyText(uri))) return void toast.error('Could not copy');
		copied = true;
		setTimeout(() => (copied = false), 1500);
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
	/** Tools some chats keep off because the server changed them (known after a test). */
	let drifts = $state<Record<string, ConnectionDrift | undefined>>({});
	let accepting = $state<string | null>(null);
	async function test(c: Connection): Promise<void> {
		results[c.id] = { ok: false, busy: true };
		results[c.id] = await runTest(async () => {
			const r = await connectorsStore.test(c.id);
			drifts[c.id] = r.drift;
			return { ok: r.ok, message: r.message, tools: r.tools };
		});
	}
	async function acceptDefinitions(c: Connection): Promise<void> {
		accepting = c.id;
		try {
			toast.success(acceptedText(await connectorsStore.acceptDefinitions(c.id)));
			drifts[c.id] = undefined;
		} catch (err) {
			toast.error(message(err));
		} finally {
			accepting = null;
		}
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
			toast.success(c.custom ? 'Removed' : 'Disconnected');
			if (single) open = false;
		} catch (err) {
			toast.error(message(err));
		}
	}
</script>

{#snippet capRow(cap: Capability, trailing?: Snippet)}
	<li class="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
		<div class="min-w-0">
			<div class="flex items-center gap-2">
				<p class="text-sm font-medium">{cap.title}</p>
				<Badge variant={KIND_VARIANT[cap.kind]}>{KIND_LABEL[cap.kind]}</Badge>
			</div>
			{#if cap.description}<p class="mt-0.5 text-xs text-muted-foreground">{cap.description}</p>{/if}
		</div>
		{#if trailing}{@render trailing()}{/if}
	</li>
{/snippet}

{#snippet connectionCard(c: Connection, title?: string, badge?: string)}
	{@const caps = capabilitiesOf(connector, c)}
	{@const res = results[c.id]}
	<div class="flex flex-col rounded-xl border border-border">
		<div class="flex flex-wrap items-center gap-x-3 gap-y-2 p-3.5">
			<div class="min-w-0 flex-1">
				{#if renaming === c.id}
					<div class="flex items-center gap-2">
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
					</div>
				{:else}
					<div class="flex flex-wrap items-center gap-1.5">
						<span class="truncate text-sm font-medium">{title ?? c.label}</span>
						{#if badge}<Badge variant="brand">{badge}</Badge>{/if}
						{#if c.custom && customState(c) === 'needs-sign-in'}<StatusBadge status="needs-auth" label="Sign in needed" />{:else}<StatusBadge status={connectionStatus(c)} />{/if}
					</div>
					{#if c.accountLabel}<p class="mt-0.5 truncate text-xs text-muted-foreground">Signed in as {c.accountLabel}</p>{/if}
				{/if}
			</div>
			{#if !c.builtin && renaming !== c.id}
				<div class="flex shrink-0 items-center gap-1.5">
					{#if !(c.custom && c.status === 'needs-auth')}<TestButton busy={res?.busy} onclick={() => test(c)} label="Test connection" />{/if}
					{#if c.status === 'needs-auth' || c.status === 'error'}<Button size="sm" onclick={() => reconnect(c)}>{c.custom && c.status === 'needs-auth' ? 'Sign in' : 'Reconnect'}</Button>{/if}
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button {...props} variant="ghost" size="icon-sm" aria-label="More actions"><DotsThreeIcon class="size-5" weight="bold" /></Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end">
							<DropdownMenu.Item
								onSelect={() => {
									renaming = c.id;
									renameValue = c.label;
								}}>Rename</DropdownMenu.Item
							>
							{#if !c.custom || c.settings.authMode === 'oauth'}<DropdownMenu.Item onSelect={() => reconnect(c)}>{c.custom ? 'Sign in again' : 'Reconnect'}</DropdownMenu.Item>{/if}
							{#if c.custom}<DropdownMenu.Item onSelect={() => acceptDefinitions(c)}>Accept new definitions in all chats</DropdownMenu.Item>{/if}
							<DropdownMenu.Separator />
							<DropdownMenu.Item variant="destructive" onSelect={() => (confirmRemove = c)}>{c.custom ? 'Remove' : 'Disconnect'}</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</div>
			{/if}
		</div>

		{#if visibleStatusMessage(c.status, c.statusMessage, res)}<p class="px-3.5 pb-3 text-xs text-destructive-text" role="alert">{visibleStatusMessage(c.status, c.statusMessage, res)}</p>{/if}
		{#if res}<div class="px-3.5 pb-3"><TestResult result={res} /></div>{/if}
		{#if drifts[c.id]}
			<div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 pb-3">
				<p class="text-xs text-warning-text" role="status">{driftText(drifts[c.id]!)}. For safety they stay off in those chats until you accept the new definitions.</p>
				<Button size="sm" variant="outline" disabled={accepting === c.id} onclick={() => acceptDefinitions(c)}>Accept new definitions in all chats</Button>
			</div>
		{/if}

		{#if !c.builtin}<AccessControl connection={c} />{/if}

		{#if c.custom && caps.length === 0}
			<p class="border-t border-border px-3.5 py-3 text-xs text-muted-foreground">
				{c.status === 'needs-auth' ? 'Its tools appear after you sign in.' : 'No tools found yet. Test the connection to discover them.'}
			</p>
		{/if}
		{#if caps.length}
			<div class="border-t border-border px-3.5 pt-3 pb-1">
				<h4 class="text-xs font-medium tracking-wide text-muted-foreground uppercase">{c.builtin ? 'What it can do' : c.custom ? `Tools · ${toolCount(caps)} found · default permissions` : 'Default permissions'}</h4>
				<ul class="divide-y divide-border">
					{#each caps as cap (cap.id)}
						{@const mode = modeOf(c, cap)}
						{#snippet trailing()}
							<div class="flex flex-col items-start gap-1 sm:items-end">
								{#if c.builtin}
									<span class="text-xs text-muted-foreground">{MODE_LABEL[mode]}</span>
								{:else}
									<ModeControl {mode} label="{cap.title} permission" onPick={(m) => setMode(c, cap, m)} />
								{/if}
								{#if connector && alwaysAsks(connector, cap, mode)}
									<span class="flex items-center gap-1 text-[11px] text-muted-foreground"><LockIcon class="size-3" />Always asks, even in Bypass mode</span>
								{/if}
							</div>
						{/snippet}
						{@render capRow(cap, trailing)}
					{/each}
				</ul>
			</div>
			<Collapsible.Root class="px-3.5 pb-3">
				<Collapsible.Trigger class="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
					<CaretDownIcon class="size-3 transition-transform group-data-[state=open]:rotate-180" />Advanced · individual tools
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
	</div>
{/snippet}

{#snippet serverInfo(c: Connection)}
	{@const url = typeof c.settings.url === 'string' ? c.settings.url : ''}
	<section class="flex flex-col gap-2 rounded-xl border border-border p-3.5">
		<div class="flex items-center justify-between gap-3 text-sm"><span class="text-muted-foreground">Authentication</span><span>{authLabel(c)}</span></div>
		<div class="flex items-center gap-2">
			<code class="min-w-0 flex-1 rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs break-all" data-testid="server-url">{url}</code>
			<Button size="icon-sm" variant="outline" aria-label="Copy server URL" onclick={() => copyUri(url)}>
				{#if copied}<CheckIcon class="size-4" />{:else}<CopyIcon class="size-4" />{/if}
			</Button>
		</div>
	</section>
{/snippet}

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="flex max-h-[92svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
		{#if connector}
			<Dialog.Header class="gap-0 border-b border-border px-5 py-5 pr-12 sm:pr-14 sm:pl-6">
				<div class="flex flex-col gap-4 sm:flex-row sm:items-start">
					{#if single}
						<span aria-hidden="true" class="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-muted text-lg font-semibold text-muted-foreground">{initialsOf(single.label)}</span>
					{:else}
						<ConnectorIcon icon={connector.icon} size="lg" />
					{/if}
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2">
							<Dialog.Title class="text-lg font-semibold">{single ? single.label : connector.name}</Dialog.Title>
							{#if connector.builtin}<Badge variant="info">Included</Badge>{:else if single}<StatusBadge status={customState(single) === 'needs-sign-in' ? 'needs-auth' : connectionStatus(single)} label={customState(single) === 'needs-sign-in' ? 'Sign in needed' : undefined} />{:else if connections.length}<StatusBadge status="connected" />{/if}
						</div>
						{#if single}
							<p class="mt-0.5 text-xs text-muted-foreground">Custom connector · {hostOf(single) || 'remote MCP server'}</p>
						{:else}
						<p class="mt-0.5 text-xs text-muted-foreground">
							{connector.builtin ? 'Built in' : connector.source === 'custom' ? 'Your own server' : categoryLabel(connector.category)}
							{#if connector.auth.type !== 'none'}· Sign in with {connector.auth.type === 'oauth2' ? 'OAuth' : connector.auth.type === 'deviceCode' ? 'a device code' : 'an API key'}{/if}
						</p>
						{/if}
						<Dialog.Description class="mt-2 text-sm text-muted-foreground">{single ? 'Your own remote MCP server. Agents only use what you allow below.' : connector.description}</Dialog.Description>
						{#if !single && (connector.publisher || connector.homepage || connector.docsUrl)}
							<p class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="connector-links">
								{#if connector.publisher}<span>By {connector.publisher}</span>{/if}
								{#if connector.homepage}<a class="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline" href={connector.homepage} target="_blank" rel="noopener noreferrer">Website<ArrowSquareOutIcon class="size-3" /></a>{/if}
								{#if connector.docsUrl}<a class="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline" href={connector.docsUrl} target="_blank" rel="noopener noreferrer">Docs<ArrowSquareOutIcon class="size-3" /></a>{/if}
							</p>
						{/if}
					</div>
					{#if !connector.builtin && !needsSetup && !single}
						<Button class="shrink-0 sm:mt-0.5" onclick={startConnect}>
							{#if connections.length}<PlusIcon class="size-4" />Add account{:else}Connect{/if}
						</Button>
					{/if}
				</div>
			</Dialog.Header>

			<div class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-5 sm:px-6">
				{#if connector.builtin}
					{#if memory}
						<section class="flex flex-col gap-3">
							<h3 class="text-sm font-medium">Where memory lives</h3>
							{#each memory.workspace as c (c.id)}
								{@render connectionCard(c, 'Workspace memory, shared by the whole team', 'Whole team')}
							{/each}
							{#if memory.agents.length}
								<Collapsible.Root>
									<Collapsible.Trigger class="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
										<CaretDownIcon class="size-3.5 transition-transform group-data-[state=open]:rotate-180" />{memory.agents.length} agents have their own memory
									</Collapsible.Trigger>
									<Collapsible.Content class="mt-2 flex flex-col gap-3">
										{#each memory.agents as c (c.id)}
											{@render connectionCard(c, `${(c.scopeId && agentName(c.scopeId)) || 'Agent'}: its own memory`, 'Only this agent')}
										{/each}
									</Collapsible.Content>
								</Collapsible.Root>
							{/if}
						</section>
					{:else}
						<section class="flex flex-col gap-2">
							<h3 class="text-sm font-medium">What it can do</h3>
							<ul class="divide-y divide-border rounded-xl border border-border px-3.5">
								{#each connector.capabilities as cap (cap.id)}{@render capRow(cap)}{/each}
							</ul>
						</section>
					{/if}
					<p class="text-xs text-muted-foreground">Included with every workspace, nothing to connect. Turn it on or off per agent in the agent's Connectors tab.</p>
				{:else}
					{#if single}
						{@render serverInfo(single)}
						{@render connectionCard(single)}
					{:else if connections.length}
						<section class="flex flex-col gap-3">
							<h3 class="text-sm font-medium">Connections</h3>
							{#each connections as c (c.id)}{@render connectionCard(c)}{/each}
						</section>
					{:else if connector.capabilities.length}
						<section class="flex flex-col gap-2">
							<h3 class="text-sm font-medium">What it can do</h3>
							<ul class="divide-y divide-border rounded-xl border border-border px-3.5">
								{#each connector.capabilities as cap (cap.id)}{@render capRow(cap)}{/each}
							</ul>
						</section>
					{:else}
						<section class="flex flex-col gap-1 rounded-xl border border-dashed border-border px-4 py-4">
							<h3 class="text-sm font-medium">Tools appear after you connect</h3>
							<p class="text-sm text-muted-foreground">
								{connector.source === 'custom'
									? 'Enter the server URL and sign in. Its tools are discovered then, grouped into what it can read and what it can change, and you choose what is allowed.'
									: `Once connected, ${connector.name}'s capabilities are listed here, grouped into what it can read and what it can change.`}
							</p>
						</section>
					{/if}

					{#if needsSetup && connector.oauthClient}
						{@const oc = connector.oauthClient}
						<section class="flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-4">
							<div>
								<h3 class="text-sm font-medium">Set up the {connector.name} OAuth app</h3>
								<p class="mt-1 text-xs text-muted-foreground">Signing in with {connector.name} needs an OAuth app. Create one there and register this callback URL.</p>
							</div>
							<div class="flex items-center gap-2">
								<code class="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs break-all">{oc.redirectUri}</code>
								<Button size="icon-sm" variant="outline" aria-label="Copy callback URL" onclick={() => copyUri(oc.redirectUri)}>
									{#if copied}<CheckIcon class="size-4" />{:else}<CopyIcon class="size-4" />{/if}
								</Button>
							</div>
							{#if oc.envVars.length}
								<p class="text-xs text-muted-foreground">Or set <span class="font-mono">{oc.envVars.join(' and ')}</span> on the server.</p>
							{/if}
							<form class="grid gap-3 sm:grid-cols-2" onsubmit={saveClient}>
								<Field.Field>
									<Field.Label for="oc-id">Client ID</Field.Label>
									<Input id="oc-id" bind:value={clientId} autocomplete="off" />
								</Field.Field>
								<Field.Field>
									<Field.Label for="oc-secret">Client secret</Field.Label>
									<Input id="oc-secret" type="password" bind:value={clientSecret} autocomplete="off" />
								</Field.Field>
								<div class="flex flex-wrap gap-2 sm:col-span-2">
									<Button type="submit" size="sm" disabled={savingClient || !clientId.trim()}>{savingClient ? 'Saving…' : 'Save OAuth app'}</Button>
									<Button type="button" size="sm" variant="ghost" onclick={startConnect}>Use a personal access token instead</Button>
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

					<p class="flex items-start gap-2 text-xs text-muted-foreground">
						<ShieldCheckIcon class="mt-px size-4 shrink-0" />
						<span>Agents only use what you allow. Anything that writes or deletes asks first, even in Bypass mode. Credentials are stored encrypted and never shown again.</span>
					</p>
				{/if}
			</div>

			{#if !connector.builtin && !needsSetup && !single}
				<div class="flex items-center justify-between gap-3 border-t border-border bg-muted/30 px-5 py-3 sm:px-6">
					<!-- applies to the NEXT account connected here; existing accounts have their own switch above -->
					{#if connections.length === 0}
						<label class="flex items-center gap-2.5 text-sm">
							<Switch bind:checked={makeDefault} aria-label="Make it available to all agents once connected" />
							<span>Make it available to all agents <span class="text-muted-foreground">once connected</span></span>
						</label>
					{:else}
						<span class="text-xs text-muted-foreground">Each account above has its own Access setting.</span>
					{/if}
					<Button variant="ghost" onclick={() => (open = false)}>Close</Button>
				</div>
			{/if}
		{/if}
	</Dialog.Content>
</Dialog.Root>

<ConnectFlowDialog
	bind:open={flowOpen}
	definitionId={flowConnectionId ? undefined : connector?.id}
	connectionId={flowConnectionId}
	scope="workspace"
	label={flowLabel}
	signIn={isCustom}
	defaultEnabled={makeDefault}
	onDone={flowDone}
/>

<AlertDialog.Root open={confirmRemove !== null} onOpenChange={(o) => !o && (confirmRemove = null)}>
	<AlertDialog.Content elevation="floating">
		<AlertDialog.Header>
			<AlertDialog.Title>{confirmRemove?.custom ? 'Remove' : 'Disconnect'} {confirmRemove?.label}?</AlertDialog.Title>
			<AlertDialog.Description>{confirmRemove?.custom ? `Agents lose access to ${confirmRemove.label}, and its saved sign-in and headers are deleted. You can add it again later.` : `Agents lose access to ${connector?.name}. You can connect it again later.`}</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action variant="destructive" onclick={remove}>{confirmRemove?.custom ? 'Remove' : 'Disconnect'}</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
