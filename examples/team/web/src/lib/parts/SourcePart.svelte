<script lang="ts">
	import { Source, Sources, SourcesContent, SourcesTrigger } from '#lib/components/ai/sources/index.js';
	import type { PartView } from './map.js';

	let { views }: { views: Extract<PartView, { kind: 'source' }>[] } = $props();
</script>

<Sources>
	<SourcesTrigger count={views.length} />
	<SourcesContent>
		{#each views as s (s.key)}
			<Source href={s.url} title={s.title} />
		{/each}
	</SourcesContent>
</Sources>
