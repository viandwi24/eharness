<script lang="ts">
	// Test a saved version without side effects: an example message (simple), a recorded chat event,
	// a JSON event, or no event. The answer leads with a plain verdict, then the trace.
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwise';
	import PlayIcon from 'phosphor-svelte/lib/Play';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircle';
	import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircle';
	import InfoIcon from 'phosphor-svelte/lib/Info';
	import { api } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { formatTime } from '#lib/format.js';
	import type { Lookups } from '#lib/scripts/lookups.svelte.js';
	import { type DryRunResult, eventLine, SAMPLE_EVENT, toJsonText } from '#lib/scripts/scripts.js';
	import { verdictOf } from '#lib/scripts/verdict.js';
	import { cn } from '#lib/utils.js';
	import MonacoEditor from './MonacoEditor.svelte';
	import RunTrace from './RunTrace.svelte';

	type StreamEvent = components['schemas']['StreamEvent'];

	let {
		script,
		latest,
		versions,
		unsaved = false,
		lookups,
		suggestedChat = '',
		suggestedText = '',
		sample,
		onDone
	}: {
		script: string;
		latest: number;
		versions: number[];
		unsaved?: boolean;
		lookups: Lookups;
		/** A chat and words from the manifest, to prefill the example message. */
		suggestedChat?: string;
		suggestedText?: string;
		/** A sample event for scripts that do not start on chat messages (opens the JSON tab). */
		sample?: unknown;
		onDone?: (r: DryRunResult) => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	let version = $state(String(latest));
	let source = $state<'example' | 'recorded' | 'json' | 'none'>('example');

	// example message
	let exConnection = $state('');
	let exChat = $state('');
	let exFrom = $state('Ana');
	let exRole = $state('member');
	let exText = $state('');
	let prefilled = false;
	$effect(() => {
		if (prefilled) return;
		if (suggestedChat || suggestedText) {
			exChat = exChat || suggestedChat;
			exText = exText || (suggestedText ? `${suggestedText} everyone` : 'hello');
			prefilled = true;
		} else if (!exText) exText = 'hello';
	});
	$effect(() => {
		if (!exConnection && lookups.state.connections.length) exConnection = lookups.state.connections[0]!.value;
	});

	// recorded events
	let events = $state<StreamEvent[] | null>(null);
	let next = $state<string | null>(null);
	let eventsError = $state('');
	let eventsLoading = $state(false);
	let eventId = $state('');
	let text = $state('');

	let json = $state(toJsonText(SAMPLE_EVENT));
	let sampled = false;
	$effect(() => {
		if (sampled || sample === undefined) return;
		sampled = true;
		json = toJsonText(sample);
		source = 'json';
	});
	let running = $state(false);
	let error = $state('');
	let result = $state<DryRunResult | null>(null);
	const verdict = $derived(result ? verdictOf(result) : null);

	// svelte-ignore state_referenced_locally
	let seenLatest = latest;
	$effect(() => {
		if (latest !== seenLatest) {
			if (version === String(seenLatest)) version = String(latest);
			seenLatest = latest;
		}
	});

	async function loadEvents(more = false): Promise<void> {
		if (eventsLoading) return;
		eventsLoading = true;
		eventsError = '';
		try {
			const r = await api.get('/events', { query: { source: 'channel', type: 'message.created,reaction.added,member.joined,member.join_requested', limit: 50, ...(more && next ? { cursor: next } : {}) } });
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

	export async function run(): Promise<void> {
		error = '';
		let body: components['schemas']['ScriptDryRun'] = { version: Number(version) };
		if (source === 'example') {
			const chat = exChat.trim() || 'Test chat';
			body = {
				...body,
				event: {
					type: 'message.created',
					connectionId: exConnection,
					eventId: 'example',
					at: Date.now(),
					chat: { nodeId: 'example', nativeId: chat, title: chat, rootNativeId: chat, rootTitle: chat },
					actor: { id: 'example', name: exFrom.trim() || 'Someone', role: exRole },
					text: exText,
					messageId: 'example'
				}
			};
		} else if (source === 'recorded') {
			if (!eventId) {
				error = 'Pick a chat event first.';
				return;
			}
			body = { ...body, eventId, ...(text ? { text } : {}) };
		} else if (source === 'json') {
			try {
				body = { ...body, event: JSON.parse(json) };
			} catch (e) {
				error = `The event is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
				return;
			}
		}
		running = true;
		try {
			result = await api.post('/scripts/{script}/dry-run', { params: { script }, body });
			onDone?.(result);
		} catch (e) {
			error = e instanceof Error ? e.message : 'The test failed';
		} finally {
			running = false;
		}
	}

	const tab = (on: boolean): string => cn('rounded-md px-2.5 py-1 text-xs transition-colors', on ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground');
</script>

<div class="flex min-w-0 flex-col gap-4">
	<div class="flex items-center gap-2">
		<h3 class="text-sm font-semibold">Test</h3>
		<span class="text-xs text-muted-foreground">Runs the real code; sends and writes nothing.</span>
		<span class="flex-1"></span>
		<NativeSelect bind:value={version} class="h-8 w-28 text-xs" aria-label="Version to test">
			{#each versions as v (v)}<NativeSelectOption value={String(v)}>v{v}{v === latest ? ' (latest)' : ''}</NativeSelectOption>{/each}
		</NativeSelect>
	</div>

	{#if unsaved}
		<p class="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-text"><InfoIcon class="mt-0.5 size-3.5 shrink-0" /> You have unsaved changes. The test runs the saved v{version}; save first to test your edits.</p>
	{/if}

	<div class="inline-flex w-fit flex-wrap gap-0.5 rounded-lg bg-muted p-0.5" role="tablist" aria-label="Test event">
		<button type="button" role="tab" aria-selected={source === 'example'} class={tab(source === 'example')} onclick={() => (source = 'example')}>Example message</button>
		<button type="button" role="tab" aria-selected={source === 'recorded'} class={tab(source === 'recorded')} onclick={() => (source = 'recorded')}>Real event</button>
		<button type="button" role="tab" aria-selected={source === 'json'} class={tab(source === 'json')} onclick={() => (source = 'json')}>JSON</button>
		<button type="button" role="tab" aria-selected={source === 'none'} class={tab(source === 'none')} onclick={() => (source = 'none')}>No event</button>
	</div>

	{#if source === 'example'}
		<div class="grid gap-3 sm:grid-cols-2">
			<Field.Field>
				<Field.Label for="ex-chat">Chat</Field.Label>
				<Input id="ex-chat" bind:value={exChat} placeholder="Chat title" autocomplete="off" />
			</Field.Field>
			<Field.Field>
				<Field.Label for="ex-conn">Connection</Field.Label>
				<NativeSelect id="ex-conn" bind:value={exConnection}>
					<NativeSelectOption value="">(none)</NativeSelectOption>
					{#each lookups.state.connections as c (c.value)}<NativeSelectOption value={c.value}>{c.label}</NativeSelectOption>{/each}
				</NativeSelect>
			</Field.Field>
			<Field.Field>
				<Field.Label for="ex-from">From</Field.Label>
				<Input id="ex-from" bind:value={exFrom} autocomplete="off" />
			</Field.Field>
			<Field.Field>
				<Field.Label for="ex-role">Their role</Field.Label>
				<NativeSelect id="ex-role" bind:value={exRole}>
					{#each ['owner', 'admin', 'member', 'guest'] as r (r)}<NativeSelectOption value={r}>{r}</NativeSelectOption>{/each}
				</NativeSelect>
			</Field.Field>
			<Field.Field class="sm:col-span-2">
				<Field.Label for="ex-text">Message</Field.Label>
				<Input id="ex-text" bind:value={exText} autocomplete="off" onkeydown={(e) => e.key === 'Enter' && void run()} />
			</Field.Field>
		</div>
	{:else if source === 'recorded'}
		<div class="flex flex-col gap-2">
			<div class="flex items-center justify-between gap-2">
				<span class="text-xs text-muted-foreground">Recent events of your chats</span>
				<Button variant="ghost" size="icon-sm" aria-label="Reload the events" title="Reload" disabled={eventsLoading} onclick={() => void loadEvents()}>
					{#if eventsLoading}<Spinner class="size-4" />{:else}<ArrowClockwiseIcon class="size-4" />{/if}
				</Button>
			</div>
			{#if eventsError}
				<p class="text-sm text-destructive-text" role="alert">{eventsError}</p>
			{:else if events && !events.length}
				<p class="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">No chat events recorded yet. Use an example message.</p>
			{:else if events}
				<div class="max-h-56 overflow-auto rounded-md border border-border" role="listbox" aria-label="Chat events">
					{#each events as e (e.id)}
						<button
							type="button"
							role="option"
							aria-selected={eventId === e.id}
							class={cn('flex w-full items-baseline gap-2 border-b border-border px-2.5 py-1.5 text-left text-xs last:border-b-0 hover:bg-accent/50', eventId === e.id && 'bg-[color-mix(in_srgb,var(--brand)_12%,var(--card))]')}
							onclick={() => (eventId = e.id)}
						>
							<span class="min-w-0 flex-1 truncate" title={eventLine(e)}>{eventLine(e)}</span>
							<span class="shrink-0 text-muted-foreground">{formatTime(e.at)}</span>
						</button>
					{/each}
					{#if next}<button type="button" class="w-full px-2.5 py-1.5 text-center text-xs text-muted-foreground hover:bg-accent/50" disabled={eventsLoading} onclick={() => void loadEvents(true)}>Load more</button>{/if}
				</div>
			{/if}
			<Field.Field>
				<Field.Label for="rec-text">What the message said</Field.Label>
				<Input id="rec-text" bind:value={text} placeholder="Message text is never stored: type it" autocomplete="off" />
			</Field.Field>
		</div>
	{:else if source === 'json'}
		<MonacoEditor path="file:///test-event.json" language="json" bind:value={json} label="Test event JSON" class="h-56" />
	{:else}
		<p class="text-xs text-muted-foreground">Runs with an empty event, like Run now or a schedule.</p>
	{/if}

	{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
	<Button class="w-fit" onclick={() => void run()} disabled={running}>
		{#if running}<Spinner class="size-4" />{:else}<PlayIcon class="size-4" />{/if} Test v{version}
	</Button>

	{#if result && verdict}
		<div
			class={cn(
				'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm',
				verdict.tone === 'ok' && 'border-[color-mix(in_srgb,var(--success)_35%,var(--card))] bg-success-soft text-success-text',
				verdict.tone === 'warn' && 'border-[color-mix(in_srgb,var(--warning)_35%,var(--card))] bg-warning-soft text-warning-text',
				verdict.tone === 'bad' && 'border-[color-mix(in_srgb,var(--destructive)_35%,var(--card))] bg-destructive-soft text-destructive-text'
			)}
			role="status"
		>
			{#if verdict.tone === 'ok'}<CheckCircleIcon class="mt-0.5 size-4 shrink-0" weight="fill" />{:else}<WarningCircleIcon class="mt-0.5 size-4 shrink-0" weight="fill" />{/if}
			<div class="flex flex-col gap-0.5">
				<span class="font-medium">{verdict.title}</span>
				{#each verdict.lines as l (l)}<span class="text-xs opacity-90">{l}</span>{/each}
			</div>
		</div>
		<details class="group rounded-lg border border-border">
			<summary class="cursor-pointer px-3 py-2 text-xs text-muted-foreground select-none hover:text-foreground">Full trace</summary>
			<div class="border-t border-border p-3"><RunTrace run={result.run} triggers={result.triggers} /></div>
		</details>
	{:else if !result}
		<p class="text-xs text-muted-foreground">The answer shows here: whether the trigger would start it, what it would send or write, its logs and errors.</p>
	{/if}
</div>
