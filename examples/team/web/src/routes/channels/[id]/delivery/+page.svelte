<script lang="ts">
	import { untrack } from 'svelte';
	import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwise';
	import { api } from '#lib/api/index.js';
	import NeedsALook from '#lib/components/app/channels/NeedsALook.svelte';
	import ChannelHeader from '#lib/components/app/channels/ChannelHeader.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { useConnection } from '#lib/channels/connection.svelte.js';
	import { breakerText, HELD_HELP, HELD_LABEL, limitsBody, limitsFormOf, outboxSummary, paceBody, paceFormOf, usageText, type LimitsForm, type PaceForm } from '#lib/channels/model.js';
	import { formatTime } from '#lib/format.js';

	// How messages leave: the queue, the pause after errors, and for a user account the daily caps.
	const cs = useConnection();
	const id = cs.id();
	const conn = $derived(cs.conn!);
	const account = $derived(conn.account);
	const breaker = $derived(breakerText(conn, Date.now()));

	let busy = $state(false);
	let limits = $state<LimitsForm>(untrack(() => (cs.conn?.account ? limitsFormOf(cs.conn.account.limits) : { dmDailyMax: '', dailyMax: '', adminLogHours: '' })));
	let dirty = $state(false);
	$effect(() => {
		const l = conn.account?.limits;
		untrack(() => {
			if (l && !dirty) limits = limitsFormOf(l);
		});
	});

	// the pace: send rate, the natural pause between changes, API limits per minute
	let pace = $state<PaceForm | undefined>(untrack(() => (cs.conn?.account ? paceFormOf(cs.conn.account.limits) : undefined)));
	let paceDirty = $state(false);
	$effect(() => {
		const l = conn.account?.limits;
		untrack(() => {
			if (l && !paceDirty) pace = paceFormOf(l);
		});
	});
	const paceDefaults = $derived(account ? paceFormOf(account.limitDefaults) : undefined);
	const isDefault = $derived(pace !== undefined && paceDefaults !== undefined && (Object.keys(pace) as Array<keyof PaceForm>).every((k) => Number(pace?.[k]) === Number(paceDefaults[k])));
	function useDefaults(): void {
		if (!paceDefaults) return;
		pace = { ...paceDefaults };
		paceDirty = true;
	}
	async function savePace(): Promise<void> {
		if (!pace) return;
		const r = paceBody(pace);
		if ('error' in r) {
			toast.error(r.error);
			return;
		}
		if (await run('save the pace', () => api.put('/channels/connections/{id}/account/limits', { params: { id }, body: r.body }), 'Pace saved')) paceDirty = false;
	}

	async function run(what: string, fn: () => Promise<unknown>, ok: string): Promise<boolean> {
		busy = true;
		try {
			await fn();
			toast.success(ok);
			await cs.load();
			return true;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : `Could not ${what}`);
			return false;
		} finally {
			busy = false;
		}
	}
	const resetBreaker = (): Promise<boolean> => run('close the breaker', () => api.post('/channels/connections/{id}/breaker/reset', { params: { id } }), 'Sending resumed');
	const restart = (): Promise<boolean> => run('restart', () => api.post('/channels/connections/{id}/restart', { params: { id } }), 'Restarted');
	async function saveLimits(): Promise<void> {
		const r = limitsBody(limits);
		if ('error' in r) {
			toast.error(r.error);
			return;
		}
		if (await run('save the limits', () => api.put('/channels/connections/{id}/account/limits', { params: { id }, body: r.body }), 'Limits saved')) dirty = false;
	}
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<ChannelHeader section="delivery" title={account ? 'Send limits' : 'Delivery'} description={account ? 'How much the account may send.' : 'The queue of outgoing messages.'} />
	<PageBody size="narrow" class="gap-4">
		<section class="flex flex-col gap-1 rounded-xl border border-border bg-card p-4" aria-label="Outbox">
			<h2 class="text-sm font-medium">Outbox</h2>
			<p class="text-xs text-muted-foreground" data-testid="outbox-summary" title={conn.counts.outboxHeld > 0 ? `${HELD_LABEL}: ${HELD_HELP}` : undefined}>{outboxSummary(conn)}</p>
			{#if conn.counts.outboxHeld > 0}<p class="text-xs text-muted-foreground" data-testid="held-help">{HELD_HELP}</p>{/if}
			{#if account}
				<p class="text-xs" data-testid="usage">{usageText(account)}{#if account.floods.parkedChats > 0} · {account.floods.parkedChats} chat{account.floods.parkedChats === 1 ? '' : 's'} paused by a flood wait{/if}{#if account.pausedUntil} · sending paused until {formatTime(account.pausedUntil)}{/if}</p>
			{/if}
		</section>

		<NeedsALook connectionId={id} onChanged={() => cs.load()} />

		{#if breaker}
			<section class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-warning-soft p-4 text-xs text-warning-text" role="alert" aria-label="Sending is paused">
				<span class="min-w-0 flex-1">{breaker}</span>
				<Button size="sm" variant="outline" onclick={() => void resetBreaker()} disabled={busy}>Resume sending</Button>
			</section>
		{:else}
			<p class="text-xs text-muted-foreground">Messages are queued, sent no faster than {account ? 'the limits below' : 'Telegram allows (about one per second per chat)'} and retried on errors. If sending keeps failing it pauses by itself and says so here.</p>
		{/if}

		{#if account}
			<section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="Send limits" data-testid="limits">
				<p class="text-xs text-muted-foreground">A user account that sends like a robot gets limited. Sends are spaced out and capped per day; the defaults are strict on purpose. Raise them only when you must.</p>
				<div class="grid gap-3 sm:grid-cols-3">
					<label class="flex flex-col gap-1"><span class="text-xs font-medium">Direct messages a day</span><Input inputmode="numeric" bind:value={limits.dmDailyMax} oninput={() => (dirty = true)} /></label>
					<label class="flex flex-col gap-1"><span class="text-xs font-medium">Messages a day (all)</span><Input inputmode="numeric" bind:value={limits.dailyMax} oninput={() => (dirty = true)} /></label>
					<label class="flex flex-col gap-1"><span class="text-xs font-medium">Admin log every (hours)</span><Input inputmode="decimal" bind:value={limits.adminLogHours} oninput={() => (dirty = true)} /></label>
				</div>
				<div class="flex justify-end"><Button size="sm" onclick={() => void saveLimits()} disabled={busy || !dirty} data-testid="save-limits">Save limits</Button></div>
			</section>
		{/if}

		{#if account && pace && paceDefaults}
			<section class="flex flex-col gap-4 rounded-xl border border-border bg-card p-4" aria-label="Pace" data-testid="pace">
				<div class="flex flex-col gap-1">
					<h2 class="text-sm font-medium">Pace</h2>
					<p class="text-xs text-muted-foreground">How fast the account acts. Changes to chats (titles, usernames, members, invite links) wait a random pause between each other, like a person clicking through the app. A short flood wait from Telegram is waited out by itself; a long one pauses only chat changes, sending goes on.</p>
				</div>

				{#snippet field(label: string, key: keyof PaceForm, unit: string, mode: 'numeric' | 'decimal' = 'decimal')}
					<label class="flex min-w-0 flex-col gap-1">
						<span class="text-xs leading-4 font-medium sm:min-h-8">{label}</span>
						<div class="flex items-center gap-2">
							<Input inputmode={mode} class="min-w-0" bind:value={pace![key]} oninput={() => (paceDirty = true)} data-testid={`pace-${key}`} />
							<span class="shrink-0 text-xs text-muted-foreground">{unit}</span>
						</div>
						<span class="text-[11px] text-muted-foreground">default {paceDefaults[key]}</span>
					</label>
				{/snippet}

				{#snippet range(label: string, min: keyof PaceForm, max: keyof PaceForm)}
					<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
						<span class="w-full text-xs font-medium sm:w-44">{label}</span>
						<Input inputmode="decimal" class="w-20" aria-label={`${label}, shortest (seconds)`} bind:value={pace![min]} oninput={() => (paceDirty = true)} data-testid={`pace-${min}`} />
						<span class="text-xs text-muted-foreground">to</span>
						<Input inputmode="decimal" class="w-20" aria-label={`${label}, longest (seconds)`} bind:value={pace![max]} oninput={() => (paceDirty = true)} data-testid={`pace-${max}`} />
						<span class="text-xs text-muted-foreground">s</span>
						<span class="text-[11px] text-muted-foreground">default {paceDefaults[min]}–{paceDefaults[max]} s</span>
					</div>
				{/snippet}

				<fieldset class="flex flex-col gap-2">
					<legend class="mb-1 text-xs font-medium text-muted-foreground">Natural pause</legend>
					<div class="flex flex-col gap-3">
						{@render range('Between chat changes', 'adminPauseMinS', 'adminPauseMaxS')}
						{@render range('Between edits and pins', 'editPauseMinS', 'editPauseMaxS')}
					</div>
					<p class="text-xs text-muted-foreground">Each pause is picked at random in the range. 0 to 0 turns it off.</p>
				</fieldset>

				<fieldset class="flex flex-col gap-2">
					<legend class="mb-1 text-xs font-medium text-muted-foreground">Sending</legend>
					<div class="grid gap-3 sm:grid-cols-3">
						{@render field('Gap between messages to one chat', 'chatGapS', 's')}
						{@render field('Messages to one group', 'groupPerMinute', '/min', 'numeric')}
						{@render field('Messages in all chats', 'accountPerMinute', '/min', 'numeric')}
					</div>
				</fieldset>

				<fieldset class="flex flex-col gap-2">
					<legend class="mb-1 text-xs font-medium text-muted-foreground">Telegram API</legend>
					<div class="grid gap-3 sm:grid-cols-3">
						{@render field('Chat changes', 'adminPerMinute', '/min')}
						{@render field('Chat changes at once', 'adminBurst', 'calls', 'numeric')}
						{@render field('Edits, deletes, pins', 'editPerMinute', '/min')}
						{@render field('Reads', 'readPerMinute', '/min')}
						{@render field('All calls', 'globalPerMinute', '/min')}
						{@render field('Longest a tool waits', 'waitS', 's')}
					</div>
					<p class="text-xs text-muted-foreground">A tool that would wait longer than that answers "rate limited, retry in N s" so the agent can say when it will be done.</p>
				</fieldset>

				<div class="flex flex-wrap items-center justify-end gap-2">
					<Button size="sm" variant="ghost" onclick={useDefaults} disabled={busy || isDefault} data-testid="pace-defaults">Use defaults</Button>
					<Button size="sm" onclick={() => void savePace()} disabled={busy || !paceDirty} data-testid="save-pace">Save pace</Button>
				</div>
			</section>
		{/if}

		<section class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
			<p class="min-w-0 flex-1 text-xs text-muted-foreground">Something stuck? Restarting stops and starts {account ? 'the account' : 'polling'}. Queued messages and settings stay.</p>
			<Button size="sm" variant="outline" onclick={() => void restart()} disabled={busy}><ArrowsClockwiseIcon class="size-4" /> {account ? 'Restart the account' : 'Restart the bot'}</Button>
		</section>
	</PageBody>
</div>
