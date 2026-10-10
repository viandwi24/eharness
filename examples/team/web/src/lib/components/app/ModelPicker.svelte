<script lang="ts">
	import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwise';
	import CaretUpDownIcon from 'phosphor-svelte/lib/CaretUpDown';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Command from '#lib/components/ui/command/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { filterModels, formatContext, formatPricing, hasModelPolicy, isModelEnabled, type ModelPolicy, type ProviderModel } from '#lib/providers/models.js';
	import { providersStore } from '#lib/providers/store.svelte.js';

	/**
	 * Pick a provider profile, then a model of it: a searchable list (`GET
	 * /providers/profiles/{id}/models`) with context window, price per 1M tokens and reasoning /
	 * tools badges. A model id that is not in the list can be typed. `profileId` null = the
	 * workspace default (profile and model).
	 */
	let {
		profileId = $bindable(null),
		modelId = $bindable(null),
		defaultLabel = 'Workspace default',
		id = 'model-picker',
		disabled = false
	}: {
		profileId?: string | null;
		modelId?: string | null;
		/** Label of the "no pick" option of the profile select. */
		defaultLabel?: string;
		id?: string;
		disabled?: boolean;
	} = $props();

	const profiles = $derived(providersStore.state.profiles.filter((p) => p.enabled || p.id === profileId));
	// a legacy pick (a model with no profile) is a model of the default profile
	const listProfileId = $derived(profileId ?? (modelId ? (providersStore.defaultProfile()?.id ?? null) : null));
	const showModel = $derived(profileId !== null || modelId !== null);

	let models = $state<ProviderModel[]>([]);
	let loading = $state(false);
	let loadError = $state('');
	let open = $state(false);
	let query = $state('');

	let seq = 0;
	async function load(profile: string, refresh = false): Promise<void> {
		const mine = ++seq;
		loading = true;
		loadError = '';
		try {
			const list = await providersStore.models(profile, refresh);
			if (mine === seq) models = list;
		} catch (e) {
			if (mine === seq) {
				models = [];
				loadError = e instanceof Error ? e.message : 'Could not load the models';
			}
		} finally {
			if (mine === seq) loading = false;
		}
	}

	$effect(() => {
		const p = listProfileId;
		if (!p) {
			models = [];
			return;
		}
		void load(p);
	});

	const selected = $derived(modelId ? models.find((m) => m.id === modelId) : undefined);
	const matches = $derived(filterModels(models, query));
	// the profile's model policy: only enabled models can be picked, a typed id must pass it too
	const policy = $derived((listProfileId ? providersStore.profile(listProfileId)?.models : undefined) as ModelPolicy | undefined);
	const customBlocked = $derived(hasModelPolicy(policy) && query.trim() !== '' && !isModelEnabled(policy, query.trim()));
	const exact = $derived(models.some((m) => m.id === query.trim()));

	function onProfile(e: Event): void {
		const v = (e.currentTarget as HTMLSelectElement).value;
		profileId = v === '' ? null : v;
		modelId = null; // models belong to a profile
	}

	function pick(v: string | null): void {
		modelId = v;
		open = false;
		query = '';
	}
	const meta = (m: ProviderModel): string[] =>
		[m.contextWindow ? `${formatContext(m.contextWindow)} context` : '', formatPricing(m.pricing)].filter(Boolean);
</script>

<div class="flex w-full max-w-xl flex-col gap-2">
	<NativeSelect {id} value={profileId ?? ''} onchange={onProfile} {disabled} class="w-full" aria-label="Provider profile">
		<NativeSelectOption value="">{defaultLabel}</NativeSelectOption>
		{#each profiles as p (p.id)}
			<NativeSelectOption value={p.id}>{p.label}{p.label === p.id ? '' : ` (${p.id})`}{p.enabled ? '' : ' (disabled)'}</NativeSelectOption>
		{/each}
	</NativeSelect>

	{#if showModel}
		<Popover.Root bind:open onOpenChange={(o) => !o && (query = '')}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button {...props} type="button" variant="outline" {disabled} aria-label="Model" class="h-auto min-h-9 w-full justify-between gap-2 py-1.5 text-left font-normal">
						<span class="min-w-0 flex-1">
							{#if modelId}
								<span class="block truncate text-sm">{selected?.name ?? modelId}</span>
								{#if selected && selected.name !== selected.id}<span class="block truncate font-mono text-[11px] text-muted-foreground">{selected.id}</span>{/if}
							{:else}
								<span class="text-sm text-muted-foreground">Default model of this profile</span>
							{/if}
						</span>
						<CaretUpDownIcon class="size-4 shrink-0 text-muted-foreground" />
					</Button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content elevation="floating" align="start" class="w-[min(36rem,92vw)] gap-0 p-0">
				<Command.Root shouldFilter={false} class="rounded-xl">
					<Command.Input bind:value={query} placeholder="Search models or type an id…" class="h-10" />
					<Command.List class="max-h-[min(22rem,50svh)]">
						{#if loading}
							<div class="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground"><Spinner class="size-4" />Loading models…</div>
						{:else}
							{#if loadError}<p class="px-3 py-2 text-xs text-destructive-text" role="alert">{loadError}. You can still type a model id.</p>{/if}
							{#if !query}
								<Command.Item value="__default__" onSelect={() => pick(null)} class="h-auto py-1.5">
									<span class="text-sm">Default model of this profile</span>
								</Command.Item>
							{/if}
							{#if query.trim() && !exact && customBlocked}
								<p class="px-3 py-2 text-xs text-muted-foreground" data-testid="custom-blocked">
									<span class="font-mono">{query.trim()}</span> is not enabled for this profile. Turn it on under Settings, Providers.
								</p>
							{:else if query.trim() && !exact}
								<Command.Item value="__custom__" onSelect={() => pick(query.trim())} class="h-auto py-1.5">
									<span class="text-sm">Use <span class="font-mono">{query.trim()}</span></span>
									<span class="text-xs text-muted-foreground">custom id</span>
								</Command.Item>
							{/if}
							{#each matches.items as m (m.id)}
								<Command.Item value={m.id} onSelect={() => pick(m.id)} data-checked={m.id === modelId} class="h-auto items-start py-1.5">
									<span class="min-w-0 flex-1">
										<span class="flex items-center gap-1.5">
											<span class="truncate text-sm">{m.name}</span>
											{#if m.reasoning}<Badge variant="info" class="h-[18px] px-1.5 text-[10px]">reasoning</Badge>{/if}
											{#if m.tools}<Badge variant="secondary" class="h-[18px] px-1.5 text-[10px]">tools</Badge>{/if}
										</span>
										<span class="block truncate font-mono text-[11px] text-muted-foreground">{m.id}</span>
										{#if meta(m).length}<span class="block text-[11px] text-muted-foreground">{meta(m).join(' · ')}</span>{/if}
									</span>
								</Command.Item>
							{/each}
							{#if matches.total > matches.items.length}
								<p class="px-3 py-2 text-xs text-muted-foreground">{matches.total - matches.items.length} more: keep typing to narrow the list.</p>
							{:else if matches.total === 0 && !query.trim()}
								<p class="px-3 py-4 text-sm text-muted-foreground">No models listed for this profile. Type a model id above.</p>
							{/if}
						{/if}
					</Command.List>
					<div class="flex items-center justify-between gap-2 border-t border-border px-2 py-1.5">
						<span class="text-xs text-muted-foreground">{models.length} models</span>
						<Button type="button" variant="ghost" size="xs" disabled={loading || !listProfileId} onclick={() => listProfileId && load(listProfileId, true)}>
							<ArrowsClockwiseIcon class="size-3.5" />Refresh
						</Button>
					</div>
				</Command.Root>
			</Popover.Content>
		</Popover.Root>
		{#if selected && meta(selected).length}
			<p class="text-xs text-muted-foreground">
				{meta(selected).join(' · ')}{selected.reasoning ? ' · reasoning' : ''}{selected.tools === false ? ' · no tool calling' : ''}
			</p>
		{:else if modelId && !loading && !selected && listProfileId}
			<p class="text-xs text-muted-foreground">Not in this profile's list: used as typed.</p>
		{/if}
	{/if}
</div>
