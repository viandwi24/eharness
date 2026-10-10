<script lang="ts">
	import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOut';
	import type { ComponentProps } from "svelte";
	import { getOpenInContext } from "./context.js";
	import { type ProviderKey, providers } from "./providers.js";

	let {
		provider,
		...restProps
	}: Omit<ComponentProps<typeof DropdownMenu.Item>, "child" | "children"> & { provider: ProviderKey } = $props();

	const context = getOpenInContext();
	const config = $derived(providers[provider]);
	const Icon = $derived(config.icon);
	const href = $derived(config.createUrl(context.query));
	const label = $derived(config.title.replace("Open in ", ""));
</script>

<DropdownMenu.Item {...restProps}>
	{#snippet child({ props })}
		<a {...props} {href} rel="noopener noreferrer" target="_blank">
			<span
				class="inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] text-white [&_svg]:size-3"
				style:background={config.color}
			>
				<Icon />
			</span>
			<span class="flex-1">{label}</span>
			<ArrowSquareOutIcon class="size-[13px] shrink-0 text-muted-foreground" />
		</a>
	{/snippet}
</DropdownMenu.Item>
