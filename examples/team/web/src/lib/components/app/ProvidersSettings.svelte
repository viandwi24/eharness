<script lang="ts">
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimple';
	import PlugsConnectedIcon from 'phosphor-svelte/lib/PlugsConnected';
	import CubeIcon from 'phosphor-svelte/lib/Cube';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeft';
	import DotsThreeIcon from 'phosphor-svelte/lib/DotsThree';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import { untrack } from 'svelte';
	import { api, fieldErrors } from '#lib/api/index.js';
	import ProviderIcon from '#lib/components/app/ProviderIcon.svelte';
	import ProviderModels from '#lib/components/app/ProviderModels.svelte';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import SchemaForm from '#lib/components/app/SchemaForm.svelte';
	import EnvNotice from '#lib/components/app/config/EnvNotice.svelte';
	import StatusBadge from '#lib/components/app/config/StatusBadge.svelte';
	import TestButton from '#lib/components/app/config/TestButton.svelte';
	import TestResult from '#lib/components/app/config/TestResult.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { profileStatuses, runTest, type TestOutcome } from '#lib/config/status.js';
	import { buildSettings, envVariables, initialValues, type FormValues } from '#lib/providers/form.js';
	import { providersStore } from '#lib/providers/store.svelte.js';
	import type { ProviderDefinition, ProviderProfile } from '#lib/providers/store-core.js';
	import { live } from '#lib/stores/live.svelte.js';

	const store = providersStore.state;


	// Initial load, and a refresh when another tab or instance changes a profile.
	$effect(() => {
		void live.state.revs.providers;
		untrack(() => {
			providersStore.forget();
			void providersStore.load();
		});
	});

	// --- test results (per profile, this session) ---------------------------------------------
	let results = $state<Record<string, TestOutcome>>({});
	async function test(id: string): Promise<TestOutcome> {
		results[id] = { ok: false, busy: true };
		const r = await runTest(() => api.post('/providers/profiles/{id}/test', { params: { id } }));
		results[id] = r;
		return r;
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
	let dialogTest = $state<TestOutcome | undefined>(undefined);

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
	let confirmDelete = $state<ProviderProfile | null>(null);
	async function remove(): Promise<void> {
		const p = confirmDelete;
		confirmDelete = null;
		if (!p) return;
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

	// the profile shown in the detail panel: the picked one, else the default, else the first
	let pickedId = $state<string | undefined>(undefined);
	const selected = $derived(store.profiles.find((p) => p.id === pickedId) ?? store.profiles.find((p) => p.isDefault) ?? store.profiles[0]);
	const selectedDef = $derived(selected ? providersStore.definition(selected.definitionId) : undefined);

	/** Read-only summary of a profile's settings: label and value, secrets as their saved hint. */
	function summaryRows(p: ProviderProfile, def: ProviderDefinition | undefined): { label: string; value: string; mono: boolean }[] {
		if (!def) return [];
		const rows: { label: string; value: string; mono: boolean }[] = [];
		for (const f of def.fields) {
			const v = p.settings[f.path];
			if (v === undefined || v === null || v === '') {
				if (f.secret && f.required) rows.push({ label: f.label, value: 'Not set', mono: false });
				continue;
			}
			if (f.secret && typeof v === 'object') {
				const sv = v as { set?: boolean; hint?: string };
				rows.push({ label: f.label, value: sv.set ? (sv.hint ? `Saved (${sv.hint})` : 'Saved') : 'Not set', mono: !!sv.hint });
			} else if (f.kind === 'record') {
				const n = Object.keys(v as object).length;
				if (n) rows.push({ label: f.label, value: `${n} ${n === 1 ? 'entry' : 'entries'}`, mono: false });
			} else if (typeof v !== 'object') {
				rows.push({ label: f.label, value: String(v), mono: f.kind === 'string' });
			}
		}
		return rows;
	}

	const envVars = (p: ProviderProfile): string[] => {
		const def = providersStore.definition(p.definitionId);
		return def ? envVariables(def.envMap, p.settings) : [];
	};
</script>

<div class="flex flex-col gap-5">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="max-w-xl">
			<h2 class="text-base font-semibold">Providers</h2>
			<p class="mt-1 text-sm text-muted-foreground">
				Where models come from. Add several profiles of one provider, such as two OpenRouter keys, then pick a profile and a model per agent. Keys are stored encrypted and never shown again.
			</p>
		</div>
		<Button size="sm" onclick={startAdd}><PlusIcon class="size-3.5" />Add provider</Button>
	</div>

	{#if store.error && !store.loaded}
		<p class="text-sm text-destructive-text" role="alert">{store.error}</p>
	{:else if !store.loaded}
		<div class="grid gap-4 md:grid-cols-[17rem_1fr]">
			<div class="flex flex-col gap-2"><Skeleton class="h-14 rounded-xl" /><Skeleton class="h-14 rounded-xl" /></div>
			<Skeleton class="h-64 rounded-xl" />
		</div>
	{:else if store.profiles.length === 0}
		<Empty.Root class="border p-10">
			<Empty.Header>
				<Empty.Media variant="icon"><CubeIcon /></Empty.Media>
				<Empty.Title class="text-sm">No provider yet</Empty.Title>
				<Empty.Description>Add a provider to start chatting. You need an API key from OpenRouter or Vercel AI Gateway, or set <span class="font-mono">OPENROUTER_API_KEY</span> or <span class="font-mono">AI_GATEWAY_API_KEY</span> on the server.</Empty.Description>
			</Empty.Header>
			<Button size="sm" onclick={startAdd}><PlusIcon class="size-3.5" />Add provider</Button>
		</Empty.Root>
	{:else}
		<div class="grid items-start gap-4 md:grid-cols-[17rem_minmax(0,1fr)]">
			<nav aria-label="Provider profiles" class="flex flex-col gap-1.5">
				{#each store.profiles as p (p.id)}
					{@const def = providersStore.definition(p.definitionId)}
					{@const r = results[p.id]}
					<button
						type="button"
						aria-current={selected?.id === p.id ? 'true' : undefined}
						onclick={() => (pickedId = p.id)}
						class="flex items-center gap-3 rounded-xl border border-transparent p-2.5 text-left outline-none transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring aria-[current=true]:border-border aria-[current=true]:bg-accent"
					>
						<ProviderIcon definitionId={p.definitionId} size="sm" />
						<span class="min-w-0 flex-1">
							<span class="flex items-center gap-1.5">
								<span class="truncate text-sm font-medium">{p.label}</span>
								{#if p.isDefault}<Badge variant="brand">Default</Badge>{/if}
							</span>
							<span class="block truncate text-xs text-muted-foreground">{def?.label ?? p.definitionId} · {p.source === 'env' ? 'Environment' : 'Custom'}</span>
						</span>
						{#if !p.enabled}
							<span class="size-2 shrink-0 rounded-full bg-warning" title="Disabled"></span>
						{:else if r && !r.busy}
							<span class="size-2 shrink-0 rounded-full {r.ok ? 'bg-success' : 'bg-destructive'}" title={r.ok ? 'Last test passed' : 'Last test failed'}></span>
						{/if}
					</button>
				{/each}
			</nav>

			{#if selected}
				{@const p = selected}
				{@const r = results[p.id]}
				<div class="flex min-w-0 flex-col gap-6 rounded-xl border border-border p-4 sm:p-5">
					<div class="flex flex-wrap items-start gap-3">
						<ProviderIcon definitionId={p.definitionId} size="lg" />
						<div class="min-w-44 flex-1">
							<div class="flex flex-wrap items-center gap-1.5">
								<h3 class="truncate text-base font-semibold">{p.label}</h3>
								{#each profileStatuses(p) as st (st)}<StatusBadge status={st} />{/each}
							</div>
							<p class="mt-0.5 text-xs text-muted-foreground">{selectedDef?.label ?? p.definitionId} · <span class="font-mono">{p.id}</span></p>
						</div>
						<div class="flex shrink-0 flex-wrap items-center gap-1.5">
							<TestButton busy={r?.busy} onclick={() => test(p.id)} label="Test connection" />
							{#if p.source === 'store'}
								<Button type="button" variant="outline" size="sm" onclick={() => startEdit(p)}><PencilSimpleIcon class="size-3.5" />Edit</Button>
							{/if}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button {...props} variant="ghost" size="icon-sm" aria-label="More actions"><DotsThreeIcon class="size-5" weight="bold" /></Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									<DropdownMenu.Item disabled={p.isDefault || !p.enabled} onSelect={() => makeDefault(p)}>Make default</DropdownMenu.Item>
									{#if selectedDef?.doc}<DropdownMenu.Item onSelect={() => window.open(selectedDef.doc, '_blank', 'noopener,noreferrer')}>Open docs</DropdownMenu.Item>{/if}
									{#if p.source === 'store'}
										<DropdownMenu.Separator />
										<DropdownMenu.Item variant="destructive" onSelect={() => (confirmDelete = p)}>Delete</DropdownMenu.Item>
									{/if}
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</div>
					</div>

					{#if r}<TestResult result={r} class="text-sm" />{/if}

					<section class="flex flex-col gap-3">
						<h3 class="text-sm font-medium">Connection</h3>
						{#if p.source === 'env'}<EnvNotice vars={envVars(p)} />{/if}
						<dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
							{#each summaryRows(p, selectedDef) as row (row.label)}
								<dt class="text-muted-foreground">{row.label}</dt>
								<dd class="min-w-0 truncate {row.mono ? 'font-mono text-xs leading-5' : ''}">{row.value}</dd>
							{/each}
						</dl>
					</section>

					{#key p.id}<ProviderModels profileId={p.id} readOnly={p.source === 'env'} />{/key}
				</div>
			{/if}
		</div>
	{/if}
</div>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
		<Dialog.Header class="border-b border-border px-5 py-4 pr-12">
			<Dialog.Title>{mode === 'edit' ? `Edit ${editing?.label ?? 'provider'}` : definition ? `Add ${definition.label}` : 'Add provider'}</Dialog.Title>
			<Dialog.Description>
				{#if mode === 'edit'}Secrets you leave empty keep their saved value.{:else if definition}Fill in the connection. You can add the same provider again with another key.{:else}Choose a provider.{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if !definition}
			<div class="grid min-h-0 flex-1 gap-2 overflow-y-auto px-5 py-4 sm:grid-cols-2">
				{#each store.providers as d (d.id)}
					<button type="button" class="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-3.5 text-left outline-none transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" onclick={() => choose(d)}>
						<ProviderIcon definitionId={d.id} />
						<span class="min-w-0">
							<span class="block text-sm font-medium">{d.label}</span>
							<span class="mt-0.5 block text-xs text-muted-foreground">{d.id === 'openrouter' ? 'One key for hundreds of models from many labs.' : d.id === 'gateway' ? 'Route through Vercel with one key and unified billing.' : (d.doc ?? 'Bring your own key')}</span>
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
				<TestResult result={dialogTest} class="text-sm" />
			</form>
			<Dialog.Footer class="border-t border-border px-5 py-3">
				{#if mode === 'create'}<Button type="button" variant="ghost" class="mr-auto" onclick={() => (definition = undefined)}><ArrowLeftIcon class="size-4" />Back</Button>{/if}
				<Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
				<Button type="button" variant="outline" disabled={saving} onclick={onSaveAndTest}><PlugsConnectedIcon class="size-4" />Save and test</Button>
				<Button type="submit" form="provider-form" disabled={saving}>{saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Add provider'}</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root open={confirmDelete !== null} onOpenChange={(o) => !o && (confirmDelete = null)}>
	<AlertDialog.Content elevation="floating">
		<AlertDialog.Header>
			<AlertDialog.Title>Delete {confirmDelete?.label}?</AlertDialog.Title>
			<AlertDialog.Description>Agents that use it must pick another provider first. The saved key is removed.</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action variant="destructive" onclick={remove}>Delete</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
