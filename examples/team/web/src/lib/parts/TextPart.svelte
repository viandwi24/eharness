<script lang="ts">
	import { MessageResponse } from '#lib/components/ai/message/index.js';

	let { text }: { text: string } = $props();
</script>

<MessageResponse content={text} />
