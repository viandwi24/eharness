<script lang="ts">
	import CloudIcon from 'phosphor-svelte/lib/Cloud';
	import LightningIcon from 'phosphor-svelte/lib/Lightning';
	import StackIcon from 'phosphor-svelte/lib/Stack';
	import type { Component } from 'svelte';
	import { cn } from '#lib/utils.js';

	/** The mark of a provider definition: a Phosphor glyph in a softly tinted tile (no third-party logos). */
	let { definitionId, size = 'md', class: className }: { definitionId: string; size?: 'sm' | 'md' | 'lg'; class?: string } = $props();

	const MARKS: Record<string, { icon: Component; tint: string }> = {
		openrouter: { icon: StackIcon, tint: 'bg-indigo-500/12 text-indigo-700 dark:bg-indigo-400/15 dark:text-indigo-300' },
		gateway: { icon: LightningIcon, tint: 'bg-foreground text-background' }
	};
	const FALLBACK = { icon: CloudIcon, tint: 'bg-sky-500/12 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300' };
	const SIZE = { sm: 'size-8 rounded-lg', md: 'size-10 rounded-xl', lg: 'size-14 rounded-2xl' } as const;
	const GLYPH = { sm: 'size-4', md: 'size-5', lg: 'size-7' } as const;
	const mark = $derived(MARKS[definitionId] ?? FALLBACK);
	const Icon = $derived(mark.icon);
</script>

<span aria-hidden="true" class={cn('flex shrink-0 items-center justify-center', SIZE[size], mark.tint, className)}><Icon class={GLYPH[size]} /></span>
