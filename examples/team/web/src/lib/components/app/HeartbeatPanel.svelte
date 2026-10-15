<script lang="ts">
	import { untrack } from 'svelte';
	import { api, ApiError, fieldErrors } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { formatTime } from '#lib/format.js';
	import {
		BEAT_LABEL,
		beatDetail,
		beatTone,
		checklistNotice,
		decisionLine,
		destinationWarning,
		filesLink,
		MODES,
		formErrors,
		formOf,
		patchOf,
		scheduleSummary,
		timezoneOptions,
		type Heartbeat,
		type HeartbeatForm
	} from '#lib/heartbeat/model.js';
	import { live } from '#lib/stores/live.svelte.js';

	// The monitor of one agent: on/off, interval, active hours, its checklist (the memory file
	// HEARTBEAT.md), the last beats and, for the lead, the daily digest.
	let { agentId, isLead = false }: { agentId: string; isLead?: boolean } = $props();

	const CHECKLIST = 'HEARTBEAT.md';

	let hb = $state<Heartbeat | null>(null);
	let loadError = $state('');
	let form = $state<HeartbeatForm | null>(null);
	let errors = $state<Record<string, string>>({});
	let saving = $state(false);
	let running = $state(false);
	let seq = 0;

	// the checklist file
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
			} else toast.error(e instanceof Error ? e.message : 'Could not load the checklist');
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
		// a checklist edited elsewhere (an agent, another tab) shows unless it is being edited here
		untrack(() => {
			if (checklist === checklistSaved) void loadChecklist();
		});
	});

	const notice = $derived(hb === null ? null : checklistNotice(hb.checklist, form?.enabled ?? hb.config.enabled));
	const chosenDestination = $derived(hb?.destinations.find((d) => d.nodeId === form?.reportTo));
	/** The checklist field holds nothing real yet: offer the suggestion (inserted into the field, saved by the owner). */
	const checklistBlank = $derived(checklist.trim() === '' || (checklist === checklistSaved && hb?.checklist.empty === true));
	function insertSuggestion(): void {
		if (hb) checklist = checklistSaved.trim() === '' ? hb.checklist.suggestion : `${checklistSaved.replace(/\s+$/, '')}\n${hb.checklist.suggestion.split('\n').filter((l) => l.startsWith('- ')).join('\n')}\n`;
	}

	const dirty = $derived(hb !== null && form !== null && Object.keys(patchOf(hb.config, form, hb.destinations)).length > 0);

	async function save(createChecklist = false): Promise<void> {
		if (!hb || !form) return;
		errors = formErrors(form);
		if (Object.keys(errors).length) return;
		saving = true;
		try {
			hb = await api.patch('/agents/{id}/heartbeat', {
				params: { id: agentId },
				body: { ...patchOf(hb.config, form, hb.destinations), ...(createChecklist ? { createChecklist: true } : {}) }
			});
			form = formOf(hb.config);
			toast.success(form.enabled ? 'Heartbeat saved' : 'Heartbeat is off');
			if (createChecklist) await loadChecklist();
		} catch (e) {
			errors = fieldErrors(e);
			toast.error(e instanceof Error ? e.message : 'Could not save the heartbeat');
		} finally {
			saving = false;
		}
	}

	async function toggle(on: boolean): Promise<void> {
		if (!form) return;
		form.enabled = on;
		// turning it on for the first time also gives the agent a checklist file to write in
		await save(on && hb !== null && !hb.checklist.exists);
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
			toast.success('Checklist saved');
			void load();
		} catch (e) {
			toast.error(e instanceof ApiError && e.status === 409 ? 'The checklist changed somewhere else. Reload it and apply your edit again.' : e instanceof Error ? e.message : 'Could not save the checklist');
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
					<div class="font-medium">Heartbeat</div>
					<p class="text-xs text-muted-foreground">
						A quiet check-in{hb.trigger?.nextFireAt && form.enabled ? `, next at ${formatTime(hb.trigger.nextFireAt)}` : ''}. It reads what the server found and your checklist,
						and says nothing unless something needs you. {form.enabled ? scheduleSummary(hb.config, hb.effectiveTimezone) : 'Off.'}
					</p>
				</div>
				<Switch checked={form.enabled} onCheckedChange={(v) => void toggle(v)} aria-label="Heartbeat on" disabled={saving} />
			</div>

			{#if notice}
				<p
					class="rounded-lg border px-3 py-2 text-xs {notice.tone === 'warning' ? 'border-[color-mix(in_srgb,var(--warning)_40%,var(--popover))] bg-warning-soft text-warning-text' : 'border-border text-muted-foreground'}"
					role={notice.tone === 'warning' ? 'alert' : undefined}
				>
					{notice.text}
				</p>
			{/if}

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
			<div class="flex items-center gap-2">
				<Button size="sm" disabled={!dirty || saving} onclick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
				<Button size="sm" variant="outline" disabled={running || !hb.config.enabled} onclick={() => void runNow()}>Run a beat now</Button>
			</div>
		</section>

		<section class="flex flex-col gap-3">
			<div>
				<div class="font-medium">Proactive</div>
				<p class="text-xs text-muted-foreground">
					Let it tell a chat when it notices something unusual in the chats it can read, and beat early when they get new messages. Quiet by default: it posts only to the chat below, a few times a day at most, and never repeats itself.
				</p>
			</div>
			<label class="flex flex-col gap-1">
				<span class="text-xs font-medium">Mode</span>
				<NativeSelect bind:value={form.mode} class="w-full" aria-label="Proactivity mode">
					{#each MODES as m (m.value)}<NativeSelectOption value={m.value}>{m.label}</NativeSelectOption>{/each}
				</NativeSelect>
				<span class="text-xs text-muted-foreground">{MODES.find((m) => m.value === form?.mode)?.hint}</span>
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-xs font-medium">Report to (the chat it may speak in; it can be a chat it also watches)</span>
				<NativeSelect bind:value={form.reportTo} class="w-full" aria-label="Report to chat" disabled={!hb.destinations.length}>
					<NativeSelectOption value="">Nowhere (findings go to the digest and the bell)</NativeSelectOption>
					{#each hb.destinations as d (d.nodeId)}
						<NativeSelectOption value={d.nodeId}>{d.label} ({d.platform})</NativeSelectOption>
					{/each}
				</NativeSelect>
				{#if !hb.destinations.length}
					<span class="text-xs text-muted-foreground">This agent has no chat connection with an allowed chat yet. Bind one in Channels first.</span>
				{/if}
				{#if destinationWarning(chosenDestination)}<span class="text-xs text-warning-text">{destinationWarning(chosenDestination)}</span>{/if}
			</label>
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">Max posts a day</span>
					<Input type="number" min="0" max="50" bind:value={form.maxPostsPerDay} disabled={form.reportTo === '' || form.mode !== 'speak'} aria-invalid={!!errors.maxPostsPerDay} />
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">Beat early on activity</span>
					<span class="flex h-9 items-center"><Switch bind:checked={form.wakeOnActivity} aria-label="Beat early when chats are active" /></span>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">At most every (min)</span>
					<Input type="number" min="1" max="1440" bind:value={form.minGapMinutes} disabled={!form.wakeOnActivity} aria-invalid={!!errors.minGapMinutes} />
				</label>
			</div>
			<p class="text-xs text-muted-foreground">
				{#if hb.watched.length}
					Watches {hb.watched.length} chat{hb.watched.length === 1 ? '' : 's'} for new messages: {hb.watched.slice(0, 5).map((w) => w.title).join(', ')}{hb.watched.length > 5 ? ', …' : ''}.
					The chats named in the checklist, or all groups it is allowed in when it names none (never the report chat).
				{:else}
					No chats to watch yet.
				{/if}
				{#if form.reportTo !== '' && form.mode === 'speak'}{hb.postsToday} of {form.maxPostsPerDay} posts used today.{/if}
				{#if form.reportTo !== '' && form.mode !== 'speak'}Choose Speak for it to post there.{/if}
			</p>
			{#if form.mode !== 'off'}
				<p class="text-xs">
					{#if hb.notes.exists}<a class="underline" href={filesLink(hb.notes.path)}>Today's notes</a>{:else}No notes yet today{/if}
					<code class="ml-1 text-[11px] text-muted-foreground">{hb.notes.path}</code>
				</p>
			{/if}
			<div><Button size="sm" disabled={!dirty || saving} onclick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button></div>
		</section>

		<section class="flex flex-col gap-2">
			<div class="flex items-center justify-between gap-2">
				<div class="font-medium">Checklist</div>
				<code class="text-[11px] text-muted-foreground">{hb.checklist.path}</code>
			</div>
			<Textarea bind:value={checklist} rows={6} class="font-mono text-xs" placeholder="One thing to check per line, for example: look at the community chats for a spam wave and tell the internal group." aria-label="Heartbeat checklist" />
			<p class="text-xs text-muted-foreground">
				{#if hb.checklist.empty && checklist === checklistSaved}
					Empty (only headings or comments): the heartbeat does not run and costs nothing.
				{:else}
					The server already watches stuck, failed and waiting work, old decisions, failing programs and routines, connectors that need sign-in and the budget. Add only what is yours.
				{/if}
			</p>
			<div class="flex items-center gap-2">
				<Button size="sm" variant="outline" disabled={savingChecklist || checklist === checklistSaved} onclick={() => void saveChecklist()}>Save checklist</Button>
				{#if checklistBlank}
					<Button size="sm" variant="ghost" onclick={insertSuggestion}>Insert a suggestion</Button>
				{/if}
			</div>
		</section>

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
