<script lang="ts">
	import { page } from '$app/state';
	import ArtifactPanel from '#lib/components/artifacts/ArtifactPanel.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';

	// The full-page viewer of one artifact: the same panel as in the chat, without the chat around it.
	const id = $derived(page.params.id ?? '');
	const version = $derived(Number(page.url.searchParams.get('v')) || undefined);
</script>

<PageHeader title="Artifact" breadcrumb={[{ label: 'Artifacts', href: '/artifacts' }]} backHref="/artifacts" />
<div class="flex min-h-0 flex-1 flex-col">
	{#key id}
		<ArtifactPanel full target={{ kind: 'artifact', id, version }} />
	{/key}
</div>
