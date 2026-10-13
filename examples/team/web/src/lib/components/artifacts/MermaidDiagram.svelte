<script lang="ts">
	import { errorText, renderMermaid } from '#lib/artifacts/mermaid.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { theme } from '#lib/stores/theme.svelte.js';
	import { cn } from '#lib/utils.js';

	/**
	 * A mermaid diagram (lazy-loaded library, `securityLevel: 'strict'`, theme follows light/dark).
	 * A diagram that does not parse shows its error; `svg` and `error` are bindable for toolbars.
	 */
	let {
		code,
		svg = $bindable(''),
		error = $bindable(''),
		class: className
	}: { code: string; svg?: string; error?: string; class?: string } = $props();

	let pending = $state(true);

	$effect(() => {
		const source = code;
		const dark = theme.mode === 'dark';
		let stale = false;
		pending = true;
		renderMermaid(source, dark).then(
			(out) => {
				if (stale) return;
				svg = out;
				error = '';
				pending = false;
			},
			(e: unknown) => {
				if (stale) return;
				error = errorText(e);
				svg = '';
				pending = false;
			}
		);
		return () => {
			stale = true;
		};
	});
</script>

<div class={cn('min-w-0', className)} data-testid="mermaid-diagram">
	{#if error}
		<div class="flex flex-col gap-2" role="alert">
			<p class="text-xs text-destructive-text">Could not draw the diagram: {error}</p>
			<pre class="overflow-x-auto rounded-lg border border-border bg-muted p-3 font-mono text-xs">{code}</pre>
		</div>
	{:else if svg}
		<!-- mermaid sanitises its output at securityLevel 'strict' -->
		<div class="overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full" role="img" aria-label="Diagram">{@html svg}</div>
	{:else if pending}
		<Skeleton class="h-40 w-full" />
	{/if}
</div>
