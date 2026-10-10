<script lang="ts">
	import FileTextIcon from 'phosphor-svelte/lib/FileText';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import { files } from '#lib/mock.js';
</script>

<div class="flex min-w-0 flex-1 flex-col">
	<PageHeader title="Library" />
	<div class="flex flex-col gap-1 p-4">
		{#each files as f (f.path)}
			<div class="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-accent">
				<FileTextIcon class="size-4 text-muted-foreground" />
				<span class="flex-1 truncate font-mono text-sm">{f.path}</span>
				<span class="text-xs text-muted-foreground">{f.by}</span>
			</div>
		{/each}
		<p class="mt-4 text-sm text-muted-foreground">File viewer (text, markdown, image, PDF) lands in a later milestone.</p>
	</div>
</div>
