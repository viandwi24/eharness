<script lang="ts">
	import ConnectorIcon from '#lib/components/app/ConnectorIcon.svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import type { Connector } from '#lib/api/index.js';

	// The channel types offered, straight from the registered channel connector definitions: a new
	// platform shows up here without a change to this page.
	let {
		open = $bindable(false),
		types,
		onPick
	}: { open?: boolean; types: Connector[]; onPick: (definitionId: string) => void } = $props();
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
		<Dialog.Header class="border-b border-border px-5 py-4 pr-12">
			<Dialog.Title class="text-[15px]">Connect a channel</Dialog.Title>
			<Dialog.Description class="text-xs">Choose where the agent will live. You set it up next.</Dialog.Description>
		</Dialog.Header>
		<ul class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4" data-testid="channel-types">
			{#each types as t (t.id)}
				<li>
					<button
						type="button"
						class="flex w-full items-start gap-3 rounded-lg border border-border p-3 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
						onclick={() => {
							open = false;
							onPick(t.id);
						}}
						data-testid="channel-type-{t.id}"
					>
						<ConnectorIcon icon={t.icon} size="sm" />
						<span class="flex min-w-0 flex-col gap-0.5">
							<span class="text-sm font-medium">{t.name}</span>
							<span class="text-xs text-muted-foreground">{t.description}</span>
						</span>
					</button>
				</li>
			{:else}
				<li class="p-3 text-sm text-muted-foreground">No channel types are available on this server.</li>
			{/each}
		</ul>
	</Dialog.Content>
</Dialog.Root>
