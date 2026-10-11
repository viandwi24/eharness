<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { MediaQuery } from 'svelte/reactivity';
	import { untrack } from 'svelte';
	import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUp';
	import FilePlusIcon from 'phosphor-svelte/lib/FilePlus';
	import FilesIcon from 'phosphor-svelte/lib/Files';
	import FolderIcon from 'phosphor-svelte/lib/Folder';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import UploadSimpleIcon from 'phosphor-svelte/lib/UploadSimple';
	import XIcon from 'phosphor-svelte/lib/X';
	import { api, uploadLibraryFile } from '#lib/api/index.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import FileKindIcon from '#lib/components/app/FileKindIcon.svelte';
	import LibraryViewer from '#lib/components/app/LibraryViewer.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import * as Breadcrumb from '#lib/components/ui/breadcrumb/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as Resizable from '#lib/components/ui/resizable/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { isFileExists } from '#lib/conflict.js';
	import { basename, breadcrumbs, cleanPath, fileKind, formatBytes, listFolder, parentOf, type LibraryEntry } from '#lib/files/helpers.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { formatTime } from '#lib/format.js';

	let all = $state<LibraryEntry[]>([]);
	let loaded = $state(false);
	let error = $state('');
	let creating = $state(false);
	let newPath = $state('/library/');
	let createError = $state('');
	let uploading = $state(false);
	let fileInput = $state<HTMLInputElement>();
	let search = $state('');

	const desktop = new MediaQuery('min-width: 768px');

	const selected = $derived(page.url.searchParams.get('path'));
	const dir = $derived(page.url.searchParams.get('dir') ?? (selected ? parentOf(selected) : '/'));
	const listing = $derived(listFolder(all, dir));
	const entry = $derived(selected ? all.find((f) => f.path === selected) : undefined);
	const q = $derived(search.trim().toLowerCase());
	const results = $derived(q ? all.filter((f) => f.path.toLowerCase().includes(q)).sort((a, b) => b.updatedAt - a.updatedAt) : []);
	const crumbs = $derived(breadcrumbs(dir));

	function nav(next: { path?: string | null; dir?: string | null }): void {
		const params = new URLSearchParams();
		const d = next.dir === undefined ? dir : next.dir;
		if (d && d !== '/') params.set('dir', d);
		if (next.path) params.set('path', next.path);
		void goto(`/files${params.size ? `?${params}` : ''}`);
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
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the files';
		}
	}
	$effect(() => {
		void live.state.revs.files;
		untrack(() => void load());
	});

	function openCreate(): void {
		newPath = dir === '/' ? '/library/' : `${dir}/`;
		createError = '';
		creating = true;
	}

	async function create(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		const p = cleanPath(newPath);
		if (!p || newPath.trim().endsWith('/')) {
			createError = 'Enter a file path such as /library/notes.md';
			return;
		}
		try {
			await api.put('/library/file', { body: { path: p, content: '', ifVersion: null } });
			creating = false;
			createError = '';
			search = '';
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
			search = '';
			await load();
			nav({ path: r.path, dir: parentOf(r.path) });
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Upload failed');
		} finally {
			uploading = false;
		}
	}

	// Arrow keys move between rows (roving focus without tab stops per row).
	function rowKeys(e: KeyboardEvent): void {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		const rows = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[data-row]')];
		const i = rows.indexOf(document.activeElement as HTMLElement);
		if (i < 0) return;
		e.preventDefault();
		rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
	}

	const rowClass =
		'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';
</script>

{#snippet fileRow(f: LibraryEntry, showDir: boolean)}
	{@const kind = fileKind(f)}
	<button type="button" data-row class="{rowClass} {selected === f.path ? 'bg-accent' : ''}" aria-current={selected === f.path ? 'true' : undefined} onclick={() => nav({ path: f.path })}>
		<span class="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-muted text-muted-foreground"><FileKindIcon {kind} /></span>
		<span class="min-w-0 flex-1">
			<span class="block truncate text-[13px] font-medium">{basename(f.path)}</span>
			<span class="block truncate text-[11px] text-muted-foreground">
				{#if showDir}{parentOf(f.path)} · {/if}{formatBytes(f.size)} · {formatTime(f.updatedAt)}
			</span>
		</span>
		{#if f.createdBy}
			<AgentAvatar seed={f.createdBy.id} color={agentsStore.find(f.createdBy.id)?.color} size={18} label={f.createdBy.name} class="shrink-0" />
		{/if}
	</button>
{/snippet}

{#snippet list()}
	<div class="flex min-h-0 flex-1 flex-col">
		<div class="flex flex-col gap-2 border-b border-border p-2.5">
			<InputGroup.Root class="h-8">
				<InputGroup.Addon><MagnifyingGlassIcon /></InputGroup.Addon>
				<InputGroup.Input bind:value={search} placeholder="Filter files" aria-label="Filter files" class="text-[13px]" />
				{#if search}
					<InputGroup.Addon align="inline-end">
						<InputGroup.Button size="icon-xs" aria-label="Clear filter" onclick={() => (search = '')}><XIcon /></InputGroup.Button>
					</InputGroup.Addon>
				{/if}
			</InputGroup.Root>
			{#if !q}
				<Breadcrumb.Root aria-label="Folder path">
					<Breadcrumb.List class="gap-1 text-xs sm:gap-1">
						{#each crumbs as b, i (b.path)}
							<Breadcrumb.Item>
								{#if i === crumbs.length - 1}
									<Breadcrumb.Page>{b.name}</Breadcrumb.Page>
								{:else}
									<Breadcrumb.Link href="/files{b.path === '/' ? '' : `?dir=${encodeURIComponent(b.path)}`}" onclick={(e: MouseEvent) => (e.preventDefault(), nav({ dir: b.path, path: null }))}>{b.name}</Breadcrumb.Link>
								{/if}
							</Breadcrumb.Item>
							{#if i < crumbs.length - 1}<Breadcrumb.Separator />{/if}
						{/each}
					</Breadcrumb.List>
				</Breadcrumb.Root>
			{/if}
		</div>

		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5" role="list" aria-label="Files" onkeydown={rowKeys}>
			{#if error}
				<p class="p-2 text-sm text-destructive-text" role="alert">{error}</p>
			{:else if !loaded}
				{#each [0, 1, 2, 3, 4] as n (n)}<Skeleton class="h-12 w-full rounded-lg" />{/each}
			{:else if q}
				{#each results as f (f.path)}{@render fileRow(f, true)}{:else}
					<Empty.Root class="p-6"><Empty.Header><Empty.Title class="text-sm">No results</Empty.Title><Empty.Description>No file path contains "{search.trim()}".</Empty.Description></Empty.Header></Empty.Root>
				{/each}
			{:else if !all.length}
				<Empty.Root class="m-2 border">
					<Empty.Header>
						<Empty.Media variant="icon"><FilesIcon /></Empty.Media>
						<Empty.Title>No files yet</Empty.Title>
						<Empty.Description>Agents add artifacts here. You can also create or upload a file.</Empty.Description>
					</Empty.Header>
					<Empty.Content>
						<div class="flex gap-2">
							<Button size="sm" onclick={openCreate}><PlusIcon />New file</Button>
							<Button size="sm" variant="outline" onclick={() => fileInput?.click()}><UploadSimpleIcon />Upload</Button>
						</div>
					</Empty.Content>
				</Empty.Root>
			{:else}
				{#if dir !== '/'}
					<button type="button" data-row class={rowClass} onclick={() => nav({ dir: parentOf(dir), path: null })}>
						<span class="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground"><ArrowUpIcon class="size-4" /></span>
						<span class="text-[13px] text-muted-foreground">Up to {parentOf(dir) === '/' ? 'root' : basename(parentOf(dir))}</span>
					</button>
				{/if}
				{#each listing.folders as f (f.path)}
					<button type="button" data-row class={rowClass} onclick={() => nav({ dir: f.path, path: null })}>
						<span class="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-muted text-muted-foreground"><FolderIcon class="size-4" /></span>
						<span class="min-w-0 flex-1">
							<span class="block truncate text-[13px] font-medium">{f.name}</span>
							<span class="block text-[11px] text-muted-foreground">{f.count} file{f.count === 1 ? '' : 's'} · {formatTime(f.updatedAt)}</span>
						</span>
					</button>
				{/each}
				{#each listing.files as f (f.path)}{@render fileRow(f, false)}{/each}
				{#if !listing.folders.length && !listing.files.length}
					<p class="px-3 py-6 text-center text-xs text-muted-foreground">This folder is empty.</p>
				{/if}
			{/if}
		</div>
	</div>
{/snippet}

{#snippet preview()}
	{#if selected}
		{#key selected}
			<LibraryViewer
				path={selected}
				{entry}
				onBack={desktop.current ? undefined : () => nav({ path: null })}
				onMoved={(to) => (void load(), nav({ path: to, dir: parentOf(to) }))}
				onDeleted={() => (void load(), nav({ path: null }))}
			/>
		{/key}
	{:else}
		<Empty.Root class="m-4 border">
			<Empty.Header>
				<Empty.Media variant="icon"><FileKindIcon kind="text" /></Empty.Media>
				<Empty.Title>Select a file</Empty.Title>
				<Empty.Description>Pick a file on the left to preview, edit or download it.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{/if}
{/snippet}

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader
		title="Files"
		description={loaded ? `Shared files for you and your agents · ${all.length} file${all.length === 1 ? '' : 's'}` : 'Shared files for you and your agents.'}
		backHref={selected && !desktop.current ? '/files' : '/'}
	>
		{#snippet actions()}
			<Button size="sm" variant="outline" disabled={uploading} onclick={() => fileInput?.click()}>
				<UploadSimpleIcon /><span class="max-sm:sr-only">{uploading ? 'Uploading…' : 'Upload'}</span>
			</Button>
			<Button size="sm" onclick={openCreate}><FilePlusIcon /><span class="max-sm:sr-only">New file</span></Button>
		{/snippet}
	</PageHeader>
	<!-- Full width on purpose: file list + viewer split. -->
	<input bind:this={fileInput} type="file" class="hidden" onchange={upload} />

	{#if desktop.current}
		<Resizable.PaneGroup direction="horizontal" class="min-h-0 flex-1" autoSaveId="team-files-split">
			<Resizable.Pane defaultSize={34} minSize={24} maxSize={55} class="flex min-h-0 flex-col">{@render list()}</Resizable.Pane>
			<Resizable.Handle withHandle />
			<Resizable.Pane defaultSize={66} minSize={35} class="flex min-h-0 min-w-0 flex-col">{@render preview()}</Resizable.Pane>
		</Resizable.PaneGroup>
	{:else if selected}
		<div class="flex min-h-0 flex-1 flex-col">{@render preview()}</div>
	{:else}
		<div class="flex min-h-0 flex-1 flex-col">{@render list()}</div>
	{/if}
</div>

<Dialog.Root bind:open={creating}>
	<Dialog.Content elevation="floating" class="sm:max-w-md">
		<form class="flex flex-col gap-4" onsubmit={create}>
			<Dialog.Header>
				<Dialog.Title>New file</Dialog.Title>
				<Dialog.Description>Creates an empty file in the library. Missing folders are created for you.</Dialog.Description>
			</Dialog.Header>
			<Field.Field data-invalid={!!createError}>
				<Field.Label for="new-file-path">Path</Field.Label>
				<Input id="new-file-path" bind:value={newPath} class="font-mono text-xs" aria-invalid={!!createError} autocomplete="off" />
				{#if createError}<Field.Error>{createError}</Field.Error>{/if}
			</Field.Field>
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (creating = false)}>Cancel</Button>
				<Button type="submit">Create</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
