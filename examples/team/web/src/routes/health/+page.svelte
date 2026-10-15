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
	import { type Finding, filterFindings, KIND_LABEL, SEVERITY_LABEL, SEVERITY_VARIANT, type Severity, seenLine, severityCounts, sortFindings } from '#lib/health/model.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { timeAgo } from '#lib/time.js';

	let findings = $state<Finding[] | null>(null);
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

	onMount(() => {
		void agentsStore.load();
		// the server scans every 10 minutes: a minute is fresh enough
		const timer = setInterval(() => void load(), 60_000);
		return () => clearInterval(timer);
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
	const counts = $derived(severityCounts(findings ?? []));
	const agentsWithFindings = $derived(agentsStore.state.agents.filter((a) => (findings ?? []).some((f) => f.agentId === a.id)));
</script>

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
			{#each shown as f (f.fingerprint)}
				<Card size="sm" class="gap-2.5 px-4 py-3.5 {f.dismissed ? 'opacity-60' : ''}" data-testid="health-finding" data-severity={f.severity} data-kind={f.kind}>
					<div class="flex flex-wrap items-center gap-2">
						<Badge variant={SEVERITY_VARIANT[f.severity]} class="h-5 px-1.5 text-[11px]">{SEVERITY_LABEL[f.severity]}</Badge>
						<Badge variant="secondary" class="h-5 px-1.5 text-[11px]">{KIND_LABEL[f.kind]}</Badge>
						{#if f.agentName}<span class="text-xs text-muted-foreground">{f.agentName}</span>{/if}
						{#if f.programName}<span class="text-xs text-muted-foreground">· {f.programName}</span>{/if}
						<span class="ml-auto text-xs text-muted-foreground">{seenLine(f, (ms) => timeAgo(ms))}</span>
					</div>
					<p class="text-[14px] leading-snug font-medium">{f.explanation}</p>
					<p class="text-[13px] text-muted-foreground"><span class="font-medium text-foreground">Suggested fix.</span> {f.fix}</p>
					<div class="flex flex-wrap items-center gap-2">
						{#if f.link}
							<Button size="sm" variant="outline" href={f.link}>{f.programId ? 'Open the run' : 'Open the session'}</Button>
						{/if}
						<Button size="sm" variant="ghost" disabled={busy === f.fingerprint} onclick={() => void setDismissed(f, !f.dismissed)}>
							{f.dismissed ? 'Show again' : 'Dismiss'}
						</Button>
					</div>
				</Card>
			{/each}
		{/if}
	</PageBody>
</div>
