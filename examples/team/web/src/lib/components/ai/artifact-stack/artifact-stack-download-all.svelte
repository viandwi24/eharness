<script lang="ts">
	import DownloadIcon from 'phosphor-svelte/lib/Download';
	import { Button, type ButtonProps } from "#lib/components/ui/button/index.js";

	let { class: className, children, ...restProps }: Omit<ButtonProps, "href"> = $props();
</script>

<Button
	data-slot="ai-artifact-stack-download-all"
	variant="secondary"
	size="sm"
	type="button"
	class={className}
	{...restProps}
>
	<DownloadIcon class="size-3.5" />
	{#if children}
		{@render children()}
	{:else}
		Download all
	{/if}
</Button>
