<script lang="ts" module>
	/**
	 * Standard body widths of a global page (the header is always `PageHeader`):
	 * - `narrow`: card lists and forms (Decisions, Settings) — max-w-3xl.
	 * - `wide` (default): tables and grids (Programs, Routines, Connectors) — max-w-5xl.
	 * - `full`: deliberately edge to edge for a board, canvas or very wide table (Tasks, Logs).
	 */
	export type PageBodySize = 'narrow' | 'wide' | 'full';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.js';

	/**
	 * The standard scrolling body under a `PageHeader`: one scroll container, centred column with a
	 * standard max width and padding. `class` goes on the inner column (e.g. `gap-*`), `scrollClass`
	 * on the scroll container (e.g. to turn scrolling off for a board that scrolls itself).
	 */
	let {
		size = 'wide',
		class: className,
		scrollClass,
		children
	}: { size?: PageBodySize; class?: string; scrollClass?: string; children: Snippet } = $props();

	const max = { narrow: 'max-w-3xl', wide: 'max-w-5xl', full: '' } as const;
</script>

<div class={cn('min-h-0 min-w-0 flex-1 overflow-y-auto', scrollClass)}>
	<div class={cn('mx-auto flex w-full flex-col gap-4 p-4 md:p-6', max[size], size === 'full' && 'p-3 md:p-4', className)}>
		{@render children()}
	</div>
</div>
