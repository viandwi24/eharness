<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '#lib/utils.js';
	import { type Elevation, setSurface, useElevation } from '#lib/components/ui/elevation/index.js';

	// App surface: a card-like block that honours the elevation system (same level recipe as edmi Card).
	// Layered mode: raised (bevel) at the top, flat (border only) when nested inside another raised/floating
	// surface. `elevation="sunken"` makes an inset well (parameter boxes, JSON/code previews).
	// The level classes come last, so they win over a caller's `border-*`/`bg-*` only when they set one.
	type Props = Omit<HTMLAttributes<HTMLElement>, 'children'> & {
		/** Element to render: div (default), button, a, li, section... Extra attributes (href, type) pass through. */
		as?: string;
		elevation?: Elevation;
		ref?: HTMLElement | null;
		children?: Snippet;
		[key: string]: unknown;
	};

	let { as = 'div', elevation = 'auto', ref = $bindable(null), class: className, children, ...rest }: Props = $props();

	const levelClass = {
		sunken: 'border-sk-bd bg-sk-bg shadow-sunken',
		flat: '',
		raised: 'border-transparent shadow-raised',
		floating: 'border-transparent shadow-floating'
	};

	const level = useElevation(() => elevation, 'surface');
	setSurface(() => level.current);
</script>

<svelte:element
	this={as}
	bind:this={ref}
	data-slot="surface"
	data-elevation={level.current}
	class={cn('rounded-xl border border-border bg-card text-card-foreground', className, levelClass[level.current])}
	{...rest}
>
	{@render children?.()}
</svelte:element>
