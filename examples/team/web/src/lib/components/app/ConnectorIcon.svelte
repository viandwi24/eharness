<script lang="ts">
	import BrainIcon from 'phosphor-svelte/lib/Brain';
	import ChatCircleDotsIcon from 'phosphor-svelte/lib/ChatCircleDots';
	import FolderIcon from 'phosphor-svelte/lib/Folder';
	import GithubLogoIcon from 'phosphor-svelte/lib/GithubLogo';
	import GlobeIcon from 'phosphor-svelte/lib/Globe';
	import ListChecksIcon from 'phosphor-svelte/lib/ListChecks';
	import PlugsIcon from 'phosphor-svelte/lib/Plugs';
	import UsersIcon from 'phosphor-svelte/lib/Users';
	import type { Component } from 'svelte';
	import { iconKey, type IconKey } from '#lib/connectors/view.js';
	import { cn } from '#lib/utils.js';

	/** The icon of a connector, resolved from its `icon` name; unknown names fall back to a plug. */
	let { icon, class: className }: { icon?: string; class?: string } = $props();
	const ICONS: Record<IconKey, Component> = {
		folder: FolderIcon,
		brain: BrainIcon,
		'list-checks': ListChecksIcon,
		globe: GlobeIcon,
		'message-circle-question': ChatCircleDotsIcon,
		users: UsersIcon,
		'github-logo': GithubLogoIcon,
		plugs: PlugsIcon
	};
	const Icon = $derived(ICONS[iconKey(icon)]);
</script>

<span class={cn('flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted text-foreground', className)}>
	<Icon class="size-5" />
</span>
