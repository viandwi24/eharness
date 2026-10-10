<script lang="ts">
	import './layout.css';
	import favicon from '#lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { ElevationProvider } from '#lib/components/ui/elevation/index.js';
	import { Toaster } from '#lib/components/ui/sonner/index.js';
	import AgentList from '#lib/components/app/AgentList.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Mobile: list -> chat -> panel sheet. The list is the home screen; other routes replace it.
	const isHome = $derived(page.url.pathname === '/');
</script>

<svelte:head>
	<title>Team</title>
	<link rel="icon" href={favicon} />
</svelte:head>

<ElevationProvider mode="layered">
	<div class="flex h-svh bg-background text-foreground">
		<aside
			class="{isHome ? 'flex' : 'hidden'} h-full w-full shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground md:flex md:w-72 lg:w-80"
		>
			<AgentList />
		</aside>
		<main class="{isHome ? 'hidden' : 'flex'} h-full min-w-0 flex-1 md:flex">
			{@render children()}
		</main>
	</div>
	<Toaster />
</ElevationProvider>
