<script lang="ts">
	import DownloadIcon from 'phosphor-svelte/lib/Download';
	import type { ComponentProps } from "svelte";
	import ArtifactViewerAction from "./artifact-viewer-action.svelte";

	let {
		label = "Download",
		...restProps
	}: Omit<ComponentProps<typeof ArtifactViewerAction>, "label" | "children"> & {
		label?: string;
	} = $props();
</script>

<ArtifactViewerAction {label} {...restProps}>
	<DownloadIcon class="size-4" />
</ArtifactViewerAction>
