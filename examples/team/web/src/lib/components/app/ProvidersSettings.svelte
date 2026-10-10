<script lang="ts">
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircle';
	import CloudIcon from 'phosphor-svelte/lib/Cloud';
	import LightningIcon from 'phosphor-svelte/lib/Lightning';
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimple';
	import PlugsConnectedIcon from 'phosphor-svelte/lib/PlugsConnected';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import StackIcon from 'phosphor-svelte/lib/Stack';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import WarningIcon from 'phosphor-svelte/lib/Warning';
	import { untrack } from 'svelte';
	import { api, fieldErrors } from '#lib/api/index.js';
	import SchemaForm from '#lib/components/app/SchemaForm.svelte';
	import Surface from '#lib/components/app/Surface.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { buildSettings, envVariables, initialValues, type FormValues } from '#lib/providers/form.js';
	import { providersStore } from '#lib/providers/store.svelte.js';
	import type { ProviderDefinition, ProviderProfile } from '#lib/providers/store-core.js';
	import { live } from '#lib/stores/live.svelte.js';

	type TestResult = { ok: boolean; message?: string; latencyMs?: number };

	const store = providersStore.state;

	const iconOf = (definitionId: string) => (definitionId === 'openrouter' ? StackIcon : definitionId === 'gateway' ? LightningIcon : CloudIcon);

	// Initial load, and a refresh when another tab or instance changes a profile.
	$effect(() => {
		void live.state.revs.providers;
		untrack(() => {
			providersStore.forget();
			void providersStore.load();
		});
	});

	// --- test results (per profile, this session) ---------------------------------------------
	let results = $state<Record<string, TestResult & { busy?: boolean }>>({});
	async function test(id: string): Promise<TestResult> {
		results[id] = { ok: false, busy: true };
		try {
			const r = await api.post('/providers/profiles/{id}/test', { params: { id } });
			results[id] = r;
			return r;
		} catch (e) {
			const r = { ok: false, message: e instanceof Error ? e.message : 'Test failed' };
			results[id] = r;
			return r;
		}
	}

	// --- dialog: add / edit --------------------------------------------------------------------
	let open = $state(false);
	let mode = $state<'create' | 'edit'>('create');
	let definition = $state<ProviderDefinition | undefined>(undefined);
	let editing = $state<ProviderProfile | undefined>(undefined);
	let label = $state('');
	let enabled = $state(true);
	let values = $state<FormValues>({});
	let errors = $state<Record<string, string>>({});
	let formError = $state('');
	let saving = $state(false);
	let dialogTest = $state<(TestResult & { busy?: boolean }) | undefined>(undefined);

	function startAdd(): void {
		mode = 'create';
		definition = undefined;
		editing = undefined;
		reset();
		open = true;
	}

	function choose(d: ProviderDefinition): void {
		definition = d;
		label = '';
		values = initialValues(d.fields);
	}

	function startEdit(p: ProviderProfile): void {
		const d = providersStore.definition(p.definitionId);
		if (!d || p.source === 'env') return;
		mode = 'edit';
		definition = d;
		editing = p;
		reset();
		label = p.label;
		enabled = p.enabled;
		values = initialValues(d.fields, p.settings);
		open = true;
	}

	function reset(): void {
		label = '';
		enabled = true;
		values = {};
		errors = {};
		formError = '';
		dialogTest = undefined;
	}

	const placeholderLabel = $derived(definition ? definition.label : '');

	/** Save; returns the saved profile id, or undefined when validation or the server refused. */
	async function save(): Promise<string | undefined> {
		if (!definition) return undefined;
		formError = '';
		const built = buildSettings(definition.fields, values, editing?.settings, mode);
		if (!built.ok) {
			errors = built.errors;
			return undefined;
		}
		errors = {};
		saving = true;
		try {
			const name = label.trim();
			let saved: ProviderProfile;
			if (mode === 'create') {
				saved = await api.post('/providers/profiles', {
					body: { providerId: definition.id, ...(name ? { label: name } : {}), settings: built.settings, enabled }
				});
			} else {
				saved = await api.patch('/providers/profiles/{id}', {
					params: { id: (editing as ProviderProfile).id },
					body: { ...(name ? { label: name } : {}), settings: built.settings, enabled }
				});
			}
			providersStore.forget(saved.id);
			await providersStore.load();
			editing = store.profiles.find((p) => p.id === saved.id) ?? saved;
			mode = 'edit';
			values = initialValues(definition.fields, editing.settings); // secrets cleared, "saved" shown
			label = editing.label;
			return saved.id;
		} catch (e) {
			errors = serverErrors(e);
			formError = e instanceof Error ? e.message : String(e);
			return undefined;
		} finally {
			saving = false;
		}
	}

	// server-side validation messages arrive as "settings.<path>: message" issues
	function serverErrors(e: unknown): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(fieldErrors(e))) out[k.replace(/^settings\./, '')] = v;
		return out;
	}

	async function onSave(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		const wasCreate = mode === 'create';
		const id = await save();
		if (id === undefined) return;
		toast.success(wasCreate ? 'Provider added' : 'Provider saved');
		open = false;
		void test(id);
	}

	async function onSaveAndTest(): Promise<void> {
		const id = await save();
		if (id === undefined) return;
		dialogTest = { ok: false, busy: true };
		dialogTest = await test(id);
	}

	// --- row actions --------------------------------------------------------------------------
	async function remove(p: ProviderProfile): Promise<void> {
		if (!confirm(`Delete ${p.label}? Agents that use it must pick another provider first.`)) return;
		try {
			await api.delete('/providers/profiles/{id}', { params: { id: p.id } });
			toast.success('Provider deleted');
			providersStore.forget(p.id);
			await providersStore.load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not delete the provider');
		}
	}

	async function makeDefault(p: ProviderProfile): Promise<void> {
		try {
			await api.patch('/settings', { body: { defaultProfile: p.id, defaultModel: null } });
			toast.success(`${p.label} is the default provider`);
			await providersStore.load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not change the default');
		}
	}

	const envNote = (p: ProviderProfile): string => {
		const def = providersStore.definition(p.definitionId);
		const vars = def ? envVariables(def.envMap, p.settings) : [];
		return vars.length ? vars.join(', ') : 'environment variables';
	};
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Providers</Card.Title>
		<Card.Description>
			Where models come from. Add several profiles of the same provider (for example two OpenRouter keys), then pick a profile and a model per agent. Keys are stored encrypted and never shown again.
		</Card.Description>
		<Card.Action><Button size="sm" onclick={startAdd}><PlusIcon class="size-3.5" />Add provider</Button></Card.Action>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3">
		{#if store.error && !store.loaded}
			<p class="text-sm text-destructive-text" role="alert">{store.error}</p>
		{:else if !store.loaded}
			<Skeleton class="h-16 w-full rounded-xl" />
			<Skeleton class="h-16 w-full rounded-xl" />
		{:else if store.profiles.length === 0}
			<Empty.Root class="border p-6">
				<Empty.Header>
					<Empty.Title class="text-sm">No provider yet</Empty.Title>
					<Empty.Description>Add one to start chatting, or set <span class="font-mono">OPENROUTER_API_KEY</span> / <span class="font-mono">AI_GATEWAY_API_KEY</span> on the server.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else}
			{#each store.profiles as p (p.id)}
				{@const Icon = iconOf(p.definitionId)}
				{@const def = providersStore.definition(p.definitionId)}
				{@const r = results[p.id]}
				<Surface class="flex flex-col gap-2 rounded-xl p-3.5">
					<div class="flex items-center gap-3">
						<span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon class="size-5" /></span>
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-1.5">
								<span class="truncate text-sm font-medium">{p.label}</span>
								<Badge variant={p.source === 'env' ? 'secondary' : 'outline'}>{p.source === 'env' ? 'Env' : 'Custom'}</Badge>
								{#if p.isDefault}<Badge variant="brand">Default</Badge>{/if}
								{#if !p.enabled}<Badge variant="warning">Disabled</Badge>{/if}
							</div>
							<div class="truncate text-xs text-muted-foreground">
								{def?.label ?? p.definitionId} · <span class="font-mono">{p.id}</span>
								{#if p.settings.apiKey && typeof p.settings.apiKey === 'object' && 'hint' in p.settings.apiKey}· key <span class="font-mono">{(p.settings.apiKey as { hint?: string }).hint}</span>{/if}
							</div>
						</div>
						<div class="flex shrink-0 items-center gap-1">
							<Button type="button" variant="outline" size="sm" disabled={r?.busy} onclick={() => test(p.id)}>
								{#if r?.busy}<Spinner class="size-3.5" />{:else}<PlugsConnectedIcon class="size-3.5" />{/if}Test
							</Button>
							{#if !p.isDefault && p.enabled}<Button type="button" variant="ghost" size="sm" onclick={() => makeDefault(p)}>Make default</Button>{/if}
							{#if p.source === 'store'}
								<Button type="button" variant="ghost" size="icon-sm" aria-label="Edit {p.label}" onclick={() => startEdit(p)}><PencilSimpleIcon class="size-4" /></Button>
								<Button type="button" variant="ghost" size="icon-sm" aria-label="Delete {p.label}" onclick={() => remove(p)}><TrashIcon class="size-4" /></Button>
							{/if}
						</div>
					</div>
					{#if p.source === 'env'}
						<p class="text-xs text-muted-foreground">Read-only: set by <span class="font-mono">{envNote(p)}</span> in the server environment. Change it there, or add a custom profile here.</p>
					{/if}
					{#if r && !r.busy}
						<p class="flex items-center gap-1.5 text-xs {r.ok ? 'text-success-text' : 'text-destructive-text'}" role="status">
							{#if r.ok}<CheckCircleIcon class="size-3.5" />Connected{r.message ? `: ${r.message}` : ''}{r.latencyMs ? ` (${r.latencyMs} ms)` : ''}{:else}<WarningIcon class="size-3.5" />{r.message ?? 'Connection failed'}{/if}
						</p>
					{/if}
				</Surface>
			{/each}
		{/if}
	</Card.Content>
</Card.Root>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>{mode === 'edit' ? `Edit ${editing?.label ?? 'provider'}` : definition ? `Add ${definition.label}` : 'Add provider'}</Dialog.Title>
			<Dialog.Description>
				{#if mode === 'edit'}Secrets you leave empty keep their saved value.{:else if definition}Fill in the connection. You can add the same provider again with another key.{:else}Choose a provider.{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if !definition}
			<div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-5 py-4">
				{#each store.providers as d (d.id)}
					{@const Icon = iconOf(d.id)}
					<button type="button" class="flex items-center gap-3 rounded-xl border border-border bg-card p-3 text-left outline-none transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" onclick={() => choose(d)}>
						<span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon class="size-5" /></span>
						<span class="min-w-0">
							<span class="block text-sm font-medium">{d.label}</span>
							<span class="block truncate text-xs text-muted-foreground">{d.doc ?? d.id}</span>
						</span>
					</button>
				{/each}
			</div>
			<Dialog.Footer class="border-t border-border px-5 py-3">
				<Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
			</Dialog.Footer>
		{:else}
			<form id="provider-form" onsubmit={onSave} class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
				<Field.Field>
					<Field.Label for="pf-label">Name</Field.Label>
					<Input id="pf-label" bind:value={label} placeholder={placeholderLabel} maxlength={80} />
					<Field.Description>Shown in pickers. Several profiles of one provider need different names.</Field.Description>
				</Field.Field>
				<SchemaForm fields={definition.fields} bind:values current={editing?.settings} {errors} idPrefix="pf" disabled={saving} />
				<Field.Field orientation="horizontal">
					<Field.Content>
						<Field.Label for="pf-enabled">Enabled</Field.Label>
						<Field.Description>A disabled profile cannot be picked or used.</Field.Description>
					</Field.Content>
					<Switch id="pf-enabled" bind:checked={enabled} aria-label="Enabled" />
				</Field.Field>
				{#if formError && !Object.keys(errors).length}<p class="text-sm text-destructive-text" role="alert">{formError}</p>{/if}
				{#if dialogTest}
					<p class="flex items-center gap-1.5 text-sm {dialogTest.busy ? 'text-muted-foreground' : dialogTest.ok ? 'text-success-text' : 'text-destructive-text'}" role="status">
						{#if dialogTest.busy}<Spinner class="size-4" />Testing…{:else if dialogTest.ok}<CheckCircleIcon class="size-4" />Connected{dialogTest.message ? `: ${dialogTest.message}` : ''}{:else}<WarningIcon class="size-4" />{dialogTest.message ?? 'Connection failed'}{/if}
					</p>
				{/if}
			</form>
			<Dialog.Footer class="border-t border-border px-5 py-3">
				<Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
				<Button type="button" variant="outline" disabled={saving} onclick={onSaveAndTest}><PlugsConnectedIcon class="size-4" />Save &amp; test</Button>
				<Button type="submit" form="provider-form" disabled={saving}>{saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Add provider'}</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
