<script lang="ts">
	// Edmi ✦ port: the error state is the destructive ui alert.
	import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircle';
	import { Alert, AlertDescription, AlertTitle } from "#lib/components/ui/alert/index.js";
	import type { Snippet } from "svelte";
	import { useJSXPreview } from "./use-jsx-preview.svelte.js";

	let { class: className, children }: { class?: string; children?: Snippet<[Error]> } = $props();

	const preview = useJSXPreview();
</script>

{#if preview.error}
	<Alert data-slot="ai-jsx-preview-error" variant="destructive" class={className}>
		{#if children}
			{@render children(preview.error)}
		{:else}
			<WarningCircleIcon  />
			<AlertTitle>Could not render</AlertTitle>
			<AlertDescription>{preview.error.message}</AlertDescription>
		{/if}
	</Alert>
{/if}
