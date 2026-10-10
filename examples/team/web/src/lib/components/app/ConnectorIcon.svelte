<script lang="ts">
	import BrainIcon from 'phosphor-svelte/lib/Brain';
	import ChatCircleDotsIcon from 'phosphor-svelte/lib/ChatCircleDots';
	import FolderIcon from 'phosphor-svelte/lib/Folder';
	import GlobeIcon from 'phosphor-svelte/lib/Globe';
	import ListChecksIcon from 'phosphor-svelte/lib/ListChecks';
	import PlugsIcon from 'phosphor-svelte/lib/Plugs';
	import UsersIcon from 'phosphor-svelte/lib/Users';
	import type { Component } from 'svelte';
	import { iconKey, type IconKey } from '#lib/connectors/view.js';
	import { cn } from '#lib/utils.js';

	/**
	 * The logo of a connector, resolved from its `icon` name: the GitHub mark as inline SVG, built-ins as
	 * Phosphor icons in softly tinted tiles; unknown names fall back to a plug. `size` is the tile.
	 */
	let { icon, size = 'md', class: className }: { icon?: string; size?: 'sm' | 'md' | 'lg'; class?: string } = $props();

	const ICONS: Partial<Record<IconKey, Component>> = {
		folder: FolderIcon,
		brain: BrainIcon,
		'list-checks': ListChecksIcon,
		globe: GlobeIcon,
		'message-circle-question': ChatCircleDotsIcon,
		users: UsersIcon,
		plugs: PlugsIcon
	};
	// soft tint per icon, readable in light and dark; the brand mark keeps its own colours
	const TINT: Record<IconKey, string> = {
		folder: 'bg-amber-500/12 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300',
		brain: 'bg-violet-500/12 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300',
		'list-checks': 'bg-emerald-500/12 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300',
		globe: 'bg-sky-500/12 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300',
		'message-circle-question': 'bg-rose-500/12 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300',
		users: 'bg-indigo-500/12 text-indigo-700 dark:bg-indigo-400/15 dark:text-indigo-300',
		'github-logo': 'bg-foreground text-background',
		plugs: 'bg-muted text-muted-foreground'
	};
	const SIZE = { sm: 'size-8 rounded-lg', md: 'size-10 rounded-xl', lg: 'size-14 rounded-2xl' } as const;
	const GLYPH = { sm: 'size-4', md: 'size-5', lg: 'size-7' } as const;

	const key = $derived(iconKey(icon));
	const Icon = $derived(ICONS[key]);
</script>

<span aria-hidden="true" class={cn('flex shrink-0 items-center justify-center', SIZE[size], TINT[key], className)}>
	{#if key === 'github-logo'}
		<svg viewBox="0 0 24 24" fill="currentColor" class={GLYPH[size]}>
			<path
				d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.16.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"
			/>
		</svg>
	{:else if Icon}
		<Icon class={GLYPH[size]} />
	{/if}
</span>
