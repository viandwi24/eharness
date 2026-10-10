<script lang="ts">
	import { page } from '$app/state';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import SessionView from '#lib/components/app/SessionView.svelte';
	import { live } from '#lib/stores/live.svelte.js';

	const task = $derived(live.state.tasks.find((t) => t.id === page.params.id));
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title={task?.title ?? 'Task'} breadcrumb={[{ label: 'Tasks', href: '/tasks' }]} backHref="/tasks" />
	{#key page.params.id}
		<SessionView taskId={page.params.id ?? ''} />
	{/key}
</div>
