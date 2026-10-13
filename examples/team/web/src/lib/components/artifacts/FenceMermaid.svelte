<script lang="ts">
	import type { CodeToken } from 'svelte-streamdown';
	import FenceBlock from './FenceBlock.svelte';
	import PlainFence from './PlainFence.svelte';

	let { token, id, incomplete = false }: { token: CodeToken; id: string; incomplete?: boolean; animate?: boolean } = $props();
</script>

{#if incomplete}
	<PlainFence {token} {id} {incomplete} />
{:else}
	<FenceBlock kind="mermaid" lang="mermaid" code={token.text.replace(/\n+$/, '')} />
{/if}
