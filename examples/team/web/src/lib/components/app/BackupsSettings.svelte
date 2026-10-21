<script lang="ts">
	import { onMount } from 'svelte';
	import { api, fieldErrors } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import { type Backup, type RestorePlan, bytesText, planSummary, reasonLabel, resultSummary, verifiedText } from '#lib/backups/model.js';
	import { downloadBackupFile } from '#lib/backups/download.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { formatDateTime, timeAgo } from '#lib/time.js';

	type Settings = components['schemas']['Settings'];
	type Overview = components['schemas']['BackupList'];

	let overview = $state<Overview | null>(null);
	let loadError = $state('');
	let running = $state(false);
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

	async function load(): Promise<void> {
		try {
			overview = await api.get('/backups');
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
			const r = await api.post('/backups');
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
			<Card.Description>A consistent copy of the whole database is written while the server runs, then checked (integrity and row counts), with a zip of every library and memory file next to it. One is also taken before risky operations such as reorganizing memory, and at start-up when none was taken today.</Card.Description>
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
				Written to <span class="font-mono text-xs">{overview?.dir ?? '…'}</span> (<span class="font-mono text-xs">TEAM_BACKUP_DIR</span>): mount it on a persistent volume and copy it off the server. Restoring the whole database is a manual step, see the README.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-3">
			<div><Button size="sm" onclick={backUpNow} disabled={running}>{running ? 'Backing up…' : 'Back up now'}</Button></div>
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
										<Button variant="ghost" size="sm" disabled={b.filesBytes === null || busy === `${b.id}:files`} onclick={() => download(b, 'files')}>Files</Button>
										<Button variant="ghost" size="sm" disabled={!b.verified} onclick={() => openRestore(b)}>Restore files</Button>
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
</div>

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
					<NativeSelectOption value="missing">Leave them as they are, restore only what is missing</NativeSelectOption>
					<NativeSelectOption value="all">Replace the ones whose content differs from the backup</NativeSelectOption>
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
