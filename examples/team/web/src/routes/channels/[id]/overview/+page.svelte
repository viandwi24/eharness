<script lang="ts">
	import { onMount } from 'svelte';
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOut';
	import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwise';
	import WarningIcon from 'phosphor-svelte/lib/Warning';
	import { api } from '#lib/api/index.js';
	import BindingForm from '#lib/components/app/channels/BindingForm.svelte';
	import ChannelHeader from '#lib/components/app/channels/ChannelHeader.svelte';
	import StatusBadges from '#lib/components/app/channels/StatusBadges.svelte';
	import ConnectFlowDialog from '#lib/components/app/ConnectFlowDialog.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { useConnection } from '#lib/channels/connection.svelte.js';
	import {
		ACCOUNT_WARNING,
		API_ID_URL,
		TERMS_URL,
		accountHint,
		ago,
		attentionOf,
		breakerText,
		channelHref,
		EVENT_LABEL,
		eventText,
		eventTone,
		isAccount,
		outboxSummary,
		privacyWarning,
		stateHint,
		usageText,
		type ChannelActivity,
		type ChannelChat
	} from '#lib/channels/model.js';
	import { pollWhileVisible } from '#lib/hooks/poll.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { formatTime } from '#lib/format.js';

	// which agents may use this connection's tools (its access on the Connectors page)
	let toolAgents = $state<string | null>(null);
	async function loadToolAgents(): Promise<void> {
		try {
			const r = await api.get('/connections');
			const c = r.connections.find((x) => x.id === id);
			if (!c?.access) return void (toolAgents = null);
			const names = c.access.agentIds.map((a) => agentsStore.state.agents.find((x) => x.id === a)?.name ?? a);
			toolAgents = c.access.mode === 'all' ? 'all agents' : names.length ? names.join(', ') : 'no agent yet';
		} catch {
			toolAgents = null;
		}
	}
	onMount(() => void loadToolAgents());

	const cs = useConnection();
	const conn = $derived(cs.conn!);
	const id = $derived(cs.id());
	const account = $derived(isAccount(conn));
	const hint = $derived(account ? accountHint(conn) : stateHint(conn));
	const attention = $derived(attentionOf(conn));
	const agentName = $derived(conn.binding ? (agentsStore.state.agents.find((a) => a.id === conn.binding?.agentId)?.name ?? 'an agent') : undefined);
	const link = $derived(conn.bot ? `https://t.me/${conn.bot.username}` : undefined);
	const breaker = $derived(breakerText(conn, Date.now()));

	let recent = $state<ChannelActivity[] | null>(null);
	let reading = $state<ChannelChat[]>([]);
	let busy = $state(false);
	let reconnectOpen = $state(false);

	const warning = $derived(privacyWarning(conn, reading));

	async function loadRecent(): Promise<void> {
		if (!conn.binding) return;
		try {
			recent = (await api.get('/channels/connections/{id}/activity/table', { params: { id }, query: { limit: 8 } })).items;
			if (!account) reading = (await api.get('/channels/connections/{id}/chats/table', { params: { id }, query: { allowed: 'yes', limit: 100 } })).items;
		} catch {
			// the overview still shows; the next look retries
		}
	}
	onMount(() => {
		void loadRecent();
		return pollWhileVisible(() => void loadRecent());
	});

	async function act(what: string, path: '/channels/connections/{id}/restart' | '/channels/connections/{id}/webhook/delete', ok: string): Promise<void> {
		busy = true;
		try {
			await api.post(path, { params: { id } });
			toast.success(ok);
			await cs.load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : `Could not ${what}`);
		} finally {
			busy = false;
		}
	}

	const tiles = $derived([
		{ label: account ? 'Chats being read' : 'Chats', value: conn.counts.chats, to: 'chats' },
		{ label: 'Linked people', value: conn.counts.linked, to: 'people' },
		{ label: 'Not linked yet', value: conn.counts.unlinked, to: 'people', warn: conn.counts.unlinked > 0 },
		{ label: 'Waiting to send', value: conn.counts.outboxPending, to: 'delivery' },
		{ label: 'Failed to send', value: conn.counts.outboxFailed, to: 'delivery', warn: conn.counts.outboxFailed > 0 }
	]);
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<ChannelHeader section="overview" description="How this channel is doing and what needs you.">
		{#snippet actions()}
			{#if link}<Button size="sm" variant="outline" href={link} target="_blank" rel="noreferrer"><ArrowSquareOutIcon class="size-4" /> Open in Telegram</Button>{/if}
		{/snippet}
	</ChannelHeader>
	<PageBody size="wide" class="gap-5">
		<section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="Status" data-testid="overview-status">
			<div class="flex flex-wrap items-center gap-2">
				<StatusBadges {conn} />
				{#if conn.runtime.state === 'running'}<span class="text-xs text-muted-foreground">since {formatTime(conn.runtime.since)}</span>{/if}
				{#if agentName}<span class="text-xs text-muted-foreground">· answered by {agentName}</span>{/if}
			</div>
			{#if hint}<p class="text-sm text-muted-foreground">{hint}</p>{/if}
			{#if conn.runtime.state === 'webhook' || conn.runtime.state === 'error' || conn.runtime.state === 'lease' || conn.runtime.state === 'needs-auth'}
				<div class="flex flex-wrap gap-2">
					{#if conn.runtime.state === 'webhook'}<Button size="sm" onclick={() => void act('remove the webhook', '/channels/connections/{id}/webhook/delete', 'Webhook removed')} disabled={busy}>Remove webhook and poll</Button>{/if}
					{#if conn.runtime.state === 'error' || conn.runtime.state === 'lease'}<Button size="sm" variant="outline" onclick={() => void act('restart', '/channels/connections/{id}/restart', 'Restarted')} disabled={busy}><ArrowsClockwiseIcon class="size-4" /> Retry</Button>{/if}
					{#if conn.runtime.state === 'needs-auth'}<Button size="sm" variant="outline" onclick={() => (reconnectOpen = true)}>{account ? 'Sign in again' : 'Reconnect with a new token'}</Button>{/if}
				</div>
			{/if}
			{#if breaker}<p class="text-xs text-warning-text" role="status">{breaker}</p>{/if}
		</section>

		{#if !conn.binding}
			<section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="Answering agent" data-testid="overview-bind">
				<div>
					<h2 class="text-sm font-medium">No answering agent</h2>
					<p class="text-xs text-muted-foreground">
						This connection runs and records what it sees{account ? ' in the chats you choose' : ''}; nobody answers on it. Agents allowed on the <a href="/connectors" class="underline underline-offset-4">Connectors</a> page use its tools (read chats, send messages). Choose an agent below if it should answer direct messages and mentions.
					</p>
				</div>
				<BindingForm {conn} onChange={() => void cs.load()} />
			</section>
		{/if}
		{#if toolAgents !== null}
			<p class="text-xs text-muted-foreground" data-testid="tool-agents">
				Agents that can use its tools: <span class="text-foreground">{toolAgents}</span>. <a href="/connectors" class="underline underline-offset-4">Change on Connectors</a>
			</p>
		{/if}
			<section aria-label="Key numbers">
				<ul class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" data-testid="overview-tiles">
					{#each tiles as t (t.label)}
						<li>
							<a href={channelHref(id, t.to)} class="flex flex-col gap-0.5 rounded-lg border border-border bg-card p-3 outline-none hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring">
								<span class="font-mono text-xl tabular-nums {t.warn ? 'text-warning-text' : ''}">{t.value}</span>
								<span class="text-xs text-muted-foreground">{t.label}</span>
							</a>
						</li>
					{/each}
				</ul>
				<p class="mt-2 text-xs text-muted-foreground" data-testid="outbox-summary">{outboxSummary(conn)}{#if conn.account} · {usageText(conn.account)}{/if}</p>
			</section>

			{#if attention.length > 0}
				<section class="flex flex-col gap-2 rounded-xl border border-border bg-warning-soft p-4 text-sm text-warning-text" aria-label="Needs attention" data-testid="overview-attention">
					<h2 class="flex items-center gap-2 text-sm font-medium"><WarningIcon class="size-4" /> Needs attention</h2>
					<ul class="flex list-disc flex-col gap-1 pl-5 text-xs">{#each attention as a (a)}<li>{a}</li>{/each}</ul>
				</section>
			{/if}

			{#if warning}
				<p class="flex gap-2 rounded-lg border border-border bg-warning-soft p-3 text-xs text-warning-text" role="note" data-testid="privacy-warning"><WarningIcon class="mt-0.5 size-4 shrink-0" /> {warning}</p>
			{:else if conn.bot && !conn.bot.canReadAllGroupMessages}
				<p class="text-xs text-muted-foreground">{conn.bot.guidance}</p>
			{/if}

			{#if conn.account && conn.account.warnings.length > 0}
				<ul class="flex flex-col gap-1 text-xs text-warning-text" role="status">{#each conn.account.warnings as w (w)}<li>{w}</li>{/each}</ul>
			{/if}

			<section class="flex flex-col gap-2" aria-label="Recent activity" data-testid="overview-activity">
				<div class="flex items-center justify-between gap-2">
					<h2 class="text-sm font-medium">Recent activity</h2>
					<Button size="sm" variant="ghost" href={channelHref(id, 'activity')}>All activity</Button>
				</div>
				{#if recent === null}
					<div class="flex flex-col gap-2" aria-busy="true">{#each [0, 1, 2] as i (i)}<Skeleton class="h-10 w-full rounded-lg" />{/each}</div>
				{:else if recent.length === 0}
					<p class="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">Nothing yet. Events appear when somebody writes to this channel or the agent sends something.</p>
				{:else}
					<ul class="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
						{#each recent as e (e.id)}
							<li class="flex flex-col gap-1 p-3">
								<div class="flex min-w-0 flex-wrap items-center gap-2">
									<Badge variant={eventTone(e.type)}>{EVENT_LABEL[e.type]}</Badge>
									<span class="ml-auto shrink-0 text-xs text-muted-foreground" title={formatTime(e.at)}>{ago(e.at, Date.now())}</span>
								</div>
								{#if eventText(e)}<p class="text-xs break-words text-muted-foreground">{eventText(e)}</p>{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</section>

		{#if account}
			<section class="flex flex-col gap-2 rounded-lg border border-border bg-warning-soft p-3 text-xs text-warning-text" role="note" data-testid="account-warning">
				<p class="flex gap-2 font-medium"><WarningIcon class="mt-0.5 size-4 shrink-0" /> This is a user account, not a bot</p>
				<p>{ACCOUNT_WARNING}</p>
				<p class="flex flex-wrap gap-x-4 gap-y-1">
					<a class="underline underline-offset-4" href={TERMS_URL} target="_blank" rel="noreferrer">Telegram API terms</a>
					<a class="underline underline-offset-4" href={API_ID_URL} target="_blank" rel="noreferrer">Getting an api_id</a>
				</p>
			</section>
		{/if}
	</PageBody>
</div>

<ConnectFlowDialog bind:open={reconnectOpen} connectionId={conn.id} label={conn.label} signIn={account} next={account ? 'The account starts again by itself.' : 'The bot starts again by itself.'} onDone={() => void cs.load()} />
