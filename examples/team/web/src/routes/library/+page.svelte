<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import FileTextIcon from 'phosphor-svelte/lib/FileText';
	import FolderIcon from 'phosphor-svelte/lib/Folder';
	import UploadSimpleIcon from 'phosphor-svelte/lib/UploadSimple';
	import { api, uploadLibraryFile } from '#lib/api/index.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import LibraryViewer from '#lib/components/app/LibraryViewer.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { isFileExists } from '#lib/conflict.js';
	import { breadcrumbs, cleanPath, fileKind, formatBytes, listFolder, parentOf, type LibraryEntry } from '#lib/files/helpers.js';
	import { formatTime } from '#lib/format.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';

	let all = $state<LibraryEntry[]>([]);
	let loaded = $state(false);
	let error = $state('');
	let creating = $state(false);
	let newPath = $state('/library/');
	let createError = $state('');
	let uploading = $state(false);
	let fileInput = $state<HTMLInputElement>();

	const selected = $derived(page.url.searchParams.get('path'));
	const dir = $derived(page.url.searchParams.get('dir') ?? (selected ? parentOf(selected) : '/'));
	const listing = $derived(listFolder(all, dir));
	const entry = $derived(selected ? all.find((f) => f.path === selected) : undefined);

	function nav(next: { path?: string | null; dir?: string | null }): void {
		const q = new URLSearchParams();
		const d = next.dir === undefined ? dir : next.dir;
		if (d && d !== '/') q.set('dir', d);
		if (next.path) q.set('path', next.path);
		void goto(`/library${q.size ? `?${q}` : ''}`);
	}

	let seq = 0;
	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/library', { query: { limit: 2000 } });
			if (mine !== seq) return;
			all = r.files;
			error = '';
			loaded = true;
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the library';
		}
	}
	$effect(() => {
		void live.state.revs.files;
		untrack(() => void load());
	});

	async function create(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		const p = cleanPath(newPath);
		if (!p) {
			createError = 'Enter a path such as /library/notes.md';
			return;
		}
		try {
			await api.put('/library/file', { body: { path: p, content: '', ifVersion: null } });
			creating = false;
			createError = '';
			await load();
			nav({ path: p, dir: parentOf(p) });
		} catch (err) {
			createError = isFileExists(err) ? 'That file already exists' : err instanceof Error ? err.message : String(err);
		}
	}

	async function upload(e: Event): Promise<void> {
		const input = e.currentTarget as HTMLInputElement;
		const f = input.files?.[0];
		input.value = '';
		if (!f) return;
		uploading = true;
		try {
			const r = await uploadLibraryFile(f);
			toast.success(`Uploaded ${r.name}`);
			await load();
			nav({ path: r.path, dir: parentOf(r.path) });
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Upload failed');
		} finally {
			uploading = false;
		}
	}
</script>

<div class="flex min-w-0 flex-1 flex-col">
	<PageHeader title="Library">
		<Button size="sm" variant="outline" onclick={() => ((creating = !creating), (createError = ''))}>New file</Button>
		<Button size="sm" variant="outline" disabled={uploading} onclick={() => fileInput?.click()}>
			<UploadSimpleIcon class="size-4" />{uploading ? 'Uploading…' : 'Upload'}
		</Button>
		<input bind:this={fileInput} type="file" class="hidden" onchange={upload} />
	</PageHeader>

	<div class="flex min-h-0 flex-1">
		<section class="{selected ? 'hidden md:flex' : 'flex'} min-h-0 w-full shrink-0 flex-col overflow-y-auto border-r border-border md:w-96">
			<nav class="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2 text-xs" aria-label="Folder">
				{#each breadcrumbs(dir) as b, i (b.path)}
					{#if i > 0}<span class="text-muted-foreground">/</span>{/if}
					<button type="button" class="rounded px-1 hover:bg-accent {b.path === dir ? 'font-medium' : 'text-muted-foreground'}" onclick={() => nav({ dir: b.path, path: null })}>{b.name}</button>
				{/each}
			</nav>
			{#if creating}
				<form class="flex flex-col gap-1 border-b border-border p-3" onsubmit={create}>
					<div class="flex gap-2">
						<Input bind:value={newPath} aria-label="New file path" class="font-mono text-xs" />
						<Button type="submit" size="sm">Create</Button>
					</div>
					{#if createError}<span class="text-xs text-destructive-text">{createError}</span>{/if}
				</form>
			{/if}
			<div class="flex flex-col gap-0.5 p-2 text-sm">
				{#if error}<p class="p-2 text-destructive-text">{error}</p>{/if}
				{#if !loaded && !error}<p class="p-2 text-muted-foreground">Loading…</p>{/if}
				{#if loaded && !listing.folders.length && !listing.files.length}
					<p class="p-2 text-muted-foreground">{all.length ? 'This folder is empty.' : 'No files yet. Agents add artifacts here; you can also create or upload one.'}</p>
				{/if}
				{#each listing.folders as f (f.path)}
					<button type="button" class="flex items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-accent" onclick={() => nav({ dir: f.path, path: null })}>
						<FolderIcon class="size-4 shrink-0 text-muted-foreground" />
						<span class="min-w-0 flex-1 truncate">{f.name}</span>
						<span class="text-xs text-muted-foreground">{f.count} file{f.count === 1 ? '' : 's'}</span>
					</button>
				{/each}
				{#each listing.files as f (f.path)}
					<button
						type="button"
						class="flex items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-accent {selected === f.path ? 'bg-accent' : ''}"
						onclick={() => nav({ path: f.path })}
					>
						{#if f.createdBy}
							<AgentAvatar seed={f.createdBy.id} color={agentsStore.find(f.createdBy.id)?.color} size={20} label={f.createdBy.name} />
						{:else}
							<FileTextIcon class="size-5 shrink-0 text-muted-foreground" />
						{/if}
						<span class="min-w-0 flex-1">
							<span class="block truncate font-mono text-xs">{f.path.slice(f.path.lastIndexOf('/') + 1)}</span>
							<span class="block text-xs text-muted-foreground">
								{f.createdBy?.name ?? 'you'} · {fileKind(f)} · {formatBytes(f.size)} · {formatTime(f.updatedAt)}
							</span>
						</span>
					</button>
				{/each}
			</div>
		</section>

		<section class="{selected ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-1 flex-col">
			{#if selected}
				<div class="border-b border-border px-3 py-1 md:hidden">
					<Button size="sm" variant="ghost" onclick={() => nav({ path: null })}>Back to files</Button>
				</div>
				{#key selected}
					<LibraryViewer
						path={selected}
						{entry}
						onMoved={(to) => (void load(), nav({ path: to, dir: parentOf(to) }))}
						onDeleted={() => (void load(), nav({ path: null }))}
					/>
				{/key}
			{:else}
				<p class="p-6 text-sm text-muted-foreground">Select a file to view it.</p>
			{/if}
		</section>
	</div>
</div>
