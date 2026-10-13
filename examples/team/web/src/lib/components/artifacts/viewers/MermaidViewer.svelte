<script lang="ts">
	import { loadText, type ViewerInput } from '#lib/artifacts/input.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import DiagramPane from '../DiagramPane.svelte';

	let { input }: { input: ViewerInput } = $props();

	let code = $state<string>();
	let error = $state('');

	$effect(() => {
		const i = input;
		code = undefined;
		error = '';
		const ctl = new AbortController();
		loadText(i, ctl.signal).then(
			(t) => !ctl.signal.aborted && (code = t),
			(e: unknown) => !ctl.signal.aborted && (error = e instanceof Error ? e.message : 'Could not load the diagram')
		);
		return () => ctl.abort();
	});
</script>

<div class="h-full min-h-0 overflow-hidden">
	{#if error}
		<p class="p-4 text-sm text-destructive-text" role="alert">{error}</p>
	{:else if code === undefined}
		<Skeleton class="m-4 h-40" />
	{:else}
		<DiagramPane kind="mermaid" {code} bordered={false} fill label="mermaid" />
	{/if}
</div>
