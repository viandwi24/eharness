<script lang="ts">
	// Debugging the heartbeat of an agent: the beats (what each one decided) beside the heartbeat
	// session itself (every prompt, tool call and result of the rolling `heartbeat:<agentId>` session),
	// with links to the model calls in Logs.
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import type { UIMessage } from 'ai';
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwise';
	import ListMagnifyingGlassIcon from 'phosphor-svelte/lib/ListMagnifyingGlass';
	import { api, harness } from '#lib/api/index.js';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import Surface from '#lib/components/app/Surface.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import MessageView from '#lib/parts/MessageView.svelte';
	import { formatTime } from '#lib/format.js';
	import { BEAT_LABEL, beatDetail, beatTone, decisionLine, type Heartbeat } from '#lib/heartbeat/model.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { cn } from '#lib/utils.js';

	const agentId = $derived(page.params.id ?? '');
	const agent = $derived(agentsStore.state.agents.find((a) => a.id === agentId || a.slug === agentId));
	const sessionId = $derived(`heartbeat:${agent?.id ?? agentId}`);
	const PAGE = 30;

	let hb = $state<Heartbeat | null>(null);
	let messages = $state<UIMessage[]>([]);
	let olderCursor = $state<string | undefined>(undefined);
	const hasOlder = $derived(olderCursor !== undefined);
	let loading = $state(false);
	let error = $state('');
	let selectedBeat = $state<string | null>(null);

	async function load(): Promise<void> {
		if (!agent) return;
		loading = true;
		try {
			const [beats, page1] = await Promise.all([
				api.get('/agents/{id}/heartbeat', { params: { id: agent.id } }),
				harness.sessions.messages(sessionId, { limit: PAGE, clip: 20_000 })
			]);
			hb = beats;
			messages = page1.messages as UIMessage[];
			olderCursor = page1.nextBefore;
			error = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load the heartbeat';
		} finally {
			loading = false;
		}
	}

	async function older(): Promise<void> {
		if (olderCursor === undefined) return;
		loading = true;
		try {
			const p = await harness.sessions.messages(sessionId, { limit: PAGE, clip: 20_000, before: olderCursor });
			messages = [...(p.messages as UIMessage[]), ...messages];
			olderCursor = p.nextBefore;
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void agent?.id;
		untrack(() => void load());
	});
	// a beat that ends (heartbeat-changed) or a new message of this session refreshes the view
	let seen = live.state.revs.heartbeat;
	$effect(() => {
		const rev = live.state.revs.heartbeat;
		untrack(() => {
			if (rev !== seen) {
				seen = rev;
				void load();
			}
		});
	});

	/** The time of a message (UUIDv7 ids sort by creation; metadata may carry it too). */
	const timeOf = (m: UIMessage): number | undefined => {
		const meta = (m.metadata as { createdAt?: number } | undefined)?.createdAt;
		if (typeof meta === 'number') return meta;
		const hex = m.id.replace(/-/g, '').slice(0, 12);
		const t = Number.parseInt(hex, 16);
		return Number.isFinite(t) && t > 1_500_000_000_000 ? t : undefined;
	};
	/** Messages of one beat: from its start to its end (or the next beat). */
	const inBeat = (m: UIMessage): boolean => {
		const b = hb?.beats.find((x) => x.id === selectedBeat);
		if (!b) return true;
		const t = timeOf(m);
		if (t === undefined) return true;
		return t >= b.at - 2_000 && t <= (b.endedAt ?? Date.now()) + 2_000;
	};
	const shown = $derived(messages.filter(inBeat));
	const logsHref = $derived(`/logs?sessionId=${encodeURIComponent(sessionId)}&range=7d`);
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Heartbeat of {agent?.name ?? 'agent'}" description="Every beat, and the session it runs in: prompts, tool calls and results." breadcrumb={[{ label: 'Agents', href: '/' }]} backHref={agent ? `/a/${agent.id}` : '/'}>
		<Button size="sm" variant="outline" href={logsHref}><ListMagnifyingGlassIcon class="size-4" /> Model calls in Logs</Button>
		<Button size="sm" variant="ghost" onclick={() => void load()} disabled={loading} aria-label="Refresh">
			{#if loading}<Spinner class="size-4" />{:else}<ArrowClockwiseIcon class="size-4" />{/if}
		</Button>
	</PageHeader>

	<PageBody size="full" class="gap-4">
		{#if error}
			<p class="text-sm text-destructive-text" role="alert">{error}</p>
		{:else if !hb}
			<Skeleton class="h-96 w-full" />
		{:else}
			<div class="grid min-w-0 gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
				<Surface class="flex min-w-0 flex-col self-start xl:sticky xl:top-4">
					<div class="flex items-center gap-2 border-b border-border px-3 py-2">
						<span class="text-sm font-medium">Beats</span>
						<span class="text-xs text-muted-foreground">{hb.beats.length}</span>
						<span class="flex-1"></span>
						{#if selectedBeat}<button type="button" class="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground" onclick={() => (selectedBeat = null)}>Show all</button>{/if}
					</div>
					{#if !hb.beats.length}
						<p class="px-3 py-6 text-center text-xs text-muted-foreground">No beats yet.</p>
					{:else}
						<ul class="max-h-[70dvh] divide-y divide-border overflow-auto">
							{#each hb.beats as b (b.id)}
								<li>
									<button type="button" class={cn('flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-accent/40', selectedBeat === b.id && 'bg-accent/60')} onclick={() => (selectedBeat = selectedBeat === b.id ? null : b.id)}>
										<span class="flex items-center gap-2">
											<Badge variant={beatTone(b.status)}>{BEAT_LABEL[b.status]}</Badge>
											<span class="text-[11px] text-muted-foreground">{formatTime(b.at)}{b.trigger && b.trigger !== 'schedule' ? ` · ${b.trigger}` : ''}</span>
										</span>
										<span class="text-xs text-muted-foreground">{beatDetail(b)}</span>
										{#each b.items as item (item.fingerprint)}
											<span class="border-l border-border pl-2 text-xs">
												<span class="font-medium">{item.urgent ? 'Urgent: ' : ''}{item.title}</span>
												{#if decisionLine(item)}<span class="block text-[11px] text-muted-foreground">{decisionLine(item)}</span>{/if}
											</span>
										{/each}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</Surface>

				<Surface class="flex min-w-0 flex-col gap-3 p-4">
					<div class="flex items-center gap-2">
						<span class="text-sm font-medium">Session</span>
						<code class="font-mono text-xs text-muted-foreground">{sessionId}</code>
						<span class="flex-1"></span>
						<span class="text-xs text-muted-foreground">{selectedBeat ? 'This beat only' : 'Newest at the bottom'}</span>
					</div>
					{#if hasOlder && !selectedBeat}
						<Button size="sm" variant="ghost" class="self-center" onclick={() => void older()} disabled={loading}>Load older</Button>
					{/if}
					{#if !shown.length}
						<p class="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">{messages.length ? 'No messages in this beat (older ones may need "Load older" first).' : 'The heartbeat has not run yet.'}</p>
					{:else}
						<div class="flex min-w-0 flex-col gap-4">
							{#each shown as m, i (m.id)}
								{@const t = timeOf(m)}
								{#if t !== undefined}<span class="text-[11px] text-muted-foreground">{formatTime(t)}</span>{/if}
								<MessageView message={m} agent={agent ? { id: agent.id, name: agent.name, color: agent.color } : undefined} showHeader={i === 0 || shown[i - 1]?.role !== m.role} live={false} instruction={m.role === 'user'} />
							{/each}
						</div>
					{/if}
				</Surface>
			</div>
		{/if}
	</PageBody>
</div>
