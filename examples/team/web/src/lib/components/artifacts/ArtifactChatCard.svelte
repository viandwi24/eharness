<script lang="ts">
	import { ArtifactCard, ArtifactCardBody, ArtifactCardIcon, ArtifactCardMeta, ArtifactCardTitle, type ArtifactKind } from '#lib/components/ai/artifact-card/index.js';
	import { isKnownKind, kindLabel } from '#lib/artifacts/kinds.js';
	import { openPanel } from '#lib/artifacts/open.js';
	import { artifactsApi } from '#lib/artifacts/api.js';
	import { copyText } from '#lib/clipboard.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import CopyIcon from 'phosphor-svelte/lib/Copy';

	/** The artifact in the chat: a card that opens the side panel; while the agent writes it, the title shimmers. */
	let {
		id,
		kind,
		title,
		version,
		generating = false
	}: { id?: string; kind: string; title: string; version?: number; generating?: boolean } = $props();

	const iconKind = $derived((isKnownKind(kind) ? kind : 'file') as ArtifactKind);

	// The public link, when the artifact is public: people copy it from here instead of trusting a retyped one in the text.
	let shareUrl = $state<string | null>(null);
	$effect(() => {
		shareUrl = null;
		if (!id || generating) return;
		const ctrl = new AbortController();
		artifactsApi
			.get(id, ctrl.signal)
			.then((a) => {
				shareUrl = a.visibility === 'public' ? a.shareUrl : null;
			})
			.catch(() => {});
		return () => ctrl.abort();
	});

	async function copyLink(): Promise<void> {
		if (shareUrl && (await copyText(shareUrl))) toast.success('Link copied');
		else toast.error('Could not copy the link');
	}
</script>

{#snippet card()}
	<ArtifactCard state={generating ? 'generating' : 'ready'} class="max-w-lg transition-colors group-hover:bg-accent/40">
		<ArtifactCardIcon kind={iconKind} />
		<ArtifactCardBody>
			<ArtifactCardTitle>{title}</ArtifactCardTitle>
			<ArtifactCardMeta>{generating ? 'Writing…' : `${kindLabel(kind)}${version ? ` · v${version}` : ''}`}</ArtifactCardMeta>
		</ArtifactCardBody>
		{#if !generating}
			<span class="shrink-0 rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-foreground transition-colors group-hover:bg-accent">Open</span>
		{/if}
	</ArtifactCard>
{/snippet}

<div class="flex w-full max-w-lg flex-col gap-1">
{#if id && !generating}
	<button
		type="button"
		class="group block w-full max-w-lg rounded-xl text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
		aria-label="Open {title}"
		data-testid="artifact-card"
		onclick={() => openPanel({ kind: 'artifact', id })}
	>
		{@render card()}
	</button>
{:else}
	<div class="group w-full max-w-lg" data-testid="artifact-card" aria-busy={generating}>{@render card()}</div>
{/if}
	{#if shareUrl}
		<div class="flex items-center gap-2 px-1" data-testid="artifact-share-link">
			<span class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={shareUrl}>{shareUrl}</span>
			<Button size="xs" variant="ghost" aria-label="Copy public link" onclick={copyLink}><CopyIcon />Copy link</Button>
		</div>
	{/if}
</div>
