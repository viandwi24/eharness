<script lang="ts">
	import MonitorIcon from 'phosphor-svelte/lib/Monitor';
	import { DropdownMenuItem } from "#lib/components/ui/dropdown-menu/index.js";
	import type { ComponentProps } from "svelte";
	import { captureScreenshot } from "./screenshot.js";
	import { usePromptInputAttachments } from "./use-prompt-input.svelte.js";

	let {
		label = "Take screenshot",
		...restProps
	}: Omit<ComponentProps<typeof DropdownMenuItem>, "children"> & { label?: string } = $props();

	const attachments = usePromptInputAttachments();

	async function handleSelect() {
		try {
			const screenshot = await captureScreenshot();
			if (screenshot) attachments.add([screenshot]);
		} catch (error) {
			// The user dismissed the capture picker: not an error.
			if (
				error instanceof DOMException &&
				(error.name === "NotAllowedError" || error.name === "AbortError")
			) {
				return;
			}
			throw error;
		}
	}
</script>

<DropdownMenuItem {...restProps} onSelect={handleSelect}>
	<MonitorIcon class="size-4" />
	{label}
</DropdownMenuItem>
