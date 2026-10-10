<script lang="ts">
	import { untrack } from 'svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import MemoryEditor from '#lib/components/app/MemoryEditor.svelte';
	import { api, fieldErrors, getToken, setToken } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { modelOptions } from '#lib/models.js';
	import { modeInfo, settingsModeOf, settingsModes } from '#lib/modes.js';
	import { sumUsage, type Usage } from '#lib/settings/usage.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';

	type Settings = components['schemas']['Settings'];

	let token = $state(getToken() ?? '');
	let tokenSaved = $state(false);

	function saveToken() {
		setToken(token.trim());
		tokenSaved = true;
		void agentsStore.load();
		void loadSettings();
		void loadUsage();
	}

	let settings = $state<Settings | null>(null);
	let loadError = $state('');
	let mode = $state<Settings['defaultPermissionMode']>('default');
	let budget = $state('');
	let spawnCap = $state(4);
	let model = $state('');
	let errors = $state<Record<string, string>>({});
	let formError = $state('');
	let saving = $state(false);

	const models = $derived(
		settings?.defaultModel && !modelOptions.some((m) => m.id === settings?.defaultModel)
			? [...modelOptions, { id: settings.defaultModel, label: settings.defaultModel }]
			: modelOptions
	);

	function fill(s: Settings): void {
		settings = s;
		mode = settingsModeOf(s.defaultPermissionMode);
		budget = s.budgetUsd === null ? '' : String(s.budgetUsd);
		spawnCap = s.spawnCap;
		model = s.defaultModel ?? '';
	}

	async function loadSettings(): Promise<void> {
		try {
			fill(await api.get('/settings'));
			loadError = '';
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'Could not load settings';
		}
	}

	async function save(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		errors = {};
		formError = '';
		const b = budget.trim();
		const n = b === '' ? null : Number(b);
		if (n !== null && (!Number.isFinite(n) || n < 0)) {
			errors = { budgetUsd: 'Enter a positive amount, or leave empty for no limit' };
			return;
		}
		saving = true;
		try {
			fill(await api.patch('/settings', { body: { defaultPermissionMode: mode, budgetUsd: n, spawnCap: Math.floor(spawnCap), defaultModel: model || null } }));
			toast.success('Settings saved');
		} catch (err) {
			errors = fieldErrors(err);
			formError = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	let usage = $state<{ total: Usage; rows: { id: string; name: string; usage: Usage }[] } | null>(null);
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

	// Initial load, and a refresh when another tab changes settings.
	$effect(() => {
		void live.state.revs.settings;
		untrack(() => {
			void loadSettings();
			void loadUsage();
		});
	});

	const usd = (n: number): string => `$${n.toFixed(n < 1 ? 4 : 2)}`;
	const num = (n: number): string => n.toLocaleString();
</script>

<div class="flex min-w-0 flex-1 flex-col overflow-y-auto">
	<PageHeader title="Settings" />
	<div class="flex max-w-2xl flex-col gap-8 p-4 text-sm">
		<form class="flex flex-col gap-3" onsubmit={save}>
			<h2 class="text-base font-medium">Workspace defaults</h2>
			{#if loadError}<p class="text-destructive-text">{loadError}</p>{/if}
			<label class="flex flex-col gap-1">
				<span class="font-medium">Default permission mode</span>
				<NativeSelect bind:value={mode} disabled={!settings}>
					{#each settingsModes as m (m.id)}
						<NativeSelectOption value={m.id}>{modeInfo(m.mode).label}</NativeSelectOption>
					{/each}
				</NativeSelect>
				<span class="text-xs text-muted-foreground">The starting mode of every chat whose agent has no mode of its own (and of routine runs). {modeInfo(settingsModes.find((m) => m.id === mode)?.mode ?? 'manual').hint}</span>
				{#if errors.defaultPermissionMode}<span class="text-xs text-destructive-text">{errors.defaultPermissionMode}</span>{/if}
			</label>
			<label class="flex flex-col gap-1">
				<span class="font-medium">Monthly budget (USD)</span>
				<Input type="number" min="0" step="0.01" bind:value={budget} placeholder="No limit" disabled={!settings} aria-invalid={!!errors.budgetUsd} />
				<span class="text-xs text-muted-foreground">Cost is always tracked; with a limit, agents stop starting turns when it is reached.</span>
				{#if errors.budgetUsd}<span class="text-xs text-destructive-text">{errors.budgetUsd}</span>{/if}
			</label>
			<label class="flex flex-col gap-1">
				<span class="font-medium">Delegation cap</span>
				<Input type="number" min="1" max="32" bind:value={spawnCap} disabled={!settings} aria-invalid={!!errors.spawnCap} />
				<span class="text-xs text-muted-foreground">How many delegated tasks the lead runs at once.</span>
				{#if errors.spawnCap}<span class="text-xs text-destructive-text">{errors.spawnCap}</span>{/if}
			</label>
			<label class="flex flex-col gap-1">
				<span class="font-medium">Default model</span>
				<NativeSelect bind:value={model} disabled={!settings}>
					{#each models as m (m.id ?? '')}
						<NativeSelectOption value={m.id ?? ''}>{m.id === null ? 'Server default' : m.label}</NativeSelectOption>
					{/each}
				</NativeSelect>
				<span class="text-xs text-muted-foreground">For agents without their own model.</span>
			</label>
			{#if formError && !Object.keys(errors).length}<p class="text-xs text-destructive-text" role="alert">{formError}</p>{/if}
			<Button type="submit" class="self-start" disabled={saving || !settings}>{saving ? 'Saving…' : 'Save defaults'}</Button>
		</form>

		<section class="flex flex-col gap-3">
			<h2 class="text-base font-medium">Usage</h2>
			{#if usageError}<p class="text-destructive-text">{usageError}</p>{/if}
			{#if !usage && !usageError}<p class="text-muted-foreground">Loading…</p>{/if}
			{#if usage}
				<dl class="grid grid-cols-2 gap-2 sm:grid-cols-4">
					{#each [['Cost', usd(usage.total.costUsd)], ['Turns', num(usage.total.turns)], ['Input tokens', num(usage.total.inputTokens)], ['Output tokens', num(usage.total.outputTokens)]] as [label, value] (label)}
						<div class="rounded-lg border border-border bg-card p-3">
							<dt class="text-xs text-muted-foreground">{label}</dt>
							<dd class="text-lg font-medium">{value}</dd>
						</div>
					{/each}
				</dl>
				{#if settings?.budgetUsd !== null && settings?.budgetUsd !== undefined}
					<p class="text-xs text-muted-foreground">Budget {usd(settings.budgetUsd)} per month. The total above is all-time across agent chats.</p>
				{/if}
				<table class="w-full text-left text-xs">
					<thead class="text-muted-foreground">
						<tr><th class="py-1 font-normal">Agent</th><th class="py-1 text-right font-normal">Turns</th><th class="py-1 text-right font-normal">Tokens</th><th class="py-1 text-right font-normal">Cost</th></tr>
					</thead>
					<tbody>
						{#each usage.rows as r (r.id)}
							<tr class="border-t border-border">
								<td class="py-1">{r.name}</td>
								<td class="py-1 text-right">{num(r.usage.turns)}</td>
								<td class="py-1 text-right">{num(r.usage.totalTokens)}</td>
								<td class="py-1 text-right">{usd(r.usage.costUsd)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>

		<section class="flex flex-col gap-3">
			<h2 class="text-base font-medium">Workspace memory</h2>
			<p class="text-xs text-muted-foreground">Shared by every agent. Agents read it each turn; the lead and explicit roles can write it. If an agent edited a file while you were typing, saving shows the conflict.</p>
			<MemoryEditor scope="workspace" />
		</section>

		<form class="flex flex-col gap-3" onsubmit={(e) => (e.preventDefault(), saveToken())}>
			<h2 class="text-base font-medium">Connection</h2>
			<label class="flex flex-col gap-1">
				<span class="font-medium">Server token</span>
				<Input type="password" bind:value={token} placeholder="TEAM_TOKEN (empty if the server is open)" autocomplete="off" />
				<span class="text-xs text-muted-foreground">Stored in this browser only. PUBLIC_TEAM_TOKEN overrides it.</span>
			</label>
			<Button type="submit" class="self-start">Save token</Button>
			{#if tokenSaved}<span class="text-xs text-muted-foreground">Saved.</span>{/if}
		</form>
	</div>
</div>
