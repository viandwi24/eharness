<script lang="ts">
	import FileCodeIcon from 'phosphor-svelte/lib/FileCode';
	import FileIcon from 'phosphor-svelte/lib/File';
	import FileImageIcon from 'phosphor-svelte/lib/FileImage';
	import FileMdIcon from 'phosphor-svelte/lib/FileMd';
	import FilePdfIcon from 'phosphor-svelte/lib/FilePdf';
	import FileTextIcon from 'phosphor-svelte/lib/FileText';
	import type { FileKind } from '#lib/files/helpers.js';

	let { kind, class: className = 'size-4' }: { kind: FileKind; class?: string } = $props();
	const Icon = $derived(
		{ markdown: FileMdIcon, code: FileCodeIcon, text: FileTextIcon, image: FileImageIcon, pdf: FilePdfIcon, other: FileIcon }[kind]
	);
</script>

<Icon class={className} />
