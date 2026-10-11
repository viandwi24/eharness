<script lang="ts">
	import { fetchLibraryBlob } from '#lib/api/index.js';
	import { Attachment, AttachmentInfo, AttachmentPreview, Attachments } from '#lib/components/ai/attachments/index.js';
	import { libraryPathOf } from '#lib/chat/library-url.js';
	import type { PartView } from './map.js';

	let { views }: { views: Extract<PartView, { kind: 'file' }>[] } = $props();

	// An uploaded file is stored as a `library:` reference; an <img> cannot load it (nor send the
	// bearer token), so images and PDFs are fetched with the token and shown from a blob URL.
	let blobs = $state<Record<string, string>>({});

	const requested = new Set<string>();
	let destroyed = false;

	$effect(() => {
		for (const f of views) {
			const path = libraryPathOf(f.url);
			if (path === undefined || !f.mediaType.startsWith('image/') || requested.has(f.url)) continue;
			requested.add(f.url);
			fetchLibraryBlob(path, { inline: true })
				.then((blob) => {
					if (!destroyed) blobs[f.url] = URL.createObjectURL(blob);
				})
				.catch(() => {
					// the file is gone or unreachable: the card keeps its icon
				});
		}
	});

	$effect(() => () => {
		destroyed = true;
		for (const url of Object.values(blobs)) URL.revokeObjectURL(url);
	});

	const shownUrl = (url: string): string | undefined => (libraryPathOf(url) === undefined ? url : blobs[url]);
</script>

<Attachments variant="inline">
	{#each views as f (f.key)}
		<Attachment data={{ type: 'file', id: f.key, url: shownUrl(f.url) ?? '', mediaType: f.mediaType, filename: f.filename }}>
			<AttachmentPreview />
			<AttachmentInfo />
		</Attachment>
	{/each}
</Attachments>
