<script lang="ts">
	import { withBridge } from '#lib/artifacts/frame.js';
	import type { ViewerInput } from '#lib/artifacts/input.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import SandboxFrame from '../SandboxFrame.svelte';

	let { input, onFix }: { input: ViewerInput; onFix?: (error: string) => void } = $props();

	let src = $state<string>();
	let loadError = $state('');
	let error = $state('');
	const srcdoc = $derived(input.text !== undefined ? withBridge(input.text) : undefined);

	$effect(() => {
		const i = input;
		src = undefined;
		loadError = '';
		error = '';
		if (i.text !== undefined || !i.url) return;
		let stale = false;
		i.url().then(
			(u) => !stale && (src = u),
			(e: unknown) => !stale && (loadError = e instanceof Error ? e.message : 'Could not load the page')
		);
		return () => {
			stale = true;
		};
	});
</script>

<div class="flex h-full min-h-0 flex-col">
	{#if loadError}
		<p class="p-4 text-sm text-destructive-text" role="alert">{loadError}</p>
	{:else if src || srcdoc !== undefined}
		{#key src ?? srcdoc}
			<SandboxFrame {src} {srcdoc} title={input.title} onerror={(m) => (error = m)} class="min-h-0 flex-1" />
		{/key}
	{:else}
		<Skeleton class="m-4 h-40" />
	{/if}
	{#if error}
		<div class="flex shrink-0 items-start gap-2 border-t border-border bg-destructive-soft px-3 py-2 text-xs text-destructive-text" role="alert" data-testid="frame-error">
			<span class="min-w-0 flex-1 font-mono break-words">{error}</span>
			{#if onFix}<Button size="xs" variant="outline" onclick={() => onFix(error)}>Ask the agent to fix</Button>{/if}
			<Button size="xs" variant="ghost" onclick={() => (error = '')}>Dismiss</Button>
		</div>
	{/if}
</div>
