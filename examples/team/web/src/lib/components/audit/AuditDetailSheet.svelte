<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeft';
	import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRight';
	import XIcon from 'phosphor-svelte/lib/X';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { auditTime, connectorText, rawJson, requesterText, resultLabel, resultVariant, roleText, rowAction, summaryPairs, type AuditRow } from '#lib/audit/audit.js';
	import { channelHref } from '#lib/channels/model.js';
	import { formatDuration } from '#lib/logs/logs.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { chatHref } from '#lib/threads/model.js';

	/** One audit row in full: what was done, where, who asked, the result, and the raw record. */
	let {
		row,
		onPrev,
		onNext,
		onClose
	}: { row: AuditRow | null; onPrev?: (() => void) | undefined; onNext?: (() => void) | undefined; onClose: () => void } = $props();

	const agent = $derived(row?.agentId ? agentsStore.find(row.agentId) : undefined);
	const pairs = $derived(summaryPairs(row?.summary));
	const role = $derived(row ? roleText(row) : undefined);
	const session = $derived(row?.sessionId ? chatHref(row.sessionId) : undefined);

	function onKeydown(e: KeyboardEvent): void {
		if (!row || e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target as HTMLElement | null;
		if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
		if (e.key === 'ArrowLeft' && onPrev) {
			e.preventDefault();
			onPrev();
		} else if (e.key === 'ArrowRight' && onNext) {
			e.preventDefault();
			onNext();
		}
	}
</script>

<svelte:window onkeydowncapture={onKeydown} />

<Sheet.Root open={row !== null} onOpenChange={(o) => !o && onClose()}>
	<Sheet.Content side="right" showCloseButton={false} class="flex flex-col gap-0 p-0" style="width: min(40rem, 100vw); max-width: none">
		<header class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
			<Sheet.Title class="mr-auto text-sm font-medium">Action details</Sheet.Title>
			<Button variant="ghost" size="icon-sm" aria-label="Newer (←)" title="Newer (←)" disabled={!onPrev} onclick={() => onPrev?.()}><ArrowLeftIcon class="size-4" /></Button>
			<Button variant="ghost" size="icon-sm" aria-label="Older (→)" title="Older (→)" disabled={!onNext} onclick={() => onNext?.()}><ArrowRightIcon class="size-4" /></Button>
			<Button variant="ghost" size="icon-sm" aria-label="Close" onclick={onClose}><XIcon class="size-4" /></Button>
		</header>

		<div class="min-h-0 flex-1 overflow-y-auto p-4">
			{#if row}
				<div class="flex flex-col gap-5">
					<div class="flex flex-wrap items-center gap-1.5">
						<Badge variant={resultVariant(row.result)}>{resultLabel(row.result)}</Badge>
						<Badge variant="secondary">{rowAction(row)}</Badge>
						<Badge variant="outline">{row.kind === 'read' ? 'Lookup' : 'Action'}</Badge>
						<Badge variant="outline">{connectorText(row)}</Badge>
					</div>

					{#if row.note && row.result !== 'ok'}
						<div class="rounded-lg border border-[color-mix(in_srgb,var(--destructive)_30%,var(--popover))] bg-destructive-soft px-3 py-2 text-[13px] text-destructive-text" role="alert">
							<div class="font-medium">{row.result === 'refused' ? 'Why it was refused' : row.result === 'rate_limited' ? 'Why it was held back' : 'What went wrong'}</div>
							<p class="mt-0.5 break-words whitespace-pre-wrap">{row.note}</p>
						</div>
					{/if}

					<section>
						<h3 class="mb-2 text-xs font-semibold text-muted-foreground">Overview</h3>
						<dl class="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 text-[13px]">
							<dt class="text-muted-foreground">Time</dt>
							<dd class="font-mono text-xs">{auditTime(row.at)}</dd>
							<dt class="text-muted-foreground">Connection</dt>
							<dd class="min-w-0 break-words"><a href={channelHref(row.connectionId, 'activity')} class="underline underline-offset-2 hover:text-foreground">{row.connectionLabel}</a></dd>
							<dt class="text-muted-foreground">Action</dt>
							<dd class="min-w-0 break-words">{rowAction(row)} <span class="font-mono text-xs text-muted-foreground">({row.action})</span></dd>
							<dt class="text-muted-foreground">Chat</dt>
							<dd class="min-w-0 break-words">{row.target.chat ?? '—'}</dd>
							{#if row.target.user}
								<dt class="text-muted-foreground">Person</dt>
								<dd class="min-w-0 font-mono text-xs break-all">{row.target.user}</dd>
							{/if}
							{#if row.target.link}
								<dt class="text-muted-foreground">Link</dt>
								<dd class="min-w-0 font-mono text-xs break-all">{row.target.link}</dd>
							{/if}
							<dt class="text-muted-foreground">Requested by</dt>
							<dd class="min-w-0 break-words">{requesterText(row)}{#if role}<span class="text-muted-foreground"> · {role}</span>{/if}{#if row.member}<span class="text-muted-foreground"> · member {row.member}</span>{/if}</dd>
							<dt class="text-muted-foreground">From</dt>
							<dd class="min-w-0 break-words">{row.origin ?? '—'}</dd>
							<dt class="text-muted-foreground">Agent</dt>
							<dd class="flex min-w-0 items-center gap-2">
								{#if row.agentId}
									<a href="/a/{row.agentId}" class="flex items-center gap-1.5 hover:underline"><AgentAvatar seed={row.agentId} color={agent?.color} size={18} />{row.agentName ?? agent?.name ?? row.agentId}</a>
								{:else}—{/if}
							</dd>
							<dt class="text-muted-foreground">Session</dt>
							<dd class="flex min-w-0 items-center gap-2">
								{#if session}<a href={session} class="whitespace-nowrap underline underline-offset-2 hover:text-foreground">Open chat</a>{/if}
								{#if row.sessionId}<span class="min-w-0 truncate font-mono text-xs text-muted-foreground" title={row.sessionId}>{row.sessionId}</span>{:else}—{/if}
							</dd>
							<dt class="text-muted-foreground">Duration</dt>
							<dd class="font-mono text-xs">{formatDuration(row.durationMs)}</dd>
							{#if row.note && row.result === 'ok'}
								<dt class="text-muted-foreground">Note</dt>
								<dd class="min-w-0 break-words">{row.note}</dd>
							{/if}
							<dt class="text-muted-foreground">Record id</dt>
							<dd class="font-mono text-xs break-all">{row.id}</dd>
						</dl>
					</section>

					<section>
						<h3 class="mb-2 text-xs font-semibold text-muted-foreground">Summary</h3>
						{#if pairs.length > 0}
							<Surface class="rounded-lg">
								<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 px-3 py-2.5 text-[13px]">
									{#each pairs as p (p.key)}
										<dt class="font-mono text-xs text-muted-foreground">{p.key}</dt>
										<dd class="min-w-0 font-mono text-xs break-all">{p.value}</dd>
									{/each}
								</dl>
							</Surface>
							<p class="mt-1.5 text-xs text-muted-foreground">Message text is never stored: a text appears only as its length.</p>
						{:else}
							<p class="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">No parameters were recorded.</p>
						{/if}
					</section>

					<details class="group">
						<summary class="cursor-pointer text-xs font-semibold text-muted-foreground select-none">Raw record</summary>
						<pre class="mt-2 max-h-96 overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-[11.5px] leading-relaxed">{rawJson(row)}</pre>
					</details>
				</div>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
