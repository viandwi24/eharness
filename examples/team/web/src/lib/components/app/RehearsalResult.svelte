<script lang="ts">
	import type { UIMessage } from 'ai';
	import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimple';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import MessageView from '#lib/parts/MessageView.svelte';
	import { REPORT_LABELS, type Program } from '#lib/programs/form.js';
	import { fileBytes, fileSize, inputPreview, rehearsalBadge, toolCounts, type Rehearsal, type RehearsalFile } from '#lib/rehearsal/model.js';
	import { formatUsd } from '#lib/time.js';
	import Surface from './Surface.svelte';

	/**
	 * The result of a rehearsal: the report, the deliverable checks, the files it produced (from the
	 * scratch overlay), the outside actions that were simulated, the decisions it would have asked
	 * for, the cost and the chat of the run.
	 */
	let { rehearsal, program }: { rehearsal: Rehearsal; program?: Program | undefined } = $props();

	const badge = $derived(rehearsalBadge(rehearsal));
	const tools = $derived(toolCounts(rehearsal.toolsCalled));
	const when = (ms: number): string => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
	const seconds = $derived(rehearsal.endedAt === null ? null : Math.max(1, Math.round((rehearsal.endedAt - rehearsal.startedAt) / 1000)));

	let messages = $state<UIMessage[] | null>(null);
	let chatError = $state('');
	let loaded = '';
	$effect(() => {
		// the chat is read again when the run ends (while it runs it grows)
		const key = `${rehearsal.id}:${rehearsal.status}:${rehearsal.endedAt}`;
		if (key === loaded) return;
		loaded = key;
		api.get('/rehearsals/{id}/messages', { params: { id: rehearsal.id } }).then(
			(r) => {
				messages = r.messages as unknown as UIMessage[];
				chatError = '';
			},
			(e) => {
				chatError = e instanceof Error ? e.message : 'Could not load the chat';
			}
		);
	});

	function download(f: RehearsalFile): void {
		const bytes = fileBytes(f);
		if (bytes === null) return;
		const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: f.mediaType ?? 'application/octet-stream' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = f.path.split('/').pop() ?? 'file';
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<div class="flex flex-col gap-4" data-testid="rehearsal-result">
	<Surface class="flex flex-col gap-2 p-4 text-sm">
		<div class="flex flex-wrap items-center gap-2">
			<Badge variant={badge.variant}>{badge.label}</Badge>
			<span class="text-muted-foreground">Started {when(rehearsal.startedAt)}{seconds === null ? '' : `, took ${seconds}s`}</span>
			<span class="flex-1"></span>
			<span class="font-mono text-muted-foreground" title="Spent, against a cap of {formatUsd(rehearsal.budgetUsd)}">{formatUsd(rehearsal.costUsd)} of {formatUsd(rehearsal.budgetUsd)}</span>
		</div>
		{#if rehearsal.status === 'running'}
			<p class="text-muted-foreground">The program is running on the sample data. This page updates as it goes.</p>
		{/if}
		{#if rehearsal.error}<p class="text-destructive-text" role="alert">{rehearsal.error}</p>{/if}
		{#if program && program.version !== rehearsal.programVersion}
			<p class="text-xs text-muted-foreground">The program was saved again after this test run (it ran version {rehearsal.programVersion}, the program is at {program.version}). If you changed what it does, run it again.</p>
		{/if}
		<p class="text-xs text-muted-foreground">Safe mode: your library was not changed, outside calls that change something were simulated, and nothing was sent to the Decision Center.</p>
	</Surface>

	<Surface class="flex flex-col gap-2 p-4 text-sm" data-testid="rehearsal-report">
		<h2 class="font-medium">Report</h2>
		{#if rehearsal.report}
			<div class="flex items-center gap-2"><Badge variant={REPORT_LABELS[rehearsal.report.status].variant}>{REPORT_LABELS[rehearsal.report.status].label}</Badge></div>
			<p>{rehearsal.report.summary}</p>
			{#if rehearsal.report.notes}<p class="text-xs text-muted-foreground">{rehearsal.report.notes}</p>{/if}
			{#if rehearsal.report.outputs.length}
				<ul class="flex flex-wrap gap-1.5" aria-label="Outputs">{#each rehearsal.report.outputs as path (path)}<li class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{path}</li>{/each}</ul>
			{/if}
		{:else}
			<p class="text-muted-foreground">{rehearsal.status === 'running' ? 'Not reported yet.' : 'The run ended without a report.'}</p>
		{/if}
	</Surface>

	{#if rehearsal.deliverables}
		<Surface class="flex flex-col gap-2 p-4 text-sm" data-testid="rehearsal-deliverables">
			<div class="flex flex-wrap items-center gap-2">
				<h2 class="font-medium">Deliverables</h2>
				<Badge variant={rehearsal.deliverables.status === 'pass' ? 'success' : 'destructive'}>{rehearsal.deliverables.status === 'pass' ? 'all met' : 'not met'}</Badge>
				{#if rehearsal.deliverables.attempts > 1}<span class="text-xs text-muted-foreground">after a fix-up turn</span>{/if}
			</div>
			<ul class="flex flex-col gap-1">
				{#each rehearsal.deliverables.checks as check (check.path)}
					<li class="text-xs" data-ok={check.ok}>
						<span class="mr-1.5 font-medium {check.ok ? 'text-success-text' : 'text-destructive-text'}">{check.ok ? 'Pass' : 'Fail'}</span><span class="font-mono">{check.path}</span>
						{#if !check.ok}<ul class="ml-4 list-disc text-muted-foreground">{#each check.problems as problem (problem)}<li>{problem}</li>{/each}</ul>{/if}
					</li>
				{/each}
			</ul>
			<p class="text-xs text-muted-foreground">Checked against the files of the test run. In a real run a failure would also open a decision.</p>
		</Surface>
	{/if}

	<Surface class="flex flex-col gap-2 p-4 text-sm" data-testid="rehearsal-files">
		<h2 class="font-medium">Files it produced</h2>
		{#if rehearsal.files.length === 0}
			<p class="text-muted-foreground">{rehearsal.status === 'running' ? 'The files appear when the run ends.' : 'No files were written.'}</p>
		{/if}
		{#each rehearsal.files as file (file.path)}
			<details class="rounded-md border border-border/70">
				<summary class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5">
					<span class="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
					<span class="text-xs text-muted-foreground">{fileSize(file.size)}</span>
					{#if file.text !== null || file.base64 !== null}
						<Button type="button" variant="ghost" size="icon-sm" aria-label="Download {file.path}" onclick={(e: MouseEvent) => { e.preventDefault(); download(file); }}><DownloadSimpleIcon class="size-4" /></Button>
					{/if}
				</summary>
				{#if file.text !== null}
					<pre class="max-h-96 overflow-auto border-t border-border/70 p-2.5 text-xs whitespace-pre-wrap">{file.text}</pre>
				{:else}
					<p class="border-t border-border/70 p-2.5 text-xs text-muted-foreground">{file.truncated ? 'This file is too big to keep with the result.' : 'A binary file: download it to open it.'}</p>
				{/if}
			</details>
		{/each}
		{#if rehearsal.deleted.length}
			<p class="text-xs text-muted-foreground">It also deleted (in the scratch copy only): <span class="font-mono">{rehearsal.deleted.join(', ')}</span></p>
		{/if}
	</Surface>

	<Surface class="flex flex-col gap-2 p-4 text-sm" data-testid="rehearsal-simulated">
		<h2 class="font-medium">Outside actions that were simulated</h2>
		{#if rehearsal.simulated.length === 0}
			<p class="text-muted-foreground">None. The run made no call to an outside system that would change something.</p>
		{:else}
			<ul class="flex flex-col gap-1.5">
				{#each rehearsal.simulated as a, i (i)}
					<li class="rounded-md border border-border/70 px-2.5 py-1.5"><span class="font-mono text-xs font-medium">{a.tool}</span> <span class="font-mono text-xs text-muted-foreground">{inputPreview(a.input)}</span></li>
				{/each}
			</ul>
			<p class="text-xs text-muted-foreground">These calls were not made. The agent was told they were simulated and carried on as if they had worked.</p>
		{/if}
	</Surface>

	<Surface class="flex flex-col gap-2 p-4 text-sm" data-testid="rehearsal-would-ask">
		<h2 class="font-medium">Decisions it would ask you for</h2>
		{#if rehearsal.wouldAsk.length === 0}
			<p class="text-muted-foreground">None. The run did not stop to ask anything.</p>
		{:else}
			<ul class="flex flex-col gap-2">
				{#each rehearsal.wouldAsk as a, i (i)}
					<li class="rounded-md border border-border/70 px-2.5 py-2">
						<div class="flex items-center gap-2"><Badge variant="info">{a.kind === 'amendment' ? 'more authority' : a.kind === 'report' ? 'ended needing a decision' : 'question'}</Badge><span class="font-medium">{a.title}</span></div>
						<p class="mt-1">{a.question}</p>
						{#if a.options?.length}<p class="mt-1 text-xs text-muted-foreground">Options: {a.options.join(' · ')}</p>{/if}
						{#if a.details}<pre class="mt-1 text-xs whitespace-pre-wrap text-muted-foreground">{a.details}</pre>{/if}
					</li>
				{/each}
			</ul>
			<p class="text-xs text-muted-foreground">In a real run these would wait for you in the Decision Center. Here nothing was created.</p>
		{/if}
	</Surface>

	{#if tools.length}
		<Surface class="flex flex-col gap-2 p-4 text-sm">
			<h2 class="font-medium">Tools it called</h2>
			<ul class="flex flex-wrap gap-1.5">{#each tools as t (t.name)}<li class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{t.name}{t.count > 1 ? ` ×${t.count}` : ''}</li>{/each}</ul>
		</Surface>
	{/if}

	<Surface class="flex flex-col gap-3 p-4 text-sm" data-testid="rehearsal-chat">
		<h2 class="font-medium">The run, step by step</h2>
		{#if chatError}
			<p class="text-destructive-text" role="alert">{chatError}</p>
		{:else if messages === null}
			<Skeleton class="h-16 w-full" />
		{:else if messages.length === 0}
			<p class="text-muted-foreground">Nothing yet.</p>
		{:else}
			<div class="flex flex-col gap-3">
				{#each messages as m (m.id)}<MessageView message={m} scratch />{/each}
			</div>
		{/if}
	</Surface>
</div>
