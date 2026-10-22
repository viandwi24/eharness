<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '#lib/api/index.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { type Storage, type StorageAction, actionLabels, confirmText, isLowDisk, percent, resultText, sizeText } from '#lib/storage/model.js';
	import { formatDateTime, timeAgo } from '#lib/time.js';

	let storage = $state<Storage | null>(null);
	let loadError = $state('');
	let loading = $state(false);
	let running = $state<StorageAction | ''>('');
	let lastResult = $state('');

	let confirmOpen = $state(false);
	let pending = $state<StorageAction>('checkpoint');
	let mediaDays = $state('3');

	async function load(refresh = false): Promise<void> {
		loading = true;
		try {
			storage = await api.get('/storage', refresh ? { query: { refresh: '1' } } : {});
			loadError = '';
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'Could not read the storage';
		} finally {
			loading = false;
		}
	}

	onMount(() => void load());

	function ask(action: StorageAction): void {
		pending = action;
		confirmOpen = true;
	}

	const days = $derived(Math.max(1, Math.floor(Number(mediaDays)) || 3));

	async function run(): Promise<void> {
		const action = pending;
		running = action;
		lastResult = '';
		try {
			const r = await api.post('/storage/actions/{action}', { params: { action }, body: { confirm: true, ...(action === 'clear-media' ? { days } : {}) } });
			lastResult = resultText(r);
			toast.success(r.message);
		} catch (e) {
			const message = e instanceof Error ? e.message : 'The action failed';
			lastResult = message;
			toast.error(message);
		} finally {
			running = '';
			await load(true);
		}
	}

	const volumePct = $derived(storage?.volume ? percent(storage.volume.usedBytes, storage.volume.totalBytes) : 0);
	const low = $derived(storage?.volume ? isLowDisk(storage.volume) : false);
	const maxFolder = $derived(Math.max(1, ...(storage?.library.folders.map((f) => f.bytes) ?? [1])));
	const maxGroup = $derived(Math.max(1, ...(storage?.database.groups.map((g) => g.bytes ?? g.rows) ?? [1])));
	const actions: Array<{ id: StorageAction; hint: string }> = [
		{ id: 'checkpoint', hint: 'Empty the write-ahead log into the database file.' },
		{ id: 'retention', hint: 'Run every retention cleanup now.' },
		{ id: 'clear-media', hint: 'Delete tool media and screenshots older than N days.' },
		{ id: 'compact', hint: 'VACUUM: give free pages back to the disk. Needs free space about the size of the database.' }
	];
</script>

<div class="flex flex-col gap-4">
	{#if loadError}
		<Alert.Root variant="destructive"><Alert.Title>Could not read the storage</Alert.Title><Alert.Description>{loadError}</Alert.Description></Alert.Root>
	{:else if !storage}
		<p class="text-sm text-muted-foreground">Scanning the data directory…</p>
	{:else}
		{#each storage.warnings as w (w.code + w.text)}
			<Alert.Root variant={w.code === 'low-disk' ? 'destructive' : 'warning'} role="alert"><Alert.Description>{w.text}</Alert.Description></Alert.Root>
		{/each}

		<Card.Root>
			<Card.Header>
				<Card.Title>Disk</Card.Title>
				<Card.Description>
					Data directory <span class="font-mono text-xs">{storage.dataDir}</span>. Scanned {timeAgo(storage.scannedAt)} in {storage.tookMs} ms (reused for 60 seconds).
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				{#if storage.volume}
					<Progress value={volumePct} aria-label="Disk used" class={low ? '[&_[data-slot=progress-indicator]]:bg-destructive' : ''} />
					<div class="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
						<span><span class="font-mono">{sizeText(storage.volume.usedBytes)}</span> used of <span class="font-mono">{sizeText(storage.volume.totalBytes)}</span> ({volumePct}%)</span>
						<span class={low ? 'font-medium text-destructive-text' : ''}><span class="font-mono">{sizeText(storage.volume.freeBytes)}</span> free</span>
					</div>
				{:else}
					<p class="text-sm text-muted-foreground">The size of the volume could not be read.</p>
				{/if}
				<div><Button size="sm" variant="outline" onclick={() => load(true)} disabled={loading}>{loading ? 'Scanning…' : 'Scan again'}</Button></div>
			</Card.Content>
		</Card.Root>

		<div class="grid gap-4 md:grid-cols-2">
			<Card.Root>
				<Card.Header><Card.Title>Database</Card.Title><Card.Description class="font-mono text-xs">{storage.database.file}</Card.Description></Card.Header>
				<Card.Content class="flex flex-col gap-1 text-sm">
					<div class="flex justify-between"><span>team.db</span><span class="font-mono">{sizeText(storage.database.dbBytes)}</span></div>
					<div class="flex justify-between"><span>Write-ahead log (-wal)</span><span class="font-mono">{sizeText(storage.database.walBytes)}</span></div>
					<div class="flex justify-between"><span>Shared memory (-shm)</span><span class="font-mono">{sizeText(storage.database.shmBytes)}</span></div>
					<div class="flex justify-between border-t border-border pt-1 font-medium"><span>Total</span><span class="font-mono">{sizeText(storage.database.totalBytes)}</span></div>
					<div class="mt-2 flex justify-between text-muted-foreground"><span>Pages</span><span class="font-mono">{storage.database.pageCount.toLocaleString()} × {sizeText(storage.database.pageSize)}</span></div>
					<div class="flex justify-between text-muted-foreground"><span>Free pages (reclaimable)</span><span class="font-mono">{storage.database.freelistPages.toLocaleString()} ({sizeText(storage.database.reclaimableBytes)})</span></div>
					<div class="flex justify-between text-muted-foreground"><span>Auto vacuum</span><span class="font-mono">{storage.database.autoVacuum}</span></div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header><Card.Title>Library</Card.Title><Card.Description>Files in the shared library, memory and tool media.</Card.Description></Card.Header>
				<Card.Content class="flex flex-col gap-1 text-sm">
					<div class="flex justify-between"><span>Files</span><span class="font-mono">{storage.library.files.toLocaleString()} ({sizeText(storage.library.bytes)})</span></div>
					<div class="flex justify-between"><span>Version history</span><span class="font-mono">{storage.library.history.versions.toLocaleString()} versions ({sizeText(storage.library.history.bytes)})</span></div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header><Card.Title>Backups</Card.Title><Card.Description class="font-mono text-xs">{storage.backups?.path ?? 'No backup directory (in-memory database)'}</Card.Description></Card.Header>
				<Card.Content class="flex flex-col gap-1 text-sm">
					{#if storage.backups}
						<div class="flex justify-between"><span>Snapshots</span><span class="font-mono">{storage.backups.snapshots} ({storage.backups.files} files, {sizeText(storage.backups.totalBytes)})</span></div>
						<div class="flex justify-between"><span>Newest</span><span>{storage.backups.newestAt ? formatDateTime(storage.backups.newestAt) : '—'}</span></div>
						<div class="flex justify-between"><span>Oldest</span><span>{storage.backups.oldestAt ? formatDateTime(storage.backups.oldestAt) : '—'}</span></div>
						<div class="flex justify-between">
							<span>Disk</span>
							{#if storage.backups.sameVolume === true}<Badge variant="destructive">Same disk as the database</Badge>
							{:else if storage.backups.sameVolume === false}<Badge variant="secondary">Another disk</Badge>
							{:else}<span>—</span>{/if}
						</div>
					{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header><Card.Title>Other folders</Card.Title><Card.Description>Next to the database, if present.</Card.Description></Card.Header>
				<Card.Content class="flex flex-col gap-2 text-sm">
					{#each storage.others as d (d.id)}
						<div>
							<div class="flex justify-between"><span>{d.label}</span><span class="font-mono">{d.approximate ? '≥ ' : ''}{sizeText(d.bytes)} · {d.files.toLocaleString()} files{d.approximate ? ' (approximate)' : ''}</span></div>
							<div class="truncate font-mono text-xs text-muted-foreground" title={d.path}>{d.path}</div>
							{#each d.children.slice(0, 4) as c (c.name)}
								<div class="flex justify-between pl-3 text-xs text-muted-foreground"><span>{c.name}</span><span class="font-mono">{sizeText(c.bytes)}</span></div>
							{/each}
						</div>
					{:else}
						<p class="text-muted-foreground">None of them exist.</p>
					{/each}
				</Card.Content>
			</Card.Root>
		</div>

		<Card.Root>
			<Card.Header><Card.Title>Database by feature</Card.Title><Card.Description>{storage.database.perTableBytes ? 'Table and index bytes.' : 'This SQLite has no size statistics: row counts only.'}</Card.Description></Card.Header>
			<Card.Content class="flex flex-col gap-2">
				{#each storage.database.groups as g (g.group)}
					<div class="flex items-center gap-3 text-sm">
						<span class="w-44 shrink-0">{g.label}</span>
						<div class="h-2 flex-1 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-primary" style="width: {percent(g.bytes ?? g.rows, maxGroup)}%"></div></div>
						<span class="w-32 shrink-0 text-right font-mono text-xs">{g.bytes === null ? '' : sizeText(g.bytes)} · {g.rows.toLocaleString()} rows</span>
					</div>
				{/each}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header><Card.Title>Biggest tables</Card.Title></Card.Header>
			<Card.Content class="overflow-x-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row><Table.Head>Table</Table.Head><Table.Head>Feature</Table.Head><Table.Head class="text-right">Rows</Table.Head><Table.Head class="text-right">Size</Table.Head></Table.Row>
					</Table.Header>
					<Table.Body>
						{#each storage.database.tables as t (t.name)}
							<Table.Row>
								<Table.Cell class="font-mono text-xs">{t.name}</Table.Cell>
								<Table.Cell class="text-xs text-muted-foreground">{t.group}</Table.Cell>
								<Table.Cell class="text-right font-mono text-xs">{t.rows === null ? '—' : t.rows.toLocaleString()}</Table.Cell>
								<Table.Cell class="text-right font-mono text-xs">{sizeText(t.bytes)}</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header><Card.Title>Library by folder</Card.Title></Card.Header>
			<Card.Content class="flex flex-col gap-2">
				{#each storage.library.folders as f (f.folder)}
					<div class="flex items-center gap-3 text-sm">
						<span class="w-64 shrink-0 truncate font-mono text-xs" title={f.folder}>{f.folder}</span>
						<div class="h-2 flex-1 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-primary" style="width: {percent(f.bytes, maxFolder)}%"></div></div>
						<span class="w-36 shrink-0 text-right font-mono text-xs">{sizeText(f.bytes)} · {f.files.toLocaleString()} files</span>
					</div>
				{:else}
					<p class="text-sm text-muted-foreground">The library is empty.</p>
				{/each}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header><Card.Title>Maintenance</Card.Title><Card.Description>Each action asks first and reports the database size before and after.</Card.Description></Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<div class="flex max-w-40 flex-col gap-1">
					<label class="text-[13px] text-muted-foreground" for="storage-media-days">Clear media older than (days)</label>
					<Input id="storage-media-days" type="number" min={1} max={3650} step={1} bind:value={mediaDays} />
				</div>
				<div class="grid gap-2 sm:grid-cols-2">
					{#each actions as a (a.id)}
						<div class="flex flex-col gap-1 rounded-lg border border-border p-3">
							<Button size="sm" variant={a.id === 'compact' ? 'outline' : 'secondary'} onclick={() => ask(a.id)} disabled={running !== ''}>{running === a.id ? 'Working…' : actionLabels[a.id]}</Button>
							<span class="text-xs text-muted-foreground">{a.hint}</span>
						</div>
					{/each}
				</div>
				{#if lastResult}<p class="text-sm" role="status">{lastResult}</p>{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</div>

<ConfirmDialog bind:open={confirmOpen} title={actionLabels[pending]} description={storage ? confirmText(pending, storage, days) : ''} confirmLabel={actionLabels[pending]} confirmVariant="default" onConfirm={run} />
