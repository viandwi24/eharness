<script lang="ts">
	import MusicNoteIcon from 'phosphor-svelte/lib/MusicNote';
	import FileTextIcon from 'phosphor-svelte/lib/FileText';
	import ImageIcon from 'phosphor-svelte/lib/Image';
	import GlobeIcon from 'phosphor-svelte/lib/Globe';
	import VideoIcon from 'phosphor-svelte/lib/Video';
	import PaperclipIcon from 'phosphor-svelte/lib/Paperclip';
	import { cn } from "#lib/utils.js";
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";
	import { useAttachmentContext } from "./use-attachments.svelte.js";

	let {
		fallbackIcon,
		class: className,
		...restProps
	}: HTMLAttributes<HTMLDivElement> & {
		fallbackIcon?: Snippet;
	} = $props();

	const attachment = useAttachmentContext();
	const data = $derived(attachment.data);
	const category = $derived(attachment.mediaCategory);
	const variant = $derived(attachment.variant);
	const fileUrl = $derived(data.type === "file" ? data.url : undefined);
	const filename = $derived(data.type === "file" ? data.filename : undefined);
</script>

<div
	data-slot="ai-attachment-preview"
	class={cn(
		"flex shrink-0 items-center justify-center overflow-hidden text-muted-foreground [&_svg:not([class*='size-'])]:size-4",
		variant === "grid" &&
			"h-20 w-full rounded-xl border border-border bg-muted [&_svg:not([class*='size-'])]:size-5",
		variant === "inline" && "size-4 [&_svg:not([class*='size-'])]:size-3.5",
		variant === "list" && "size-9 rounded-lg border border-border bg-muted text-foreground",
		className
	)}
	{...restProps}
>
	{#if category === "image" && fileUrl}
		<img
			alt={filename || "Image"}
			class={cn("size-full object-cover", variant !== "grid" && "rounded-[5px]")}
			src={fileUrl}
		/>
	{:else if category === "video" && fileUrl}
		<!-- svelte-ignore a11y_media_has_caption -->
		<video class="size-full object-cover" muted src={fileUrl}></video>
	{:else if fallbackIcon}
		{@render fallbackIcon()}
	{:else if category === "audio"}
		<MusicNoteIcon  />
	{:else if category === "document"}
		<FileTextIcon  />
	{:else if category === "image"}
		<ImageIcon  />
	{:else if category === "source"}
		<GlobeIcon  />
	{:else if category === "video"}
		<VideoIcon  />
	{:else}
		<PaperclipIcon  />
	{/if}
</div>
