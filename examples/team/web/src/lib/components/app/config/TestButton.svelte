<script lang="ts">
	import PlugsConnectedIcon from 'phosphor-svelte/lib/PlugsConnected';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';

	/** The Test button of a provider profile or a connection (pair of `TestResult`). */
	let { busy = false, onclick, label = 'Test', variant = 'outline' }: { busy?: boolean; onclick: () => void; label?: string; variant?: 'outline' | 'default' | 'ghost' } = $props();
</script>

<Button type="button" {variant} size="sm" disabled={busy} {onclick}>
	{#if busy}<Spinner class="size-3.5" />{:else}<PlugsConnectedIcon class="size-3.5" />{/if}{label}
</Button>
