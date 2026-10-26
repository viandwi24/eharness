<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwise';
	import FloppyDiskIcon from 'phosphor-svelte/lib/FloppyDisk';
	import { api, ApiError } from '#lib/api/index.js';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import Surface from '#lib/components/app/Surface.svelte';
	import ApiReference from '#lib/components/scripts/ApiReference.svelte';
	import CodeEditor from '#lib/components/scripts/CodeEditor.svelte';
	import DryRunPanel from '#lib/components/scripts/DryRunPanel.svelte';
	import RunsPanel from '#lib/components/scripts/RunsPanel.svelte';
	import StatusBar from '#lib/components/scripts/StatusBar.svelte';
	import VersionsPanel from '#lib/components/scripts/VersionsPanel.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { checkManifest, type Script, type ScriptDetail, toJsonText } from '#lib/scripts/scripts.js';
	import { live } from '#lib/stores/live.svelte.js';

	type Tab = 'code' | 'dry' | 'versions' | 'runs' | 'state';

	const scriptRef = $derived(page.params.script ?? '');

	let detail = $state<ScriptDetail | null>(null);
	let error = $state('');
	let notFound = $state(false);
	let tab = $state<Tab>('code');
	let viewVersion = $state<number | null>(null);
	let seq = 0;

	// the editor: a draft of the latest version
	let source = $state('');
	let manifestText = $state('');
	let note = $state('');
	let base = $state<{ version: number; source: string; manifest: string } | null>(null);
	let saving = $state(false);
	let saveError = $state('');

	const dirty = $derived(!!base && (source !== base.source || manifestText !== base.manifest));
	const manifestCheck = $derived(checkManifest(manifestText));
	/** A newer version was saved elsewhere while this draft has edits. */
	const stale = $derived(!!detail && !!base && dirty && detail.latest.version !== base.version);
	const versions = $derived(detail ? Array.from({ length: detail.script.latestVersion }, (_, i) => detail!.script.latestVersion - i) : []);

	// panels refetch when the script changes or runs (here, an agent, another tab or instance)
	let panelRev = $state(0);

	function takeLatest(d: ScriptDetail): void {
		const m = toJsonText(d.latest.manifest);
		base = { version: d.latest.version, source: d.latest.source, manifest: m };
		source = d.latest.source;
		manifestText = m;
		note = '';
		saveError = '';
	}

	async function load(force = false): Promise<void> {
		const mine = ++seq;
		try {
			const d = await api.get('/scripts/{script}', { params: { script: scriptRef } });
			if (mine !== seq) return;
			const first = !detail || detail.script.id !== d.script.id;
			detail = d;
			error = '';
			notFound = false;
			if (first || force || !dirty) takeLatest(d);
		} catch (e) {
			if (mine !== seq) return;
			notFound = e instanceof ApiError && e.status === 404;
			error = e instanceof Error ? e.message : 'Could not load the script';
		}
	}

	// a new script (navigation): start over
	$effect(() => {
		void scriptRef;
		untrack(() => {
			detail = null;
			base = null;
			error = '';
			notFound = false;
			tab = 'code';
			viewVersion = null;
			void load();
		});
	});

	let seenRev = live.state.revs.scripts;
	$effect(() => {
		const rev = live.state.revs.scripts;
		untrack(() => {
			if (rev === seenRev) return;
			seenRev = rev;
			panelRev++;
			void load();
		});
	});

	function changed(s: Script): void {
		if (detail) detail = { ...detail, script: s };
		panelRev++;
		void load();
	}

	async function save(): Promise<void> {
		if (!detail || saving) return;
		saveError = '';
		const m = checkManifest(manifestText);
		if (!m.ok) {
			saveError = m.error;
			return;
		}
		if (!dirty) {
			toast.info('Nothing changed');
			return;
		}
		saving = true;
		try {
			const r = await api.patch('/scripts/{script}', {
				params: { script: detail.script.id },
				body: { source, manifest: m.manifest, ...(note.trim() ? { note: note.trim() } : {}) }
			});
			toast.success(r.version ? `Saved v${r.version}` : 'Nothing changed');
			detail = { ...detail, script: r.script };
			panelRev++;
			await load(true);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Could not save';
		} finally {
			saving = false;
		}
	}

	function editorKeys(e: KeyboardEvent): void {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
			e.preventDefault();
			void save();
		}
	}

	function viewCode(version: number): void {
		viewVersion = version;
		tab = 'versions';
	}

	// the script's own state between runs
	let kv = $state<{ key: string; value: string }[] | null>(null);
	let kvError = $state('');
	let kvLoading = $state(false);
	async function loadKv(): Promise<void> {
		if (!detail) return;
		kvLoading = true;
		try {
			kv = (await api.get('/scripts/{script}/kv', { params: { script: detail.script.id } })).entries;
			kvError = '';
		} catch (e) {
			kvError = e instanceof Error ? e.message : 'Could not load the state';
		} finally {
			kvLoading = false;
		}
	}
	$effect(() => {
		if (tab !== 'state') return;
		void panelRev;
		untrack(() => void loadKv());
	});

	const prettyValue = (v: string): string => {
		try {
			return JSON.stringify(JSON.parse(v), null, 2);
		} catch {
			return v;
		}
	};
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title={detail?.script.name ?? scriptRef} description={detail?.script.description || 'A script: code, manifest, runs.'} breadcrumb={[{ label: 'Scripts', href: '/scripts' }]} backHref="/scripts" />

	<PageBody size="wide" class="gap-4">
		{#if error && !detail}
			<Empty.Root class="border border-dashed border-border">
				<Empty.Header><Empty.Title>{notFound ? 'Script not found' : 'Could not load the script'}</Empty.Title><Empty.Description>{error}</Empty.Description></Empty.Header>
				<Empty.Content>
					{#if notFound}<Button href="/scripts" variant="outline">Back to scripts</Button>{:else}<Button variant="outline" onclick={() => void load()}>Retry</Button>{/if}
				</Empty.Content>
			</Empty.Root>
		{:else if !detail}
			<Skeleton class="h-24 w-full" />
			<Skeleton class="h-96 w-full" />
		{:else}
			{#if notFound}
				<p class="text-sm text-destructive-text" role="alert">This script was deleted. <a href="/scripts" class="underline underline-offset-4">Back to scripts</a></p>
			{/if}
			<StatusBar
				{detail}
				onChanged={changed}
				onViewVersion={viewCode}
				onRan={() => { panelRev++; tab = 'runs'; }}
				onRenamed={(name) => void goto(`/scripts/${encodeURIComponent(name)}`, { replaceState: true })}
				onDeleted={() => void goto('/scripts')}
			/>

			<Tabs.Root bind:value={tab}>
				<Tabs.List variant="line" class="h-10 gap-4 overflow-x-auto">
					<Tabs.Trigger value="code">Code{dirty ? ' •' : ''}</Tabs.Trigger>
					<Tabs.Trigger value="dry">Dry run</Tabs.Trigger>
					<Tabs.Trigger value="versions">Versions</Tabs.Trigger>
					<Tabs.Trigger value="runs">Runs</Tabs.Trigger>
					<Tabs.Trigger value="state">State</Tabs.Trigger>
				</Tabs.List>
			</Tabs.Root>

			{#if tab === 'code'}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="flex flex-col gap-4" onkeydown={editorKeys}>
					{#if stale}
						<p class="rounded-md border border-[color-mix(in_srgb,var(--warning)_30%,var(--card))] bg-warning-soft px-3 py-2 text-sm text-warning-text">
							v{detail.latest.version} was saved meanwhile; your edits are based on v{base?.version}. Saving makes a new version from your draft.
							<button type="button" class="underline underline-offset-4" onclick={() => detail && takeLatest(detail)}>Discard my edits and load v{detail.latest.version}</button>
						</p>
					{/if}
					<div class="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
						<Field.Field>
							<Field.Label for="script-source">Source <span class="text-xs font-normal text-muted-foreground">TypeScript · v{base?.version ?? detail.latest.version}{dirty ? ', edited' : ''}</span></Field.Label>
							<CodeEditor id="script-source" label="Script source" bind:value={source} class="h-[60dvh]" />
						</Field.Field>
						<Field.Field data-invalid={!manifestCheck.ok}>
							<Field.Label for="script-manifest">Manifest <span class="text-xs font-normal text-muted-foreground">JSON: triggers, grants, limits</span></Field.Label>
							<CodeEditor id="script-manifest" label="Manifest" bind:value={manifestText} invalid={!manifestCheck.ok} class="h-[40dvh] xl:h-[60dvh]" />
							{#if !manifestCheck.ok}<Field.Error>{manifestCheck.error}</Field.Error>{:else}<Field.Description>Grants are default-deny: list every chat, path, table, host or agent the code may touch.</Field.Description>{/if}
						</Field.Field>
					</div>
					<div class="flex flex-wrap items-end gap-3">
						<Field.Field class="min-w-48 flex-1">
							<Field.Label for="script-note">Version note</Field.Label>
							<Input id="script-note" bind:value={note} placeholder="What changed" autocomplete="off" />
						</Field.Field>
						{#if dirty}
							<Button variant="ghost" onclick={() => detail && takeLatest(detail)} disabled={saving}><ArrowClockwiseIcon class="size-4" /> Discard</Button>
						{/if}
						<Button onclick={() => void save()} disabled={saving || !dirty || !manifestCheck.ok} title="Save a new version (Ctrl+S)">
							{#if saving}<Spinner class="size-4" />{:else}<FloppyDiskIcon class="size-4" />{/if} Save
						</Button>
					</div>
					{#if saveError}<p class="text-sm break-words whitespace-pre-wrap text-destructive-text" role="alert">{saveError}</p>{/if}
					{#if detail.script.status === 'active' && dirty}
						<p class="text-xs text-muted-foreground">Saving makes a new version. The active version keeps running until you activate the new one.</p>
					{/if}
					<ApiReference />
				</div>
			{:else if tab === 'dry'}
				<DryRunPanel script={detail.script.id} latest={detail.script.latestVersion} {versions} onDone={() => panelRev++} />
			{:else if tab === 'versions'}
				<VersionsPanel script={detail.script} rev={panelRev} bind:view={viewVersion} onRestored={() => { panelRev++; void load(true); }} />
			{:else if tab === 'runs'}
				<RunsPanel script={detail.script.id} rev={panelRev} />
			{:else}
				<div class="flex flex-col gap-3">
					<div class="flex items-center gap-2">
						<p class="flex-1 text-xs text-muted-foreground">What the script keeps between runs with <code class="font-mono">ctx.kv</code>.</p>
						<Button variant="outline" size="icon-sm" aria-label="Refresh" title="Refresh" disabled={kvLoading} onclick={() => void loadKv()}>
							{#if kvLoading}<Spinner class="size-4" />{:else}<ArrowClockwiseIcon class="size-4" />{/if}
						</Button>
					</div>
					{#if kvError}
						<p class="text-sm text-destructive-text" role="alert">{kvError}</p>
					{:else if !kv}
						<Skeleton class="h-24 w-full" />
					{:else if !kv.length}
						<p class="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">No state stored.</p>
					{:else}
						<Surface>
							<ul class="divide-y divide-border">
								{#each kv as e (e.key)}
									<li class="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:gap-4">
										<code class="w-48 shrink-0 font-mono text-xs font-medium break-all">{e.key}</code>
										<pre class="max-h-48 min-w-0 flex-1 overflow-auto font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">{prettyValue(e.value)}</pre>
									</li>
								{/each}
							</ul>
						</Surface>
					{/if}
				</div>
			{/if}
		{/if}
	</PageBody>
</div>
