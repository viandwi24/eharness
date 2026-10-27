<script lang="ts">
	import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwise';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import WrenchIcon from 'phosphor-svelte/lib/Wrench';
	import XIcon from 'phosphor-svelte/lib/X';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { api } from '#lib/api/index.js';
	import { disableAllModels, enableAllModels, filterModels, recommendedFirst, formatContext, formatPricing, hasModelPolicy, isModelEnabled, setModelEnabled, type ModelPolicy, type ProviderModel } from '#lib/providers/models.js';
	import { providersStore } from '#lib/providers/store.svelte.js';

	/**
	 * The models of one provider profile: searchable, with context window, price and capability badges,
	 * and a switch per model (the profile's `models.allow` / `models.deny`). Agents can only pick the
	 * models that are on. `readOnly` (an env profile) shows the switches without changing them.
	 * A model can be added by hand (`models.extra`: id, name, context window) for a server that does
	 * not list it, and "Test tools" checks a model can call tools (agents need that).
	 */
	let { profileId, readOnly = false }: { profileId: string; readOnly?: boolean } = $props();

	let models = $state<ProviderModel[]>([]);
	let loading = $state(true);
	let error = $state('');
	let query = $state('');
	let limit = $state(40);
	let onlyEnabled = $state(false);
	let saving = $state(false);
	const policy = $derived(providersStore.profile(profileId)?.models as ModelPolicy | undefined);
	const enabledCount = $derived(models.filter((m) => m.enabled !== false).length);
	const restricted = $derived(hasModelPolicy(policy));
	/** Local servers and custom endpoints: their notes (the running context) and a tool check matter. */
	const SELF_HOSTED = new Set(['ollama', 'lmstudio', 'vllm', 'llamacpp', 'openai-compatible']);
	const selfHosted = $derived(SELF_HOSTED.has(providersStore.profile(profileId)?.definitionId ?? ''));

	let seq = 0;
	async function load(refresh = false): Promise<void> {
		const mine = ++seq;
		loading = true;
		error = '';
		try {
			const list = await providersStore.allModels(profileId, refresh);
			if (mine === seq) models = list;
		} catch (e) {
			if (mine === seq) {
				models = [];
				error = e instanceof Error ? e.message : 'Could not load the models';
			}
		} finally {
			if (mine === seq) loading = false;
		}
	}
	$effect(() => {
		void profileId;
		query = '';
		limit = 40;
		void load();
	});

	const shown = $derived(onlyEnabled ? models.filter((m) => m.enabled !== false) : models);
	const ordered = $derived(query.trim() ? { items: shown, recommended: 0 } : recommendedFirst(shown));
	const matches = $derived(filterModels(ordered.items, query, limit));

	/** Store a new policy: switches update at once, the server answer replaces them (a failure puts them back). */
	async function apply(next: ModelPolicy | null): Promise<void> {
		if (saving || readOnly) return;
		const before = models;
		models = models.map((m) => ({ ...m, enabled: isModelEnabled(next ?? undefined, m.id) }));
		saving = true;
		try {
			await api.patch('/providers/profiles/{id}', { params: { id: profileId }, body: { models: next } });
			providersStore.forget(profileId);
			await providersStore.load();
		} catch (e) {
			models = before;
			toast.error(e instanceof Error ? e.message : 'Could not save the model list');
		} finally {
			saving = false;
		}
	}
	const toggle = (m: ProviderModel, on: boolean): Promise<void> => apply(setModelEnabled(policy, m.id, on));

	/** Below this an agent's instructions and tools hardly fit (`MIN_CONTEXT_WINDOW` of the server). */
	const SMALL_CONTEXT = 16_000;

	// --- a model added by hand --------------------------------------------------------------
	let adding = $state(false);
	let newId = $state('');
	let newName = $state('');
	let newWindow = $state<number | null>(null);
	let addError = $state('');
	async function addModel(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		const id = newId.trim();
		if (!id) return void (addError = 'Type the model id the server knows, for example qwen3:8b.');
		if (models.some((m) => m.id === id)) return void (addError = `${id} is already in the list.`);
		if (newWindow !== null && (!Number.isInteger(newWindow) || newWindow < 256)) return void (addError = 'Context length must be a whole number of tokens, at least 256.');
		addError = '';
		const extra = [...(policy?.extra ?? []), { id, ...(newName.trim() ? { name: newName.trim() } : {}), ...(newWindow ? { contextWindow: newWindow } : {}) }];
		await saveExtra(extra);
		if (!error) {
			adding = false;
			newId = newName = '';
			newWindow = null;
		}
	}
	const removeModel = (m: ProviderModel): Promise<void> => saveExtra((policy?.extra ?? []).filter((x) => x.id !== m.id));
	async function saveExtra(extra: NonNullable<ModelPolicy['extra']>): Promise<void> {
		if (saving || readOnly) return;
		saving = true;
		try {
			const next: ModelPolicy = { ...(policy ?? {}), extra };
			if (extra.length === 0) delete next.extra;
			const empty = next.allow === undefined && (next.deny?.length ?? 0) === 0 && next.extra === undefined;
			await api.patch('/providers/profiles/{id}', { params: { id: profileId }, body: { models: empty ? null : next } });
			providersStore.forget(profileId);
			await providersStore.load();
			await load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save the model');
		} finally {
			saving = false;
		}
	}

	// --- tool probe -----------------------------------------------------------------------------
	type Probe = { running: true } | { running: false; ok: boolean; tools: boolean; message: string; latencyMs: number };
	let probes = $state<Record<string, Probe>>({});
	async function probe(m: ProviderModel): Promise<void> {
		probes[m.id] = { running: true };
		try {
			const r = await api.post('/providers/profiles/{id}/probe', { params: { id: profileId }, body: { modelId: m.id } });
			probes[m.id] = { running: false, ...r };
		} catch (e) {
			probes[m.id] = { running: false, ok: false, tools: false, message: e instanceof Error ? e.message : 'The check failed', latencyMs: 0 };
		}
	}
	const finished = (id: string): Extract<Probe, { running: false }> | undefined => {
		const p = probes[id];
		return p && !p.running ? p : undefined;
	};
	const seconds = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
</script>

<section class="flex flex-col gap-3">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h3 class="text-sm font-medium">Models {#if !loading && !error}<span class="font-normal text-muted-foreground" data-testid="models-count">{restricted ? `${enabledCount} of ${models.length} enabled` : models.length}</span>{/if}</h3>
		<div class="flex flex-wrap items-center gap-1">
			{#if !readOnly && !loading && !error && models.length > 0}
				<Button size="xs" variant="ghost" disabled={saving} onclick={() => apply(enableAllModels(policy))} data-testid="enable-all">Enable all</Button>
				<Button size="xs" variant="ghost" disabled={saving || enabledCount === 0} onclick={() => apply(disableAllModels(policy))} data-testid="disable-all">Disable all</Button>
			{/if}
			{#if !readOnly}<Button size="xs" variant="ghost" disabled={saving} onclick={() => (adding = !adding)} aria-expanded={adding} data-testid="add-model"><PlusIcon class="size-3.5" />Add model</Button>{/if}
			<Button size="xs" variant="ghost" disabled={loading} onclick={() => load(true)}><ArrowsClockwiseIcon class="size-3.5" />Refresh</Button>
		</div>
	</div>
	{#if adding}
		<form class="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 p-3" onsubmit={addModel} data-testid="add-model-form">
			<p class="text-xs text-muted-foreground">For a model the server does not list, or to give one a name and the context length the server runs it with.</p>
			<Input bind:value={newId} placeholder="Model id, e.g. qwen3:8b" aria-label="Model id" class="font-mono text-xs" disabled={saving} />
			<div class="flex gap-2">
				<Input bind:value={newName} placeholder="Name (optional)" aria-label="Model name" class="min-w-0 flex-1" disabled={saving} />
				<Input type="number" inputmode="numeric" min={256} step={1} bind:value={newWindow} placeholder="Context tokens" aria-label="Context length in tokens" class="w-36" disabled={saving} />
			</div>
			{#if addError}<p class="text-xs text-destructive-text" role="alert">{addError}</p>{/if}
			<div class="flex justify-end gap-1">
				<Button type="button" size="xs" variant="ghost" onclick={() => ((adding = false), (addError = ''))}>Cancel</Button>
				<Button type="submit" size="xs" disabled={saving}>Add</Button>
			</div>
		</form>
	{/if}
	{#if !loading && !error && models.length > 0}
		<label class="flex items-center gap-2 text-xs text-muted-foreground">
			<Switch size="sm" bind:checked={onlyEnabled} aria-label="Show only enabled models" />
			Show only enabled
			{#if readOnly}<span class="ml-auto">Set from environment variables: read-only</span>{/if}
		</label>
	{/if}
	{#if models.length > 8 || query}
		<div class="relative">
			<MagnifyingGlassIcon class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
			<Input bind:value={query} placeholder="Search models" aria-label="Search models" class="pl-8" oninput={() => (limit = 40)} />
		</div>
	{/if}
	{#if loading}
		<div class="flex flex-col gap-2"><Skeleton class="h-11 rounded-lg" /><Skeleton class="h-11 rounded-lg" /><Skeleton class="h-11 rounded-lg" /></div>
	{:else if error}
		<p class="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-text" role="alert">{error}</p>
	{:else if models.length === 0}
		<p class="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">This provider lists no models.{readOnly ? ' Type a model id when you pick one for an agent.' : ' Use Add model to name one.'}</p>
	{:else if matches.total === 0}
		<p class="px-1 py-3 text-sm text-muted-foreground">{query.trim() ? `No model matches “${query.trim()}”.` : 'No model is enabled. Switch some on, or use Enable all.'}</p>
	{:else}
		<ul class="divide-y divide-border overflow-hidden rounded-xl border border-border">
			{#each matches.items as m, i (m.id)}
				{@const on = m.enabled !== false}
				{#if ordered.recommended > 0 && i === 0}<li class="bg-muted/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground" data-testid="models-recommended">Recommended</li>{/if}
				{#if ordered.recommended > 0 && i === ordered.recommended}<li class="bg-muted/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">All other models</li>{/if}
				<li class="flex items-start gap-3 px-3 py-2.5" data-testid="model-row" data-enabled={on}>
					<Switch size="sm" class="mt-0.5" checked={on} disabled={readOnly || saving} onCheckedChange={(v) => void toggle(m, v)} aria-label="{on ? 'Disable' : 'Enable'} {m.name}" />
					<div class="flex min-w-0 flex-1 flex-col gap-1.5 {on ? '' : 'opacity-60'}">
					<div class="min-w-0">
						<p class="truncate text-sm font-medium">{m.name}</p>
						<p class="truncate font-mono text-[11px] text-muted-foreground">{m.id}</p>
					</div>
					<div class="flex flex-wrap items-center gap-1.5">
						{#if m.source === 'extra'}<Badge variant="outline">Added by hand</Badge>{/if}
						{#if m.tools}<Badge variant="secondary">Tools</Badge>{/if}
						{#if m.reasoning}<Badge variant="info">Reasoning</Badge>{/if}
						{#if m.contextWindow}<Badge variant={m.contextWindow < SMALL_CONTEXT ? 'warning' : 'outline'}>{formatContext(m.contextWindow)} context</Badge>{/if}
						{#if m.pricing}<span class="text-[11px] text-muted-foreground tabular-nums">{m.pricing.input === 0 && m.pricing.output === 0 ? 'Free (runs on your server)' : formatPricing(m.pricing)}</span>{/if}
					</div>
					{#if selfHosted && m.description}<p class="text-[11px] leading-4 text-muted-foreground">{m.description}</p>{/if}
					{#if m.contextWindow && m.contextWindow < SMALL_CONTEXT}<p class="text-[11px] leading-4 text-warning-text">Too small for an agent: its instructions and tools need about {formatContext(SMALL_CONTEXT)}. Run the model with a larger context.</p>{/if}
					{#if finished(m.id)}{@const pr = finished(m.id)!}<p class="text-[11px] leading-4 {pr.tools ? 'text-success-text' : 'text-destructive-text'}" role="status" data-testid="probe-result">{pr.message}{pr.latencyMs ? ` (${seconds(pr.latencyMs)})` : ''}</p>{/if}
					</div>
					<div class="flex shrink-0 items-center gap-0.5">
						{#if on && selfHosted}<Button size="xs" variant="ghost" disabled={probes[m.id]?.running} onclick={() => probe(m)} title="Send one small request with a tool: agents need models that call tools" data-testid="probe-tools"><WrenchIcon class="size-3.5" />{probes[m.id]?.running ? 'Testing…' : 'Test tools'}</Button>{/if}
						{#if m.source === 'extra' && !readOnly}<Button size="icon-xs" variant="ghost" disabled={saving} onclick={() => removeModel(m)} aria-label="Remove {m.name}"><XIcon class="size-3.5" /></Button>{/if}
					</div>
				</li>
			{/each}
		</ul>
		{#if matches.total > matches.items.length}
			<Button size="sm" variant="ghost" class="self-center" onclick={() => (limit += 60)}>Show more ({matches.total - matches.items.length} left)</Button>
		{/if}
	{/if}
</section>
