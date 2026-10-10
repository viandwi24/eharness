<script lang="ts">
	import { page } from '$app/state';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import SessionView from '#lib/components/app/SessionView.svelte';
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Task" />
	{#key page.params.id}
		<SessionView taskId={page.params.id ?? ''} />
	{/key}
</div>
