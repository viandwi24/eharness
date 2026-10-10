<script lang="ts">
	import PauseIcon from 'phosphor-svelte/lib/Pause';
	import PlayIcon from 'phosphor-svelte/lib/Play';
	import { Button, type ButtonProps } from "#lib/components/ui/button/index.js";
	import { Spinner } from "#lib/components/ui/spinner/index.js";
	import { cn } from "#lib/utils.js";

	let {
		class: className,
		playing = false,
		loading = false,
		onPlay,
		onclick,
		...restProps
	}: Omit<ButtonProps, "children" | "href" | "onclick"> & {
		onclick?: (event: MouseEvent) => void;
		playing?: boolean;
		loading?: boolean;
		onPlay?: () => void;
	} = $props();
</script>

<Button
	data-slot="ai-voice-selector-preview"
	type="button"
	variant="ghost"
	size="icon-xs"
	aria-label={playing ? "Pause preview" : "Play preview"}
	disabled={loading}
	class={cn("mt-px", className)}
	onclick={(event) => {
		event.stopPropagation();
		onclick?.(event);
		onPlay?.();
	}}
	{...restProps}
>
	{#if loading}
		<Spinner class="size-3" />
	{:else if playing}
		<PauseIcon class="size-3 fill-current" />
	{:else}
		<PlayIcon class="size-3 fill-current" />
	{/if}
</Button>
