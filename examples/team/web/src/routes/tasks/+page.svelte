<script lang="ts">
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import { agents, tasks } from '#lib/mock.js';

	const columns = [
		{ id: 'needs-action', title: 'Needs action' },
		{ id: 'running', title: 'Running' },
		{ id: 'done', title: 'Done' }
	] as const;
</script>

<div class="flex min-w-0 flex-1 flex-col">
	<PageHeader title="Tasks" />
	<div class="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-3">
		{#each columns as col (col.id)}
			<section class="flex flex-col gap-2">
				<h2 class="text-sm font-medium text-muted-foreground">{col.title}</h2>
				{#each tasks.filter((t) => t.column === col.id) as t (t.id)}
					<div class="rounded-lg border border-border bg-card p-3 text-sm">
						<div class="font-medium">{t.title}</div>
						<div class="mt-1 text-xs text-muted-foreground">
							{agents.find((a) => a.id === t.agentId)?.name}
						</div>
					</div>
				{/each}
			</section>
		{/each}
	</div>
</div>
