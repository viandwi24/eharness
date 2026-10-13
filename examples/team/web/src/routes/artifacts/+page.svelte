<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import { artifactsApi, toMs, type ArtifactSummary } from '#lib/artifacts/api.js';
	import { ARTIFACT_KINDS, isKnownKind, kindLabel } from '#lib/artifacts/kinds.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { ArtifactKindIcon, type ArtifactKind } from '#lib/components/ai/artifact-card/index.js';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import Surface from '#lib/components/app/Surface.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { formatTime } from '#lib/format.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	// Everything the team's agents made: search, filter by kind and visibility, open the full viewer.
	let query = $state('');
	let kind = $state('');
	let visibility = $state<'' | 'private' | 'public'>('');
	let items = $state<ArtifactSummary[]>([]);
	let cursor = $state<string | null>(null);
	let loaded = $state(false);
	let loadingMore = $state(false);
	let error = $state('');

	const shown = $derived(visibility ? items.filter((a) => a.visibility === visibility) : items);
	const filtered = $derived(query.trim() !== '' || kind !== '' || visibility !== '');

	let seq = 0;
	async function load(more = false): Promise<void> {
		const mine = ++seq;
		if (more) loadingMore = true;
		else loaded = false;
		try {
			const r = await artifactsApi.list({ query: query.trim(), kind, limit: 30, ...(more && cursor ? { cursor } : {}) });
			if (mine !== seq) return;
			items = more ? [...items, ...r.items] : r.items;
			cursor = r.nextCursor;
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the artifacts';
		} finally {
			if (mine === seq) {
				loaded = true;
				loadingMore = false;
			}
		}
	}

	// search and kind ask the server (debounced); visibility filters what is loaded
	let timer: ReturnType<typeof setTimeout> | undefined;
	function again(): void {
		clearTimeout(timer);
		timer = setTimeout(() => void load(), 250);
	}
	onMount(() => {
		void load();
		return () => clearTimeout(timer);
	});
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
<PageHeader title="Artifacts" description="Pages, documents, diagrams and files your agents made" />
<PageBody size="wide" class="gap-4">
	<div class="flex flex-wrap items-center gap-2">
		<div class="relative min-w-48 flex-1">
			<MagnifyingGlassIcon class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
			<Input bind:value={query} oninput={again} placeholder="Search artifacts" aria-label="Search artifacts" class="pl-8" />
		</div>
		<NativeSelect bind:value={kind} onchange={() => void load()} aria-label="Kind" class="w-auto">
			<NativeSelectOption value="">All kinds</NativeSelectOption>
			{#each ARTIFACT_KINDS as k (k)}<NativeSelectOption value={k}>{kindLabel(k)}</NativeSelectOption>{/each}
		</NativeSelect>
		<NativeSelect bind:value={visibility} aria-label="Visibility" class="w-auto">
			<NativeSelectOption value="">Any visibility</NativeSelectOption>
			<NativeSelectOption value="private">Private</NativeSelectOption>
			<NativeSelectOption value="public">Public</NativeSelectOption>
		</NativeSelect>
	</div>

	{#if error}
		<p class="text-sm text-destructive-text" role="alert">{error}</p>
	{:else if !loaded}
		<div class="flex flex-col gap-2" aria-busy="true">{#each [0, 1, 2, 3] as i (i)}<Skeleton class="h-16 w-full rounded-xl" />{/each}</div>
	{:else if shown.length === 0}
		<Empty.Root class="border border-dashed border-border">
			<Empty.Header>
				<Empty.Title>{filtered ? 'No artifacts match' : 'No artifacts yet'}</Empty.Title>
				<Empty.Description>{filtered ? 'Try another search or filter.' : 'Ask an agent to build a page, a document or a chart and it shows up here.'}</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<ul class="flex flex-col gap-2" data-testid="artifact-list">
			{#each shown as a (a.id)}
				{@const agent = a.agentId ? agentsStore.find(a.agentId) : undefined}
				<li>
					<Surface as="a" href="/artifacts/{a.id}" class="flex items-center gap-3 p-3 transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" data-testid="artifact-row">
						<span class="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-muted text-muted-foreground"><ArtifactKindIcon kind={(isKnownKind(a.kind) ? a.kind : 'file') as ArtifactKind} /></span>
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm font-medium">{a.title}</span>
							<span class="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
								<span>{kindLabel(a.kind)}</span><span aria-hidden="true">·</span><span>v{a.version}</span>
								{#if agent}<span aria-hidden="true">·</span><AgentAvatar seed={agent.id} color={agent.color} size={14} label={agent.name} /><span>{agent.name}</span>{/if}
								<span aria-hidden="true">·</span><span>{formatTime(toMs(a.updatedAt))}</span>
							</span>
						</span>
						<Badge variant={a.visibility === 'public' ? 'secondary' : 'outline'}>{a.visibility === 'public' ? 'Public' : 'Private'}</Badge>
					</Surface>
				</li>
			{/each}
		</ul>
		{#if cursor}
			<div class="flex justify-center"><Button variant="outline" size="sm" disabled={loadingMore} onclick={() => void load(true)}>{loadingMore ? 'Loading…' : 'Load more'}</Button></div>
		{/if}
	{/if}
</PageBody>
</div>
