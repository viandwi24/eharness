<script lang="ts">
	import * as InsetPanel from '#lib/components/ui/inset-panel/index.js';
	import { shell } from '#lib/stores/shell.svelte.js';
	import './layout.css';
	import favicon from '#lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { Toaster } from '#lib/components/ui/sonner/index.js';
	import * as Sidebar from '#lib/components/ui/sidebar/index.js';
	import AgentDialog from '#lib/components/app/AgentDialog.svelte';
	import AgentListPanel from '#lib/components/app/AgentListPanel.svelte';
	import AppRail from '#lib/components/app/AppRail.svelte';
	import { hasSubSidebar } from '#lib/nav/sections.js';
	import NewTaskDialog from '#lib/components/app/NewTaskDialog.svelte';
	import ProgramDialog from '#lib/components/app/ProgramDialog.svelte';
	import RoutineDialog from '#lib/components/app/RoutineDialog.svelte';
	import ReconnectingBar from '#lib/components/app/ReconnectingBar.svelte';
	import TaskDrawer from '#lib/components/app/TaskDrawer.svelte';
	import { startLive } from '#lib/stores/live.svelte.js';
	import { checkSession } from '#lib/stores/auth.svelte.js';
	import { goToLogin } from '#lib/api/auth-fetch.js';
	import { isLoginPath, mustSignIn } from '#lib/auth.js';
	import { onMount } from 'svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Desktop sidebar collapsed / expanded (⌘B); the edmi provider stores it in a cookie.
	let sidebarOpen = $state(
		typeof document === 'undefined' || !/(?:^|;\s*)sidebar_state=false\b/.test(document.cookie)
	);

	// The login page is a bare page: no rail, no live connection.
	const isLogin = $derived(isLoginPath(page.url.pathname));

	onMount(() => {
		document.getElementById('boot')?.remove(); // the static "Loading…" of app.html
		if (isLoginPath(location.pathname)) return;
		let stop: (() => void) | undefined;
		let gone = false;
		// with a login, ask the server first: a signed-out browser goes to /login instead of opening streams
		void checkSession().then((s) => {
			if (gone) return;
			if (mustSignIn(s)) goToLogin();
			else stop = startLive();
		});
		return () => {
			gone = true;
			stop?.();
		};
	});

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

{#if isLogin}
	{@render children()}
	<Toaster />
{:else}
	<Sidebar.Provider bind:open={sidebarOpen} class="h-svh min-h-0 flex-col bg-background text-foreground md:flex-row md:bg-sidebar">
		<div class="hidden md:flex"><AppRail /></div>
		<div class="flex min-h-0 min-w-0 flex-1">
			<!-- the agent list sits on the shell background next to the rail (no card); only the page is a panel -->
			<aside
				class="{isHome ? 'flex' : 'hidden'} h-full w-full shrink-0 flex-col bg-sidebar text-sidebar-foreground {listShown ? 'md:flex' : 'md:hidden'} md:w-72 lg:w-80"
			>
				<AgentListPanel />
			</aside>
			<!-- the page is an edmi inset panel: a shell with the content plate inset in it -->
			<InsetPanel.Root
				elevation="raised"
				class="{isHome ? 'hidden' : 'flex'} h-full min-w-0 flex-1 max-md:rounded-none max-md:border-0 md:my-2 md:mr-2 md:flex md:h-auto"
			>
				{#if shell.header}
					<!-- page header on the shell, above the plate (edmi inset panel recipe) -->
					<InsetPanel.Header class="block p-0 font-normal">{@render shell.header()}</InsetPanel.Header>
				{/if}
				<InsetPanel.Body class="{shell.header ? '' : 'mt-0.5'} flex min-h-0 text-foreground max-md:m-0 max-md:rounded-none max-md:border-0">
					{@render children()}
				</InsetPanel.Body>
			</InsetPanel.Root>
		</div>
		{#if barShown}<div class="md:hidden"><AppRail bar /></div>{/if}
	</Sidebar.Provider>
	<ReconnectingBar />
	<TaskDrawer />
	<AgentDialog />
	<RoutineDialog />
	<ProgramDialog />
	<NewTaskDialog />
	<Toaster />
{/if}
