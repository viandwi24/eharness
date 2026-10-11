<script lang="ts">
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import BrainIcon from 'phosphor-svelte/lib/Brain';
	import CubeIcon from 'phosphor-svelte/lib/Cube';
	import ChartBarIcon from 'phosphor-svelte/lib/ChartBar';
	import PlugsConnectedIcon from 'phosphor-svelte/lib/PlugsConnected';
	import SlidersIcon from 'phosphor-svelte/lib/Sliders';
	import { api, fieldErrors, getToken, setToken } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import MemoryEditor from '#lib/components/app/MemoryEditor.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import * as AllocationBar from '#lib/components/ui/allocation-bar/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import ModelPicker from '#lib/components/app/ModelPicker.svelte';
	import ProvidersSettings from '#lib/components/app/ProvidersSettings.svelte';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { StatTile } from '#lib/components/ui/stat-tile/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { providersStore } from '#lib/providers/store.svelte.js';
	import { modeInfo, settingsModeOf, settingsModes } from '#lib/modes.js';
	import { sumUsage, type Usage } from '#lib/settings/usage.js';
	import { validateGeneral } from '#lib/settings/validate.js';
	import { timezoneOptions } from '#lib/heartbeat/model.js';
	import { AUTO_THRESHOLD } from '#lib/connectors/tool-access.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { formatUsd } from '#lib/time.js';

	type Settings = components['schemas']['Settings'];

	const sections = [
		{ id: 'general', label: 'General', icon: SlidersIcon },
		{ id: 'providers', label: 'Providers', icon: CubeIcon },
		{ id: 'usage', label: 'Usage', icon: ChartBarIcon },
		{ id: 'memory', label: 'Memory', icon: BrainIcon },
		{ id: 'connection', label: 'Connection', icon: PlugsConnectedIcon }
	] as const;
	type SectionId = (typeof sections)[number]['id'];

	const section = $derived<SectionId>(sections.find((s) => s.id === page.url.searchParams.get('section'))?.id ?? 'general');

	// --- general ---------------------------------------------------------------------------
	let settings = $state<Settings | null>(null);
	let loadError = $state('');
	let mode = $state<Settings['defaultPermissionMode']>('default');
	let budget = $state('');
	let spawnCap = $state('4');
	let timezone = $state('UTC');
	let toolAccess = $state<Settings['toolAccess']>('auto');
	let model = $state<string | null>(null);
	let profile = $state<string | null>(null);
	let errors = $state<Record<string, string>>({});
	let formError = $state('');
	let saving = $state(false);

	const dirty = $derived(
		!!settings &&
			(mode !== settingsModeOf(settings.defaultPermissionMode) ||
				toolAccess !== settings.toolAccess ||
				budget.trim() !== (settings.budgetUsd === null ? '' : String(settings.budgetUsd)) ||
				spawnCap.trim() !== String(settings.spawnCap) ||
				timezone.trim() !== settings.timezone ||
				model !== settings.defaultModel ||
				profile !== settings.defaultProfile)
	);

	function fill(s: Settings): void {
		settings = s;
		mode = settingsModeOf(s.defaultPermissionMode);
		budget = s.budgetUsd === null ? '' : String(s.budgetUsd);
		spawnCap = String(s.spawnCap);
		timezone = s.timezone;
		toolAccess = s.toolAccess;
		model = s.defaultModel;
		profile = s.defaultProfile;
	}

	async function loadSettings(): Promise<void> {
		try {
			const s = await api.get('/settings');
			// Another tab's change refreshes the form only when there is nothing unsaved here.
			if (!settings || !dirty) fill(s);
			else settings = s;
			loadError = '';
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'Could not load settings';
		}
	}

	function discard(): void {
		if (settings) fill(settings);
		errors = {};
		formError = '';
	}

	async function save(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		formError = '';
		const v = validateGeneral({ budget, spawnCap, timezone });
		if (!v.ok) {
			errors = v.errors;
			return;
		}
		errors = {};
		saving = true;
		try {
			fill(await api.patch('/settings', { body: { defaultPermissionMode: mode, toolAccess, budgetUsd: v.value.budgetUsd, spawnCap: v.value.spawnCap, timezone: v.value.timezone, defaultModel: model || null, defaultProfile: profile || null } }));
			toast.success('Settings saved');
		} catch (err) {
			errors = fieldErrors(err);
			formError = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	// --- usage -----------------------------------------------------------------------------
	let usage = $state<{ total: Usage; rows: { id: string; name: string; color?: string; usage: Usage }[] } | null>(null);
	let usageError = $state('');
	let useq = 0;
	async function loadUsage(): Promise<void> {
		const mine = ++useq;
		try {
			if (!agentsStore.state.loaded) await agentsStore.load();
			const rows = await Promise.all(
				agentsStore.state.agents.map(async (a) => ({
					id: a.id,
					name: a.name,
					color: a.color,
					usage: (await api.get('/agents/{id}/stats', { params: { id: a.id } })).usage
				}))
			);
			if (mine !== useq) return;
			usage = { total: sumUsage(rows.map((r) => r.usage)), rows };
			usageError = '';
		} catch (e) {
			if (mine === useq) usageError = e instanceof Error ? e.message : 'Could not load usage';
		}
	}

	const costSegments = $derived(
		(usage?.rows ?? [])
			.filter((r) => r.usage.costUsd > 0)
			.sort((a, b) => b.usage.costUsd - a.usage.costUsd)
			.slice(0, 5)
			.map((r) => ({ label: r.name, value: Math.max(1, Math.round((r.usage.costUsd / (usage?.total.costUsd || 1)) * 100)) }))
	);

	// --- connection ------------------------------------------------------------------------
	let token = $state(getToken() ?? '');
	let tokenSaved = $state(getToken() ?? '');
	const tokenDirty = $derived(token.trim() !== tokenSaved);

	function saveToken(e: SubmitEvent): void {
		e.preventDefault();
		setToken(token.trim());
		tokenSaved = token.trim();
		toast.success('Token saved in this browser');
		void agentsStore.load();
		void loadSettings();
		void loadUsage();
	}

	// Initial load, and a refresh when another tab changes settings.
	$effect(() => {
		void providersStore.load();
		void live.state.revs.settings;
		untrack(() => {
			void loadSettings();
			void loadUsage();
		});
	});

	const num = (n: number): string => n.toLocaleString();
	const modeHint = $derived(modeInfo(settingsModes.find((m) => m.id === mode)?.mode ?? 'manual').hint);
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Settings" description="Workspace-wide defaults for every agent." />

	<div class="flex min-h-0 flex-1 flex-col md:flex-row">
		<nav aria-label="Settings sections" class="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 md:w-52 md:flex-col md:overflow-visible md:border-r md:border-b-0 md:p-3">
			{#each sections as s (s.id)}
				<a
					href="?section={s.id}"
					aria-current={s.id === section ? 'page' : undefined}
					class="flex h-8 shrink-0 items-center gap-2 rounded-[7px] px-2.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-[current=page]:bg-accent aria-[current=page]:text-foreground"
				>
					<s.icon class="size-4" />{s.label}
				</a>
			{/each}
		</nav>

		<PageBody size={section === 'providers' ? 'wide' : 'narrow'}>
				{#if section === 'providers'}
					<ProvidersSettings />
				{:else if section === 'general'}
					<form id="general" onsubmit={save} class="flex flex-col gap-4">
						<Card.Root>
							<Card.Header>
								<Card.Title>General</Card.Title>
								<Card.Description>Defaults used by chats and routines whose agent does not set its own.</Card.Description>
							</Card.Header>
							<Card.Content>
								{#if loadError}
									<p class="mb-4 text-sm text-destructive-text" role="alert">{loadError}</p>
								{/if}
								<Field.Group>
									<Field.Field data-invalid={!!errors.defaultModel}>
										<Field.Label for="s-model">Default model</Field.Label>
										{#if !settings}<Skeleton class="h-9 w-full max-w-sm" />{:else}
											<ModelPicker id="s-model" bind:profileId={profile} bind:modelId={model} defaultLabel="Server default" />
										{/if}
										<Field.Description>The provider profile and model of agents that do not pick their own. Profiles are managed under Providers.</Field.Description>
										{#if errors.defaultModel}<Field.Error>{errors.defaultModel}</Field.Error>{/if}
									</Field.Field>
									<Field.Field data-invalid={!!errors.defaultPermissionMode}>
										<Field.Label for="s-mode">Default permission mode</Field.Label>
										{#if !settings}<Skeleton class="h-9 w-full max-w-sm" />{:else}
											<NativeSelect id="s-mode" bind:value={mode} class="w-full max-w-sm">
												{#each settingsModes as m (m.id)}
													<NativeSelectOption value={m.id}>{modeInfo(m.mode).label}</NativeSelectOption>
												{/each}
											</NativeSelect>
										{/if}
										<Field.Description>The starting mode of every chat whose agent has no mode of its own, and of routine runs. {modeHint}</Field.Description>
										{#if errors.defaultPermissionMode}<Field.Error>{errors.defaultPermissionMode}</Field.Error>{/if}
									</Field.Field>
									<Field.Field>
										<Field.Label for="s-tool-access">Tool access</Field.Label>
										{#if !settings}<Skeleton class="h-9 w-full max-w-sm" />{:else}
											<NativeSelect id="s-tool-access" bind:value={toolAccess} class="w-full max-w-sm">
												<NativeSelectOption value="auto">Auto</NativeSelectOption>
												<NativeSelectOption value="on-demand">On demand</NativeSelectOption>
											</NativeSelect>
										{/if}
										<Field.Description>How the tools of connected apps reach the model. Auto loads them up front, and switches to on demand at {AUTO_THRESHOLD} or more tools. On demand lets the model search for them: fewer tokens with many connectors. Agents can override this; built-in connectors always load.</Field.Description>
									</Field.Field>
									<Field.Field data-invalid={!!errors.budgetUsd}>
										<Field.Label for="s-budget">Monthly budget (USD)</Field.Label>
										<Input id="s-budget" type="number" min="0" step="0.01" inputmode="decimal" bind:value={budget} placeholder="No limit" disabled={!settings} aria-invalid={!!errors.budgetUsd} class="max-w-sm" />
										<Field.Description>Cost is always tracked. With a limit, agents stop starting turns when it is reached.</Field.Description>
										{#if errors.budgetUsd}<Field.Error>{errors.budgetUsd}</Field.Error>{/if}
									</Field.Field>
									<Field.Field data-invalid={!!errors.spawnCap}>
										<Field.Label for="s-cap">Delegation cap</Field.Label>
										<Input id="s-cap" type="number" min="1" max="32" step="1" inputmode="numeric" bind:value={spawnCap} disabled={!settings} aria-invalid={!!errors.spawnCap} class="max-w-32" />
										<Field.Description>How many delegated tasks the lead runs at once (1 to 32).</Field.Description>
										{#if errors.spawnCap}<Field.Error>{errors.spawnCap}</Field.Error>{/if}
									</Field.Field>
									<Field.Field data-invalid={!!errors.timezone}>
										<Field.Label for="s-tz">Team timezone</Field.Label>
										<Input id="s-tz" bind:value={timezone} list="settings-zones" placeholder="UTC" disabled={!settings} aria-invalid={!!errors.timezone} class="max-w-sm" />
										<datalist id="settings-zones">
											{#each timezoneOptions() as z (z)}<option value={z}></option>{/each}
										</datalist>
										<Field.Description>The default timezone of the heartbeat's active hours and of the daily digest time. The server's own timezone until you set one; a heartbeat or the digest can use its own.</Field.Description>
										{#if errors.timezone}<Field.Error>{errors.timezone}</Field.Error>{/if}
									</Field.Field>
								</Field.Group>
								{#if formError && !Object.keys(errors).length}<p class="mt-4 text-sm text-destructive-text" role="alert">{formError}</p>{/if}
							</Card.Content>
						</Card.Root>

						<div class="sticky bottom-0 -mx-1 flex items-center justify-end gap-2 rounded-xl border border-border bg-card/95 px-3 py-2 shadow-sm backdrop-blur {dirty ? '' : 'hidden'}" role="status">
							<span class="mr-auto text-[13px] text-muted-foreground">Unsaved changes</span>
							<Button type="button" variant="ghost" size="sm" onclick={discard} disabled={saving}>Discard</Button>
							<Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
						</div>
					</form>
				{:else if section === 'usage'}
					<Card.Root>
						<Card.Header>
							<Card.Title>Usage</Card.Title>
							<Card.Description>
								All-time totals across agent chats.
								{#if settings?.budgetUsd !== null && settings?.budgetUsd !== undefined}Monthly budget: {formatUsd(settings.budgetUsd)}.{/if}
							</Card.Description>
						</Card.Header>
						<Card.Content class="flex flex-col gap-5">
							{#if usageError}
								<p class="text-sm text-destructive-text" role="alert">{usageError}</p>
							{:else if !usage}
								<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
									{#each [0, 1, 2, 3] as n (n)}<Skeleton class="h-24 rounded-xl" />{/each}
								</div>
							{:else}
								<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
									<StatTile class="w-full px-4 py-3.5" label="Cost" value={formatUsd(usage.total.costUsd)} />
									<StatTile class="w-full px-4 py-3.5" label="Turns" value={num(usage.total.turns)} />
									<StatTile class="w-full px-4 py-3.5" label="Input tokens" value={num(usage.total.inputTokens)} />
									<StatTile class="w-full px-4 py-3.5" label="Output tokens" value={num(usage.total.outputTokens)} />
								</div>
								{#if costSegments.length > 1}
									<div class="flex flex-col gap-1.5">
										<h3 class="text-[13px] font-medium">Cost by agent</h3>
										<AllocationBar.AllocationBar segments={costSegments} />
									</div>
								{/if}
								{#if !usage.rows.length}
									<Empty.Root class="border p-6">
										<Empty.Header>
											<Empty.Title class="text-sm">No agents yet</Empty.Title>
											<Empty.Description>Usage shows up once agents have run.</Empty.Description>
										</Empty.Header>
									</Empty.Root>
								{:else}
									<div class="overflow-hidden rounded-lg border border-border">
										<Table.Root>
											<Table.Header>
												<Table.Row class="hover:bg-transparent">
													<Table.Head>Agent</Table.Head>
													<Table.Head class="text-right">Turns</Table.Head>
													<Table.Head class="text-right">Tokens</Table.Head>
													<Table.Head class="text-right">Cost</Table.Head>
												</Table.Row>
											</Table.Header>
											<Table.Body>
												{#each usage.rows as r (r.id)}
													<Table.Row>
														<Table.Cell>
															<span class="flex items-center gap-2"><AgentAvatar seed={r.id} color={r.color} size={18} />{r.name}</span>
														</Table.Cell>
														<Table.Cell class="text-right font-mono text-xs">{num(r.usage.turns)}</Table.Cell>
														<Table.Cell class="text-right font-mono text-xs">{num(r.usage.totalTokens)}</Table.Cell>
														<Table.Cell class="text-right font-mono text-xs">{formatUsd(r.usage.costUsd)}</Table.Cell>
													</Table.Row>
												{/each}
											</Table.Body>
										</Table.Root>
									</div>
								{/if}
							{/if}
						</Card.Content>
					</Card.Root>
				{:else if section === 'memory'}
					<Card.Root>
						<Card.Header>
							<Card.Title>Workspace memory</Card.Title>
							<Card.Description>
								Shared by every agent. Agents read it each turn; the lead and explicit roles can write it. If an agent edited a file while you were typing, saving shows the conflict.
							</Card.Description>
						</Card.Header>
						<Card.Content><MemoryEditor scope="workspace" /></Card.Content>
					</Card.Root>
				{:else}
					<form onsubmit={saveToken}>
						<Card.Root>
							<Card.Header>
								<Card.Title>Connection</Card.Title>
								<Card.Description>How this browser authenticates with the team server.</Card.Description>
							</Card.Header>
							<Card.Content>
								<Field.Field>
									<Field.Label for="s-token">Server token</Field.Label>
									<Input id="s-token" type="password" bind:value={token} placeholder="TEAM_TOKEN (empty if the server is open)" autocomplete="off" class="max-w-md" />
									<Field.Description>Stored in this browser only. PUBLIC_TEAM_TOKEN overrides it.</Field.Description>
								</Field.Field>
							</Card.Content>
							<Card.Footer class="justify-end gap-2 border-t border-border pt-4">
								<Button type="submit" size="sm" disabled={!tokenDirty}>Save token</Button>
							</Card.Footer>
						</Card.Root>
					</form>
				{/if}
		</PageBody>
	</div>
</div>
