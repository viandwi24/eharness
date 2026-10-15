<script lang="ts">
	import { cn } from "#lib/utils.js";
	import MediaRefImage from "#lib/parts/MediaRefImage.svelte";
	import { toolContent } from "#lib/parts/media.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		class: className,
		output,
		errorText,
		...restProps
	}: HTMLAttributes<HTMLDivElement> & { output?: unknown; errorText?: string } = $props();

	// a tool that stored an image (a browser screenshot) returns a media reference: show the picture
	type MediaRef = { type: "media-ref"; path: string; mediaType: string; text?: string };
	const media = $derived(
		output !== null &&
			typeof output === "object" &&
			(output as { type?: unknown }).type === "media-ref" &&
			typeof (output as { path?: unknown }).path === "string" &&
			String((output as { mediaType?: unknown }).mediaType ?? "").startsWith("image/")
			? (output as MediaRef)
			: undefined
	);
	// an MCP result whose images were stored as files: its text and its pictures in order
	const content = $derived(media ? undefined : toolContent(output));
	const text = $derived(
		media ? (media.text ?? "") : typeof output === "string" ? output : JSON.stringify(output, null, 2)
	);
	const pre =
		"m-0 overflow-x-auto rounded-lg bg-muted px-3 py-2.5 font-mono text-xs leading-[1.6] whitespace-pre text-foreground";
</script>

{#if output || errorText}
	<div data-slot="ai-tool-output" class={className} {...restProps}>
		<div class="mb-1.5 font-mono text-[11px] font-medium tracking-[0.8px] text-muted-foreground uppercase">
			{errorText ? "Error" : "Result"}
		</div>
		{#if errorText}
			<pre class={cn(pre, "bg-destructive-soft text-destructive-text")}>{errorText}</pre>
		{:else if content}
			<div class="flex flex-col gap-2">
				{#each content as part, i (i)}
					{#if part.kind === "image"}
						<MediaRefImage path={part.image.path} />
					{:else}
						<pre class={pre}>{part.text}</pre>
					{/if}
				{/each}
			</div>
		{:else if media}
			<div class="flex flex-col gap-2">
				<MediaRefImage path={media.path} />
				{#if text}<pre class={pre}>{text}</pre>{/if}
			</div>
		{:else}
			<pre class={pre}>{text}</pre>
		{/if}
	</div>
{/if}
