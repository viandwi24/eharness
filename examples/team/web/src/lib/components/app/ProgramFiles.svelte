<script lang="ts">
	import { api } from '#lib/api/index.js';
	import LibraryViewer from '#lib/components/app/LibraryViewer.svelte';
	import ProgramFilesDialog from '#lib/components/app/ProgramFilesDialog.svelte';
	import Surface from '#lib/components/app/Surface.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { inFileMode, libraryLink } from '#lib/programs/files.js';
	import type { Program } from '#lib/programs/form.js';
	import { live } from '#lib/stores/live.svelte.js';

	let { program }: { program: Program } = $props();

	let moveOpen = $state(false);
	let which = $state<'brief' | 'notes'>('brief');
	let busy = $state(false);

	const fileMode = $derived(inFileMode(program));
	const path = $derived(which === 'brief' ? program.briefPath : program.notesPath);

	async function backToText(): Promise<void> {
		busy = true;
		try {
			await api.patch('/programs/{id}', { params: { id: program.id }, body: { briefPath: null, notesPath: null, version: program.version } });
			live.state.revs.programs++;
			toast.success('The program uses its saved text again');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not switch back');
		} finally {
			busy = false;
		}
	}
</script>

<Surface class="flex flex-col gap-3 p-4 text-sm" data-testid="program-files">
	<div class="flex flex-wrap items-center gap-2">
		<p class="font-medium">Brief and agreements in the library</p>
		<span class="flex-1"></span>
		{#if fileMode}
			<Button size="sm" variant="ghost" disabled={busy} onclick={backToText}>Switch back to text</Button>
		{:else}
			<Button size="sm" variant="outline" onclick={() => (moveOpen = true)}>Move brief and notes to the library</Button>
		{/if}
	</div>
	{#if fileMode}
		<p class="text-xs text-muted-foreground">
			Every run reads the current files below; each save is a library version. If a file is missing, the run uses the saved copy and you are told. A file never grants access: authority, forbidden actions and gates stay on the program.
		</p>
		<div class="flex flex-wrap items-center gap-2">
			<Button size="xs" variant={which === 'brief' ? 'secondary' : 'ghost'} onclick={() => (which = 'brief')}>Brief</Button>
			<Button size="xs" variant={which === 'notes' ? 'secondary' : 'ghost'} onclick={() => (which = 'notes')}>Agreements</Button>
			{#if path}<a class="ml-auto font-mono text-xs underline underline-offset-4" href={libraryLink(path)}>{path}</a>{/if}
		</div>
		{#if path}
			{#key path}
				<LibraryViewer {path} onMoved={() => (live.state.revs.programs++)} onDeleted={() => (live.state.revs.programs++)} />
			{/key}
		{/if}
	{:else}
		<p class="text-xs text-muted-foreground">
			The brief and the agreements are text inside the program. Moving them to /library/programs/&lt;name&gt;/ lets you edit them as files with a version history; every run reads the current file.
		</p>
	{/if}
</Surface>

<ProgramFilesDialog bind:open={moveOpen} programIds={[program.id]} />
