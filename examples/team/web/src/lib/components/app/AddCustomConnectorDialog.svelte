<script lang="ts">
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import { api } from '#lib/api/index.js';
	import type { ConnectFlow, Connection, CustomProbe } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import {
		badHeaderNames,
		canAdd,
		createBody,
		defaultSignIn,
		detectionText,
		needsOwnClient,
		SIGN_IN_OPTIONS,
		validateDetails,
		type HeaderRow,
		type SignIn
	} from '#lib/connectors/custom.js';
	import { cn } from '#lib/utils.js';

	/**
	 * "Add custom connector", like Claude: name + remote MCP server URL, then a review of how the
	 * server wants to sign in (the server probes it), an optional OAuth client, request headers, Add.
	 * The result is a new connector with its own name. With `agentId` it belongs to that agent only.
	 */
	let {
		open = $bindable(false),
		agentId,
		onAdded
	}: {
		open?: boolean;
		agentId?: string;
		/** The connector was added; `flow` is the OAuth flow to open when "Sign in now" was chosen. */
		onAdded: (connection: Connection, flow?: ConnectFlow) => void;
	} = $props();

	let step = $state<'details' | 'review'>('details');
	let name = $state('');
	let url = $state('');
	let touched = $state(false);
	let probing = $state(false);
	let probe = $state<CustomProbe | null>(null);
	let signIn = $state<SignIn>('none');
	let clientId = $state('');
	let clientSecret = $state('');
	let headers = $state<HeaderRow[]>([]);
	let availableToAll = $state(false);
	let adding = $state(false);
	let error = $state('');

	const errors = $derived(validateDetails(name, url));
	const bad = $derived(badHeaderNames(headers));
	const form = $derived({ name, url, signIn, clientId, clientSecret, headers, availableToAll });
	const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

	// a fresh form every time the dialog opens
	$effect(() => {
		if (open) {
			step = 'details';
			name = '';
			url = '';
			touched = false;
			probe = null;
			probing = false;
			signIn = 'none';
			clientId = '';
			clientSecret = '';
			headers = [];
			availableToAll = false;
			adding = false;
			error = '';
		}
	});

	async function next(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		touched = true;
		error = '';
		if (Object.keys(errors).length) return;
		probing = true;
		try {
			probe = await api.post('/connectors/custom/probe', { body: { url: url.trim() } });
			signIn = defaultSignIn(probe);
			step = 'review';
		} catch (err) {
			error = message(err);
		} finally {
			probing = false;
		}
	}

	async function add(): Promise<void> {
		if (!canAdd(form) || adding) return;
		adding = true;
		error = '';
		try {
			const res = await api.post('/connectors/custom', { body: createBody(form, agentId) });
			open = false;
			onAdded(res.connection, res.flow as ConnectFlow | undefined);
		} catch (err) {
			error = message(err);
		} finally {
			adding = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="flex max-h-[92svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
		<Dialog.Header class="gap-1 border-b border-border px-5 py-4 pr-12">
			<Dialog.Title>Add custom connector</Dialog.Title>
			<Dialog.Description>
				{step === 'details' ? 'Connect your agents to a remote MCP server. Only add servers you trust.' : 'Check how it signs in, then add it.'}
			</Dialog.Description>
		</Dialog.Header>

		{#if step === 'details'}
			<form class="flex min-h-0 flex-1 flex-col" onsubmit={next} novalidate>
				<div class="flex flex-col gap-4 overflow-y-auto px-5 py-4">
					<Field.Field>
						<Field.Label for="cc-name">Name</Field.Label>
						<Input id="cc-name" bind:value={name} placeholder="Company docs" autocomplete="off" aria-invalid={touched && !!errors.name} />
						{#if touched && errors.name}<p class="text-xs text-destructive-text" role="alert">{errors.name}</p>{/if}
					</Field.Field>
					<Field.Field>
						<Field.Label for="cc-url">Remote MCP server URL</Field.Label>
						<Input id="cc-url" bind:value={url} placeholder="https://mcp.example.com/mcp" autocomplete="off" inputmode="url" aria-invalid={touched && !!errors.url} />
						{#if touched && errors.url}<p class="text-xs text-destructive-text" role="alert">{errors.url}</p>{/if}
					</Field.Field>
					{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
				</div>
				<Dialog.Footer class="border-t border-border px-5 py-3">
					<Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
					<Button type="submit" disabled={probing}>
						{#if probing}<Spinner class="size-4" />Checking the server…{:else}Continue{/if}
					</Button>
				</Dialog.Footer>
			</form>
		{:else}
			<div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
				<div class="rounded-xl bg-muted/50 px-3.5 py-2.5">
					<p class="text-sm font-medium">{name.trim()}</p>
					<p class="truncate font-mono text-xs text-muted-foreground">{url.trim()}</p>
					<p class="mt-1.5 text-xs text-muted-foreground" role="status">{detectionText(probe)}</p>
				</div>

				<section class="flex flex-col gap-2">
					<h3 class="text-sm font-medium">Authentication</h3>
					<div class="flex flex-col gap-1.5" role="radiogroup" aria-label="Authentication">
						{#each SIGN_IN_OPTIONS as o (o.value)}
							<button
								type="button"
								role="radio"
								aria-checked={signIn === o.value}
								onclick={() => (signIn = o.value)}
								class={cn(
									'flex items-start gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors outline-none focus-visible:outline-2 focus-visible:outline-ring',
									signIn === o.value ? 'border-foreground/40 bg-accent/50' : 'border-border hover:bg-accent/30'
								)}
							>
								<span class={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border', signIn === o.value ? 'border-foreground bg-foreground text-background' : 'border-border')}>
									{#if signIn === o.value}<CheckIcon class="size-3" weight="bold" />{/if}
								</span>
								<span class="flex flex-col">
									<span class="text-sm font-medium">{o.label}</span>
									<span class="text-xs text-muted-foreground">{o.hint}</span>
								</span>
							</button>
						{/each}
					</div>
				</section>

				{#if signIn !== 'none'}
					<section class="flex flex-col gap-2">
						<div>
							<h3 class="text-sm font-medium">OAuth client <span class="font-normal text-muted-foreground">· optional</span></h3>
							<p class="text-xs text-muted-foreground">
								{needsOwnClient(probe) ? 'This server does not register clients itself: enter the client ID of an OAuth app you created there.' : 'Leave empty to let the server register one. Use your own client if the server requires it.'}
							</p>
						</div>
						<div class="grid gap-3 sm:grid-cols-2">
							<Field.Field>
								<Field.Label for="cc-client-id">Client ID</Field.Label>
								<Input id="cc-client-id" bind:value={clientId} autocomplete="off" />
							</Field.Field>
							<Field.Field>
								<Field.Label for="cc-client-secret">Client secret</Field.Label>
								<Input id="cc-client-secret" type="password" bind:value={clientSecret} autocomplete="off" />
							</Field.Field>
						</div>
					</section>
				{/if}

				<section class="flex flex-col gap-2">
					<div>
						<h3 class="text-sm font-medium">Request headers <span class="font-normal text-muted-foreground">· optional</span></h3>
						<p class="text-xs text-muted-foreground">Sent with every request, for example an API key. Values are stored encrypted.</p>
					</div>
					{#each headers as row, i (i)}
						<div class="flex items-center gap-2">
							<Input class="h-8 flex-1" bind:value={row.key} placeholder="Header name" aria-label="Header name {i + 1}" autocomplete="off" />
							<Input class="h-8 flex-1" type="password" bind:value={row.value} placeholder="Value" aria-label="Header value {i + 1}" autocomplete="off" />
							<Button type="button" size="icon-sm" variant="ghost" aria-label="Remove header {i + 1}" onclick={() => (headers = headers.filter((_, j) => j !== i))}><TrashIcon class="size-4" /></Button>
						</div>
					{/each}
					{#if bad.length}<p class="text-xs text-destructive-text" role="alert">Header names may contain letters, digits and hyphens only: {bad.join(', ')}.</p>{/if}
					<div><Button type="button" size="sm" variant="outline" onclick={() => (headers = [...headers, { key: '', value: '' }])}><PlusIcon class="size-4" />Add header</Button></div>
				</section>

				{#if !agentId}
					<label class="flex items-center justify-between gap-3 text-sm">
						<span class="flex flex-col"><span>Available to all agents</span><span class="text-xs text-muted-foreground">Off: you turn it on per agent.</span></span>
						<Switch bind:checked={availableToAll} aria-label="Available to all agents" />
					</label>
				{/if}

				{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
			</div>
			<Dialog.Footer class="border-t border-border px-5 py-3">
				<Button type="button" variant="ghost" disabled={adding} onclick={() => ((step = 'details'), (error = ''))}>Back</Button>
				<Button type="button" disabled={adding || !canAdd(form)} onclick={add}>
					{#if adding}<Spinner class="size-4" />{signIn === 'now' ? 'Adding…' : 'Connecting…'}{:else}Add{/if}
				</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
