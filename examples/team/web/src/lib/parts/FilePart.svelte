<script lang="ts">
	import { Attachment, AttachmentInfo, AttachmentPreview, Attachments } from '#lib/components/ai/attachments/index.js';
	import type { PartView } from './map.js';

	let { views }: { views: Extract<PartView, { kind: 'file' }>[] } = $props();
</script>

<Attachments variant="inline">
	{#each views as f (f.key)}
		<Attachment data={{ type: 'file', id: f.key, url: f.url, mediaType: f.mediaType, filename: f.filename }}>
			<AttachmentPreview />
			<AttachmentInfo />
		</Attachment>
	{/each}
</Attachments>
