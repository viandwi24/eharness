<script lang="ts">
	import { api } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { filesResultText, readyCount } from '#lib/programs/files.js';
	import { live } from '#lib/stores/live.svelte.js';

	type Item = components['schemas']['ProgramFilesPreview']['items'][number];

	let {
		open = $bindable(false),
		programIds,
		onDone
	}: {
		open: boolean;
		/** One or a few programs; absent = every program that is not in file mode yet. */
		programIds?: string[];
		onDone?: () => void;
	} = $props();

	let items = $state<Item[] | null>(null);
	let loading = $state(false);
	let applying = $state(false);
	let error = $state('');
	let outcome = $state('');

	$effect(() => {
		if (open) void load();
	});

	async function load(): Promise<void> {
		loading = true;
		error = '';
		outcome = '';
		items = null;
		try {
			items = (await api.post('/program-files/preview', { body: programIds ? { programIds } : {} })).items;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not prepare the move';
		} finally {
			loading = false;
		}
	}

	async function apply(): Promise<void> {
		applying = true;
		error = '';
		try {
			const r = await api.post('/program-files/apply', { body: programIds ? { programIds } : {} });
			outcome = filesResultText(r);
			live.state.revs.programs++;
			live.state.revs.files++;
			toast.success('Moved to the library');
			onDone?.();
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not move the programs';
		} finally {
			applying = false;
		}
	}

	const ready = $derived(items ? readyCount(items) : 0);
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="flex max-h-[92svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>Move brief and notes to the library</Dialog.Title>
			<Dialog.Description>
				Each program gets /library/programs/&lt;name&gt;/brief.md and notes.md. Every run then reads the current file, and the library keeps every version. The text now in the program stays as a fallback copy. Authority, forbidden actions and gates stay in the program, never in a file.
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
			{#if loading}<p class="text-sm text-muted-foreground" role="status">Checking the programs…</p>{/if}
			{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
			{#if outcome}<Alert.Root variant="success"><Alert.Title>Done</Alert.Title><Alert.Description>{outcome}</Alert.Description></Alert.Root>{/if}
			{#if items}
				{#if !items.length}<p class="text-sm text-muted-foreground">There are no programs.</p>{/if}
				<ul class="divide-y divide-border rounded-lg border border-border" aria-label="Programs to move">
					{#each items as i (i.programId)}
						<li class="flex flex-col gap-0.5 px-3 py-2 text-xs">
							<div class="flex items-center gap-2">
								<span class="min-w-0 flex-1 truncate text-sm font-medium">{i.name}</span>
								<Badge variant={i.status === 'ready' ? 'secondary' : i.status === 'already' ? 'outline' : 'destructive'}>
									{i.status === 'ready' ? 'Will move' : i.status === 'already' ? 'Already in the library' : 'Blocked'}
								</Badge>
							</div>
							<span class="font-mono text-muted-foreground">{i.briefPath} ({i.briefChars} characters)</span>
							<span class="font-mono text-muted-foreground">{i.notesPath} ({i.notes} agreement{i.notes === 1 ? '' : 's'})</span>
							{#if i.note}<span class="text-warning-text">{i.note}</span>{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
		<Dialog.Footer class="border-t border-border px-5 py-3">
			<Button variant="ghost" onclick={() => (open = false)}>Close</Button>
			<Button onclick={apply} disabled={applying || loading || ready === 0}>{applying ? 'Moving…' : `Move ${ready} program${ready === 1 ? '' : 's'}`}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
