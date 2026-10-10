<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import ClockCounterClockwiseIcon from 'phosphor-svelte/lib/ClockCounterClockwise';
	import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimple';
	import { api, fetchLibraryBlob } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { CodeBlock } from '#lib/components/ai/code-block/index.js';
	import { MessageResponse } from '#lib/components/ai/message/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { conflictVersion } from '#lib/conflict.js';
	import { basename, cleanPath, codeLanguage, fileKind, formatBytes, type LibraryEntry } from '#lib/files/helpers.js';
	import { formatTime } from '#lib/format.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import TextEditor from './TextEditor.svelte';

	type Version = components['schemas']['LibraryVersion'];

	let {
		path,
		entry,
		onMoved,
		onDeleted
	}: {
		path: string;
		/** The list row, when known (media type, creator). */
		entry?: LibraryEntry;
		onMoved: (to: string) => void;
		onDeleted: () => void;
	} = $props();

	let meta = $state<LibraryEntry | undefined>(undefined);
	let content = $state<string | null>(null);
	let blobUrl = $state<string | null>(null);
	let error = $state('');
	let loading = $state(false);
	let editing = $state(false);
	let renaming = $state(false);
	let newPath = $state('');
	let actionError = $state('');
	let versions = $state<Version[] | null>(null);
	let showVersions = $state(false);

	const info = $derived(meta ?? entry);
	const kind = $derived(info ? fileKind(info) : fileKind({ path, mediaType: null, binary: false }));
	const textual = $derived(kind === 'markdown' || kind === 'code' || kind === 'text');
	const creator = $derived(info?.createdBy ?? null);

	function revoke(): void {
		if (blobUrl) URL.revokeObjectURL(blobUrl);
		blobUrl = null;
	}
	onDestroy(revoke);

	let seq = 0;
	async function load(p: string, quiet: boolean): Promise<void> {
		const mine = ++seq;
		if (!quiet) {
			loading = true;
			content = null;
			revoke();
			meta = undefined;
			versions = null;
			showVersions = false;
		}
		try {
			if (!textual) {
				// Not text by the list's info: binary kinds are fetched as blobs (image/pdf), "other" just downloads.
				if (kind === 'image' || kind === 'pdf') {
					const b = await fetchLibraryBlob(p, { inline: true });
					if (mine !== seq) return;
					revoke();
					blobUrl = URL.createObjectURL(b);
				}
				error = '';
				return;
			}
			const r = await api.get('/library/file', { query: { path: p } });
			if (mine !== seq) return;
			if (!r?.file) throw new Error('No preview for this file type. Use Download.');
			meta = r.file;
			content = r.content;
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the file';
		} finally {
			if (mine === seq) loading = false;
		}
	}

	// Load on path change; refresh quietly when the file changed elsewhere (not while editing).
	let lastPath = '';
	$effect(() => {
		const p = path;
		void kind;
		const rev = live.state.revs.files;
		void rev;
		const changed = p !== lastPath;
		lastPath = p;
		if (changed) {
			editing = false;
			renaming = false;
			actionError = '';
		}
		untrack(() => {
			if (changed || !editing) void load(p, !changed);
		});
	});

	async function loadVersions(): Promise<void> {
		showVersions = !showVersions;
		if (!showVersions) return;
		try {
			versions = (await api.get('/library/versions', { query: { path, limit: 50 } })).versions;
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Could not load versions';
		}
	}

	async function download(): Promise<void> {
		try {
			const b = await fetchLibraryBlob(path);
			const url = URL.createObjectURL(b);
			const a = document.createElement('a');
			a.href = url;
			a.download = basename(path);
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Download failed';
		}
	}

	async function rename(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		const to = cleanPath(newPath);
		if (!to) {
			actionError = 'Enter an absolute path such as /library/notes/new-name.md';
			return;
		}
		if (to === path) {
			renaming = false;
			return;
		}
		try {
			await api.post('/library/move', { body: { from: path, to, ...(info?.version ? { ifVersion: info.version } : {}) } });
			toast.success('File moved');
			renaming = false;
			actionError = '';
			onMoved(to);
		} catch (err) {
			actionError = conflictVersion(err) ? 'The file changed since you opened it. Reload and try again.' : err instanceof Error ? err.message : String(err);
		}
	}

	async function remove(): Promise<void> {
		if (!confirm(`Delete ${path}? This cannot be undone.`)) return;
		try {
			await api.delete('/library/file', { query: { path, ...(info?.version ? { ifVersion: info.version } : {}) } });
			toast.success('File deleted');
			onDeleted();
		} catch (err) {
			actionError = conflictVersion(err) ? 'The file changed since you opened it. Reload and try again.' : err instanceof Error ? err.message : String(err);
		}
	}
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
	<div class="flex flex-wrap items-center gap-2">
		{#if creator}
			<AgentAvatar seed={creator.id} color={agentsStore.find(creator.id)?.color} size={24} label={creator.name} />
		{/if}
		<h2 class="min-w-0 flex-1 truncate font-mono text-sm font-medium" title={path}>{path}</h2>
		<Badge variant="outline">{kind}</Badge>
	</div>
	{#if info}
		<p class="text-xs text-muted-foreground">
			{creator ? `Created by ${creator.name}` : 'Created by you'} · {formatBytes(info.size)} · {info.mediaType ?? 'unknown type'} · updated {formatTime(info.updatedAt)}
		</p>
	{/if}

	<div class="flex flex-wrap gap-2">
		{#if textual && content !== null && !editing}
			<Button size="sm" variant="outline" onclick={() => (editing = true)}>Edit</Button>
		{/if}
		<Button size="sm" variant="outline" onclick={() => ((renaming = !renaming), (newPath = path))}>Rename / move</Button>
		<Button size="sm" variant="outline" onclick={download}><DownloadSimpleIcon class="size-4" />Download</Button>
		<Button size="sm" variant="outline" onclick={loadVersions}><ClockCounterClockwiseIcon class="size-4" />History</Button>
		<Button size="sm" variant="outline" onclick={remove}>Delete</Button>
	</div>

	{#if renaming}
		<form class="flex gap-2" onsubmit={rename}>
			<Input bind:value={newPath} aria-label="New path" class="font-mono text-xs" />
			<Button type="submit" size="sm">Move</Button>
			<Button type="button" size="sm" variant="ghost" onclick={() => (renaming = false)}>Cancel</Button>
		</form>
	{/if}
	{#if actionError}<p class="text-xs text-destructive-text" role="alert">{actionError}</p>{/if}

	{#if showVersions}
		<div class="rounded-lg border border-border p-3 text-xs">
			<h3 class="mb-2 font-medium">History (metadata only)</h3>
			{#if !versions}
				<p class="text-muted-foreground">Loading…</p>
			{:else if !versions.length}
				<p class="text-muted-foreground">No history.</p>
			{:else}
				<ul class="flex flex-col gap-1">
					{#each versions as v (v.seq)}
						<li class="flex flex-wrap gap-x-2">
							<span class="font-medium">{v.action}</span>
							<span>{v.by?.name ?? 'you'}</span>
							{#if v.size !== null}<span class="text-muted-foreground">{formatBytes(v.size)}</span>{/if}
							{#if v.fromPath}<span class="font-mono text-muted-foreground">from {v.fromPath}</span>{/if}
							<span class="ml-auto text-muted-foreground">{new Date(v.at).toLocaleString()}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}

	{#if error}
		<p class="text-sm text-destructive-text">{error}</p>
	{:else if loading}
		<p class="text-sm text-muted-foreground">Loading…</p>
	{:else if editing && content !== null && info}
		{#key info.version}
			<TextEditor
				initial={content}
				version={info.version}
				save={(c, ifVersion) => api.put('/library/file', { body: { path, content: c, ...(ifVersion === undefined ? {} : { ifVersion }) } })}
				loadLatest={async () => {
					try {
						const r = await api.get('/library/file', { query: { path } });
						return { content: r.content, version: r.file.version };
					} catch {
						return null;
					}
				}}
				onSaved={(c) => {
					editing = false;
					toast.success('File saved');
					void load(path, true);
					content = c;
				}}
				onReload={(l) => {
					content = l.content;
					editing = false;
					void load(path, true);
				}}
				onCancel={() => (editing = false)}
			/>
		{/key}
	{:else if kind === 'markdown' && content !== null}
		<MessageResponse content={content || '*(empty)*'} class="max-w-none" />
	{:else if kind === 'code' && content !== null}
		<CodeBlock code={content} language={(codeLanguage(path) ?? 'text') as never} showLineNumbers />
	{:else if kind === 'text' && content !== null}
		<pre class="whitespace-pre-wrap rounded-lg border border-border bg-card p-3 font-mono text-xs">{content}</pre>
	{:else if kind === 'image' && blobUrl}
		<img src={blobUrl} alt={basename(path)} class="max-h-[70vh] max-w-full self-start rounded-lg border border-border object-contain" />
	{:else if kind === 'pdf' && blobUrl}
		<iframe src={blobUrl} title={basename(path)} class="h-[70vh] w-full rounded-lg border border-border"></iframe>
	{:else if kind === 'other'}
		<p class="text-sm text-muted-foreground">No preview for this file type. Use Download.</p>
	{/if}
</div>
