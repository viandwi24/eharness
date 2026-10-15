<script lang="ts">
	import { untrack } from 'svelte';
	import { api, ApiError, fieldErrors } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { formatTime } from '#lib/format.js';
	import {
		BEAT_LABEL,
		beatDetail,
		beatTone,
		decisionLine,
		filesLink,
		formErrors,
		formOf,
		NO_ORDERS,
		orderWhere,
		orderWho,
		patchOf,
		scheduleSummary,
		timezoneOptions,
		type Heartbeat,
		type HeartbeatForm
	} from '#lib/heartbeat/model.js';
	import { live } from '#lib/stores/live.svelte.js';

	// The monitor of one agent. People tell the agent in chat what to watch (standing orders); they
	// are kept here as readable lines of its memory file HEARTBEAT.md. Below: the file as text, the
	// advanced interval and hours, the last beats and, for the lead, the daily digest.
	let { agentId, isLead = false }: { agentId: string; isLead?: boolean } = $props();

	const CHECKLIST = 'HEARTBEAT.md';

	let hb = $state<Heartbeat | null>(null);
	let loadError = $state('');
	let form = $state<HeartbeatForm | null>(null);
	let errors = $state<Record<string, string>>({});
	let saving = $state(false);
	let running = $state(false);
	let removing = $state<string | null>(null);
	let seq = 0;

	// the file as text
	let checklist = $state('');
	let checklistVersion = $state<string | null>(null);
	let checklistSaved = $state('');
	let savingChecklist = $state(false);

	// the digest
	let digest = $state({ enabled: true, time: '18:00', timezone: '' });
	let digestSaved = $state('');
	const zones = timezoneOptions();

	async function loadChecklist(): Promise<void> {
		try {
			const r = await api.get('/memory/file', { query: { scope: 'agent', agentId, path: CHECKLIST } });
			checklist = checklistSaved = r.content;
			checklistVersion = r.version;
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) {
				checklist = checklistSaved = '';
				checklistVersion = null;
			} else toast.error(e instanceof Error ? e.message : 'Could not load the file');
		}
	}

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/agents/{id}/heartbeat', { params: { id: agentId } });
			if (mine !== seq) return;
			hb = r;
			loadError = '';
			// keep unsaved edits: the form only follows the server while untouched
			if (form === null || untrack(() => !dirty)) form = formOf(r.config);
			digest = { enabled: r.digest.enabled, time: r.digest.time, timezone: r.digest.timezone ?? '' };
			digestSaved = JSON.stringify(digest);
		} catch (e) {
			if (mine === seq) loadError = e instanceof Error ? e.message : 'Could not load the heartbeat';
		}
	}
	$effect(() => {
		void agentId;
		void live.state.revs.heartbeat;
		untrack(() => void load());
	});
	$effect(() => {
		void agentId;
		void live.state.revs.files;
		void live.state.revs.heartbeat;
		// a file edited elsewhere (an agent adding an order, another tab) shows unless it is being edited here
		untrack(() => {
			if (checklist === checklistSaved) void loadChecklist();
		});
	});

	const dirty = $derived(hb !== null && form !== null && Object.keys(patchOf(hb.config, form)).length > 0);

	async function save(): Promise<void> {
		if (!hb || !form) return;
		errors = formErrors(form);
		if (Object.keys(errors).length) return;
		saving = true;
		try {
			hb = await api.patch('/agents/{id}/heartbeat', { params: { id: agentId }, body: patchOf(hb.config, form) });
			form = formOf(hb.config);
			toast.success('Saved');
		} catch (e) {
			errors = fieldErrors(e);
			toast.error(e instanceof Error ? e.message : 'Could not save');
		} finally {
			saving = false;
		}
	}

	async function removeOrder(id: string): Promise<void> {
		removing = id;
		try {
			hb = await api.delete('/agents/{id}/heartbeat/orders/{orderId}', { params: { id: agentId, orderId: id } });
			toast.success('Standing order removed');
			if (checklist === checklistSaved) void loadChecklist();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not remove the order');
		} finally {
			removing = null;
		}
	}

	async function saveChecklist(): Promise<void> {
		savingChecklist = true;
		try {
			const r = await api.put('/memory/file', {
				query: { scope: 'agent', agentId, path: CHECKLIST },
				body: { content: checklist, ifVersion: checklistVersion }
			});
			checklistSaved = checklist;
			checklistVersion = r.version;
			toast.success('Saved');
			void load();
		} catch (e) {
			toast.error(e instanceof ApiError && e.status === 409 ? 'The file changed somewhere else. Reload it and apply your edit again.' : e instanceof Error ? e.message : 'Could not save the file');
		} finally {
			savingChecklist = false;
		}
	}

	async function runNow(): Promise<void> {
		running = true;
		try {
			const r = await api.post('/agents/{id}/heartbeat/run', { params: { id: agentId } });
			if (r.started) toast.success('Beat started');
			else toast.info(`Not run: ${r.reason ?? 'skipped'}`);
			void load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not run a beat');
		} finally {
			running = false;
		}
	}

	async function saveDigest(): Promise<void> {
		try {
			await api.patch('/digest', { body: { enabled: digest.enabled, time: digest.time, timezone: digest.timezone.trim() === '' ? null : digest.timezone.trim() } });
			toast.success('Digest saved');
			void load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save the digest');
		}
	}
	const digestDirty = $derived(JSON.stringify(digest) !== digestSaved);
</script>

<div class="flex flex-col gap-5 text-sm">
	{#if loadError}
		<p class="text-destructive-text" role="alert">{loadError}</p>
	{:else if !hb || !form}
		<div class="flex flex-col gap-2" aria-busy="true" aria-label="Loading the heartbeat">
			{#each [0, 1, 2] as i (i)}<Skeleton class="h-9 w-full rounded-lg" />{/each}
		</div>
	{:else}
		<section class="flex flex-col gap-3">
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0">
					<div class="font-medium">Standing orders</div>
					<p class="text-xs text-muted-foreground">
						Tell the agent in chat what to watch; it keeps the orders here. It looks {scheduleSummary(hb.config, hb.effectiveTimezone)}{hb.trigger?.nextFireAt && hb.config.enabled ? `, next at ${formatTime(hb.trigger.nextFireAt)}` : ''}, and sooner when the chats it watches get new messages. It says nothing unless something needs you.
					</p>
				</div>
				<Button size="sm" variant="outline" disabled={running || !hb.config.enabled} onclick={() => void runNow()}>Run a beat now</Button>
			</div>

			{#if !hb.orders.length}
				<p class="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{NO_ORDERS}</p>
			{:else}
				<ul class="flex flex-col divide-y divide-border rounded-lg border border-border">
					{#each hb.orders as o (o.id)}
						<li class="flex items-start gap-3 px-3 py-2">
							<div class="min-w-0 flex-1">
								<div class="break-words">{o.text}{#if !o.active} <Badge variant="outline">paused</Badge>{/if}</div>
								<div class="text-[11px] text-muted-foreground">
									{orderWho(o)} · {orderWhere(o)} · {formatTime(o.at)}
								</div>
							</div>
							<Button size="sm" variant="ghost" disabled={removing === o.id} onclick={() => void removeOrder(o.id)} aria-label={`Remove: ${o.text}`}>Remove</Button>
						</li>
					{/each}
				</ul>
			{/if}
			{#if hb.watched.length}
				<p class="text-xs text-muted-foreground">
					Watches {hb.watched.length} chat{hb.watched.length === 1 ? '' : 's'} for new messages: {hb.watched.slice(0, 5).map((w) => w.title).join(', ')}{hb.watched.length > 5 ? ', …' : ''}.
				</p>
			{/if}
			<p class="text-xs">
				{#if hb.notes.exists}<a class="underline" href={filesLink(hb.notes.path)}>Today's notes</a>{:else}No notes yet today{/if}
				<code class="ml-1 text-[11px] text-muted-foreground">{hb.notes.path}</code>
			</p>
		</section>

		<details class="rounded-lg border border-border px-3 py-2">
			<summary class="cursor-pointer text-sm font-medium">Edit as text</summary>
			<div class="mt-2 flex flex-col gap-2">
				<code class="text-[11px] text-muted-foreground">{hb.checklist.path}</code>
				<Textarea bind:value={checklist} rows={8} class="font-mono text-xs" placeholder="One standing order or item to check per line." aria-label="HEARTBEAT.md" />
				<p class="text-xs text-muted-foreground">
					Each order is a list item with a small tail in a comment (who asked, where it reports); keep the tail when you edit the words. A line without a tail is an ordinary item the agent looks at; it reports to the digest and the bell only. With only headings or comments the heartbeat does not run and costs nothing.
				</p>
				<div><Button size="sm" variant="outline" disabled={savingChecklist || checklist === checklistSaved} onclick={() => void saveChecklist()}>Save</Button></div>
			</div>
		</details>

		<details class="rounded-lg border border-border px-3 py-2">
			<summary class="cursor-pointer text-sm font-medium">Advanced</summary>
			<div class="mt-2 flex flex-col gap-3">
				<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium">Every (min)</span>
						<Input type="number" min="5" max="1440" bind:value={form.everyMinutes} aria-invalid={!!errors.everyMinutes} />
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium">Active from</span>
						<Input type="time" bind:value={form.activeFrom} aria-invalid={!!errors.activeFrom} />
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium">Until</span>
						<Input type="time" bind:value={form.activeTo} aria-invalid={!!errors.activeTo} />
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium">Timezone</span>
						<Input bind:value={form.timezone} list="heartbeat-zones" placeholder={`Team timezone (${hb.effectiveTimezone})`} aria-invalid={!!errors.timezone} />
					</label>
				</div>
				<datalist id="heartbeat-zones">
					{#each zones as z (z)}<option value={z}></option>{/each}
				</datalist>
				{#each Object.values(errors) as e (e)}<p class="text-xs text-destructive-text">{e}</p>{/each}
				<div><Button size="sm" disabled={!dirty || saving} onclick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button></div>
			</div>
		</details>

		{#if isLead}
			<section class="flex flex-col gap-2">
				<div class="flex items-start justify-between gap-3">
					<div>
						<div class="font-medium">Daily digest</div>
						<p class="text-xs text-muted-foreground">One entry on the Briefing page (and one notification in the bell): what ran, what waits for you, what the heartbeat noticed and what it cost. A quiet day adds nothing.</p>
					</div>
					<Switch bind:checked={digest.enabled} aria-label="Daily digest on" />
				</div>
				<div class="grid grid-cols-2 gap-3">
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium">Time</span>
						<Input type="time" bind:value={digest.time} />
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium">Timezone</span>
						<Input bind:value={digest.timezone} list="heartbeat-zones" placeholder={hb.digest.effectiveTimezone} />
					</label>
				</div>
				<div class="flex items-center gap-3">
					<Button size="sm" variant="outline" disabled={!digestDirty} onclick={() => void saveDigest()}>Save digest</Button>
					<span class="text-xs text-muted-foreground">
						{hb.digest.buffered} item{hb.digest.buffered === 1 ? '' : 's'} waiting{hb.digest.lastSentAt ? ` · last sent ${formatTime(hb.digest.lastSentAt)}` : ''}
					</span>
				</div>
			</section>
		{/if}

		<section class="flex flex-col gap-2">
			<div class="font-medium">Recent beats</div>
			{#if !hb.beats.length}
				<p class="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">No beats yet.</p>
			{:else}
				<ul class="flex flex-col divide-y divide-border rounded-lg border border-border">
					{#each hb.beats.slice(0, 20) as b (b.id)}
						<li class="flex flex-col gap-1 px-3 py-2">
							<div class="flex items-center gap-2">
								<Badge variant={beatTone(b.status)}>{BEAT_LABEL[b.status]}</Badge>
								<span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{beatDetail(b)}</span>
								<span class="shrink-0 text-[11px] text-muted-foreground">{formatTime(b.at)}</span>
							</div>
							{#each b.items as item (item.fingerprint)}
								<div class="ml-1 border-l border-border pl-2 text-xs">
									<span class="font-medium">{item.urgent ? 'Urgent: ' : ''}{item.title}</span>
									{#if item.detail}<span class="text-muted-foreground"> {item.detail}</span>{/if}
									{#if decisionLine(item)}<div class="text-[11px] text-muted-foreground">{decisionLine(item)}</div>{/if}
								</div>
							{/each}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</div>
