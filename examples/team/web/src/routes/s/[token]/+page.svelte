<script lang="ts">
	import { page } from '$app/state';
	import { apiBase } from '#lib/api/index.js';
	import type { ArtifactFile, ArtifactSummary } from '#lib/artifacts/api.js';
	import type { ViewerInput } from '#lib/artifacts/input.js';
	import ArtifactView from '#lib/components/artifacts/ArtifactView.svelte';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';

	/**
	 * The public page of a shared artifact (plan P45 "Sharing"): the whole screen is the viewer; no
	 * login, no app shell. Metadata from `GET /share/<token>`, content from the public content URLs it
	 * names (never with credentials).
	 */
	type Share = { artifact: ArtifactSummary; entryUrl: string; baseUrl: string; files: ArtifactFile[] };

	const token = $derived(page.params.token ?? '');
	let share = $state<Share>();
	let status = $state<'loading' | 'ready' | 'missing' | 'error'>('loading');

	$effect(() => {
		const t = token;
		const ctl = new AbortController();
		status = 'loading';
		share = undefined;
		fetch(`${apiBase.replace(/\/+$/, '')}/share/${encodeURIComponent(t)}`, { credentials: 'omit', signal: ctl.signal }).then(
			async (res) => {
				if (ctl.signal.aborted) return;
				if (res.status === 404) return void (status = 'missing');
				if (!res.ok) return void (status = 'error');
				share = (await res.json()) as Share;
				status = 'ready';
			},
			() => !ctl.signal.aborted && (status = 'error')
		);
		return () => ctl.abort();
	});

	const input = $derived.by((): ViewerInput | undefined => {
		const s = share;
		if (!s) return undefined;
		const a = s.artifact;
		const entry = s.files.find((f: ArtifactFile) => f.path === a.entry);
		return {
			kind: a.kind,
			title: a.title,
			name: a.entry,
			mediaType: entry?.mediaType,
			size: entry?.size,
			url: async () => s.entryUrl,
			resolve: async (rel: string) => `${s.baseUrl}${rel.replace(/^\.\//, '').split('/').map(encodeURIComponent).join('/')}`
		};
	});
</script>

<svelte:head>
	<title>{share?.artifact.title ?? 'Shared artifact'}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="flex h-svh min-h-0 flex-col bg-background text-foreground" data-testid="share-page">
	{#if status === 'ready' && share && input}
		<!-- the whole page is the viewer -->
		<main class="flex min-h-0 flex-1 flex-col overflow-auto">
			<ArtifactView {input} />
		</main>
	{:else if status === 'loading'}
		<div class="flex flex-col gap-3 p-6">
			<Skeleton class="h-6 w-64" />
			<Skeleton class="h-4 w-full" />
			<Skeleton class="h-4 w-5/6" />
		</div>
	{:else}
		<div class="flex flex-1 items-center justify-center p-6">
			<Empty.Root class="border-0">
				<Empty.Header>
					<Empty.Title>{status === 'missing' ? 'This link is not available' : 'Something went wrong'}</Empty.Title>
					<Empty.Description>
						{status === 'missing' ? 'It may have been made private or deleted.' : 'The shared item could not be loaded. Try again later.'}
					</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		</div>
	{/if}
</div>
