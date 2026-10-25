<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { api } from '#lib/api/index.js';
	import { eventHref } from '#lib/events/events.js';

	// Events live on the page of each channel. Older links (`/events?e=<id>` in bell notifications)
	// land here and go on to the page that shows the event.
	onMount(() => {
		const id = page.url.searchParams.get('e');
		if (!id) return void goto('/channels', { replace: true });
		void api
			.get('/events/{id}', { params: { id } })
			.then((e) => goto(eventHref(e), { replace: true }))
			.catch(() => goto('/channels', { replace: true }));
	});
</script>

<p class="p-4 text-sm text-muted-foreground">Opening the event…</p>
