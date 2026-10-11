<script lang="ts">
	import { live } from '#lib/stores/live.svelte.js';
</script>

<!-- Thin, quiet top bar while the events stream is down (server restart, network). Fades in after a
     moment so an instant reconnect never flashes; gone as soon as the stream is back. -->
{#if live.state.connection === 'unauthorized'}
	<!-- Terminal: the server answered 401 / 403 to the activity stream. Retrying will not help; the
	     token (Settings) must change. -->
	<div role="alert" class="fixed inset-x-0 top-0 z-50 flex h-6 items-center justify-center gap-1.5 bg-destructive-soft text-[11px] text-destructive-text" data-testid="feed-unauthorized">
		Not authorized: the server refused the token. Set a valid token in Settings, then reload.
	</div>
{:else if live.state.reconnecting}
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
