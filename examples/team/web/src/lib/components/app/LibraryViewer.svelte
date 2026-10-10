<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import { onDestroy, untrack } from 'svelte';
	import ClockCounterClockwiseIcon from 'phosphor-svelte/lib/ClockCounterClockwise';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeft';
	import DotsThreeIcon from 'phosphor-svelte/lib/DotsThree';
	import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimple';
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimple';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import { api, fetchLibraryBlob } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { CodeBlock } from '#lib/components/ai/code-block/index.js';
	import { MessageResponse } from '#lib/components/ai/message/index.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { conflictVersion } from '#lib/conflict.js';
	import { basename, cleanPath, codeLanguage, fileKind, formatBytes, type LibraryEntry } from '#lib/files/helpers.js';
	import { formatTime } from '#lib/format.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import FileKindIcon from './FileKindIcon.svelte';
	import TextEditor from './TextEditor.svelte';

	type Version = components['schemas']['LibraryVersion'];

	let {
		path,
		entry,
		onBack,
		onMoved,
		onDeleted
	}: {
		path: string;
		/** The list row, when known (media type, creator). */
		entry?: LibraryEntry;
		/** Shows a back button (mobile: the preview replaces the file list). */
		onBack?: () => void;
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
	let confirmDelete = $state(false);

	const info = $derived(meta ?? entry);
	const kind = $derived(info ? fileKind(info) : fileKind({ path, mediaType: null, binary: false }));
	const kindLabel: Record<string, string> = { markdown: 'Markdown', code: 'Code', text: 'Text', image: 'Image', pdf: 'PDF', other: 'File' };
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
		versions = null;
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
		confirmDelete = false;
		try {
			await api.delete('/library/file', { query: { path, ...(info?.version ? { ifVersion: info.version } : {}) } });
			toast.success('File deleted');
			onDeleted();
		} catch (err) {
			actionError = conflictVersion(err) ? 'The file changed since you opened it. Reload and try again.' : err instanceof Error ? err.message : String(err);
		}
	}
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<div class="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label="Back to files" onclick={onBack}><ArrowLeftIcon class="size-4" /></Button>
		{/if}
		<span class="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-muted text-muted-foreground"><FileKindIcon {kind} /></span>
		<div class="min-w-0 flex-1">
			<h2 class="truncate text-[13px] leading-4 font-medium" title={path}>{basename(path)}</h2>
			<p class="truncate font-mono text-[11px] leading-4 text-muted-foreground">{path}</p>
		</div>
		{#if textual && content !== null && !editing}
			<Button size="sm" variant="outline" onclick={() => (editing = true)}><PencilSimpleIcon />Edit</Button>
		{/if}
		<Button size="icon-sm" variant="ghost" aria-label="Download" title="Download" onclick={download}><DownloadSimpleIcon class="size-4" /></Button>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} size="icon-sm" variant="ghost" aria-label="More actions"><DotsThreeIcon class="size-4" weight="bold" /></Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-48">
				<DropdownMenu.Item onSelect={() => ((renaming = true), (newPath = path))}><PencilSimpleIcon />Rename / move</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={loadVersions}><ClockCounterClockwiseIcon />{showVersions ? 'Hide history' : 'History'}</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item variant="destructive" onSelect={() => (confirmDelete = true)}><TrashIcon />Delete</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>

	<div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
		{#if info}
			<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
				<Badge variant="outline">{kind}</Badge>
				{#if creator}
					<AgentAvatar seed={creator.id} color={agentsStore.find(creator.id)?.color} size={16} label={creator.name} />
				{/if}
				<span>{creator ? creator.name : 'You'}</span>
				<span aria-hidden="true">·</span><span>{formatBytes(info.size)}</span>
				<span aria-hidden="true">·</span><span>{info.mediaType ?? kindLabel[kind]}</span>
				<span aria-hidden="true">·</span><span>updated {formatTime(info.updatedAt)}</span>
			</div>
		{/if}

		{#if renaming}
			<form class="flex flex-wrap gap-2" onsubmit={rename}>
				<Input bind:value={newPath} aria-label="New path" class="min-w-0 flex-1 font-mono text-xs" />
				<Button type="submit" size="sm">Move</Button>
				<Button type="button" size="sm" variant="ghost" onclick={() => (renaming = false)}>Cancel</Button>
			</form>
		{/if}
		{#if actionError}<p class="text-xs text-destructive-text" role="alert">{actionError}</p>{/if}

		{#if showVersions}
			<Surface class="rounded-lg p-3 text-xs">
				<h3 class="mb-2 font-medium">History <span class="font-normal text-muted-foreground">(metadata only)</span></h3>
				{#if !versions}
					<p class="text-muted-foreground">Loading…</p>
				{:else if !versions.length}
					<p class="text-muted-foreground">No history.</p>
				{:else}
					<ul class="flex flex-col gap-1.5">
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
			</Surface>
		{/if}

		{#if error}
			<p class="text-sm text-destructive-text" role="alert">{error}</p>
		{:else if loading}
			<div class="flex flex-col gap-2"><Skeleton class="h-4 w-2/3" /><Skeleton class="h-4 w-full" /><Skeleton class="h-4 w-5/6" /></div>
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
			<pre class="whitespace-pre-wrap rounded-lg border border-sk-bd bg-sk-bg p-3 font-mono text-xs shadow-sunken">{content}</pre>
		{:else if kind === 'image' && blobUrl}
			<img src={blobUrl} alt={basename(path)} class="max-h-[70vh] max-w-full self-start rounded-lg border border-border object-contain" />
		{:else if kind === 'pdf' && blobUrl}
			<iframe src={blobUrl} title={basename(path)} class="h-[70vh] w-full rounded-lg border border-border"></iframe>
		{:else if kind === 'other'}
			<p class="text-sm text-muted-foreground">No preview for this file type. Use Download.</p>
		{/if}
	</div>
</div>

<AlertDialog.Root bind:open={confirmDelete}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete {basename(path)}?</AlertDialog.Title>
			<AlertDialog.Description>This permanently deletes <span class="font-mono">{path}</span>. This cannot be undone.</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action variant="destructive" onclick={remove}>Delete</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
