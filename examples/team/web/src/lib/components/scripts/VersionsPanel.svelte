<script lang="ts">
	import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwise';
	import { api } from '#lib/api/index.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import Surface from '#lib/components/app/Surface.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import MonacoDiff from './MonacoDiff.svelte';
	import MonacoEditor from './MonacoEditor.svelte';
	import { type Script, type ScriptVersion, type ScriptVersionMeta, toJsonText, versionMarkers } from '#lib/scripts/scripts.js';

	/**
	 * Every version, newest first. Tick two to compare them; open one to read its code; restore one as
	 * a new version. `view` is the version whose code is open (the status bar links here).
	 */
	let { script, rev = 0, view = $bindable(null), onRestored }: { script: Script; rev?: number; view?: number | null; onRestored: (version: number | undefined) => void } = $props();

	let versions = $state<ScriptVersionMeta[] | null>(null);
	let error = $state('');
	let picked = $state<number[]>([]);
	const cache = new Map<number, ScriptVersion>();
	let full = $state<Record<number, ScriptVersion>>({});
	let loadingFull = $state(false);
	let restoring = $state<number | null>(null);
	let confirmRestore = $state(false);
	let seq = 0;

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/scripts/{script}/versions', { params: { script: script.id } });
			if (mine !== seq) return;
			versions = [...r.versions].sort((a, b) => b.version - a.version);
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the versions';
		}
	}

	$effect(() => {
		void rev;
		void script.latestVersion;
		void load();
	});

	async function fetchVersion(v: number): Promise<ScriptVersion | null> {
		const hit = cache.get(v);
		if (hit) return hit;
		try {
			const r = await api.get('/scripts/{script}/versions/{version}', { params: { script: script.id, version: v } });
			cache.set(v, r);
			full = { ...full, [v]: r };
			return r;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : `Could not load v${v}`);
			return null;
		}
	}

	// the versions shown (the open one and the two compared) are fetched once
	$effect(() => {
		const need = [...picked, ...(view !== null ? [view] : [])].filter((v) => !full[v]);
		if (!need.length) return;
		loadingFull = true;
		void Promise.all(need.map(fetchVersion)).finally(() => (loadingFull = false));
	});

	function toggle(v: number, on: boolean): void {
		const rest = picked.filter((x) => x !== v);
		picked = on ? [...rest, v].slice(-2) : rest;
	}

	const pair = $derived(picked.length === 2 ? ([Math.min(...picked), Math.max(...picked)] as const) : null);
	const diff = $derived(pair && full[pair[0]] && full[pair[1]] ? { a: full[pair[0]]!, b: full[pair[1]]! } : null);
	const opened = $derived(view !== null ? full[view] : undefined);

	async function restore(): Promise<void> {
		const v = restoring;
		if (v === null) return;
		const src = await fetchVersion(v);
		if (!src) return;
		try {
			const r = await api.patch('/scripts/{script}', { params: { script: script.id }, body: { source: src.source, manifest: src.manifest, note: `restore v${v}` } });
			toast.success(r.version ? `Restored v${v} as v${r.version}` : `v${v} is the same as the latest version`);
			onRestored(r.version);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not restore the version');
		} finally {
			restoring = null;
		}
	}

	const when = (ms: number): string => new Date(ms).toLocaleString();
</script>


<div class="flex flex-col gap-4">
	{#if error}
		<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Retry</button></p>
	{:else if !versions}
		<div class="flex flex-col gap-2">{#each [0, 1, 2] as i (i)}<Skeleton class="h-12 w-full" />{/each}</div>
	{:else}
		<p class="text-xs text-muted-foreground">Tick two versions to compare them. Restoring saves an old version as a new one.</p>
		<Surface>
			<ul class="divide-y divide-border">
				{#each versions as v (v.version)}
					{@const isPicked = picked.includes(v.version)}
					<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm {view === v.version ? 'bg-[color-mix(in_srgb,var(--brand)_7%,var(--card))]' : ''}">
						<Checkbox checked={isPicked} onCheckedChange={(on) => toggle(v.version, on === true)} aria-label="Compare v{v.version}" />
						<span class="w-10 font-mono text-[13px] font-medium">v{v.version}</span>
						<div class="flex min-w-0 flex-1 flex-col">
							<span class="truncate">{v.note || 'No note'}</span>
							<span class="text-xs text-muted-foreground">{v.createdBy}{v.authorKind === 'agent' ? ' (agent)' : ''} · {when(v.createdAt)}</span>
						</div>
						<div class="flex flex-wrap items-center gap-1">
							{#each versionMarkers(v.version, script) as m (m.label)}<Badge variant={m.tone}>{m.label}</Badge>{/each}
						</div>
						<div class="flex items-center gap-1">
							<Button size="sm" variant="ghost" onclick={() => (view = view === v.version ? null : v.version)}>{view === v.version ? 'Close' : 'View'}</Button>
							{#if v.version !== script.latestVersion}
								<Button size="sm" variant="ghost" onclick={() => { restoring = v.version; confirmRestore = true; }} aria-label="Restore v{v.version}"><ArrowCounterClockwiseIcon class="size-4" /><span class="hidden sm:inline">Restore</span></Button>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		</Surface>

		{#if view !== null}
			<Surface class="flex flex-col gap-3 p-4">
				<div class="flex items-center justify-between gap-2">
					<h3 class="text-sm font-medium">Code of v{view}</h3>
					<Button size="sm" variant="ghost" onclick={() => (view = null)}>Close</Button>
				</div>
				{#if opened}
					{#key view}
						<MonacoEditor path="file:///versions/v{view}.ts" language="typescript" value={opened.source} readOnly label="Code of v{view}" class="h-[50dvh]" />
						<h4 class="text-xs font-medium text-muted-foreground">Triggers and permissions</h4>
						<MonacoEditor path="file:///versions/v{view}.json" language="json" value={toJsonText(opened.manifest)} readOnly label="Manifest of v{view}" class="h-64" />
					{/key}
				{:else if loadingFull}
					<Spinner class="size-4" />
				{/if}
			</Surface>
		{/if}

		{#if pair}
			<Surface class="flex flex-col gap-3 p-4">
				<h3 class="text-sm font-medium">v{pair[0]} → v{pair[1]}</h3>
				{#if diff}
					<h4 class="text-xs font-medium text-muted-foreground">Code</h4>
					<MonacoDiff original={diff.a.source} modified={diff.b.source} language="typescript" class="h-[50dvh]" />
					<h4 class="text-xs font-medium text-muted-foreground">Triggers and permissions</h4>
					<MonacoDiff original={toJsonText(diff.a.manifest)} modified={toJsonText(diff.b.manifest)} language="json" class="h-64" />
				{:else}
					<Spinner class="size-4" />
				{/if}
			</Surface>
		{/if}
	{/if}
</div>

<ConfirmDialog
	bind:open={confirmRestore}
	title="Restore v{restoring ?? ''}?"
	description="Its code and manifest are saved as a new version. An active script keeps running its active version until you activate the new one."
	confirmLabel="Restore"
	confirmVariant="default"
	onConfirm={restore}
/>
