<script lang="ts">
	import XIcon from 'phosphor-svelte/lib/X';
	import type { ComponentProps } from "svelte";
	import ArtifactViewerAction from "./artifact-viewer-action.svelte";

	let {
		label = "Close",
		...restProps
	}: Omit<ComponentProps<typeof ArtifactViewerAction>, "label" | "children"> & {
		label?: string;
	} = $props();
</script>

<ArtifactViewerAction {label} {...restProps}>
	<XIcon class="size-4" />
</ArtifactViewerAction>
