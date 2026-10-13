<script lang="ts">
	import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimple';
	import FileIcon from 'phosphor-svelte/lib/File';
	import type { ViewerInput } from '#lib/artifacts/input.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { formatBytes } from '#lib/files/helpers.js';

	/** A file with no viewer of its own: what it is, and a download. */
	let { input }: { input: ViewerInput } = $props();

	let href = $state<string>();
	$effect(() => {
		const i = input;
		href = undefined;
		let stale = false;
		void i.url?.().then((u) => !stale && (href = u)).catch(() => {});
		return () => {
			stale = true;
		};
	});
</script>

<div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
	<span class="grid size-14 place-items-center rounded-xl border border-border bg-muted text-muted-foreground"><FileIcon class="size-6" /></span>
	<div class="min-w-0">
		<p class="truncate text-sm font-medium">{input.name}</p>
		<p class="text-xs text-muted-foreground">{[input.mediaType, formatBytes(input.size)].filter(Boolean).join(' · ') || 'No preview for this file type'}</p>
	</div>
	<Button size="sm" variant="outline" {href} download={input.name} disabled={!href}><DownloadSimpleIcon />Download</Button>
</div>
