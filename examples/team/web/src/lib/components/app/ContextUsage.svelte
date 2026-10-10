<script lang="ts">
	import type { Task } from '#lib/api/client.js';
	import { contextView, formatRate, formatTokens, formatUsd, type ChatStats } from '#lib/context.js';
	import { formatTime } from '#lib/format.js';

	/** Context size, compaction and usage of one chat (`GET /agents/{id}/stats`), plus the cost of its tasks. */
	let { stats, owned = [], delegated = [] }: { stats: ChatStats; owned?: Task[]; delegated?: Task[] } = $props();

	const view = $derived(contextView(stats.context));
	const c = $derived(stats.context);
	const last = $derived(c.lastCompaction);
	const sum = (tasks: Task[], key: 'costUsd' | 'tokens'): number => tasks.reduce((n, t) => n + t[key], 0);
	const dot: Record<string, string> = { instructions: 'bg-foreground/80', tools: 'bg-foreground/50', messages: 'bg-foreground/25' };
	const price = $derived(stats.model.pricing);
</script>

<div class="flex flex-col gap-4">
	<section>
		<div class="flex items-baseline justify-between gap-2">
			<h3 class="text-xs font-medium text-muted-foreground">Model</h3>
			<span class="min-w-0 truncate font-mono text-xs" title={stats.model.id}>{stats.model.id}</span>
		</div>
		<p class="mt-1 text-xs text-muted-foreground">
			{#if price}
				{formatRate(price.input)} in · {formatRate(price.output)} out{price.cacheRead !== undefined ? ` · ${formatRate(price.cacheRead)} cached` : ''}
			{:else}
				No price known for this model: cost is not counted.
			{/if}
		</p>
	</section>

	<section>
		<div class="flex items-baseline justify-between gap-2">
			<h3 class="text-xs font-medium text-muted-foreground">Context</h3>
			<span class="text-xs tabular-nums">{formatTokens(c.tokens)} / {formatTokens(c.window)} · {view.pct}%</span>
		</div>
		<!-- bar: segments of the window, the compaction threshold (amber) and the hard limit (red) as marks -->
		<div class="relative mt-2 h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label="Context used {view.pct}%">
			<div class="flex h-full">
				{#each view.segments as s (s.key)}
					<div class={dot[s.key]} style="width: {s.pct}%"></div>
				{/each}
			</div>
			<div class="absolute inset-y-0 w-px bg-warning-text" style="left: {view.summarizeAtPct}%" title="Summarize at {formatTokens(c.summarizeAt)}"></div>
			<div class="absolute inset-y-0 w-px bg-destructive-text" style="left: {view.hardLimitPct}%" title="Hard limit {formatTokens(c.hardLimit)}"></div>
		</div>
		<ul class="mt-2 flex flex-col gap-1 text-xs">
			{#each view.segments as s (s.key)}
				<li class="flex items-center gap-2">
					<span class="size-2 rounded-full {dot[s.key]}"></span>
					<span class="flex-1 text-muted-foreground">{s.label}</span>
					<span class="tabular-nums">{formatTokens(s.tokens)}</span>
				</li>
			{/each}
			<li class="flex items-center gap-2">
				<span class="h-2 w-px bg-warning-text"></span>
				<span class="flex-1 text-muted-foreground">Summarize at</span>
				<span class="tabular-nums">{formatTokens(c.summarizeAt)}</span>
			</li>
			<li class="flex items-center gap-2">
				<span class="h-2 w-px bg-destructive-text"></span>
				<span class="flex-1 text-muted-foreground">Hard limit</span>
				<span class="tabular-nums">{formatTokens(c.hardLimit)}</span>
			</li>
		</ul>
		{#if view.near}
			<p class="mt-2 rounded-lg bg-warning-soft p-2 text-xs text-warning-text">
				{view.over ? 'Past the summarize threshold: older messages are compacted on the next turn.' : 'Close to the summarize threshold: older messages will be compacted soon.'}
			</p>
		{/if}
	</section>

	<section>
		<h3 class="text-xs font-medium text-muted-foreground">Last compaction</h3>
		{#if last}
			<p class="mt-1 text-xs">
				{formatTokens(last.before)} → {formatTokens(last.after)} tokens
				<span class="text-muted-foreground">· {formatTime(last.at)}</span>
			</p>
		{:else}
			<p class="mt-1 text-xs text-muted-foreground">Never compacted.</p>
		{/if}
	</section>

	<section>
		<h3 class="text-xs font-medium text-muted-foreground">Usage</h3>
		<dl class="mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
			<dt class="text-muted-foreground">Input tokens</dt>
			<dd class="tabular-nums">{formatTokens(stats.usage.inputTokens)}</dd>
			<dt class="text-muted-foreground">Output tokens</dt>
			<dd class="tabular-nums">{formatTokens(stats.usage.outputTokens)}</dd>
			<dt class="text-muted-foreground">Turns</dt>
			<dd class="tabular-nums">{stats.usage.turns}</dd>
			<dt class="text-muted-foreground">Chat cost</dt>
			<dd class="tabular-nums">{formatUsd(stats.usage.costUsd)}</dd>
			{#if owned.length}
				<dt class="text-muted-foreground">Runs ({owned.length})</dt>
				<dd class="tabular-nums">{formatUsd(sum(owned, 'costUsd'))} · {formatTokens(sum(owned, 'tokens'))}</dd>
			{/if}
			{#if delegated.length}
				<dt class="text-muted-foreground">Delegated ({delegated.length})</dt>
				<dd class="tabular-nums">{formatUsd(sum(delegated, 'costUsd'))} · {formatTokens(sum(delegated, 'tokens'))}</dd>
			{/if}
		</dl>
	</section>
</div>
