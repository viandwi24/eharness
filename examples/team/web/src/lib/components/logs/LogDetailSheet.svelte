<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeft';
	import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRight';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircle';
	import XIcon from 'phosphor-svelte/lib/X';
	import type { ModelCallDetail } from '#lib/api/client.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { formatTokens } from '#lib/context.js';
	import { formatDateTime, formatDuration, formatSpeed, headersOf, kindLabel, outputOf, promptMessages, statusVariant, tokensPerSecond, truncationOf } from '#lib/logs/logs.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openTask } from '#lib/stores/drawer.svelte.js';
	import { formatUsd } from '#lib/time.js';
	import JsonViewer from './JsonViewer.svelte';
	import LogText from './LogText.svelte';

	/** The "Call details" sheet: stats, overview and the payloads of one model call, with prev / next. */
	let {
		id,
		detail,
		loading,
		error,
		onNavigate,
		onClose
	}: {
		/** Id of the open call (null = closed). */
		id: string | null;
		detail: ModelCallDetail | null;
		loading: boolean;
		error: string | null;
		onNavigate: (id: string) => void;
		onClose: () => void;
	} = $props();

	let tab = $state('messages');
	const agent = $derived(detail?.agentId ? agentsStore.find(detail.agentId) : undefined);
	const speed = $derived(detail ? tokensPerSecond(detail) : null);
	const messages = $derived(detail ? promptMessages(detail.requestOptions) : []);
	const promptCut = $derived(detail ? truncationOf(detail.requestOptions) : null);
	const output = $derived(detail ? outputOf(detail) : null);
	const tools = $derived.by(() => {
		const t = (detail?.requestOptions as { tools?: unknown } | null)?.tools;
		return Array.isArray(t) ? t.map((x) => String((x as { name?: unknown }).name ?? '')).filter(Boolean) : [];
	});
	const headers = $derived(detail ? headersOf(detail.response) : {});

	function onKeydown(e: KeyboardEvent): void {
		if (!id || e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target as HTMLElement | null;
		if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
		if (e.key === 'ArrowLeft' && detail?.prevId) {
			e.preventDefault();
			e.stopPropagation();
			onNavigate(detail.prevId);
		} else if (e.key === 'ArrowRight' && detail?.nextId) {
			e.preventDefault();
			e.stopPropagation();
			onNavigate(detail.nextId);
		}
	}
</script>

<!-- capture phase: ← / → step through calls even when a tab trigger has focus (it would move the tab) -->
<svelte:window onkeydowncapture={onKeydown} />

{#snippet tile(label: string, value: string, sub?: string)}
	<Surface class="rounded-lg px-3 py-2.5">
		<div class="text-[11.5px] text-muted-foreground">{label}</div>
		<div class="mt-0.5 font-mono text-[15px] leading-tight tabular-nums">{value}</div>
		{#if sub}<div class="mt-0.5 text-[11.5px] text-muted-foreground tabular-nums">{sub}</div>{/if}
	</Surface>
{/snippet}

<Sheet.Root open={id !== null} onOpenChange={(o) => !o && onClose()}>
	<Sheet.Content side="right" showCloseButton={false} class="flex flex-col gap-0 p-0" style="width: min(64rem, 100vw); max-width: none">
		<header class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
			<Sheet.Title class="mr-auto text-sm font-medium">Call details</Sheet.Title>
			<Button variant="ghost" size="icon-sm" aria-label="Newer call (←)" title="Newer call (←)" disabled={!detail?.prevId} onclick={() => detail?.prevId && onNavigate(detail.prevId)}>
				<ArrowLeftIcon class="size-4" />
			</Button>
			<Button variant="ghost" size="icon-sm" aria-label="Older call (→)" title="Older call (→)" disabled={!detail?.nextId} onclick={() => detail?.nextId && onNavigate(detail.nextId)}>
				<ArrowRightIcon class="size-4" />
			</Button>
			<Button variant="ghost" size="icon-sm" aria-label="Close" onclick={onClose}><XIcon class="size-4" /></Button>
		</header>

		<div class="min-h-0 flex-1 overflow-y-auto p-4">
			{#if error && !detail}
				<div class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
					<WarningCircleIcon class="size-5" />
					<p>{error}</p>
					<p class="text-xs">The call may have been removed by the retention policy.</p>
				</div>
			{:else if !detail}
				<div class="flex flex-col gap-3">
					<Skeleton class="h-6 w-2/3" />
					<div class="grid grid-cols-2 gap-2 sm:grid-cols-3">{#each [0, 1, 2, 3, 4, 5] as n (n)}<Skeleton class="h-16 rounded-lg" />{/each}</div>
					<Skeleton class="h-40 w-full rounded-lg" />
				</div>
			{:else}
				<div class="flex flex-col gap-5 {loading ? 'opacity-60' : ''}">
					<div class="flex flex-wrap items-center gap-1.5">
						<Badge variant="secondary" class="font-mono">{detail.modelId}</Badge>
						<Badge variant="outline">{detail.provider}</Badge>
						<Badge variant="outline">{kindLabel(detail.kind)}</Badge>
						<Badge variant={statusVariant(detail.status)} class="capitalize">{detail.status}</Badge>
						{#if detail.truncated}<Badge variant="warning">Truncated</Badge>{/if}
					</div>

					{#if detail.status !== 'ok' && (detail.errorMessage || detail.errorName)}
						<div class="rounded-lg border border-[color-mix(in_srgb,var(--destructive)_30%,var(--popover))] bg-destructive-soft px-3 py-2 text-[13px] text-destructive-text" role="alert">
							{#if detail.errorName}<div class="font-medium">{detail.errorName}</div>{/if}
							{#if detail.errorMessage}<p class="mt-0.5 break-words whitespace-pre-wrap">{detail.errorMessage}</p>{/if}
						</div>
					{/if}

					<div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
						{@render tile('Latency', formatDuration(detail.firstChunkMs ?? detail.durationMs), detail.firstChunkMs === null ? 'whole call' : 'to first token')}
						{@render tile('Throughput', formatSpeed(speed))}
						{@render tile('Cost', detail.costUsd === null ? '—' : formatUsd(detail.costUsd), detail.costUsd === null ? 'not priced' : undefined)}
						{@render tile(
							'Tokens',
							`${detail.inputTokens === null ? '—' : formatTokens(detail.inputTokens)} → ${detail.outputTokens === null ? '—' : formatTokens(detail.outputTokens)}`,
							[detail.cachedTokens ? `${formatTokens(detail.cachedTokens)} cached` : '', detail.reasoningTokens ? `${formatTokens(detail.reasoningTokens)} reasoning` : ''].filter(Boolean).join(' · ') || undefined
						)}
						{@render tile('Finish reason', detail.finishReason ?? '—')}
						{@render tile('Duration', formatDuration(detail.durationMs))}
					</div>

					<section>
						<h3 class="mb-2 text-xs font-semibold text-muted-foreground">Overview</h3>
						<dl class="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 text-[13px]">
							<dt class="text-muted-foreground">Model</dt>
							<dd class="font-mono text-xs break-all">{detail.modelId}</dd>
							<dt class="text-muted-foreground">Provider</dt>
							<dd class="font-mono text-xs break-all">{detail.provider}</dd>
							<dt class="text-muted-foreground">Agent</dt>
							<dd class="flex min-w-0 items-center gap-2">
								{#if detail.agentId}
									<a href="/a/{detail.agentId}" class="flex items-center gap-1.5 hover:underline">
										<AgentAvatar seed={detail.agentId} color={agent?.color} size={18} />{agent?.name ?? detail.agentId}
									</a>
								{:else}—{/if}
							</dd>
							<dt class="text-muted-foreground">Session</dt>
							<dd class="flex min-w-0 items-center gap-2">
								{#if detail.taskId}
									<button type="button" class="whitespace-nowrap underline underline-offset-2 hover:text-foreground" onclick={() => openTask(detail.taskId!)}>Open task</button>
								{:else if detail.sessionId && detail.agentId && detail.sessionId.startsWith('dm:')}
									<a href="/a/{detail.agentId}" class="whitespace-nowrap underline underline-offset-2 hover:text-foreground">Open chat</a>
								{/if}
								{#if detail.sessionId}<span class="min-w-0 truncate font-mono text-xs text-muted-foreground" title={detail.sessionId}>{detail.sessionId}</span>{:else}—{/if}
							</dd>
							<dt class="text-muted-foreground">Turn</dt>
							<dd class="font-mono text-xs break-all">{detail.turnId ?? '—'}</dd>
							<dt class="text-muted-foreground">Step</dt>
							<dd class="font-mono text-xs">{detail.stepIndex ?? '—'}</dd>
							<dt class="text-muted-foreground">Message</dt>
							<dd class="font-mono text-xs break-all">{detail.messageId ?? '—'}</dd>
							<dt class="text-muted-foreground">Started at</dt>
							<dd class="font-mono text-xs">{formatDateTime(detail.startedAt)}</dd>
							<dt class="text-muted-foreground">Call id</dt>
							<dd class="font-mono text-xs break-all">{detail.id}</dd>
						</dl>
					</section>

					<Tabs.Root bind:value={tab} class="gap-3">
						<Tabs.List variant="line" class="overflow-x-auto [scrollbar-width:none]">
							<Tabs.Trigger value="messages">Messages</Tabs.Trigger>
							<Tabs.Trigger value="output">Output</Tabs.Trigger>
							<Tabs.Trigger value="request">Request JSON</Tabs.Trigger>
							<Tabs.Trigger value="response">Response JSON</Tabs.Trigger>
							<Tabs.Trigger value="metadata">Metadata</Tabs.Trigger>
						</Tabs.List>

						<Tabs.Content value="messages" class="flex flex-col gap-2">
							{#if promptCut}
								<p class="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning-text">The prompt was too large to keep in full. See Request JSON for the stored part.</p>
							{:else if messages.length === 0}
								<p class="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">No prompt was recorded for this call.</p>
							{/if}
							{#each messages as m, i (i)}
								<Surface as="details" class="group rounded-lg" open={m.role !== 'system'}>
									<summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs select-none [&::-webkit-details-marker]:hidden">
										<CaretDownIcon class="size-3 text-muted-foreground transition-transform group-not-open:-rotate-90" />
										<Badge variant={m.role === 'user' ? 'brand' : m.role === 'assistant' ? 'info' : m.role === 'tool' ? 'warning' : 'secondary'} class="capitalize">{m.role}</Badge>
										<span class="truncate text-muted-foreground">{m.parts.length} part{m.parts.length === 1 ? '' : 's'}</span>
									</summary>
									<div class="flex flex-col gap-2 border-t border-border px-3 py-2.5">
										{#each m.parts as p, j (j)}
											<div>
												{#if p.label || p.kind !== 'text'}
													<div class="mb-0.5 text-[11px] font-medium text-muted-foreground">{p.kind === 'tool-call' ? 'Tool call' : p.kind === 'tool-result' ? 'Tool result' : p.kind}{p.label ? ` · ${p.label}` : ''}</div>
												{/if}
												<LogText text={p.text} mono={p.kind === 'tool-call' || p.kind === 'tool-result'} />
											</div>
										{/each}
									</div>
								</Surface>
							{/each}
							{#if tools.length > 0}
								<p class="text-xs text-muted-foreground">Tools offered ({tools.length}): <span class="font-mono">{tools.join(', ')}</span></p>
							{/if}
						</Tabs.Content>

						<Tabs.Content value="output" class="flex flex-col gap-3">
							{#if output && !output.text && !output.reasoning && output.toolCalls.length === 0}
								<p class="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
									{detail.status === 'ok' ? 'The model returned no content.' : 'The call ended before any output.'}
								</p>
							{/if}
							{#if output?.text}
								<section><h4 class="mb-1 text-xs font-semibold text-muted-foreground">Text</h4><Surface class="rounded-lg px-3 py-2.5"><LogText text={output.text} max={4000} /></Surface></section>
							{/if}
							{#if output?.reasoning}
								<section><h4 class="mb-1 text-xs font-semibold text-muted-foreground">Reasoning</h4><Surface class="rounded-lg px-3 py-2.5 text-muted-foreground"><LogText text={output.reasoning} max={2000} /></Surface></section>
							{/if}
							{#if output && output.toolCalls.length > 0}
								<section class="flex flex-col gap-2">
									<h4 class="text-xs font-semibold text-muted-foreground">Tool calls ({output.toolCalls.length})</h4>
									{#each output.toolCalls as c (c.toolCallId)}
										<div class="flex flex-col gap-1.5">
											<div class="flex items-center gap-2 text-xs"><Badge variant="warning" class="font-mono">{c.toolName}</Badge><span class="truncate font-mono text-muted-foreground">{c.toolCallId}</span></div>
											<JsonViewer value={c.input} title="input" />
										</div>
									{/each}
								</section>
							{/if}
						</Tabs.Content>

						<Tabs.Content value="request" class="flex flex-col gap-2">
							{#if detail.requestBody === null || detail.requestBody === undefined}
								<p class="text-xs text-muted-foreground">The provider did not report the wire body: showing the call options.</p>
								<JsonViewer value={detail.requestOptions} title="request options" />
							{:else}
								<JsonViewer value={detail.requestBody} title="request body" />
							{/if}
						</Tabs.Content>

						<Tabs.Content value="response" class="flex flex-col gap-2">
							<JsonViewer value={detail.response} title="response" empty="No response was recorded." />
						</Tabs.Content>

						<Tabs.Content value="metadata" class="flex flex-col gap-3">
							<section><h4 class="mb-1 text-xs font-semibold text-muted-foreground">Provider metadata</h4><JsonViewer value={detail.providerMetadata} title="providerMetadata" empty="The provider reported no metadata." /></section>
							<section><h4 class="mb-1 text-xs font-semibold text-muted-foreground">Usage (raw)</h4><JsonViewer value={detail.usageRaw} title="usage" empty="The provider reported no raw usage." /></section>
							<section><h4 class="mb-1 text-xs font-semibold text-muted-foreground">Response headers</h4><JsonViewer value={Object.keys(headers).length > 0 ? headers : null} title="headers" empty="No headers were recorded." /></section>
						</Tabs.Content>
					</Tabs.Root>
				</div>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
