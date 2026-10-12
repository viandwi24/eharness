<script lang="ts">
	import qrcode from 'qrcode-generator';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import type { FlowView } from '#lib/api/index.js';
	import type { FlowSession } from '#lib/connectors/flow-core.js';
	import { qrDataUri, refreshText } from '#lib/connectors/flow-view.js';
	import FlowFooter from './FlowFooter.svelte';
	import { usePolling, useNow } from './waiting.svelte.js';

	// A login QR code (Telegram: Settings, Devices, Link Desktop Device). The token rotates under the same
	// view while it is polled; the image is drawn here from the url, which goes nowhere else.
	let { session, view, onCancel }: { session: FlowSession; view: Extract<FlowView, { type: 'qr' }>; onCancel: () => void } = $props();

	// svelte-ignore state_referenced_locally
	usePolling(session, () => view);
	const clock = useNow();
	const image = $derived(view.url ? qrDataUri(view.url, qrcode as never) : '');
</script>

<div class="flex flex-col items-center gap-4 pt-1 pb-3 text-center">
	<div class="flex flex-col gap-1">
		<h3 class="text-sm font-medium">{view.title}</h3>
		{#if view.description}<p class="text-[13px] text-muted-foreground">{view.description}</p>{/if}
	</div>
	{#if image}
		<img src={image} alt="Login QR code" class="size-52 rounded-lg border border-border bg-white p-1" data-testid="flow-qr" />
	{:else}
		<div class="flex size-52 items-center justify-center rounded-lg border border-dashed border-border"><Spinner class="size-5" /></div>
	{/if}
	{#if view.url}<a class="max-w-full truncate text-xs underline underline-offset-4" href={view.url}>Open the login link on this device</a>{/if}
	<p class="flex items-center gap-2 text-xs text-muted-foreground" role="status"><Spinner class="size-3.5" />Waiting for the scan · {refreshText(view.expiresAt, clock.value)}</p>
</div>
<FlowFooter>
	<Button variant="ghost" onclick={onCancel}>Cancel</Button>
</FlowFooter>
