<script lang="ts">
	import { untrack } from 'svelte';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircle';
	import FileTextIcon from 'phosphor-svelte/lib/FileText';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import UploadSimpleIcon from 'phosphor-svelte/lib/UploadSimple';
	import { api, uploadLibraryFile } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { relativeTime } from '#lib/routines/schedule.js';
	import { type FileFormat, formatBytes, formatOf, type TableImportResult } from '#lib/tables/tables.js';
	import { cn } from '#lib/utils.js';

	/** Import a CSV, JSON or NDJSON file: upload one, or pick one from the library. */
	let { open = $bindable(false), table, fields, onDone }: { open?: boolean; table: string; fields: string[]; onDone: () => void } = $props();

	type Entry = { path: string; size: number; updatedAt: number };
	let source = $state<'upload' | 'library'>('upload');
	let files = $state<Entry[] | null>(null);
	let search = $state('');
	let path = $state('');
	let format = $state<'' | FileFormat>('');
	let upsertKey = $state('');
	let preview = $state<string[] | null>(null);
	let dragging = $state(false);
	let uploading = $state(false);
	let busy = $state(false);
	let error = $state('');
	let result = $state<TableImportResult | null>(null);
	let input = $state<HTMLInputElement | null>(null);

	const detected = $derived(path ? formatOf(path) : null);
	const shown = $derived((files ?? []).filter((f) => !search.trim() || f.path.toLowerCase().includes(search.trim().toLowerCase())));
	const FORMAT_LABEL: Record<FileFormat, string> = { csv: 'CSV', json: 'JSON', ndjson: 'NDJSON' };

	$effect(() => {
		if (!open) return;
		untrack(() => {
			path = '';
			format = '';
			upsertKey = '';
			preview = null;
			error = '';
			result = null;
			search = '';
			void loadFiles();
		});
	});

	async function loadFiles(): Promise<void> {
		files = null;
		try {
			const [lib, up] = await Promise.all([api.get('/library', { query: { prefix: '/library', limit: 2000 } }), api.get('/library', { query: { prefix: '/uploads', limit: 2000 } })]);
			files = [...lib.files, ...up.files].filter((f) => formatOf(f.path) !== null).sort((a, b) => b.updatedAt - a.updatedAt);
		} catch {
			files = [];
		}
	}

	async function choose(p: string): Promise<void> {
		path = p;
		result = null;
		error = '';
		preview = null;
		try {
			const r = (await api.get('/library/file', { query: { path: p } })) as unknown as { content?: string };
			preview = typeof r.content === 'string' ? r.content.split('\n').slice(0, 6) : null;
		} catch {
			preview = null;
		}
	}

	async function upload(file: File | undefined): Promise<void> {
		if (!file) return;
		if (!formatOf(file.name)) {
			error = 'Pick a .csv, .json, .ndjson or .jsonl file.';
			return;
		}
		uploading = true;
		error = '';
		try {
			const up = await uploadLibraryFile(file);
			await choose(up.path);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not upload the file';
		} finally {
			uploading = false;
		}
	}

	async function submit(): Promise<void> {
		error = '';
		result = null;
		busy = true;
		try {
			result = await api.post('/tables/{table}/import', { params: { table }, body: { path, ...(format ? { format } : {}), ...(upsertKey ? { upsertKey } : {}) } });
			onDone();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not import the file';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="[&>*]:min-w-0 max-h-[92dvh] overflow-y-auto sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>Import rows</Dialog.Title>
			<Dialog.Description>From a CSV file with a header line, a JSON list of objects, or NDJSON (one object per line).</Dialog.Description>
		</Dialog.Header>

		{#if result}
			<div class="flex flex-col items-center gap-3 rounded-lg border border-border p-6 text-center" role="status">
				<CheckCircleIcon class="size-8 text-success-text" weight="fill" />
				<p class="text-sm">
					<strong>{result.inserted.toLocaleString()}</strong> added · <strong>{result.updated.toLocaleString()}</strong> updated{#if result.skipped}
						· <strong class="text-destructive-text">{result.skipped.toLocaleString()}</strong> skipped{/if}
				</p>
				{#if result.errors.length}
					<ul class="max-h-40 w-full list-disc overflow-y-auto pl-5 text-left text-xs text-destructive-text">
						{#each result.errors as m, i (i)}<li>{m}</li>{/each}
					</ul>
				{/if}
			</div>
			<Dialog.Footer>
				<Button variant="ghost" onclick={() => (result = null)}>Import another</Button>
				<Button onclick={() => (open = false)}>Done</Button>
			</Dialog.Footer>
		{:else}
			<Tabs.Root bind:value={source}>
				<Tabs.List variant="line" class="h-9 gap-4">
					<Tabs.Trigger value="upload">Upload a file</Tabs.Trigger>
					<Tabs.Trigger value="library">From the library</Tabs.Trigger>
				</Tabs.List>
			</Tabs.Root>

			{#if source === 'upload'}
				<button
					type="button"
					class={cn(
						'flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
						dragging ? 'border-brand bg-brand-soft' : 'border-border hover:bg-accent'
					)}
					onclick={() => input?.click()}
					ondragover={(e) => {
						e.preventDefault();
						dragging = true;
					}}
					ondragleave={() => (dragging = false)}
					ondrop={(e) => {
						e.preventDefault();
						dragging = false;
						void upload(e.dataTransfer?.files[0]);
					}}
				>
					{#if uploading}<Spinner class="size-6" />{:else}<UploadSimpleIcon class="size-6 text-muted-foreground" />{/if}
					<span class="text-sm font-medium">{uploading ? 'Uploading…' : 'Drop a file here or click to choose'}</span>
					<span class="text-xs text-muted-foreground">.csv, .json, .ndjson — up to 10 MB. It is saved to the library under /uploads.</span>
				</button>
				<input bind:this={input} type="file" accept=".csv,.json,.ndjson,.jsonl,text/csv,application/json" class="hidden" onchange={(e) => void upload(e.currentTarget.files?.[0])} />
			{:else}
				<InputGroup.Root class="h-8">
					<InputGroup.Addon><MagnifyingGlassIcon class="size-4" /></InputGroup.Addon>
					<InputGroup.Input bind:value={search} placeholder="Search data files" aria-label="Search data files" />
				</InputGroup.Root>
				<div class="max-h-56 overflow-y-auto rounded-lg border border-border">
					{#if files === null}
						<div class="flex flex-col gap-1 p-2">{#each [0, 1, 2] as i (i)}<Skeleton class="h-8 w-full" />{/each}</div>
					{:else if !shown.length}
						<p class="p-4 text-center text-xs text-muted-foreground">{files.length ? 'No file matches.' : 'No CSV or JSON files in the library yet. Upload one instead.'}</p>
					{:else}
						{#each shown as f (f.path)}
							<button
								type="button"
								class={cn('flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent', path === f.path && 'bg-brand-soft')}
								onclick={() => void choose(f.path)}
							>
								<FileTextIcon class="size-4 shrink-0 text-muted-foreground" />
								<span class="min-w-0 flex-1 truncate font-mono text-xs">{f.path}</span>
								<span class="shrink-0 text-xs text-muted-foreground">{formatBytes(f.size)} · {relativeTime(f.updatedAt)}</span>
							</button>
						{/each}
					{/if}
				</div>
			{/if}

			{#if path}
				<div class="flex flex-col gap-3 rounded-lg border border-border p-3">
					<div class="flex min-w-0 items-center gap-2">
						<FileTextIcon class="size-4 shrink-0 text-muted-foreground" />
						<code class="min-w-0 flex-1 truncate font-mono text-xs">{path}</code>
						{#if detected}<Badge variant="secondary">{FORMAT_LABEL[detected]}</Badge>{/if}
					</div>
					{#if preview}
						<pre class="max-h-28 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-4 text-muted-foreground">{preview.join('\n')}</pre>
					{/if}
					<div class="grid gap-3 sm:grid-cols-2">
						<label class="flex flex-col gap-1.5 text-sm">
							Format
							<NativeSelect bind:value={format} size="sm">
								<NativeSelectOption value="">{detected ? `${FORMAT_LABEL[detected]} (from the name)` : 'From the name'}</NativeSelectOption>
								<NativeSelectOption value="csv">CSV</NativeSelectOption>
								<NativeSelectOption value="json">JSON list</NativeSelectOption>
								<NativeSelectOption value="ndjson">NDJSON</NativeSelectOption>
							</NativeSelect>
						</label>
						<label class="flex flex-col gap-1.5 text-sm">
							Rows that already exist
							<NativeSelect bind:value={upsertKey} size="sm">
								<NativeSelectOption value="">Always add as new rows</NativeSelectOption>
								{#each fields as f (f)}<NativeSelectOption value={f}>Update rows with the same {f}</NativeSelectOption>{/each}
							</NativeSelect>
						</label>
					</div>
				</div>
			{/if}

			{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
				<Button disabled={busy || !path || uploading} onclick={() => void submit()}>{#if busy}<Spinner />{/if}Import</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
