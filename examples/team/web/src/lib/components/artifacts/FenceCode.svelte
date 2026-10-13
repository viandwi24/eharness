<script lang="ts">
	import type { CodeToken } from 'svelte-streamdown';
	import { fenceKind } from '#lib/artifacts/fences.js';
	import FenceBlock from './FenceBlock.svelte';
	import PlainFence from './PlainFence.svelte';

	/** Streamdown's `code` component: mermaid, svg and html fences preview; the rest stays plain. */
	let { token, id, incomplete = false }: { token: CodeToken; id: string; incomplete?: boolean; animate?: boolean } = $props();

	const lang = $derived((token.lang ?? '').toLowerCase());
	const kind = $derived(fenceKind({ lang, code: token.text }));
</script>

<!-- an open fence is still being written: it shows as code until the closing fence arrives -->
{#if kind && !incomplete}
	<FenceBlock {kind} {lang} code={token.text.replace(/\n+$/, '')} />
{:else}
	<PlainFence {token} {id} {incomplete} />
{/if}
