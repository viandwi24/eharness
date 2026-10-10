<script lang="ts">
	import './layout.css';
	import favicon from '#lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { ElevationProvider } from '#lib/components/ui/elevation/index.js';
	import { Toaster } from '#lib/components/ui/sonner/index.js';
	import * as Sidebar from '#lib/components/ui/sidebar/index.js';
	import AgentDialog from '#lib/components/app/AgentDialog.svelte';
	import AgentListPanel from '#lib/components/app/AgentListPanel.svelte';
	import AppRail from '#lib/components/app/AppRail.svelte';
	import { hasSubSidebar } from '#lib/nav/sections.js';
	import RoutineDialog from '#lib/components/app/RoutineDialog.svelte';
	import TaskDrawer from '#lib/components/app/TaskDrawer.svelte';
	import { startLive } from '#lib/stores/live.svelte.js';
	import { onMount } from 'svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Desktop sidebar collapsed / expanded (⌘B); the edmi provider stores it in a cookie.
	let sidebarOpen = $state(
		typeof document === 'undefined' || !/(?:^|;\s*)sidebar_state=false\b/.test(document.cookie)
	);

	onMount(() => startLive());

	// Mobile: list -> chat -> panel sheet. The list is the home screen; other routes replace it.
	const isHome = $derived(page.url.pathname === '/');
	// Desktop: [icon rail] [agent list, agents section only] [page]. ⌘B hides the agent list.
	const listShown = $derived(hasSubSidebar(page.url.pathname) && sidebarOpen);
	// Mobile bottom bar on top-level pages; a chat (/a/…) gets the whole screen.
	const barShown = $derived(!page.url.pathname.startsWith('/a/'));
</script>

<svelte:head>
	<title>Team</title>
	<link rel="icon" href={favicon} />
</svelte:head>

<ElevationProvider mode="layered">
	<Sidebar.Provider bind:open={sidebarOpen} class="h-svh min-h-0 flex-col bg-background text-foreground md:flex-row md:bg-sidebar">
		<div class="hidden md:flex"><AppRail /></div>
		<div class="flex min-h-0 min-w-0 flex-1">
			<aside
				class="{isHome ? 'flex' : 'hidden'} h-full w-full shrink-0 flex-col bg-sidebar text-sidebar-foreground {listShown ? 'md:flex' : 'md:hidden'} md:my-2 md:mr-2 md:h-auto md:w-72 md:overflow-hidden md:rounded-xl md:border md:border-border lg:w-80"
			>
				<AgentListPanel />
			</aside>
			<main
				class="{isHome ? 'hidden' : 'flex'} h-full min-w-0 flex-1 bg-background md:my-2 md:mr-2 md:flex md:h-auto md:overflow-hidden md:rounded-xl md:border md:border-border md:shadow-sm"
			>
				{@render children()}
			</main>
		</div>
		{#if barShown}<div class="md:hidden"><AppRail bar /></div>{/if}
	</Sidebar.Provider>
	<TaskDrawer />
	<AgentDialog />
	<RoutineDialog />
	<Toaster />
</ElevationProvider>
