<script lang="ts">
	import { onMount } from 'svelte';
	import ChatCircleDotsIcon from 'phosphor-svelte/lib/ChatCircleDots';
	import TelegramLogoIcon from 'phosphor-svelte/lib/TelegramLogo';
	import { api } from '#lib/api/index.js';
	import ChannelConnectionCard from '#lib/components/app/ChannelConnectionCard.svelte';
	import ConnectFlowDialog from '#lib/components/app/ConnectFlowDialog.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { sortConnections, type ChannelConnection } from '#lib/channels/model.js';
	import { connectorsStore } from '#lib/connectors/connectors.svelte.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	let list = $state<ChannelConnection[] | null>(null);
	let error = $state('');
	let connectOpen = $state(false);
	let seq = 0;
	const sorted = $derived(sortConnections(list ?? []));

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/channels/connections');
			if (mine !== seq) return;
			list = r.items;
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the channels';
		}
	}

	onMount(() => {
		void connectorsStore.load();
		if (!agentsStore.state.loaded) void agentsStore.load();
		void load();
		// there is no push for transport state: look again while the page is open and visible
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void load();
		}, 5000);
		return () => clearInterval(timer);
	});
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Channels" description="Chat platforms where your agents live: Telegram bots, their chats and the people linked to them.">
		<Button size="sm" onclick={() => (connectOpen = true)} data-testid="connect-bot"><TelegramLogoIcon class="size-4" /> Connect a Telegram bot</Button>
	</PageHeader>
	<PageBody size="narrow" class="gap-4">
		{#if error}
			<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Retry</button></p>
		{:else if !list}
			<div class="flex flex-col gap-3" aria-busy="true">{#each [0, 1] as i (i)}<Skeleton class="h-32 w-full rounded-xl" />{/each}</div>
		{:else if list.length === 0}
			<Empty.Root class="border border-dashed border-border" data-testid="channels-empty">
				<Empty.Header>
					<Empty.Media variant="icon"><ChatCircleDotsIcon /></Empty.Media>
					<Empty.Title>No bot connected</Empty.Title>
					<Empty.Description>
						Create a bot with @BotFather in Telegram (/newbot), copy its token, and connect it here. Then pick the agent that answers on it and allow the chats it may use.
					</Empty.Description>
				</Empty.Header>
				<Button size="sm" onclick={() => (connectOpen = true)}>Connect a Telegram bot</Button>
			</Empty.Root>
		{:else}
			{#each sorted as c (c.id)}<ChannelConnectionCard conn={c} onChange={() => void load()} />{/each}
		{/if}
	</PageBody>
</div>

<ConnectFlowDialog bind:open={connectOpen} definitionId="telegram-bot" scope="workspace" onDone={() => void load()} />
