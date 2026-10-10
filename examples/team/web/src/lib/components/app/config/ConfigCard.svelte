<script lang="ts">
	import type { Snippet } from 'svelte';
	import Surface from '#lib/components/app/Surface.svelte';

	/**
	 * The card of one provider profile or one connection: icon, title with badges, a one-line
	 * subtitle, actions on the right and free content below (notices, test results, permissions).
	 */
	let {
		icon,
		title,
		badges,
		subtitle,
		actions,
		children,
		class: className = ''
	}: {
		icon?: Snippet;
		title: Snippet;
		badges?: Snippet;
		subtitle?: Snippet;
		actions?: Snippet;
		children?: Snippet;
		class?: string;
	} = $props();
</script>

<Surface class="flex flex-col gap-2 rounded-xl p-3.5 {className}">
	<div class="flex items-center gap-3">
		{#if icon}<span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">{@render icon()}</span>{/if}
		<div class="min-w-0 flex-1">
			<div class="flex flex-wrap items-center gap-1.5">
				<span class="truncate text-sm font-medium">{@render title()}</span>
				{@render badges?.()}
			</div>
			{#if subtitle}<div class="truncate text-xs text-muted-foreground">{@render subtitle()}</div>{/if}
		</div>
		{#if actions}<div class="flex shrink-0 flex-wrap items-center gap-1">{@render actions()}</div>{/if}
	</div>
	{@render children?.()}
</Surface>
