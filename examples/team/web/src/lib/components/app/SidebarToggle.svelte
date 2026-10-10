<script lang="ts">
	import SidebarSimpleIcon from 'phosphor-svelte/lib/SidebarSimple';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Kbd, KbdGroup } from '#lib/components/ui/kbd/index.js';
	import { useSidebar } from '#lib/components/ui/sidebar/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';

	/**
	 * Collapse / expand the app sidebar on md+ (⌘B / Ctrl+B also toggles it). `whenCollapsed`: render
	 * only while the sidebar is hidden (the page headers show it to bring the sidebar back).
	 */
	let { whenCollapsed = false }: { whenCollapsed?: boolean } = $props();
	const sidebar = useSidebar();
	const mac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform);
</script>

{#if !whenCollapsed || !sidebar.open}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					variant="ghost"
					size="icon-sm"
					class="hidden shrink-0 text-muted-foreground md:inline-flex"
					aria-label={sidebar.open ? 'Hide sidebar' : 'Show sidebar'}
					aria-expanded={sidebar.open}
					onclick={() => sidebar.setOpen(!sidebar.open)}
				>
					<SidebarSimpleIcon class="size-4" />
				</Button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content side="bottom" class="flex items-center gap-2">
			{sidebar.open ? 'Hide sidebar' : 'Show sidebar'}
			<KbdGroup><Kbd>{mac ? '⌘' : 'Ctrl'}</Kbd><Kbd>B</Kbd></KbdGroup>
		</Tooltip.Content>
	</Tooltip.Root>
{/if}
