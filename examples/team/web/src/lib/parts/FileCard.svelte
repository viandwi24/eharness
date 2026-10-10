<script lang="ts">
	import FileTextIcon from 'phosphor-svelte/lib/FileText';
	import FileCodeIcon from 'phosphor-svelte/lib/FileCode';
	import FileImageIcon from 'phosphor-svelte/lib/FileImage';
	import FilePdfIcon from 'phosphor-svelte/lib/FilePdf';
	import FileIcon from 'phosphor-svelte/lib/File';
	import { basename, fileKind, parentOf } from '#lib/files/helpers.js';
	import type { WrittenFile } from './activity.js';

	/** A file the agent wrote, as a card that opens it in Files (like Claude's artifact card). */
	let { file }: { file: WrittenFile } = $props();

	const kind = $derived(fileKind({ path: file.path, mediaType: null, binary: false }));
	const label: Record<string, string> = { markdown: 'Markdown', code: 'Code', text: 'Text', image: 'Image', pdf: 'PDF', other: 'File' };
	const Icon = $derived(
		kind === 'markdown' || kind === 'text' ? FileTextIcon : kind === 'code' ? FileCodeIcon : kind === 'image' ? FileImageIcon : kind === 'pdf' ? FilePdfIcon : FileIcon
	);
	const href = $derived(`/files?path=${encodeURIComponent(file.path)}`);
</script>

<a
	{href}
	class="group flex w-full max-w-lg items-center gap-3 rounded-xl border border-border bg-card p-2.5 pr-3 text-[13.5px] transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
	data-testid="file-card"
>
	<span class="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
		<Icon class="size-5" />
	</span>
	<span class="min-w-0 flex-1">
		<span class="block truncate font-medium" title={file.path}>{basename(file.path)}</span>
		<span class="block truncate text-xs text-muted-foreground">
			{label[kind]} · {file.action === 'created' ? 'Created' : 'Edited'} in {parentOf(file.path)}
		</span>
	</span>
	<span class="shrink-0 rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-foreground transition-colors group-hover:bg-accent">Open</span>
</a>
