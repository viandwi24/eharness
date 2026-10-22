<script lang="ts">
	import { onMount } from 'svelte';
	import FolderIcon from 'phosphor-svelte/lib/Folder';
	import { api } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { foldersOf } from '#lib/developers/model.js';

	/**
	 * Pick folders of the library (`GET /library`): the folders that hold files, plus any path typed
	 * in. `single` keeps at most one (the write folder). A grant is always a folder inside
	 * `/library`, never the library itself.
	 */
	let { value = $bindable([]), single = false, label }: { value?: string[]; single?: boolean; label: string } = $props();

	let found = $state<string[]>([]);
	let loading = $state(true);
	let typed = $state('');
	let error = $state('');

	onMount(() => {
		api.get('/library', { query: { prefix: '/library', limit: 2000 } }).then(
			(r) => {
				found = foldersOf(r.files.map((f) => f.path));
				loading = false;
			},
			() => {
				loading = false;
			}
		);
	});

	const all = $derived([...new Set([...found, ...value])].sort());

	function toggle(folder: string, on: boolean): void {
		if (on) value = single ? [folder] : [...value, folder];
		else value = value.filter((f) => f !== folder);
	}
	function add(): void {
		const raw = typed.trim().replace(/\/\*\*$/, '').replace(/\/+$/, '');
		if (!raw) return;
		const path = raw.startsWith('/') ? raw : `/${raw}`;
		if (!/^\/library\/[^/]/.test(path) || path.includes('..')) {
			error = 'Use a folder inside the library, like /library/public/support.';
			return;
		}
		error = '';
		typed = '';
		if (!value.includes(path)) value = single ? [path] : [...value, path];
	}
</script>

<div class="flex flex-col gap-2" data-testid="folder-picker">
	<span class="font-medium">{label}</span>
	<div class="max-h-40 overflow-y-auto rounded-md border border-border p-1">
		{#if loading}
			<p class="p-2 text-xs text-muted-foreground">Loading folders…</p>
		{:else if all.length === 0}
			<p class="p-2 text-xs text-muted-foreground">No folders in the library yet. Type a path below.</p>
		{:else}
			{#each all as folder (folder)}
				<label class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent/40">
					<Checkbox checked={value.includes(folder)} onCheckedChange={(v) => toggle(folder, v === true)} aria-label={folder} />
					<FolderIcon class="size-4 text-muted-foreground" />
					<span class="truncate font-mono text-xs">{folder}</span>
				</label>
			{/each}
		{/if}
	</div>
	<div class="flex gap-2">
		<Input bind:value={typed} placeholder="/library/public/support" class="font-mono text-xs" aria-label="Add a folder path" onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} />
		<Button type="button" variant="outline" size="sm" onclick={add}>Add</Button>
	</div>
	{#if error}<p class="text-xs text-destructive-text">{error}</p>{/if}
</div>
