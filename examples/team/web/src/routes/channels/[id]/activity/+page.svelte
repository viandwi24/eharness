<script lang="ts">
	import ActivityTable from '#lib/components/app/channels/ActivityTable.svelte';
	import ChannelHeader from '#lib/components/app/channels/ChannelHeader.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { useConnection } from '#lib/channels/connection.svelte.js';

	const cs = useConnection();
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<ChannelHeader section="activity" description="What was received and what happened to it." />
	<PageBody size="wide" class="gap-3">
		<p class="text-xs text-muted-foreground">Every event of this channel, newest first. In: what woke the agent, what was only read, what was dropped and why. Out: replies, approvals, and every action or read the agent made on the platform (who asked, the result, how long it took), plus rate limits. Metadata only: no message text.</p>
		<ActivityTable connectionId={cs.id()} />
	</PageBody>
</div>
