<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, untrack } from 'svelte';
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwise';
	import BellRingingIcon from 'phosphor-svelte/lib/BellRinging';
	import LightningIcon from 'phosphor-svelte/lib/Lightning';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircle';
	import { api } from '#lib/api/index.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import Surface from '#lib/components/app/Surface.svelte';
	import TriggerFiresSheet from '#lib/components/triggers/TriggerFiresSheet.svelte';
	import TriggerFormSheet from '#lib/components/triggers/TriggerFormSheet.svelte';
	import TriggerTestDialog from '#lib/components/triggers/TriggerTestDialog.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import type { EventCatalog } from '#lib/events/events.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { formatDateTime, timeAgo } from '#lib/time.js';
	import { actionText, capText, cooldownText, filteredHint, filtersText, formWithPrefill, lastFiredText, listensText, scopeText, type Names, type Trigger, type TriggerForm } from '#lib/triggers/triggers.js';

	let items = $state<Trigger[]>([]);
	let executed = $state(0);
	let cap = $state(0);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let rowError = $state<Record<string, string>>({});
	let catalog = $state<EventCatalog>({ types: [], connections: [] });
	let programs = $state<{ id: string; name: string }[]>([]);

	let formOpen = $state(false);
	let editing = $state<Trigger | null>(null);
	let initial = $state<Partial<TriggerForm> | null>(null);
	let testing = $state<Trigger | null>(null);
	let testOpen = $state(false);
	let logging = $state<Trigger | null>(null);
	let deleting = $state<Trigger | null>(null);
	let deleteOpen = $state(false);
	let prefillError = $state<string | null>(null);

	const names: Names = $derived({
		typeLabel: (t) => catalog.types.find((x) => x.type === t)?.label ?? t,
		connection: (id) => catalog.connections.find((c) => c.id === id)?.label ?? id,
		agent: (id) => agentsStore.find(id)?.name ?? 'an agent',
		program: (id) => programs.find((p) => p.id === id)?.name ?? 'a program'
	});

	async function load(quiet = false): Promise<void> {
		if (!quiet) {
			loading = true;
			error = null;
		}
		try {
			const res = await api.get('/triggers');
			items = res.items;
			executed = res.executedLastHour;
			cap = res.hourlyCap;
		} catch (e) {
			if (!quiet) error = e instanceof Error ? e.message : String(e);
		} finally {
			if (!quiet) loading = false;
		}
	}

	async function toggle(t: Trigger, enabled: boolean): Promise<void> {
		const before = t.enabled;
		items = items.map((x) => (x.id === t.id ? { ...x, enabled } : x));
		rowError = { ...rowError, [t.id]: '' };
		try {
			const saved = await api.patch('/triggers/{id}', { params: { id: t.id }, body: { enabled } });
			items = items.map((x) => (x.id === t.id ? saved : x));
		} catch (e) {
			items = items.map((x) => (x.id === t.id ? { ...x, enabled: before } : x));
			const msg = e instanceof Error ? e.message : String(e);
			rowError = { ...rowError, [t.id]: msg };
			toast.error(msg);
		}
	}

	async function remove(t: Trigger): Promise<void> {
		try {
			await api.delete('/triggers/{id}', { params: { id: t.id } });
			items = items.filter((x) => x.id !== t.id);
			toast.success(`Deleted ${t.name}`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not delete the trigger');
		}
	}

	function openNew(prefill: Partial<TriggerForm> | null = null): void {
		editing = null;
		initial = prefill;
		formOpen = true;
	}
	function openEdit(t: Trigger): void {
		editing = t;
		initial = null;
		formOpen = true;
	}
	function onSaved(t: Trigger): void {
		toast.success(editing ? 'Trigger saved' : 'Trigger created');
		items = items.some((x) => x.id === t.id) ? items.map((x) => (x.id === t.id ? t : x)) : [t, ...items];
		void load(true);
	}

	// `?new=1&event=<id>` (from the Events page) opens the create form prefilled from that event
	$effect(() => {
		if (page.url.searchParams.get('new') !== '1') return;
		const eventId = page.url.searchParams.get('event');
		untrack(() => {
			void goto(page.url.pathname, { replace: true, reset: false });
			if (!eventId) return openNew();
			prefillError = null;
			void api
				.get('/events/{id}', { params: { id: eventId } })
				.then((e) => openNew({ ...formWithPrefill(e) }))
				.catch(() => {
					prefillError = 'That event could not be loaded, so the form starts empty.';
					openNew();
				});
		});
	});

	onMount(() => {
		void load();
		void agentsStore.load();
		void api.get('/events/catalog').then((c) => (catalog = c)).catch(() => undefined);
		void api.get('/programs').then((r) => (programs = r.programs.map((p) => ({ id: p.id, name: p.name })))).catch(() => undefined);
		const tick = setInterval(() => !document.hidden && void load(true), 10_000);
		return () => clearInterval(tick);
	});

	const description = $derived(loading && items.length === 0 ? 'Make an agent, a program or a notification react to events.' : `${items.length} trigger${items.length === 1 ? '' : 's'}. ${capText(executed, cap)}.`);
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Triggers" {description}>
		{#snippet actions()}
			<Button size="sm" aria-label="New trigger" onclick={() => openNew()}><PlusIcon class="size-4" /><span class="hidden sm:inline">New trigger</span></Button>
			<Button variant="outline" size="sm" href="/events" aria-label="Events"><LightningIcon class="size-4" /><span class="hidden sm:inline">Events</span></Button>
			<Button variant="outline" size="icon-sm" aria-label="Refresh" title="Refresh" disabled={loading} onclick={() => void load()}>
				{#if loading}<Spinner class="size-4" />{:else}<ArrowClockwiseIcon class="size-4" />{/if}
			</Button>
		{/snippet}
	</PageHeader>

	<div class="relative min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto flex w-full max-w-4xl flex-col gap-3 p-3 md:p-4">
			<p class="text-xs text-muted-foreground">
				{capText(executed, cap)}. The cap is set in <a href="/settings?section=limits" class="underline underline-offset-2 hover:text-foreground">Settings, Limits</a>; firings over the cap are skipped and logged.
			</p>
			{#if prefillError}<p class="text-xs text-destructive-text" role="alert">{prefillError}</p>{/if}

			{#if error && items.length === 0}
				<Empty.Root class="border">
					<Empty.Header>
						<Empty.Media variant="icon"><WarningCircleIcon /></Empty.Media>
						<Empty.Title>Could not load the triggers</Empty.Title>
						<Empty.Description>{error}</Empty.Description>
					</Empty.Header>
					<Empty.Content><Button size="sm" variant="outline" onclick={() => void load()}>Try again</Button></Empty.Content>
				</Empty.Root>
			{:else if loading && items.length === 0}
				<div class="flex flex-col gap-2" data-testid="triggers-loading">{#each [0, 1, 2] as n (n)}<Skeleton class="h-28 w-full" />{/each}</div>
			{:else if items.length === 0}
				<Empty.Root class="border" data-testid="triggers-empty">
					<Empty.Header>
						<Empty.Media variant="icon"><BellRingingIcon /></Empty.Media>
						<Empty.Title>No triggers yet</Empty.Title>
						<Empty.Description>A trigger listens for events, such as a join request, a failed program or a reaction, and then wakes an agent, runs a program, notifies you or calls a webhook. You can also start one from any event on the Events page.</Empty.Description>
					</Empty.Header>
					<Empty.Content><Button size="sm" onclick={() => openNew()}><PlusIcon class="size-4" />New trigger</Button></Empty.Content>
				</Empty.Root>
			{:else}
				<ul class="flex flex-col gap-3" data-testid="triggers-list">
					{#each items as t (t.id)}
						{@const filters = filtersText(t)}
						{@const hint = filteredHint(t.filteredCount)}
						<li>
							<Surface class="flex flex-col gap-2 p-3 {t.enabled ? '' : 'opacity-70'}">
								<div class="flex items-center gap-2">
									<h2 class="min-w-0 flex-1 truncate text-sm font-medium">{t.name}</h2>
									{#if t.errorCount > 0}<Badge variant="destructive" title="Firings that ended in an error">{t.errorCount} error{t.errorCount === 1 ? '' : 's'}</Badge>{/if}
									<Switch checked={t.enabled} onCheckedChange={(v: boolean) => void toggle(t, v)} aria-label="{t.enabled ? 'Disable' : 'Enable'} {t.name}" />
								</div>
								{#if rowError[t.id]}<p class="text-xs text-destructive-text" role="alert">{rowError[t.id]}</p>{/if}
								<p class="text-[13px] break-words">
									{listensText(t, names)}
									<span class="text-muted-foreground">{scopeText(t, names)}{filters ? `, ${filters}` : ''}.</span>
									<span>It {actionText(t, names)}.</span>
								</p>
								<div class="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
									<span title={t.lastFiredAt ? formatDateTime(t.lastFiredAt) : undefined}>{lastFiredText(t.lastFiredAt)}{t.lastFiredAt ? ` (${formatDateTime(t.lastFiredAt)})` : ''}</span>
									<span>{t.fireCount.toLocaleString()} firing{t.fireCount === 1 ? '' : 's'}</span>
									<span>Cooldown: {cooldownText(t.cooldownSec)}</span>
									<span>Created by {t.createdBy}, {timeAgo(t.createdAt) === 'now' ? 'just now' : `${timeAgo(t.createdAt)} ago`}</span>
									{#if t.allowSelf}<span class="text-warning-text">Also fires on events the agent caused</span>{/if}
								</div>
								{#if hint}<p class="text-xs text-muted-foreground">{hint}.</p>{/if}
								{#if t.notes}<p class="text-xs break-words text-muted-foreground">{t.notes}</p>{/if}
								<div class="flex flex-wrap gap-1.5 pt-1">
									<Button size="sm" variant="outline" onclick={() => openEdit(t)}>Edit</Button>
									<Button size="sm" variant="outline" onclick={() => { testing = t; testOpen = true; }}>Test</Button>
									<Button size="sm" variant="outline" onclick={() => (logging = t)}>Log</Button>
									<Button size="sm" variant="ghost" class="text-destructive-text" onclick={() => { deleting = t; deleteOpen = true; }}>Delete</Button>
								</div>
							</Surface>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</div>

<TriggerFormSheet bind:open={formOpen} trigger={editing} {initial} {catalog} {programs} {onSaved} />
<TriggerTestDialog bind:open={testOpen} trigger={testing} types={catalog.types} />
<TriggerFiresSheet trigger={logging} types={catalog.types} onClose={() => (logging = null)} />
<ConfirmDialog bind:open={deleteOpen} title="Delete this trigger?" description="{deleting?.name ?? 'The trigger'} stops listening and its firing log is removed. This cannot be undone." onConfirm={async () => {
		if (deleting) await remove(deleting);
	}} />
