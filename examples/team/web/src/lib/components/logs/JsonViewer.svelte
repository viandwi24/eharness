<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import CopyIcon from 'phosphor-svelte/lib/Copy';
	import WarningIcon from 'phosphor-svelte/lib/Warning';
	import { Button } from '#lib/components/ui/button/index.js';
	import { formatBytes } from '#lib/files/helpers.js';
	import { truncationOf } from '#lib/logs/logs.js';
	import JsonNode from './JsonNode.svelte';
	import { copyText } from '#lib/clipboard.js';

	/** A JSON value as a collapsible tree with a copy button. A value cut by the server shows its preview as text. */
	let { value, title, empty = 'Nothing was recorded.' }: { value: unknown; title?: string; empty?: string } = $props();

	let openDepth = $state(2);
	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => () => clearTimeout(timer));

	const cut = $derived(truncationOf(value));
	const missing = $derived(value === null || value === undefined);
	const text = $derived(cut ? cut.preview : missing ? '' : JSON.stringify(value, null, 2));

	async function copy(): Promise<void> {
		if (!(await copyText(text))) return;
		copied = true;
		clearTimeout(timer);
		timer = setTimeout(() => (copied = false), 1500);
	}
</script>

{#if missing}
	<p class="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">{empty}</p>
{:else}
	<Surface elevation="sunken" class="overflow-hidden rounded-lg">
		<div class="flex items-center gap-1 border-b border-border bg-muted py-1.5 pr-1.5 pl-3">
			<span class="mr-auto font-mono text-[11.5px] text-muted-foreground">{title ?? 'JSON'} · {formatBytes(cut ? cut.bytes : text.length)}</span>
			{#if !cut}
				<Button variant="ghost" size="xs" onclick={() => (openDepth = 99)}>Expand all</Button>
				<Button variant="ghost" size="xs" onclick={() => (openDepth = 0)}>Collapse</Button>
			{/if}
			<Button variant="ghost" size="icon-xs" aria-label={copied ? 'Copied' : 'Copy JSON'} onclick={copy}>
				{#if copied}<CheckIcon />{:else}<CopyIcon />{/if}
			</Button>
		</div>
		{#if cut}
			<p class="flex items-start gap-2 border-b border-border bg-warning-soft px-3 py-2 text-xs text-warning-text">
				<WarningIcon class="mt-0.5 size-3.5 shrink-0" />
				Too large to keep in full: only the first part of the {formatBytes(cut.bytes)} was stored.
			</p>
			<pre class="max-h-[60vh] overflow-auto p-3 font-mono text-[12px] leading-[1.6] break-all whitespace-pre-wrap">{text}</pre>
		{:else}
			<div class="max-h-[60vh] overflow-auto p-3 font-mono text-[12px] leading-[1.6]">
				{#key openDepth}<JsonNode {value} {openDepth} />{/key}
			</div>
		{/if}
	</Surface>
{/if}
