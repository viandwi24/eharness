<script lang="ts">
	import { live } from '#lib/stores/live.svelte.js';
</script>

<!-- Thin, quiet top bar while the events stream is down (server restart, network). Fades in after a
     moment so an instant reconnect never flashes; gone as soon as the stream is back. -->
{#if live.state.reconnecting}
	<div
		role="status"
		aria-live="polite"
		class="reconnecting pointer-events-none fixed inset-x-0 top-0 z-50 flex h-5 items-center justify-center gap-1.5 bg-muted/90 text-[11px] text-muted-foreground backdrop-blur-sm"
	>
		<span class="size-1.5 animate-pulse rounded-full bg-amber-500"></span>
		Reconnecting…
	</div>
{/if}

<style>
	.reconnecting {
		animation: reconnecting-in 150ms ease-out 1s both;
	}
	@keyframes reconnecting-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
</style>
