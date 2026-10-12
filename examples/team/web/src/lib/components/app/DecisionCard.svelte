<script lang="ts">
	import { chatHref } from '#lib/threads/model.js';
	import { goto } from '$app/navigation';
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimple';
	import XIcon from 'phosphor-svelte/lib/X';
	import { ApiError } from '#lib/api/index.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { MessageResponse } from '#lib/components/ai/message/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Card } from '#lib/components/ui/card/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { decide } from '#lib/decisions/actions.js';
	import { type Decision, grantLines, isOpen, isStandDownChoice, KIND_INFO, optionsOf, outcomeLine, proposalBudget, statusBadge, triggerLine } from '#lib/decisions/model.js';
	import EffectiveGrant from './EffectiveGrant.svelte';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openSession } from '#lib/stores/drawer.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { timeAgo } from '#lib/time.js';

	let { decision, onEdit }: { decision: Decision; onEdit?: (d: Extract<Decision, { kind: 'proposal' }>) => void } = $props();

	const agent = $derived(agentsStore.find(decision.agentId));
	const open = $derived(isOpen(decision));
	const options = $derived(optionsOf(decision));
	const grants = $derived(grantLines(decision));
	const badge = $derived(statusBadge(decision));
	let note = $state('');
	let rejecting = $state(false);
	let busy = $state(false);
	let bodyOpen = $state(false);
	const longBody = $derived(decision.body.length > 500 || decision.body.split('\n').length > 8);
	const rememberHint = $derived(decision.kind === 'escalation' && open && decision.programId !== null ? options.filter(isStandDownChoice) : []);

	/** The DM chat a proposal came from, or the task session of a run. */
	async function openSource(): Promise<void> {
		if (!decision.sessionId) return;
		const chat = chatHref(decision.sessionId);
		if (chat) {
			void goto(chat);
			return;
		}
		if (!(await openSession(decision.sessionId))) toast.error('That session is not on the board any more');
	}

	async function send(kind: 'approve' | 'reject', choice?: string): Promise<void> {
		busy = true;
		try {
			const text = note.trim() || undefined;
			if (kind === 'approve') await decide(decision.id, 'approve', { note: text, choice });
			else await decide(decision.id, 'reject', { note: text });
			toast.success(kind === 'approve' ? 'Approved' : 'Rejected');
			note = '';
			rejecting = false;
		} catch (e) {
			// answered elsewhere, or the run stopped waiting: say so; the list refetches either way
			if (e instanceof ApiError && (e.code === 'DECISION_CLOSED' || e.code === 'DECISION_EXPIRED')) toast.info(e.message);
			else toast.error(e instanceof Error ? e.message : 'Could not send the answer');
		} finally {
			busy = false;
			await live.loadDecisions();
			live.state.revs.decisions++;
		}
	}
</script>

<Card size="sm" class="gap-3 px-4 py-3.5" data-testid="decision-card" data-kind={decision.kind} data-status={decision.status}>
	<div class="flex flex-wrap items-center gap-2">
		<Badge variant="secondary" class="h-5 px-1.5 text-[11px]">{KIND_INFO[decision.kind].badge}</Badge>
		<Badge variant={badge.variant} class="h-5 px-1.5 text-[11px]">{badge.label}</Badge>
		<span class="ml-auto text-xs text-muted-foreground">{timeAgo(decision.createdAt)}</span>
	</div>
	<div class="flex items-start gap-2.5">
		<AgentAvatar seed={decision.agentId} color={agent?.color} size={28} label={agent?.name ?? 'Agent'} class="mt-0.5 shrink-0" />
		<div class="min-w-0 flex-1">
			<h3 class="text-[15px] leading-snug font-semibold">{decision.title}</h3>
			<div class="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
				<span>{agent?.name ?? 'An agent'} asks</span>
				{#if decision.sessionId}
					<button type="button" class="underline underline-offset-4 outline-none hover:text-foreground focus-visible:text-foreground" onclick={() => void openSource()}>
						{chatHref(decision.sessionId) ? 'Open the chat' : 'Open the run'}
					</button>
				{/if}
				{#if decision.programId}
					<a class="underline underline-offset-4 hover:text-foreground" href="/programs">Program</a>
				{/if}
			</div>
		</div>
	</div>

	{#if decision.body}
		<div class="rounded-md border border-border bg-muted/40 px-3 py-2" data-testid="decision-body">
			<div class={bodyOpen || !longBody ? '' : 'max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]'}>
				<div class="[&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_code]:break-words"><MessageResponse content={decision.body} class="text-[13.5px]" /></div>
			</div>
			{#if longBody}
				<button type="button" class="mt-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground" aria-expanded={bodyOpen} onclick={() => (bodyOpen = !bodyOpen)}>{bodyOpen ? 'Show less' : 'Show more'}</button>
			{/if}
		</div>
	{/if}

	{#if decision.kind === 'proposal'}
		<dl class="grid gap-x-4 gap-y-1 text-[13px] sm:grid-cols-[8rem_1fr]">
			<dt class="text-muted-foreground">Runs as</dt>
			<dd>{agentsStore.find(decision.payload.program.agentId)?.name ?? 'an agent'} · {decision.payload.program.name}</dd>
			<dt class="text-muted-foreground">When</dt>
			<dd>{triggerLine(decision.payload)}</dd>
			<dt class="text-muted-foreground">Budget</dt>
			<dd>{proposalBudget(decision.payload)}</dd>
			{#if decision.payload.program.gates.length}
				<dt class="text-muted-foreground">Still asks you</dt>
				<dd>{decision.payload.program.gates.join('; ')}</dd>
			{/if}
			{#if decision.payload.program.deliverables?.length}
				<dt class="text-muted-foreground">Must leave</dt>
				<dd class="font-mono text-xs" data-testid="proposal-deliverables">{decision.payload.program.deliverables.map((d) => `${d.path} (${d.kind})`).join(', ')}</dd>
			{/if}
			{#if decision.payload.program.forbidden.length}
				<dt class="text-muted-foreground">Forbidden</dt>
				<dd class="font-mono text-xs">{decision.payload.program.forbidden.join(', ')}</dd>
			{/if}
		</dl>
	{/if}

	{#if decision.kind !== 'escalation'}
		<div data-testid="decision-grants">
			<div class="mb-1 text-xs font-medium text-muted-foreground">
				{decision.kind === 'amendment' ? 'Approving adds this to the program' : 'Approving grants exactly this authority'}
			</div>
			{#if grants.length}
				<ul class="flex flex-col gap-0.5 text-[13px]">
					{#each grants as line (line)}<li class="font-mono text-xs before:mr-2 before:content-['•']">{line}</li>{/each}
				</ul>
			{:else}
				<p class="text-[13px] text-muted-foreground">Nothing beyond finding and planning its own work.</p>
			{/if}
			{#if open && decision.grant}
				<div class="mt-2"><EffectiveGrant grant={decision.grant} /></div>
			{/if}
		</div>
	{/if}

	{#if open}
		{#if rejecting}
			<div class="flex flex-col gap-2">
				<Textarea bind:value={note} rows={2} placeholder="Why not? (the agent reads this)" aria-label="Note" />
				<div class="flex gap-2">
					<Button size="sm" variant="destructive" disabled={busy} onclick={() => void send('reject')}><XIcon class="size-4" /> Reject</Button>
					<Button size="sm" variant="ghost" disabled={busy} onclick={() => (rejecting = false)}>Cancel</Button>
				</div>
			</div>
		{:else}
			<div class="flex flex-col gap-2">
				<Textarea bind:value={note} rows={1} placeholder="Add a note (optional)" aria-label="Note" class="min-h-9" />
				<div class="flex flex-wrap gap-2">
					{#if decision.kind === 'escalation' && options.length}
						{#each options as option (option)}
							<Button size="sm" disabled={busy} onclick={() => void send('approve', option)}>{option}</Button>
						{/each}
					{:else}
						<Button size="sm" disabled={busy} onclick={() => void send('approve')}><CheckIcon class="size-4" /> Approve</Button>
					{/if}
					{#if decision.kind === 'proposal'}
						<Button size="sm" variant="outline" disabled={busy} onclick={() => onEdit?.(decision)}><PencilSimpleIcon class="size-4" /> Edit &amp; approve</Button>
					{/if}
					<Button size="sm" variant="ghost" disabled={busy} onclick={() => (rejecting = true)}>Reject…</Button>
				</div>
				{#if rememberHint.length}
					<p class="text-xs text-muted-foreground" data-testid="remember-hint">If you answer “{rememberHint.join('” or “')}”, this answer will be remembered for 7 days: the program will not ask the same thing again. You can make it forget on the program page.</p>
				{/if}
			</div>
		{/if}
	{:else}
		<p class="text-[13px] text-muted-foreground">
			{outcomeLine(decision)}{decision.decisionNote ? ` Note: ${decision.decisionNote}` : ''}
		</p>
	{/if}
</Card>
