<script lang="ts" module>
	/** An ancestor in the breadcrumb trail. Links when `href` is set; otherwise it is plain text. */
	export type Crumb = { label: string; href?: string };
</script>

<script lang="ts">
	import ShellHeader from './ShellHeader.svelte';
	import SidebarToggle from './SidebarToggle.svelte';
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeft';
	import type { Snippet } from 'svelte';
	import * as Breadcrumb from '#lib/components/ui/breadcrumb/index.js';
	import { Button } from '#lib/components/ui/button/index.js';

	/**
	 * The standard header of every global page (same h-14 as the chat header).
	 * `title` is the h1; `description` a one-line subtitle; `breadcrumb` the ancestors that lead to it;
	 * `actions` (or plain children, for older callers) sit on the right, before the approvals bell.
	 * `backHref` is where the mobile back arrow goes (default: the agent list).
 * On narrow screens the actions wrap onto a second row instead of squeezing the title away.
	 */
	let {
		title,
		description,
		breadcrumb,
		actions,
		children,
		backHref = '/'
	}: {
		title: string;
		description?: string;
		breadcrumb?: Crumb[];
		actions?: Snippet;
		children?: Snippet;
		backHref?: string;
	} = $props();
</script>

<ShellHeader>
	<header class="flex min-h-14 shrink-0 flex-wrap items-center gap-2 px-3 py-2 md:h-14 md:flex-nowrap md:py-0">
		<Button href={backHref} variant="ghost" size="icon-sm" class="md:hidden" aria-label="Back">
			<CaretLeftIcon class="size-4" />
		</Button>
		<SidebarToggle whenCollapsed />
		<div class="flex min-w-36 flex-1 flex-col justify-center">
			{#if breadcrumb?.length}
				<Breadcrumb.Root>
					<Breadcrumb.List class="flex-nowrap gap-1.5 text-sm sm:gap-1.5">
						{#each breadcrumb as c (c.label + (c.href ?? ''))}
							<Breadcrumb.Item class="shrink-0">
								{#if c.href}<Breadcrumb.Link href={c.href}>{c.label}</Breadcrumb.Link>{:else}{c.label}{/if}
							</Breadcrumb.Item>
							<Breadcrumb.Separator />
						{/each}
						<Breadcrumb.Item class="min-w-0">
							<h1 class="truncate text-sm font-medium text-foreground">{title}</h1>
						</Breadcrumb.Item>
					</Breadcrumb.List>
				</Breadcrumb.Root>
			{:else}
				<h1 class="truncate text-sm leading-5 font-medium">{title}</h1>
			{/if}
			{#if description}<p class="truncate text-xs leading-4 text-muted-foreground">{description}</p>{/if}
		</div>
		<div class="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2 max-md:ml-auto">
			{@render actions?.()}
			{@render children?.()}
		</div>
	</header>
</ShellHeader>
