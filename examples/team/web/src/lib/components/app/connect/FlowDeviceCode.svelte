<script lang="ts">
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import CopyIcon from 'phosphor-svelte/lib/Copy';
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOut';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import type { FlowView } from '#lib/api/index.js';
	import type { FlowSession } from '#lib/connectors/flow-core.js';
	import { countdownText, deviceLink, safeUrl } from '#lib/connectors/flow-view.js';
	import FlowFooter from './FlowFooter.svelte';
	import { usePolling, useNow } from './waiting.svelte.js';
	import { copyText } from '#lib/clipboard.js';

	let { session, view, onCancel }: { session: FlowSession; view: Extract<FlowView, { type: 'deviceCode' }>; onCancel: () => void } = $props();

	// svelte-ignore state_referenced_locally
	usePolling(session, () => view);
	const clock = useNow();
	const link = $derived(deviceLink(view));
	const expired = $derived(view.expiresAt <= clock.value);
	let copied = $state(false);

	async function copy(): Promise<void> {
		// clipboard unavailable: the code is selectable
		if (!(await copyText(view.userCode))) return;
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}
</script>

<div class="flex flex-col items-center gap-4 pt-1 pb-3 text-center">
	<div class="flex flex-col gap-1">
		<h3 class="text-sm font-medium">{view.title}</h3>
		<p class="text-[13px] text-muted-foreground">{expired ? 'This code has expired. Cancel and connect again to get a new one.' : 'Open the page, then enter this code.'}</p>
	</div>
	<button
		type="button"
		onclick={copy}
		aria-label="Copy code {view.userCode}"
		disabled={expired}
		class="group flex max-w-full items-center gap-3 rounded-xl border border-border bg-muted/50 px-4 py-3 transition-colors outline-none hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring sm:px-5 {expired ? 'opacity-50' : ''}"
	>
		<code class="font-mono text-2xl font-semibold tracking-[0.15em] whitespace-nowrap select-all sm:text-3xl sm:tracking-[0.2em] {expired ? 'line-through' : ''}">{view.userCode}</code>
		<span class="text-muted-foreground group-hover:text-foreground">
			{#if copied}<CheckIcon class="size-4" />{:else}<CopyIcon class="size-4" />{/if}
		</span>
	</button>
	{#if !expired}<p class="h-4 text-xs text-muted-foreground" role="status" aria-live="polite">{copied ? 'Copied' : 'Select the code to copy it'}</p>{/if}
	{#if !expired && safeUrl(link)}
		<Button href={link} target="_blank" rel="noopener noreferrer"><ArrowSquareOutIcon class="size-4" />Open the page</Button>
	{/if}
	{#if expired}
		<p class="text-xs text-destructive-text" role="status">Expired</p>
	{:else}
		<p class="flex items-center gap-2 text-xs text-muted-foreground" role="status"><Spinner class="size-3.5" />Waiting for you to finish · {countdownText(view.expiresAt, clock.value)}</p>
	{/if}
</div>
<FlowFooter>
	<Button variant="ghost" onclick={onCancel}>Cancel</Button>
</FlowFooter>
