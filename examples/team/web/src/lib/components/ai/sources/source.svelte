<script lang="ts">
	import GlobeIcon from 'phosphor-svelte/lib/Globe';
	import { cn } from "#lib/utils.js";
	import type { HTMLAnchorAttributes } from "svelte/elements";

	let { class: className, href, title, children, ...restProps }: HTMLAnchorAttributes = $props();

	const host = $derived.by(() => {
		if (!href) return undefined;
		try {
			return new URL(href).hostname.replace(/^www\./, "");
		} catch {
			return undefined;
		}
	});
</script>

<a
	data-slot="ai-source"
	class={cn("flex items-center gap-2 text-foreground", className)}
	{href}
	rel="noreferrer"
	target="_blank"
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else}
		<GlobeIcon class="size-3.5 shrink-0 text-muted-foreground" />
		<span class="underline underline-offset-[3px]">{title}</span>
		{#if host}
			<span class="font-mono text-[11.5px] text-muted-foreground">{host}</span>
		{/if}
	{/if}
</a>
