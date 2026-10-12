<script lang="ts">
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { STATE_LABEL, stateTone, typeLabel, type ChannelConnection } from '#lib/channels/model.js';

	// The type of a connection (Telegram bot or account) and what it is doing right now.
	let { conn }: { conn: ChannelConnection } = $props();
</script>

<Badge variant="secondary" data-testid="channel-type">{typeLabel(conn)}</Badge>
<Badge variant={stateTone(conn.runtime.state)} data-testid="channel-state">{STATE_LABEL[conn.runtime.state]}</Badge>
