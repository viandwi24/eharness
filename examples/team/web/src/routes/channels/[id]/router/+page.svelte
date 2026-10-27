<script lang="ts">
	import ArrowsSplitIcon from 'phosphor-svelte/lib/ArrowsSplit';
	import { api } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import ChannelHeader from '#lib/components/app/channels/ChannelHeader.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { useConnection } from '#lib/channels/connection.svelte.js';
	import { type ChannelChat, channelHref } from '#lib/channels/model.js';

	// A router agent reads one chat as a feed and shares its posts out to other chats (the Signal
	// Router template: signals and their follow-ups, a table of trade ideas, trial mode first).
	type Chat = ChannelChat;
	type Result = components['schemas']['SignalRouterResult'];

	const cs = useConnection();
	const id = cs.id();

	let chats = $state<Chat[] | null>(null);
	let error = $state('');
	let source = $state('');
	let targets = $state<string[]>([]);
	let name = $state('Signal Router');
	let trial = $state(true);
	let rules = $state('');
	let busy = $state(false);
	let done = $state<Result | null>(null);

	const postable = $derived((chats ?? []).filter((c) => c.postable && c.state === 'active' && c.kind !== 'direct'));
	const feeds = $derived((chats ?? []).filter((c) => c.effective.feed));
	const titleOf = (nodeId: string): string => chats?.find((c) => c.id === nodeId)?.title ?? nodeId;

	async function load(): Promise<void> {
		try {
			chats = (await api.get('/channels/connections/{id}/chats', { params: { id } })).items;
			error = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load the chats';
		}
	}
	$effect(() => {
		void id;
		void load();
	});

	const toggle = (nodeId: string, on: boolean): void => {
		targets = on ? [...targets, nodeId] : targets.filter((t) => t !== nodeId);
	};

	async function create(): Promise<void> {
		if (!source || targets.length === 0) return;
		busy = true;
		try {
			done = await api.post('/channels/connections/{id}/signal-router', {
				params: { id },
				body: { source, targets, name: name.trim() || undefined, trial, ...(rules.trim() ? { rules: rules.trim() } : {}) }
			});
			toast.success(trial ? 'Router set up in trial mode' : 'Router set up');
			await load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not set up the router');
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<ChannelHeader section="router" description="An agent reads one chat as a feed and shares its posts out to other chats." />
	<PageBody size="wide" class="gap-6">
		{#if error}
			<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Retry</button></p>
		{:else if chats === null}
			<div class="flex flex-col gap-2">{#each [0, 1, 2] as i (i)}<Skeleton class="h-10 w-full" />{/each}</div>
		{:else}
			{#if feeds.length}
				<section class="flex flex-col gap-2" aria-labelledby="feeds">
					<h3 id="feeds" class="text-sm font-semibold">Feeds of this connection</h3>
					<ul class="divide-y divide-border rounded-lg border border-border bg-card text-sm">
						{#each feeds as f (f.id)}
							<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
								<ArrowsSplitIcon class="size-4 text-muted-foreground" />
								<span class="font-medium">{f.title}</span>
								{#if f.effective.copyTrial}<Badge variant="secondary">trial: nothing is sent</Badge>{:else}<Badge>live</Badge>{/if}
								<span class="flex-1"></span>
								<a class="text-xs underline underline-offset-4" href={`/agents/${f.effective.agentId}`}>The agent and its instructions</a>
								<a class="text-xs underline underline-offset-4" href={`${channelHref(id, 'chats')}/${f.id}`}>Chat settings (trial / live)</a>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			<section class="flex max-w-2xl flex-col gap-4" aria-labelledby="new-router">
				<div class="flex flex-col gap-1">
					<h3 id="new-router" class="text-sm font-semibold">Set up a Signal Router</h3>
					<p class="text-xs text-muted-foreground">
						The agent reads every post of the source chat. Signals go out to the target chats in turn (the chat with the fewest ideas today first); replies, "TP all", "cut loss" and screenshots follow their signal; reports, greetings and promos stay. Edits and deletions of the source reach the copies on their own. It keeps a table of trade ideas. In trial mode it decides and records but sends nothing.
					</p>
				</div>

				<label class="flex flex-col gap-1.5">
					<span class="text-xs font-medium">Source chat (where the analyst posts)</span>
					<NativeSelect bind:value={source} aria-label="Source chat" onchange={() => (targets = targets.filter((t) => t !== source))}>
						<NativeSelectOption value="">Pick a chat…</NativeSelectOption>
						{#each postable as c (c.id)}<NativeSelectOption value={c.id}>{c.title}{c.chatKind === 'channel' ? ' (channel)' : ''}</NativeSelectOption>{/each}
					</NativeSelect>
				</label>

				<fieldset class="flex flex-col gap-1.5">
					<legend class="mb-1 text-xs font-medium">Target chats (signals are shared out to these)</legend>
					{#each postable.filter((c) => c.id !== source) as c (c.id)}
						<label class="flex items-center gap-2 text-sm">
							<Checkbox checked={targets.includes(c.id)} onCheckedChange={(v) => toggle(c.id, v === true)} aria-label={c.title} />
							<span>{c.title}</span>
							{#if !c.effective.allowed}<span class="text-xs text-muted-foreground">(will be allowed)</span>{/if}
							{#if c.canPost === false}<span class="text-xs text-warning-text">(the connection cannot post here)</span>{/if}
						</label>
					{:else}
						<p class="text-xs text-muted-foreground">No other chat yet: add the connection to the target chats (as an admin of a channel) first.</p>
					{/each}
				</fieldset>

				<label class="flex flex-col gap-1.5">
					<span class="text-xs font-medium">Agent name</span>
					<Input bind:value={name} class="max-w-xs" autocomplete="off" />
				</label>

				<label class="flex flex-col gap-1.5">
					<span class="text-xs font-medium">More rules <span class="font-normal text-muted-foreground">(optional, added to the instructions)</span></span>
					<Textarea bind:value={rules} rows={3} maxlength={4000} placeholder={'e.g. "Posts with #promo are marketing: do not copy them." or "Gold only: skip other pairs."'} />
				</label>

				<label class="flex items-start gap-3">
					<Switch bind:checked={trial} size="sm" class="mt-0.5" />
					<span class="flex flex-col gap-0.5">
						<span class="text-xs font-medium">Start in trial mode (recommended)</span>
						<span class="text-xs text-muted-foreground">Decisions are recorded in the table and in the copy records; nothing is sent until you switch the source chat to live in its chat settings.</span>
					</span>
				</label>

				<div class="flex items-center gap-3">
					<Button onclick={() => void create()} disabled={busy || !source || targets.length === 0}>{#if busy}<Spinner />{/if}Set up the router</Button>
					{#if !source || targets.length === 0}<span class="text-xs text-muted-foreground">Pick a source and at least one target.</span>{/if}
				</div>

				{#if done}
					<div class="flex flex-col gap-1 rounded-lg border border-border bg-card p-3 text-sm" role="status">
						<span class="font-medium">{done.agent.name} reads “{done.source.title}”{done.trial ? ' (trial mode)' : ''}.</span>
						<span class="text-xs text-muted-foreground">Targets: {done.targets.map((t) => t.title).join(', ')} · table <a class="underline underline-offset-4" href={`/tables/${done.table}`}>{done.table}</a> · <a class="underline underline-offset-4" href={`/agents/${done.agent.id}`}>edit its instructions</a></span>
						<span class="text-xs text-muted-foreground">Its notes per message are in its chat session for {titleOf(done.source.id)} (Inbox), the decisions in the table.</span>
					</div>
				{/if}
			</section>
		{/if}
	</PageBody>
</div>
