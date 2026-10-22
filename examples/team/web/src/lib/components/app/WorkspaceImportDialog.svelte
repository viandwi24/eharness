<script lang="ts">
	import { api } from '#lib/api/index.js';
	import {
		type ImportItem,
		type ImportPreview,
		type ImportSource,
		type SectionId,
		type Ticks,
		applySummary,
		bytesText,
		defaultTicks,
		grants,
		importResultText,
		isSelected,
		itemsOf,
		selectionBody,
		skippedCount,
		statusText,
		withOverwrite
	} from '#lib/backups/model.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';

	let {
		open = $bindable(false),
		source,
		label,
		undoOf,
		initial,
		onDone
	}: {
		open: boolean;
		source: ImportSource | null;
		/** Where it comes from, in words ("mine.zip", "the backup of 12 Oct"). */
		label: string;
		/** The restore point this import undoes. */
		undoOf?: string;
		/** A suggested selection (the undo of a restore point). */
		initial?: { sections: SectionId[]; exclude: string[]; removeSections: SectionId[]; overwrite?: boolean; overwriteConflicts?: boolean; rewriteReferences?: boolean };
		onDone: () => void;
	} = $props();

	let preview = $state<ImportPreview | null>(null);
	let ticks = $state<Ticks>({ sections: new Set(), exclude: new Set(), remove: new Set(), overwrite: false, overwriteConflicts: false, rewrite: false });
	let passphrase = $state('');
	let unlocking = $state(false);
	let secretsError = $state('');
	let loading = $state(false);
	let applying = $state(false);
	let error = $state('');
	let outcome = $state('');
	let expanded = $state<Set<string>>(new Set());

	$effect(() => {
		if (open && source) {
			passphrase = '';
			secretsError = '';
			void load(source);
		}
	});

	async function load(s: ImportSource): Promise<void> {
		loading = true;
		error = '';
		outcome = '';
		preview = null;
		expanded = new Set();
		try {
			const p = await api.post('/backups/import-preview', { body: { source: s } });
			preview = p;
			const t = defaultTicks(p);
			if (initial) {
				t.sections = new Set(initial.sections);
				t.exclude = new Set(initial.exclude);
				t.remove = new Set(initial.removeSections);
				t.overwrite = initial.overwrite === true;
				t.overwriteConflicts = initial.overwriteConflicts === true;
				t.rewrite = initial.rewriteReferences === true;
			}
			ticks = t;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not compare the zip';
		} finally {
			loading = false;
		}
	}

	/** Open the secrets of the zip with the passphrase: a wrong one leaves the preview as it is. */
	async function unlock(): Promise<void> {
		if (!source || !passphrase) return;
		unlocking = true;
		secretsError = '';
		try {
			const p = await api.post('/backups/import-preview', { body: { source, passphrase } });
			preview = p;
			ticks.sections = new Set([...ticks.sections, 'secrets']);
		} catch (e) {
			secretsError = e instanceof Error ? e.message : 'Could not open the secrets';
		} finally {
			unlocking = false;
		}
	}

	function flip<T>(set: Set<T>, value: T, on: boolean): Set<T> {
		const next = new Set(set);
		if (on) next.add(value);
		else next.delete(value);
		return next;
	}

	function toggleExpanded(key: string): void {
		expanded = flip(expanded, key, !expanded.has(key));
	}

	const items = $derived(preview?.items ?? []);
	// what each button would do: the skip choice adds new items only, the overwrite choice replaces the differing ones too
	const skipPicked = $derived(items.filter((i) => isSelected(i, withOverwrite(ticks, false))).length);
	const overwritePicked = $derived(items.filter((i) => isSelected(i, withOverwrite(ticks, true))).length);
	const skipped = $derived(skippedCount(items, ticks));
	const granted = $derived(grants(items, withOverwrite(ticks, true)));
	const conflictCount = $derived(preview?.sections.reduce((n, s) => n + s.conflicts, 0) ?? 0);
	const refs = $derived(preview?.references);
	const movesOf = $derived(preview?.moves);
	const secretsOn = $derived(ticks.sections.has('secrets') && preview?.secrets.unlocked === true);
	/** The checkbox of an item: ticked unless left out (whether it is replaced is the button's choice). */
	const ticked = (i: ImportItem): boolean => isSelected(i, withOverwrite(ticks, true));

	async function apply(overwrite: boolean): Promise<void> {
		if (!source) return;
		applying = true;
		error = '';
		try {
			const r = await api.post('/backups/import', {
				body: { source, selection: selectionBody(withOverwrite(ticks, overwrite)), ...(secretsOn ? { passphrase } : {}), ...(undoOf ? { undoOf } : {}) }
			});
			outcome = r.restorePointId ? `${importResultText(r)} A safety backup was taken first; undo it from the restore points.` : 'Nothing was selected to change.';
			if (r.counts.failed) toast.warning(`${r.counts.failed} item${r.counts.failed === 1 ? '' : 's'} failed: see the restore point`);
			else toast.success('Import applied');
			preview = null;
			passphrase = '';
			onDone();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Import failed';
		} finally {
			applying = false;
		}
	}

	function sectionChecked(id: SectionId): boolean {
		return ticks.sections.has(id);
	}

	const badge = (i: ImportItem): 'success' | 'warning' | 'secondary' | 'outline' => (i.kind === 'move' ? 'success' : i.status === 'added' ? 'success' : i.status === 'changed' ? 'warning' : 'secondary');
	/** The badge text of an item: a move, a rewrite and an item changed here since the export say so. */
	const badgeText = (i: ImportItem): string => {
		if (i.kind === 'move') return i.move?.kind === 'prefix' ? 'Folder moved' : 'Moved';
		if (i.kind === 'reference') return 'Rewrite';
		if (i.status === 'only-live') return ticks.remove.has(i.section) && (!i.conflict || ticks.overwriteConflicts) ? 'Will be removed' : 'Kept';
		return statusText[i.status];
	};
</script>

<Dialog.Root open={open} onOpenChange={(o) => (open = o)}>
	<Dialog.Content elevation="floating" class="flex max-h-[92svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>{undoOf ? 'Undo a restore point' : 'Import into this workspace'}</Dialog.Title>
			<Dialog.Description>
				From {label}. Nothing is written until you apply. Items that exist here and differ are kept as they are unless you choose to overwrite them, items changed here after the zip was exported keep the live version unless you tick them, files that were moved or renamed offline are applied as moves, and an import never deletes unless you tick "remove what is not in the zip" for a section. Conversations are never ticked by default (they are large); secrets come back only from an encrypted export, with its passphrase. A verified safety backup is taken first and recorded as a restore point.
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
			{#if loading}<p class="text-sm text-muted-foreground" role="status">Reading and comparing the zip…</p>{/if}
			{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
			{#if outcome}<Alert.Root variant="success"><Alert.Title>Done</Alert.Title><Alert.Description>{outcome}</Alert.Description></Alert.Root>{/if}
			{#if preview}
				<p class="text-xs text-muted-foreground">
					Zip made {new Date(preview.manifest.createdAt).toLocaleString()} by version {preview.manifest.appVersion}, format {preview.manifest.formatVersion}; its hashes were verified.
				</p>
				{#each preview.warnings as w (w)}<p class="text-xs text-muted-foreground">{w}</p>{/each}
				{#if preview.secrets.included}
					<section class="rounded-lg border border-border px-3 py-3">
						<p class="text-sm font-medium">Secrets included: {preview.secrets.count} (encrypted)</p>
						{#if preview.secrets.unlocked}
							<p class="mt-1 text-xs text-muted-foreground">The passphrase opened them. They are listed below by name only; values are never shown. Untick the Secrets section to leave them out.</p>
						{:else}
							<p class="mt-1 text-xs text-muted-foreground">Provider keys and connection credentials travel in this zip, encrypted. Enter the passphrase chosen when it was exported to list and restore them.</p>
							<form
								class="mt-2 flex flex-wrap items-center gap-2"
								onsubmit={(e) => {
									e.preventDefault();
									void unlock();
								}}
							>
								<Input type="password" autocomplete="off" bind:value={passphrase} placeholder="Passphrase of the export" aria-label="Passphrase of the export" class="max-w-72" />
								<Button type="submit" size="sm" variant="outline" disabled={!passphrase || unlocking}>{unlocking ? 'Opening…' : 'Enter passphrase'}</Button>
							</form>
						{/if}
						{#if secretsError}<p class="mt-2 text-sm text-destructive-text" role="alert">{secretsError}</p>{/if}
					</section>
				{/if}
				{#if movesOf && movesOf.files > 0}
					<Alert.Root>
						<Alert.Title>{movesOf.files} file{movesOf.files === 1 ? '' : 's'} moved{movesOf.folders ? `, ${movesOf.folders} folder${movesOf.folders === 1 ? '' : 's'}` : ''}</Alert.Title>
						<Alert.Description>
							{movesOf.explicit} stated in migrations/moves.json, {movesOf.detected} found by content (same bytes, new name). They are applied as moves: the history follows the file, and an agent that still uses an old path is sent to the new one.
						</Alert.Description>
					</Alert.Root>
				{/if}
				{#if conflictCount > 0 && !undoOf}
					<section class="rounded-lg border border-border px-3 py-3">
						<label class="flex items-start gap-2 text-sm">
							<Checkbox checked={ticks.overwriteConflicts} onCheckedChange={(v) => (ticks.overwriteConflicts = v === true)} aria-label="Replace or remove what was changed here after the export" />
							<span>
								<span class="font-medium">{conflictCount} item{conflictCount === 1 ? ' was' : 's were'} changed here after this zip was exported.</span>
								<span class="block text-xs text-muted-foreground">They keep the version that is live now. Tick to replace or remove them too (marked "Changed here since the export" below).</span>
							</span>
						</label>
					</section>
				{/if}
				{#if refs && (refs.dangling.length > 0 || refs.atRisk.length > 0)}
					<section class="rounded-lg border border-border px-3 py-3" aria-label="Reference check">
						<p class="text-sm font-medium">Reference check ({refs.checked} checked)</p>
						{#if refs.dangling.length}
							<p class="mt-1 text-xs text-warning-text">{refs.dangling.length} reference{refs.dangling.length === 1 ? '' : 's'} would point to nothing after this import:</p>
							<ul class="mt-1 max-h-48 list-disc overflow-auto pl-4 text-xs">
								{#each refs.dangling as r (`${r.owner}|${r.where}|${r.ref}`)}
									<li><span class="font-medium">{r.owner}</span> ({r.where}): <span class="font-mono">{r.ref}</span>{#if r.suggestion} → <span class="font-mono text-success-text">{r.suggestion}</span>{/if}</li>
								{/each}
							</ul>
							{#if refs.truncated}<p class="mt-1 text-xs text-muted-foreground">The list is cut; the rewrite covers all of them.</p>{/if}
						{/if}
						{#if refs.atRisk.length}
							<p class="mt-2 text-xs text-muted-foreground">{refs.atRisk.length} reference{refs.atRisk.length === 1 ? '' : 's'} work only because of files that "remove what is not in the zip" would delete:</p>
							<ul class="mt-1 max-h-32 list-disc overflow-auto pl-4 text-xs">
								{#each refs.atRisk as r (`${r.owner}|${r.where}|${r.ref}`)}
									<li><span class="font-medium">{r.owner}</span> ({r.where}): <span class="font-mono">{r.ref}</span></li>
								{/each}
							</ul>
						{/if}
						{#if !undoOf && refs.rewritable > 0}
							<label class="mt-2 flex items-start gap-2 text-sm">
								<Checkbox checked={ticks.rewrite} onCheckedChange={(v) => (ticks.rewrite = v === true)} aria-label="Rewrite references using the moves" />
								<span>
									<span class="font-medium">Rewrite references using the moves ({refs.rewritable})</span>
									<span class="block text-xs text-muted-foreground">Programs, standing orders, memory notes and API folder grants are pointed at the new paths; what a program may read and write stays the same. Each rewrite is listed below as a "Rewrite" item.</span>
								</span>
							</label>
						{/if}
					</section>
				{/if}
				{#if !undoOf && skipped}
					<p class="text-xs text-muted-foreground">{skipped} item{skipped === 1 ? '' : 's'} here differ{skipped === 1 ? 's' : ''} from the zip. "Apply (skip existing)" adds only what is new; "Apply and overwrite existing" replaces the differing ones too.</p>
				{/if}
				{#if granted.length}
					<Alert.Root variant="warning" role="alert">
						<Alert.Title>This import grants authority</Alert.Title>
						<Alert.Description>
							<ul class="mt-1 list-disc pl-4">
								{#each granted as g (g.key)}
									<li><span class="font-medium">{g.label}</span>: {g.authority.join('; ')}</li>
								{/each}
							</ul>
						</Alert.Description>
					</Alert.Root>
				{/if}
				{#each preview.sections as s (s.id)}
					{@const rows = itemsOf(preview, s.id)}
					{#if s.added + s.changed + s.onlyLive + s.unchanged + s.moved > 0 || rows.length > 0}
						<section class="rounded-lg border border-border">
							<div class="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
								<Checkbox checked={sectionChecked(s.id)} disabled={!s.applicable} onCheckedChange={(v) => (ticks.sections = flip(ticks.sections, s.id, v === true))} aria-label={`Apply ${s.label}`} />
								<span class="text-sm font-medium">{s.label}</span>
								<span class="text-xs text-muted-foreground">{s.added} new, {s.changed} differ, {s.unchanged} same{s.moved ? `, ${s.moved} moved` : ''}{s.onlyLive ? `, ${s.onlyLive} only in the workspace` : ''}{s.conflicts ? `, ${s.conflicts} changed here since the export` : ''}</span>
								{#if s.applicable && s.onlyLive}
									<label class="ml-auto flex items-center gap-2 text-xs">
										<Checkbox checked={ticks.remove.has(s.id)} disabled={!sectionChecked(s.id)} onCheckedChange={(v) => (ticks.remove = flip(ticks.remove, s.id, v === true))} aria-label={`Remove what is not in the zip: ${s.label}`} />
										Remove what is not in the zip ({s.onlyLive})
									</label>
								{/if}
							</div>
							{#if rows.length}
								<ul class="max-h-72 divide-y divide-border overflow-auto">
									{#each rows as i (i.key)}
										<li class="px-3 py-1.5 text-xs">
											<div class="flex items-center gap-2">
												<Checkbox
													checked={ticked(i)}
													disabled={!i.applicable || (i.kind === 'reference' ? !ticks.rewrite : !sectionChecked(i.section) || (i.status === 'only-live' && !ticks.remove.has(i.section)) || (i.conflict && !ticks.overwriteConflicts))}
													onCheckedChange={(v) => (ticks.exclude = flip(ticks.exclude, i.key, v !== true))}
													aria-label={`Apply ${i.label}`}
												/>
												<Badge variant={badge(i)}>{badgeText(i)}</Badge>
												{#if i.conflict}<Badge variant="warning">Changed here since the export</Badge>{/if}
												<span class="min-w-0 flex-1 truncate font-mono">{i.label}</span>
												{#if i.sizeAfter !== null}<span class="text-muted-foreground">{bytesText(i.sizeBefore)} → {bytesText(i.sizeAfter)}</span>{/if}
												{#if i.fields.length || i.diff || i.authority.length || i.notes.length || i.blocked}
													<Button variant="ghost" size="sm" onclick={() => toggleExpanded(i.key)}>{expanded.has(i.key) ? 'Hide' : 'Details'}</Button>
												{/if}
											</div>
											{#if i.blocked}<p class="mt-1 text-destructive-text">Cannot be applied: {i.blocked}</p>{/if}
											{#if expanded.has(i.key) || i.authority.length}
												{#if i.authority.length}
													<p class="mt-1 text-warning-text">Grants: {i.authority.join('; ')}</p>
												{/if}
											{/if}
											{#if expanded.has(i.key)}
												{#each i.notes as n (n)}<p class="mt-1 text-muted-foreground">{n}</p>{/each}
												{#if i.fields.length}
													<table class="mt-1 w-full text-left">
														<tbody>
															{#each i.fields as f (f.field)}
																<tr class="align-top">
																	<td class="pr-2 font-mono text-muted-foreground">{f.field}</td>
																	<td class="pr-2 break-words text-destructive-text">{f.before}</td>
																	<td class="break-words text-success-text">{f.after}</td>
																</tr>
															{/each}
														</tbody>
													</table>
												{/if}
												{#if i.diff}<pre class="mt-1 max-h-60 overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap">{i.diff}</pre>{/if}
											{/if}
										</li>
									{/each}
								</ul>
							{:else}
								<p class="px-3 py-2 text-xs text-muted-foreground">Nothing differs.</p>
							{/if}
						</section>
					{/if}
				{/each}
				{#if preview.truncated}<p class="text-xs text-muted-foreground">The list shows the first {preview.items.length} items; the import covers all of them.</p>{/if}
				<p class="text-sm" role="status">{applySummary(items, withOverwrite(ticks, undoOf ? true : false))}</p>
			{/if}
		</div>
		<Dialog.Footer class="border-t border-border px-5 py-3">
			<Button variant="ghost" onclick={() => (open = false)}>Close</Button>
			{#if undoOf}
				<Button onclick={() => apply(true)} disabled={applying || loading || !preview || overwritePicked === 0}>{applying ? 'Undoing…' : `Undo: put back ${overwritePicked} change${overwritePicked === 1 ? '' : 's'}`}</Button>
			{:else}
				<Button variant="outline" onclick={() => apply(false)} disabled={applying || loading || !preview || skipPicked === 0}>{applying ? 'Applying…' : `Apply (skip existing) · ${skipPicked}`}</Button>
				<Button onclick={() => apply(true)} disabled={applying || loading || !preview || overwritePicked === 0}>{applying ? 'Applying…' : `Apply and overwrite existing · ${overwritePicked}`}</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
