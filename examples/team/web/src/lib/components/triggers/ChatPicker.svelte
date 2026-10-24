<script lang="ts">
	import XIcon from 'phosphor-svelte/lib/X';
	import { untrack } from 'svelte';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { KIND_LABEL, type ChannelChat } from '#lib/channels/model.js';

	type Row = { id: string; title: string; connectionId: string; connection: string; kind: string; topic: boolean };

	/** A searchable multi-select of the chats of some connections (all of them when none is chosen). Stores internal node ids. */
	let {
		connections,
		connectionIds,
		selected = $bindable([]),
		names = $bindable({})
	}: {
		connections: { id: string; label: string }[];
		connectionIds: string[];
		selected?: string[];
		/** Titles of the chats seen so far, by id (the form shows a chosen chat by name). */
		names?: Record<string, string>;
	} = $props();

	let rows = $state<Row[]>([]);
	let loading = $state(false);
	let failed = $state<string | null>(null);
	let q = $state('');
	let seq = 0;

	const scope = $derived(connectionIds.length > 0 ? connections.filter((c) => connectionIds.includes(c.id)) : connections);
	const scopeKey = $derived(scope.map((c) => c.id).join(','));

	$effect(() => {
		void scopeKey;
		untrack(() => void load(scope));
	});

	async function load(list: { id: string; label: string }[]): Promise<void> {
		const mine = ++seq;
		loading = true;
		failed = null;
		const out: Row[] = [];
		let firstError: string | null = null;
		await Promise.all(
			list.map(async (c) => {
				try {
					const res = await api.get('/channels/connections/{id}/chats', { params: { id: c.id } });
					for (const n of res.items as ChannelChat[]) out.push({ id: n.id, title: n.title, connectionId: c.id, connection: c.label, kind: n.kind === 'thread' ? 'Topic' : (KIND_LABEL[n.chatKind] ?? n.chatKind), topic: n.kind === 'thread' });
				} catch (e) {
					firstError ??= e instanceof Error ? e.message : String(e);
				}
			})
		);
		if (mine !== seq) return;
		rows = out.sort((a, b) => a.title.localeCompare(b.title));
		failed = firstError;
		names = { ...names, ...Object.fromEntries(out.map((r) => [r.id, r.title])) };
		loading = false;
	}

	const shown = $derived.by(() => {
		const t = q.trim().toLowerCase();
		return (t ? rows.filter((r) => r.title.toLowerCase().includes(t) || r.connection.toLowerCase().includes(t)) : rows).slice(0, 200);
	});

	function toggle(id: string): void {
		selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
	}
	const nameOf = (id: string): string => names[id] ?? rows.find((r) => r.id === id)?.title ?? id;
</script>

<div class="flex flex-col gap-2">
	{#if selected.length > 0}
		<div class="flex flex-wrap gap-1.5">
			{#each selected as id (id)}
				<Badge variant="secondary" class="gap-1 pr-1">
					<span class="max-w-48 truncate" title={id}>{nameOf(id)}</span>
					<button type="button" class="rounded-sm p-0.5 hover:bg-accent" aria-label="Remove chat {nameOf(id)}" onclick={() => toggle(id)}><XIcon class="size-3" /></button>
				</Badge>
			{/each}
		</div>
	{/if}
	<Input bind:value={q} placeholder="Search chats" aria-label="Search chats" class="h-8 text-[13px]" />
	<div class="max-h-48 overflow-y-auto rounded-md border border-border p-1">
		{#if loading}
			<div class="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground"><Spinner class="size-3.5" />Loading chats</div>
		{:else if shown.length === 0}
			<p class="px-2 py-3 text-xs text-muted-foreground">{failed ?? (rows.length === 0 ? 'No chats found yet. Chats appear once a connection has seen them.' : 'No chat matches the search.')}</p>
		{:else}
			{#each shown as r (r.id)}
				<label class="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50">
					<Checkbox checked={selected.includes(r.id)} onCheckedChange={() => toggle(r.id)} aria-label={r.title} />
					<span class="min-w-0 flex-1 truncate text-[13px]">{r.title}</span>
					<span class="shrink-0 text-xs text-muted-foreground">{r.connection} · {r.kind}</span>
				</label>
			{/each}
		{/if}
	</div>
	{#if failed && rows.length > 0}<p class="text-xs text-destructive-text" role="alert">Some chats could not be loaded: {failed}</p>{/if}
</div>
