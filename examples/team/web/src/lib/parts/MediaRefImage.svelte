<script lang="ts">
	import { fetchLibraryBlob } from '#lib/api/index.js';

	/**
	 * An image a tool stored in the file system and returned as a media reference (a browser
	 * screenshot): fetched from the library and shown inline; a click opens it full size.
	 */
	let { path, alt = 'Screenshot' }: { path: string; alt?: string } = $props();
	let url = $state<string | undefined>();
	let failed = $state(false);

	$effect(() => {
		const p = path;
		let gone = false;
		let made: string | undefined;
		failed = false;
		url = undefined;
		fetchLibraryBlob(p, { inline: true }).then(
			(blob) => {
				if (gone) return;
				made = URL.createObjectURL(blob);
				url = made;
			},
			() => {
				if (!gone) failed = true;
			}
		);
		return () => {
			gone = true;
			if (made) URL.revokeObjectURL(made);
		};
	});
</script>

{#if url}
	<a href={url} target="_blank" rel="noopener" class="block w-fit max-w-full overflow-hidden rounded-lg border border-border">
		<img src={url} {alt} class="block max-h-96 max-w-full object-contain" loading="lazy" />
	</a>
{:else if failed}
	<p class="text-xs text-muted-foreground" data-testid="screenshot-expired">This screenshot expired and is no longer available.</p>
{:else}
	<div class="h-40 w-64 max-w-full animate-pulse rounded-lg bg-muted" aria-label="Loading the screenshot"></div>
{/if}
