<script lang="ts">
	import FileTextIcon from 'phosphor-svelte/lib/FileText';
	import { untrack } from 'svelte';
	import { api } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import { MessageResponse } from '#lib/components/ai/message/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { cleanPath, formatBytes } from '#lib/files/helpers.js';
	import { isFileExists } from '#lib/conflict.js';
	import { formatTime } from '#lib/format.js';
	import { live } from '#lib/stores/live.svelte.js';
	import TextEditor from './TextEditor.svelte';

	type Info = components['schemas']['MemoryFileInfo'];
	type Scope = components['schemas']['MemoryScope'];

	let { scope, agentId, compact = false }: { scope: Scope; agentId?: string; compact?: boolean } = $props();

	let files = $state<Info[]>([]);
	let loaded = $state(false);
	let listError = $state('');
	let selected = $state<string | null>(null);
	let file = $state<{ content: string; version: string } | null>(null);
	let fileError = $state('');
	let editing = $state(false);
	let creating = $state(false);
	let newPath = $state('');
	let createError = $state('');

	const query = (path: string) => ({ scope, path, ...(agentId ? { agentId } : {}) });

	let listSeq = 0;
	async function loadList(): Promise<void> {
		const mine = ++listSeq;
		try {
			const r = await api.get('/memory', { query: { scope, ...(agentId ? { agentId } : {}) } });
			if (mine !== listSeq) return;
			files = r.files.slice().sort((a, b) => a.path.localeCompare(b.path));
			listError = '';
			loaded = true;
		} catch (e) {
			if (mine === listSeq) listError = e instanceof Error ? e.message : 'Could not load memory';
		}
	}

	async function open(path: string): Promise<void> {
		selected = path;
		editing = false;
		fileError = '';
		file = null;
		await refreshFile();
	}

	async function refreshFile(): Promise<void> {
		if (!selected) return;
		const path = selected;
		try {
			const r = await api.get('/memory/file', { query: query(path) });
			if (selected === path) file = { content: r.content, version: r.version };
		} catch (e) {
			if (selected === path) {
				file = null;
				fileError = e instanceof Error ? e.message : 'Could not load the file';
			}
		}
	}

	// Reload on scope change and whenever a memory file changes anywhere (agents write memory too).
	$effect(() => {
		void scope;
		void agentId;
		void live.state.revs.files;
		untrack(() => {
			void loadList();
			if (selected && !editing) void refreshFile();
		});
	});

	async function remove(): Promise<void> {
		if (!selected || !confirm(`Delete ${selected}?`)) return;
		try {
			await api.delete('/memory/file', { query: query(selected) });
			toast.success('Memory file deleted');
			selected = null;
			file = null;
			await loadList();
		} catch (e) {
			fileError = e instanceof Error ? e.message : 'Could not delete the file';
		}
	}

	async function create(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		const p = cleanPath(newPath)?.slice(1);
		if (!p) {
			createError = 'Enter a relative path such as notes/team.md';
			return;
		}
		try {
			await api.put('/memory/file', { query: query(p), body: { content: '', ifVersion: null } });
			creating = false;
			newPath = '';
			createError = '';
			await loadList();
			await open(p);
			editing = true;
		} catch (err) {
			createError = isFileExists(err) ? 'That file already exists' : err instanceof Error ? err.message : String(err);
		}
	}
</script>

<div class="flex flex-col gap-3 {compact ? 'text-sm' : ''}">
	{#if listError}<p class="text-xs text-destructive-text">{listError}</p>{/if}
	{#if !loaded && !listError}<p class="text-muted-foreground">Loading…</p>{/if}
	{#if loaded && !files.length}<p class="text-muted-foreground">No memory files yet.</p>{/if}
	<div class="flex flex-col gap-1">
		{#each files as f (f.path)}
			<button
				type="button"
				class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent {selected === f.path ? 'bg-accent' : ''}"
				onclick={() => void open(f.path)}
			>
				<FileTextIcon class="size-4 shrink-0 text-muted-foreground" />
				<span class="min-w-0 flex-1 truncate font-mono text-xs">{f.path}</span>
				<span class="text-xs text-muted-foreground">{formatBytes(f.size)} · {formatTime(f.updatedAt)}</span>
			</button>
		{/each}
	</div>

	{#if creating}
		<form class="flex flex-col gap-1" onsubmit={create}>
			<div class="flex gap-2">
				<Input bind:value={newPath} placeholder="notes/team.md" aria-label="New memory file path" />
				<Button type="submit" size="sm">Create</Button>
				<Button type="button" size="sm" variant="ghost" onclick={() => ((creating = false), (createError = ''))}>Cancel</Button>
			</div>
			{#if createError}<span class="text-xs text-destructive-text">{createError}</span>{/if}
		</form>
	{:else}
		<Button size="sm" variant="outline" class="self-start" onclick={() => (creating = true)}>New file</Button>
	{/if}

	{#if selected}
		<div class="flex flex-col gap-2 rounded-lg border border-border p-3">
			<div class="flex items-center gap-2">
				<span class="min-w-0 flex-1 truncate font-mono text-xs font-medium">{selected}</span>
				{#if file && !editing}
					<Button size="sm" variant="outline" onclick={() => (editing = true)}>Edit</Button>
					<Button size="sm" variant="outline" onclick={remove}>Delete</Button>
				{/if}
			</div>
			{#if fileError}<p class="text-xs text-destructive-text">{fileError}</p>{/if}
			{#if file && editing}
				{#key file.version}
					<TextEditor
						initial={file.content}
						version={file.version}
						rows={compact ? 10 : 16}
						save={(content, ifVersion) =>
							api.put('/memory/file', { query: query(selected!), body: { content, ...(ifVersion === undefined ? {} : { ifVersion }) } })}
						loadLatest={async () => {
							try {
								const r = await api.get('/memory/file', { query: query(selected!) });
								return { content: r.content, version: r.version };
							} catch {
								return null;
							}
						}}
						onSaved={(content, version) => {
							file = { content, version };
							editing = false;
							void loadList();
							toast.success('Memory saved');
						}}
						onReload={(l) => {
							file = l.version ? { content: l.content, version: l.version } : file;
							editing = false;
						}}
						onCancel={() => (editing = false)}
					/>
				{/key}
			{:else if file}
				{#if selected.endsWith('.md')}
					<MessageResponse content={file.content || '*(empty)*'} />
				{:else}
					<pre class="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-xs">{file.content}</pre>
				{/if}
			{/if}
		</div>
	{/if}
</div>
