<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeft';
	import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRight';
	import XIcon from 'phosphor-svelte/lib/X';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { actorHandle, actorName, actorRole, chatText, eventTime, factRows, sourceText, typeLabel, type EventTypeInfo, type StreamEvent } from '#lib/events/events.js';

	/** One event in full: what happened, where, who did it, its facts, and a way to listen for more like it. */
	let {
		event,
		types,
		onPrev,
		onNext,
		onClose
	}: { event: StreamEvent | null; types: EventTypeInfo[]; onPrev?: (() => void) | undefined; onNext?: (() => void) | undefined; onClose: () => void } = $props();

	const info = $derived(event ? types.find((t) => t.type === event.type) : undefined);
	const facts = $derived(event ? factRows(event) : []);
	const name = $derived(event ? actorName(event) : '');
	const handle = $derived(event ? actorHandle(event) : '');
	const role = $derived(event ? actorRole(event) : '');

	function onKeydown(e: KeyboardEvent): void {
		if (!event || e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target as HTMLElement | null;
		if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
		if (e.key === 'ArrowLeft' && onPrev) {
			e.preventDefault();
			onPrev();
		} else if (e.key === 'ArrowRight' && onNext) {
			e.preventDefault();
			onNext();
		}
	}

</script>

<svelte:window onkeydowncapture={onKeydown} />

<Sheet.Root open={event !== null} onOpenChange={(o) => !o && onClose()}>
	<Sheet.Content side="right" showCloseButton={false} class="flex flex-col gap-0 p-0" style="width: min(40rem, 100vw); max-width: none">
		<header class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
			<Sheet.Title class="mr-auto text-sm font-medium">Event details</Sheet.Title>
			<Button variant="ghost" size="icon-sm" aria-label="Newer (←)" title="Newer (←)" disabled={!onPrev} onclick={() => onPrev?.()}><ArrowLeftIcon class="size-4" /></Button>
			<Button variant="ghost" size="icon-sm" aria-label="Older (→)" title="Older (→)" disabled={!onNext} onclick={() => onNext?.()}><ArrowRightIcon class="size-4" /></Button>
			<Button variant="ghost" size="icon-sm" aria-label="Close" onclick={onClose}><XIcon class="size-4" /></Button>
		</header>

		<div class="min-h-0 flex-1 overflow-y-auto p-4">
			{#if event}
				<div class="flex flex-col gap-5">
					<div class="flex flex-wrap items-center gap-1.5">
						<Badge variant="secondary">{typeLabel(types, event.type)}</Badge>
						<Badge variant="outline">{event.source === 'app' ? 'App' : 'Chat'}</Badge>
						{#if event.agentCaused}<Badge variant="warning">Caused by the agent</Badge>{/if}
					</div>

					<p class="text-sm break-words">{event.summary}</p>

					<div class="flex flex-wrap gap-2">
						{#if event.link}<Button size="sm" variant="outline" href={event.link}>Open</Button>{/if}
					</div>

					<section>
						<h3 class="mb-2 text-xs font-semibold text-muted-foreground">Overview</h3>
						<dl class="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 text-[13px]">
							<dt class="text-muted-foreground">Time</dt>
							<dd class="font-mono text-xs">{eventTime(event.at)}</dd>
							<dt class="text-muted-foreground">Source</dt>
							<dd class="min-w-0 break-words">{sourceText(event)}</dd>
							<dt class="text-muted-foreground">Type</dt>
							<dd class="min-w-0 break-words">{typeLabel(types, event.type)} <span class="font-mono text-xs text-muted-foreground">({event.type})</span></dd>
							{#if event.chat}
								<dt class="text-muted-foreground">Chat</dt>
								<dd class="min-w-0 break-words">{chatText(event)}</dd>
							{/if}
							{#if event.actor}
								<dt class="text-muted-foreground">Actor</dt>
								<dd class="min-w-0 break-words">
									{name || '—'}{#if handle}<span class="text-muted-foreground"> · {handle}</span>{/if}{#if role}<span class="text-muted-foreground"> · {role}</span>{/if}
									{#if event.actor.id}<span class="ml-1 font-mono text-xs text-muted-foreground">{event.actor.id}</span>{/if}
								</dd>
							{/if}
							{#if event.agentId}
								<dt class="text-muted-foreground">Agent</dt>
								<dd class="min-w-0"><a href="/a/{event.agentId}" class="underline underline-offset-2 hover:text-foreground">Open agent</a></dd>
							{/if}
							{#if event.sessionId}
								<dt class="text-muted-foreground">Session</dt>
								<dd class="min-w-0 truncate font-mono text-xs text-muted-foreground" title={event.sessionId}>{event.sessionId}</dd>
							{/if}
							<dt class="text-muted-foreground">Event id</dt>
							<dd class="font-mono text-xs break-all">{event.id}</dd>
						</dl>
					</section>

					<section>
						<h3 class="mb-2 text-xs font-semibold text-muted-foreground">Facts</h3>
						{#if facts.length > 0}
							<Surface class="rounded-lg">
								<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 px-3 py-2.5 text-[13px]">
									{#each facts as f (f.key)}
										<dt class="font-mono text-xs text-muted-foreground">{f.key}</dt>
										<dd class="min-w-0 font-mono text-xs break-all">{f.value}</dd>
									{/each}
								</dl>
							</Surface>
							<p class="mt-1.5 text-xs text-muted-foreground">Message text is never part of an event.</p>
						{:else}
							<p class="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">This event has no extra facts.</p>
						{/if}
					</section>

					{#if info?.note}
						<section>
							<h3 class="mb-2 text-xs font-semibold text-muted-foreground">What this channel delivers</h3>
							<p class="text-[13px] break-words">{info.note}</p>
						</section>
					{/if}
				</div>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
