<script lang="ts">
	import './layout.css';
	import favicon from '#lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { ElevationProvider } from '#lib/components/ui/elevation/index.js';
	import { Toaster } from '#lib/components/ui/sonner/index.js';
	import * as Sidebar from '#lib/components/ui/sidebar/index.js';
	import AgentDialog from '#lib/components/app/AgentDialog.svelte';
	import AppSidebar from '#lib/components/app/AppSidebar.svelte';
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
</script>

<svelte:head>
	<title>Team</title>
	<link rel="icon" href={favicon} />
</svelte:head>

<ElevationProvider mode="layered">
	<!-- md+: the page sits in an inset panel on the sidebar surface (edmi-ui sidebar "inset" look). -->
	<Sidebar.Provider bind:open={sidebarOpen} class="h-svh min-h-0 bg-background text-foreground md:bg-sidebar">
		<aside
			class="{isHome ? 'flex' : 'hidden'} h-full w-full shrink-0 flex-col bg-sidebar text-sidebar-foreground {sidebarOpen ? 'md:flex' : 'md:hidden'} md:w-72 lg:w-80"
		>
			<AppSidebar />
		</aside>
		<main
			class="{isHome ? 'hidden' : 'flex'} h-full min-w-0 flex-1 bg-background md:my-2 md:mr-2 {sidebarOpen ? '' : 'md:ml-2'} md:flex md:h-auto md:overflow-hidden md:rounded-xl md:border md:border-border md:shadow-sm"
		>
			{@render children()}
		</main>
	</Sidebar.Provider>
	<TaskDrawer />
	<AgentDialog />
	<RoutineDialog />
	<Toaster />
</ElevationProvider>
