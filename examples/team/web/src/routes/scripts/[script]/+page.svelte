<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwise';
	import FloppyDiskIcon from 'phosphor-svelte/lib/FloppyDisk';
	import CodeIcon from 'phosphor-svelte/lib/Code';
	import ShieldCheckIcon from 'phosphor-svelte/lib/ShieldCheck';
	import WarningIcon from 'phosphor-svelte/lib/Warning';
	import BookOpenIcon from 'phosphor-svelte/lib/BookOpen';
	import { api, ApiError } from '#lib/api/index.js';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import Surface from '#lib/components/app/Surface.svelte';
	import ApiReference from '#lib/components/scripts/ApiReference.svelte';
	import ManifestBuilder from '#lib/components/scripts/ManifestBuilder.svelte';
	import MonacoEditor, { type EditorProblem } from '#lib/components/scripts/MonacoEditor.svelte';
	import RunsPanel from '#lib/components/scripts/RunsPanel.svelte';
	import StatusBar from '#lib/components/scripts/StatusBar.svelte';
	import TestPanel from '#lib/components/scripts/TestPanel.svelte';
	import VersionsPanel from '#lib/components/scripts/VersionsPanel.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { createLookups } from '#lib/scripts/lookups.svelte.js';
	import { fromManifest, sampleEventFor, simpleCanShow, type SimpleManifest, toManifest } from '#lib/scripts/manifest-model.js';
	import { checkManifest, type DryRunResult, type Script, type ScriptDetail, toJsonText } from '#lib/scripts/scripts.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { cn } from '#lib/utils.js';

	type Tab = 'edit' | 'runs' | 'versions' | 'state';
	type Part = 'code' | 'manifest';

	const scriptRef = $derived(page.params.script ?? '');
	const lookups = createLookups();
	$effect(() => void lookups.load());

	let detail = $state<ScriptDetail | null>(null);
	let error = $state('');
	let notFound = $state(false);
	let tab = $state<Tab>('edit');
	let part = $state<Part>('code');
	let viewVersion = $state<number | null>(null);
	let seq = 0;

	// the draft of the latest version
	let source = $state('');
	let manifestText = $state('');
	let note = $state('');
	let base = $state<{ version: number; source: string; manifest: string } | null>(null);
	let saving = $state(false);
	let saveError = $state('');
	let problems = $state<EditorProblem[]>([]);
	let editorApi: { reveal: (line: number, column: number) => void } | null = null;
	let showRef = $state(false);

	const dirty = $derived(!!base && (source !== base.source || manifestText !== base.manifest));
	const manifestCheck = $derived(checkManifest(manifestText));
	const stale = $derived(!!detail && !!base && dirty && detail.latest.version !== base.version);
	const versions = $derived(detail ? Array.from({ length: detail.script.latestVersion }, (_, i) => detail!.script.latestVersion - i) : []);
	const errors = $derived(problems.filter((p) => p.severity === 'error'));

	// Simple (forms) or JSON for the manifest; both edit `manifestText`
	let manifestMode = $state<'simple' | 'json'>('simple');
	let simple = $state<SimpleManifest>(fromManifest({}));
	/** The manifest text as the simple model would write it (to compare meaning, not formatting). */
	const norm = (text: string): string | null => {
		const c = checkManifest(text);
		return c.ok ? JSON.stringify(toManifest(fromManifest(c.manifest))) : null;
	};
	function enterSimple(): void {
		if (!manifestCheck.ok) {
			toast.error('Fix the JSON first: ' + manifestCheck.error);
			return;
		}
		if (!simpleCanShow(manifestCheck.manifest)) toast.info('Some fields are only shown in JSON mode; editing in Simple mode drops them.');
		simple = fromManifest(manifestCheck.manifest);
		manifestMode = 'simple';
	}
	$effect(() => {
		// a form change rewrites the JSON (the save sends the JSON)
		if (manifestMode !== 'simple') return;
		const wanted = toManifest(simple);
		untrack(() => {
			if (norm(manifestText) === JSON.stringify(wanted)) return;
			manifestText = toJsonText(wanted);
		});
	});
	$effect(() => {
		// an outside change (load, discard, JSON edits) refreshes the forms
		const n = norm(manifestText);
		untrack(() => {
			if (n === null || n === JSON.stringify(toManifest(simple))) return;
			const c = checkManifest(manifestText);
			if (c.ok) simple = fromManifest(c.manifest);
		});
	});

	// the newest test of the latest version (for the progress steps)
	let tested = $state<'ok' | 'failed' | 'none'>('none');
	async function loadTested(): Promise<void> {
		if (!detail) return;
		try {
			const r = await api.get('/scripts/{script}/runs', { params: { script: detail.script.id }, query: { limit: 20, dryRun: 'true' } });
			const last = r.runs.find((x) => x.version === detail!.script.latestVersion);
			tested = !last ? 'none' : last.outcome === 'ok' ? 'ok' : 'failed';
		} catch {
			/* the steps just show "not tested" */
		}
	}

	let panelRev = $state(0);
	let webhookUrl = $state('');
	async function loadWebhook(id: string): Promise<void> {
		try {
			webhookUrl = (await api.get('/scripts/{script}/webhook', { params: { script: id } })).url;
		} catch {
			webhookUrl = '';
		}
	}

	function takeLatest(d: ScriptDetail): void {
		const m = toJsonText(d.latest.manifest);
		base = { version: d.latest.version, source: d.latest.source, manifest: m };
		source = d.latest.source;
		manifestText = m;
		simple = fromManifest(d.latest.manifest);
		note = '';
		saveError = '';
		if (manifestMode === 'simple' && !simpleCanShow(d.latest.manifest)) manifestMode = 'json';
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
			void loadTested();
			if (first) void loadWebhook(d.script.id);
		} catch (e) {
			if (mine !== seq) return;
			notFound = e instanceof ApiError && e.status === 404;
			error = e instanceof Error ? e.message : 'Could not load the script';
		}
	}

	$effect(() => {
		void scriptRef;
		untrack(() => {
			detail = null;
			base = null;
			error = '';
			notFound = false;
			tab = 'edit';
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
			saveError = `Triggers and permissions: ${m.error}`;
			part = 'manifest';
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
			toast.success(r.version ? `Saved v${r.version}. Test it on the right.` : 'Nothing changed');
			detail = { ...detail, script: r.script };
			panelRev++;
			await load(true);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Could not save';
		} finally {
			saving = false;
		}
	}

	// "Test it": the test panel (beside the editor on wide screens, under it otherwise)
	let testPanel: { run: () => Promise<void> } | undefined = $state();
	let testHost: HTMLElement | undefined = $state();
	function focusTest(): void {
		tab = 'edit';
		requestAnimationFrame(() => {
			testHost?.scrollIntoView({ behavior: 'smooth', block: 'start' });
			void testPanel?.run();
		});
	}
	function tested_(r: DryRunResult): void {
		panelRev++;
		if (r.run.version === detail?.script.latestVersion) tested = r.run.outcome === 'ok' ? 'ok' : 'failed';
	}

	$effect(() => {
		// a fresh script from a recipe opens with the test in view
		if (detail && page.url.searchParams.get('test') === '1') untrack(() => requestAnimationFrame(() => testHost?.scrollIntoView({ block: 'start' })));
	});

	// suggestions for the example message from the first chat trigger
	const savedTriggers = $derived(fromManifest(detail?.latest.manifest ?? {}).triggers);
	const firstChat = $derived(savedTriggers.find((t) => t.kind === 'channel'));
	const sample = $derived(firstChat ? undefined : sampleEventFor(savedTriggers[0]));

	function viewCode(version: number): void {
		viewVersion = version;
		tab = 'versions';
	}

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

	function onWindowKey(e: KeyboardEvent): void {
		if (tab === 'edit' && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
			e.preventDefault();
			void save();
		}
	}

	const seg = (on: boolean): string => cn('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors', on ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground');
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title={detail?.script.name ?? scriptRef} description={detail?.script.description || 'A script'} breadcrumb={[{ label: 'Scripts', href: '/scripts' }]} backHref="/scripts" />

	<PageBody size="full" class="gap-4">
		{#if error && !detail}
			<Empty.Root class="border border-dashed border-border">
				<Empty.Header><Empty.Title>{notFound ? 'Script not found' : 'Could not load the script'}</Empty.Title><Empty.Description>{error}</Empty.Description></Empty.Header>
				<Empty.Content>
					{#if notFound}<Button href="/scripts" variant="outline">Back to scripts</Button>{:else}<Button variant="outline" onclick={() => void load()}>Retry</Button>{/if}
				</Empty.Content>
			</Empty.Root>
		{:else if !detail}
			<Skeleton class="h-20 w-full" />
			<Skeleton class="h-[60dvh] w-full" />
		{:else}
			<StatusBar
				{detail}
				{dirty}
				{tested}
				onSave={() => void save()}
				onTest={focusTest}
				onChanged={changed}
				onViewVersion={viewCode}
				onRan={() => { panelRev++; tab = 'runs'; }}
				onRenamed={(name) => void goto(`/scripts/${encodeURIComponent(name)}`, { replaceState: true })}
				onDeleted={() => void goto('/scripts')}
			/>

			<Tabs.Root bind:value={tab}>
				<Tabs.List variant="line" class="h-10 gap-4 overflow-x-auto">
					<Tabs.Trigger value="edit">Edit & test{dirty ? ' •' : ''}</Tabs.Trigger>
					<Tabs.Trigger value="runs">Runs</Tabs.Trigger>
					<Tabs.Trigger value="versions">History</Tabs.Trigger>
					<Tabs.Trigger value="state">Saved state</Tabs.Trigger>
				</Tabs.List>
			</Tabs.Root>

			{#if tab === 'edit'}
				{#if stale}
					<p class="rounded-md border border-[color-mix(in_srgb,var(--warning)_30%,var(--card))] bg-warning-soft px-3 py-2 text-sm text-warning-text">
						v{detail.latest.version} was saved meanwhile (by an agent or another tab); your edits are based on v{base?.version}.
						<button type="button" class="underline underline-offset-4" onclick={() => detail && takeLatest(detail)}>Load v{detail.latest.version} and drop my edits</button>
					</p>
				{/if}
				<div class="grid min-w-0 gap-4 2xl:grid-cols-[minmax(0,1fr)_28rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
					<!-- editor -->
					<Surface class="flex min-w-0 flex-col">
						<div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
							<div class="inline-flex gap-0.5 rounded-lg bg-muted p-0.5" role="tablist" aria-label="Part">
								<button type="button" role="tab" aria-selected={part === 'code'} class={seg(part === 'code')} onclick={() => (part = 'code')}><CodeIcon class="size-3.5" /> Code</button>
								<button type="button" role="tab" aria-selected={part === 'manifest'} class={seg(part === 'manifest')} onclick={() => (part = 'manifest')}>
									<ShieldCheckIcon class="size-3.5" /> Triggers & permissions{#if !manifestCheck.ok}<span class="size-1.5 rounded-full bg-destructive"></span>{/if}
								</button>
							</div>
							{#if part === 'manifest'}
								<div class="inline-flex gap-0.5 rounded-lg bg-muted p-0.5" role="tablist" aria-label="Mode">
									<button type="button" role="tab" aria-selected={manifestMode === 'simple'} class={seg(manifestMode === 'simple')} onclick={enterSimple}>Simple</button>
									<button type="button" role="tab" aria-selected={manifestMode === 'json'} class={seg(manifestMode === 'json')} onclick={() => (manifestMode = 'json')}>JSON</button>
								</div>
							{/if}
							<span class="flex-1"></span>
							{#if part === 'code'}
								{#if errors.length}
									<span class="inline-flex items-center gap-1 text-xs text-destructive-text"><WarningIcon class="size-3.5" /> {errors.length} problem{errors.length === 1 ? '' : 's'}</span>
								{:else if problems.length}
									<span class="text-xs text-warning-text">{problems.length} warning{problems.length === 1 ? '' : 's'}</span>
								{/if}
								<Button size="sm" variant="ghost" onclick={() => (showRef = true)}><BookOpenIcon class="size-4" /> ctx reference</Button>
							{/if}
							<span class="font-mono text-xs text-muted-foreground">v{base?.version ?? detail.latest.version}{dirty ? ' · edited' : ''}</span>
						</div>

						{#if part === 'code'}
							<MonacoEditor
								path="file:///scripts/{detail.script.id}.ts"
								language="typescript"
								bind:value={source}
								label="Script code"
								class="h-[calc(100dvh-25rem)] min-h-96 rounded-none border-0"
								onSave={() => void save()}
								onProblems={(p) => (problems = p)}
								onReady={(a) => (editorApi = a)}
							/>
							{#if problems.length}
								<ul class="max-h-32 overflow-auto border-t border-border text-xs">
									{#each problems.slice(0, 50) as p, i (i)}
										<li>
											<button type="button" class="flex w-full gap-2 px-3 py-1 text-left hover:bg-accent/50" onclick={() => editorApi?.reveal(p.line, p.column)}>
												<span class={p.severity === 'error' ? 'text-destructive-text' : 'text-warning-text'}>{p.severity === 'error' ? '●' : '▲'}</span>
												<span class="font-mono text-muted-foreground">{p.line}:{p.column}</span>
												<span class="min-w-0 flex-1 truncate">{p.message}</span>
											</button>
										</li>
									{/each}
								</ul>
							{/if}
						{:else if manifestMode === 'simple'}
							<div class="h-[calc(100dvh-25rem)] min-h-96 overflow-auto p-4">
								<ManifestBuilder bind:manifest={simple} {lookups} {webhookUrl} />
							</div>
						{:else}
							<MonacoEditor path="file:///manifest/{detail.script.id}.json" language="json" bind:value={manifestText} label="Triggers and permissions (JSON)" class="h-[calc(100dvh-25rem)] min-h-96 rounded-none border-0" onSave={() => void save()} />
							{#if !manifestCheck.ok}<p class="border-t border-border px-3 py-1.5 text-xs text-destructive-text" role="alert">{manifestCheck.error}</p>{/if}
						{/if}

						<div class="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
							<Input bind:value={note} placeholder="What changed (optional)" class="h-8 max-w-sm min-w-40 flex-1 text-xs" aria-label="Version note" autocomplete="off" />
							<span class="flex-1"></span>
							{#if saveError}<span class="max-w-md truncate text-xs text-destructive-text" title={saveError} role="alert">{saveError}</span>{/if}
							{#if dirty}
								<Button size="sm" variant="ghost" onclick={() => detail && takeLatest(detail)} disabled={saving}><ArrowClockwiseIcon class="size-4" /> Discard</Button>
							{/if}
							<Button size="sm" onclick={() => void save()} disabled={saving || !dirty || !manifestCheck.ok} title="Save a new version (Ctrl+S)">
								{#if saving}<Spinner class="size-4" />{:else}<FloppyDiskIcon class="size-4" />{/if} Save{dirty ? ` v${detail.latest.version + 1}` : ''}
							</Button>
						</div>
					</Surface>

					<!-- test -->
					<div bind:this={testHost} class="min-w-0 xl:sticky xl:top-4 xl:self-start">
						<Surface class="p-4">
							<TestPanel
								bind:this={testPanel}
								script={detail.script.id}
								latest={detail.script.latestVersion}
								{versions}
								unsaved={dirty}
								{lookups}
								suggestedChat={firstChat?.kind === 'channel' ? (firstChat.chats[0] ?? '') : ''}
								suggestedText={firstChat?.kind === 'channel' ? (firstChat.textContains[0] ?? '') : ''}
								{sample}
								onDone={tested_}
							/>
						</Surface>
					</div>
				</div>
			{:else if tab === 'versions'}
				<VersionsPanel script={detail.script} rev={panelRev} bind:view={viewVersion} onRestored={() => { panelRev++; void load(true); }} />
			{:else if tab === 'runs'}
				<RunsPanel script={detail.script.id} rev={panelRev} />
			{:else}
				<div class="flex flex-col gap-3">
					<div class="flex items-center gap-2">
						<p class="flex-1 text-xs text-muted-foreground">What the script remembers between runs (<code class="font-mono">ctx.kv</code>).</p>
						<Button variant="outline" size="icon-sm" aria-label="Refresh" title="Refresh" disabled={kvLoading} onclick={() => void loadKv()}>
							{#if kvLoading}<Spinner class="size-4" />{:else}<ArrowClockwiseIcon class="size-4" />{/if}
						</Button>
					</div>
					{#if kvError}
						<p class="text-sm text-destructive-text" role="alert">{kvError}</p>
					{:else if !kv}
						<Skeleton class="h-24 w-full" />
					{:else if !kv.length}
						<p class="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">Nothing saved yet.</p>
					{:else}
						<Surface>
							<ul class="divide-y divide-border">
								{#each kv as e (e.key)}
									<li class="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:gap-4">
										<code class="w-48 shrink-0 font-mono text-xs font-medium break-all">{e.key}</code>
										<pre class="max-h-48 min-w-0 flex-1 overflow-auto font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">{prettyValue(e.value)}</pre>
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

<Sheet.Root bind:open={showRef}>
	<Sheet.Content side="right" class="w-full overflow-y-auto sm:max-w-xl">
		<Sheet.Header>
			<Sheet.Title>ctx reference</Sheet.Title>
			<Sheet.Description>Everything a script can call. In the editor, type <code class="font-mono">ctx.</code> for suggestions.</Sheet.Description>
		</Sheet.Header>
		<div class="px-4 pb-6"><ApiReference open /></div>
	</Sheet.Content>
</Sheet.Root>
