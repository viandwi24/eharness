<script lang="ts">
	import { api, apiBase } from '#lib/api/index.js';
	import { type DatabaseRestorePreview, type DatabaseRestoreStatus, bytesText, deltaText, lastRestoreText, phraseMatches, restartText, splitTables, tableClassText, totalsText } from '#lib/backups/model.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Table from '#lib/components/ui/table/index.js';

	/** The whole-database restore: preview, typed confirmation, restart, and the result after the server is back. */
	let {
		open = $bindable(false),
		backupId,
		label,
		undoOf,
		onDone
	}: { open: boolean; backupId: string | null; label: string; undoOf?: string; onDone?: () => void } = $props();

	let preview = $state<DatabaseRestorePreview | null>(null);
	let loading = $state(false);
	let error = $state('');
	let typed = $state('');
	let working = $state(false);
	let phase = $state<'confirm' | 'restarting' | 'done'>('confirm');
	let status = $state<DatabaseRestoreStatus | null>(null);
	let showUnchanged = $state(false);

	const split = $derived(preview ? splitTables(preview.tables) : { changed: [], unchanged: [] });
	const confirmed = $derived(!!preview && phraseMatches(typed, preview.phrase));
	const outcome = $derived(status ? lastRestoreText(status.last) : null);

	$effect(() => {
		if (!open || !backupId) return;
		const id = backupId;
		preview = null;
		error = '';
		typed = '';
		phase = 'confirm';
		status = null;
		showUnchanged = false;
		loading = true;
		api
			.get('/backups/{id}/database-restore', { params: { id } })
			.then((p) => (preview = p))
			.catch((e) => (error = e instanceof Error ? e.message : 'Could not compare the backup with the database'))
			.finally(() => (loading = false));
	});

	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

	async function healthy(): Promise<boolean> {
		try {
			return (await fetch(`${apiBase.replace(/\/+$/, '')}/health`, { cache: 'no-store' })).ok;
		} catch {
			return false;
		}
	}

	/** Wait for the server to go away (or a few seconds), then until it answers again (up to two minutes). */
	async function waitForServer(): Promise<boolean> {
		for (let i = 0; i < 10 && (await healthy()); i++) await sleep(500);
		for (let i = 0; i < 120; i++) {
			await sleep(1000);
			if (await healthy()) return true;
		}
		return false;
	}

	async function apply(): Promise<void> {
		if (!preview || !confirmed || !backupId) return;
		working = true;
		error = '';
		try {
			const r = await api.post('/backups/{id}/database-restore', { params: { id: backupId }, body: { confirm: preview.phrase, ...(undoOf ? { undoOf } : {}) } });
			if (r.restart === 'manual') {
				phase = 'done';
				status = await api.get('/backups/database-restore');
				onDone?.();
				return;
			}
			phase = 'restarting';
			if (!(await waitForServer())) {
				error = 'The server did not come back within two minutes. Check the process manager, then reload this page.';
				return;
			}
			status = await api.get('/backups/database-restore');
			phase = 'done';
			onDone?.();
		} catch (e) {
			error = e instanceof Error ? e.message : 'The restore failed';
		} finally {
			working = false;
		}
	}
</script>

<Dialog.Root open={open} onOpenChange={(o) => { if (phase !== 'restarting') open = o; }}>
	<Dialog.Content elevation="floating" class="flex max-h-[92svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>{undoOf ? 'Undo a whole database restore' : 'Restore the whole database'}</Dialog.Title>
			<Dialog.Description>From {label}. Every table is replaced by the backup, chats and everything else that only the database holds included. A verified safety backup is taken first, and this can be undone from the restore points.</Dialog.Description>
		</Dialog.Header>
		<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
			{#if loading}<p class="text-sm text-muted-foreground" role="status">Comparing the backup with the running database…</p>{/if}
			{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
			{#if phase === 'restarting'}
				<Alert.Root><Alert.Title>Restarting…</Alert.Title><Alert.Description>The restore is applied while the server starts. This page continues when it answers again; do not close it.</Alert.Description></Alert.Root>
			{:else if phase === 'done'}
				{#if outcome}
					<Alert.Root variant={outcome.ok ? 'success' : 'destructive'}><Alert.Title>{outcome.ok ? 'Done' : 'Not applied'}</Alert.Title><Alert.Description>{outcome.text}</Alert.Description></Alert.Root>
				{:else if status?.pending}
					<Alert.Root variant="warning"><Alert.Title>Staged</Alert.Title><Alert.Description>The restore applies when you restart the server yourself.</Alert.Description></Alert.Root>
				{:else}
					<Alert.Root><Alert.Title>No result yet</Alert.Title><Alert.Description>The server answered but reports no restore. Reload the page and check the restore points.</Alert.Description></Alert.Root>
				{/if}
			{:else if preview}
				{#if preview.pending}
					<Alert.Root variant="warning"><Alert.Title>Another restore is already staged</Alert.Title><Alert.Description>Cancel it first (in the Backups settings) before staging a new one.</Alert.Description></Alert.Root>
				{/if}
				{#if preview.warnings.length}
					<Alert.Root variant="warning">
						<Alert.Title>Read before you continue</Alert.Title>
						<Alert.Description><ul class="list-disc pl-4">{#each preview.warnings as w (w)}<li>{w}</li>{/each}</ul></Alert.Description>
					</Alert.Root>
				{/if}
				<p class="text-sm" role="status">{totalsText(preview.totals)}</p>
				{#if split.changed.length}
					<div class="max-h-72 overflow-auto rounded-lg border border-border">
						<Table.Root>
							<Table.Header>
								<Table.Row><Table.Head>Table</Table.Head><Table.Head>Kind</Table.Head><Table.Head class="text-right">Backup</Table.Head><Table.Head class="text-right">Now</Table.Head><Table.Head class="text-right">Change</Table.Head></Table.Row>
							</Table.Header>
							<Table.Body>
								{#each split.changed as t (t.table)}
									<Table.Row>
										<Table.Cell class="text-xs"><span class="font-mono">{t.table}</span><span class="block text-muted-foreground">{t.feature}</span></Table.Cell>
										<Table.Cell><Badge variant={t.class === 'snapshot' ? 'warning' : 'secondary'}>{tableClassText[t.class]}</Badge></Table.Cell>
										<Table.Cell class="text-right text-xs">{t.backup}</Table.Cell>
										<Table.Cell class="text-right text-xs">{t.live}</Table.Cell>
										<Table.Cell class="text-right text-xs font-medium">{deltaText(t.delta)}</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</div>
				{:else}
					<p class="text-sm text-muted-foreground">No table has a different number of rows (contents may still differ).</p>
				{/if}
				{#if split.unchanged.length}
					<div>
						<Button variant="ghost" size="sm" onclick={() => (showUnchanged = !showUnchanged)}>{showUnchanged ? 'Hide' : 'Show'} {split.unchanged.length} tables with the same row count</Button>
						{#if showUnchanged}
							<ul class="mt-1 columns-2 gap-4 text-xs text-muted-foreground">
								{#each split.unchanged as t (t.table)}<li class="font-mono">{t.table} ({t.live}){t.class === 'derived' ? ' cache' : ''}</li>{/each}
							</ul>
						{/if}
					</div>
				{/if}
				<p class="text-sm">{restartText(preview.restart)} Size of the backup: {bytesText(preview.backup.dbBytes)}.</p>
				<Field.Field>
					<Field.Label for="db-restore-confirm">Type <span class="font-mono">{preview.phrase}</span> to confirm</Field.Label>
					<Input id="db-restore-confirm" bind:value={typed} autocomplete="off" class="max-w-80 font-mono text-xs" />
				</Field.Field>
			{/if}
		</div>
		<Dialog.Footer class="border-t border-border px-5 py-3">
			<Button variant="ghost" disabled={phase === 'restarting'} onclick={() => (open = false)}>{phase === 'done' ? 'Close' : 'Cancel'}</Button>
			{#if phase === 'done' && outcome}
				<Button onclick={() => location.reload()}>Reload the page</Button>
			{:else if phase === 'confirm'}
				<Button variant="destructive" onclick={apply} disabled={working || !confirmed || !!preview?.pending}>{working ? 'Restoring…' : 'Restore the whole database'}</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
