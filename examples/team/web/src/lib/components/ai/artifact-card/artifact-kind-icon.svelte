<script lang="ts">
	import ArchiveIcon from 'phosphor-svelte/lib/Archive';
	import FileCodeIcon from 'phosphor-svelte/lib/FileCode';
	import ImageIcon from 'phosphor-svelte/lib/Image';
	import AppWindowIcon from 'phosphor-svelte/lib/AppWindow';
	import FileIcon from 'phosphor-svelte/lib/File';
	import FileTextIcon from 'phosphor-svelte/lib/FileText';
	import GlobeIcon from 'phosphor-svelte/lib/Globe';
	import TableIcon from 'phosphor-svelte/lib/Table';
	import TreeStructureIcon from 'phosphor-svelte/lib/TreeStructure';
	import type { ArtifactKind } from "./use-artifact-card.svelte.js";

	let {
		kind = "document",
		class: className = "size-5",
	}: {
		kind?: ArtifactKind;
		class?: string;
	} = $props();
</script>

{#if kind === "archive"}
	<ArchiveIcon class={className} />
{:else if kind === "code"}
	<FileCodeIcon class={className} />
{:else if kind === "image"}
	<ImageIcon class={className} />
{:else if kind === "slides"}
	<AppWindowIcon class={className} />
{:else if kind === "html"}
	<GlobeIcon class={className} />
{:else if kind === "mermaid"}
	<TreeStructureIcon class={className} />
{:else if kind === "data"}
	<TableIcon class={className} />
{:else if kind === "file"}
	<FileIcon class={className} />
{:else}
	<FileTextIcon class={className} />
{/if}
