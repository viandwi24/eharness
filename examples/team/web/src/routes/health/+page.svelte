<script lang="ts">
	import HeartbeatIcon from 'phosphor-svelte/lib/Heartbeat';
	import { onMount } from 'svelte';
	import { api } from '#lib/api/index.js';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Card } from '#lib/components/ui/card/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { ALARM_LABEL, type Alarm, alarmAction, CONSISTENCY_LABEL, type Finding, filterFindings, KIND_LABEL, memoryWhere, SEVERITY_LABEL, SEVERITY_VARIANT, type Severity, seenLine, severityCounts, sortFindings, splitConsistency } from '#lib/health/model.js';
	import { openEditAgent } from '#lib/stores/dialogs.svelte.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { timeAgo } from '#lib/time.js';

	let findings = $state<Finding[] | null>(null);
	let alarms = $state<Alarm[]>([]);
	let error = $state('');
	let agentFilter = $state('');
	let severityFilter = $state<Severity | ''>('');
	let showDismissed = $state(false);
	let busy = $state<string | null>(null);
	let seq = 0;

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/agent-health/findings', { query: { ...(showDismissed ? { dismissed: 'true' as const } : {}) } });
			if (mine !== seq) return;
			findings = r.findings;
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the findings';
		}
	}

	/** The alarms: failures of scheduled and background work, until somebody acknowledges them. */
	async function loadAlarms(): Promise<void> {
		try {
			alarms = (await api.get('/alarms', {})).alarms;
		} catch {
			// the findings below still work; the next refresh tries again
		}
	}

	async function ack(a: Alarm): Promise<void> {
		busy = a.id;
		try {
			await api.post('/alarms/{id}/ack', { params: { id: a.id } });
			await loadAlarms();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not acknowledge it');
		} finally {
			busy = null;
		}
	}

	onMount(() => {
		void agentsStore.load();
		void loadAlarms();
		const alarmTimer = setInterval(() => void loadAlarms(), 30_000);
		// the server scans every 10 minutes: a minute is fresh enough
		const timer = setInterval(() => void load(), 60_000);
		return () => {
			clearInterval(timer);
			clearInterval(alarmTimer);
		};
	});
	$effect(() => {
		void showDismissed;
		void load();
	});

	async function setDismissed(f: Finding, dismissed: boolean): Promise<void> {
		busy = f.fingerprint;
		try {
			const params = { fingerprint: f.fingerprint };
			if (dismissed) await api.post('/agent-health/findings/{fingerprint}/dismiss', { params });
			else await api.delete('/agent-health/findings/{fingerprint}/dismiss', { params });
			toast.success(dismissed ? 'Dismissed' : 'Showing it again');
			await load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not change the finding');
		} finally {
			busy = null;
		}
	}

	const shown = $derived(sortFindings(filterFindings(findings ?? [], { agentId: agentFilter, severity: severityFilter })));
	const groups = $derived(splitConsistency(shown));
	const counts = $derived(severityCounts(findings ?? []));
	const agentsWithFindings = $derived(agentsStore.state.agents.filter((a) => (findings ?? []).some((f) => f.agentId === a.id)));
</script>

{#snippet card(f: Finding)}
				<Card size="sm" class="gap-2.5 px-4 py-3.5 {f.dismissed ? 'opacity-60' : ''}" data-testid="health-finding" data-severity={f.severity} data-kind={f.kind}>
					<div class="flex flex-wrap items-center gap-2">
						<Badge variant={SEVERITY_VARIANT[f.severity]} class="h-5 px-1.5 text-[11px]">{SEVERITY_LABEL[f.severity]}</Badge>
						<Badge variant="secondary" class="h-5 px-1.5 text-[11px]">{f.consistency ? (CONSISTENCY_LABEL[f.consistency.kind] ?? KIND_LABEL[f.kind]) : KIND_LABEL[f.kind]}</Badge>
						{#if f.agentName}<span class="text-xs text-muted-foreground">{f.agentName}</span>{/if}
						{#if f.programName}<span class="text-xs text-muted-foreground">· {f.programName}</span>{/if}
						{#if !f.consistency}<span class="ml-auto text-xs text-muted-foreground">{seenLine(f, (ms) => timeAgo(ms))}</span>{/if}
					</div>
					<p class="text-[14px] leading-snug font-medium">{f.explanation}</p>
					<p class="text-[13px] text-muted-foreground"><span class="font-medium text-foreground">Suggested fix.</span> {f.fix}</p>
					<div class="flex flex-wrap items-center gap-2">
						{#if f.link}
							<Button size="sm" variant="outline" href={f.link}>{f.consistency ? (f.programId ? 'Open the program' : 'Open it') : f.programId ? 'Open the run' : 'Open the session'}</Button>
						{/if}
						{#if memoryWhere(f)}
							<span class="font-mono text-xs text-muted-foreground" data-testid="health-memory-path">{memoryWhere(f)}</span>
							{#if f.agentId}
								<Button size="sm" variant="outline" onclick={() => openEditAgent(f.agentId as string, 'memory')}>Open the memory file</Button>
							{/if}
						{/if}
						<Button size="sm" variant="ghost" disabled={busy === f.fingerprint} onclick={() => void setDismissed(f, !f.dismissed)}>
							{f.dismissed ? 'Show again' : 'Dismiss'}
						</Button>
					</div>
				</Card>
{/snippet}

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Health" description="Problems the server noticed in the last 24 hours, from its own data.">
		<NativeSelect bind:value={agentFilter} aria-label="Filter by agent" class="w-40">
			<NativeSelectOption value="">All agents</NativeSelectOption>
			{#each agentsWithFindings as a (a.id)}
				<NativeSelectOption value={a.id}>{a.name}</NativeSelectOption>
			{/each}
		</NativeSelect>
		<NativeSelect bind:value={severityFilter} aria-label="Filter by severity" class="w-36">
			<NativeSelectOption value="">All severities</NativeSelectOption>
			<NativeSelectOption value="high">High{counts.high ? ` (${counts.high})` : ''}</NativeSelectOption>
			<NativeSelectOption value="medium">Medium{counts.medium ? ` (${counts.medium})` : ''}</NativeSelectOption>
			<NativeSelectOption value="low">Low</NativeSelectOption>
		</NativeSelect>
		<Button size="sm" variant={showDismissed ? 'secondary' : 'ghost'} aria-pressed={showDismissed} onclick={() => (showDismissed = !showDismissed)}>Dismissed</Button>
	</PageHeader>

	<PageBody size="narrow" class="gap-3">
		{#if alarms.length}
			<section class="flex flex-col gap-2" data-testid="health-alarms" aria-label="Needs attention">
				<h2 class="text-sm font-semibold">Needs attention</h2>
				{#each alarms as a (a.id)}
					{@const action = alarmAction(a)}
					<Card size="sm" class="gap-2 border-destructive/40 px-4 py-3.5" data-testid="health-alarm" data-kind={a.kind}>
						<div class="flex flex-wrap items-center gap-2">
							<Badge variant="destructive" class="h-5 px-1.5 text-[11px]">{ALARM_LABEL[a.kind]}</Badge>
							<span class="ml-auto text-xs text-muted-foreground">{timeAgo(a.createdAt)}</span>
						</div>
						<p class="text-[14px] leading-snug">{a.text}</p>
						<div class="flex flex-wrap items-center gap-2">
							{#if action}<Button size="sm" variant="outline" href={action.href}>{action.label}</Button>{/if}
							<Button size="sm" variant="ghost" disabled={busy === a.id} onclick={() => void ack(a)}>Acknowledge</Button>
						</div>
					</Card>
				{/each}
			</section>
		{/if}
		{#if error}
			<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Retry</button></p>
		{:else if !findings}
			<div class="flex flex-col gap-2">{#each [0, 1, 2] as i (i)}<Skeleton class="h-24 w-full" />{/each}</div>
		{:else if !shown.length}
			<Empty.Root class="border border-dashed border-border">
				<Empty.Header>
					<Empty.Media variant="icon"><HeartbeatIcon /></Empty.Media>
					<Empty.Title>{findings.length ? 'Nothing matches these filters' : 'No problems noticed'}</Empty.Title>
					<Empty.Description>
						The server checks every ten minutes for tools that are denied again and again, loops, repeated errors, approvals nobody answers, context spikes, program runs that end partial or failed, and provider errors. Serious ones also ring the bell.
					</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else}
			{#each groups.runtime as f (f.fingerprint)}
				{@render card(f)}
			{/each}
			{#if groups.consistency.length}
				<div class="mt-2 flex flex-col gap-1" data-testid="health-consistency">
					<h2 class="text-sm font-semibold">Consistency</h2>
					<p class="text-[13px] text-muted-foreground">Places that contradict each other or hold stale state: duplicate programs, memory files that name tools or ids that are gone, decisions nobody answered, connections that are down but still used.</p>
				</div>
				{#each groups.consistency as f (f.fingerprint)}
					{@render card(f)}
				{/each}
			{/if}
		{/if}
	</PageBody>
</div>
