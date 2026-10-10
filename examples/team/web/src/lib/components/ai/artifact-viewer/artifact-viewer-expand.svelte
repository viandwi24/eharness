<script lang="ts">
	import ArrowsOutSimpleIcon from 'phosphor-svelte/lib/ArrowsOutSimple';
	import type { ComponentProps } from "svelte";
	import ArtifactViewerAction from "./artifact-viewer-action.svelte";

	let {
		label = "Expand",
		...restProps
	}: Omit<ComponentProps<typeof ArtifactViewerAction>, "label" | "children"> & {
		label?: string;
	} = $props();
</script>

<ArtifactViewerAction {label} {...restProps}>
	<ArrowsOutSimpleIcon class="size-4" />
</ArtifactViewerAction>
