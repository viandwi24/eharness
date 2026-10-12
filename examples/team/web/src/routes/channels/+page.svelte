<script lang="ts">
	import { onMount } from 'svelte';
	import ChatCircleDotsIcon from 'phosphor-svelte/lib/ChatCircleDots';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import { api } from '#lib/api/index.js';
	import ChannelAccountCard from '#lib/components/app/ChannelAccountCard.svelte';
	import ChannelTypePicker from '#lib/components/app/ChannelTypePicker.svelte';
	import ChannelConnectionCard from '#lib/components/app/ChannelConnectionCard.svelte';
	import ConnectFlowDialog from '#lib/components/app/ConnectFlowDialog.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { channelTypes, isAccount, sortConnections, type ChannelConnection } from '#lib/channels/model.js';
	import { connectorsStore } from '#lib/connectors/connectors.svelte.js';
	import { pollWhileVisible } from '#lib/hooks/poll.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	let list = $state<ChannelConnection[] | null>(null);
	let error = $state('');
	let pickOpen = $state(false);
	let connectOpen = $state(false);
	let definitionId = $state('');
	const types = $derived(channelTypes(connectorsStore.state.connectors));
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
		return pollWhileVisible(() => void load());
	});
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Channels" description="Chat platforms where your agents live. Connect a channel, choose the chats it may use, and see what it sends and reads.">
		<Button size="sm" onclick={() => (pickOpen = true)} data-testid="connect-channel"><PlusIcon class="size-4" /> Connect a channel</Button>
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
					<Empty.Title>No channel connected</Empty.Title>
					<Empty.Description>
						A channel is a chat platform where an agent talks with your team or reads what is said. Pick a type next (for example a Telegram bot, or a Telegram account for chats a bot cannot join), set it up, then choose the agent and the chats.
					</Empty.Description>
				</Empty.Header>
				<Button size="sm" onclick={() => (pickOpen = true)}>Connect a channel</Button>
			</Empty.Root>
		{:else}
			{#each sorted as c (c.id)}
				{#if isAccount(c)}<ChannelAccountCard conn={c} onChange={() => void load()} />{:else}<ChannelConnectionCard conn={c} onChange={() => void load()} />{/if}
			{/each}
		{/if}
	</PageBody>
</div>

<ChannelTypePicker bind:open={pickOpen} {types} onPick={(id) => { definitionId = id; connectOpen = true; }} />
<ConnectFlowDialog bind:open={connectOpen} {definitionId} scope="workspace" next="Next: choose the agent that uses it on its card, then the chats it may read." onDone={() => void load()} />
