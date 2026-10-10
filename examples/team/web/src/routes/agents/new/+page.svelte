<script lang="ts">
	import AgentEditor from '#lib/components/app/AgentEditor.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
</script>

<div class="flex min-w-0 flex-1 flex-col overflow-y-auto">
	<PageHeader title="New agent" />
	<AgentEditor />
</div>
