<script lang="ts">
	import ImageIcon from 'phosphor-svelte/lib/Image';
	import { DropdownMenuItem } from "#lib/components/ui/dropdown-menu/index.js";
	import type { ComponentProps } from "svelte";
	import { usePromptInputAttachments } from "./use-prompt-input.svelte.js";

	let {
		label = "Add photos or files",
		...restProps
	}: Omit<ComponentProps<typeof DropdownMenuItem>, "children"> & { label?: string } = $props();

	const attachments = usePromptInputAttachments();
</script>

<DropdownMenuItem {...restProps} onSelect={() => attachments.openFileDialog()}>
	<ImageIcon class="size-4" />
	{label}
</DropdownMenuItem>
