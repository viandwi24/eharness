<script lang="ts">
	import { untrack } from 'svelte';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { eventTime, typeLabel, type EventTypeInfo, type StreamEvent } from '#lib/events/events.js';
	import { DRY_RUN_NOTE, verdictLabel, verdictVariant, type Trigger, type TriggerDryRun } from '#lib/triggers/triggers.js';

	/** Test a trigger against a past event: what it would do, without doing anything. */
	let { open = $bindable(false), trigger, types }: { open?: boolean; trigger: Trigger | null; types: EventTypeInfo[] } = $props();

	let events = $state<StreamEvent[]>([]);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let chosen = $state<string | null>(null);
	let running = $state(false);
	let result = $state<TriggerDryRun | null>(null);
	let runError = $state<string | null>(null);

	$effect(() => {
		if (!open || !trigger) return;
		const t = trigger;
		untrack(() => {
			events = [];
			chosen = null;
			result = null;
			runError = null;
			loadError = null;
			loading = true;
			void api
				.get('/events', { query: { limit: 30, type: t.eventTypes.join(',') } as never })
				.then((r) => (events = r.items))
				.catch((e) => (loadError = e instanceof Error ? e.message : String(e)))
				.finally(() => (loading = false));
		});
	});

	async function run(): Promise<void> {
		if (!trigger || !chosen) return;
		running = true;
		runError = null;
		result = null;
		try {
			result = await api.post('/triggers/{id}/test', { params: { id: trigger.id }, body: { eventId: chosen } });
		} catch (e) {
			runError = e instanceof Error ? e.message : String(e);
		} finally {
			running = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="flex max-h-[90vh] flex-col gap-3 sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Test {trigger?.name ?? 'trigger'}</Dialog.Title>
			<Dialog.Description>Pick a past event. The trigger tells what it would do with it. Nothing is sent, woken or run.</Dialog.Description>
		</Dialog.Header>

		<div class="max-h-56 min-h-24 overflow-y-auto rounded-md border border-border" role="radiogroup" aria-label="Past events">
			{#if loading}
				<div class="flex flex-col gap-1 p-2">{#each [0, 1, 2] as n (n)}<Skeleton class="h-8 w-full" />{/each}</div>
			{:else if loadError}
				<p class="p-3 text-xs text-destructive-text" role="alert">{loadError}</p>
			{:else if events.length === 0}
				<p class="p-3 text-xs text-muted-foreground">No past event of the types this trigger listens to. There is nothing to test against yet.</p>
			{:else}
				{#each events as e (e.id)}
					<button
						type="button"
						role="radio"
						aria-checked={chosen === e.id}
						class="flex w-full flex-col gap-0.5 border-b border-border px-3 py-1.5 text-left last:border-b-0 hover:bg-muted/50 {chosen === e.id ? 'bg-accent' : ''}"
						onclick={() => {
							chosen = e.id;
							result = null;
							runError = null;
						}}
					>
						<span class="flex items-center gap-2 text-xs text-muted-foreground"><span class="font-mono">{eventTime(e.at)}</span><span>{typeLabel(types, e.type)}</span></span>
						<span class="truncate text-[13px]">{e.summary}</span>
					</button>
				{/each}
			{/if}
		</div>

		<div class="flex items-center gap-2">
			<Button size="sm" disabled={!chosen || running} onclick={() => void run()}>{#if running}<Spinner />{/if}Run the test</Button>
			{#if runError}<span class="text-xs text-destructive-text" role="alert">{runError}</span>{/if}
		</div>

		{#if result}
			<div class="flex min-h-0 flex-col gap-2 overflow-y-auto rounded-md border border-border p-3" data-testid="dry-run">
				<div class="flex flex-wrap items-center gap-2">
					<Badge variant={verdictVariant(result.verdict)}>{verdictLabel(result.verdict, result.reason)}</Badge>
					<span class="text-[13px]">{result.summary}</span>
				</div>
				{#if result.problems.length > 0}
					<ul class="flex flex-col gap-1 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-text" role="alert">
						{#each result.problems as p (p)}<li>{p}</li>{/each}
					</ul>
				{/if}
				{#if result.notes.length > 0}
					<ul class="list-disc pl-5 text-xs text-muted-foreground">{#each result.notes as n (n)}<li>{n}</li>{/each}</ul>
				{/if}
				{#if result.wouldDo.length > 0}
					<pre class="overflow-x-auto rounded-md bg-muted/50 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">{result.wouldDo.join('\n')}</pre>
				{/if}
				<p class="text-xs font-medium">{DRY_RUN_NOTE}</p>
			</div>
		{/if}

		<Dialog.Footer><Button variant="ghost" onclick={() => (open = false)}>Close</Button></Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
