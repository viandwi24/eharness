<script lang="ts">
	import ArrowUpRightIcon from 'phosphor-svelte/lib/ArrowUpRight';
	import type { ComponentProps } from "svelte";
	import ArtifactViewerAction from "./artifact-viewer-action.svelte";

	let {
		label = "Open in",
		...restProps
	}: Omit<ComponentProps<typeof ArtifactViewerAction>, "label" | "children"> & {
		label?: string;
	} = $props();
</script>

<ArtifactViewerAction {label} {...restProps}>
	<ArrowUpRightIcon class="size-4" />
</ArtifactViewerAction>
