<script lang="ts">
	import { artifactsApi, cachedViewUrl } from '#lib/artifacts/api.js';
	import { openPanel } from '#lib/artifacts/open.js';
	import { basename } from '#lib/files/helpers.js';

	/** A thumbnail of an image a code run saved, through the library's signed view URL. Click opens it in the panel. */
	let { path }: { path: string } = $props();

	let src = $state<string>();
	let failed = $state(false);

	$effect(() => {
		const p = path;
		src = undefined;
		failed = false;
		let stale = false;
		void cachedViewUrl(() => artifactsApi.libraryViewUrl(p))().then(
			(u) => !stale && (src = u),
			() => !stale && (failed = true)
		);
		return () => {
			stale = true;
		};
	});
</script>

<button
	type="button"
	class="group block overflow-hidden rounded-lg border border-border bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
	title={path}
	aria-label="Open {basename(path)}"
	onclick={() => openPanel({ kind: 'file', path })}
>
	<!-- an SVG in an <img> runs no script, so a thumbnail may show it; the panel opens it in the locked frame -->
	{#if src}
		<img {src} alt={basename(path)} loading="lazy" class="block h-28 max-w-56 object-contain transition-opacity group-hover:opacity-90" />
	{:else}
		<span class="grid h-28 w-40 place-items-center px-2 text-center text-xs text-muted-foreground">{failed ? 'Could not load' : basename(path)}</span>
	{/if}
</button>
