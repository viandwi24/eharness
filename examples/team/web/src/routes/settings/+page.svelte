<script lang="ts">
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import BrainIcon from 'phosphor-svelte/lib/Brain';
	import CubeIcon from 'phosphor-svelte/lib/Cube';
	import ChartBarIcon from 'phosphor-svelte/lib/ChartBar';
	import PlugsConnectedIcon from 'phosphor-svelte/lib/PlugsConnected';
	import ShieldCheckIcon from 'phosphor-svelte/lib/ShieldCheck';
	import SlidersIcon from 'phosphor-svelte/lib/Sliders';
	import { api, fieldErrors, getToken, setToken } from '#lib/api/index.js';
	import { auth, signOut } from '#lib/stores/auth.svelte.js';
	import type { components } from '#lib/api/schema.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import * as AllocationBar from '#lib/components/ui/allocation-bar/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import ModelPicker from '#lib/components/app/ModelPicker.svelte';
	import BackupsSettings from '#lib/components/app/BackupsSettings.svelte';
	import StorageSettings from '#lib/components/app/StorageSettings.svelte';
	import PauseSettings from '#lib/components/app/PauseSettings.svelte';
	import ProvidersSettings from '#lib/components/app/ProvidersSettings.svelte';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { StatTile } from '#lib/components/ui/stat-tile/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { providersStore } from '#lib/providers/store.svelte.js';
	import { modeInfo, settingsModeOf, settingsModes } from '#lib/modes.js';
	import { monthText, percentOf, sinceText, sourceLabel } from '#lib/settings/usage.js';
	import { validateGeneral } from '#lib/settings/validate.js';
	import { ALL_KNOBS, KNOB_GROUPS, knobPatch, knobText } from '#lib/settings/knobs.js';
	import WarningIcon from 'phosphor-svelte/lib/Warning';
	import TimerIcon from 'phosphor-svelte/lib/Timer';
	import DatabaseIcon from 'phosphor-svelte/lib/Database';
	import ArchiveIcon from 'phosphor-svelte/lib/Archive';
	import HardDrivesIcon from 'phosphor-svelte/lib/HardDrives';
	import { isTimezone, timezoneOptions } from '#lib/heartbeat/model.js';
	import { applyTeamZone } from '#lib/stores/team-zone.svelte.js';
	import { formatDateTime } from '#lib/time.js';
	import { AUTO_THRESHOLD } from '#lib/connectors/tool-access.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live, reconnectLive } from '#lib/stores/live.svelte.js';
	import { formatUsd } from '#lib/time.js';

	type Settings = components['schemas']['Settings'];

	const sections = [
		{ id: 'general', label: 'General', icon: SlidersIcon },
		{ id: 'providers', label: 'Providers', icon: CubeIcon },
		{ id: 'models', label: 'Models', icon: BrainIcon },
		{ id: 'limits', label: 'Limits', icon: TimerIcon },
		{ id: 'data', label: 'Data retention', icon: DatabaseIcon },
		{ id: 'backups', label: 'Backups', icon: ArchiveIcon },
		{ id: 'storage', label: 'Storage', icon: HardDrivesIcon },
		{ id: 'usage', label: 'Usage', icon: ChartBarIcon },
		{ id: 'rules', label: 'Saved rules', icon: ShieldCheckIcon },
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
	let teamName = $state('');
	let worksRoot = $state('/library/works');
	let classifierProfile = $state<string | null>(null);
	let classifierModel = $state<string | null>(null);
	let searchProfile = $state<string | null>(null);
	let searchModel = $state<string | null>(null);
	/** What is typed in each numeric knob (see lib/settings/knobs.ts). */
	let knobTexts = $state<Record<string, string>>({});
	let errors = $state<Record<string, string>>({});
	let formError = $state('');
	let saving = $state(false);

	const storedKnobs = (s: Settings): Record<string, number | null> => Object.fromEntries(ALL_KNOBS.map((k) => [k.key, (s as unknown as Record<string, number | null>)[k.key] ?? null]));
	const knobsDirty = $derived.by(() => {
		const s = settings;
		return !!s && ALL_KNOBS.some((k) => String(knobTexts[k.key] ?? '').trim() !== knobText(k, storedKnobs(s)[k.key] ?? null));
	});

	const dirty = $derived(
		!!settings &&
			(knobsDirty ||
				teamName.trim() !== (settings.teamName ?? '') ||
				worksRoot.trim() !== (settings.worksRoot ?? '/library/works') ||
				classifierProfile !== settings.classifierProfile ||
				classifierModel !== settings.classifierModel ||
				searchProfile !== settings.searchProfile ||
				searchModel !== settings.searchModel ||
				mode !== settingsModeOf(settings.defaultPermissionMode) ||
				toolAccess !== settings.toolAccess ||
				String(budget ?? '').trim() !== (settings.budgetUsd === null ? '' : String(settings.budgetUsd)) ||
				String(spawnCap ?? '').trim() !== String(settings.spawnCap) ||
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
		teamName = s.teamName ?? '';
		worksRoot = s.worksRoot ?? '/library/works';
		classifierProfile = s.classifierProfile;
		classifierModel = s.classifierModel;
		searchProfile = s.searchProfile;
		searchModel = s.searchModel;
		const stored = storedKnobs(s);
		knobTexts = Object.fromEntries(ALL_KNOBS.map((k) => [k.key, knobText(k, stored[k.key] ?? null)]));
	}

	// --- models in use (`GET /settings/models`) ------------------------------------------------
	let modelsInfo = $state<components['schemas']['SettingsModels'] | null>(null);
	async function loadModels(): Promise<void> {
		try {
			modelsInfo = await api.get('/settings/models');
		} catch {
			modelsInfo = null;
		}
	}
	const sourceText = (s: string): string => (s === 'setting' ? 'picked' : s === 'env' ? 'from TEAM_MODEL' : s === 'built-in' ? 'built-in fallback' : 'follows the agent');

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

	// --- code sandbox (`GET /settings/code`) -----------------------------------------------------
	let codeSandbox = $state<components['schemas']['CodeSandbox'] | null>(null);
	const codeSummary = $derived(
		!codeSandbox
			? ''
			: codeSandbox.driver === 'off'
				? 'Code sandbox: off'
				: `Code sandbox: ${codeSandbox.python ? `Python ${codeSandbox.python}` : 'Python (version unknown)'} · ${codeSandbox.driver} · ${codeSandbox.isolated ? 'isolated' : `not isolated (${codeSandbox.label})`}${codeSandbox.install === 'off' ? '' : ` · installs: ${codeSandbox.install}`}`
	);
	const remoteSummary = $derived(
		codeSandbox?.remote
			? `Remote sandbox: ${codeSandbox.remote.host} · ${codeSandbox.remote.python ? `Python ${codeSandbox.remote.python}` : 'Python (version unknown)'} · ${codeSandbox.remote.label}`
			: codeSandbox?.remote === null
				? 'Remote sandbox: connected but not reachable right now'
				: ''
	);
	async function loadCodeSandbox(): Promise<void> {
		try {
			codeSandbox = await api.get('/settings/code');
		} catch {
			codeSandbox = null;
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
		const kp = settings ? knobPatch(knobTexts, storedKnobs(settings)) : ({ ok: true, patch: {} } as const);
		if (!kp.ok) {
			errors = kp.errors;
			return;
		}
		errors = {};
		saving = true;
		try {
			// only the new knobs that changed are sent: an untouched one keeps following its initial value
			const extra: Record<string, unknown> = { ...kp.patch };
			if (settings && teamName.trim() !== (settings.teamName ?? '')) extra.teamName = teamName.trim() || null;
			if (settings && worksRoot.trim() !== (settings.worksRoot ?? '/library/works')) extra.worksRoot = worksRoot.trim() || '/library/works';
			if (settings && (classifierModel !== settings.classifierModel || classifierProfile !== settings.classifierProfile)) {
				extra.classifierModel = classifierModel || null;
				extra.classifierProfile = classifierProfile || null;
			}
			if (settings && (searchModel !== settings.searchModel || searchProfile !== settings.searchProfile)) {
				extra.searchModel = searchModel || null;
				extra.searchProfile = searchProfile || null;
			}
			const saved = await api.patch('/settings', { body: { defaultPermissionMode: mode, toolAccess, budgetUsd: v.value.budgetUsd, spawnCap: v.value.spawnCap, timezone: v.value.timezone, defaultModel: model || null, defaultProfile: profile || null, ...extra } });
			fill(saved);
			void loadModels();
			toast.success('Settings saved');
			// every time in the app follows the team timezone (re-renders the page when it changed)
			applyTeamZone(saved.timezone);
		} catch (err) {
			errors = fieldErrors(err);
			formError = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	// --- usage -----------------------------------------------------------------------------
	// `GET /usage`: chats (every thread), tasks, delegated work, routine and program runs
	let usage = $state<components['schemas']['WorkspaceUsage'] | null>(null);
	let usageError = $state('');
	let useq = 0;
	async function loadUsage(): Promise<void> {
		const mine = ++useq;
		try {
			const r = await api.get('/usage');
			if (mine !== useq) return;
			usage = r;
			usageError = '';
		} catch (e) {
			if (mine === useq) usageError = e instanceof Error ? e.message : 'Could not load usage';
		}
	}

	const costSegments = $derived(
		(usage?.agents ?? [])
			.filter((r) => r.total.costUsd > 0)
			.sort((a, b) => b.total.costUsd - a.total.costUsd)
			.slice(0, 5)
			.map((r) => ({ label: r.name, value: Math.max(1, percentOf(r.total.costUsd, usage?.total.costUsd ?? 0)) }))
	);

	// --- saved rules (the allow rules of each agent) ---------------------------------------------
	async function removeRule(a: components['schemas']['Agent'], rule: string): Promise<void> {
		try {
			await agentsStore.update(a.id, { rules: { ...a.rules, allow: a.rules.allow.filter((r) => r !== rule) } });
			toast.success(`Removed ${rule} from ${a.name}`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not remove the rule');
		}
	}

	// --- connection ------------------------------------------------------------------------
	let token = $state(getToken() ?? '');
	let tokenSaved = $state(getToken() ?? '');
	const tokenDirty = $derived(token.trim() !== tokenSaved);

	function saveToken(e: SubmitEvent): void {
		e.preventDefault();
		setToken(token.trim());
		tokenSaved = token.trim();
		toast.success('Token saved in this browser');
		reconnectLive(); // the stream, the lists and every screen refetch with the new token: no reload
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
			void loadCodeSandbox();
			void loadModels();
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
				{:else if section === 'general' || section === 'models' || section === 'limits' || section === 'data'}
					{#if section === 'general'}<div class="mb-4"><PauseSettings /></div>{/if}
					<form id="general" onsubmit={save} class="flex flex-col gap-4">
						{#if section === 'general'}
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
											<ModelPicker id="s-model" bind:profileId={profile} bind:modelId={model} defaultLabel="Server default" fallback={null} />
										{/if}
										<Field.Description>The provider profile and model of agents that do not pick their own. Profiles are managed under Providers.</Field.Description>
										{#if modelsInfo?.workspaceDefault}
											<p class="text-xs" data-testid="workspace-default-model">Agents without a model of their own run on <span class="font-mono">{modelsInfo.workspaceDefault.profileLabel} · {modelsInfo.workspaceDefault.modelId}</span> ({sourceText(modelsInfo.workspaceDefault.source)}).</p>
										{/if}
										{#each modelsInfo?.warnings ?? [] as w (w)}
											<p class="flex items-start gap-1.5 text-xs text-warning-text" role="status" data-testid="model-fallback-warning"><WarningIcon class="mt-px size-3.5 shrink-0" />{w}</p>
										{/each}
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
									<Field.Field>
										<Field.Label for="s-team-name">Team name</Field.Label>
										<Input id="s-team-name" bind:value={teamName} placeholder="None" maxlength={100} disabled={!settings} class="max-w-sm" />
										<Field.Description>Given to agents in chats ("You are the assistant of this team"). Empty means none.</Field.Description>
									</Field.Field>
									<Field.Field>
										<Field.Label for="s-works-root">Daily journal folder</Field.Label>
										<Input id="s-works-root" bind:value={worksRoot} placeholder="/library/works" maxlength={200} disabled={!settings} class="max-w-sm font-mono text-xs" />
										<Field.Description>Agents keep the day's follow-ups and notes in <span class="font-mono">{worksRoot || '/library/works'}/YYYY/MM/DD.md</span>, and program runs and heartbeat findings add a line with a link to their report.</Field.Description>
									</Field.Field>
									<Field.Field data-invalid={!!errors.timezone}>
										<Field.Label for="s-tz">Team timezone</Field.Label>
										<Input id="s-tz" bind:value={timezone} list="settings-zones" placeholder="UTC" disabled={!settings} aria-invalid={!!errors.timezone} class="max-w-sm" />
										<datalist id="settings-zones">
											{#each timezoneOptions() as z (z)}<option value={z}></option>{/each}
										</datalist>
										<Field.Description>
											The one clock of the team: every time in this app, what agents read as "now" and "today", routines and reminders, chat message times, the daily digest and the heartbeat's active hours. The server's own timezone until you set one; a routine, a heartbeat or the digest can name its own.
											{#if settings && isTimezone(timezone.trim())}<span class="mt-1 block">Now in {timezone.trim()}: {formatDateTime(Date.now(), { dateStyle: 'full', timeStyle: 'short', timeZone: timezone.trim() })}</span>{/if}
										</Field.Description>
										{#if errors.timezone}<Field.Error>{errors.timezone}</Field.Error>{/if}
									</Field.Field>
								</Field.Group>
								{#if formError && !Object.keys(errors).length}<p class="mt-4 text-sm text-destructive-text" role="alert">{formError}</p>{/if}
							</Card.Content>
						</Card.Root>

						<Card.Root>
							<Card.Header>
								<Card.Title>Code sandbox</Card.Title>
								<Card.Description>Where agents with "Run Python" (Files &amp; Sandbox) run their scripts. Set by the server's TEAM_CODE_* variables. A connected Remote sandbox (Connectors) takes over "Run Python" for the agents that have it on.</Card.Description>
							</Card.Header>
							<Card.Content>
								{#if codeSandbox}
									<p class="text-sm" data-testid="code-sandbox">{codeSummary}</p>
									<p class="mt-1 text-xs text-muted-foreground">{codeSandbox.label}</p>
									{#if remoteSummary}<p class="mt-3 text-sm" data-testid="remote-sandbox">{remoteSummary}</p>{/if}
								{:else}
									<p class="text-sm text-muted-foreground">Loading…</p>
								{/if}
							</Card.Content>
						</Card.Root>

						{/if}

						{#if section === 'models'}
							<Card.Root>
								<Card.Header>
									<Card.Title>Models for background work</Card.Title>
									<Card.Description>Calls the agent does not make itself. Each one runs on the model shown here: none silently uses a different one.</Card.Description>
								</Card.Header>
								<Card.Content>
									<Field.Group>
										{#each modelsInfo?.warnings ?? [] as w (w)}
											<p class="flex items-start gap-1.5 text-sm text-warning-text" role="status"><WarningIcon class="mt-0.5 size-4 shrink-0" />{w}</p>
										{/each}
										<Field.Field>
											<Field.Label for="s-classifier">Auto mode classifier</Field.Label>
											{#if !settings}<Skeleton class="h-9 w-full max-w-sm" />{:else}
												<ModelPicker id="s-classifier" bind:profileId={classifierProfile} bind:modelId={classifierModel} defaultLabel="Same as the agent" fallback={null} showEffective={false} />
											{/if}
											<Field.Description>Decides actions in Auto mode. "Same as the agent" judges with the model of the agent whose action it reviews, so it never costs more than the agent. A small, cheap model is usually enough.</Field.Description>
										</Field.Field>
										<Field.Field>
											<Field.Label for="s-search">Web search</Field.Label>
											{#if !settings}<Skeleton class="h-9 w-full max-w-sm" />{:else}
												<ModelPicker id="s-search" bind:profileId={searchProfile} bind:modelId={searchModel} defaultLabel="Built-in search model" fallback={null} showEffective={false} />
											{/if}
											<Field.Description>Answers the web_search tool with the provider's own search (OpenRouter or AI Gateway profiles). The built-in model is a small fast one.</Field.Description>
										</Field.Field>
									</Field.Group>
								</Card.Content>
							</Card.Root>
							<Card.Root>
								<Card.Header>
									<Card.Title>Models in use</Card.Title>
									<Card.Description>What each kind of call runs on right now (saved settings).</Card.Description>
								</Card.Header>
								<Card.Content>
									{#if !modelsInfo}
										<Skeleton class="h-24 w-full" />
									{:else}
										<div class="overflow-hidden rounded-lg border border-border" data-testid="models-in-use">
											<Table.Root>
												<Table.Header>
													<Table.Row class="hover:bg-transparent">
														<Table.Head>Call</Table.Head>
														<Table.Head>Model</Table.Head>
														<Table.Head>Source</Table.Head>
													</Table.Row>
												</Table.Header>
												<Table.Body>
													<Table.Row>
														<Table.Cell>Agents without their own model</Table.Cell>
														<Table.Cell class="font-mono text-xs">{modelsInfo.workspaceDefault ? `${modelsInfo.workspaceDefault.profileLabel} · ${modelsInfo.workspaceDefault.modelId}` : 'No provider configured'}</Table.Cell>
														<Table.Cell class="text-xs text-muted-foreground">{modelsInfo.workspaceDefault ? sourceText(modelsInfo.workspaceDefault.source) : ''}</Table.Cell>
													</Table.Row>
													{#each modelsInfo.background as r (r.key)}
														<Table.Row>
															<Table.Cell>{r.label}</Table.Cell>
															<Table.Cell class="font-mono text-xs">{r.modelId ? `${r.profileLabel ?? r.profileId ?? ''} · ${r.modelId}` : r.source === 'agent' ? "The agent's own model" : r.source === 'built-in' ? 'None: no provider can run it' : '—'}</Table.Cell>
															<Table.Cell class="text-xs text-muted-foreground">{sourceText(r.source)}<span class="block">{r.note}</span></Table.Cell>
														</Table.Row>
													{/each}
												</Table.Body>
											</Table.Root>
										</div>
										{#if modelsInfo.agentsOnFallback.length}
											<p class="mt-3 text-xs text-muted-foreground">On the built-in fallback: {modelsInfo.agentsOnFallback.join(', ')}.</p>
										{/if}
									{/if}
								</Card.Content>
							</Card.Root>
						{/if}

						{#each KNOB_GROUPS.filter((g) => (section === 'limits' && g.id !== 'retention') || (section === 'data' && g.id === 'retention')) as g (g.id)}
							<Card.Root>
								<Card.Header>
									<Card.Title>{g.title}</Card.Title>
									<Card.Description>{g.description} Defaults come from the server's environment on first start; what you save here wins.</Card.Description>
								</Card.Header>
								<Card.Content>
									<Field.Group>
										{#each g.knobs as k (k.key)}
											<Field.Field data-invalid={!!errors[k.key]}>
												<Field.Label for="s-{k.key}">{k.label}{k.unit ? ` (${k.unit})` : ''}</Field.Label>
												<Input id="s-{k.key}" type="number" min={k.min} max={k.max} step={k.integer ? 1 : 'any'} inputmode="decimal" bind:value={knobTexts[k.key]} placeholder={k.placeholder ?? ''} disabled={!settings} aria-invalid={!!errors[k.key]} class="max-w-40" />
												<Field.Description>{k.description}</Field.Description>
												{#if errors[k.key]}<Field.Error>{errors[k.key]}</Field.Error>{/if}
											</Field.Field>
										{/each}
									</Field.Group>
									{#if formError && !Object.keys(errors).length}<p class="mt-4 text-sm text-destructive-text" role="alert">{formError}</p>{/if}
								</Card.Content>
							</Card.Root>
						{/each}

						<div class="sticky bottom-0 -mx-1 flex items-center justify-end gap-2 rounded-xl border border-border bg-card/95 px-3 py-2 shadow-sm backdrop-blur {dirty ? '' : 'hidden'}" role="status">
							<span class="mr-auto text-[13px] text-muted-foreground">Unsaved changes</span>
							<Button type="button" variant="ghost" size="sm" onclick={discard} disabled={saving}>Discard</Button>
							<Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
						</div>
					</form>
				{:else if section === 'backups'}
					<BackupsSettings />
				{:else if section === 'storage'}
					<StorageSettings />
				{:else if section === 'usage'}
					<Card.Root>
						<Card.Header>
							<Card.Title>Usage</Card.Title>
							<Card.Description>
								This month's spend and budget come from the budget ledger; the breakdown below comes from the call log (the Logs page). A call is one model request; a turn or a run makes several.
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
								{#if usage.month}
									<div class="grid grid-cols-2 gap-3 lg:grid-cols-3" data-testid="usage-month">
										<StatTile class="w-full px-4 py-3.5" label="Spent this month" value={formatUsd(usage.month.spentUsd)} />
										<StatTile class="w-full px-4 py-3.5" label="Monthly budget" value={usage.month.limitUsd === null ? 'No limit' : formatUsd(usage.month.limitUsd)} />
									</div>
									<p class="sr-only">{monthText(usage.month, formatUsd)}</p>
								{/if}
								<p class="text-[13px] text-muted-foreground" data-testid="usage-since">{sinceText(usage.since)}</p>
								<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
									<StatTile class="w-full px-4 py-3.5" label="Cost (breakdown)" value={formatUsd(usage.total.costUsd)} />
									<StatTile class="w-full px-4 py-3.5" label="Tokens" value={num(usage.total.tokens)} />
									<StatTile class="w-full px-4 py-3.5" label="Model calls" value={num(usage.total.calls)} />
									<StatTile class="w-full px-4 py-3.5" label="Turns + runs" value={num(usage.total.count)} />
								</div>
								<div class="flex flex-col gap-1.5">
									<h3 class="text-[13px] font-medium">By source</h3>
									<div class="overflow-hidden rounded-lg border border-border" data-testid="usage-by-source">
										<Table.Root>
											<Table.Header>
												<Table.Row class="hover:bg-transparent">
													<Table.Head>Source</Table.Head>
													<Table.Head class="text-right">Turns / runs</Table.Head>
													<Table.Head class="text-right">Calls</Table.Head>
													<Table.Head class="text-right">Tokens</Table.Head>
													<Table.Head class="text-right">Cost</Table.Head>
												</Table.Row>
											</Table.Header>
											<Table.Body>
												{#each usage.bySource as s (s.source)}
													{@const l = sourceLabel(s.source)}
													<Table.Row>
														<Table.Cell>{l.label}</Table.Cell>
														<Table.Cell class="text-right font-mono text-xs">{num(s.count)} {l.unit}</Table.Cell>
														<Table.Cell class="text-right font-mono text-xs">{num(s.calls)}</Table.Cell>
														<Table.Cell class="text-right font-mono text-xs">{num(s.tokens)}</Table.Cell>
														<Table.Cell class="text-right font-mono text-xs">{formatUsd(s.costUsd)}</Table.Cell>
													</Table.Row>
												{/each}
											</Table.Body>
										</Table.Root>
									</div>
								</div>
								{#if costSegments.length > 1}
									<div class="flex flex-col gap-1.5">
										<h3 class="text-[13px] font-medium">Cost by agent</h3>
										<AllocationBar.AllocationBar segments={costSegments} />
									</div>
								{/if}
								{#if !usage.agents.length}
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
													<Table.Head class="text-right">Turns + runs</Table.Head>
													<Table.Head class="text-right">Calls</Table.Head>
													<Table.Head class="text-right">Tokens</Table.Head>
													<Table.Head class="text-right">Cost</Table.Head>
												</Table.Row>
											</Table.Header>
											<Table.Body>
												{#each usage.agents as r (r.id)}
													<Table.Row>
														<Table.Cell>
															<span class="flex items-center gap-2"><AgentAvatar seed={r.id} color={r.color} size={18} />{r.name}</span>
														</Table.Cell>
														<Table.Cell class="text-right font-mono text-xs">{num(r.total.count)}</Table.Cell>
														<Table.Cell class="text-right font-mono text-xs">{num(r.total.calls)}</Table.Cell>
														<Table.Cell class="text-right font-mono text-xs">{num(r.total.tokens)}</Table.Cell>
														<Table.Cell class="text-right font-mono text-xs">{formatUsd(r.total.costUsd)}</Table.Cell>
													</Table.Row>
												{/each}
											</Table.Body>
										</Table.Root>
									</div>
								{/if}
							{/if}
						</Card.Content>
					</Card.Root>
				{:else if section === 'rules'}
					<Card.Root>
						<Card.Header>
							<Card.Title>Saved rules</Card.Title>
							<Card.Description>Tools an agent may use without asking. "Always allow" in an approval saves one here (for this agent or all agents). Remove a rule and the agent asks again.</Card.Description>
						</Card.Header>
						<Card.Content class="flex flex-col gap-4" data-testid="saved-rules">
							{#each agentsStore.state.agents.filter((a) => !a.archivedAt) as a (a.id)}
								<div class="flex flex-col gap-1.5">
									<span class="flex items-center gap-2 text-[13px] font-medium"><AgentAvatar seed={a.id} color={a.color} size={18} />{a.name}</span>
									{#if !a.rules.allow.length}
										<p class="text-xs text-muted-foreground">No saved rules.</p>
									{:else}
										<ul class="flex flex-wrap gap-1.5">
											{#each a.rules.allow as rule (rule)}
												<li class="flex items-center gap-1 rounded bg-muted py-0.5 pr-0.5 pl-1.5 font-mono text-[11px]">
													{rule}
													<button type="button" class="rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Remove rule {rule} of {a.name}" onclick={() => void removeRule(a, rule)}>×</button>
												</li>
											{/each}
										</ul>
									{/if}
								</div>
							{/each}
						</Card.Content>
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
									<Field.Description>
										{#if auth.required}
											This server asks for a login, so the browser does not need a token. It is only for scripts and API clients (they send it as a Bearer token). Stored in this browser only.
										{:else}
											Stored in this browser only. PUBLIC_TEAM_TOKEN overrides it.
										{/if}
									</Field.Description>
								</Field.Field>
							</Card.Content>
							<Card.Footer class="justify-end gap-2 border-t border-border pt-4">
								<Button type="submit" size="sm" disabled={!tokenDirty}>Save token</Button>
							</Card.Footer>
						</Card.Root>
					</form>
					{#if auth.required}
						<Card.Root class="mt-4">
							<Card.Header>
								<Card.Title>Session</Card.Title>
								<Card.Description>You are signed in with the workspace password. The session lasts 30 days in this browser.</Card.Description>
							</Card.Header>
							<Card.Footer class="justify-end border-t border-border pt-4">
								<Button type="button" variant="outline" size="sm" onclick={() => void signOut()}>Log out</Button>
							</Card.Footer>
						</Card.Root>
					{/if}
				{/if}
		</PageBody>
	</div>
</div>
