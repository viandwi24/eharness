<script lang="ts">
	import ChannelHeader from '#lib/components/app/channels/ChannelHeader.svelte';
	import ChatsTable from '#lib/components/app/channels/ChatsTable.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { useConnection } from '#lib/channels/connection.svelte.js';

	const cs = useConnection();
	const account = $derived(cs.conn?.transport === 'user');
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<ChannelHeader section="chats" description={account ? 'The groups and channels of the account. Choose the ones it reads.' : 'Where the bot is. Choose the chats the agent may use.'} />
	<PageBody size="wide" class="gap-3">
		<p class="text-xs text-muted-foreground">
			{#if account}
				Pick the groups and channels to read. People (direct messages) are never listed. Live messages, edits and deletions are stored from the moment a chat is chosen; a chosen chat is observe-only until you change its settings.
			{:else}
				A chat must be allowed before the agent reads or answers there. Open a chat to set when the agent answers, how it replies and how long messages are kept.
			{/if}
		</p>
		<ChatsTable />
	</PageBody>
</div>
