<script lang="ts">
	import EyeIcon from 'phosphor-svelte/lib/Eye';
	import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlash';
	import { Switch } from "#lib/components/ui/switch/index.js";
	import { cn } from "#lib/utils.js";
	import { useEnvironmentVariablesContext } from "./use-environment-variables.svelte.js";

	let { class: className }: { class?: string } = $props();

	const list = useEnvironmentVariablesContext();
</script>

<div class={cn("flex items-center gap-2 text-[12.5px]", className)}>
	<span class="text-muted-foreground">
		{#if list.showValues}
			<EyeIcon class="size-3.5" />
		{:else}
			<EyeSlashIcon class="size-3.5" />
		{/if}
	</span>
	<span>Show values</span>
	<Switch
		aria-label="Toggle value visibility"
		size="sm"
		checked={list.showValues}
		onCheckedChange={(v) => list.setShowValues(v)}
	/>
</div>
