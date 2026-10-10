<script lang="ts">
	import CloudIcon from 'phosphor-svelte/lib/Cloud';
	import { cn } from '#lib/utils.js';

	/**
	 * The mark of a provider definition in a softly tinted tile. OpenRouter, Vercel (AI Gateway) and
	 * Anthropic show their plain monochrome mark, for identification only (paths from simple-icons,
	 * CC0); other providers get a generic cloud glyph. Marks follow `currentColor`.
	 */
	let { definitionId, size = 'md', class: className }: { definitionId: string; size?: 'sm' | 'md' | 'lg'; class?: string } = $props();

	const MARKS: Record<string, { path: string; tint: string; label: string }> = {
		openrouter: {
			label: 'OpenRouter',
			tint: 'bg-slate-500/12 text-slate-800 dark:bg-slate-300/15 dark:text-slate-200',
			path: 'M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z'
		},
		gateway: { label: 'Vercel AI Gateway', tint: 'bg-foreground text-background', path: 'm12 1.608 12 20.784H0Z' },
		anthropic: {
			label: 'Anthropic',
			tint: 'bg-orange-500/12 text-orange-800 dark:bg-orange-400/15 dark:text-orange-300',
			path: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z'
		}
	};
	const FALLBACK_TINT = 'bg-sky-500/12 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300';
	const SIZE = { sm: 'size-8 rounded-lg', md: 'size-10 rounded-xl', lg: 'size-14 rounded-2xl' } as const;
	const GLYPH = { sm: 'size-4', md: 'size-5', lg: 'size-7' } as const;
	const mark = $derived(MARKS[definitionId]);
</script>

<span aria-hidden="true" data-provider-mark={mark ? definitionId : 'generic'} class={cn('flex shrink-0 items-center justify-center', SIZE[size], mark?.tint ?? FALLBACK_TINT, className)}>
	{#if mark}
		<svg viewBox="0 0 24 24" fill="currentColor" class={GLYPH[size]} focusable="false"><path d={mark.path} /></svg>
	{:else}
		<CloudIcon class={GLYPH[size]} />
	{/if}
</span>
