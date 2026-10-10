<script lang="ts">
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeft';
	import type { Snippet } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';

	let { title, children }: { title: string; children?: Snippet } = $props();
</script>

<header class="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3">
	<Button href="/" variant="ghost" size="icon-sm" class="md:hidden" aria-label="Back to agents">
		<CaretLeftIcon class="size-4" />
	</Button>
	<h1 class="flex-1 text-base font-medium">{title}</h1>
	{@render children?.()}
</header>
