<script lang="ts">
	import { loadText, type ViewerInput } from '#lib/artifacts/input.js';
	import { CodeBlock } from '#lib/components/ai/code-block/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { codeLanguage } from '#lib/files/helpers.js';

	let { input }: { input: ViewerInput } = $props();

	let code = $state<string>();
	let error = $state('');
	const language = $derived(codeLanguage(input.name) ?? 'text');

	$effect(() => {
		const i = input;
		code = undefined;
		error = '';
		const ctl = new AbortController();
		loadText(i, ctl.signal).then(
			(t) => !ctl.signal.aborted && (code = t),
			(e: unknown) => !ctl.signal.aborted && (error = e instanceof Error ? e.message : 'Could not load the file')
		);
		return () => ctl.abort();
	});
</script>

<div class="h-full overflow-auto p-4">
	{#if error}
		<p class="text-sm text-destructive-text" role="alert">{error}</p>
	{:else if code === undefined}
		<Skeleton class="h-40 w-full" />
	{:else}
		<CodeBlock {code} language={language as never} showLineNumbers />
	{/if}
</div>
