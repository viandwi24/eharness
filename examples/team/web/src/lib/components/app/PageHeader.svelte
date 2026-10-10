<script lang="ts" module>
	/** An ancestor in the breadcrumb trail. Links when `href` is set; otherwise it is plain text. */
	export type Crumb = { label: string; href?: string };
</script>

<script lang="ts">
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeft';
	import type { Snippet } from 'svelte';
	import * as Breadcrumb from '#lib/components/ui/breadcrumb/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import ApprovalsPopover from './ApprovalsPopover.svelte';

	/**
	 * The standard header of every global page (same h-14 as the chat header).
	 * `title` is the h1; `description` a one-line subtitle; `breadcrumb` the ancestors that lead to it;
	 * `actions` (or plain children, for older callers) sit on the right, before the approvals bell.
	 * `backHref` is where the mobile back arrow goes (default: the agent list).
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

<header class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
	<Button href={backHref} variant="ghost" size="icon-sm" class="md:hidden" aria-label="Back">
		<CaretLeftIcon class="size-4" />
	</Button>
	<div class="flex min-w-0 flex-1 flex-col justify-center">
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
	<div class="flex shrink-0 items-center gap-2">
		{@render actions?.()}
		{@render children?.()}
		<ApprovalsPopover />
	</div>
</header>
