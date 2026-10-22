<script lang="ts">
	import { onMount } from 'svelte';
	import { api, fieldErrors } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import { type Backup, type DatabaseRestoreStatus, type ImportSource, type RestorePlan, type RestorePoint, type SectionId, bytesText, lastRestoreText, passphraseProblem, planSummary, reasonLabel, resultSummary, restorePointText, verifiedText } from '#lib/backups/model.js';
	import { downloadBackupFile, downloadWorkspaceExport, uploadWorkspaceZip } from '#lib/backups/download.js';
	import DatabaseRestoreDialog from '#lib/components/app/DatabaseRestoreDialog.svelte';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import WorkspaceImportDialog from '#lib/components/app/WorkspaceImportDialog.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { formatDateTime, timeAgo } from '#lib/time.js';

	type Settings = components['schemas']['Settings'];
	type Overview = components['schemas']['BackupList'];

	let overview = $state<Overview | null>(null);
	let loadError = $state('');
	let running = $state(false);
	let backupConversations = $state(false);
	let busy = $state('');

	// --- schedule (Settings: backupEnabled, backupTime, backupKeepDaily, backupKeepWeekly) -------
	let settings = $state<Settings | null>(null);
	let enabled = $state(true);
	let time = $state('02:00');
	let keepDaily = $state('14');
	let keepWeekly = $state('8');
	let saveError = $state('');
	let saving = $state(false);
	const scheduleDirty = $derived(
		!!settings && (enabled !== settings.backupEnabled || time !== settings.backupTime || keepDaily !== String(settings.backupKeepDaily) || keepWeekly !== String(settings.backupKeepWeekly))
	);

	function fill(s: Settings): void {
		settings = s;
		enabled = s.backupEnabled;
		time = s.backupTime;
		keepDaily = String(s.backupKeepDaily);
		keepWeekly = String(s.backupKeepWeekly);
	}

	let restorePoints = $state<RestorePoint[]>([]);

	let dbStatus = $state<DatabaseRestoreStatus | null>(null);
	const dbLast = $derived(dbStatus ? lastRestoreText(dbStatus.last) : null);

	async function cancelStaged(): Promise<void> {
		try {
			await api.delete('/backups/database-restore');
			toast.success('The staged restore was cancelled');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not cancel');
		}
		await load();
	}

	async function load(): Promise<void> {
		try {
			dbStatus = await api.get('/backups/database-restore').catch(() => null);
			overview = await api.get('/backups');
			restorePoints = (await api.get('/backups/restore-points')).restorePoints;
			loadError = '';
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'Could not load the backups';
		}
	}

	async function saveSchedule(): Promise<void> {
		saving = true;
		saveError = '';
		try {
			fill(await api.patch('/settings', { body: { backupEnabled: enabled, backupTime: time, backupKeepDaily: Number(keepDaily), backupKeepWeekly: Number(keepWeekly) } }));
			toast.success('Backup schedule saved');
			await load();
		} catch (e) {
			saveError = Object.values(fieldErrors(e) ?? {})[0] ?? (e instanceof Error ? e.message : 'Could not save');
		} finally {
			saving = false;
		}
	}

	onMount(() => {
		void load();
		void api.get('/settings').then(fill).catch(() => undefined);
	});

	async function backUpNow(): Promise<void> {
		running = true;
		try {
			const r = await api.post('/backups', { query: { conversations: backupConversations ? 'true' : 'false' } });
			if (r.ok) toast.success('Backup written and verified');
			else toast.error(`Backup failed: ${r.error ?? 'unknown problem'}`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Backup failed');
		} finally {
			running = false;
			await load();
		}
	}

	async function download(b: Backup, what: 'db' | 'files'): Promise<void> {
		busy = `${b.id}:${what}`;
		try {
			await downloadBackupFile(b.id, what);
		} catch (e) {
			if (!(e instanceof DOMException && e.name === 'AbortError')) toast.error(e instanceof Error ? e.message : 'Download failed');
		} finally {
			busy = '';
		}
	}

	let toDelete = $state<Backup | null>(null);
	let deleteOpen = $state(false);
	async function remove(): Promise<void> {
		if (!toDelete) return;
		try {
			await api.delete('/backups/{id}', { params: { id: toDelete.id } });
			toast.success('Backup deleted');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not delete');
		}
		await load();
	}

	// --- the workspace export and the import -----------------------------------------------------
	let importOpen = $state(false);
	let importSource = $state<ImportSource | null>(null);
	let importLabel = $state('');
	let importUndoOf = $state<string | undefined>(undefined);
	let importInitial = $state<{ sections: SectionId[]; exclude: string[]; removeSections: SectionId[]; overwrite?: boolean } | undefined>(undefined);
	let uploading = $state(false);
	let exporting = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);

	// the export: without secrets, or with the provider keys and connection credentials encrypted by a passphrase
	let exportOpen = $state(false);
	let withSecrets = $state(false);
	let withConversations = $state(false);
	let exportPass = $state('');
	let exportPass2 = $state('');
	const exportProblem = $derived(withSecrets ? passphraseProblem(exportPass, exportPass2) : null);

	function openExport(): void {
		withSecrets = false;
		withConversations = false;
		exportPass = '';
		exportPass2 = '';
		exportOpen = true;
	}

	async function exportNow(): Promise<void> {
		exporting = true;
		try {
			await downloadWorkspaceExport(withSecrets ? exportPass : undefined, withConversations);
			exportOpen = false;
		} catch (e) {
			if (!(e instanceof DOMException && e.name === 'AbortError')) toast.error(e instanceof Error ? e.message : 'Download failed');
		} finally {
			exporting = false;
			exportPass = '';
			exportPass2 = '';
		}
	}

	function startImport(source: ImportSource, label: string): void {
		importSource = source;
		importLabel = label;
		importUndoOf = undefined;
		importInitial = undefined;
		importOpen = true;
	}

	async function pickedFile(e: Event): Promise<void> {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		uploading = true;
		try {
			const up = await uploadWorkspaceZip(file);
			startImport({ uploadId: up.uploadId }, up.name);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'The zip was refused');
		} finally {
			uploading = false;
		}
	}

	async function startUndo(p: RestorePoint): Promise<void> {
		if (p.kind === 'database-restore') {
			startDbRestore(p.safetyBackupId, `the safety backup taken before ${formatDateTime(p.at)}`, p.id);
			return;
		}
		busy = `undo:${p.id}`;
		try {
			const u = await api.get('/backups/restore-points/{id}/undo', { params: { id: p.id } });
			importSource = u.source;
			importLabel = `the safety backup taken before ${formatDateTime(p.at)}`;
			importUndoOf = p.id;
			importInitial = u.selection;
			importOpen = true;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not prepare the undo');
		} finally {
			busy = '';
		}
	}

	// --- whole-database restore ------------------------------------------------------------------
	let dbOpen = $state(false);
	let dbBackupId = $state<string | null>(null);
	let dbLabel = $state('');
	let dbUndoOf = $state<string | undefined>(undefined);

	function startDbRestore(backupId: string, label: string, undoOf?: string): void {
		dbBackupId = backupId;
		dbLabel = label;
		dbUndoOf = undoOf;
		dbOpen = true;
	}

	// --- restore of files ------------------------------------------------------------------------
	let restoring = $state<Backup | null>(null);
	let restorePath = $state('/');
	let restoreMode = $state<'missing' | 'all'>('missing');
	let plan = $state<RestorePlan | null>(null);
	let restoreError = $state('');
	let working = $state(false);
	let outcome = $state('');
	let samples = $state<Array<{ path: string; size: number; updatedAt: number }>>([]);

	function openRestore(b: Backup): void {
		restoring = b;
		restorePath = '/';
		restoreMode = 'missing';
		plan = null;
		restoreError = '';
		outcome = '';
		samples = [];
		void api.get('/backups/{id}/entries', { params: { id: b.id }, query: { prefix: '/', limit: 200 } }).then((r) => (samples = r.files)).catch(() => undefined);
	}

	async function preview(): Promise<void> {
		if (!restoring) return;
		working = true;
		restoreError = '';
		outcome = '';
		try {
			plan = await api.post('/backups/{id}/restore-preview', { params: { id: restoring.id }, body: { path: restorePath.trim() || '/', mode: restoreMode } });
		} catch (e) {
			plan = null;
			restoreError = e instanceof Error ? e.message : 'Could not compare';
		} finally {
			working = false;
		}
	}

	async function restore(): Promise<void> {
		if (!restoring) return;
		working = true;
		restoreError = '';
		try {
			const r = await api.post('/backups/{id}/restore', { params: { id: restoring.id }, body: { path: restorePath.trim() || '/', mode: restoreMode } });
			outcome = `${resultSummary(r)}${r.safetyBackupId ? ' A safety backup was taken first.' : ''}`;
			plan = null;
			toast.success('Files restored');
			await load();
		} catch (e) {
			restoreError = e instanceof Error ? e.message : 'Restore failed';
		} finally {
			working = false;
		}
	}

	const actionText = { create: 'Create', replace: 'Replace', keep: 'Keep as is', same: 'Same' } as const;
	const changes = $derived(plan ? plan.counts.create + plan.counts.replace : 0);
</script>

<div class="flex flex-col gap-4">
	{#if dbStatus?.pending}
		<Alert.Root variant="warning" role="alert">
			<Alert.Title>A whole-database restore is staged</Alert.Title>
			<Alert.Description>
				<div class="flex flex-wrap items-center gap-3">
					<span>Backup {dbStatus.pending.backupId} replaces the database when the server restarts (staged {timeAgo(dbStatus.pending.stagedAt)}). Restart the server, or cancel it.</span>
					<Button size="sm" variant="outline" onclick={cancelStaged}>Cancel the restore</Button>
				</div>
			</Alert.Description>
		</Alert.Root>
	{/if}
	{#if dbLast && !dbLast.ok}
		<Alert.Root variant="destructive" role="alert"><Alert.Title>The last whole-database restore failed</Alert.Title><Alert.Description>{dbLast.text}</Alert.Description></Alert.Root>
	{/if}

	{#if loadError}
		<Alert.Root variant="destructive"><Alert.Title>Could not load the backups</Alert.Title><Alert.Description>{loadError}</Alert.Description></Alert.Root>
	{:else if overview}
		{#if overview.stale}
			<Alert.Root variant="destructive" role="alert">
				<Alert.Title>{overview.lastVerifiedAt === null ? 'There is no verified backup' : `The newest verified backup is ${timeAgo(overview.lastVerifiedAt)}`}</Alert.Title>
				<Alert.Description>The library and memory live only in this database. Back up now, and check the server log if the automatic backup keeps failing (it also raises an alarm).</Alert.Description>
			</Alert.Root>
		{:else}
			<Alert.Root variant="success"><Alert.Title>Last verified backup: {timeAgo(overview.lastVerifiedAt)}</Alert.Title><Alert.Description>{formatDateTime(overview.lastVerifiedAt ?? 0)}</Alert.Description></Alert.Root>
		{/if}
	{/if}

	<Card.Root>
		<Card.Header>
			<Card.Title>Schedule</Card.Title>
			<Card.Description>A consistent copy of the whole database is written while the server runs, then checked (integrity and row counts), with one readable zip of the workspace next to it (settings, agents, memory, library, programs, routines, people, connections, reminders, channels, history, artifacts, the developer API and browser profiles; no chats unless you tick it, no secrets: an export you download by hand can carry them, encrypted). One is also taken before risky operations such as reorganizing memory, and at start-up when none was taken today.</Card.Description>
		</Card.Header>
		<Card.Content>
			<form
				class="flex flex-col gap-4"
				onsubmit={(e) => {
					e.preventDefault();
					void saveSchedule();
				}}
			>
				<Field.Group>
					<Field.Field orientation="horizontal">
						<Switch id="backup-enabled" bind:checked={enabled} disabled={!settings} aria-label="Automatic backups" />
						<Field.Label for="backup-enabled">Automatic backups</Field.Label>
					</Field.Field>
					<Field.Field>
						<Field.Label for="backup-time">Daily at (team timezone{settings ? `: ${settings.timezone}` : ''})</Field.Label>
						<Input id="backup-time" type="time" bind:value={time} disabled={!settings} class="max-w-40" />
					</Field.Field>
					<Field.Field>
						<Field.Label for="backup-daily">Keep daily backups of the last (days)</Field.Label>
						<Input id="backup-daily" type="number" min={1} max={365} step={1} bind:value={keepDaily} disabled={!settings} class="max-w-40" />
						<Field.Description>The newest backup of each of these days is kept. Backups taken before a risky operation are kept at least 30 days.</Field.Description>
					</Field.Field>
					<Field.Field>
						<Field.Label for="backup-weekly">Keep weekly backups of the last (weeks)</Field.Label>
						<Input id="backup-weekly" type="number" min={0} max={520} step={1} bind:value={keepWeekly} disabled={!settings} class="max-w-40" />
					</Field.Field>
				</Field.Group>
				{#if saveError}<p class="text-sm text-destructive-text" role="alert">{saveError}</p>{/if}
				<div><Button type="submit" size="sm" disabled={!scheduleDirty || saving}>{saving ? 'Saving…' : 'Save schedule'}</Button></div>
			</form>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Backups</Card.Title>
			<Card.Description>
				Written to <span class="font-mono text-xs">{overview?.dir ?? '…'}</span> (<span class="font-mono text-xs">TEAM_BACKUP_DIR</span>): mount it on a persistent volume and copy it off the server. The whole database can be restored from a verified backup, with a safety backup first and a restart of the server.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-3">
			<div class="flex flex-wrap gap-2">
				<Button size="sm" onclick={backUpNow} disabled={running}>{running ? 'Backing up…' : 'Back up now'}</Button>
				<label class="flex items-center gap-2 text-xs text-muted-foreground">
					<Checkbox checked={backupConversations} onCheckedChange={(v) => (backupConversations = v === true)} aria-label="Include conversations in the workspace zip of the backup" />
					Include conversations in the zip
				</label>
				<Button size="sm" variant="outline" onclick={openExport} disabled={exporting}>{exporting ? 'Preparing…' : 'Download workspace export'}</Button>
				<Button size="sm" variant="outline" onclick={() => fileInput?.click()} disabled={uploading}>{uploading ? 'Checking the zip…' : 'Import from zip'}</Button>
				<input bind:this={fileInput} type="file" accept=".zip,application/zip" class="hidden" onchange={pickedFile} aria-label="Workspace zip to import" />
			</div>
			{#if overview && !overview.backups.length}
				<p class="text-sm text-muted-foreground">No backups yet.</p>
			{:else if overview}
				<div class="overflow-x-auto">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Time</Table.Head>
								<Table.Head>Reason</Table.Head>
								<Table.Head>Size</Table.Head>
								<Table.Head>Files</Table.Head>
								<Table.Head>Status</Table.Head>
								<Table.Head class="text-right">Actions</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each overview.backups as b (b.id)}
								<Table.Row>
									<Table.Cell class="whitespace-nowrap text-xs">{formatDateTime(b.createdAt)}</Table.Cell>
									<Table.Cell class="text-xs">{reasonLabel(b)}</Table.Cell>
									<Table.Cell class="whitespace-nowrap text-xs">{bytesText(b.dbBytes)}<span class="block text-muted-foreground">export {bytesText(b.filesBytes)}</span></Table.Cell>
									<Table.Cell class="text-xs">{b.fileCount}</Table.Cell>
									<Table.Cell>
										<Badge variant={b.verified && !b.exportError ? 'success' : b.verified ? 'warning' : 'destructive'} title={verifiedText(b)}>{b.verified ? (b.exportError ? 'No export' : 'Verified') : 'Not verified'}</Badge>
									</Table.Cell>
									<Table.Cell class="whitespace-nowrap text-right">
										<Button variant="ghost" size="sm" disabled={busy === `${b.id}:db`} onclick={() => download(b, 'db')}>Database</Button>
										<Button variant="ghost" size="sm" disabled={b.filesBytes === null || busy === `${b.id}:files`} onclick={() => download(b, 'files')}>Export</Button>
										<Button variant="ghost" size="sm" disabled={b.filesBytes === null} onclick={() => startImport({ backupId: b.id }, `the backup of ${formatDateTime(b.createdAt)}`)}>Import</Button>
										<Button variant="ghost" size="sm" disabled={!b.verified} onclick={() => openRestore(b)}>Restore files</Button>
										<Button variant="ghost" size="sm" disabled={!b.verified} onclick={() => startDbRestore(b.id, `the backup of ${formatDateTime(b.createdAt)}`)}>Restore whole database…</Button>
										<Button
											variant="ghost"
											size="sm"
											onclick={() => {
												toDelete = b;
												deleteOpen = true;
											}}>Delete</Button
										>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Restore points</Card.Title>
			<Card.Description>Every import or restore takes a verified safety backup first and is recorded here: what was applied, from where, by whom and when. Undo restores from that safety backup with the same preview, and is a restore point itself, so an undo can be undone.</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2">
			{#if !restorePoints.length}
				<p class="text-sm text-muted-foreground">No imports or restores yet.</p>
			{:else}
				<ul class="divide-y divide-border">
					{#each restorePoints as p (p.id)}
						<li class="flex flex-wrap items-center gap-3 py-2 text-sm">
							<div class="min-w-0 flex-1">
								<div>{restorePointText(p)}</div>
								<div class="text-xs text-muted-foreground">{formatDateTime(p.at)} by {p.by}; safety backup <span class="font-mono">{p.safetyBackupId}</span>{p.undoneBy ? '; undone' : ''}</div>
								{#if p.counts.failed}<div class="text-xs text-destructive-text">{p.counts.failed} failed: {p.items.filter((i) => i.action === 'failed').slice(0, 3).map((i) => `${i.key} (${i.note ?? 'failed'})`).join('; ')}</div>{/if}
							</div>
							<Button variant="outline" size="sm" disabled={!!p.undoneBy || busy === `undo:${p.id}`} onclick={() => startUndo(p)}>Undo</Button>
						</li>
					{/each}
				</ul>
			{/if}
		</Card.Content>
	</Card.Root>
</div>

<Dialog.Root open={exportOpen} onOpenChange={(o) => (exportOpen = o)}>
	<Dialog.Content elevation="floating" class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Download the workspace export</Dialog.Title>
			<Dialog.Description>One readable zip of the workspace. Secrets are left out unless you choose a passphrase: then provider keys and connection credentials travel in the zip, encrypted. Scheduled backups never hold secrets.</Dialog.Description>
		</Dialog.Header>
		<form
			class="flex flex-col gap-4"
			onsubmit={(e) => {
				e.preventDefault();
				if (!exportProblem) void exportNow();
			}}
		>
			<Field.Field orientation="horizontal">
				<Switch id="export-secrets" bind:checked={withSecrets} aria-label="Include secrets, encrypted" />
				<Field.Label for="export-secrets">Include secrets, encrypted with a passphrase</Field.Label>
			</Field.Field>
			<Field.Field orientation="horizontal">
				<Checkbox id="export-conversations" checked={withConversations} onCheckedChange={(v) => (withConversations = v === true)} aria-label="Include conversations" />
				<Field.Label for="export-conversations">Include conversations (chat history, large)</Field.Label>
			</Field.Field>
			{#if withSecrets}
				<Field.Field>
					<Field.Label for="export-pass">Passphrase (at least 12 characters)</Field.Label>
					<Input id="export-pass" type="password" autocomplete="new-password" bind:value={exportPass} />
				</Field.Field>
				<Field.Field>
					<Field.Label for="export-pass2">Type it again</Field.Label>
					<Input id="export-pass2" type="password" autocomplete="new-password" bind:value={exportPass2} />
					<Field.Description>Nothing can recover this passphrase. Without it the secrets in the zip cannot be read (AES-256-GCM, key from PBKDF2-SHA256); with it, anyone who has the zip can read them, so keep both apart.</Field.Description>
				</Field.Field>
				{#if exportPass && exportProblem}<p class="text-sm text-destructive-text" role="alert">{exportProblem}</p>{/if}
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (exportOpen = false)}>Cancel</Button>
				<Button type="submit" disabled={exporting || !!exportProblem}>{exporting ? 'Preparing…' : withSecrets ? 'Download with secrets' : 'Download without secrets'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<WorkspaceImportDialog bind:open={importOpen} source={importSource} label={importLabel} undoOf={importUndoOf} initial={importInitial} onDone={() => void load()} />

<DatabaseRestoreDialog bind:open={dbOpen} backupId={dbBackupId} label={dbLabel} undoOf={dbUndoOf} onDone={() => void load()} />

<ConfirmDialog
	bind:open={deleteOpen}
	title="Delete this backup?"
	description="The database copy and the files export of this snapshot are removed from the server. The newest verified backup cannot be deleted."
	onConfirm={remove}
/>

<Dialog.Root open={restoring !== null} onOpenChange={(o) => { if (!o) restoring = null; }}>
	<Dialog.Content elevation="floating" class="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>Restore files</Dialog.Title>
			<Dialog.Description>
				{#if restoring}From the backup of {formatDateTime(restoring.createdAt)} ({reasonLabel(restoring)}).{/if} Files come back as new versions, the previous version stays in the file history, and nothing is ever deleted. A full safety backup is taken first.
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
			<Field.Field>
				<Field.Label for="restore-path">What to restore</Field.Label>
				<Input id="restore-path" bind:value={restorePath} list="restore-paths" placeholder="/ (everything), a folder or one file" class="font-mono text-xs" />
				<datalist id="restore-paths">{#each samples as s (s.path)}<option value={s.path}></option>{/each}</datalist>
				<Field.Description>For example <span class="font-mono">/</span>, <span class="font-mono">/memories/agents</span> or <span class="font-mono">/library/reports/q1.md</span>.</Field.Description>
			</Field.Field>
			<Field.Field>
				<Field.Label for="restore-mode">Files that exist now</Field.Label>
				<NativeSelect id="restore-mode" bind:value={restoreMode} onchange={() => (plan = null)}>
					<NativeSelectOption value="missing">Skip them: restore only what is missing</NativeSelectOption>
					<NativeSelectOption value="all">Overwrite the ones whose content differs from the backup</NativeSelectOption>
				</NativeSelect>
			</Field.Field>
			<div class="flex gap-2">
				<Button variant="outline" size="sm" onclick={preview} disabled={working}>{working && !plan ? 'Comparing…' : 'Preview changes'}</Button>
			</div>
			{#if restoreError}<p class="text-sm text-destructive-text" role="alert">{restoreError}</p>{/if}
			{#if outcome}<Alert.Root variant="success"><Alert.Title>Done</Alert.Title><Alert.Description>{outcome}</Alert.Description></Alert.Root>{/if}
			{#if plan}
				<p class="text-sm" role="status">{planSummary(plan)}</p>
				{#if plan.entries.some((e) => e.action !== 'same')}
					<div class="max-h-64 overflow-auto rounded-lg border border-border">
						<Table.Root>
							<Table.Body>
								{#each plan.entries.filter((e) => e.action !== 'same') as e (e.path)}
									<Table.Row>
										<Table.Cell class="font-mono text-xs">{e.path}</Table.Cell>
										<Table.Cell class="whitespace-nowrap text-xs">{actionText[e.action]}{e.action === 'replace' && e.liveIsNewer ? ' (current file is newer)' : ''}</Table.Cell>
										<Table.Cell class="whitespace-nowrap text-xs text-muted-foreground">{bytesText(e.liveSize)} → {bytesText(e.snapshotSize)}</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</div>
					{#if plan.truncated}<p class="text-xs text-muted-foreground">The list shows the first {plan.entries.length} entries; the restore covers all of them.</p>{/if}
				{/if}
			{/if}
		</div>
		<Dialog.Footer class="border-t border-border px-5 py-3">
			<Button variant="ghost" onclick={() => (restoring = null)}>Close</Button>
			<Button onclick={restore} disabled={working || !plan || changes === 0}>{working && plan ? 'Restoring…' : `Restore ${changes} file${changes === 1 ? '' : 's'}`}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
