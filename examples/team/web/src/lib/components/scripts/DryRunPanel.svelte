<script lang="ts">
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwise';
	import PlayIcon from 'phosphor-svelte/lib/Play';
	import { api } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import Surface from '#lib/components/app/Surface.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import * as RadioGroup from '#lib/components/ui/radio-group/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { formatTime } from '#lib/format.js';
	import { type DryRunResult, eventLine, SAMPLE_EVENT, toJsonText } from '#lib/scripts/scripts.js';
	import CodeEditor from './CodeEditor.svelte';
	import RunTrace from './RunTrace.svelte';

	type StreamEvent = components['schemas']['StreamEvent'];

	/** Run a version on a recorded chat event, a synthetic one or none. Sends nothing: side effects become "would …". */
	let { script, latest, versions, onDone }: { script: string; latest: number; versions: number[]; onDone?: () => void } = $props();

	// svelte-ignore state_referenced_locally
	let version = $state(String(latest));
	let source = $state<'recorded' | 'synthetic' | 'manual'>('recorded');
	let events = $state<StreamEvent[] | null>(null);
	let next = $state<string | null>(null);
	let eventsError = $state('');
	let eventsLoading = $state(false);
	let eventId = $state('');
	let text = $state('');
	let synthetic = $state(toJsonText(SAMPLE_EVENT));
	let syntheticError = $state('');
	let running = $state(false);
	let error = $state('');
	let result = $state<DryRunResult | null>(null);

	// a new latest version (saved here or elsewhere) is what a dry run should test by default
	// svelte-ignore state_referenced_locally
	let seenLatest = latest;
	$effect(() => {
		if (latest !== seenLatest) {
			if (version === String(seenLatest)) version = String(latest);
			seenLatest = latest;
		}
	});

	const TYPES = 'message.created,reaction.added';

	async function loadEvents(more = false): Promise<void> {
		if (eventsLoading) return;
		eventsLoading = true;
		eventsError = '';
		try {
			const r = await api.get('/events', { query: { source: 'channel', type: TYPES, limit: 50, ...(more && next ? { cursor: next } : {}) } });
			events = more && events ? [...events, ...r.items] : r.items;
			next = r.next ?? null;
		} catch (e) {
			eventsError = e instanceof Error ? e.message : 'Could not load the chat events';
		} finally {
			eventsLoading = false;
		}
	}

	$effect(() => {
		if (source === 'recorded' && events === null) void loadEvents();
	});

	async function run(): Promise<void> {
		error = '';
		syntheticError = '';
		let body: components['schemas']['ScriptDryRun'] = { version: Number(version) };
		if (source === 'recorded') {
			if (!eventId) {
				error = 'Pick a chat event first.';
				return;
			}
			body = { ...body, eventId, ...(text ? { text } : {}) };
		} else if (source === 'synthetic') {
			try {
				body = { ...body, event: JSON.parse(synthetic) };
			} catch (e) {
				syntheticError = `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
				return;
			}
		}
		running = true;
		try {
			result = await api.post('/scripts/{script}/dry-run', { params: { script }, body });
			onDone?.();
		} catch (e) {
			error = e instanceof Error ? e.message : 'The dry run failed';
		} finally {
			running = false;
		}
	}
</script>

<div class="grid gap-4 lg:grid-cols-2">
	<Surface class="flex min-w-0 flex-col gap-4 p-4">
		<div class="flex flex-wrap items-end gap-3">
			<Field.Field class="w-36">
				<Field.Label for="dry-version">Version</Field.Label>
				<NativeSelect id="dry-version" bind:value={version}>
					{#each versions as v (v)}<NativeSelectOption value={String(v)}>v{v}{v === latest ? ' (latest)' : ''}</NativeSelectOption>{/each}
				</NativeSelect>
			</Field.Field>
		</div>

		<RadioGroup.Root bind:value={source} class="flex flex-wrap gap-x-5 gap-y-2" aria-label="Event">
			<label class="flex items-center gap-2 text-sm"><RadioGroup.Item value="recorded" /> Recorded chat event</label>
			<label class="flex items-center gap-2 text-sm"><RadioGroup.Item value="synthetic" /> Synthetic event</label>
			<label class="flex items-center gap-2 text-sm"><RadioGroup.Item value="manual" /> No event</label>
		</RadioGroup.Root>

		{#if source === 'recorded'}
			<div class="flex flex-col gap-2">
				<div class="flex items-center justify-between gap-2">
					<span class="text-xs text-muted-foreground">Recent messages and reactions of the chat connections</span>
					<Button variant="ghost" size="icon-sm" aria-label="Reload the events" title="Reload" disabled={eventsLoading} onclick={() => void loadEvents()}>
						{#if eventsLoading}<Spinner class="size-4" />{:else}<ArrowClockwiseIcon class="size-4" />{/if}
					</Button>
				</div>
				{#if eventsError}
					<p class="text-sm text-destructive-text" role="alert">{eventsError}</p>
				{:else if events && !events.length}
					<p class="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">No chat events recorded yet. Use a synthetic event instead.</p>
				{:else if events}
					<div class="max-h-64 overflow-auto rounded-md border border-border" role="listbox" aria-label="Chat events">
						{#each events as e (e.id)}
							<button
								type="button"
								role="option"
								aria-selected={eventId === e.id}
								class="flex w-full items-baseline gap-2 border-b border-border px-2.5 py-1.5 text-left text-xs last:border-b-0 hover:bg-accent/50 {eventId === e.id ? 'bg-[color-mix(in_srgb,var(--brand)_10%,var(--card))]' : ''}"
								onclick={() => (eventId = e.id)}
							>
								<span class="min-w-0 flex-1 truncate" title={eventLine(e)}>{eventLine(e)}</span>
								<span class="shrink-0 text-muted-foreground" title={new Date(e.at).toLocaleString()}>{formatTime(e.at)}</span>
							</button>
						{/each}
						{#if next}
							<button type="button" class="w-full px-2.5 py-1.5 text-center text-xs text-muted-foreground hover:bg-accent/50" disabled={eventsLoading} onclick={() => void loadEvents(true)}>Load more</button>
						{/if}
					</div>
				{/if}
				<Field.Field>
					<Field.Label for="dry-text">Message text</Field.Label>
					<Input id="dry-text" bind:value={text} placeholder="halo everyone" autocomplete="off" />
					<Field.Description>Message text is never stored, so type what the message said.</Field.Description>
				</Field.Field>
			</div>
		{:else if source === 'synthetic'}
			<Field.Field data-invalid={!!syntheticError}>
				<Field.Label for="dry-event">Event (JSON)</Field.Label>
				<CodeEditor id="dry-event" label="Synthetic event" bind:value={synthetic} invalid={!!syntheticError} class="h-56" />
				{#if syntheticError}<Field.Error>{syntheticError}</Field.Error>{:else}<Field.Description>Put the real connection id and chat title to test chat triggers.</Field.Description>{/if}
			</Field.Field>
		{:else}
			<p class="text-xs text-muted-foreground">The script runs with an empty event, as "Run now" or a schedule would start it.</p>
		{/if}

		{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
		<div>
			<Button onclick={() => void run()} disabled={running}>
				{#if running}<Spinner class="size-4" />{:else}<PlayIcon class="size-4" />{/if} Dry run
			</Button>
		</div>
	</Surface>

	<Surface class="min-w-0 p-4">
		{#if result}
			<RunTrace run={result.run} triggers={result.triggers} />
		{:else}
			<p class="text-sm text-muted-foreground">The result shows here. A dry run executes the real code but sends, writes and wakes nothing: those calls show as "would …".</p>
		{/if}
	</Surface>
</div>
