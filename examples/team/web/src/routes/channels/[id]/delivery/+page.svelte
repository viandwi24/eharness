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
	import { breakerText, HELD_HELP, HELD_LABEL, limitsBody, limitsFormOf, outboxSummary, usageText, type LimitsForm } from '#lib/channels/model.js';
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

		<section class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
			<p class="min-w-0 flex-1 text-xs text-muted-foreground">Something stuck? Restarting stops and starts {account ? 'the account' : 'polling'}. Queued messages and settings stay.</p>
			<Button size="sm" variant="outline" onclick={() => void restart()} disabled={busy}><ArrowsClockwiseIcon class="size-4" /> {account ? 'Restart the account' : 'Restart the bot'}</Button>
		</section>
	</PageBody>
</div>
