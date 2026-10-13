<script lang="ts">
	import { svgDocument } from '#lib/artifacts/frame.js';
	import type { ViewerInput } from '#lib/artifacts/input.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import SandboxFrame from '../SandboxFrame.svelte';

	let { input }: { input: ViewerInput } = $props();

	let src = $state<string>();
	let error = $state('');
	const isSvg = $derived(/\.svg$/i.test(input.name) || input.mediaType === 'image/svg+xml');

	$effect(() => {
		const i = input;
		src = undefined;
		error = '';
		if (i.text !== undefined || !i.url) return;
		let stale = false;
		i.url().then(
			(u) => !stale && (src = u),
			(e: unknown) => !stale && (error = e instanceof Error ? e.message : 'Could not load the image')
		);
		return () => {
			stale = true;
		};
	});
</script>

<div class="flex h-full min-h-0 items-center justify-center overflow-auto bg-muted/40 p-4">
	{#if error}
		<p class="text-sm text-destructive-text" role="alert">{error}</p>
	{:else if isSvg}
		<!-- an SVG can carry script: it is never put in the page, only in the locked frame -->
		{#if input.text !== undefined}
			<SandboxFrame srcdoc={svgDocument(input.text)} title={input.title} locked class="h-full min-h-[50vh] rounded-md" />
		{:else if src}
			<SandboxFrame {src} title={input.title} locked class="h-full min-h-[50vh] rounded-md" />
		{:else}
			<Skeleton class="h-40 w-full" />
		{/if}
	{:else if src}
		<img {src} alt={input.title} class="max-h-full max-w-full rounded-lg border border-border bg-white object-contain" />
	{:else}
		<Skeleton class="h-40 w-full" />
	{/if}
</div>
