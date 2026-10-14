<script lang="ts">
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import SchemaForm from '#lib/components/app/SchemaForm.svelte';
	import { buildSettings, initialValues, type FormValues } from '#lib/providers/form.js';
	import { type BrowserAdapter, type BrowserMode, type BrowserOverview, type BrowserProfile, modeLabel } from '#lib/browser/model.js';
	import RuntimeCard from './RuntimeCard.svelte';

	/**
	 * New profile, inline: name, adapter cards, mode, the adapter form of that mode (secrets are
	 * password fields; "Test connection" for an existing browser, the engine card for a managed one),
	 * done. Only modes the server offers can be picked.
	 */
	let { overview, onCreated, onCancel }: { overview: BrowserOverview; onCreated: (p: BrowserProfile) => void; onCancel: () => void } = $props();

	type Step = 'name' | 'adapter' | 'mode' | 'settings' | 'done';
	const STEPS: { id: Step; label: string }[] = [
		{ id: 'name', label: 'Name' },
		{ id: 'adapter', label: 'Browser' },
		{ id: 'mode', label: 'Where it runs' },
		{ id: 'settings', label: 'Settings' },
		{ id: 'done', label: 'Done' }
	];
	let step = $state<Step>('name');
	let name = $state('');
	let adapterId = $state('');
	let mode = $state<BrowserMode | ''>('');
	let values = $state<FormValues>({});
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);
	let test = $state<{ ok: boolean; version?: string; error?: string } | null>(null);
	let created = $state<BrowserProfile | null>(null);
	let runtimeState = $state<string | undefined>();
	let runsOn = $state<'local' | 'remote'>('local');

	const adapter = $derived(overview.adapters.find((a) => a.id === adapterId));
	const fields = $derived(mode && adapter ? (adapter.forms[mode]?.fields ?? []) : []);
	const offered = (a: BrowserAdapter): boolean => a.modes.length > 0;
	const index = $derived(STEPS.findIndex((s) => s.id === step));
	/** The engine card shown: this server's, or the Remote sandbox's (`chrome@remote`). */
	const engine = $derived(runsOn === 'remote' && adapter?.remote ? adapter.remote : adapter?.runtime);
	const engineId = $derived(adapter ? (runsOn === 'remote' && adapter.remote ? adapter.remote.adapter : adapter.id) : '');
	function pickRunsOn(where: 'local' | 'remote'): void {
		runsOn = where;
		runtimeState = (where === 'remote' ? adapter?.remote : adapter?.runtime)?.state;
	}

	function pickAdapter(a: BrowserAdapter): void {
		if (!offered(a)) return;
		adapterId = a.id;
		mode = a.modes.length === 1 ? a.modes[0]! : '';
		step = 'mode';
		if (a.modes.length === 1) pickMode(a.modes[0]!);
	}
	function pickMode(m: BrowserMode): void {
		mode = m;
		const fields = adapter?.forms[m]?.fields ?? [];
		values = initialValues(fields);
		// a server usually has no screen: a new browser runs without a window unless switched off
		if (fields.some((f) => f.path === 'headless') && values.headless === undefined) values.headless = true;
		errors = {};
		test = null;
		runsOn = 'local';
		runtimeState = adapter?.runtime?.state;
		step = 'settings';
	}
	function settingsBody(): Record<string, unknown> | undefined {
		const r = buildSettings(fields, values, undefined, 'create');
		if (!r.ok) {
			errors = r.errors;
			return undefined;
		}
		errors = {};
		return r.settings;
	}
	async function runTest(): Promise<void> {
		const settings = settingsBody();
		if (!settings || !mode) return;
		busy = true;
		try {
			test = await api.post('/browser/test', { body: { adapter: adapterId, mode, settings } });
		} catch (e) {
			test = { ok: false, error: e instanceof Error ? e.message : 'The test failed' };
		} finally {
			busy = false;
		}
	}
	async function create(): Promise<void> {
		const settings = settingsBody();
		if (!settings || !mode) return;
		busy = true;
		try {
			created = await api.post('/browser/profiles', { body: { name: name.trim(), adapter: adapterId, mode, settings, ...(mode === 'managed' && runsOn === 'remote' ? { runtime: 'remote' as const } : {}) } });
			step = 'done';
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not create the profile');
		} finally {
			busy = false;
		}
	}
	const managedReady = $derived(mode !== 'managed' || runtimeState === 'ready' || runtimeState === 'running');
</script>

<section class="flex flex-col gap-4 rounded-xl border border-border bg-card p-4" aria-label="New browser profile" data-testid="browser-wizard">
	<ol class="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Steps">
		{#each STEPS as s, i (s.id)}
			<li class={i === index ? 'font-medium text-foreground' : i < index ? 'text-muted-foreground' : 'text-muted-foreground/60'} aria-current={i === index ? 'step' : undefined}>{i + 1}. {s.label}</li>
		{/each}
	</ol>

	{#if step === 'name'}
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium">Name</span>
			<Input bind:value={name} placeholder="Research browser" maxlength={80} data-testid="browser-name" onkeydown={(e) => e.key === 'Enter' && name.trim() && (step = 'adapter')} />
			<span class="text-xs text-muted-foreground">Logins are kept per profile, so name it after what it is used for.</span>
		</label>
		<div class="flex justify-end gap-2">
			<Button size="sm" variant="ghost" onclick={onCancel}>Cancel</Button>
			<Button size="sm" disabled={name.trim() === ''} onclick={() => (step = 'adapter')} data-testid="wizard-next">Next</Button>
		</div>
	{:else if step === 'adapter'}
		<div class="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Browser">
			{#each overview.adapters as a (a.id)}
				{@const caps = a.capabilities.managed ?? a.capabilities.manual}
				<button
					type="button"
					role="radio"
					aria-checked={adapterId === a.id}
					disabled={!offered(a)}
					onclick={() => pickAdapter(a)}
					data-testid="adapter-{a.id}"
					class="flex flex-col gap-1.5 rounded-lg border border-border p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring enabled:hover:bg-accent disabled:opacity-60"
				>
					<span class="text-sm font-medium">{a.label}</span>
					{#if a.description}<span class="text-xs text-muted-foreground">{a.description}</span>{/if}
					{#if caps}
						<span class="flex flex-wrap gap-1">
							{#if caps.screenshot}<Badge variant="secondary">Screenshots</Badge>{/if}
							{#if caps.liveView !== 'none'}<Badge variant="secondary">Live view</Badge>{/if}
							{#if caps.takeover}<Badge variant="secondary">Takeover</Badge>{/if}
							{#if caps.persistentProfile}<Badge variant="secondary">Keeps logins</Badge>{/if}
						</span>
					{/if}
					{#each ['manual', 'managed'] as const as m (m)}
						{#if a.unavailable[m]}<span class="text-xs text-muted-foreground">{modeLabel(m)}: {a.unavailable[m]}</span>{/if}
					{/each}
				</button>
			{/each}
		</div>
		<div class="flex justify-between gap-2"><Button size="sm" variant="ghost" onclick={() => (step = 'name')}>Back</Button></div>
	{:else if step === 'mode' && adapter}
		<div class="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Where it runs">
			{#each adapter.modes as m (m)}
				<button type="button" role="radio" aria-checked={mode === m} onclick={() => pickMode(m)} data-testid="mode-{m}" class="flex flex-col gap-1 rounded-lg border border-border p-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
					<span class="text-sm font-medium">{m === 'manual' ? 'Connect to an existing browser' : 'Run it on this server'}</span>
					<span class="text-xs text-muted-foreground">{m === 'manual' ? 'You or a provider run it; this app connects to its debugging address.' : 'This server downloads the engine and starts it when an agent needs it.'}</span>
				</button>
			{/each}
		</div>
		<div class="flex justify-between gap-2"><Button size="sm" variant="ghost" onclick={() => (step = 'adapter')}>Back</Button></div>
	{:else if step === 'settings' && adapter && mode}
		{#if mode === 'managed' && adapter.remote}
			<div class="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Runs on">
				<button type="button" role="radio" aria-checked={runsOn === 'local'} onclick={() => pickRunsOn('local')} data-testid="runs-on-local" class="flex flex-col gap-1 rounded-lg border border-border p-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-checked:border-brand">
					<span class="text-sm font-medium">This server</span>
					<span class="text-xs text-muted-foreground">Chrome runs next to the app.</span>
				</button>
				<button type="button" role="radio" aria-checked={runsOn === 'remote'} onclick={() => pickRunsOn('remote')} data-testid="runs-on-remote" class="flex flex-col gap-1 rounded-lg border border-border p-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-checked:border-brand">
					<span class="text-sm font-medium">The Remote sandbox</span>
					<span class="text-xs text-muted-foreground">Chrome runs on {adapter.remote.host}; the app drives it through the sandbox server.</span>
				</button>
			</div>
		{/if}
		{#if mode === 'managed' && engine}
			{#key engineId}
				<RuntimeCard adapter={engineId} label={runsOn === 'remote' && adapter.remote ? `${adapter.label} on ${adapter.remote.host}` : adapter.label} runtime={engine} onChange={(r) => (runtimeState = r.state)} />
			{/key}
			{#if !managedReady}<p class="text-xs text-muted-foreground">Install the engine to continue.</p>{/if}
		{/if}
		{#if fields.length > 0}
			<SchemaForm {fields} bind:values {errors} idPrefix="bw" />
		{:else if mode === 'managed'}
			<p class="text-xs text-muted-foreground">Nothing to configure: the engine runs with its defaults.</p>
		{/if}
		{#if mode === 'manual'}
			<div class="flex flex-wrap items-center gap-2">
				<Button size="sm" variant="outline" disabled={busy} onclick={() => void runTest()} data-testid="wizard-test">Test connection</Button>
				{#if test}
					<span class="text-xs {test.ok ? 'text-success-text' : 'text-destructive-text'}" role="status" data-testid="wizard-test-result">{test.ok ? `Connected${test.version ? ` · ${test.version}` : ''}` : (test.error ?? 'Could not connect')}</span>
				{/if}
			</div>
		{/if}
		<div class="flex justify-between gap-2">
			<Button size="sm" variant="ghost" onclick={() => (step = adapter.modes.length > 1 ? 'mode' : 'adapter')}>Back</Button>
			<Button size="sm" disabled={busy || !managedReady} onclick={() => void create()} data-testid="wizard-create">Create profile</Button>
		</div>
	{:else if step === 'done' && created}
		<div class="flex flex-col items-start gap-3" data-testid="wizard-done">
			<p class="flex items-center gap-2 text-sm"><CheckIcon class="size-4 text-success-text" /> <span><strong>{created.name}</strong> is ready to use. Give it to an agent from the agent's Browser connection.</span></p>
			<div class="flex gap-2">
				<Button size="sm" href="/browser/{created.id}" data-testid="wizard-open">Open live view</Button>
				<Button size="sm" variant="ghost" onclick={() => created && onCreated(created)}>Close</Button>
			</div>
		</div>
	{/if}
</section>
