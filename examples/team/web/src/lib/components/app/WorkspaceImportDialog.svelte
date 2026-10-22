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
		statusText
	} from '#lib/backups/model.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
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
		initial?: { sections: SectionId[]; exclude: string[]; removeSections: SectionId[] };
		onDone: () => void;
	} = $props();

	let preview = $state<ImportPreview | null>(null);
	let ticks = $state<Ticks>({ sections: new Set(), exclude: new Set(), remove: new Set() });
	let loading = $state(false);
	let applying = $state(false);
	let error = $state('');
	let outcome = $state('');
	let expanded = $state<Set<string>>(new Set());

	$effect(() => {
		if (open && source) void load(source);
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
			}
			ticks = t;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not compare the zip';
		} finally {
			loading = false;
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
	const picked = $derived(items.filter((i) => isSelected(i, ticks)).length);
	const granted = $derived(grants(items, ticks));

	async function apply(): Promise<void> {
		if (!source) return;
		applying = true;
		error = '';
		try {
			const r = await api.post('/backups/import', { body: { source, selection: selectionBody(ticks), ...(undoOf ? { undoOf } : {}) } });
			outcome = r.restorePointId ? `${importResultText(r)} A safety backup was taken first; undo it from the restore points.` : 'Nothing was selected to change.';
			if (r.counts.failed) toast.warning(`${r.counts.failed} item${r.counts.failed === 1 ? '' : 's'} failed: see the restore point`);
			else toast.success('Import applied');
			preview = null;
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

	const badge = (i: ImportItem): 'success' | 'warning' | 'secondary' | 'outline' => (i.status === 'added' ? 'success' : i.status === 'changed' ? 'warning' : 'secondary');
</script>

<Dialog.Root open={open} onOpenChange={(o) => (open = o)}>
	<Dialog.Content elevation="floating" class="flex max-h-[92svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>{undoOf ? 'Undo a restore point' : 'Import into this workspace'}</Dialog.Title>
			<Dialog.Description>
				From {label}. Nothing is written until you apply. An import never deletes unless you tick "remove what is not in the zip" for a section. Secrets are never imported; connections and reminders are shown for reading only. A verified safety backup is taken first and recorded as a restore point.
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
					{#if s.added + s.changed + s.onlyLive + s.unchanged > 0}
						<section class="rounded-lg border border-border">
							<div class="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
								<Checkbox checked={sectionChecked(s.id)} disabled={!s.applicable} onCheckedChange={(v) => (ticks.sections = flip(ticks.sections, s.id, v === true))} aria-label={`Apply ${s.label}`} />
								<span class="text-sm font-medium">{s.label}</span>
								<span class="text-xs text-muted-foreground">{s.added} new, {s.changed} differ, {s.unchanged} same{s.onlyLive ? `, ${s.onlyLive} only in the workspace` : ''}</span>
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
													checked={isSelected(i, ticks)}
													disabled={!i.applicable || !sectionChecked(i.section) || (i.status === 'only-live' && !ticks.remove.has(i.section))}
													onCheckedChange={(v) => (ticks.exclude = flip(ticks.exclude, i.key, v !== true))}
													aria-label={`Apply ${i.label}`}
												/>
												<Badge variant={badge(i)}>{i.status === 'only-live' ? (ticks.remove.has(i.section) ? 'Will be removed' : 'Kept') : statusText[i.status]}</Badge>
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
				<p class="text-sm" role="status">{applySummary(items, ticks)}</p>
			{/if}
		</div>
		<Dialog.Footer class="border-t border-border px-5 py-3">
			<Button variant="ghost" onclick={() => (open = false)}>Close</Button>
			<Button onclick={apply} disabled={applying || loading || !preview || picked === 0}>{applying ? 'Applying…' : `Apply ${picked} change${picked === 1 ? '' : 's'}`}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
