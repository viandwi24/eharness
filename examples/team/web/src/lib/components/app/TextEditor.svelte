<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { diffStats, lineDiff, saveWithConflict } from '#lib/conflict.js';

	type Latest = { content: string; version: string | null };

	let {
		initial,
		version,
		save,
		loadLatest,
		onSaved,
		onReload,
		onCancel,
		rows = 18
	}: {
		initial: string;
		/** Version the draft started from (`ifVersion`). null creates the file. */
		version: string | null;
		/** Write the draft. `ifVersion` undefined overwrites without a guard. */
		save: (content: string, ifVersion: string | null | undefined) => Promise<{ version: string }>;
		/** Current content on the server (null when the file is gone). */
		loadLatest: () => Promise<Latest | null>;
		onSaved: (content: string, version: string) => void;
		/** The user chose the server's copy after a conflict. */
		onReload: (latest: Latest) => void;
		onCancel: () => void;
		rows?: number;
	} = $props();

	// svelte-ignore state_referenced_locally
	let draft = $state(initial);
	// svelte-ignore state_referenced_locally
	let base = $state<string | null>(version);
	let saving = $state(false);
	let error = $state('');
	let theirs = $state<Latest | null | undefined>(undefined); // undefined: no conflict
	let showDiff = $state(false);

	const diff = $derived(theirs ? lineDiff(draft, theirs.content) : []);
	const stats = $derived(diffStats(diff));

	async function run(ifVersion: string | null | undefined): Promise<void> {
		saving = true;
		error = '';
		try {
			const out = await saveWithConflict(() => save(draft, ifVersion));
			if (out.ok) {
				theirs = undefined;
				onSaved(draft, out.version);
				return;
			}
			// An agent (or another tab) wrote the file after we opened it.
			theirs = await loadLatest().catch(() => null);
			base = theirs?.version ?? out.conflict.currentVersion;
			showDiff = false;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3">
	{#if theirs !== undefined}
		<div class="flex flex-col gap-2 rounded-lg border border-border bg-warning-soft p-3 text-sm text-warning-text" role="alert">
			<p class="font-medium">
				{theirs === null ? 'This file was deleted while you were editing.' : 'This file changed while you were editing.'}
			</p>
			{#if theirs}
				<p class="text-xs">
					Their version differs by +{stats.added} / -{stats.removed} lines. Reload to take it (your draft is lost), or overwrite
					to keep yours.
				</p>
			{/if}
			<div class="flex flex-wrap gap-2">
				{#if theirs}
					<Button size="sm" variant="outline" onclick={() => onReload(theirs as Latest)}>Reload theirs</Button>
					<Button size="sm" variant="outline" onclick={() => (showDiff = !showDiff)}>{showDiff ? 'Hide diff' : 'Show diff'}</Button>
				{/if}
				<Button size="sm" disabled={saving} onclick={() => void run(theirs ? theirs.version : null)}>Overwrite with mine</Button>
				<Button size="sm" variant="ghost" onclick={() => (theirs = undefined)}>Keep editing</Button>
			</div>
			{#if showDiff && theirs}
				<pre class="max-h-64 overflow-auto rounded-md border border-border bg-card p-2 font-mono text-xs text-foreground">{#each diff as l, i (i)}<span
							class="block whitespace-pre-wrap {l.kind === 'add' ? 'bg-success-soft text-success-text' : l.kind === 'del' ? 'bg-destructive-soft text-destructive-text' : ''}"
							>{l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}{l.text}</span
						>{/each}</pre>
				<p class="text-xs">Green: only in their version. Red: only in yours.</p>
			{/if}
		</div>
	{/if}
	<Textarea bind:value={draft} {rows} class="min-h-48 flex-1 font-mono text-xs" spellcheck={false} aria-label="File content" />
	{#if error}<p class="text-xs text-destructive-text" role="alert">{error}</p>{/if}
	<div class="flex gap-2">
		<Button disabled={saving || theirs !== undefined} onclick={() => void run(base)}>{saving ? 'Saving…' : 'Save'}</Button>
		<Button variant="ghost" onclick={onCancel}>Cancel</Button>
	</div>
</div>
