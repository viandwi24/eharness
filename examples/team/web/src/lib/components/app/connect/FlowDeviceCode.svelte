<script lang="ts">
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import CopyIcon from 'phosphor-svelte/lib/Copy';
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOut';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import type { FlowView } from '#lib/api/index.js';
	import type { FlowSession } from '#lib/connectors/flow-core.js';
	import { countdownText, deviceLink, safeUrl } from '#lib/connectors/flow-view.js';
	import { usePolling, useNow } from './waiting.svelte.js';

	let { session, view, onCancel }: { session: FlowSession; view: Extract<FlowView, { type: 'deviceCode' }>; onCancel: () => void } = $props();

	// svelte-ignore state_referenced_locally
	usePolling(session, () => view);
	const clock = useNow();
	const link = $derived(deviceLink(view));
	let copied = $state(false);

	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(view.userCode);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// clipboard unavailable: the code is selectable
		}
	}
</script>

<div class="flex flex-col items-center gap-4 py-2 text-center">
	<h3 class="text-sm font-semibold">{view.title}</h3>
	<p class="text-sm text-muted-foreground">Open the page below and enter this code.</p>
	<div class="flex items-center gap-2">
		<code class="rounded-md border border-border bg-muted px-4 py-2 font-mono text-2xl font-semibold tracking-widest select-all">{view.userCode}</code>
		<Button variant="outline" size="icon" onclick={copy} aria-label="Copy code">
			{#if copied}<CheckIcon class="size-4" />{:else}<CopyIcon class="size-4" />{/if}
		</Button>
	</div>
	{#if safeUrl(link)}
		<Button href={link} target="_blank" rel="noopener noreferrer"><ArrowSquareOutIcon class="size-4" />Open the page</Button>
	{/if}
	<p class="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Spinner class="size-4" />Waiting for you to finish…</p>
	<p class="text-xs text-muted-foreground">{countdownText(view.expiresAt, clock.value)}</p>
	<Button variant="ghost" onclick={onCancel}>Cancel</Button>
</div>
