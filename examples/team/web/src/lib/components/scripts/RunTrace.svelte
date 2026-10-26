<script lang="ts">
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import { callLabel, formatDuration, formatJson, outcomeTone, type ScriptRun, shortJson, triggerLabel } from '#lib/scripts/scripts.js';

	/** The trace of one run: outcome, ctx calls ("would …" in a dry run), logs, result and the event. */
	let { run, triggers, showEvent = true }: { run: ScriptRun; triggers?: string[]; showEvent?: boolean } = $props();
</script>

{#snippet block(title: string, text: string)}
	<pre class="max-h-72 overflow-auto rounded-md border border-sk-bd bg-sk-bg p-2.5 font-mono text-xs leading-5 whitespace-pre-wrap break-words" aria-label={title}>{text}</pre>
{/snippet}

<div class="flex min-w-0 flex-col gap-3 text-sm">
	<div class="flex flex-wrap items-center gap-2">
		<Badge variant={outcomeTone(run.outcome)}>{run.outcome}</Badge>
		{#if run.dryRun}<Badge variant="secondary">dry run</Badge>{/if}
		<span class="text-xs text-muted-foreground">v{run.version} · {run.trigger} · {formatDuration(run.durationMs)} · CPU {formatDuration(run.cpuMs)} · by {run.startedBy} · {new Date(run.startedAt).toLocaleString()}</span>
	</div>

	{#if triggers?.length}
		<ul class="flex flex-col gap-0.5 text-xs">
			{#each triggers as t, i (i)}
				<li class={t === 'match' ? 'text-success-text' : 'text-muted-foreground'}>{triggerLabel(t, i)}</li>
			{/each}
		</ul>
	{/if}

	{#if run.reason}<p class="text-xs text-muted-foreground">Reason: {run.reason}</p>{/if}
	{#if run.error}<p class="rounded-md bg-destructive-soft px-2.5 py-2 font-mono text-xs break-words whitespace-pre-wrap text-destructive-text" role="alert">{run.error}</p>{/if}

	<section class="flex flex-col gap-1.5">
		<h4 class="text-xs font-medium text-muted-foreground">Calls ({run.calls.length})</h4>
		{#if run.calls.length}
			<ol class="flex flex-col gap-1">
				{#each run.calls as c, i (i)}
					<li class="rounded-md border border-border px-2.5 py-1.5 text-xs">
						<div class="flex flex-wrap items-baseline gap-x-2">
							<span class="font-mono font-medium {c.dryRun ? 'text-info-text' : ''} {c.ok ? '' : 'text-destructive-text'}">{callLabel(c)}</span>
							<span class="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={formatJson(c.args)}>{shortJson(c.args)}</span>
							<span class="text-muted-foreground">{formatDuration(c.ms)}</span>
						</div>
						{#if !c.ok}
							<div class="mt-0.5 font-mono break-words text-destructive-text">error: {c.error ?? '?'}</div>
						{:else if !c.dryRun && c.result !== undefined}
							<div class="mt-0.5 truncate font-mono text-muted-foreground" title={formatJson(c.result)}>→ {shortJson(c.result)}</div>
						{/if}
					</li>
				{/each}
			</ol>
		{:else}
			<p class="text-xs text-muted-foreground">No ctx calls.</p>
		{/if}
	</section>

	<section class="flex flex-col gap-1.5">
		<h4 class="text-xs font-medium text-muted-foreground">Logs ({run.logs.length})</h4>
		{#if run.logs.length}{@render block('Logs', run.logs.join('\n'))}{:else}<p class="text-xs text-muted-foreground">No log lines.</p>{/if}
	</section>

	{#if run.outcome === 'ok'}
		<section class="flex flex-col gap-1.5">
			<h4 class="text-xs font-medium text-muted-foreground">Result</h4>
			{@render block('Result', formatJson(run.result))}
		</section>
	{/if}

	{#if showEvent && run.event !== undefined && run.event !== null}
		<Collapsible.Root>
			<Collapsible.Trigger class="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
				<CaretDownIcon class="size-3 transition-transform group-data-[state=open]:rotate-180" /> Event
			</Collapsible.Trigger>
			<Collapsible.Content class="mt-1.5">{@render block('Event', formatJson(run.event))}</Collapsible.Content>
		</Collapsible.Root>
	{/if}
</div>
