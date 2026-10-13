<script lang="ts">
	import { ArtifactCard, ArtifactCardBody, ArtifactCardIcon, ArtifactCardMeta, ArtifactCardTitle, type ArtifactKind } from '#lib/components/ai/artifact-card/index.js';
	import { isKnownKind, kindLabel } from '#lib/artifacts/kinds.js';
	import { openPanel } from '#lib/artifacts/open.js';

	/** The artifact in the chat: a card that opens the side panel; while the agent writes it, the title shimmers. */
	let {
		id,
		kind,
		title,
		version,
		generating = false
	}: { id?: string; kind: string; title: string; version?: number; generating?: boolean } = $props();

	const iconKind = $derived((isKnownKind(kind) ? kind : 'file') as ArtifactKind);
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
